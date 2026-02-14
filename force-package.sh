#!/bin/bash
# Force package the extension by working around vsce bugs

set -e

echo "=== FORCE PACKAGING EXTENSION ==="
echo ""

cd "$(dirname "$0")"

# Step 1: Clean build
echo "[1/5] Clean build..."
rm -rf out node_modules package-lock.json
npm install
npm run compile
echo "✓ Build complete"

# Step 2: Create package directory structure manually
echo "[2/5] Creating package structure..."
PACKAGE_DIR="package-temp"
rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR/out"

# Copy files
cp package.json "$PACKAGE_DIR/"
cp -r out/* "$PACKAGE_DIR/out/"
cp README.md "$PACKAGE_DIR/" 2>/dev/null || echo "README.md not found, skipping"
cp CHANGELOG.md "$PACKAGE_DIR/" 2>/dev/null || echo "CHANGELOG.md not found, skipping"
cp LICENSE "$PACKAGE_DIR/" 2>/dev/null || echo "LICENSE not found, skipping"

echo "✓ Package structure created"

# Step 3: Create VSIX manually using zip
echo "[3/5] Creating VSIX archive..."
cd "$PACKAGE_DIR"

# Create extension.vsixmanifest
cat > extension.vsixmanifest << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="hidden-terminal-watchdog" Version="1.0.0" Publisher="prf-compliance"/>
    <DisplayName>Hidden Terminal Watchdog</DisplayName>
    <Description>Monitors and cleans up hidden VS Code terminals</Description>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="package.json"/>
  </Assets>
</PackageManifest>
EOF

# Create [Content_Types].xml
cat > '[Content_Types].xml' << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
EOF

# Create extension directory
mkdir -p extension
cp package.json extension/
cp -r out extension/

# Create zip
zip -r ../hidden-terminal-watchdog-1.0.0.vsix . -x "*.git*"

cd ..
rm -rf "$PACKAGE_DIR"

echo "✓ VSIX created: hidden-terminal-watchdog-1.0.0.vsix"

# Step 4: Install the extension
echo "[4/5] Installing extension..."
code --install-extension hidden-terminal-watchdog-1.0.0.vsix --force

echo "✓ Extension installed"

# Step 5: Verify installation
echo "[5/5] Verifying installation..."
code --list-extensions | grep hidden-terminal-watchdog && echo "✓ Extension verified" || echo "✗ Extension not found"

echo ""
echo "=== INSTALLATION COMPLETE ==="
echo ""
echo "To test the extension:"
echo "1. Restart VS Code (or reload window: Ctrl+Shift+P > 'Reload Window')"
echo "2. Press Ctrl+Shift+P"
echo "3. Type: 'Hidden Terminal Watchdog: Show Status'"
echo "4. Check Output panel (View > Output > 'Hidden Terminal Watchdog')"
echo ""

