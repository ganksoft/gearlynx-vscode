import {
    LoggingDebugSession,
    InitializedEvent,
    StoppedEvent,
    ContinuedEvent,
    TerminatedEvent,
    OutputEvent,
    Thread,
    StackFrame,
    Scope,
    Source,
    Variable,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { DebugMonitorClient, CLIENT_PROTOCOL_VERSION } from './debug_monitor_client';
import { DebugInfo } from './debug_info';
import { setActiveSession } from './extension';
import { CpuRegisters, DebugSymbol } from './types';
import { expandTilde } from './paths';
import { hex, formatByteWord } from './format';
import { logInfo, logWarn, logError } from './log';

const THREAD_ID = 1;

// CPU register names accepted in watch expressions, breakpoint conditions and
// logpoint messages. The condition pattern is built from the same list so the
// two cannot drift apart.
const REGISTER_NAMES: string[] = ['pc', 'a', 'x', 'y', 's', 'p'];
const REGISTER_CONDITION_RE =
    new RegExp(`^(${REGISTER_NAMES.join('|')})\\s*(==|!=|<|>|<=|>=)\\s*(\\$?[0-9a-fA-Fx]+)$`, 'i');

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    rom: string;
    debugFile?: string;
    stopOnEntry?: boolean;
    port?: number;
    gearlynxPath?: string;
    sourceRoots?: string[];
    headless?: boolean;
    traceSteps?: boolean;
}

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
    debugFile?: string;
    hostname?: string;
    port?: number;
    sourceRoots?: string[];
    traceSteps?: boolean;
}

export class LynxDebugSession extends LoggingDebugSession {
    private monitor: DebugMonitorClient;
    private debugInfo: DebugInfo | null = null;
    private emulatorProcess: cp.ChildProcess | null = null;
    private variableHandles = new Map<number, string>();
    private nextVarRef = 1;
    // Track breakpoints per source file for proper clear/re-set
    private sourceBreakpoints = new Map<string, number[]>();
    // Track conditions for conditional breakpoints (address -> condition expression)
    private breakpointConditions = new Map<number, string>();
    // Track logpoint messages (address -> log message template)
    private breakpointLogMessages = new Map<number, string>();
    // Track data breakpoints (address set)
    private dataBreakpoints = new Set<number>();
    // Track function breakpoints (address set)
    private functionBreakpoints = new Set<number>();
    // Track instruction breakpoints (address set)
    private instructionBreakpoints = new Set<number>();
    // Hits so far per hit-count breakpoint address
    private hitCounts = new Map<number, number>();
    // Registers and hardware status don't change while the emulator is paused,
    // but several scopes ask for them on every stop. Cache the in-flight
    // promise and drop it whenever execution state changes.
    private cachedRegisters: Promise<CpuRegisters> | null = null;
    private cachedHardware: Promise<Record<string, unknown>> | null = null;
    // Saved launch args for restart
    private launchArgs: LaunchRequestArguments | null = null;
    // Source-line stepping state
    private sourceStepActive = false;
    private sourceStepOriginFile = '';
    private sourceStepOriginLine = 0;
    private sourceStepFn: (() => Promise<void>) | null = null;
    private sourceStepCount = 0;
    private sourceStepStopReason = '';
    private traceSteps = false;
    private static readonly SOURCE_STEP_MAX = 100;

    // Drives both scopesRequest and variablesRequest, so a scope's label, its
    // variable-handle key and its populator can never drift apart.
    private readonly scopeSpecs: {
        label: string;
        key: string;
        needsDebugInfo: boolean;
        populate: (variables: Variable[]) => Promise<void>;
    }[] = [
        { label: 'Registers', key: 'registers', needsDebugInfo: false, populate: v => this.populateRegisters(v) },
        { label: 'Flags', key: 'flags', needsDebugInfo: false, populate: v => this.populateFlags(v) },
        { label: 'Locals', key: 'locals', needsDebugInfo: true, populate: v => this.populateLocals(v) },
        { label: 'Zero Page', key: 'zeropage', needsDebugInfo: true, populate: v => this.populateZeroPage(v) },
        { label: 'Globals', key: 'globals', needsDebugInfo: true, populate: v => this.populateGlobals(v) },
        { label: 'Hardware', key: 'hardware', needsDebugInfo: false, populate: v => this.populateHardware(v) },
        { label: 'Timers', key: 'timers', needsDebugInfo: false, populate: v => this.populateTimers(v) },
        { label: 'Audio', key: 'audio', needsDebugInfo: false, populate: v => this.populateAudio(v) },
    ];

    public constructor() {
        super('lynxdebug-adapter.log');
        this.monitor = new DebugMonitorClient();

        this.monitor.on('stopped', (data: Record<string, unknown>) => {
            const reason = (data?.reason as string) || 'step';
            // Before any handler below reads state -- the emulator has moved.
            this.invalidateStateCache();

            // If we're in a source-line step loop, keep going regardless of stop reason
            if (this.sourceStepActive) {
                this.sourceStepStopReason = reason;
                this.handleSourceStepStopped();
                return;
            }

            // Check conditional breakpoints and logpoints
            if (reason === 'breakpoint') {
                this.handleBreakpointHit();
                return;
            }

            this.sendEvent(new StoppedEvent(reason, THREAD_ID));
        });

        this.monitor.on('resumed', () => {
            this.invalidateStateCache();
            // Don't send ContinuedEvent during source-line step loop
            if (this.sourceStepActive) return;
            this.sendEvent(new ContinuedEvent(THREAD_ID));
        });

        this.monitor.on('terminated', () => {
            this.sendEvent(new TerminatedEvent());
        });

        this.monitor.on('close', () => {
            this.sendEvent(new TerminatedEvent());
        });

        this.monitor.on('error', (err: Error) => {
            const msg = `Gearlynx debug connection error: ${err.message}`;
            logError(msg);
            void vscode.window.showErrorMessage(msg);
        });
    }

    public getDebugInfo(): DebugInfo | null {
        return this.debugInfo;
    }

    public getMonitor(): DebugMonitorClient {
        return this.monitor;
    }

    public getStreamPort(): number {
        return (this.launchArgs?.port || 6502) + 1;
    }

