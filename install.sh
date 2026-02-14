#!/usr/bin/env bash
# install.sh - Install Hidden Terminal Watchdog VS Code extension
set -euo pipefail

echo "=== Hidden Terminal Watchdog Installation ==="
echo "Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# Check if we're in the right directory
if [[ ! -f "package.json" ]]; then
    echo "[ERROR] package.json not found. Run this script from the extension directory."
    exit 1
fi

# Install dependencies if needed
if [[ ! -d "node_modules" ]]; then
    echo "[INFO] Installing dependencies..."
    npm install
else
    echo "[INFO] Dependencies already installed"
fi

# Compile TypeScript
echo "[INFO] Compiling TypeScript..."
npm run compile

# Check if vsce is installed
if ! command -v vsce &> /dev/null; then
    echo "[INFO] Installing @vscode/vsce globally..."
    npm install -g @vscode/vsce
fi

# Package the extension
echo "[INFO] Packaging extension..."
vsce package --allow-missing-repository --allow-star-activation

# Find the .vsix file
VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -1)

if [[ -z "$VSIX_FILE" ]]; then
    echo "[ERROR] Failed to create .vsix file"
    exit 1
fi

echo "[INFO] Created: $VSIX_FILE"

# Install the extension
echo "[INFO] Installing extension in VS Code..."
code --install-extension "$VSIX_FILE" --force

echo ""
echo "=== Installation Complete ==="
echo "Extension installed: $VSIX_FILE"
echo ""
echo "Next steps:"
echo "1. Reload VS Code window (Ctrl+Shift+P → 'Developer: Reload Window')"
echo "2. Open Output panel (Ctrl+Shift+U)"
echo "3. Select 'Hidden Terminal Watchdog' from dropdown"
echo "4. Run commands from Command Palette (Ctrl+Shift+P):"
echo "   - 'Hidden Terminal Watchdog: Show Status'"
echo "   - 'Hidden Terminal Watchdog: Force Cleanup'"
echo ""

