import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import { runWithTee } from './teeRunner';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HEARTBEAT_INTERVAL = 60000;
const PROCESS_SCAN_INTERVAL = 15000;
const MAX_TERMINALS = 20;
const MAX_NODE_PROCESSES = 40;
const EVENT_LOOP_DRIFT_THRESHOLD = 4000;

let lastHeartbeat = Date.now();
let cancellationEvents = 0;
let terminalInstance: vscode.Terminal | undefined;
let outputChannelInstance: vscode.OutputChannel | undefined;
let logDbPath: string | undefined;
let terminalOutputBuffer: Map<number, string[]> = new Map(); // Track output per terminal
let fileReadPositions: Map<string, number> = new Map(); // Track read position per log file

// Log database entry
interface LogEntry {
    timestamp: string;
    type: 'heartbeat' | 'process' | 'terminal' | 'event_loop' | 'cancellation' | 'recovery' | 'info';
    message: string;
    data?: any;
}

// Duplicate line tracking
let lastLogMessage = '';
let duplicateCount = 0;

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

function writeToDb(entry: LogEntry) {
    if (!logDbPath) return;

    try {
        const line = JSON.stringify(entry) + '\n';
        fs.appendFileSync(logDbPath, line);
    } catch (err) {
        console.error('Failed to write to log database:', err);
    }
}

function log(message: string, type: LogEntry['type'] = 'info', data?: any) {
    const timestamp = new Date().toISOString();
    const channel = getChannel();

    // ALWAYS write to database (no suppression)
    writeToDb({ timestamp, type, message, data });

    // Check for duplicates in OUTPUT CHANNEL only
    if (message === lastLogMessage) {
        duplicateCount++;
        // Still show in output channel but with count
        const date = new Date(timestamp);
        const timeStr = date.toLocaleTimeString('en-US', { hour12: false });
        channel.appendLine(`[${timeStr}] ${message} (x${duplicateCount + 1})`);
        console.log(`[WATCHDOG ${timestamp}] ${message} (x${duplicateCount + 1})`);
        return;
    }

    // If we had duplicates, reset count
    if (duplicateCount > 0) {
        duplicateCount = 0;
    }

    lastLogMessage = message;

    // Format timestamp for readability
    const date = new Date(timestamp);
    const timeStr = date.toLocaleTimeString('en-US', { hour12: false });

    // Log to output channel with readable timestamp
    channel.appendLine(`[${timeStr}] ${message}`);

    // Console for debugging
    console.log(`[WATCHDOG ${timestamp}] ${message}`);
}