    public async refreshStoppedState(): Promise<void> {
        // Only re-emit if the emulator is actually stopped
        try {
            const status = await this.monitor.getStatus();
            if (status.idle || status.paused) {
                this.sendEvent(new StoppedEvent('step', THREAD_ID));
            }
        } catch {
            // ignore -- not connected
        }
    }

    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        _args: DebugProtocol.InitializeRequestArguments
    ): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsReadMemoryRequest = true;
        response.body.supportsWriteMemoryRequest = true;
        response.body.supportsDisassembleRequest = true;
        response.body.supportsSteppingGranularity = true;
        response.body.supportsInstructionBreakpoints = true;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsDataBreakpoints = true;
        response.body.supportsSetVariable = true;
        response.body.supportsRestartRequest = true;
        response.body.supportsFunctionBreakpoints = true;
        response.body.supportsLogPoints = true;
        response.body.supportsLoadedSourcesRequest = true;
        response.body.supportsGotoTargetsRequest = true;
        response.body.supportsCompletionsRequest = true;
        response.body.completionTriggerCharacters = ['$', '.'];
        response.body.supportsStepBack = true;

        this.sendResponse(response);
    }

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: LaunchRequestArguments
    ): Promise<void> {
        // Expand a leading "~" in user-supplied paths; Node does not do this.
        args.rom = expandTilde(args.rom) as string;
        args.debugFile = expandTilde(args.debugFile);
        args.gearlynxPath = expandTilde(args.gearlynxPath);
        args.sourceRoots = args.sourceRoots?.map((r) => expandTilde(r) as string);

        this.launchArgs = args;
        this.traceSteps = args.traceSteps || false;
        try {
            // Load debug info
            if (args.debugFile) {
                logInfo(`Loading debug info: ${args.debugFile}`);
                this.debugInfo = DebugInfo.load(args.debugFile, args.sourceRoots);
                if (this.debugInfo) {
                    const stale = this.debugInfo.checkSourceStaleness();
                    if (stale.length > 0) {
                        const names = stale.map(s => path.basename(s.source)).join(', ');
                        const msg = `${stale.length} source file(s) changed since the debug info was built: ${names}. ` +
                            'Breakpoints and stepping may not match the running ROM -- rebuild before debugging.';
                        this.sendEvent(new OutputEvent(msg + '\n', 'console'));
                        logWarn(msg);
                        // Keep the toast short -- long messages get truncated with an
                        // expand chevron. Full detail is in the Debug Console/Output.
                        void vscode.window.showWarningMessage(
                            `${stale.length} source file(s) changed since the debug info was built. ` +
                            'Rebuild before debugging -- see the Debug Console for details.');
                    }
                }
            } else {
                logInfo('No debug file configured; source-level debugging will be unavailable.');
            }

            setActiveSession(this);

            const port = args.port || 6502;

            // Start Gearlynx process
            if (args.gearlynxPath) {
                const emulatorArgs = [
                    '--debug-monitor',
                    '--debug-monitor-port', port.toString(),
                ];

                if (args.headless) {
                    emulatorArgs.push('--headless');
                }

                emulatorArgs.push(args.rom);

                // Find a .sym file to pass to Gearlynx for its internal symbol table
                const romBase = args.rom.replace(/\.[^.]+$/, '');
                const symCandidates = [
                    romBase + '.sym',
                    args.rom + '.sym',
                    romBase + '.lbl',
                    args.rom + '.lbl',
                ];
                let symPathFound: string | undefined;
                for (const symPath of symCandidates) {
                    if (fs.existsSync(symPath)) {
                        symPathFound = symPath;
                        emulatorArgs.push(symPath);
                        break;
                    }
                }
                if (symPathFound) {
                    logInfo(`Auto-detected symbol file for Gearlynx: ${symPathFound}`);
                } else {
                    logInfo(`No symbol file found for Gearlynx (tried: ${symCandidates.join(', ')})`);
                }

                logInfo(`Launching Gearlynx: ${args.gearlynxPath} ${emulatorArgs.join(' ')}`);
                this.emulatorProcess = cp.spawn(args.gearlynxPath, emulatorArgs, {
                    stdio: ['ignore', 'ignore', args.headless ? 'pipe' : 'ignore'],
                    detached: false
                });

                if (args.headless && this.emulatorProcess.stderr) {
                    this.emulatorProcess.stderr.on('data', (data: Buffer) => {
                        this.sendEvent(new OutputEvent(data.toString(), 'stderr'));
                    });
                }

                this.emulatorProcess.on('exit', () => {
                    this.sendEvent(new TerminatedEvent());
                });
            }

            // Connect to debug monitor with retry
            logInfo(`Connecting to debug monitor at localhost:${port}...`);
            await this.monitor.connect('localhost', port);
            logInfo('Connected to debug monitor.');
            await this.checkProtocol();

            // If we didn't spawn the emulator, load the ROM via protocol
            if (!args.gearlynxPath) {
                await this.monitor.loadRom(args.rom);
            }

            this.sendEvent(new InitializedEvent());

            if (args.stopOnEntry) {
                // Emulator starts paused in debug mode
                this.sendEvent(new StoppedEvent('entry', THREAD_ID));
            } else {
                await this.monitor.continue_();
            }

            this.sendResponse(response);
        } catch (err) {
            logError(`Launch failed: ${err}`);
            response.success = false;
            response.message = `Launch failed: ${err}`;
            this.sendResponse(response);
        }
    }

    protected async attachRequest(
        response: DebugProtocol.AttachResponse,
        args: AttachRequestArguments
    ): Promise<void> {
        // Expand a leading "~" in user-supplied paths; Node does not do this.
        args.debugFile = expandTilde(args.debugFile);
        args.sourceRoots = args.sourceRoots?.map((r) => expandTilde(r) as string);

        try {
            this.traceSteps = args.traceSteps || false;
            if (args.debugFile) {
                this.debugInfo = DebugInfo.load(args.debugFile, args.sourceRoots);
            }

            setActiveSession(this);

            const hostname = args.hostname || 'localhost';
            const port = args.port || 6502;

            logInfo(`Attaching to debug monitor at ${hostname}:${port}...`);
            await this.monitor.connect(hostname, port);
            logInfo('Attached to debug monitor.');
            await this.checkProtocol();
            this.sendEvent(new InitializedEvent());

            // Unlike launch, attach joins an emulator that may already be
            // paused; reflect that so the toolbar shows Continue/step, not Pause.
            try {
                const status = await this.monitor.getStatus();
                if (status.paused || status.idle) {
                    this.sendEvent(new StoppedEvent(status.stop_reason || 'pause', THREAD_ID));
                }
            } catch {
                // Status unavailable -- leave the UI as running.
            }

            this.sendResponse(response);
        } catch (err) {
            logError(`Connect failed: ${err}`);
            response.success = false;
            response.message = `Connect failed: ${err}`;
            this.sendResponse(response);
        }
    }

    // Negotiate the debug-monitor wire protocol version with the emulator. A
    // mismatch (or a build too old to support the handshake) is surfaced as a
    // warning; debugging is still allowed to proceed (warn-but-continue).
    private async checkProtocol(): Promise<void> {
        try {
            const info = await this.monitor.handshake();
            if (info.protocolVersion !== CLIENT_PROTOCOL_VERSION) {
                const msg = `LynxDebug expects debug-monitor protocol v${CLIENT_PROTOCOL_VERSION}, ` +
                    `but Gearlynx (${info.emulatorVersion}) reports v${info.protocolVersion}. ` +
                    `Update the extension or the emulator so both match; debugging may be unreliable.`;
                this.sendEvent(new OutputEvent(msg + '\n', 'important'));
                logWarn(msg);
                void vscode.window.showWarningMessage(msg);
            }
        } catch {
            const msg = `LynxDebug could not negotiate the debug-monitor protocol version with Gearlynx ` +
                `(handshake unsupported). This Gearlynx build predates protocol v${CLIENT_PROTOCOL_VERSION}; ` +
                `debugging may be unreliable.`;
            this.sendEvent(new OutputEvent(msg + '\n', 'important'));
            logWarn(msg);
            void vscode.window.showWarningMessage(msg);
        }
    }

    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        _args: DebugProtocol.ConfigurationDoneArguments
    ): void {
        this.sendResponse(response);
    }

    protected async disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        _args: DebugProtocol.DisconnectArguments
    ): Promise<void> {
        this.monitor.disconnect();
        if (this.emulatorProcess) {
            this.emulatorProcess.kill();
            this.emulatorProcess = null;
        }
        this.sendResponse(response);
    }

    // -- Execution control --

    protected async continueRequest(
        response: DebugProtocol.ContinueResponse,
        _args: DebugProtocol.ContinueArguments
    ): Promise<void> {
        await this.monitor.continue_();
        response.body = { allThreadsContinued: true };
        this.sendResponse(response);
    }

    protected async nextRequest(
        response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments
    ): Promise<void> {
        if (args.granularity === 'instruction' || !this.debugInfo) {
            await this.monitor.stepOver();
        } else {
            await this.beginSourceLineStep(() => this.monitor.stepOver());
        }
        this.sendResponse(response);
    }

    protected async stepInRequest(
        response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments
    ): Promise<void> {
        if (args.granularity === 'instruction' || !this.debugInfo) {
            await this.monitor.stepIn();
        } else {
            await this.beginSourceLineStep(() => this.monitor.stepIn());
        }
        this.sendResponse(response);
    }

    protected async stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        _args: DebugProtocol.StepOutArguments
    ): Promise<void> {
        // stepOut always runs until RTS -- no source-line looping needed
        await this.monitor.stepOut();
        this.sendResponse(response);
    }

    protected async pauseRequest(
        response: DebugProtocol.PauseResponse,
        _args: DebugProtocol.PauseArguments
    ): Promise<void> {
        await this.monitor.pause();
        this.sendResponse(response);
    }

    protected async stepBackRequest(
        response: DebugProtocol.StepBackResponse,
        _args: DebugProtocol.StepBackArguments
    ): Promise<void> {
        let stepped = false;
        try {
            stepped = await this.monitor.rewindStepBack();
        } catch (err) {
            response.success = false;
            response.message = `Step back failed: ${err}`;
        }
        this.sendResponse(response);
        if (stepped) {
            this.sendEvent(new StoppedEvent('step', THREAD_ID));
        }
    }

    protected reverseContinueRequest(
        response: DebugProtocol.ReverseContinueResponse,
        _args: DebugProtocol.ReverseContinueArguments
    ): void {
        // Reverse continue not supported -- just do a single step back
        this.stepBackRequest(response as unknown as DebugProtocol.StepBackResponse, _args as unknown as DebugProtocol.StepBackArguments);
    }

    // -- Threads --

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [new Thread(THREAD_ID, '65C02')]
        };
        this.sendResponse(response);
    }

    // -- Stack trace --

    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        _args: DebugProtocol.StackTraceArguments
    ): Promise<void> {
        try {
            const regs = await this.getRegisters();
            const frames: StackFrame[] = [];

            // Current frame
            const source = this.resolveSource(regs.pc);
            const topFrame = new StackFrame(
                0,
                this.formatAddress(regs.pc),
                source?.vscodeSource,
                source?.line
            );
            topFrame.instructionPointerReference = regs.pc.toString();
            const topFn = this.debugInfo?.findFunctionForAddress(regs.pc);
            if (topFn?.isLibrary) {
                (topFrame as unknown as DebugProtocol.StackFrame).presentationHint = 'subtle';
            }
            frames.push(topFrame);

            // Call stack from emulator, innermost-first. Entry i's "return"
            // address is where the caller at DAP frame i+1 is paused -- not
            // entry i's "function" address, which is one call level too deep.
            const callStackData = await this.monitor.getCallStack();
            const stack = callStackData?.['stack'] as Array<{
                function: string;
                source: string;
                return: string;
            }> | undefined;
            if (stack) {
                for (let i = 0; i < stack.length; i++) {
                    const callerPc = parseInt(stack[i].return.replace('$', ''), 16);
                    const entrySource = this.resolveSource(callerPc);
                    const frame = new StackFrame(
                        i + 1,
                        this.formatAddress(callerPc),
                        entrySource?.vscodeSource,
                        entrySource?.line
                    );
                    frame.instructionPointerReference = callerPc.toString();
                    const fn = this.debugInfo?.findFunctionForAddress(callerPc);
                    if (fn?.isLibrary) {
                        (frame as unknown as DebugProtocol.StackFrame).presentationHint = 'subtle';
                    }
                    frames.push(frame);
                }
            }

            response.body = {
                stackFrames: frames,
                totalFrames: frames.length
            };
            this.sendResponse(response);
        } catch (err) {
            response.success = false;
            response.message = `Stack trace failed: ${err}`;
            this.sendResponse(response);
        }
    }

    // -- Scopes and variables --

    protected scopesRequest(
        response: DebugProtocol.ScopesResponse,
        _args: DebugProtocol.ScopesArguments
    ): void {
        this.variableHandles.clear();
        this.nextVarRef = 1;

        const scopes: Scope[] = this.scopeSpecs
            .filter(spec => !spec.needsDebugInfo || this.debugInfo)
            .map(spec => new Scope(spec.label, this.allocVariableRef(spec.key), false));

        response.body = { scopes };
        this.sendResponse(response);
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        const scopeName = this.variableHandles.get(args.variablesReference);
        const spec = this.scopeSpecs.find(s => s.key === scopeName);
        const variables: Variable[] = [];

        try {
            if (spec && (!spec.needsDebugInfo || this.debugInfo)) {
                await spec.populate(variables);
            }
        } catch {
            // Return empty if disconnected
        }

        response.body = { variables };
        this.sendResponse(response);
    }

    private async populateRegisters(variables: Variable[]): Promise<void> {
        const regs = await this.getRegisters();
        const pcVar = this.makeVar('PC', regs.pc, 4);
        (pcVar as unknown as DebugProtocol.Variable).memoryReference = regs.pc.toString();
        variables.push(pcVar);
        variables.push(this.makeVar('A', regs.a, 2));
        variables.push(this.makeVar('X', regs.x, 2));
        variables.push(this.makeVar('Y', regs.y, 2));
        const spVar = this.makeVar('S', regs.s, 2);
        (spVar as unknown as DebugProtocol.Variable).memoryReference = (0x0100 + regs.s).toString();
        variables.push(spVar);
        variables.push(this.makeVar('P', regs.p, 2));
        // Memory region shortcuts
        const ramVar = new Variable('RAM', '$0000-$FFFF', 0);
        (ramVar as unknown as DebugProtocol.Variable).memoryReference = '0';
        variables.push(ramVar);
    }

    private async populateFlags(variables: Variable[]): Promise<void> {
        const p = (await this.getRegisters()).p;
        variables.push(new Variable('N (Negative)', (p & 0x80) ? '1' : '0', 0));
        variables.push(new Variable('V (Overflow)', (p & 0x40) ? '1' : '0', 0));
        variables.push(new Variable('B (Break)', (p & 0x10) ? '1' : '0', 0));
        variables.push(new Variable('D (Decimal)', (p & 0x08) ? '1' : '0', 0));
        variables.push(new Variable('I (IRQ Disable)', (p & 0x04) ? '1' : '0', 0));
        variables.push(new Variable('Z (Zero)', (p & 0x02) ? '1' : '0', 0));
        variables.push(new Variable('C (Carry)', (p & 0x01) ? '1' : '0', 0));
    }

    private async populateLocals(variables: Variable[]): Promise<void> {
        if (!this.debugInfo) return;

        const regs = await this.getRegisters();
        const localVars = this.debugInfo.getLocalsForAddress(regs.pc);

        if (localVars.length === 0) {
            // Check if we're in a known function but cc65 didn't emit local info
            const inFunc = this.debugInfo.findFunctionForAddress(regs.pc);
            if (inFunc) {
                variables.push(new Variable(
                    `(${inFunc.name})`,
                    'no local variable info from cc65',
                    0
                ));
            }
            return;
        }

        // Read the cc65 software stack pointer from zero page. Only needed
        // for sc=auto locals; sc=reg locals resolve to an absolute address
        // and don't touch it.
        let stackPtr = 0;
        if (localVars.some(l => l.registerAddress === undefined)) {
            stackPtr = (await this.readWord(this.debugInfo.getZeropageStackPointerAddr())).word;
        }

        for (const local of localVars) {
            // Register variables (cc65 sc=reg) live at a fixed zero-page
            // address in the shared regbank buffer; stack (auto) locals are
            // relative to the current cc65 software stack pointer.
            const addr = local.registerAddress !== undefined
                ? local.registerAddress
                : stackPtr + local.stackPointerOffset + local.stackOffset;
            try {
                const masked = addr & 0xFFFF;
                const { lo, hi } = await this.readWord(masked);
                variables.push(new Variable(local.name, formatByteWord(lo, hi, masked), 0));
            } catch {
                variables.push(new Variable(local.name, '<unavailable>', 0));
            }
        }
    }

    private async populateGlobals(variables: Variable[]): Promise<void> {
        if (!this.debugInfo) return;
        await this.populateSymbols(variables, this.debugInfo.getSymbols().filter(s => s.isCVariable && !s.isZeroPage));
    }

    private async populateZeroPage(variables: Variable[]): Promise<void> {
        if (!this.debugInfo) return;
        await this.populateSymbols(variables, this.debugInfo.getZeroPageSymbols().filter(s => s.isCVariable));
    }

    private async populateSymbols(variables: Variable[], symbols: DebugSymbol[]): Promise<void> {
        const sorted = symbols.sort((a, b) => a.name.localeCompare(b.name));
        const memory = await this.readSymbolMemory(sorted);
        for (const sym of sorted) {
            const lo = memory.get(sym.address);
            const hi = memory.get(sym.address + 1);
            if (lo === undefined || hi === undefined) {
                variables.push(new Variable(sym.name, '<unavailable>', 0));
                continue;
            }
            const v: DebugProtocol.Variable = {
                name: sym.name,
                value: formatByteWord(lo, hi, sym.address),
                variablesReference: 0,
                memoryReference: sym.address.toString(),
            };
            variables.push(v as Variable);
        }
    }

    // One memory_get per symbol means hundreds of sequential round-trips every
    // time a scope is expanded, so merge the 2-byte windows into contiguous
    // ranges (a small gap is cheaper to read than an extra request) and fetch
    // those in parallel. Addresses left unset read as <unavailable>.
    private async readSymbolMemory(symbols: DebugSymbol[]): Promise<Map<number, number>> {
        const MAX_GAP = 16;
        const addresses = [...new Set(symbols.map(s => s.address))].sort((a, b) => a - b);

        const ranges: { start: number; end: number }[] = [];
        for (const addr of addresses) {
            const end = Math.min(0xFFFF, addr + 1);
            const last = ranges[ranges.length - 1];
            if (last && addr - last.end <= MAX_GAP) {
                last.end = Math.max(last.end, end);
            } else {
                ranges.push({ start: addr, end });
            }
        }

        const bytes = new Map<number, number>();
        await Promise.all(ranges.map(async (range) => {
            const size = range.end - range.start + 1;
            try {
                const data = await this.monitor.getMemory(0, range.start, size);
                for (let i = 0; i < size; i++) {
                    const byte = parseInt(data.substring(i * 2, i * 2 + 2), 16);
                    if (!isNaN(byte)) bytes.set(range.start + i, byte);
                }
            } catch {
                // Leave this range unset.
            }
        }));
        return bytes;
    }

    private async populateHardware(variables: Variable[]): Promise<void> {
        try {
            const hw = await this.getHardwareStatus();
            const regs = await this.getRegisters();

            variables.push(new Variable('Cycles', `${regs.cycles}`, 0));
            variables.push(new Variable('CPU Halted', `${hw['halted']}`, 0));
            variables.push(new Variable('IRQ Asserted', `${hw['irq_asserted']}`, 0));
            variables.push(new Variable('IRQ Pending', `${hw['irq_pending']}`, 0));

            // LCD
            const lcd = hw['lcd'] as Record<string, unknown> | undefined;
            if (lcd) {
                const lineStatus = lcd['line_status'] as Record<string, unknown> | undefined;
                if (lineStatus) {
                    const lineNum = lineStatus['line_number'];
                    const lineType = lineStatus['line_type'] as string || '';
                    if (lineNum !== undefined)
                        variables.push(new Variable('LCD Line', `${lineNum} (${lineType})`, 0));
                }
                const dispAdr = lcd['display_address'] as Record<string, unknown> | undefined;
                if (dispAdr && dispAdr['value'])
                    variables.push(new Variable('DISPADR', `$${dispAdr['value']}`, 0));
                const vidBas = lcd['video_base'] as Record<string, unknown> | undefined;
                if (vidBas && vidBas['value'])
                    variables.push(new Variable('VIDBAS', `$${vidBas['value']}`, 0));
            }

            // Cart
            const cart = hw['cart'] as Record<string, unknown> | undefined;
            if (cart) {
                const addrGen = cart['address_generation'] as Record<string, unknown> | undefined;
                if (addrGen) {
                    if (addrGen['page_offset'] !== undefined)
                        variables.push(new Variable('Cart Page', `$${addrGen['page_offset']}`, 0));
                }
                const bank0 = cart['bank0'] as Record<string, unknown> | undefined;
                const bank1 = cart['bank1'] as Record<string, unknown> | undefined;
                if (bank0 && bank0['page_size'] !== undefined)
                    variables.push(new Variable('Cart Bank0', `page:${bank0['page_size']}`, 0));
                if (bank1 && bank1['page_size'] !== undefined)
                    variables.push(new Variable('Cart Bank1', `page:${bank1['page_size']}`, 0));
            }
        } catch {
            variables.push(new Variable('Hardware', '<unavailable>', 0));
        }
    }

    private async populateTimers(variables: Variable[]): Promise<void> {
        try {
            const hw = await this.getHardwareStatus();
            const timers = hw['timers'] as Record<string, unknown> | undefined;
            if (timers && timers['timers']) {
                const timerArr = timers['timers'] as Array<Record<string, unknown>>;
                for (const t of timerArr) {
                    const idx = t['index'] as number;
                    const name = t['name'] as string || `Timer ${idx}`;
                    const counter = t['counter'] as string || '00';
                    const backup = t['backup'] as string || '00';
                    const enabled = t['enabled'] as boolean;
                    variables.push(new Variable(
                        `${idx}: ${name}`,
                        `cnt:$${counter} bkp:$${backup} ${enabled ? 'ON' : 'off'}`,
                        0
                    ));
                }
            }
        } catch {
            variables.push(new Variable('Timers', '<unavailable>', 0));
        }
    }

    private async populateAudio(variables: Variable[]): Promise<void> {
        try {
            const hw = await this.getHardwareStatus();
            const audio = hw['audio'] as Record<string, unknown> | undefined;
            if (audio && audio['channels']) {
                const channels = audio['channels'] as Array<Record<string, unknown>>;
                for (const ch of channels) {
                    const idx = ch['index'] as number;
                    const vol = ch['volume'] as string || '00';
                    const output = ch['output'] as string || '00';
                    const enabled = ch['enabled'] as boolean;
                    variables.push(new Variable(
                        `Ch ${idx}`,
                        `vol:$${vol} out:$${output} ${enabled ? 'ON' : 'off'}`,
                        0
                    ));
                }
            }
        } catch {
            variables.push(new Variable('Audio', '<unavailable>', 0));
        }
    }

    // -- Breakpoints --

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        const sourcePath = args.source.path || '';
        const requestedBps = args.breakpoints || [];
        const resultBps: DebugProtocol.Breakpoint[] = [];

        // Clear previous breakpoints, conditions, and logpoints for this source file
        const prevAddresses = this.sourceBreakpoints.get(sourcePath) || [];
        for (const addr of prevAddresses) {
            this.breakpointConditions.delete(addr);
            this.breakpointLogMessages.delete(addr);
        }
        await this.clearBreakpoints(prevAddresses);

        const newAddresses: number[] = [];

        for (const reqBp of requestedBps) {
            let address: number | undefined;
            let verifiedLine = reqBp.line;

            if (this.debugInfo) {
                const location = this.debugInfo.findNearestCodeLine(sourcePath, reqBp.line);
                if (location) {
                    address = location.address;
                    verifiedLine = location.line;
                }
            }

            if (address !== undefined) {
                try {
                    await this.monitor.setBreakpoint(address, 'exec');
                    newAddresses.push(address);

                    // Track condition if present
                    if (reqBp.condition) {
                        this.breakpointConditions.set(address, reqBp.condition);
                    }
                    // Hit count condition
                    if (reqBp.hitCondition) {
                        const hitExpr = `__hitcount__ ${reqBp.hitCondition}`;
                        this.breakpointConditions.set(address, hitExpr);
                    }
                    // Logpoint message
                    if (reqBp.logMessage) {
                        this.breakpointLogMessages.set(address, reqBp.logMessage);
                    }

                    resultBps.push({
                        verified: true,
                        line: verifiedLine,
                        source: args.source
                    });
                } catch {
                    resultBps.push({ verified: false, line: reqBp.line });
                }
            } else {
                resultBps.push({
                    verified: false,
                    line: reqBp.line,
                    message: 'No code at this line'
                });
            }
        }

        this.sourceBreakpoints.set(sourcePath, newAddresses);
        response.body = { breakpoints: resultBps };
        this.sendResponse(response);
    }

    // -- Evaluate (hover/watch) --

    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments
    ): Promise<void> {
        try {
            const expr = args.expression.trim();

            // Check for register names
            const lowerExpr = expr.toLowerCase();
            if (REGISTER_NAMES.includes(lowerExpr)) {
                const regs = await this.getRegisters();
                const val = regs[lowerExpr as keyof CpuRegisters] as number;
                response.body = {
                    result: `${hex(val, lowerExpr === 'pc' ? 4 : 2)} (${val})`,
                    variablesReference: 0
                };
                this.sendResponse(response);
                return;
            }

            // Check for hex address ($xxxx or 0xXXXX)
            let addrMatch = expr.match(/^\$([0-9a-fA-F]{1,4})$/);
            if (!addrMatch) {
                addrMatch = expr.match(/^0x([0-9a-fA-F]{1,4})$/i);
            }
            if (addrMatch) {
                const addr = parseInt(addrMatch[1], 16);
                const val = await this.readByte(addr);
                response.body = {
                    result: `[${hex(addr, 4)}] = ${hex(val, 2)} (${val})`,
                    variablesReference: 0
                };
                this.sendResponse(response);
                return;
            }

            // Check for symbol lookup -- read the VALUE at the symbol's address
            if (this.debugInfo) {
                const sym = this.debugInfo.findSymbol(expr);
                if (sym) {
                    const { lo, hi } = await this.readWord(sym.address);
                    response.body = {
                        result: formatByteWord(lo, hi, sym.address),
                        variablesReference: 0,
                        memoryReference: sym.address.toString()
                    };
                    this.sendResponse(response);
                    return;
                }
            }

            response.body = {
                result: `'${expr}' not found`,
                variablesReference: 0
            };
            this.sendResponse(response);
        } catch (err) {
            response.success = false;
            response.message = `Evaluate failed: ${err}`;
            this.sendResponse(response);
        }
    }

    // -- Disassembly --

    protected async disassembleRequest(
        response: DebugProtocol.DisassembleResponse,
        args: DebugProtocol.DisassembleArguments
    ): Promise<void> {
        try {
            // Parse memoryReference as hex address
            const baseAddr = parseInt(args.memoryReference, 10) || 0;
            const offset = args.offset || 0;
            const count = args.instructionCount || 32;
            const startAddr = Math.max(0, baseAddr + offset);
            // Request a generous range since we don't know instruction sizes ahead of time
            const endAddr = Math.min(0xFFFF, startAddr + count * 3);

            const lines = await this.monitor.getDisassembly(startAddr, endAddr);
            const instructions: DebugProtocol.DisassembledInstruction[] = [];

            for (const line of lines) {
                if (instructions.length >= count) break;

                const addrHex = `0x${line.address.toString(16).toUpperCase().padStart(4, '0')}`;
                const source = this.resolveSource(line.address);

                const instr: DebugProtocol.DisassembledInstruction = {
                    address: addrHex,
                    instruction: line.name,
                    instructionBytes: line.bytes,
                };

                if (source) {
                    instr.location = source.vscodeSource;
                    instr.line = source.line;
                }

                // Show symbol label if present
                if (this.debugInfo) {
                    const sym = this.debugInfo.findSymbolAtAddress(line.address);
                    if (sym) {
                        instr.symbol = sym.name;
                    }
                }

                instructions.push(instr);
            }

            response.body = { instructions };
            this.sendResponse(response);
        } catch (err) {
            response.success = false;
            response.message = `Disassembly failed: ${err}`;
            this.sendResponse(response);
        }
    }

    // -- Read memory --

    protected async readMemoryRequest(
        response: DebugProtocol.ReadMemoryResponse,
        args: DebugProtocol.ReadMemoryArguments
    ): Promise<void> {
        try {
            const baseAddr = parseInt(args.memoryReference, 10) || 0;
            const offset = args.offset || 0;
            const count = args.count;
            const addr = Math.max(0, baseAddr + offset);

            const hex = await this.monitor.getMemory(0, addr, count);
            // Convert hex string to base64
            const bytes = Buffer.from(hex, 'hex');
            response.body = {
                address: `0x${addr.toString(16)}`,
                data: bytes.toString('base64'),
                unreadableBytes: 0,
            };
            this.sendResponse(response);
        } catch (err) {
            response.success = false;
            response.message = `Read memory failed: ${err}`;
            this.sendResponse(response);
        }
    }

    // -- Breakpoint hit handling (conditional, logpoints) --

    private async handleBreakpointHit(): Promise<void> {
        try {
            const regs = await this.getRegisters();

            // Check for logpoint first
            const logMsg = this.breakpointLogMessages.get(regs.pc);
            if (logMsg) {
                const output = await this.interpolateLogMessage(logMsg);
                this.sendEvent(new OutputEvent(output + '\n', 'console'));
                await this.monitor.continue_();
                return;
            }

            const condition = this.breakpointConditions.get(regs.pc);

            if (!condition) {
                this.sendEvent(new StoppedEvent('breakpoint', THREAD_ID));
                return;
            }

            // Handle hit count conditions
            if (condition.startsWith('__hitcount__ ')) {
                const target = parseInt(condition.substring(13), 10);
                const count = (this.hitCounts.get(regs.pc) || 0) + 1;
                this.hitCounts.set(regs.pc, count);
                if (count >= target) {
                    this.hitCounts.set(regs.pc, 0);
                    this.sendEvent(new StoppedEvent('breakpoint', THREAD_ID));
                } else {
                    await this.monitor.continue_();
                }
                return;
            }

            // Evaluate condition expression
            const result = await this.evaluateCondition(condition);
            if (result) {
                this.sendEvent(new StoppedEvent('breakpoint', THREAD_ID));
            } else {
                await this.monitor.continue_();
            }
        } catch {
            this.sendEvent(new StoppedEvent('breakpoint', THREAD_ID));
        }
    }

    private async interpolateLogMessage(msg: string): Promise<string> {
        // Replace {expression} with evaluated values
        const regs = await this.getRegisters();
        return msg.replace(/\{([^}]+)\}/g, (_match, expr: string) => {
            const e = expr.trim().toLowerCase();
            // Register names
            if (REGISTER_NAMES.includes(e)) {
                const val = regs[e as keyof CpuRegisters] as number;
                return hex(val, e === 'pc' ? 4 : 2);
            }
            // Symbol lookup
            if (this.debugInfo) {
                const sym = this.debugInfo.findSymbol(expr.trim());
                if (sym) return hex(sym.address, 4);
            }
            return `{${expr}}`;
        });
    }

    private async evaluateCondition(expr: string): Promise<boolean> {
        // Supported forms:
        //   A == 5, X != 0, Y > 10
        //   $addr == value (memory byte comparison)
        //   symbolName == value
        const regs = await this.getRegisters();

        // Try "register op value"
        const regMatch = expr.match(REGISTER_CONDITION_RE);
        if (regMatch) {
            const regName = regMatch[1].toLowerCase();
            const op = regMatch[2];
            const val = this.parseNumber(regMatch[3]);
            const regVal = regs[regName as keyof CpuRegisters] as number;
            return this.compareValues(regVal, op, val);
        }

        // Try "$addr op value" (memory comparison)
        const memMatch = expr.match(/^\$([0-9a-fA-F]{1,4})\s*(==|!=|<|>|<=|>=)\s*(\$?[0-9a-fA-Fx]+)$/);
        if (memMatch) {
            const addr = parseInt(memMatch[1], 16);
            const op = memMatch[2];
            const val = this.parseNumber(memMatch[3]);
            return this.compareValues(await this.readByte(addr), op, val);
        }

        // Try "symbol op value"
        if (this.debugInfo) {
            const symMatch = expr.match(/^(\w+)\s*(==|!=|<|>|<=|>=)\s*(\$?[0-9a-fA-Fx]+)$/);
            if (symMatch) {
                const sym = this.debugInfo.findSymbol(symMatch[1]);
                if (sym) {
                    const op = symMatch[2];
                    const val = this.parseNumber(symMatch[3]);
                    return this.compareValues(await this.readByte(sym.address), op, val);
                }
            }
        }

        // Can't parse -- treat as true (stop)
        return true;
    }

    private parseNumber(s: string): number {
        s = s.trim();
        if (s.startsWith('$')) return parseInt(s.substring(1), 16);
        if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s.substring(2), 16);
        return parseInt(s, 10);
    }

    private compareValues(left: number, op: string, right: number): boolean {
        switch (op) {
            case '==': return left === right;
            case '!=': return left !== right;
            case '<': return left < right;
            case '>': return left > right;
            case '<=': return left <= right;
            case '>=': return left >= right;
            default: return true;
        }
    }

    // -- Data breakpoints --

    protected dataBreakpointInfoRequest(
        response: DebugProtocol.DataBreakpointInfoResponse,
        args: DebugProtocol.DataBreakpointInfoArguments
    ): void {
        // Variables with a memoryReference can have data breakpoints
        const name = args.name;
        let address: number | undefined;

        // Check if it's a hex address
        if (name.startsWith('$') || name.startsWith('0x')) {
            address = this.parseNumber(name);
        }

        // Check if it's a known symbol
        if (address === undefined && this.debugInfo) {
            const sym = this.debugInfo.findSymbol(name);
            if (sym) address = sym.address;
        }

        if (address !== undefined) {
            response.body = {
                dataId: address.toString(),
                description: `${name} @${hex(address, 4)}`,
                accessTypes: ['read', 'write', 'readWrite'],
                canPersist: false,
            };
        } else {
            response.body = {
                dataId: null,
                description: 'Cannot set data breakpoint',
            };
        }

        this.sendResponse(response);
    }

    protected async setDataBreakpointsRequest(
        response: DebugProtocol.SetDataBreakpointsResponse,
        args: DebugProtocol.SetDataBreakpointsArguments
    ): Promise<void> {
        await this.clearBreakpoints(this.dataBreakpoints);
        this.dataBreakpoints.clear();

        const resultBps: DebugProtocol.Breakpoint[] = [];

        for (const dbp of args.breakpoints) {
            const address = parseInt(dbp.dataId, 10);
            if (isNaN(address)) {
                resultBps.push({ verified: false });
                continue;
            }

            let type: string;
            switch (dbp.accessType) {
                case 'read': type = 'read'; break;
                case 'write': type = 'write'; break;
                case 'readWrite': type = 'all'; break;
                default: type = 'write'; break;
            }

            try {
                await this.monitor.setBreakpoint(address, type);
                this.dataBreakpoints.add(address);
                resultBps.push({ verified: true });
            } catch {
                resultBps.push({ verified: false });
            }
        }

        response.body = { breakpoints: resultBps };
        this.sendResponse(response);
    }

    // -- Set variable (edit registers) --

    protected async setVariableRequest(
        response: DebugProtocol.SetVariableResponse,
        args: DebugProtocol.SetVariableArguments
    ): Promise<void> {
        const scopeName = this.variableHandles.get(args.variablesReference);
        try {
            if (scopeName === 'registers') {
                const val = this.parseNumber(args.value);
                await this.monitor.setRegister(args.name, val);
                this.invalidateStateCache();
                response.body = {
                    value: `${hex(val, args.name === 'PC' ? 4 : 2)} (${val})`,
                };
            } else {
                response.success = false;
                response.message = 'Cannot set this variable';
            }
        } catch (err) {
            response.success = false;
            response.message = `${err}`;
        }
        this.sendResponse(response);
    }

    // -- Write memory --

    protected async writeMemoryRequest(
        response: DebugProtocol.WriteMemoryResponse,
        args: DebugProtocol.WriteMemoryArguments
    ): Promise<void> {
        try {
            const addr = parseInt(args.memoryReference, 10) || 0;
            const offset = args.offset || 0;
            const targetAddr = Math.max(0, addr + offset);
            const data = Buffer.from(args.data, 'base64');
            const hex = data.toString('hex');
            await this.monitor.setMemory(0, targetAddr, hex);
            response.body = { bytesWritten: data.length };
            this.sendResponse(response);
        } catch (err) {
            response.success = false;
            response.message = `Write memory failed: ${err}`;
            this.sendResponse(response);
        }
    }

    // -- Restart --

    protected async restartRequest(
        response: DebugProtocol.RestartResponse,
        _args: DebugProtocol.RestartArguments
    ): Promise<void> {
        try {
            await this.monitor.reset();
            if (this.launchArgs?.stopOnEntry) {
                this.sendEvent(new StoppedEvent('entry', THREAD_ID));
            } else {
                await this.monitor.continue_();
            }
        } catch (err) {
            response.success = false;
            response.message = `Restart failed: ${err}`;
        }
        this.sendResponse(response);
    }

    // -- Function breakpoints --

    protected async setFunctionBreakPointsRequest(
        response: DebugProtocol.SetFunctionBreakpointsResponse,
        args: DebugProtocol.SetFunctionBreakpointsArguments
    ): Promise<void> {
        await this.clearBreakpoints(this.functionBreakpoints);
        this.functionBreakpoints.clear();

        const resultBps: DebugProtocol.Breakpoint[] = [];

        for (const fbp of args.breakpoints) {
            let address: number | undefined;
            if (this.debugInfo) {
                const sym = this.debugInfo.findSymbol(fbp.name);
                if (sym) address = sym.address;
            }

            if (address !== undefined) {
                try {
                    await this.monitor.setBreakpoint(address, 'exec');
                    this.functionBreakpoints.add(address);
                    if (fbp.condition) {
                        this.breakpointConditions.set(address, fbp.condition);
                    }
                    resultBps.push({ verified: true });
                } catch {
                    resultBps.push({ verified: false, message: 'Failed to set breakpoint' });
                }
            } else {
                resultBps.push({ verified: false, message: `Symbol '${fbp.name}' not found` });
            }
        }

        response.body = { breakpoints: resultBps };
        this.sendResponse(response);
    }

    // -- Instruction breakpoints --

    protected async setInstructionBreakpointsRequest(
        response: DebugProtocol.SetInstructionBreakpointsResponse,
        args: DebugProtocol.SetInstructionBreakpointsArguments
    ): Promise<void> {
        await this.clearBreakpoints(this.instructionBreakpoints);
        this.instructionBreakpoints.clear();

        const resultBps: DebugProtocol.Breakpoint[] = [];

        for (const ibp of args.breakpoints) {
            const addr = parseInt(ibp.instructionReference, 10) || 0;
            const offset = ibp.offset || 0;
            const targetAddr = addr + offset;

            try {
                await this.monitor.setBreakpoint(targetAddr, 'exec');
                this.instructionBreakpoints.add(targetAddr);
                resultBps.push({
                    verified: true,
                    instructionReference: targetAddr.toString(),
                });
            } catch {
                resultBps.push({ verified: false });
            }
        }

        response.body = { breakpoints: resultBps };
        this.sendResponse(response);
    }

    // -- Loaded sources --

    protected loadedSourcesRequest(
        response: DebugProtocol.LoadedSourcesResponse,
        _args: DebugProtocol.LoadedSourcesArguments
    ): void {
        const sources: DebugProtocol.Source[] = [];
        if (this.debugInfo) {
            const seen = new Set<string>();
            for (const [, locs] of this.debugInfo.getAllAddressToSource()) {
                for (const loc of locs) {
                    if (!seen.has(loc.source)) {
                        seen.add(loc.source);
                        sources.push({ name: path.basename(loc.source), path: loc.source });
                    }
                }
            }
        }
        response.body = { sources };
        this.sendResponse(response);
    }

    // -- Goto targets (set next statement) --

    protected async gotoTargetsRequest(
        response: DebugProtocol.GotoTargetsResponse,
        args: DebugProtocol.GotoTargetsArguments
    ): Promise<void> {
        const targets: DebugProtocol.GotoTarget[] = [];
        const sourcePath = args.source.path || '';
        const line = args.line;

        if (this.debugInfo) {
            const loc = this.debugInfo.findNearestCodeLine(sourcePath, line);
            if (loc) {
                targets.push({
                    id: loc.address,
                    label: `Line ${loc.line} (${hex(loc.address, 4)})`,
                    line: loc.line,
                });
            }
        }

        response.body = { targets };
        this.sendResponse(response);
    }

    protected async gotoRequest(
        response: DebugProtocol.GotoResponse,
        args: DebugProtocol.GotoArguments
    ): Promise<void> {
        try {
            // targetId is the address from gotoTargetsRequest
            await this.monitor.setRegister('PC', args.targetId);
            this.sendEvent(new StoppedEvent('goto', THREAD_ID));
        } catch (err) {
            response.success = false;
            response.message = `Goto failed: ${err}`;
        }
        this.sendResponse(response);
    }

    // -- Completions (debug console autocomplete) --

    protected completionsRequest(
        response: DebugProtocol.CompletionsResponse,
        args: DebugProtocol.CompletionsArguments
    ): void {
        const text = args.text.substring(0, args.column - 1);
        const targets: DebugProtocol.CompletionItem[] = [];

        // Register names
        for (const reg of REGISTER_NAMES) {
            if (reg.startsWith(text.toLowerCase())) {
                targets.push({ label: reg.toUpperCase() });
            }
        }

        // Symbol names
        if (this.debugInfo) {
            const symbols = this.debugInfo.getSymbols();
            for (const sym of symbols) {
                if (sym.name.toLowerCase().startsWith(text.toLowerCase())) {
                    targets.push({ label: sym.name });
                }
                const bare = sym.name.startsWith('_') ? sym.name.substring(1) : null;
                if (bare && bare.toLowerCase().startsWith(text.toLowerCase())) {
                    targets.push({ label: bare });
                }
            }
        }

        response.body = { targets };
        this.sendResponse(response);
    }

    // -- Source-line stepping --

    private async beginSourceLineStep(stepFn: () => Promise<void>): Promise<void> {
        if (!this.debugInfo) {
            await stepFn();
            return;
        }

        const regs = await this.getRegisters();
        const loc = this.debugInfo.findSourceForAddress(regs.pc);

        this.sourceStepOriginFile = loc?.source || '';
        this.sourceStepOriginLine = loc?.line || 0;
        this.sourceStepFn = stepFn;
        this.sourceStepCount = 0;
        this.sourceStepStopReason = '';
        this.sourceStepActive = true;

        if (this.traceSteps) {
            const file = loc ? path.basename(loc.source) : '?';
            const line = loc?.line || 0;
            this.sendEvent(new OutputEvent(
                `[step] begin from ${hex(regs.pc, 4)} ${file}:${line}\n`, 'console'));
        }

        await stepFn();
    }

    private async handleSourceStepStopped(): Promise<void> {
        this.sourceStepCount++;

        if (!this.debugInfo || !this.sourceStepFn || this.sourceStepCount >= LynxDebugSession.SOURCE_STEP_MAX) {
            this.sourceStepActive = false;
            if (this.traceSteps) {
                this.sendEvent(new OutputEvent(
                    `[step] hit limit (count=${this.sourceStepCount})\n`, 'console'));
            }
            this.sendEvent(new StoppedEvent('step', THREAD_ID));
            return;
        }

        try {
            const regs = await this.getRegisters();
            const loc = this.debugInfo.findSourceForAddress(regs.pc);
            const pc = hex(regs.pc, 4);

            if (loc) {
                const sameFile = loc.source.toLowerCase() === this.sourceStepOriginFile.toLowerCase();
                const sameLine = loc.line === this.sourceStepOriginLine;

                if (this.traceSteps) {
                    const file = path.basename(loc.source);
                    const decision = (!sameFile || !sameLine) ? 'STOP' : 'continue (same line)';
                    this.sendEvent(new OutputEvent(
                        `[step] #${this.sourceStepCount} ${pc} -> ${file}:${loc.line} ${decision}\n`, 'console'));
                }

                if (!sameFile || !sameLine) {
                    this.sourceStepActive = false;
                    const reason = this.sourceStepStopReason === 'breakpoint' ? 'breakpoint' : 'step';
                    this.sendEvent(new StoppedEvent(reason, THREAD_ID));
                    return;
                }
            } else {
                // No source mapping -- keep stepping through unmapped code
                if (this.traceSteps) {
                    this.sendEvent(new OutputEvent(
                        `[step] #${this.sourceStepCount} ${pc} -> unmapped\n`, 'console'));
                }
            }
            await this.sourceStepFn();
        } catch {
            this.sourceStepActive = false;
            this.sendEvent(new StoppedEvent('step', THREAD_ID));
        }
    }

    // -- Helpers --

    private resolveSource(address: number): { vscodeSource: Source; line: number } | null {
        if (!this.debugInfo) return null;

        const loc = this.debugInfo.findSourceForAddress(address);
        if (!loc) return null;

        return {
            vscodeSource: new Source(path.basename(loc.source), loc.source),
            line: loc.line
        };
    }

    // Every state-changing event routes through sendEvent, so invalidating here
    // covers the stops and resumes this adapter originates itself (restart,
    // goto, the source-step loop) as well as the monitor's own events.
    public sendEvent(event: DebugProtocol.Event): void {
        if (event.event === 'stopped' || event.event === 'continued') {
            this.invalidateStateCache();
        }
        super.sendEvent(event);
    }

    private invalidateStateCache(): void {
        this.cachedRegisters = null;
        this.cachedHardware = null;
    }

    private getRegisters(): Promise<CpuRegisters> {
        if (!this.cachedRegisters) {
            const pending = this.monitor.getRegisters();
            // A failed read must not stay cached for the rest of the stop.
            pending.catch(() => { if (this.cachedRegisters === pending) this.cachedRegisters = null; });
            this.cachedRegisters = pending;
        }
        return this.cachedRegisters;
    }

    private getHardwareStatus(): Promise<Record<string, unknown>> {
        if (!this.cachedHardware) {
            const pending = this.monitor.getHardwareStatus();
            pending.catch(() => { if (this.cachedHardware === pending) this.cachedHardware = null; });
            this.cachedHardware = pending;
        }
        return this.cachedHardware;
    }

    private async readByte(address: number): Promise<number> {
        const data = await this.monitor.getMemory(0, address, 1);
        return parseInt(data.substring(0, 2), 16);
    }

    private async readWord(address: number): Promise<{ lo: number; hi: number; word: number }> {
        const data = await this.monitor.getMemory(0, address, 2);
        const lo = parseInt(data.substring(0, 2), 16);
        const hi = parseInt(data.substring(2, 4), 16);
        return { lo, hi, word: lo | (hi << 8) };
    }

    private async clearBreakpoints(addresses: Iterable<number>): Promise<void> {
        for (const addr of addresses) {
            try { await this.monitor.deleteBreakpoint(addr); } catch { /* ignore */ }
        }
    }

    private formatAddress(addr: number): string {
        const addrHex = hex(addr, 4);
        if (this.debugInfo) {
            // Prefer the enclosing function: findSymbolAtAddress only matches
            // an exact entry address, missing return addresses and mid-function
            // step positions.
            const fn = this.debugInfo.findFunctionForAddress(addr);
            if (fn) {
                const offset = addr - fn.address;
                const name = offset > 0 ? `${fn.name}+${offset}` : fn.name;
                return `${name} (${addrHex})`;
            }
            const sym = this.debugInfo.findSymbolAtAddress(addr);
            if (sym) {
                return `${sym.name} (${addrHex})`;
            }
        }
        return addrHex;
    }

    private makeVar(name: string, value: number, width: number): Variable {
        return new Variable(name, `${hex(value, width)} (${value})`, 0);
    }

    private allocVariableRef(name: string): number {
        const ref = this.nextVarRef++;
        this.variableHandles.set(ref, name);
        return ref;
    }
}
