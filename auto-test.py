#!/usr/bin/env python3
"""Automated VS Code extension testing using pyautogui"""

import subprocess
import time
import sys
import os

os.environ['DISPLAY'] = ':0'

def run_cmd(cmd):
    """Run command and return output"""
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout.strip(), result.stderr.strip(), result.returncode

def find_vscode_window():
    """Find VS Code window ID"""
    stdout, _, _ = run_cmd("xdotool search --class 'code' | head -1")
    return stdout.strip()

def activate_window(window_id):
    """Activate window"""
    run_cmd(f"xdotool windowactivate {window_id}")
    time.sleep(0.5)

def send_keys(keys):
    """Send keyboard input"""
    run_cmd(f"xdotool key {keys}")
    time.sleep(0.5)

def type_text(text):
    """Type text"""
    run_cmd(f"xdotool type '{text}'")
    time.sleep(0.5)

def main():
    print("=== Automated Extension Test ===\n")
    
    # Step 1: Find VS Code
    print("[1/6] Finding VS Code window...")
    vscode_win = find_vscode_window()
    if not vscode_win:
        print("ERROR: VS Code not found")
        return 1
    print(f"✓ VS Code window: {vscode_win}")
    
    # Step 2: Activate VS Code
    print("[2/6] Activating VS Code...")
    activate_window(vscode_win)
    
    # Step 3: Open Run view (Ctrl+Shift+D)
    print("[3/6] Opening Run view...")
    send_keys("ctrl+shift+d")
    time.sleep(1)
    
    # Step 4: Start debugging (F5)
    print("[4/6] Starting debugger (F5)...")
    send_keys("F5")
    time.sleep(5)
    
    # Step 5: Check for Extension Development Host
    print("[5/6] Checking for Extension Development Host...")
    stdout, _, _ = run_cmd("xdotool search --name 'Extension Development Host' 2>/dev/null | head -1")
    ext_host_win = stdout.strip()
    
    if ext_host_win:
        print(f"✓ Extension Development Host launched: {ext_host_win}")
        
        # Step 6: Test command
        print("[6/6] Testing extension command...")
        activate_window(ext_host_win)
        time.sleep(1)
        
        # Open command palette
        send_keys("ctrl+shift+p")
        time.sleep(1)
        
        # Type command
        type_text("Hidden Terminal Watchdog: Show Status")
        time.sleep(1)
        
        # Execute
        send_keys("Return")
        time.sleep(2)
        
        print("\n✓ TEST COMPLETE")
        print("Check Output panel (View > Output) for extension logs")
        return 0
    else:
        print("✗ Extension Development Host did not launch")
        print("\nDEBUG: Trying alternative method...")
        
        # Alternative: Use menu
        activate_window(vscode_win)
        send_keys("alt+r")  # Run menu
        time.sleep(1)
        send_keys("s")  # Start Debugging
        time.sleep(5)
        
        stdout, _, _ = run_cmd("xdotool search --name 'Extension Development Host' 2>/dev/null | head -1")
        if stdout.strip():
            print("✓ Extension launched via menu")
            return 0
        else:
            print("✗ Failed to launch extension")
            return 1

if __name__ == "__main__":
    sys.exit(main())

