import * as vscode from 'vscode';
import { logInfo, logWarn } from './log';

// Matches a task by the label users actually type in launch.json's
// preLaunchTask: either the bare name ("build") or the qualified form the
// task list shows ("npm: build", "shell: build").
function matchesName(task: vscode.Task, name: string): boolean {
    return task.name === name || `${task.source}: ${task.name}` === name;
}

function isDefaultBuildTask(task: vscode.Task): boolean {
    return task.group?.id === vscode.TaskGroup.Build.id && task.group.isDefault === true;
}

// Finds the task to run before a stale launch: the one named in launch.json's
// buildTask if given, otherwise the workspace's default build task. Returns
// undefined when there is nothing to run, in which case callers degrade to a
// warning rather than blocking the launch.
export async function resolveBuildTask(name?: string): Promise<vscode.Task | undefined> {
    let tasks: vscode.Task[];
    try {
        tasks = await vscode.tasks.fetchTasks();
    } catch (e) {
        logWarn(`Could not fetch workspace tasks: ${e}`);
        return undefined;
    }

    let match: vscode.Task | undefined;
    if (name) {
        match = tasks.find(t => matchesName(t, name));
        if (!match) logWarn(`buildTask "${name}" is not a known task in this workspace.`);
    } else {
        match = tasks.find(t => isDefaultBuildTask(t) && !t.isBackground);
    }

    // A background (watch) task never ends, so awaiting it would hang the
    // launch forever. Fall back to warning instead.
    if (match?.isBackground) {
        logWarn(`Build task "${buildTaskLabel(match)}" is a background task; not running it before launch.`);
        return undefined;
    }

    return match;
}

export function buildTaskLabel(task: vscode.Task): string {
    return task.source ? `${task.source}: ${task.name}` : task.name;
}

// Runs a task to completion and reports whether it succeeded. Process-backed
// tasks report a real exit code. Tasks with no process (custom executions)
// only fire onDidEndTask, so those are treated as successful.
export async function runBuildTask(task: vscode.Task): Promise<boolean> {
    const label = buildTaskLabel(task);
    logInfo(`Running build task: ${label}`);

    let execution: vscode.TaskExecution;
    try {
        execution = await vscode.tasks.executeTask(task);
    } catch (e) {
        logWarn(`Failed to start build task "${label}": ${e}`);
        return false;
    }

    return new Promise<boolean>(resolve => {
        let exitCode: number | undefined;

        const processListener = vscode.tasks.onDidEndTaskProcess(e => {
            if (e.execution === execution) exitCode = e.exitCode;
        });

        const endListener = vscode.tasks.onDidEndTask(e => {
            if (e.execution !== execution) return;
            processListener.dispose();
            endListener.dispose();
            const ok = exitCode === undefined || exitCode === 0;
            logInfo(`Build task "${label}" finished (exit code ${exitCode ?? 'n/a'}).`);
            resolve(ok);
        });
    });
}
