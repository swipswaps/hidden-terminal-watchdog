# Installation Guide

## Quick Start

### 1. Install Dependencies

```bash
cd hidden-terminal-watchdog
npm install
```

### 2. Compile TypeScript

```bash
npm run compile
```

### 3. Test in Development Mode

Press `F5` in VS Code to launch the Extension Development Host with the extension loaded.

### 4. Package for Distribution

```bash
# Install vsce if not already installed
npm install -g @vscode/vsce

# Package the extension
vsce package
```

This creates `hidden-terminal-watchdog-1.0.0.vsix`

### 5. Install the Extension

```bash
code --install-extension hidden-terminal-watchdog-1.0.0.vsix
```

Or in VS Code:
1. Open Command Palette (`Ctrl+Shift+P`)
2. Run `Extensions: Install from VSIX...`
3. Select the `.vsix` file

## Usage

### Commands

Open Command Palette (`Ctrl+Shift+P`) and run:

- **Hidden Terminal Watchdog: Show Status** - View current terminal status
- **Hidden Terminal Watchdog: Force Cleanup** - Cleanup all hidden terminals

### Output Channel

View logs in the Output panel:
1. Open Output panel (`Ctrl+Shift+U`)
2. Select "Hidden Terminal Watchdog" from dropdown

### Configuration

Open Settings (`Ctrl+,`) and search for "watchdog":

- `watchdog.monitorInterval` - How often to check (default: 5000ms)
- `watchdog.maxTerminals` - Warning threshold (default: 20)
- `watchdog.autoCleanup` - Auto-cleanup when threshold exceeded (default: false)

## Troubleshooting

### Extension Not Activating

Check the Output channel for errors. The extension activates on VS Code startup (`activationEvents: ["*"]`).

### No Hidden Terminals Detected

This is good! It means no terminal accumulation is happening. The extension only detects:
- VS Code extension host processes
- VS Code terminal processes with `--ms-enable-electron-run-as-node`

### Permission Errors

The extension uses `pgrep` and `kill` commands which require appropriate permissions. Make sure you're running VS Code with sufficient privileges to manage your own processes.

## Platform Support

Currently supports **Linux only** (uses `/proc` filesystem and `pgrep`).

Future versions may add support for macOS and Windows.

## Development

### Watch Mode

```bash
npm run watch
```

This automatically recompiles TypeScript on file changes.

### Debugging

1. Open the project in VS Code
2. Press `F5` to launch Extension Development Host
3. Set breakpoints in `src/extension.ts`
4. Trigger commands to hit breakpoints

## Uninstall

```bash
code --uninstall-extension prf-compliance.hidden-terminal-watchdog
```

Or in VS Code:
1. Open Extensions view (`Ctrl+Shift+X`)
2. Find "Hidden Terminal Watchdog"
3. Click Uninstall

