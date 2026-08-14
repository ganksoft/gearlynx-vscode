// Types shared across the LynxDebug extension

export interface MonitorRequest {
    id: number;
    cmd: string;
    [key: string]: unknown;
}

export interface MonitorResponse {
    id: number;
    success: boolean;
    data: Record<string, unknown>;
}

export interface MonitorEvent {
    id: 0;
    event: string;
    data?: Record<string, unknown>;
}

export type MonitorMessage = MonitorResponse | MonitorEvent;

export interface CpuRegisters {
    pc: number;
    a: number;
    x: number;
    y: number;
    s: number;
    p: number;
    cycles: number;
    halted: boolean;
}

export interface DisasmLine {
    address: number;
    name: string;
    bytes: string;
    size: number;
    jump: boolean;
    jump_address: number;
    subroutine: boolean;
}

export interface DebugStatus {
    paused: boolean;
    idle: boolean;
    empty: boolean;
    pc: number;
    run_state: string;
    stop_reason: string;
}

export interface HandshakeInfo {
    protocolVersion: number;
    emulatorVersion: string;
}

// Debug info types for source-level debugging

export interface SourceLocation {
    source: string;
    line: number;
    address: number;
    addressEnd: number;
    segmentId: number;
}

export interface DebugSymbol {
    name: string;
    address: number;
    isGlobal: boolean;
    isZeroPage: boolean;
    isCVariable: boolean;
    isCompilerGenerated: boolean;
    segment: string;
}

export interface DebugFunction {
    name: string;
    address: number;
    addressEnd: number;
    source: string;
    line: number;
    segment: string;
    segmentId: number;
    isLibrary: boolean;
    libraryName?: string;
}

export interface LocalVariable {
    name: string;
    scopeId: number;
    functionAddress: number;
    functionEndAddress: number;
    stackOffset: number;
    stackPointerOffset: number;
    registerAddress?: number;
    segmentId: number;
}

export interface DebugInfoData {
    addressToSource: Map<number, SourceLocation[]>;
    sourceToAddresses: Map<string, Map<number, number[]>>;
    symbols: DebugSymbol[];
    functions: DebugFunction[];
    locals: LocalVariable[];
    zeropageStackPointerAddr: number;
    overlayGroups: OverlayGroup[];
    segments: SegmentInfo[];
    fileMtimes: Map<string, number>;
}

// A segment is 'code' when it hosts at least one function symbol, otherwise
// 'data' -- cc65 debug info only distinguishes read-only vs read-write.
export type SegmentKind = 'code' | 'data';

export interface SegmentInfo {
    name: string;
    start: number;
    size: number;
    type: string;
    kind: SegmentKind;
}

export interface OverlayGroup {
    segmentIds: number[];
    segmentNames: string[];
    // Parallel to segmentNames: the classified kind of each overlay segment.
    segmentKinds: SegmentKind[];
}
