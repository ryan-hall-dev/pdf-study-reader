#!/bin/bash
# Creates "PDF to Audio Book.app" on the Desktop. Double-clicking it runs this
# project from its .venv. Re-run this script if you move the project folder.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Desktop/PDF to Audio Book.app"

if [ ! -x "$PROJECT/.venv/bin/python" ]; then
  echo "No .venv found in $PROJECT. Create it first (see README.md)." >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>PDF to Audio Book</string>
  <key>CFBundleDisplayName</key><string>PDF to Audio Book</string>
  <key>CFBundleIdentifier</key><string>local.ryan.pdf-to-audiobook</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

cat > "$APP/Contents/MacOS/launcher" <<EOF
#!/bin/bash
cd "$PROJECT"
exec "$PROJECT/.venv/bin/python" "$PROJECT/app.py" >> "$PROJECT/app.log" 2>&1
EOF
chmod +x "$APP/Contents/MacOS/launcher"

if [ -f "$PROJECT/assets/AppIcon.icns" ]; then
  cp "$PROJECT/assets/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
fi

touch "$APP"  # make Finder pick up the icon
echo "Created: $APP"
