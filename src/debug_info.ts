import * as path from 'path';
import * as fs from 'fs';
import { SourceLocation, DebugSymbol, DebugFunction, LocalVariable, OverlayGroup, SegmentInfo, DebugInfoData } from './types';
import { Cc65DebugInfo } from './debug_info_cc65';
import { SymDebugInfo } from './debug_info_sym';
import { logInfo, logWarn } from './log';

export class DebugInfo {
    private data: DebugInfoData;
    private sourceRoots: string[];
    private activeOverlaySegmentId: number | null = null;
    private activeOverlayName: string | null = null;
    private sourceResolveCache = new Map<string, string | null>();
    // Memoizes findSourceForAddress, which runs per step and per symbol-table
    // row; cleared on overlay change since that's what alters resolution.
    private addressLocationCache = new Map<number, SourceLocation | null>();
    // Lazily-built ascending address list for binary search; never
    // invalidated since addressToSource itself doesn't change after parsing.
    private sortedAddresses: number[] | undefined;

    private constructor(data: DebugInfoData, sourceRoots: string[]) {
        this.data = data;
        this.sourceRoots = sourceRoots;
    }

    static load(filePath: string, sourceRoots?: string[]): DebugInfo | null {
        if (!fs.existsSync(filePath)) {
            return null;
        }

        const ext = path.extname(filePath).toLowerCase();
        // A fresh array, never the caller's: load() runs again on every debug-file
        // watcher event with the same sourceRoots, and prepending in place would
        // grow that array without bound.
        const roots = [path.dirname(filePath), ...(sourceRoots ?? [])];

        let data: DebugInfoData | null = null;

        if (ext === '.dbg') {
            data = Cc65DebugInfo.parse(filePath, roots);
        } else if (ext === '.sym') {
            data = SymDebugInfo.parse(filePath);
        }

        if (!data) {
            logWarn(`Found a ${ext} debug file but could not read it: ${filePath}`);
            return null;
        }

        if (data.symbols.length === 0 && data.functions.length === 0) {
            logWarn(`Parsed ${ext} debug info but found no symbols or functions: ${filePath}. ` +
                'Check that the build produced debug output for this ROM.');
        } else {
            logInfo(`Parsed ${ext} debug info: ${data.symbols.length} symbols, ${data.functions.length} functions, ` +
                `${data.locals.length} locals, ${data.segments.length} segments, ${data.overlayGroups.length} overlay group(s), ` +
                `${data.addressToSource.size} mapped address(es).`);
        }

        return new DebugInfo(data, roots);
    }

    // Common cc65 debug-file naming conventions relative to a rom path.
    // Shared by launch-config resolution and the no-session workspace scan so
    // both pick the same file; returns all candidates so callers can log them.
    private static findCandidatePath(rom: string): { found?: string; candidates: string[] } {
        const baseName = rom.replace(/\.[^.]+$/, '');
        const candidates = [
            baseName + '.dbg',
            rom + '.dbg',
            baseName + '.sym',
            rom + '.sym',
        ];
        return { found: candidates.find(c => fs.existsSync(c)), candidates };
    }

    // An explicit debugFile is trusted as-is (even if missing -- load() then
    // just returns null); auto-detection only kicks in when none was given.
    static resolveDebugFile(rom: string, explicitDebugFile: string | undefined): { path?: string; candidates?: string[] } {
        if (explicitDebugFile) {
            return { path: explicitDebugFile };
        }
        const { found, candidates } = DebugInfo.findCandidatePath(rom);
        return { path: found, candidates };
    }

    findSourceForAddress(address: number): SourceLocation | null {
        const cached = this.addressLocationCache.get(address);
        if (cached !== undefined) {
            return cached;
        }

        const best = this.computeSourceForAddress(address);
        this.addressLocationCache.set(address, best);
        return best;
    }

