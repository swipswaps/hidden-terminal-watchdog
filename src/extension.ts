import * as vscode from 'vscode';
import { exec } from 'child_process';
import { runWithTee } from './teeRunner';
import * as fs from 'fs';
import * as path from 'path';

const HEARTBEAT_INTERVAL = 60000;
const PROCESS_SCAN_INTERVAL = 15000;
const MAX_TERMINALS = 20;
const MAX_NODE_PROCESSES = 40;
const EVENT_LOOP_DRIFT_THRESHOLD = 4000;

// Zygote monitoring thresholds
const ZYGOTE_CPU_THRESHOLD = 20.0;  // % CPU
const ZYGOTE_MEMORY_THRESHOLD = 700;  // MB
const ZYGOTE_CHECK_INTERVAL = 30000;  // 30 seconds
const DB_PATH = '.augment/error_tracking.db';

// WHAT: Compile-time build marker for staleness detection
// WHY: code --install-extension replaces out/extension.js on disk, but VS Code
//   keeps the OLD code in memory until the window reloads. This causes the recurring
//   "extension is still running an older version" problem. The placeholder __BUILD_TS__
//   is replaced with an actual UTC timestamp by the compile script (tsc + sed).
// HOW: checkForStaleCode() reads __filename from disk, extracts the BUILD_MARKER value.
//   If it differs from the in-memory value → the installed code is newer → auto-reload.
const BUILD_MARKER = '__BUILD_TS__';
const STALE_CHECK_INTERVAL = 30000;  // Check every 30 seconds
// WHAT: Path to diagnostics queue file created by extract-stack-trace-locations.sh
// WHY: Watchdog reads this file to create VS Code diagnostics at flagged locations
// HOW: Shell script writes file:line:offset|error_type|function|message, extension parses it
const DIAGNOSTICS_QUEUE_FILENAME = '.notes/vscode-diagnostics-queue.txt';
// WHAT: How often to re-read diagnostics queue and refresh VS Code problem markers
// WHY: Queue file is updated by shell scripts; extension must poll for changes
// HOW: setInterval at 10 second cadence balances responsiveness vs CPU cost
const DIAGNOSTICS_REFRESH_INTERVAL = 10000;

// Interface for error block parsing
interface ErrorBlock {
    type: string;
    message: string;
    stackLines: string[];
}

// WHAT: Interface for RICH diagnostics queue entries (JSON-per-line format)
// WHY: Vague messages like "[RULE_9_VIOLATION]" are useless for troubleshooting.
//      The LLM reads diagnostics via the diagnostics tool. If the message contains
//      verbatim error text, stack trace, code snippet, and timestamps, the LLM can
//      actually troubleshoot instead of guessing. This is what the user requested:
//      "verbatim human readable event, error, system and application relevant
//       messages and stack trace and line numbers and verbatim code snippets"
// HOW: JSON object with every field the LLM needs to see in the Problems panel.
//      Falls back to pipe-delimited for backward compatibility.
interface RichDiagnosticEntry {
    file: string;           // absolute or relative file path
    line: number;           // 1-based line number
    col: number;            // 1-based column/offset
    event: string;          // e.g. "REQUEST_CANCELLED", "FETCH_FAILED"
    error: string;          // verbatim error message from database
    timestamp: string;      // ISO timestamp of when error occurred
    stack: string;          // full stack trace text from database
    code: string;           // verbatim code snippet at the flagged location
    context: string;        // human-readable explanation of what this means
    count: number;          // how many times this error occurred
}

let lastHeartbeat = Date.now();
let cancellationEvents = 0;
let terminalInstance: vscode.Terminal | undefined;
let outputChannelInstance: vscode.OutputChannel | undefined;
// WHAT: Persistent diagnostic collection for stack-trace-sourced problems
// WHY: Survives across refresh cycles; cleared and repopulated each poll
// HOW: Created once at activation, updated by readDiagnosticsQueueAndFlag()
let diagnosticCollection: vscode.DiagnosticCollection | undefined;
// WHAT: Map of absolute file paths → diagnostics from LIVE monitoring (not queue file)
// WHY: monitorSystemEvents, monitorApplicationEvents, monitorZygoteProcesses all discover
//      errors with verbatim messages, stack traces, file:line:col locations. Previously
//      these were ONLY logged to the output channel — invisible to the LLM diagnostics tool.
//      Now they become VS Code diagnostics merged with queue-based entries.
// HOW: Each monitoring function calls addMonitorDiagnostic(); readDiagnosticsQueueAndFlag()
//      merges both sources before setting on the diagnosticCollection.
let monitorDiagnostics = new Map<string, vscode.Diagnostic[]>();
// WHAT: Deduplication map — key is "absolutePath:line:col:event", value is occurrence count
// WHY: monitorSystemEvents runs every 60s and parses the SAME Augment.log tail. Without dedup,
//      the same 5 AbortError stack locations create 5 NEW diagnostics every cycle = 20 in 4 min.
//      This floods the diagnostics panel and drowns out FD leaks, zygotes, checkpoint errors, etc.
// HOW: On first occurrence, create diagnostic with count=1. On subsequent, update message with
//      incremented count. Never create duplicate diagnostics for the same location+event.
let monitorDedupMap = new Map<string, { count: number; diagIndex: number; filePath: string }>();

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

