# Hidden Terminal Watchdog

A VS Code extension that monitors and cleans hidden terminals and extension hosts to prevent RULE 22 violations and MCP instability.

## Features

- **Automatic Monitoring**: Continuously monitors for hidden VS Code terminal processes and extension hosts
- **Real-time Alerts**: Warns when hidden terminal count exceeds configurable threshold
- **Manual Cleanup**: Command palette action to force cleanup of hidden terminals
- **Status Monitoring**: View current status of tracked and hidden terminals
- **Configurable**: Customize monitoring interval, thresholds, and auto-cleanup behavior

## Commands

- `Hidden Terminal Watchdog: Force Cleanup` - Immediately cleanup all hidden terminals
- `Hidden Terminal Watchdog: Show Status` - Display current terminal status

## Configuration

- `watchdog.monitorInterval` - Interval in milliseconds to check for hidden terminals (default: 5000ms)
- `watchdog.maxTerminals` - Maximum number of hidden terminals before warning (default: 20)
- `watchdog.autoCleanup` - Automatically cleanup hidden terminals when threshold is exceeded (default: false)

## Root Cause

This extension addresses RULE 22 violations where spawning dozens of unreused terminals causes persistent resource contention in the VS Code extension host. Under heavy terminal load (100+ accumulated sessions), the MCP client connection becomes unstable, triggering spurious `cancel-tool-run` signals.

## How It Works

1. Monitors VS Code extension hosts and terminal processes using `pgrep`
2. Tracks all integrated terminals via VS Code API
3. Detects hidden terminals (processes without controlling TTY)
4. Sends SIGTERM for graceful shutdown, then SIGKILL if needed
5. Logs all activity to Output channel for forensic analysis

## Installation

### From Source

1. Clone the repository
2. Run `npm install`
3. Run `npm run compile`
4. Press F5 to launch extension development host

### From VSIX

1. Download the `.vsix` file
2. Run `code --install-extension hidden-terminal-watchdog-1.0.0.vsix`

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode
npm run watch

# Package extension
npm install -g @vscode/vsce
vsce package
```

## License

MIT

## Author

Created to solve terminal accumulation issues in Augment Agent workflows.

