import * as os from 'os';
import * as path from 'path';

// VSCode and Node don't do shell tilde expansion, so a leading "~" must be
// expanded before a path reaches any fs or child_process call.
export function expandTilde(p: string | undefined): string | undefined {
    if (!p) {
        return p;
    }
    if (p === '~') {
        return os.homedir();
    }
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}