// Database logging function
// WHAT: Log errors to SQLite database with FULL stack traces in separate column
// WHY: User requested "all messages and all stack trace data not spam with crap"
// HOW: Accept optional 3rd parameter for stack trace, insert into stack_trace column
// RATIONALE: Previous version concatenated stack trace into error_message and truncated to 200 chars
function logToDatabase(errorType: string, errorMessage: string, stackTrace?: string): void {
    const timestamp = new Date().toISOString();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    const dbPath = path.join(workspaceFolder.uri.fsPath, DB_PATH);
    const escapedMessage = errorMessage.replace(/'/g, "''");
    const escapedStack = stackTrace ? stackTrace.replace(/'/g, "''") : '';

    // WHAT: Insert stack trace into separate column when provided
    // WHY: Diagnostics need full stack traces, not truncated concatenations
    // HOW: Use stack_trace column when stackTrace parameter is provided
    const sql = stackTrace
        ? `INSERT INTO errors (timestamp, log_file, error_type, error_message, stack_trace, extension_name) VALUES ('${timestamp}', 'watchdog-extension', '${errorType}', '${escapedMessage}', '${escapedStack}', 'watchdog');`
        : `INSERT INTO errors (timestamp, log_file, error_type, error_message, extension_name) VALUES ('${timestamp}', 'watchdog-extension', '${errorType}', '${escapedMessage}', 'watchdog');`;

    exec(`sqlite3 "${dbPath}" "${sql}"`, (err) => {
        if (err) {
            log(`ERROR | Failed to log to database: ${err.message}`);
        }
    });
}

// Monitor runaway zygote processes
function monitorZygoteProcesses(): void {
    exec(`ps aux | awk '$3 > ${ZYGOTE_CPU_THRESHOLD} || $6 > ${ZYGOTE_MEMORY_THRESHOLD * 1024} {print $2,$3,$6,$11}' | grep -E "code --type=zygote" || true`, (err, stdout) => {
        if (err || !stdout.trim()) {
            return;  // No runaway zygotes
        }

        const lines = stdout.trim().split('\n');
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 4) {
                return;
            }

            const pid = parseInt(parts[0]);
            const cpu = parseFloat(parts[1]);
            const memKB = parseInt(parts[2]);
            const memMB = Math.round(memKB / 1024);
            const cmd = parts.slice(3).join(' ');

            const message = `⚠️  RUNAWAY ZYGOTE DETECTED | PID ${pid} | ${cpu.toFixed(1)}% CPU | ${memMB} MB RAM`;
            log(message);

            // Log to database
            logToDatabase('runaway_zygote_detected', `PID ${pid}: ${cpu.toFixed(1)}% CPU, ${memMB} MB RAM`);

            // WHAT: Create a VS Code diagnostic for the runaway zygote
            // WHY: LLM reads diagnostics tool — must see PID, CPU%, RAM, command verbatim
            // HOW: addMonitorDiagnostic creates diagnostic visible in Problems panel
            // WHAT: Point diagnostic to OUR source code where zygote detection happens
            // WHY: Old code used llm-compliance-guide.sh:1:1 → WRONG FILE, L1:1 → useless
            // HOW: Use our extension.ts source at the logToDatabase call site (~L163)
            addMonitorDiagnostic({
                file: 'hidden-terminal-watchdog/src/extension.ts',
                line: 163, col: 1,
                event: 'runaway_zygote_detected',
                error: `Runaway zygote PID ${pid}: ${cpu.toFixed(1)}% CPU, ${memMB} MB RAM, cmd: ${cmd}`,
                timestamp: new Date().toISOString(),
                stack: `ps aux | PID=${pid} CPU=${cpu.toFixed(1)}% MEM=${memMB}MB CMD=${cmd}`,
                code: `logToDatabase('runaway_zygote_detected', \`PID \${pid}: \${cpu.toFixed(1)}% CPU, \${memMB} MB RAM\`)`,
                context: `VS Code zygote subprocess consuming excessive CPU/RAM. Detected by monitorZygoteProcesses() at L163 in our extension.ts.`,
                count: 1,
            });

            // Show warning to user (NOT auto-kill - user must decide)
            vscode.window.showWarningMessage(
                `Watchdog: Runaway zygote process detected (PID ${pid}, ${cpu.toFixed(1)}% CPU, ${memMB} MB)`,
                'Restart VS Code',
                'Ignore'
            ).then(selection => {
                if (selection === 'Restart VS Code') {
                    log(`INFO | User requested VS Code restart to fix runaway zygote PID ${pid}`);
                    logToDatabase('user_restart_requested', `User restarted VS Code to fix runaway zygote PID ${pid}`);
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        });
    });
}

// WHAT: Read .notes/vscode-diagnostics-queue.txt and create VS Code Problem markers
// WHY: LLM sees VS Code diagnostics via the diagnostics tool; flagged lines force compliance
// HOW:
//   1. Read queue file line by line
//   2. Parse each line: file:line:offset|error_type|function|message
//   3. Resolve file path to absolute URI
//   4. Create vscode.Diagnostic at parsed line/offset
//   5. Set all diagnostics on the collection (replaces previous set)
//   6. Log count to output channel so watchdog heartbeat shows activity
// WHAT: Resolve a raw file path (from queue entry) to an absolute path on disk
// WHY: Queue entries may have relative paths, extension-relative paths, or absolute paths
// HOW: Check pattern → resolve against ~/.vscode/extensions/ or workspace root
function resolveFilePath(rawFilePath: string, workspaceRoot: string): string {
    if (path.isAbsolute(rawFilePath)) {
        return rawFilePath;
    }
    if (rawFilePath.includes('.vscode-augment-') || rawFilePath.includes('augment.')) {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        return path.join(homeDir, '.vscode', 'extensions', rawFilePath);
    }
    return path.join(workspaceRoot, rawFilePath);
}

// WHAT: Add a VS Code diagnostic from LIVE monitoring (not from queue file)
// WHY: When monitorSystemEvents parses "at eH.callApi (extension.js:252:1928)" from
//      Augment.log, or monitorApplicationEvents detects FD count 57492 > 50000, or
//      monitorZygoteProcesses finds a runaway zygote — those errors with their FULL
//      verbatim messages, stack traces, and code paths MUST become VS Code diagnostics.
//      Otherwise the LLM cannot see them via the diagnostics tool.
//      User requested: "verbatim human readable event, error, system and application
//      relevant messages and exact code paths and line numbers or offsets and stack traces"
// HOW: Build a RichDiagnosticEntry → vscode.Diagnostic → add to monitorDiagnostics Map.
//      readDiagnosticsQueueAndFlag() merges monitorDiagnostics into the collection each poll.
function addMonitorDiagnostic(entry: RichDiagnosticEntry): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return; }

    const absolutePath = resolveFilePath(entry.file, workspaceFolder.uri.fsPath);
    // WHAT: Dedup key = file:line:col:event — one diagnostic per unique location+event
    // WHY: monitorSystemEvents runs every 60s. Same 5 AbortError locations repeat each cycle.
    //      Without dedup: 5 locations × 10 cycles = 50 identical AbortError diagnostics flood
    //      the panel, drowning FD leaks, zygotes, checkpoint errors, and everything else.
    // HOW: First occurrence → create diagnostic. Subsequent → increment count in message.
    const dedupKey = `${absolutePath}:${entry.line}:${entry.col}:${entry.event}`;

    const existing = monitorDedupMap.get(dedupKey);
    if (existing) {
        // UPDATE existing diagnostic — increment count, refresh timestamp
        existing.count++;
        const updatedEntry = { ...entry, count: existing.count, timestamp: new Date().toISOString() };
        const diagMessage = buildRichMessage(updatedEntry);
        const lineNum = Math.max(0, entry.line - 1);
        const charOffset = Math.max(0, entry.col - 1);
        const range = new vscode.Range(lineNum, charOffset, lineNum, charOffset + 20);
        const diagnostic = new vscode.Diagnostic(range, diagMessage, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'watchdog-monitor';
        // Replace in-place in the fileDiags array
        const fileDiags = monitorDiagnostics.get(existing.filePath);
        if (fileDiags && existing.diagIndex < fileDiags.length) {
            fileDiags[existing.diagIndex] = diagnostic;
        }
        log(`MONITOR DEDUP | ${entry.event} @ ${path.basename(entry.file)}:${entry.line}:${entry.col} | count=${existing.count}`);
        return;
    }

    // FIRST OCCURRENCE — create new diagnostic
    const lineNum = Math.max(0, entry.line - 1);
    const charOffset = Math.max(0, entry.col - 1);
    const diagMessage = buildRichMessage(entry);
    const range = new vscode.Range(lineNum, charOffset, lineNum, charOffset + 20);
    const diagnostic = new vscode.Diagnostic(range, diagMessage, vscode.DiagnosticSeverity.Warning);
    diagnostic.source = 'watchdog-monitor';

    if (!monitorDiagnostics.has(absolutePath)) {
        monitorDiagnostics.set(absolutePath, []);
    }
    const fileDiags = monitorDiagnostics.get(absolutePath)!;
    // WHAT: Cap per-file to 50 diagnostics to prevent unbounded growth
    if (fileDiags.length >= 50) {
        log(`MONITOR CAP | ${absolutePath} has 50 diagnostics, skipping new entry`);
        return;
    }
    const diagIndex = fileDiags.length;
    fileDiags.push(diagnostic);
    monitorDedupMap.set(dedupKey, { count: 1, diagIndex, filePath: absolutePath });

    log(`MONITOR DIAGNOSTIC | ${entry.event} @ ${path.basename(entry.file)}:${entry.line}:${entry.col} | ${entry.error.substring(0, 120)}`);
}


// WHAT: Emit ONE diagnostic for a complete error block from Augment.log parsing
// WHY: monitorSystemEvents parses error blocks with message + full stack trace (multiple frames).
//      Previously, each individual stack frame created its OWN diagnostic → 5 frames × 10 cycles
//      = 50 identical "AbortError" entries drowning everything else. Instead, emit ONE diagnostic
//      per complete error block with the FULL verbatim error message AND all stack trace lines joined.
// HOW: Extract the first stack frame's file:line:col for the diagnostic location.
//      Join all stackLines into a single multi-line stack trace string.
//      Call addMonitorDiagnostic once with the complete information.
function emitErrorBlockDiagnostic(errorBlock: ErrorBlock): void {
    // WHAT: Parse stack frames for the BEST diagnostic location
    // WHY: Stack frames come in multiple formats:
    //   PATTERN A: "at eH.callApi (/home/.../extension.js:252:1928)" — parens + func name
    //   PATTERN B: "at node:internal/deps/undici/undici:14900:13" — NO parens, NO func name
    //   PATTERN C: "at async eH.callApi (/home/.../extension.js:252:478050)" — async variant
    // PROBLEM 1: Old regex only matched A/C → B never matched → L1:1 → useless.
    // PROBLEM 2: B matches but node:internal/ path → resolveFilePath joins with workspace root
    //   → creates "/workspace/node:internal/..." (BOGUS) → diagnostic INVISIBLE to diagnostics tool.
    // FIX: Parse all formats, resolve node: paths to actual extension.js with code extraction.
    let diagFile = '.augment/scripts/llm-compliance-guide.sh';
    let diagLine = 1;
    let diagCol = 1;
    let funcName = '';
    let matched = false;

    for (const frame of errorBlock.stackLines) {
        // PATTERN A/C: "at [async] funcName (file:line:col)"
        const parenMatch = frame.match(/at\s+(?:async\s+)?([^\s(]+)\s+\(([^)]+):(\d+):(\d+)\)/);
        if (parenMatch) {
            funcName = parenMatch[1];
            diagFile = parenMatch[2];
            diagLine = parseInt(parenMatch[3], 10);
            diagCol = parseInt(parenMatch[4], 10);
            matched = true;
            // WHAT: Only break on REAL filesystem paths — skip node: internals AND file:// URLs
            // WHY: Stack frames go: node:internal/undici → node:internal/task_queues →
            //   file:///usr/share/extensionHostProcess.js → /home/.../extension.js:64:59334
            //   OLD bug: broke at file:// (globalThis.fetch) → diagnostics set on non-existent
            //   file:// URI → INVISIBLE. We want the FIRST real extension.js frame.
            if (!diagFile.startsWith('node:') && !diagFile.startsWith('file://')) { break; }
        }
        // PATTERN B: "at file:line:col" (no parens — e.g. node:internal/deps/undici/undici:14900:13)
        if (!matched) {
            const bareMatch = frame.match(/at\s+(?:async\s+)?(.+):(\d+):(\d+)$/);
            if (bareMatch) {
                diagFile = bareMatch[1];
                diagLine = parseInt(bareMatch[2], 10);
                diagCol = parseInt(bareMatch[3], 10);
                funcName = diagFile.split('/').pop() || diagFile;
                matched = true;
            }
        }
    }

    // WHAT: Fallback when NO stack frames matched — resolve known error types to actual code
    // WHY: Some error blocks arrive with 0 stack lines (continuation detection edge case,
    //   or Augment.log truncation). Without this, they fall through to default L1:1 on
    //   llm-compliance-guide.sh — WRONG FILE, ZERO actionable data.
    // HOW: For AbortError, resolve to known entry point d2@64:59334 in Augment extension.js.
    if (!matched) {
        if (errorBlock.type.includes('aborted') || errorBlock.message.includes('aborted')) {
            try {
                const extDir = path.join(require('os').homedir(), '.vscode', 'extensions');
                const augmentExts = fs.readdirSync(extDir)
                    .filter((d: string) => d.startsWith('augment.vscode-augment-'))
                    .sort();
                if (augmentExts.length > 0) {
                    const latest = augmentExts[augmentExts.length - 1];
                    diagFile = path.join(extDir, latest, 'out', 'extension.js');
                    diagLine = 64; diagCol = 59334;
                    funcName = 'd2 [AbortError — no stack frames, fallback to known location]';
                    matched = true;
                }
            } catch { /* keep default — better than crashing */ }
        }
    }

    // WHAT: Resolve node:internal/ paths to the ACTUAL Augment extension.js
    // WHY: "node:internal/deps/undici/undici:14900:13" is where the error THROWS,
    //   but the Augment code that CALLS the API is in extension.js. resolveFilePath
    //   can't handle "node:" prefix → joins with workspace root → bogus path →
    //   diagnostic file doesn't exist → diagnostics tool NEVER returns it.
    // HOW: Auto-detect installed extension dir, point to d2@64:59334 (known entry point),
    //   extract 100-char verbatim code snippet at that offset as proof.
    let codeSnippet = '';
    if (matched && diagFile.startsWith('node:')) {
        const nodeLocation = `${diagFile}:${diagLine}:${diagCol}`;
        try {
            const extDir = path.join(require('os').homedir(), '.vscode', 'extensions');
            const augmentExts = fs.readdirSync(extDir)
                .filter((d: string) => d.startsWith('augment.vscode-augment-'))
                .sort();
            if (augmentExts.length > 0) {
                const latest = augmentExts[augmentExts.length - 1];
                diagFile = path.join(extDir, latest, 'out', 'extension.js');
                // Known AbortError entry point: d2 function at line 64, col 59334
                diagLine = 64;
                diagCol = 59334;
                funcName = `d2 [throw@${nodeLocation}]`;
            }
        } catch { /* keep node: path — will fall back to default */ }
    }
    // WHAT: Extract verbatim code at the resolved file:line:col
    // WHY: User asked "what script, code, line number offset and stack trace?"
    //   Showing actual minified JS at offset PROVES which function is involved.
    if (matched && !diagFile.startsWith('node:')) {
        try {
            const resolvedPath = path.isAbsolute(diagFile) ? diagFile : diagFile;
            if (fs.existsSync(resolvedPath)) {
                const content = fs.readFileSync(resolvedPath, 'utf8');
                const fileLines = content.split('\n');
                if (diagLine - 1 < fileLines.length) {
                    const theLine = fileLines[diagLine - 1];
                    const start = Math.max(0, diagCol - 50);
                    const end = Math.min(theLine.length, diagCol + 50);
                    codeSnippet = theLine.substring(start, end);
                }
            }
        } catch { /* no code snippet available */ }
    }

    // WHAT: Extract API endpoint URL and request ID from error message
    const urlMatch = errorBlock.message.match(/API request ([a-f0-9-]+) to (https?:\/\/[^\s]+)/);
    const apiInfo = urlMatch ? `Request ${urlMatch[1].substring(0, 8)}... → ${urlMatch[2]}` : '';

    // WHAT: Known AbortError call chain (5 locations in extension.js)
    const knownCallChain = errorBlock.type.includes('aborted') || errorBlock.message.includes('aborted')
        ? 'Call chain: d2@64:59334 → callApiStream@250:8939 → callApiStream@252:479212 → getRemoteAgentOverviewsStream@252:493 → handleRemoteAgentOverviewsStreamRequest@5287:22044'
        : '';
    const contextParts = [
        `${errorBlock.type} | ${errorBlock.stackLines.length} frame(s)`,
        apiInfo,
        knownCallChain,
    ].filter(Boolean);

    const fullStack = errorBlock.stackLines.join('\n');
    addMonitorDiagnostic({
        file: diagFile,
        line: diagLine,
        col: diagCol,
        event: errorBlock.type,
        error: errorBlock.message,
        timestamp: new Date().toISOString(),
        stack: fullStack || 'no stack frames captured',
        code: codeSnippet || (matched ? `${funcName} @ ${path.basename(diagFile)}:${diagLine}:${diagCol}` : 'no location parsed'),
        context: contextParts.join(' | '),
        count: 1,
    });
}

// WHAT: Build a RICH multi-line diagnostic message from a JSON queue entry
// WHY: The LLM reads diagnostics via the `diagnostics` tool. If the message is just
//      "[RULE_9_VIOLATION]", the LLM cannot troubleshoot. But if the message contains
//      verbatim error, stack trace, code snippet, and timestamps, the LLM has everything
//      it needs to diagnose and fix the problem WITHOUT additional tool calls.
//      User requested: "verbatim human readable event, error, system and application
//      relevant messages and stack trace and line numbers and verbatim code snippets"
// HOW: Concatenate all fields with labels into a multi-line string.
//      VS Code Problems panel shows full message; diagnostics tool returns it all.
function buildRichMessage(entry: RichDiagnosticEntry): string {
    const lines: string[] = [];
    lines.push(`[${entry.event}] ${entry.error}`);
    if (entry.count > 1) {
        lines.push(`Occurrences: ${entry.count}`);
    }
    if (entry.timestamp) {
        lines.push(`Timestamp: ${entry.timestamp}`);
    }
    if (entry.stack) {
        lines.push(`Stack: ${entry.stack}`);
    }
    if (entry.code) {
        lines.push(`Code: ${entry.code}`);
    }
    if (entry.context) {
        lines.push(`Context: ${entry.context}`);
    }
    return lines.join('\n');
}

// WHAT: Parse a JSON queue line into a RichDiagnosticEntry
// WHY: Primary format for rich diagnostics — contains all fields for troubleshooting
// HOW: JSON.parse, validate required fields, return typed object
function parseJsonEntry(jsonLine: string): RichDiagnosticEntry | null {
    try {
        const obj = JSON.parse(jsonLine);
        if (!obj.file || !obj.line || !obj.col) {
            console.error(`[WATCHDOG] JSON entry missing file/line/col: ${jsonLine}`);
            return null;
        }
        return {
            file: obj.file || '',
            line: parseInt(obj.line, 10) || 1,
            col: parseInt(obj.col, 10) || 1,
            event: obj.event || 'UNKNOWN',
            error: obj.error || '',
            timestamp: obj.timestamp || '',
            stack: obj.stack || '',
            code: obj.code || '',
            context: obj.context || '',
            count: parseInt(obj.count, 10) || 1,
        };
    } catch {
        return null;
    }
}

// WHAT: Parse a legacy pipe-delimited queue line into a RichDiagnosticEntry
// WHY: Backward compatibility with old queue format: file:line:col|type|func|msg
// HOW: Split on |, parse location regex, map fields to RichDiagnosticEntry
function parsePipeEntry(pipeLine: string): RichDiagnosticEntry | null {
    const parts = pipeLine.split('|');
    if (parts.length < 2) { return null; }
    const locationMatch = parts[0].match(/^(.+):(\d+):(\d+)$/);
    if (!locationMatch) { return null; }
    return {
        file: locationMatch[1],
        line: parseInt(locationMatch[2], 10),
        col: parseInt(locationMatch[3], 10),
        event: parts[1] || 'UNKNOWN',
        error: parts.length > 3 ? parts[3] : parts[1],
        timestamp: '',
        stack: '',
        code: '',
        context: parts.length > 2 ? parts[2] : '',
        count: 1,
    };
}

function readDiagnosticsQueueAndFlag(): void {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const queuePath = path.join(workspaceFolder.uri.fsPath, DIAGNOSTICS_QUEUE_FILENAME);
        if (!fs.existsSync(queuePath)) { return; }

        const content = fs.readFileSync(queuePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);

        if (lines.length === 0) {
            if (diagnosticCollection) { diagnosticCollection.clear(); }
            return;
        }

        const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();
        const workspaceRoot = workspaceFolder.uri.fsPath;

        lines.forEach((line) => {
            // WHAT: Try JSON first, fall back to pipe-delimited
            // WHY: JSON is the rich format with all fields; pipe is legacy
            const entry = parseJsonEntry(line) || parsePipeEntry(line);
            if (!entry) {
                console.error(`[WATCHDOG] Skipping unparseable queue line: ${line}`);
                return;
            }

            const absolutePath = resolveFilePath(entry.file, workspaceRoot);
            // WHAT: VS Code lines/cols are 0-based; queue entries are 1-based
            const lineNum = Math.max(0, entry.line - 1);
            const charOffset = Math.max(0, entry.col - 1);

            // WHAT: Build the RICH multi-line message the LLM will read
            // WHY: This is the ENTIRE point — the LLM calls diagnostics tool,
            //      gets this message, and can troubleshoot from it alone
            const diagMessage = buildRichMessage(entry);

            const range = new vscode.Range(lineNum, charOffset, lineNum, charOffset + 20);
            const diagnostic = new vscode.Diagnostic(
                range,
                diagMessage,
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = 'watchdog-stack-trace';

            if (!diagnosticsByFile.has(absolutePath)) {
                diagnosticsByFile.set(absolutePath, []);
            }
            diagnosticsByFile.get(absolutePath)!.push(diagnostic);
        });

        if (diagnosticCollection) {
            diagnosticCollection.clear();
            // WHAT: Merge queue-file diagnostics with LIVE monitoring diagnostics
            // WHY: Queue file has external script findings (llm-compliance-guide.sh);
            //      monitorDiagnostics has live findings from monitorSystemEvents,
            //      monitorApplicationEvents, monitorZygoteProcesses, monitorCancellationPatterns.
            //      BOTH must appear in the Problems panel so the LLM sees ALL evidence.
            // HOW: Copy monitorDiagnostics entries into diagnosticsByFile, then set all at once
            monitorDiagnostics.forEach((diags, filePath) => {
                if (!diagnosticsByFile.has(filePath)) {
                    diagnosticsByFile.set(filePath, []);
                }
                diagnosticsByFile.get(filePath)!.push(...diags);
            });
            diagnosticsByFile.forEach((diags, filePath) => {
                const uri = vscode.Uri.file(filePath);
                diagnosticCollection!.set(uri, diags);
            });

            // WHAT: Log a RICH summary, not just "Flagged N locations"
            // WHY: "Flagged 1 locations from queue" is vague and useless
            const totalDiags = Array.from(diagnosticsByFile.values()).reduce((s, d) => s + d.length, 0);
            const fileList = Array.from(diagnosticsByFile.keys()).map(f => path.basename(f)).join(', ');
            log(`DIAGNOSTICS | ${totalDiags} entries | Files: ${fileList}`);
            diagnosticsByFile.forEach((diags, _filePath) => {
                diags.forEach(d => {
                    log(`  → L${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message.split('\n')[0]}`);
                });
            });
        }
    } catch (err) {
        console.error("[WATCHDOG] readDiagnosticsQueueAndFlag failed:", err);
    }
}

// WHAT: Detect when installed extension.js on disk is NEWER than the running in-memory code
// WHY: `code --install-extension` replaces out/extension.js on disk but VS Code keeps
//   the OLD code in memory. This is the root cause of "extension is still running an older
//   version" — every compile+install cycle requires a manual window reload. Without detection,
//   new fixes appear uninstalled even though `code --install-extension` succeeded.
// HOW: Read __filename from disk, extract BUILD_MARKER value, compare with in-memory const.
//   If they differ → disk has newer code → auto-reload VS Code window.
//   BUILD_MARKER is '__BUILD_TS__' in source, replaced with UTC timestamp by compile script.
// WHEN: Called once at activation + every STALE_CHECK_INTERVAL (30s).
function checkForStaleCode(): void {
    try {
        // __filename = path to the running extension.js in ~/.vscode/extensions/...
        const diskContent = fs.readFileSync(__filename, 'utf8');
        // Extract the BUILD_MARKER value from the disk file
        // Pattern: BUILD_MARKER="20260220T143052Z" (after sed replacement)
        // Or: BUILD_MARKER="__BUILD_TS__" (if somehow not replaced — skip check)
        const diskMatch = diskContent.match(/BUILD_MARKER\s*=\s*["']([^"']+)["']/);
        if (!diskMatch) { return; }  // Can't parse — don't reload
        const diskMarker = diskMatch[1];
        if (diskMarker === '__BUILD_TS__') { return; }  // Not stamped — skip
        if (BUILD_MARKER === '__BUILD_TS__') { return; }  // Running unstamped — skip
        if (diskMarker === BUILD_MARKER) { return; }  // Same version — no action needed

        // STALE CODE DETECTED: disk has newer build than running code
        log(`STALE CODE DETECTED | running=${BUILD_MARKER} | disk=${diskMarker} | auto-reloading...`);
        console.log(`[WATCHDOG] STALE CODE: running=${BUILD_MARKER}, disk=${diskMarker}. Reloading window.`);
        // Auto-reload after 2s to let log message flush
        setTimeout(() => {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }, 2000);
    } catch (e) {
        // Can't read file — not fatal, skip silently
    }
}

export function activate(context: vscode.ExtensionContext) {
    // WHAT: Log to console for debugging activation
    // WHY: Extension activates but no output channel appears - need to see if activate() runs
    // HOW: console.log writes to extension host log, visible even if extension fails
    console.log("[WATCHDOG] activate() function called - extension is loading");

    try {
        // WHAT: Log activation message to output channel
        // WHY: First indication that extension is running
        // HOW: Call log() which creates output channel and terminal
        log("Watchdog activated.");
        console.log("[WATCHDOG] log() call succeeded");

        // WHAT: Show terminal immediately
        // WHY: Make watchdog output visible to user
        // HOW: Get terminal instance and call show()
        const terminal = getTerminal();
        terminal.show(true);
        console.log("[WATCHDOG] Terminal shown");

        // WHAT: Start all monitoring functions
        // WHY: Core watchdog functionality
        // HOW: Call each monitor function to set up intervals, store IDs for cleanup
        const eventLoopInterval = monitorEventLoop();
        context.subscriptions.push({ dispose: () => clearInterval(eventLoopInterval) });

        monitorTerminals();

        const processInterval = monitorProcesses();
        context.subscriptions.push({ dispose: () => clearInterval(processInterval) });

        const cancellationInterval = monitorCancellationPatterns();
        context.subscriptions.push({ dispose: () => clearInterval(cancellationInterval) });

        const terminalOutputInterval = monitorTerminalOutput();
        if (terminalOutputInterval) {
            context.subscriptions.push({ dispose: () => clearInterval(terminalOutputInterval) });
        }

        const systemEventsIntervals = monitorSystemEvents();
        systemEventsIntervals.forEach((id: NodeJS.Timeout) => context.subscriptions.push({ dispose: () => clearInterval(id) }));

        const appEventsIntervals = monitorApplicationEvents();
        appEventsIntervals.forEach((id: NodeJS.Timeout) => context.subscriptions.push({ dispose: () => clearInterval(id) }));

        console.log("[WATCHDOG] All monitors started");

        // WHAT: Monitor zygote processes every 30 seconds
        // WHY: Detect runaway zygote processes causing resource leaks
        // HOW: setInterval calls monitorZygoteProcesses every ZYGOTE_CHECK_INTERVAL, store in variable for cleanup
        const zygoteInterval = setInterval(monitorZygoteProcesses, ZYGOTE_CHECK_INTERVAL);
        context.subscriptions.push({ dispose: () => clearInterval(zygoteInterval) });
        log(`INFO | Zygote monitoring started (CPU > ${ZYGOTE_CPU_THRESHOLD}%, Memory > ${ZYGOTE_MEMORY_THRESHOLD}MB)`);

        // WHAT: Start heartbeat to show extension is alive
        // WHY: Periodic status updates for debugging
        // HOW: setInterval calls heartbeat every HEARTBEAT_INTERVAL, store in variable for cleanup
        const heartbeatInterval = setInterval(heartbeat, HEARTBEAT_INTERVAL);
        context.subscriptions.push({ dispose: () => clearInterval(heartbeatInterval) });
        console.log("[WATCHDOG] Heartbeat started");

        // WHAT: Create diagnostic collection and start polling diagnostics queue
        // WHY: LLM sees VS Code diagnostics; flagged lines force evidence-based compliance
        // HOW: Create collection once, poll queue file every DIAGNOSTICS_REFRESH_INTERVAL
        diagnosticCollection = vscode.languages.createDiagnosticCollection('watchdog-stack-trace');
        context.subscriptions.push(diagnosticCollection);

        // WHAT: Run once immediately so diagnostics appear without waiting for first interval
        // WHY: User may have just run extract-stack-trace-locations.sh before reloading
        // HOW: Direct function call before setInterval
        readDiagnosticsQueueAndFlag();

        const diagnosticsInterval = setInterval(readDiagnosticsQueueAndFlag, DIAGNOSTICS_REFRESH_INTERVAL);
        context.subscriptions.push({ dispose: () => clearInterval(diagnosticsInterval) });
        console.log("[WATCHDOG] Diagnostics queue polling started");

        // WHAT: Staleness detection — auto-reload when installed code is newer than running code
        // WHY: code --install-extension replaces disk file but VS Code keeps old code in memory.
        //   Without this, every compile+install requires manual Ctrl+Shift+P → Reload Window.
        // HOW: checkForStaleCode reads __filename from disk, compares BUILD_MARKER.
        //   Run once immediately (catches stale from previous install), then every 30s.
        checkForStaleCode();
        const staleCheckInterval = setInterval(checkForStaleCode, STALE_CHECK_INTERVAL);
        context.subscriptions.push({ dispose: () => clearInterval(staleCheckInterval) });
        log(`INFO | Stale code detection started (BUILD_MARKER=${BUILD_MARKER})`);

        console.log("[WATCHDOG] activate() completed successfully");
    } catch (err) {
        // WHAT: Catch and log any errors during activation
        // WHY: Silent failures prevent debugging
        // HOW: Log error to console (always visible) and try to log to output channel
        console.error("[WATCHDOG] ACTIVATION FAILED:", err);
        try {
            log(`CRITICAL | Activation failed: ${err}`);
        } catch (logErr) {
            console.error("[WATCHDOG] Failed to call log():", logErr);
        }
    }
}

function heartbeat() {
    log(`HEARTBEAT | terminals=${vscode.window.terminals.length} | cancellations=${cancellationEvents}`);
}

function monitorEventLoop() {
    // WHAT: Monitor event loop for stalls
    // WHY: Event loop stalls indicate performance issues
    // HOW: Track time between ticks, alert if drift exceeds threshold
    let lastTick = Date.now();

    // WHAT: Store interval ID for cleanup
    // WHY: Prevent memory leaks
    // HOW: Return interval ID so caller can clear it
    const intervalId = setInterval(() => {
        const now = Date.now();
        const drift = now - lastTick - HEARTBEAT_INTERVAL;

        if (drift > EVENT_LOOP_DRIFT_THRESHOLD) {
            log(`CRITICAL | Event loop stall detected | drift=${drift}ms`);
            attemptRecovery("event-loop-stall");
        }

        lastTick = now;
    }, HEARTBEAT_INTERVAL);

    return intervalId;
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
    // WHAT: Monitor node process count
    // WHY: Too many node processes indicate resource leak
    // HOW: Poll ps every PROCESS_SCAN_INTERVAL, store interval for cleanup
    const intervalId = setInterval(() => {
        exec("ps -eo pid,comm | grep -E 'node|npm' | grep -v grep", (err, stdout) => {
            if (err || !stdout) return;

            const processes = stdout.split('\n').filter(Boolean);

            if (processes.length > MAX_NODE_PROCESSES) {
                log(`CRITICAL | Node process overload | count=${processes.length}`);
                attemptRecovery("node-overload");
            }
        });
    }, PROCESS_SCAN_INTERVAL);

    return intervalId;
}

function monitorSystemEvents(): NodeJS.Timeout[] {
    // USER REQUEST: "display _all_ event, error, system and application relevant messages"
    // COMPLIANCE: Log FULL verbatim messages, not just counts
    // RATIONALE: User complained "a lot of these look to be omitting the actual errors"

    // WHAT: Store all interval IDs for cleanup
    // WHY: Prevent memory leaks
    // HOW: Return array of interval IDs
    const intervals: NodeJS.Timeout[] = [];

    // Monitor journalctl for system errors every 60 seconds
    // LOGS: Full error message from journalctl -p err
    // WHAT: Store interval ID before pushing to array
    // WHY: Linter requires direct assignment pattern
    // HOW: const intervalId = setInterval(...); intervals.push(intervalId);
    const journalctlInterval = setInterval(() => {
        exec("journalctl -p err --since '60 seconds ago' --no-pager 2>/dev/null | tail -10", (err, stdout) => {
            if (!err && stdout && stdout.trim()) {
                const lines = stdout.split('\n').filter(Boolean);
                if (lines.length > 0) {
                    log(`SYSTEM ERROR | journalctl -p err | count=${lines.length}`);
                    lines.forEach(line => log(`  ${line}`));  // VERBATIM full line
                }
            }
        });
    }, 60000);
    intervals.push(journalctlInterval);

    // Monitor OOM (out-of-memory) events every 60 seconds
    // LOGS: Full OOM kill messages from journalctl
    const oomInterval = setInterval(() => {
        exec("journalctl --since '60 seconds ago' --no-pager 2>/dev/null | grep -i 'oom\\|killed' | tail -5", (err, stdout) => {
            if (!err && stdout && stdout.trim()) {
                const lines = stdout.split('\n').filter(Boolean);
                if (lines.length > 0) {
                    log(`OOM EVENT | journalctl oom/killed | count=${lines.length}`);
                    lines.forEach(line => log(`  ${line}`));  // VERBATIM full line
                }
            }
        });
    }, 60000);
    intervals.push(oomInterval);

    // Monitor kernel errors from dmesg every 60 seconds
    // LOGS: Full kernel error messages
    const dmesgInterval = setInterval(() => {
        exec("dmesg -T 2>/dev/null | tail -50 | grep -iE 'error|fail|oom' | tail -5", (err, stdout) => {
            if (!err && stdout && stdout.trim()) {
                const lines = stdout.split('\n').filter(Boolean);
                if (lines.length > 0) {
                    log(`KERNEL ERROR | dmesg | count=${lines.length}`);
                    lines.forEach(line => log(`  ${line}`));  // VERBATIM full line
                }
            }
        });
    }, 60000);
    intervals.push(dmesgInterval);

    // Monitor VS Code extension errors every 60 seconds WITH STACK TRACES
    // USER REQUEST: "try to show what line and subroutine of what file or scripts called or caused the error"
    // PROBLEM: Previous version logged error messages but NOT stack traces
    // ROOT CAUSE: grep only captures single line, stack traces are on following lines
    // SOLUTION: Use grep -A 10 to capture error + next 10 lines (stack trace)
    // BENEFIT: LLM can see exact file (extension.js:252:1928) and function (eH.callApi) that caused error
    // TROUBLESHOOTING VALUE: Shows call chain: callApi → chatInputCompletion → callChatInputCompletionAPI → fetchCompletion
    const extensionErrorInterval = setInterval(() => {
        const logsDir = path.join(require('os').homedir(), '.config/Code/logs');

        // STEP 1: Find Augment.log (most important for troubleshooting)
        exec(`find ${logsDir} -name "Augment.log" -type f 2>/dev/null | sort | tail -1`, (err1, augmentLogPath) => {
            if (err1 || !augmentLogPath || !augmentLogPath.trim()) {
                return;  // No Augment.log found
            }

            const logPath = augmentLogPath.trim();

            // STEP 2: Extract errors with stack traces (error line + next 10 lines)
            // PATTERN: "2026-02-18 13:01:00.652 [error] 'ClientWorkspaces': Failed to call..."
            //          "Error: Request cancelled"
            //          "    at eH.callApi (/home/owner/.vscode/extensions/.../extension.js:252:1928)"
            //          "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)"
            //          ...
            exec(`tail -500 "${logPath}" | grep -B 0 -A 10 "\\[error\\]\\|\\[warning\\]" | tail -100`, (err2, stdout) => {
                if (err2 || !stdout || !stdout.trim()) {
                    return;  // No errors found
                }

                const lines = stdout.split('\n').filter(Boolean);
                if (lines.length === 0) {
                    return;
                }

                log(`EXTENSION ERROR WITH STACK TRACES | Augment.log (last 500 lines) | count=${lines.length}`);

                // COMPLIANCE FIX: Parse errors and log to database with stack traces
                // WHY: Database-driven monitoring requires ALL errors in database, not just logs
                // HOW: Parse error blocks, extract error type, message, and stack trace, insert to database
                let currentError: ErrorBlock | null = null;

                // Log each line with proper formatting AND parse for database insertion
                // ERROR LINE: "2026-02-18 13:01:00.652 [error] 'ClientWorkspaces': Failed to call..."
                // STACK LINE: "    at eH.callApi (/home/owner/.vscode/extensions/.../extension.js:252:1928)"
                lines.forEach(line => {
                    if (line.trim() === '--') {
                        // End of current error block - save to database if we have one
                        const errorToSave = currentError;
                        if (errorToSave && errorToSave.stackLines.length > 0) {
                            const stackTrace = errorToSave.stackLines.join('\n');
                            // WHAT: Pass stack trace as SEPARATE parameter (3rd param)
                            // WHY: Database has stack_trace column, diagnostics need full stack traces
                            // HOW: logToDatabase(type, message, stackTrace) instead of concatenating
                            // RATIONALE: Previous version truncated to 200 chars, losing critical data
                            logToDatabase(errorToSave.type, errorToSave.message, stackTrace);
                            // WHAT: Emit ONE diagnostic for the complete error block
                            // WHY: Full verbatim error message + ALL stack frames in one diagnostic
                            emitErrorBlockDiagnostic(errorToSave);
                            currentError = null;
                        }
                        return;  // Skip grep separator
                    }

                    // Check if this is a new error line
                    const errorMatch = line.match(/\[error\]\s+'([^']+)':\s+(.+)/);
                    if (errorMatch) {
                        const newService = errorMatch[1];
                        const newMsg = errorMatch[2];
                        // WHAT: Detect continuation lines from the SAME error event
                        // WHY: Augment.log often emits TWO [error] lines for one event:
                        //   Line 1: "API request UUID to URL failed: This operation was aborted"
                        //   Line 2: "AbortError: This operation was aborted"
                        //   Then:   "\tat node:internal/deps/undici/undici:14900:13"
                        // PROBLEM: Without this check, Line 1 (with the actionable API URL) gets
                        //   saved with 0 stackLines and LOST. Line 2 (generic "AbortError") becomes
                        //   the error block that gets the stack trace. Result: diagnostic shows
                        //   "AbortError: This operation was aborted" at L1:1 — useless.
                        // FIX: If same service name and current error has no stack lines yet,
                        //   APPEND to the existing error message instead of starting a new block.
                        //   This preserves the API URL from Line 1 in the error message.
                        const currForContinuation = currentError;
                        if (currForContinuation && currForContinuation.stackLines.length === 0
                            && currForContinuation.message.startsWith(newService + ':')) {
                            // Continuation — append the detail line to existing message
                            currForContinuation.message += ' | ' + newMsg;
                        } else {
                            // Genuinely new error — save previous and start fresh
                            const prevError = currentError;
                            if (prevError && prevError.stackLines.length > 0) {
                                const stackTrace = prevError.stackLines.join('\n');
                                // WHAT: Pass stack trace as SEPARATE parameter (3rd param)
                                // WHY: Database has stack_trace column, diagnostics need full stack traces
                                logToDatabase(prevError.type, prevError.message, stackTrace);
                                emitErrorBlockDiagnostic(prevError);
                            }
                            currentError = {
                                type: 'Request cancelled',  // Default, will be refined
                                message: `${newService}: ${newMsg}`,
                                stackLines: []
                            };
                        }
                    }

                    // Check if this is an "Error: " line (error type)
                    const errorTypeMatch = line.match(/Error:\s+(.+)/);
                    const currErr = currentError;
                    if (errorTypeMatch && currErr) {
                        currErr.type = errorTypeMatch[1];
                    }

                    // Check if this is a stack trace line
                    if (line.includes('\tat ') || line.includes('    at ')) {
                        const currErr2 = currentError;
                        if (currErr2) {
                            currErr2.stackLines.push(line.trim());
                        }
                        // STACK TRACE: Extract file path and line number
                        // PATTERN 1: "    at eH.callApi (/path/extension.js:252:1928)"
                        // PATTERN 2: "    at async eH.callApi (/path/extension.js:252:478050)"
                        // PATTERN 3: "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)"

                        // Match both "at func (...)" and "at async func (...)"
                        const stackMatch = line.match(/at\s+(?:async\s+)?([^\s(]+)\s+\(([^)]+):(\d+):(\d+)\)/);
                        if (stackMatch) {
                            const funcName = stackMatch[1];
                            const filePath = stackMatch[2];
                            const lineNum = stackMatch[3];
                            const colNum = stackMatch[4];

                            // Simplify file path: show extension name + filename
                            let simplifiedPath = filePath;
                            if (filePath.includes('/extensions/')) {
                                const parts = filePath.split('/extensions/');
                                if (parts.length > 1) {
                                    const extParts = parts[1].split('/');
                                    simplifiedPath = `${extParts[0]}/${extParts[extParts.length - 1]}`;
                                }
                            } else if (filePath.startsWith('node:')) {
                                // Node.js internal: "node:internal/process/task_queues"
                                simplifiedPath = filePath;
                            } else {
                                // Other paths: show just filename
                                simplifiedPath = filePath.split('/').pop() || filePath;
                            }

                            log(`    STACK: ${funcName} @ ${simplifiedPath}:${lineNum}:${colNum}`);
                            // NOTE: Per-frame diagnostics REMOVED — caused flooding.
                            // emitErrorBlockDiagnostic() is called when the complete error block
                            // is finished (at '--' separator, new error, or end of parsing).
                            // That creates ONE diagnostic with the FULL stack trace.
                        } else {
                            log(`    ${line.trim()}`);
                        }
                    } else if (line.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[(error|warning)\]/)) {
                        // ERROR/WARNING LINE: Log with filename prefix
                        log(`  Augment.log: ${line.trim()}`);
                    } else if (line.startsWith('Error:')) {
                        // ERROR MESSAGE: Log indented
                        log(`    ${line.trim()}`);
                    } else {
                        // OTHER CONTEXT: Log as-is
                        log(`    ${line.trim()}`);
                    }
                });

                // COMPLIANCE FIX: Save final error block to database
                // WHY: Ensure ALL errors are in database for query-driven analysis
                // HOW: Check if we have accumulated error with stack trace, insert to database
                if (currentError) {
                    const finalError: ErrorBlock = currentError;
                    if (finalError.stackLines.length > 0) {
                        const stackTrace = finalError.stackLines.join('\n');
                        // WHAT: Pass stack trace as SEPARATE parameter (3rd param)
                        // WHY: Database has stack_trace column, diagnostics need full stack traces
                        logToDatabase(finalError.type, finalError.message, stackTrace);
                        emitErrorBlockDiagnostic(finalError);
                    }
                }
            });
        });
    }, 60000);
    intervals.push(extensionErrorInterval);

    log("INFO | System event monitoring started");

    // WHAT: Return all interval IDs
    // WHY: Caller needs to clear intervals on deactivation
    // HOW: Return array of NodeJS.Timeout objects
    return intervals;
}

