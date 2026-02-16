import * as vscode from 'vscode';
import { exec } from 'child_process';
import { runWithTee } from './teeRunner';

const HEARTBEAT_INTERVAL = 60000;
const PROCESS_SCAN_INTERVAL = 15000;
const MAX_TERMINALS = 20;
const MAX_NODE_PROCESSES = 40;
const EVENT_LOOP_DRIFT_THRESHOLD = 4000;

let lastHeartbeat = Date.now();
let cancellationEvents = 0;
let terminalInstance: vscode.Terminal | undefined;
let outputChannelInstance: vscode.OutputChannel | undefined;

function getTerminal(): vscode.Terminal {
    if (!terminalInstance || terminalInstance.exitStatus !== undefined) {
        terminalInstance = vscode.window.createTerminal("Watchdog Monitor");
    }
    return terminalInstance;
}

function getChannel(): vscode.OutputChannel {
    if (!outputChannelInstance) {
        outputChannelInstance = vscode.window.createOutputChannel("Watchdog Log");
    }
    return outputChannelInstance;
}

function log(message: string) {
    const timestamp = new Date().toISOString();
    const terminal = getTerminal();
    const channel = getChannel();

    // Tee to terminal (visible to user)
    terminal.sendText(`[${timestamp}] ${message}`, false);

    // Also log to output channel
    channel.appendLine(`[${timestamp}] ${message}`);

    // Console for debugging
    console.log(`[WATCHDOG ${timestamp}] ${message}`);
}

export function activate(context: vscode.ExtensionContext) {
    log("Watchdog activated.");

    // Show terminal immediately
    const terminal = getTerminal();
    terminal.show(true);

    monitorEventLoop();
    monitorTerminals();
    monitorProcesses();
    monitorCancellationPatterns();

    setInterval(heartbeat, HEARTBEAT_INTERVAL);
}

function heartbeat() {
    log(`HEARTBEAT | terminals=${vscode.window.terminals.length} | cancellations=${cancellationEvents}`);
}

function monitorEventLoop() {
    let lastTick = Date.now();

    setInterval(() => {
        const now = Date.now();
        const drift = now - lastTick - HEARTBEAT_INTERVAL;

        if (drift > EVENT_LOOP_DRIFT_THRESHOLD) {
            log(`CRITICAL | Event loop stall detected | drift=${drift}ms`);
            attemptRecovery("event-loop-stall");
        }

        lastTick = now;
    }, HEARTBEAT_INTERVAL);
}

function monitorTerminals() {
    vscode.window.onDidOpenTerminal(() => {
        const count = vscode.window.terminals.length;
        log(`INFO | Terminal opened | count=${count}`);

        if (count > MAX_TERMINALS) {
            log(`WARNING | Terminal overload detected | count=${count}`);
            cleanupTerminals();
        }
    });

    vscode.window.onDidCloseTerminal(() => {
        log(`INFO | Terminal closed | count=${vscode.window.terminals.length}`);
    });
}

function cleanupTerminals() {
    vscode.window.terminals.forEach(term => {
        if (!term.name.includes("persistent") && !term.name.includes("Watchdog")) {
            term.dispose();
        }
    });

    log("ACTION | Non-persistent terminals disposed.");
}

function monitorProcesses() {
    setInterval(() => {
        exec("ps -eo pid,comm | grep -E 'node|npm' | grep -v grep", (err, stdout) => {
            if (err || !stdout) return;

            const processes = stdout.split('\n').filter(Boolean);

            if (processes.length > MAX_NODE_PROCESSES) {
                log(`CRITICAL | Node process overload | count=${processes.length}`);
                attemptRecovery("node-overload");
            }
        });
    }, PROCESS_SCAN_INTERVAL);
}

function monitorCancellationPatterns() {
    // Monitor for "Cancelled by user" errors by checking VS Code diagnostics
    vscode.languages.onDidChangeDiagnostics((event) => {
        event.uris.forEach(uri => {
            const diagnostics = vscode.languages.getDiagnostics(uri);
            diagnostics.forEach(diag => {
                if (diag.message.includes('Cancelled by user')) {
                    cancellationEvents++;
                    log(`DETECTED | Cancellation pattern in diagnostics | total=${cancellationEvents}`);
                    log(`LOCATION | ${uri.fsPath}:${diag.range.start.line}`);
                    attemptRecovery("cancellation-pattern");
                }
            });
        });
    });
}

function attemptRecovery(reason: string) {
    log(`RECOVERY | Initiating self-heal | reason=${reason}`);

    cleanupTerminals();

    vscode.window.showWarningMessage(
        `Watchdog detected instability (${reason}). Reload window?`,
        "Reload"
    ).then(choice => {
        if (choice === "Reload") {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
    });
}

export function deactivate() {
    log("Watchdog deactivated.");
}