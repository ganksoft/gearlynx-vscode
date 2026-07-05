import * as path from 'path';
import * as fs from 'fs';
import { SourceLocation, DebugSymbol, DebugFunction, LocalVariable, OverlayGroup, SegmentInfo, DebugInfoData } from './types';
import { Cc65DebugInfo } from './debug_info_cc65';
import { SymDebugInfo } from './debug_info_sym';

export class DebugInfo {
    private data: DebugInfoData;
    private sourceRoots: string[];
    private activeOverlaySegmentId: number | null = null;
    private activeOverlayName: string | null = null;
    private sourceResolveCache = new Map<string, string | null>();
    // Memoize address->location lookups. findSourceForAddress is called once per
    // single-instruction step during source-line stepping and once per row when
    // building the Symbol Table panel, so without this it dominates when
    // stepping through unmapped code or rendering a large symbol list (null
    // results are cached too). Invalidated on overlay change, the only thing
    // that alters which mappings resolve.
    private addressLocationCache = new Map<number, SourceLocation | null>();
    // Lazily-built ascending address list for binary search in
    // findSourceForAddress. Never invalidated: addressToSource itself is fixed
    // once parsed, only which mappings resolve changes with the active overlay.
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
        const roots = sourceRoots || [];
        roots.unshift(path.dirname(filePath));

        let data: DebugInfoData | null = null;

        if (ext === '.dbg') {
            data = Cc65DebugInfo.parse(filePath, roots);
        } else if (ext === '.sym') {
            data = SymDebugInfo.parse(filePath);
        }

        if (!data) return null;
        return new DebugInfo(data, roots);
    }

    // Common cc65 debug-file naming conventions relative to a rom path: game.dbg,
    // game.lnx.dbg, game.sym, game.lnx.sym. Shared by launch-config resolution
    // (extension.ts) and the no-session workspace scan (workspace_debug_info.ts)
    // so both pick the same file. Returns the full candidate list too, so callers
    // can log what was tried when nothing is found.
    static findCandidatePath(rom: string): { found?: string; candidates: string[] } {
        const baseName = rom.replace(/\.[^.]+$/, '');
        const candidates = [
            baseName + '.dbg',
            rom + '.dbg',
            baseName + '.sym',
            rom + '.sym',
        ];
        return { found: candidates.find(c => fs.existsSync(c)), candidates };
    }

    // Decides which debug file to use for a rom: an explicit debugFile is
    // trusted as-is (even if missing on disk -- load() then just returns null,
    // the same graceful "no debug info" outcome as a session with none
    // configured); auto-detection only kicks in when none was given. Shared by
    // both a real debug session launch (extension.ts) and the no-session
    // workspace scan (workspace_debug_info.ts) so they agree on the outcome.
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

    // Find the nearest mapping (largest start address <= target) whose range
    // covers the target, whose segment is active, and whose source file
    // actually exists on disk. Skipping unresolvable mappings is essential:
    // cc65 emits runtime assembly mappings (e.g. bootldr.s, not on the user's
    // disk) that share addresses with C statements. If such a mapping shadowed
    // the enclosing C line, the address would report as unmapped during
    // stepping. Each address holds one candidate per segment (overlays share
    // addresses); the active-segment filter selects the candidate for the
    // currently mapped overlay.
    //
    // Binary search finds the starting point (largest address <= target), then
    // walks backward through progressively smaller addresses. Addresses are
    // visited in decreasing order this way, so the first candidate that
    // resolves is necessarily the nearest valid mapping -- same result as a
    // full scan, without scanning addresses that can't be nearer.
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

    getLocalsForAddress(pc: number): LocalVariable[] {
        return this.data.locals.filter(
            l => pc >= l.functionAddress && pc <= l.functionEndAddress
        );
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

    // Resolve a source path recorded in the debug info to an existing on-disk
    // path. cc65 .dbg files store source file names inconsistently: some are
    // absolute (possibly from another machine or a moved project), others are
    // relative to an arbitrary build directory. Handle both by:
    //   1. Using an absolute path as-is when it exists.
    //   2. Resolving a relative path against each source root.
    //   3. Falling back to matching progressively shorter path tails (most
    //      specific first) under each source root, which relocates absolute
    //      paths from another machine and relative paths whose leading segments
    //      differ from the local layout.
    // Returns null when no existing file can be found (never a bad path).
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