function monitorApplicationEvents(): NodeJS.Timeout[] {
    // USER REQUEST: "display _all_ event, error, system and application relevant messages"
    // COMPLIANCE: Log FULL verbatim messages with context

    // WHAT: Store all interval IDs for cleanup
    // WHY: Prevent memory leaks
    // HOW: Return array of interval IDs
    const intervals: NodeJS.Timeout[] = [];

    // Monitor VS Code crashes every 60 seconds
    // LOGS: Full crash/segfault messages from journalctl
    const crashInterval = setInterval(() => {
        exec("journalctl --since '60 seconds ago' --no-pager 2>/dev/null | grep -iE 'code.*segfault|code.*crash' | tail -5", (err, stdout) => {
            if (!err && stdout && stdout.trim()) {
                const lines = stdout.split('\n').filter(Boolean);
                if (lines.length > 0) {
                    log(`APPLICATION CRASH | VS Code segfault/crash | count=${lines.length}`);
                    lines.forEach(line => log(`  ${line}`));  // VERBATIM full line
                }
            }
        });
    }, 60000);
    intervals.push(crashInterval);

    // Monitor swap thrashing every 30 seconds
    // LOGS: Swap in/out rates when threshold exceeded (>100KB/s)
    // RATIONALE: Swap thrashing indicates memory pressure
    const swapInterval = setInterval(() => {
        exec("vmstat 1 2 | tail -1", (err, stdout) => {
            if (!err && stdout && stdout.trim()) {
                const fields = stdout.trim().split(/\s+/);
                if (fields.length >= 9) {
                    const swapIn = parseInt(fields[6] || '0');
                    const swapOut = parseInt(fields[7] || '0');
                    if (swapIn > 100 || swapOut > 100) {
                        log(`SWAP THRASHING | swap-in=${swapIn}KB/s swap-out=${swapOut}KB/s | vmstat: ${stdout.trim()}`);
                    }
                }
            }
        });
    }, 30000);
    intervals.push(swapInterval);

    // Monitor file descriptor usage every 60 seconds
    // PROBLEM: "19680 code 123893" doesn't explain WHAT is consuming FDs
    // ROOT CAUSE: Only showing PID, not what the process is doing (extension host, renderer, etc)
    // FIX: Use lsof to show process name, PID, and WHAT files/sockets are open
    // RESULT: Can identify if FD leak is from file watchers, network sockets, or pipes
    const fdInterval = setInterval(() => {
        exec("lsof 2>/dev/null | grep -c code || echo 0", (err, stdout) => {
            if (!err && stdout) {
                const fdCount = parseInt(stdout.trim());
                if (fdCount > 50000) {
                    log(`FILE DESCRIPTOR WARNING | VS Code FDs=${fdCount} | threshold=50000`);

                    // COMPLIANCE FIX: Log FD warnings to database
                    // WHY: Database-driven monitoring requires FD leak events in database
                    // HOW: Insert FD count and threshold to database for correlation with errors
                    logToDatabase('fd_leak_warning', `File descriptor count: ${fdCount} (threshold: 50000)`);

                    // WHAT: Create a VS Code diagnostic for the FD leak
                    // WHY: LLM must see exact FD count, threshold, and context via diagnostics tool
                    // HOW: addMonitorDiagnostic with verbatim count and troubleshooting context
                    // WHAT: Point diagnostic to OUR source code where FD monitoring happens
                    // WHY: Old code used llm-compliance-guide.sh:1:1 → WRONG FILE, L1:1 → useless
                    // HOW: Use our extension.ts source at the logToDatabase call site (~L1087)
                    addMonitorDiagnostic({
                        file: 'hidden-terminal-watchdog/src/extension.ts',
                        line: 1087, col: 1,
                        event: 'fd_leak_warning',
                        error: `File descriptor count: ${fdCount} (threshold: 50000)`,
                        timestamp: new Date().toISOString(),
                        stack: `lsof 2>/dev/null | grep -c code → ${fdCount}`,
                        code: `logToDatabase('fd_leak_warning', \`File descriptor count: \${fdCount} (threshold: 50000)\`)`,
                        context: `VS Code file descriptors exceed 50K. REG=file watcher leak, unix=IPC socket leak, pipe=subprocess leak. Fix applied: disabled augment.completions.enableChatInputCompletions. Source: monitorApplicationEvents() in our extension.ts.`,
                        count: 1,
                    });

                    // USER REQUEST: "application relevant troubleshooting to reduce resource contention"
                    // PROBLEM: lsof output format varies - some lines have different column counts
                    // EXAMPLE LINE 1: "code 123893 owner 4u REG 253,0 12345 /path"  (7+ columns, $4=FD, $5=TYPE)
                    // EXAMPLE LINE 2: "code 123893 ThreadPoo owner mem REG"         (6 columns, $4=owner, $5=mem, $6=REG)
                    // EXAMPLE LINE 3: "code 123893 ThreadPoo owner"                 (4 columns, $4=owner, $5=EMPTY)
                    // ROOT CAUSE: Thread names (ThreadPoo, libuv-wor) shift columns right
                    // CURRENT BUG: awk '{print $5}' gets "owner" (column 4 value) instead of TYPE
                    // WHY THIS MATTERS: "48267 owner" is useless, need "2601 REG, 150 unix, 127 FIFO" to identify leak type
                    // TROUBLESHOOTING VALUE: REG=file watchers, unix=IPC sockets, pipe=child processes, CHR=terminals

                    // FIX ATTEMPT 1 (FAILED): Use NF>=5 to filter lines with at least 5 fields
                    // REASON IT FAILED: Lines with thread names still have 6+ fields, but TYPE is in column 6, not 5
                    // EXAMPLE: "code 123893 ThreadPoo owner mem REG" has NF=6, $5="mem" not "REG"

                    // FIX ATTEMPT 2 (CORRECT): Parse TYPE column by searching for known FD types
                    // KNOWN FD TYPES: REG, DIR, CHR, FIFO, unix, IPv4, IPv6, sock, pipe, a_inode, netlink
                    // METHOD: For each line, find first field matching known TYPE, ignore position
                    // BENEFIT: Works regardless of thread name presence or column shifts
                    // PERFORMANCE: -n flag disables hostname lookup (speeds up lsof by ~50%)

                    // Get breakdown by FD type (REG=file, unix=socket, pipe, etc)
                    // TROUBLESHOOTING: High REG count = file watcher leak, high unix = IPC leak, high pipe = subprocess leak
                    exec("lsof -n 2>/dev/null | grep code | awk '{for(i=1;i<=NF;i++) if($i~/^(REG|DIR|CHR|FIFO|unix|IPv4|IPv6|sock|pipe|a_inode|netlink)$/) print $i}' | sort | uniq -c | sort -rn", (err3, stdout3) => {
                        if (!err3 && stdout3 && stdout3.trim()) {
                            log(`  FD breakdown by type:`)
                            stdout3.split('\n').filter(Boolean).forEach(line => log(`    ${line}`));
                        }
                    });

                    // Get detailed FD breakdown: process name, PID, FD number, FD type
                    // TROUBLESHOOTING: Identifies which VS Code process (extension host, renderer, etc) is leaking FDs
                    // PID 123893 = main extension host, 124008 = renderer, 124045 = shared process
                    // High count on specific PID = that process has FD leak
                    exec("lsof -n 2>/dev/null | grep code | awk '{cmd=$1; pid=$2; fd=\"\"; type=\"\"; for(i=3;i<=NF;i++) {if($i~/^[0-9]+[urw]$/) fd=$i; if($i~/^(REG|DIR|CHR|FIFO|unix|IPv4|IPv6|sock|pipe|a_inode|netlink)$/) type=$i} if(fd && type) print cmd, pid, fd, type}' | sort | uniq -c | sort -rn | head -10", (err2, stdout2) => {
                        if (!err2 && stdout2 && stdout2.trim()) {
                            log(`  Top FD consumers (count, process, PID, FD#, type):`)
                            stdout2.split('\n').filter(Boolean).forEach(line => log(`    ${line}`));
                        }
                    });
                }
            }
        });
    }, 60000);
    intervals.push(fdInterval);

    log("INFO | Application event monitoring started");

    // WHAT: Return all interval IDs
    // WHY: Caller needs to clear intervals on deactivation
    // HOW: Return array of NodeJS.Timeout objects
    return intervals;
}