    // Finds the nearest mapping (largest address <= target) whose segment is
    // active and whose source file exists on disk. Unresolvable mappings are
    // skipped because cc65 emits runtime assembly mappings (e.g. bootldr.s,
    // not on disk) that share addresses with C statements and would otherwise
    // shadow them. Binary search locates the starting address, then walks
    // backward so the first resolvable candidate is necessarily the nearest.
    private computeSourceForAddress(address: number): SourceLocation | null {
        const sorted = this.getSortedAddresses();

        let lo = 0, hi = sorted.length - 1, startIdx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid] <= address) {
                startIdx = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        for (let i = startIdx; i >= 0; i--) {
            const candidates = this.data.addressToSource.get(sorted[i])!;
            for (const candidate of candidates) {
                if (address <= candidate.addressEnd && this.isSegmentActive(candidate.segmentId)) {
                    const resolved = this.resolveLocation(candidate);
                    if (resolved) {
                        return resolved;
                    }
                }
            }
        }

        return null;
    }

    private getSortedAddresses(): number[] {
        if (!this.sortedAddresses) {
            this.sortedAddresses = Array.from(this.data.addressToSource.keys()).sort((a, b) => a - b);
        }
        return this.sortedAddresses;
    }

    findNearestCodeLine(sourcePath: string, line: number): SourceLocation | null {
        const normalizedPath = this.normalizePath(sourcePath);

        // Find all address mappings for this source file
        const fileMap = this.data.sourceToAddresses.get(normalizedPath);
        if (!fileMap) {
            // Try matching by basename
            for (const [key, map] of this.data.sourceToAddresses) {
                if (path.basename(key).toLowerCase() === path.basename(normalizedPath).toLowerCase()) {
                    return this.findNearestInMap(map, line, key);
                }
            }
            return null;
        }

        return this.findNearestInMap(fileMap, line, normalizedPath);
    }

    findSymbol(name: string): DebugSymbol | null {
        const lowerName = name.toLowerCase();
        return this.data.symbols.find(s =>
            s.name.toLowerCase() === lowerName ||
            s.name.toLowerCase() === '_' + lowerName
        ) || null;
    }

    findSymbolAtAddress(address: number): DebugSymbol | null {
        return this.data.symbols.find(s => s.address === address) || null;
    }

    getSymbols(): DebugSymbol[] {
        return this.data.symbols;
    }

    getFunctions(): DebugFunction[] {
        return this.data.functions;
    }

    getAllAddressToSource(): Map<number, SourceLocation[]> {
        return this.data.addressToSource;
    }

    // Overlay-aware: overlay segments share the same runtime address range,
    // so a plain range filter would also match a non-resident overlay's
    // locals. See setActiveOverlay/isSegmentActive.
    getLocalsForAddress(pc: number): LocalVariable[] {
        return this.data.locals.filter(
            l => pc >= l.functionAddress && pc <= l.functionEndAddress && this.isSegmentActive(l.segmentId)
        );
    }

    // Overlay-aware equivalent of getFunctions().find(...) by address; see
    // getLocalsForAddress for why the active-overlay filter is needed here too.
    findFunctionForAddress(pc: number): DebugFunction | null {
        return this.data.functions.find(
            f => pc >= f.address && pc <= f.addressEnd && this.isSegmentActive(f.segmentId)
        ) || null;
    }

    getZeropageStackPointerAddr(): number {
        return this.data.zeropageStackPointerAddr;
    }

    getZeroPageSymbols(): DebugSymbol[] {
        return this.data.symbols.filter(s => s.isZeroPage);
    }

    getSegments(): SegmentInfo[] {
        return this.data.segments;
    }

    // 2-second tolerance absorbs whole-second rounding in cc65's recorded
    // mtime vs fs.Stats.mtimeMs's sub-second precision.
    checkSourceStaleness(): { source: string; dbgMtimeMs: number; fileMtimeMs: number }[] {
        const stale: { source: string; dbgMtimeMs: number; fileMtimeMs: number }[] = [];
        for (const [source, dbgMtimeMs] of this.data.fileMtimes) {
            const resolved = this.resolveSourcePath(source);
            if (!resolved) continue;
            try {
                const fileMtimeMs = fs.statSync(resolved).mtimeMs;
                if (fileMtimeMs - dbgMtimeMs > 2000) {
                    stale.push({ source: resolved, dbgMtimeMs, fileMtimeMs });
                }
            } catch {
                // Source vanished since resolveSourcePath found it -- ignore.
            }
        }
        return stale;
    }

    // -- Overlay management --

    getOverlayGroups(): OverlayGroup[] {
        return this.data.overlayGroups;
    }

    hasOverlays(): boolean {
        return this.data.overlayGroups.length > 0;
    }

    setActiveOverlay(segmentName: string): void {
        for (const group of this.data.overlayGroups) {
            const idx = group.segmentNames.indexOf(segmentName);
            if (idx >= 0) {
                this.activeOverlaySegmentId = group.segmentIds[idx];
                this.activeOverlayName = segmentName;
                this.addressLocationCache.clear();
                return;
            }
        }
    }

    getActiveOverlayName(): string | null {
        return this.activeOverlayName;
    }

    clearActiveOverlay(): void {
        this.activeOverlaySegmentId = null;
        this.activeOverlayName = null;
        this.addressLocationCache.clear();
    }

    private isSegmentActive(segmentId: number): boolean {
        if (this.activeOverlaySegmentId === null) return true;
        // Non-overlay segments are always active
        for (const group of this.data.overlayGroups) {
            if (group.segmentIds.includes(segmentId)) {
                // This is an overlay segment -- only active if selected
                return segmentId === this.activeOverlaySegmentId;
            }
        }
        return true;
    }

    // -- Internal helpers --

    private findNearestInMap(
        map: Map<number, number[]>,
        targetLine: number,
        sourcePath: string
    ): SourceLocation | null {
        // Exact line match -- use the lowest address (the line's entry point).
        // A line maps to multiple addresses and the array is in parse order, not
        // address order, so addrs[0] can be a later occurrence of the line; a
        // breakpoint must land at the line's first instruction.
        const addrs = map.get(targetLine);
        if (addrs && addrs.length > 0) {
            const loc = this.pickCandidate(Math.min(...addrs), sourcePath);
            if (loc) return this.resolveLocation(loc);
        }

        // Find nearest line >= target
        let bestLine = -1;
        for (const [line] of map) {
            if (line >= targetLine && (bestLine === -1 || line < bestLine)) {
                bestLine = line;
            }
        }

        if (bestLine >= 0) {
            const nearAddrs = map.get(bestLine);
            if (nearAddrs && nearAddrs.length > 0) {
                const loc = this.pickCandidate(Math.min(...nearAddrs), sourcePath);
                if (loc) return this.resolveLocation(loc);
            }
        }

        return null;
    }

    // Pick the source candidate at an address that belongs to the given source
    // file (overlapping overlays can register several candidates per address).
    private pickCandidate(address: number, sourcePath: string): SourceLocation | null {
        const candidates = this.data.addressToSource.get(address);
        if (!candidates || candidates.length === 0) return null;
        return candidates.find(c => this.normalizePath(c.source) === sourcePath) ?? candidates[0];
    }


    private resolveLocation(loc: SourceLocation): SourceLocation | null {
        const resolved = this.resolveSourcePath(loc.source);
        if (resolved === null) {
            return null;
        }
        return resolved === loc.source ? loc : { ...loc, source: resolved };
    }

    // cc65 .dbg files store source paths inconsistently -- absolute (maybe
    // from another machine) or relative to an arbitrary build directory.
    // computeSourcePath tries both, then tail-matching, before giving up.
    private resolveSourcePath(source: string): string | null {
        if (!source) {
            return null;
        }

        const cached = this.sourceResolveCache.get(source);
        if (cached !== undefined) {
            return cached;
        }

        const result = this.computeSourcePath(source);
        this.sourceResolveCache.set(source, result);
        return result;
    }

    private computeSourcePath(source: string): string | null {
        // 1. Absolute path that exists on disk.
        if (path.isAbsolute(source) && fs.existsSync(source)) {
            return source;
        }

        // 2. Relative path resolved directly against each source root.
        if (!path.isAbsolute(source)) {
            for (const root of this.sourceRoots) {
                const resolved = path.resolve(root, source);
                if (fs.existsSync(resolved)) {
                    return resolved;
                }
            }
        }

        // 3. Tail matching: strip leading segments and look for the remainder
        //    under each source root, longest (most specific) tail first.
        const segments = source
            .replace(/\\/g, '/')
            .split('/')
            .filter((s) => s.length > 0 && s !== '.');

        for (let i = 0; i < segments.length; i++) {
            const tail = segments.slice(i).join(path.sep);
            if (path.isAbsolute(tail)) {
                continue;
            }
            for (const root of this.sourceRoots) {
                const candidate = path.resolve(root, tail);
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }

        // No existing file found -- don't return a bad path.
        return null;
    }

    private normalizePath(p: string): string {
        return p.replace(/\\/g, '/').toLowerCase();
    }
}
