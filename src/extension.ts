import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

interface HiddenTerminalInfo {
    pid: number;
    cmdline: string;
}

let outputChannel: vscode.OutputChannel;
let logFilePath: string;

// MANDATORY: Logging to file AND terminal
function log(message: string) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;

    // Write to file (inside workspace storage)
    if (logFilePath) {
        try {
            fs.appendFileSync(logFilePath, logLine);
        } catch (err) {
            console.error('Failed to write to log file:', err);
        }
    }

    // Write to VS Code output channel
    if (outputChannel) {
        outputChannel.appendLine(message);
    }

    // Write to console (visible in Extension Development Host)
    console.log(`[WATCHDOG] ${message}`);
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Hidden Terminal Watchdog');

    // Use VS Code's storage path (inside workspace or global storage)
    const storageUri = context.globalStorageUri || context.storageUri;
    if (storageUri) {
        // Ensure storage directory exists
        fs.mkdirSync(storageUri.fsPath, { recursive: true });
        logFilePath = path.join(storageUri.fsPath, 'watchdog.log');
    } else {
        // Fallback: use workspace folder if available
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            logFilePath = path.join(workspaceFolder.uri.fsPath, '.watchdog.log');
        }
    }

    const startTime = new Date();
    log('=== Hidden Terminal Watchdog Activated ===');
    log(`Start Time: ${startTime.toISOString()}`);
    log(`User: ${os.userInfo().username}`);
    log(`VS Code PID: ${process.pid}`);
    log(`Platform: ${os.platform()}`);
    if (logFilePath) {
        log(`Log file: ${logFilePath}`);
    } else {
        log(`WARNING: No log file path available (no workspace or storage)`);
    }

    // Track all VS Code integrated terminals
    const trackedTerminals = new Set<vscode.Terminal>();

    // Observe terminal creation
    vscode.window.onDidOpenTerminal((term) => {
        trackedTerminals.add(term);
        log(`[INFO] Terminal opened: ${term.name} (tracked: ${trackedTerminals.size})`);
    });

    // Observe terminal closure
    vscode.window.onDidCloseTerminal((term) => {
        trackedTerminals.delete(term);
        log(`[INFO] Terminal closed: ${term.name} (tracked: ${trackedTerminals.size})`);
    });

    // Internal function: Detect hidden terminals and extension hosts
    function detectHiddenTerminals(): Promise<HiddenTerminalInfo[]> {
        return new Promise((resolve) => {
            // Only detect VS Code extension hosts and terminal processes
            // Do NOT detect shell processes - too broad and causes false positives
            const pattern = 'code.*--ms-enable-electron-run-as-node|extensionHost';
            const username = os.userInfo().username;
            
            exec(`pgrep -u ${username} -f "${pattern}"`, (err, stdout, stderr) => {
                if (err) {
                    // No matches found
                    resolve([]);
                    return;
                }

                const pids = stdout.split(/\s+/).filter(Boolean).map(p => parseInt(p, 10));
                
                if (pids.length === 0) {
                    resolve([]);
                    return;
                }

                // Get command lines for each PID
                const results: HiddenTerminalInfo[] = [];
                let pending = pids.length;

                pids.forEach((pid) => {
                    exec(`tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null`, (cmdErr, cmdOut) => {
                        results.push({
                            pid,
                            cmdline: cmdErr || !cmdOut.trim() ? '[cmdline unavailable]' : cmdOut.trim()
                        });
                        
                        pending--;
                        if (pending === 0) {
                            resolve(results);
                        }
                    });
                });
            });
        });
    }

    // Monitor hidden terminals periodically
    const config = vscode.workspace.getConfiguration('watchdog');
    const monitorInterval = config.get<number>('monitorInterval', 5000);
    const maxTerminals = config.get<number>('maxTerminals', 20);
    const autoCleanup = config.get<boolean>('autoCleanup', false);

    let lastCount = 0;

    const interval = setInterval(async () => {
        const terminals = await detectHiddenTerminals();

        if (terminals.length !== lastCount) {
            log(`[MONITOR] Detected ${terminals.length} hidden terminals/processes`);

            if (terminals.length > 0) {
                terminals.forEach(t => {
                    log(`  PID ${t.pid}: ${t.cmdline.substring(0, 100)}`);
                });
            }

            lastCount = terminals.length;
        }

        if (terminals.length > maxTerminals) {
            log(`[WARN] Hidden terminal count (${terminals.length}) exceeds threshold (${maxTerminals})`);
            vscode.window.showWarningMessage(
                `Hidden Terminal Watchdog: ${terminals.length} hidden terminals detected (threshold: ${maxTerminals})`,
                'Cleanup Now',
                'Dismiss'
            ).then(selection => {
                if (selection === 'Cleanup Now') {
                    vscode.commands.executeCommand('watchdog.cleanup');
                }
            });

            if (autoCleanup) {
                log(`[AUTO] Auto-cleanup enabled, running cleanup...`);
                vscode.commands.executeCommand('watchdog.cleanup');
            }
        }
    }, monitorInterval);

    // Register monitor command
    const monitorCmd = vscode.commands.registerCommand('watchdog.monitor', async () => {
        const terminals = await detectHiddenTerminals();

        outputChannel.show(true);
        log('');
        log(`=== Manual Status Check ===`);
        log(`Date: ${new Date().toISOString()}`);
        log(`Tracked terminals: ${trackedTerminals.size}`);
        log(`Hidden terminals: ${terminals.length}`);

        if (terminals.length > 0) {
            log('');
            log('Hidden terminal details:');
            terminals.forEach(t => {
                log(`  PID ${t.pid}: ${t.cmdline}`);
            });
        }

        vscode.window.showInformationMessage(
            `Hidden Terminal Watchdog: ${terminals.length} hidden terminals detected`
        );
    });

    // Register cleanup command
    const cleanupCmd = vscode.commands.registerCommand('watchdog.cleanup', async () => {
        const terminals = await detectHiddenTerminals();

        if (terminals.length === 0) {
            log('[CLEANUP] No hidden terminals to cleanup');
            vscode.window.showInformationMessage('Hidden Terminal Watchdog: No hidden terminals found');
            return;
        }

        outputChannel.show(true);
        log('');
        log(`=== Force Cleanup ===`);
        log(`Date: ${new Date().toISOString()}`);
        log(`Cleaning ${terminals.length} hidden terminals...`);

        // Send SIGTERM to all processes first
        for (const t of terminals) {
            exec(`kill -15 ${t.pid} 2>/dev/null`, (err) => {
                if (err) {
                    log(`[WARN] Failed to SIGTERM PID ${t.pid}`);
                } else {
                    log(`[INFO] Sent SIGTERM to PID ${t.pid}`);
                }
            });
        }

        // Wait briefly for graceful shutdown
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Send SIGKILL to any survivors
        for (const t of terminals) {
            exec(`kill -0 ${t.pid} 2>/dev/null`, (checkErr) => {
                if (!checkErr) {
                    // Process still exists
                    exec(`kill -9 ${t.pid} 2>/dev/null`, (killErr) => {
                        if (killErr) {
                            log(`[WARN] Failed to SIGKILL PID ${t.pid}`);
                        } else {
                            log(`[INFO] Sent SIGKILL to PID ${t.pid}`);
                        }
                    });
                } else {
                    log(`[INFO] PID ${t.pid} terminated gracefully`);
                }
            });
        }

        log(`[CLEANUP] Cleanup complete at ${new Date().toISOString()}`);
        log('');
        log('=== Root Cause Analysis ===');
        log('1. launch-process with wait=false creates persistent terminals');
        log('2. Each tool call spawns a new terminal instead of reusing');
        log('3. MCP client doesn\'t clean up on timeout');
        log('4. RULE 22 violation: Terminal accumulation causes instability');

        vscode.window.showInformationMessage(
            `Hidden Terminal Watchdog: Cleaned ${terminals.length} hidden terminals`
        );
    });

    // Log periodic heartbeat
    const heartbeat = setInterval(() => {
        log(`[HEARTBEAT] Watchdog active. Tracked: ${trackedTerminals.size}, Last hidden: ${lastCount}`);
    }, 60000); // Every 60 seconds

    // Save subscriptions
    context.subscriptions.push(
        monitorCmd,
        cleanupCmd,
        { dispose: () => clearInterval(interval) },
        { dispose: () => clearInterval(heartbeat) }
    );

    log('[INFO] Hidden Terminal Watchdog is now monitoring...');
    log('');
}

export function deactivate() {
    log('=== Hidden Terminal Watchdog DEACTIVATED ===');
    // Cleanup handled by context.subscriptions
}

