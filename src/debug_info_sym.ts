import * as fs from 'fs';
import { DebugSymbol, DebugInfoData } from './types';
import { logWarn } from './log';

export class SymDebugInfo {
    static parse(filePath: string): DebugInfoData | null {
        let src: string;
        try {
            src = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return null;
        }

        const symbols: DebugSymbol[] = [];
        const lines = src.split('\n');
        let unmatchedLines = 0;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#')) {
                continue;
            }

            // Common formats:
            // "ADDRESS LABEL" (cc65 .sym)
            // "LABEL = $ADDRESS" (ca65 exports)
            // "al ADDRESS .LABEL" (VICE label format)

            let address: number | undefined;
            let name: string | undefined;

            // Try "al CXXXX .label" (VICE format)
            const viceMatch = trimmed.match(/^al\s+C?([0-9a-fA-F]{4,6})\s+\.(.+)$/);
            if (viceMatch) {
                address = parseInt(viceMatch[1], 16);
                name = viceMatch[2];
            }

            // Try "ADDRESS LABEL" format
            if (!name) {
                const simpleMatch = trimmed.match(/^([0-9a-fA-F]{2,6})\s+(.+)$/);
                if (simpleMatch) {
                    address = parseInt(simpleMatch[1], 16);
                    name = simpleMatch[2].trim();
                }
            }

            // Try "LABEL = $ADDRESS"
            if (!name) {
                const eqMatch = trimmed.match(/^(\S+)\s*=\s*\$([0-9a-fA-F]{2,6})$/);
                if (eqMatch) {
                    name = eqMatch[1];
                    address = parseInt(eqMatch[2], 16);
                }
            }

            if (name && address !== undefined && !isNaN(address)) {
                symbols.push({
                    name: name,
                    address: address,
                    isGlobal: true,
                    isZeroPage: address < 0x100,
                    isCVariable: false,
                    isCompilerGenerated: /^[A-Z][0-9A-F]{4}$/.test(name),
                    segment: '',
                });
            } else {
                unmatchedLines++;
            }
        }

        if (unmatchedLines > 0) {
            logWarn(`sym file: ${unmatchedLines} line(s) did not match a known symbol format and were skipped.`);
        }

        // cc65 software stack pointer ("sp" in older cc65). Unused here -- a
        // sym file has no locals -- but $02 was simply wrong; that is sreg.
        const spSymbol = symbols.find(s => s.name === 'c_sp' || s.name === 'sp');

        return {
            addressToSource: new Map(),
            sourceToAddresses: new Map(),
            symbols: symbols,
            functions: [],
            locals: [],
            zeropageStackPointerAddr: spSymbol ? spSymbol.address : 0,
            overlayGroups: [],
            segments: [],
            fileMtimes: new Map(),
        };
    }
}
