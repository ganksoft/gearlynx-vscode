// Display formatting shared by the debug adapter and the debug-info parser.

export function hex(value: number, width: number): string {
    return `$${value.toString(16).toUpperCase().padStart(width, '0')}`;
}

// The value string used for every memory-backed variable: the byte at the
// address, its decimal form, the 16-bit word starting there, and the address.
export function formatByteWord(lo: number, hi: number, address: number): string {
    return `${hex(lo, 2)} (${lo}) [w:${hex(lo | (hi << 8), 4)}] @${hex(address, 4)}`;
}
