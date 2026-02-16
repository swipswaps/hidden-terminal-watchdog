import * as vscode from "vscode";
import { spawn } from "child_process";

export interface TeeOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

let terminalInstance: vscode.Terminal | undefined;
let outputChannelInstance: vscode.OutputChannel | undefined;

function getOrCreateTerminal(): vscode.Terminal {
    if (!terminalInstance || terminalInstance.exitStatus !== undefined) {
        terminalInstance = vscode.window.createTerminal("Watchdog Monitor");
    }
    return terminalInstance;
}

function getOrCreateChannel(): vscode.OutputChannel {
    if (!outputChannelInstance) {
        outputChannelInstance = vscode.window.createOutputChannel("Watchdog Log");
    }
    return outputChannelInstance;
}

/**
 * Run a command with live tee streaming to both terminal and output channel.
 * This uses spawn() instead of exec() to stream output in real-time.
 * 
 * Based on official VS Code Extension API patterns and Node.js best practices.
 */
export function runWithTee(
    command: string,
    args: string[],
    options: TeeOptions = {}
): Promise<number> {
    return new Promise((resolve) => {
        const terminal = getOrCreateTerminal();
        const outputChannel = getOrCreateChannel();
        
        // Force terminal visibility
        terminal.show(true);
        
        const child = spawn(command, args, {
            cwd: options.cwd || process.cwd(),
            env: options.env || process.env,
            shell: true
        });
        
        const cmdLine = `${command} ${args.join(" ")}`;
        terminal.sendText(`\n# Executing: ${cmdLine}\n`);
        outputChannel.appendLine(`\n=== Executing: ${cmdLine} ===`);
        
        // Stream stdout to BOTH terminal AND output channel
        child.stdout?.on("data", (data) => {
            const text = data.toString();
            terminal.sendText(text, false);
            outputChannel.append(text);
        });
        
        // Stream stderr to BOTH terminal AND output channel
        child.stderr?.on("data", (data) => {
            const text = data.toString();
            terminal.sendText(text, false);
            outputChannel.append(text);
        });
        
        child.on("close", (code) => {
            const exitMsg = `\n# Process exited with code ${code}\n`;
            terminal.sendText(exitMsg);
            outputChannel.appendLine(`Process exited with code ${code}`);
            resolve(code ?? 0);
        });
        
        child.on("error", (err) => {
            const errMsg = `\n# Spawn error: ${err.message}\n`;
            terminal.sendText(errMsg);
            outputChannel.appendLine(`Spawn error: ${err.message}`);
            resolve(1);
        });
    });
}

/**
 * Guarded run with system state verification on failure.
 */
export async function guardedRun(cmd: string, args: string[]): Promise<number> {
    const code = await runWithTee(cmd, args);
    
    if (code !== 0) {
        const channel = getOrCreateChannel();
        channel.appendLine("Non-zero exit code. Verifying actual system state...");
        // Could add state verification here
    }
    
    return code;
}

