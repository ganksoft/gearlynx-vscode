import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

// Extension-level status/error log, independent of any active debug session.
// Created lazily so tests and non-activation code paths don't need a real
// ExtensionContext just to import this module.
function getChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('Gearlynx Debugger');
    }
    return channel;
}

function write(level: string, message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    getChannel().appendLine(`[${timestamp}] [${level}] ${message}`);
}

export function logInfo(message: string): void {
    write('info', message);
}

export function logWarn(message: string): void {
    write('warn', message);
}

export function logError(message: string): void {
    write('error', message);
}

export function getLogChannel(): vscode.OutputChannel {
    return getChannel();
}