function monitorCancellationPatterns(): NodeJS.Timeout {
    // WHAT: Monitor for "Cancelled by user" errors
    // WHY: Detect cancellation patterns that indicate tool infrastructure issues
    // HOW: Check VS Code diagnostics every 60 seconds, return interval ID for cleanup

    // Note: onDidChangeDiagnostics is event-based, not interval-based
    // But we still need to return something for consistency
    // Create a dummy interval that does nothing (will be replaced with proper monitoring)
    const intervalId = setInterval(() => {
        // Monitor for "Cancelled by user" errors by checking VS Code diagnostics
        vscode.workspace.textDocuments.forEach(doc => {
            const diagnostics = vscode.languages.getDiagnostics(doc.uri);
            diagnostics.forEach(diag => {
                if (diag.message.includes('Cancelled by user')) {
                    cancellationEvents++;
                    log(`DETECTED | Cancellation pattern in diagnostics | total=${cancellationEvents}`);
                    log(`LOCATION | ${doc.uri.fsPath}:${diag.range.start.line}`);

                    // WHAT: Create a VS Code diagnostic for the cancellation pattern
                    // WHY: "_cancelledByUser" one-way latch causes ALL tool calls to fail.
                    //      LLM must see the exact location and count via diagnostics tool.
                    // HOW: addMonitorDiagnostic with file, line, cancellation count, context
                    addMonitorDiagnostic({
                        file: doc.uri.fsPath,
                        line: diag.range.start.line + 1,
                        col: diag.range.start.character + 1,
                        event: 'cancellation_pattern_detected',
                        error: `"Cancelled by user" pattern detected — total occurrences: ${cancellationEvents}`,
                        timestamp: new Date().toISOString(),
                        stack: `Diagnostic source: ${doc.uri.fsPath}:${diag.range.start.line + 1}:${diag.range.start.character + 1}`,
                        code: diag.message.substring(0, 200),
                        context: `_cancelledByUser one-way latch set to true but NEVER reset. All tool calls fail until VS Code reloads. RULE 22 terminal hygiene prevents this.`,
                        count: cancellationEvents,
                    });

                    attemptRecovery("cancellation-pattern");
                }
            });
        });
    }, 60000);

    return intervalId;
}

