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
    // Memoize address->location lookups. findSourceForAddress is an O(n) scan of
    // the whole address map and is called once per single-instruction step during
    // source-line stepping, so without this it dominates when stepping through
    // unmapped code (null results are cached too). Invalidated on overlay change,
    // the only thing that alters which mappings resolve.
    private addressLocationCache = new Map<number, SourceLocation | null>();

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

    findSourceForAddress(address: number): SourceLocation | null {
        const cached = this.addressLocationCache.get(address);
        if (cached !== undefined) {
            return cached;
        }

        // Find the nearest mapping (largest start address) whose range covers the
        // target, whose segment is active, and whose source file actually exists
        // on disk. Skipping unresolvable mappings is essential: cc65 emits runtime
        // assembly mappings (e.g. bootldr.s, not on the user's disk) that share
        // addresses with C statements. If such a mapping shadowed the enclosing C
        // line, the address would report as unmapped during stepping.
        let best: SourceLocation | null = null;
        let bestAddr = -1;
        for (const [addr, candidate] of this.data.addressToSource) {
            if (addr <= address && address <= candidate.addressEnd && addr > bestAddr
                && this.isSegmentActive(candidate.segmentId)) {
                const resolved = this.resolveLocation(candidate);
                if (resolved) {
                    best = resolved;
                    bestAddr = addr;
                }
            }
        }
        this.addressLocationCache.set(address, best);
        return best;
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

    getAllAddressToSource(): Map<number, SourceLocation> {
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
        _sourcePath: string
    ): SourceLocation | null {
        // Exact line match -- use the lowest address (the line's entry point).
        // A line maps to multiple addresses and the array is in parse order, not
        // address order, so addrs[0] can be a later occurrence of the line; a
        // breakpoint must land at the line's first instruction.
        const addrs = map.get(targetLine);
        if (addrs && addrs.length > 0) {
            const loc = this.data.addressToSource.get(Math.min(...addrs));
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
                const loc = this.data.addressToSource.get(Math.min(...nearAddrs));
                if (loc) return this.resolveLocation(loc);
            }
        }

        return null;
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
