#!/bin/sh
# Regenerates assets/macos/dmg-layout.DS_Store, the window layout of the DMG
# (see scripts/make-dmg.js and docs/release.md). Local only: it drives Finder,
# which CI never does.
#
# The view holds an alias to .background/dmg-background.tiff. Finder writes the
# volume name and the path of the disk image into that alias, so the image is
# built under a neutral path and with the real volume name. Eject every other
# "Snotra Agent" volume first, or Finder mixes them up.
#
# Usage: sh scripts/make-dmg-layout.sh   (asks Finder for automation access once)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=/tmp/snotra-dmg-layout
VOLUME="Snotra Agent"

if [ -d "/Volumes/$VOLUME" ]; then
  echo "Eject /Volumes/$VOLUME first." >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK/stage/.background" "$WORK/stage/$VOLUME.app"
cp "$ROOT/assets/macos/dmg-background.tiff" "$WORK/stage/.background/"
cp "$ROOT/icon.icns" "$WORK/stage/.VolumeIcon.icns"
ln -s /Applications "$WORK/stage/Applications"
hdiutil create -quiet -srcfolder "$WORK/stage" -volname "$VOLUME" -fs HFS+ \
  -format UDRW -size 20m -ov "$WORK/layout.dmg"
hdiutil attach -quiet "$WORK/layout.dmg" -readwrite -noautoopen

# The app and Applications sit on one line, the arrow in dmg-background.svg is
# drawn between them at the same height. The hidden files are placed below the
# window so they stay out of sight when Finder shows hidden files.
osascript <<EOF
tell application "Finder"
  tell disk "$VOLUME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 740, 480}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set text size of opts to 13
    set background picture of opts to file ".background:dmg-background.tiff"
    set position of item "$VOLUME.app" of container window to {140, 160}
    set position of item "Applications" of container window to {400, 160}
    set position of item ".background" of container window to {140, 560}
    set position of item ".VolumeIcon.icns" of container window to {400, 560}
    update without registering applications
    delay 1
    close
  end tell
end tell
EOF

sleep 2
sync
cp "/Volumes/$VOLUME/.DS_Store" "$ROOT/assets/macos/dmg-layout.DS_Store"
hdiutil detach -quiet "/Volumes/$VOLUME"
rm -rf "$WORK"
echo "Layout written: assets/macos/dmg-layout.DS_Store"
