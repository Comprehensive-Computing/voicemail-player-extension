#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dist_root="$root/dist"
target="$dist_root/firefox"
archive="$dist_root/firefox.xpi"

rm -rf "$target"
rm -f "$archive"

mkdir -p \
  "$target/img" \
  "$target/src/shared" \
  "$target/src/vendor/ffmpeg" \
  "$target/src/vendor/ffmpeg-core"

cp "$root/manifest.firefox.json" "$target/manifest.json"
cp "$root/LICENSE" "$target/LICENSE"
cp "$root/img/Voicemail-Player-Extension-Icon-32x32.png" "$target/img/Voicemail-Player-Extension-Icon-32x32.png"
cp "$root/img/Voicemail-Player-Extension-Icon-64x64.png" "$target/img/Voicemail-Player-Extension-Icon-64x64.png"
cp "$root/img/Voicemail-Player-Extension-Icon-128x128.png" "$target/img/Voicemail-Player-Extension-Icon-128x128.png"
cp "$root/img/Voicemail-Player-Extension-Icon-256x256.png" "$target/img/Voicemail-Player-Extension-Icon-256x256.png"
cp "$root/src/background.js" "$target/src/background.js"
cp "$root/src/browser-api.js" "$target/src/browser-api.js"
cp "$root/src/content-script.js" "$target/src/content-script.js"
cp "$root/src/offscreen.html" "$target/src/offscreen.html"
cp "$root/src/offscreen.js" "$target/src/offscreen.js"
cp "$root/src/page-proxy.js" "$target/src/page-proxy.js"
cp "$root/src/shared/ffmpeg-transcode.js" "$target/src/shared/ffmpeg-transcode.js"
cp "$root/src/shared/wav.js" "$target/src/shared/wav.js"
cp "$root/node_modules/@ffmpeg/ffmpeg/dist/esm/classes.js" "$target/src/vendor/ffmpeg/classes.js"
cp "$root/node_modules/@ffmpeg/ffmpeg/dist/esm/const.js" "$target/src/vendor/ffmpeg/const.js"
cp "$root/node_modules/@ffmpeg/ffmpeg/dist/esm/errors.js" "$target/src/vendor/ffmpeg/errors.js"
cp "$root/node_modules/@ffmpeg/ffmpeg/dist/esm/index.js" "$target/src/vendor/ffmpeg/index.js"
cp "$root/node_modules/@ffmpeg/ffmpeg/dist/esm/types.js" "$target/src/vendor/ffmpeg/types.js"
cp "$root/node_modules/@ffmpeg/ffmpeg/dist/esm/utils.js" "$target/src/vendor/ffmpeg/utils.js"
cp "$root/node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js" "$target/src/vendor/ffmpeg/worker.js"
cp "$root/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js" "$target/src/vendor/ffmpeg-core/ffmpeg-core.js"
cp "$root/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm" "$target/src/vendor/ffmpeg-core/ffmpeg-core.wasm"

if command -v zip >/dev/null 2>&1; then
  (
    cd "$target"
    zip -qr "$archive" .
  )
elif command -v 7z >/dev/null 2>&1; then
  (
    cd "$target"
    7z a -tzip "$archive" . >/dev/null
  )
else
  echo "Error: zip or 7z is required to create $archive" >&2
  exit 1
fi

echo "Firefox build ready at $target"
echo "Firefox package ready at $archive"
