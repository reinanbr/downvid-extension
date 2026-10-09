#!/usr/bin/env bash
# Builds the installable packages into dist/:
#   downvid-extension-chrome.zip   Chrome, Edge, Brave, Opera (unpack and
#                                  "Load unpacked", or upload to a store)
#   downvid-extension-firefox.zip  Firefox 128+ (web-ext build)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json', 'utf8')).version)")
FILES=(manifest.json _locales icons src popup options LICENSE)

rm -rf dist
mkdir -p dist
zip -qr dist/downvid-extension-chrome.zip "${FILES[@]}" -x '*.DS_Store'
npx --no-install web-ext build --source-dir . --artifacts-dir dist \
  --filename downvid-extension-firefox.zip --overwrite-dest >/dev/null
echo "DownVid $VERSION:"
ls -l dist
