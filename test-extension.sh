#!/bin/bash
# Automated extension testing script using xdotool

set -e

export DISPLAY=:0

echo "=== Automated Extension Test ==="
echo ""

# Step 1: Find VS Code window
echo "[1/5] Finding VS Code window..."
VSCODE_WINDOW=$(xdotool search --class "code" | head -1)
if [ -z "$VSCODE_WINDOW" ]; then
    echo "ERROR: VS Code window not found"
    exit 1
fi
echo "✓ Found VS Code window: $VSCODE_WINDOW"

# Step 2: Activate window
echo "[2/5] Activating VS Code window..."
xdotool windowactivate $VSCODE_WINDOW
sleep 1

# Step 3: Try F5 first
echo "[3/5] Attempting F5 to launch debugger..."
xdotool key F5
sleep 3

# Step 4: Check if Extension Development Host opened
echo "[4/5] Checking for Extension Development Host..."
EXT_HOST=$(xdotool search --name "Extension Development Host" 2>/dev/null | head -1)

if [ -n "$EXT_HOST" ]; then
    echo "✓ Extension Development Host launched successfully!"
    echo "✓ Window ID: $EXT_HOST"
    
    # Step 5: Test the extension commands
    echo "[5/5] Testing extension commands..."
    xdotool windowactivate $EXT_HOST
    sleep 1
    
    # Open command palette
    xdotool key ctrl+shift+p
    sleep 1
    
    # Type command
    xdotool type "Hidden Terminal Watchdog: Show Status"
    sleep 1
    
    # Execute
    xdotool key Return
    sleep 2
    
    echo "✓ Command executed"
    echo ""
    echo "=== TEST COMPLETE ==="
    echo "Check the Output panel in VS Code for extension logs"
    
else
    echo "✗ Extension Development Host did not launch"
    echo ""
    echo "Manual steps required:"
    echo "1. In VS Code, click 'Run' menu"
    echo "2. Click 'Start Debugging'"
    echo "OR"
    echo "1. Click the Run icon in the left sidebar (play icon with bug)"
    echo "2. Click the green play button at the top"
    exit 1
fi

