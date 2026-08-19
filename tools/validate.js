#!/usr/bin/env node
/* בדיקות לפני אריזה — נכשל ברעש, לא בחנות */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const problems = [];
const notes = [];

/* ---------- manifest ---------- */
let m;
try { m = JSON.parse(read('manifest.json')); }
catch (e) { console.error('manifest.json לא תקין:', e.message); process.exit(1); }

if (m.manifest_version !== 3) problems.push('manifest_version חייב להיות 3');
if (!/^\d+(\.\d+){0,3}$/.test(m.version)) problems.push('פורמט גרסה לא תקין: ' + m.version);
if (m.name.length > 75) problems.push(`שם ארוך מדי (${m.name.length}/75)`);
if (m.description.length > 132) problems.push(`תיאור ארוך מדי (${m.description.length}/132)`);
notes.push(`שם: ${m.name.length}/75 תווים · תיאור: ${m.description.length}/132 תווים`);

/* כל קובץ שה-manifest מפנה אליו חייב להתקיים */
const refs = [
  ...m.content_scripts.flatMap((c) => c.js || []),
  m.background && m.background.service_worker,
  m.options_page,
  m.action && m.action.default_popup,
  ...Object.values(m.icons || {}),
  ...Object.values((m.action && m.action.default_icon) || {}),
].filter(Boolean);

for (const f of new Set(refs)) {
  if (!fs.existsSync(path.join(ROOT, f))) problems.push(`ה-manifest מפנה לקובץ חסר: ${f}`);
}

/* ---------- הפניות בתוך דפי HTML ---------- */
for (const html of ['src/options.html', 'src/popup.html']) {
  const src = read(html);
  for (const ref of src.match(/(?:src|href)="([^"]+)"/g) || []) {
    const rel = ref.split('"')[1];
    if (/^(https?:|data:|#)/.test(rel)) {
      problems.push(`${html} מפנה למשאב חיצוני: ${rel} — אסור בתוסף`);
      continue;
    }
    if (!fs.existsSync(path.join(ROOT, path.dirname(html), rel))) {
      problems.push(`${html} מפנה לקובץ חסר: ${rel}`);
    }
  }
  if (/<script>[\s\S]*?<\/script>/.test(src.replace(/<script src=[^>]*><\/script>/g, ''))) {
    problems.push(`${html} מכיל סקריפט מוטבע — נחסם על ידי מדיניות התוכן של MV3`);
  }
}

/* ---------- דגלים שסוקרי החנות מחפשים ---------- */
const CODE = ['src/store.js', 'src/content.js', 'src/options.js', 'src/popup.js', 'src/background.js'];
for (const f of CODE) {
  const src = read(f);
  if (/\beval\s*\(/.test(src)) problems.push(`${f}: שימוש ב-eval`);
  if (/new\s+Function\s*\(/.test(src)) problems.push(`${f}: שימוש ב-new Function`);
  if (/\b(fetch|XMLHttpRequest|WebSocket)\b/.test(src)) problems.push(`${f}: קריאת רשת — התוסף אמור להיות מנותק`);
  if (/document\.write/.test(src)) problems.push(`${f}: שימוש ב-document.write`);
  // innerHTML מותר, אבל רק אחרי בריחה
  const unsafe = (src.match(/\.innerHTML\s*=\s*(?!.*(escapeHtml|highlight|mark\())[^;]*\$\{|\.innerHTML\s*=\s*[a-z]\w*\s*;/g) || []);
  if (unsafe.length) problems.push(`${f}: innerHTML עם ערך לא מוברח (${unsafe.length})`);
}

/* ---------- קבצי פיתוח שאסור שייכנסו לחבילה ---------- */
const DEV = ['test-page.html', 'README.md', 'PRIVACY.md', 'LICENSE', '.gitignore', 'tools', 'store', 'dist', '.git'];
notes.push('קבצי פיתוח שיוחרגו מהחבילה: ' + DEV.join(', '));

/* ---------- סיכום ---------- */
for (const n of notes) console.log('  ' + n);
if (problems.length) {
  console.error('\nנמצאו בעיות:');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('\n  ✓ הכול תקין לאריזה');