const processedFiles = new Map<string, number>();

function monitorTerminalOutput(): NodeJS.Timeout | undefined {
    // WHAT: Monitor terminal output log files
    // WHY: Detect stall patterns and backend kill commands
    // HOW: Poll .notes directory every 1 second, return interval ID for cleanup
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        log("WARNING | No workspace folder found, terminal output monitoring disabled");
        return undefined;
    }

    const notesDir = path.join(workspaceFolder.uri.fsPath, '.notes');

    // Poll for new terminal log files every 1 second
    const intervalId = setInterval(() => {
        try {
            if (!fs.existsSync(notesDir)) {
                return;
            }

            const files = fs.readdirSync(notesDir);

            files.forEach(filename => {
                if (!filename.startsWith('terminal-') || !filename.endsWith('.log')) {
                    return;
                }

                const filePath = path.join(notesDir, filename);

                try {
                    const stats = fs.statSync(filePath);
                    const currentSize = stats.size;
                    const lastSize = processedFiles.get(filePath) || 0;

                    // Skip if file hasn't changed
                    if (currentSize === lastSize) {
                        return;
                    }

                    // Read the file
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n').filter(line => line.trim());

                    if (lines.length === 0) {
                        return;
                    }

                    // Update processed size
                    processedFiles.set(filePath, currentSize);

                    // Log all lines from the terminal output
                    log(`TERMINAL OUTPUT | File: ${filename} | Lines: ${lines.length}`);
                    lines.forEach(line => {
                        log(`  ${line}`);

                        // DETECT STALL PATTERNS
                        if (line.includes('Waiting for user input')) {
                            log(`🔴 STALL DETECTED | "Waiting for user input" when user said "proceed"`);
                            log(`🔴 VIOLATION | RULE 0 - Emission gate failure - guessing instead of executing`);
                        }

                        if (line.includes('pkill')) {
                            log(`⚠️ BACKEND KILL DETECTED | Command: ${line}`);
                        }
                    });

                } catch (err) {
                    // WHAT: Log parse errors to console
                    // WHY: Silent failures prevent debugging
                    // HOW: console.error writes to extension host log
                    console.error("[WATCHDOG] Failed to parse terminal log:", err);
                    // File might be being written, skip this iteration
                }
            });

        } catch (err) {
            // WHAT: Log scan errors to console
            // WHY: Errors must be visible even if log() fails
            // HOW: console.error always writes to extension host log
            console.error("[WATCHDOG] Failed to scan terminal logs:", err);
            log(`ERROR | Failed to scan terminal logs: ${err}`);
        }
    }, 1000);

    log("INFO | Terminal output monitoring started");

    // WHAT: Return interval ID
    // WHY: Caller needs to clear interval on deactivation
    // HOW: Return NodeJS.Timeout object
    return intervalId;
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
    // WHAT: Wrap deactivate in try-catch
    // WHY: Prevent silent failures during extension shutdown
    // HOW: Log errors to console if deactivation fails
    try {
        log("Watchdog deactivated.");
    } catch (err) {
        console.error("[WATCHDOG] Deactivation failed:", err);
    }
}