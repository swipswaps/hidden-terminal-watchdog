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

### Quick Install (Recommended)

```bash
cd hidden-terminal-watchdog
./force-package.sh
```

This script will:
1. Clean build the extension
2. Create a VSIX package
3. Install it automatically
4. Verify installation

After installation, **reload VS Code** (Ctrl+Shift+P → "Reload Window")

### Manual Installation

```bash
# Build the extension
npm install
npm run compile

# Package and install
./force-package.sh

# Or install manually
code --install-extension hidden-terminal-watchdog-1.0.0.vsix --force
```

## Usage

### Commands

Open Command Palette (Ctrl+Shift+P):

- **`Hidden Terminal Watchdog: Show Status`** - Display current terminal count and hidden processes
- **`Hidden Terminal Watchdog: Force Cleanup`** - Manually kill all hidden terminals

### Log File Location

Logs are written to VS Code's global storage:

```
~/.config/Code/User/globalStorage/prf-compliance.hidden-terminal-watchdog/watchdog.log
```

### Example Output

```
[2026-02-14T23:33:54.228Z] === Hidden Terminal Watchdog Activated ===
[2026-02-14T23:34:02.723Z] [INFO] Terminal opened: augment-bash-test (tracked: 1)
[2026-02-14T23:34:03.775Z] [INFO] Terminal closed: augment-bash-test (tracked: 0)
[2026-02-14T23:34:54.231Z] [HEARTBEAT] Watchdog active. Tracked: 0, Last hidden: 0
[2026-02-14T23:35:54.231Z] [HEARTBEAT] Watchdog active. Tracked: 2, Last hidden: 0 | Events (60s): 2 opened, 1 closed, 1 monitor | Recent: [45s ago] [INFO] Terminal opened: bash (tracked: 1); [30s ago] [INFO] Terminal opened: zsh (tracked: 2); [15s ago] [MONITOR] Detected 0 hidden terminals/processes
```

**Heartbeat Features:**
- Shows current tracked terminals and last hidden count
- Summarizes events in the last 60 seconds by type (opened, closed, monitor, cleanup, warnings, system)
- Displays the last 3 event messages with timestamps
- Helps diagnose terminal accumulation patterns and MCP instability

## Troubleshooting

### Extension Not Activating

1. Check Output panel: View → Output → "Hidden Terminal Watchdog"
2. Verify installation: `code --list-extensions | grep hidden-terminal-watchdog`
3. Reload window: Ctrl+Shift+P → "Reload Window"

### Commands Not Appearing

1. Ensure extension is installed: `code --list-extensions`
2. Check for activation errors in Output panel
3. Reinstall: `./force-package.sh`

## Development

### Build from Source

```bash
git clone https://github.com/swipswaps/hidden-terminal-watchdog.git
cd hidden-terminal-watchdog
npm install
npm run compile
```

### Project Structure

```
hidden-terminal-watchdog/
├── src/
│   └── extension.ts          # Main extension code
├── out/
│   └── extension.js          # Compiled output
├── package.json              # Extension manifest
├── tsconfig.json             # TypeScript config
├── force-package.sh          # Build and install script
└── README.md                 # This file
```

## License

MIT

## Credits

Created to solve RULE 22 violations in the Augment VSCode extension forensic investigation.

## Links

- **GitHub**: https://github.com/swipswaps/hidden-terminal-watchdog
- **Issues**: https://github.com/swipswaps/hidden-terminal-watchdog/issues

