#!/usr/bin/env bash
#
# אריזת התוסף להעלאה לחנות של גוגל.
# מפיק dist/keyboard-snippets-<version>.zip שמכיל רק את מה שרץ בפועל.
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "בדיקות לפני אריזה:"
node tools/validate.js

VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/keyboard-snippets-${VERSION}.zip"

rm -rf dist .pkg
mkdir -p dist .pkg

# רק הקבצים שהתוסף צריך בזמן ריצה
cp manifest.json .pkg/
cp -R src icons .pkg/
find .pkg -name '.DS_Store' -delete
find .pkg -name '*.map' -delete

(cd .pkg && zip -qr -X "../${OUT}" .)
rm -rf .pkg

echo
echo "נארז: ${OUT}  ($(du -h "${OUT}" | cut -f1))"
echo
echo "תוכן החבילה:"
unzip -Z1 "${OUT}" | sort | sed 's/^/  /'