// Custom Pseudoterminal that captures output
class WatchdogPseudoterminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    private closeEmitter = new vscode.EventEmitter<number>();
    onDidClose?: vscode.Event<number> = this.closeEmitter.event;

    private currentProcess: any;

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        this.writeEmitter.fire('Watchdog Terminal Ready\r\n');
        log('Watchdog terminal opened', 'terminal');
    }

    close(): void {
        if (this.currentProcess) {
            this.currentProcess.kill();
        }
        log('Watchdog terminal closed', 'terminal');
    }

    handleInput(data: string): void {
        // Echo input
        this.writeEmitter.fire(data);

        // If Enter key, execute command
        if (data === '\r') {
            this.writeEmitter.fire('\n');
        }
    }

    executeCommand(command: string): void {
        this.writeEmitter.fire(`\r\n$ ${command}\r\n`);
        log(`Executing command: ${command}`, 'info', { command });

        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
        const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

        this.currentProcess = spawn(shell, shellArgs, {
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir()
        });

        this.currentProcess.stdout.on('data', (data: Buffer) => {
            const text = data.toString();
            this.writeEmitter.fire(text.replace(/\n/g, '\r\n'));
            // Log to watchdog database
            log(`[STDOUT] ${text.trim()}`, 'info', { source: 'terminal', command });
        });

        this.currentProcess.stderr.on('data', (data: Buffer) => {
            const text = data.toString();
            this.writeEmitter.fire(text.replace(/\n/g, '\r\n'));
            // Log to watchdog database
            log(`[STDERR] ${text.trim()}`, 'info', { source: 'terminal', command });
        });

        this.currentProcess.on('close', (code: number) => {
            this.writeEmitter.fire(`\r\nProcess exited with code ${code}\r\n`);
            log(`Command completed with exit code ${code}`, 'info', { command, exitCode: code });
            this.currentProcess = null;
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    // Initialize log database
    const storageUri = context.globalStorageUri;
    if (storageUri) {
        fs.mkdirSync(storageUri.fsPath, { recursive: true });
        logDbPath = path.join(storageUri.fsPath, 'watchdog-db.jsonl');
        log("Watchdog activated", 'info', { version: '1.0.0' });
    }

    // Show output channel
    const channel = getChannel();
    channel.show(true);

    // Register command to create watchdog terminal
    const createTerminalCommand = vscode.commands.registerCommand('hidden-terminal-watchdog.createTerminal', () => {
        const pty = new WatchdogPseudoterminal();
        const terminal = vscode.window.createTerminal({ name: 'Watchdog Terminal', pty });
        terminal.show();
        log('Created watchdog terminal with output capture', 'info');
    });
    context.subscriptions.push(createTerminalCommand);

    // Register command to execute command with capture
    const executeCommandWithCapture = vscode.commands.registerCommand('hidden-terminal-watchdog.executeCommand', async () => {
        const command = await vscode.window.showInputBox({
            prompt: 'Enter command to execute with output capture',
            placeHolder: 'echo "Hello World"'
        });

        if (command) {
            const pty = new WatchdogPseudoterminal();
            const terminal = vscode.window.createTerminal({ name: 'Watchdog Exec', pty });
            terminal.show();
            pty.executeCommand(command);
        }
    });
    context.subscriptions.push(executeCommandWithCapture);

    monitorEventLoop();
    monitorTerminals();
    monitorProcesses();
    monitorCancellationPatterns();

    setInterval(heartbeat, HEARTBEAT_INTERVAL);
}

function heartbeat() {
    const terminalCount = vscode.window.terminals.length;
    log(`Watchdog active | terminals=${terminalCount} | cancellations=${cancellationEvents}`, 'heartbeat', {
        terminalCount,
        cancellationEvents
    });
}

function monitorEventLoop() {
    let lastTick = Date.now();

    setInterval(() => {
        const now = Date.now();
        const drift = now - lastTick - HEARTBEAT_INTERVAL;

        if (drift > EVENT_LOOP_DRIFT_THRESHOLD) {
            log(`CRITICAL | Event loop stall detected | drift=${drift}ms`, 'event_loop', { drift });
            attemptRecovery("event-loop-stall");
        }

        lastTick = now;
    }, HEARTBEAT_INTERVAL);
}

function monitorTerminals() {
    vscode.window.onDidOpenTerminal((terminal) => {
        const count = vscode.window.terminals.length;
        log(`Terminal opened | count=${count}`, 'terminal', { count, action: 'opened' });

        // Monitor terminal process output
        if (terminal.processId) {
            terminal.processId.then(pid => {
                if (pid) {
                    log(`Terminal process started | PID=${pid} | name=${terminal.name}`, 'info', { pid, terminalName: terminal.name });

                    // Use /proc to monitor terminal output (Linux only)
                    if (process.platform === 'linux') {
                        monitorTerminalOutput(terminal, pid);
                    }
                }
            });
        }

        if (count > MAX_TERMINALS) {
            log(`WARNING | Terminal overload detected | count=${count}`, 'terminal', { count, overload: true });
            cleanupTerminals();
        }
    });

    vscode.window.onDidCloseTerminal(() => {
        const count = vscode.window.terminals.length;
        log(`Terminal closed | count=${count}`, 'terminal', { count, action: 'closed' });
    });
}

function monitorTerminalOutput(terminal: vscode.Terminal, pid: number) {
    // Watch the .notes/terminal-*.log files that commands write to
    const notesDir = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.notes');

    if (!fs.existsSync(notesDir)) {
        return; // No .notes directory, skip monitoring
    }

    // Get TTY path for this terminal
    let ttyPath = 'unknown';
    exec(`readlink /proc/${pid}/fd/0 2>/dev/null`, (error, stdout) => {
        if (!error && stdout.trim()) {
            ttyPath = stdout.trim();
        }
    });

    // Watch for new log files
    const watcher = fs.watch(notesDir, (eventType, filename) => {
        if (filename && filename.startsWith('terminal-') && filename.endsWith('.log')) {
            const logFile = path.join(notesDir, filename);

            // Read only NEW content from the log file
            try {
                const stats = fs.statSync(logFile);
                const lastPosition = fileReadPositions.get(logFile) || 0;

                // Only read if file has grown
                if (stats.size > lastPosition) {
                    const fd = fs.openSync(logFile, 'r');
                    const buffer = Buffer.alloc(stats.size - lastPosition);
                    fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
                    fs.closeSync(fd);

                    const newContent = buffer.toString('utf-8');
                    const lines = newContent.split('\n');

                    lines.forEach(line => {
                        if (line.trim() && !line.includes('[WATCHDOG')) {
                            // Log each line with TTY path
                            const channel = getChannel();
                            const timestamp = new Date().toISOString();
                            const date = new Date(timestamp);
                            const timeStr = date.toLocaleTimeString('en-US', { hour12: false });

                            // Write to database
                            writeToDb({
                                timestamp,
                                type: 'info',
                                message: `[TTY:${ttyPath}] ${line}`,
                                data: { source: 'terminal-log', file: filename, pid, tty: ttyPath }
                            });

                            // ALWAYS write to output channel (no duplicate suppression for captured output)
                            channel.appendLine(`[${timeStr}] [TTY:${ttyPath}] ${line}`);
                        }
                    });

                    // Update read position
                    fileReadPositions.set(logFile, stats.size);
                }
            } catch (err) {
                // File might be in use, skip
            }
        }
    });

    // Stop watching when terminal closes
    const checkInterval = setInterval(() => {
        if (terminal.exitStatus !== undefined) {
            watcher.close();
            clearInterval(checkInterval);
        }
    }, 1000);
}

function cleanupTerminals() {
    vscode.window.terminals.forEach(term => {
        if (!term.name.includes("persistent") && !term.name.includes("Watchdog")) {
            term.dispose();
        }
    });

    log("Non-persistent terminals disposed", 'recovery', { action: 'cleanup_terminals' });
}

function monitorProcesses() {
    setInterval(() => {
        exec("ps -eo pid,comm | grep -E 'node|npm' | grep -v grep", (err, stdout) => {
            if (err || !stdout) return;

            const processes = stdout.split('\n').filter(Boolean);

            if (processes.length > MAX_NODE_PROCESSES) {
                log(`CRITICAL | Node process overload | count=${processes.length}`, 'process', {
                    count: processes.length,
                    overload: true
                });
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
                    log(`DETECTED | Cancellation pattern in diagnostics | total=${cancellationEvents}`, 'cancellation', {
                        total: cancellationEvents,
                        location: `${uri.fsPath}:${diag.range.start.line}`
                    });
                    attemptRecovery("cancellation-pattern");
                }
            });
        });
    });
}

function attemptRecovery(reason: string) {
    log(`Initiating self-heal | reason=${reason}`, 'recovery', { reason });

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
    log("Watchdog deactivated", 'info');
}