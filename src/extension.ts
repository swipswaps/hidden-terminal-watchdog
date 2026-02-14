import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as os from 'os';

interface HiddenTerminalInfo {
    pid: number;
    cmdline: string;
}

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Hidden Terminal Watchdog');
    
    const startTime = new Date();
    output.appendLine(`=== Hidden Terminal Watchdog Activated ===`);
    output.appendLine(`Start Time: ${startTime.toISOString()}`);
    output.appendLine(`User: ${os.userInfo().username}`);
    output.appendLine(`VS Code PID: ${process.pid}`);
    output.appendLine(`Platform: ${os.platform()}`);
    output.appendLine('');

    // Track all VS Code integrated terminals
    const trackedTerminals = new Set<vscode.Terminal>();

    // Observe terminal creation
    vscode.window.onDidOpenTerminal((term) => {
        trackedTerminals.add(term);
        output.appendLine(`[INFO] Terminal opened: ${term.name} (tracked: ${trackedTerminals.size})`);
    });

    // Observe terminal closure
    vscode.window.onDidCloseTerminal((term) => {
        trackedTerminals.delete(term);
        output.appendLine(`[INFO] Terminal closed: ${term.name} (tracked: ${trackedTerminals.size})`);
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
            output.appendLine(`[MONITOR] Detected ${terminals.length} hidden terminals/processes`);
            
            if (terminals.length > 0) {
                terminals.forEach(t => {
                    output.appendLine(`  PID ${t.pid}: ${t.cmdline.substring(0, 100)}`);
                });
            }
            
            lastCount = terminals.length;
        }

        if (terminals.length > maxTerminals) {
            output.appendLine(`[WARN] Hidden terminal count (${terminals.length}) exceeds threshold (${maxTerminals})`);
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
                output.appendLine(`[AUTO] Auto-cleanup enabled, running cleanup...`);
                vscode.commands.executeCommand('watchdog.cleanup');
            }
        }
    }, monitorInterval);

    // Register monitor command
    const monitorCmd = vscode.commands.registerCommand('watchdog.monitor', async () => {
        const terminals = await detectHiddenTerminals();
        
        output.show(true);
        output.appendLine('');
        output.appendLine(`=== Manual Status Check ===`);
        output.appendLine(`Date: ${new Date().toISOString()}`);
        output.appendLine(`Tracked terminals: ${trackedTerminals.size}`);
        output.appendLine(`Hidden terminals: ${terminals.length}`);
        
        if (terminals.length > 0) {
            output.appendLine('');
            output.appendLine('Hidden terminal details:');
            terminals.forEach(t => {
                output.appendLine(`  PID ${t.pid}: ${t.cmdline}`);
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
            output.appendLine('[CLEANUP] No hidden terminals to cleanup');
            vscode.window.showInformationMessage('Hidden Terminal Watchdog: No hidden terminals found');
            return;
        }

        output.show(true);
        output.appendLine('');
        output.appendLine(`=== Force Cleanup ===`);
        output.appendLine(`Date: ${new Date().toISOString()}`);
        output.appendLine(`Cleaning ${terminals.length} hidden terminals...`);

        // Send SIGTERM to all processes first
        for (const t of terminals) {
            exec(`kill -15 ${t.pid} 2>/dev/null`, (err) => {
                if (err) {
                    output.appendLine(`[WARN] Failed to SIGTERM PID ${t.pid}`);
                } else {
                    output.appendLine(`[INFO] Sent SIGTERM to PID ${t.pid}`);
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
                            output.appendLine(`[WARN] Failed to SIGKILL PID ${t.pid}`);
                        } else {
                            output.appendLine(`[INFO] Sent SIGKILL to PID ${t.pid}`);
                        }
                    });
                } else {
                    output.appendLine(`[INFO] PID ${t.pid} terminated gracefully`);
                }
            });
        }

        output.appendLine(`[CLEANUP] Cleanup complete at ${new Date().toISOString()}`);
        output.appendLine('');
        output.appendLine('=== Root Cause Analysis ===');
        output.appendLine('1. launch-process with wait=false creates persistent terminals');
        output.appendLine('2. Each tool call spawns a new terminal instead of reusing');
        output.appendLine('3. MCP client doesn\'t clean up on timeout');
        output.appendLine('4. RULE 22 violation: Terminal accumulation causes instability');

        vscode.window.showInformationMessage(
            `Hidden Terminal Watchdog: Cleaned ${terminals.length} hidden terminals`
        );
    });

    // Log periodic heartbeat
    const heartbeat = setInterval(() => {
        output.appendLine(`[HEARTBEAT] Watchdog active. Tracked: ${trackedTerminals.size}, Last hidden: ${lastCount}`);
    }, 60000); // Every 60 seconds

    // Save subscriptions
    context.subscriptions.push(
        monitorCmd,
        cleanupCmd,
        { dispose: () => clearInterval(interval) },
        { dispose: () => clearInterval(heartbeat) }
    );

    output.appendLine('[INFO] Hidden Terminal Watchdog is now monitoring...');
    output.appendLine('');
}

export function deactivate() {
    // Cleanup handled by context.subscriptions
}

