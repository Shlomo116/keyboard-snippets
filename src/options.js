'use strict';

const STORE_KEY = 'snippets';
const SETTINGS_KEY = 'settings';

const $ = (id) => document.getElementById(id);
const form = $('form'), titleEl = $('title'), textEl = $('text');
const itemsEl = $('items'), emptyEl = $('empty'), emptyText = $('emptyText');
const searchEl = $('search'), sortEl = $('sort'), statusEl = $('status');
const cancelBtn = $('cancelBtn'), editorTitle = $('editorTitle'), saveBtn = $('saveBtn');

let snippets = [];
let editingId = null;
let statusTimer = 0;

/* ---------- עזרים ---------- */
// בזמן הקלדה: לא חותכים מקפים בקצוות, אחרת אי אפשר להקליד שם מרובה מילים
const slugLive = (s) => s.replace(/\s+/g, '-').replace(/[/\\]+/g, '');
// בשמירה: מנקים גם את הקצוות
const slug = (s) => slugLive(s).replace(/^-+|-+$/g, '');
const uid = () => 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const save = () => new Promise((res) => chrome.storage.local.set({ [STORE_KEY]: snippets }, res));

function toast(msg) {
  statusEl.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 2400);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mark(text, q) {
  if (!q) return escapeHtml(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, i)) +
    '<mark>' + escapeHtml(text.slice(i, i + q.length)) + '</mark>' +
    escapeHtml(text.slice(i + q.length));
}

function relTime(ts) {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return 'היום';
  if (d === 1) return 'אתמול';
  if (d < 30) return 'לפני ' + d + ' ימים';
  return 'לפני ' + Math.floor(d / 30) + ' חודשים';
}

/* ---------- רינדור ---------- */
function render() {
  const q = searchEl.value.trim().toLowerCase();
  const sortBy = sortEl.value;

  const list = snippets.filter((s) =>
    !q || s.title.toLowerCase().includes(q) || s.text.toLowerCase().includes(q)
  );

  list.sort((a, b) => {
    if (sortBy === 'title') return a.title.localeCompare(b.title, 'he');
    if (sortBy === 'new') return (b.createdAt || 0) - (a.createdAt || 0);
    return (b.uses || 0) - (a.uses || 0) || a.title.localeCompare(b.title, 'he');
  });

  $('statCount').textContent = String(snippets.length);
  $('statUses').textContent = String(snippets.reduce((n, s) => n + (s.uses || 0), 0));

  itemsEl.textContent = '';
  emptyEl.hidden = list.length > 0;
  $('seedBtn').hidden = snippets.length > 0;
  emptyText.textContent = q
    ? 'אין תוצאות עבור "' + searchEl.value.trim() + '".'
    : 'עדיין אין קיצורים. הוסיפו את הראשון בטופס שמימין.';

  const frag = document.createDocumentFragment();
  for (const s of list) {
    const li = document.createElement('li');
    if (s.id === editingId) li.className = 'editing';

    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('div');
    name.className = 'name';
    name.innerHTML = escapeHtml(settings.trigger) + mark(s.title, q);
    const snip = document.createElement('div');
    snip.className = 'snippet';
    snip.textContent = s.text;
    body.append(name, snip);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = (s.uses || 0) + ' שימושים' + (s.lastUsed ? ' · ' + relTime(s.lastUsed) : '');

    const btns = document.createElement('div');
    btns.className = 'btns';
    btns.append(
      mkBtn('עריכה', '', () => startEdit(s)),
      mkBtn('שכפול', '', () => duplicate(s)),
      mkBtn('מחיקה', 'del', () => remove(s)),
    );

    li.append(body, meta, btns);
    frag.appendChild(li);
  }
  itemsEl.appendChild(frag);
}

function mkBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  if (cls) b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/* ---------- פעולות ---------- */
function uniqueTitle(base) {
  let t = base, n = 2;
  while (snippets.some((s) => s.title.toLowerCase() === t.toLowerCase())) t = base + '-' + n++;
  return t;
}

async function duplicate(s) {
  snippets.push({
    id: uid(), title: uniqueTitle(s.title + '-עותק'), text: s.text,
    uses: 0, createdAt: Date.now(),
  });
  await save();
  render();
  toast('שוכפל');
}

async function remove(s) {
  if (!confirm('למחוק את הקיצור ' + settings.trigger + s.title + '?')) return;
  snippets = snippets.filter((x) => x.id !== s.id);
  if (editingId === s.id) resetForm();
  await save();
  render();
  toast('נמחק');
}

function startEdit(s) {
  editingId = s.id;
  titleEl.value = s.title;
  textEl.value = s.text;
  editorTitle.textContent = 'עריכת ' + settings.trigger + s.title;
  saveBtn.textContent = 'עדכון';
  cancelBtn.hidden = false;
  render();
  titleEl.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetForm() {
  editingId = null;
  form.reset();
  editorTitle.textContent = 'קיצור חדש';
  saveBtn.textContent = 'שמירה';
  cancelBtn.hidden = true;
  render();
}

/* ---------- טופס ---------- */
titleEl.addEventListener('input', () => {
  const pos = titleEl.selectionStart;
  const before = titleEl.value;
  const clean = slugLive(before);
  if (clean !== before) {
    const at = Math.max(0, pos - (before.length - clean.length));
    titleEl.value = clean;
    titleEl.setSelectionRange(at, at);
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = slug(titleEl.value);
  const text = textEl.value;
  if (!title) { toast('נדרשת כותרת'); titleEl.focus(); return; }
  if (!text.trim()) { toast('נדרש תוכן'); textEl.focus(); return; }

  const clash = snippets.find((s) => s.title.toLowerCase() === title.toLowerCase() && s.id !== editingId);
  if (clash) { toast('כבר קיים קיצור בשם הזה'); titleEl.focus(); titleEl.select(); return; }

  if (editingId) {
    const s = snippets.find((x) => x.id === editingId);
    if (!s) { toast('הקיצור כבר לא קיים'); resetForm(); return; }
    Object.assign(s, { title, text, updatedAt: Date.now() });
    toast('עודכן');
  } else {
    snippets.push({ id: uid(), title, text, uses: 0, createdAt: Date.now() });
    toast('נוסף — נסו ' + settings.trigger + title);
  }
  await save();
  resetForm();
  titleEl.focus();
});

cancelBtn.addEventListener('click', resetForm);
searchEl.addEventListener('input', render);
sortEl.addEventListener('change', render);

textEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editingId) resetForm();
  if (e.key === '/' && e.target === document.body) { e.preventDefault(); searchEl.focus(); }
});

/* ---------- הגדרות ---------- */
let settings = { enabled: true, trigger: '//' };

// מיזוג ולא דריסה: כתיבה של שדה אחד לא אמורה למחוק את השני
function saveSettings(patch) {
  settings = Object.assign({}, settings, patch);
  chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

function applySettingsToUI() {
  $('enabled').checked = settings.enabled !== false;
  $('trigger').value = settings.trigger;
  $('prefix').textContent = settings.trigger;
}

$('enabled').addEventListener('change', (e) => {
  saveSettings({ enabled: e.target.checked });
  toast(e.target.checked ? 'התוסף הופעל' : 'התוסף כובה');
});

$('trigger').addEventListener('change', (e) => {
  saveSettings({ trigger: e.target.value });
  $('prefix').textContent = e.target.value;
  render();
  toast('הפתיחה שונתה ל־' + e.target.value);
});

/* ---------- ייצוא / ייבוא / איפוס ---------- */
$('exportBtn').addEventListener('click', () => {
  if (!snippets.length) return toast('אין מה לייצא');
  const payload = { version: 1, exportedAt: new Date().toISOString(), snippets };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'snippets-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('יוצא קובץ');
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = Array.isArray(parsed) ? parsed : parsed.snippets;
    if (!Array.isArray(incoming)) throw new Error('bad format');
    let added = 0, skipped = 0;
    for (const raw of incoming) {
      const title = slug(String(raw && raw.title || ''));
      const text = String(raw && raw.text || '');
      if (!title || !text) { skipped++; continue; }
      if (snippets.some((s) => s.title.toLowerCase() === title.toLowerCase())) { skipped++; continue; }
      snippets.push({ id: uid(), title, text, uses: Number(raw.uses) || 0, createdAt: Date.now() });
      added++;
    }
    await save();
    render();
    toast('יובאו ' + added + ' קיצורים' + (skipped ? ' (' + skipped + ' דולגו)' : ''));
  } catch (_) {
    toast('קובץ לא תקין');
  }
});

$('clearBtn').addEventListener('click', async () => {
  if (!snippets.length) return toast('אין מה למחוק');
  if (!confirm('למחוק את כל ' + snippets.length + ' הקיצורים? הפעולה בלתי הפיכה.')) return;
  snippets = [];
  resetForm();
  await save();
  render();
  toast('הכול נמחק');
});

$('seedBtn').addEventListener('click', async () => {
  const seed = [
    { title: 'תודה', text: 'תודה רבה על פנייתך! נחזור אליך בהקדם האפשרי.' },
    { title: 'פרטים', text: 'כדי שנוכל להתקדם, נשמח לקבל:\n1. שם מלא\n2. מספר טלפון\n3. תיאור קצר של הבקשה' },
    { title: 'סגירה', text: 'הפנייה שלך טופלה ונסגרה. אם נותרה שאלה פתוחה — אנחנו כאן.' },
  ];
  for (const s of seed) {
    if (snippets.some((x) => x.title === s.title)) continue;
    snippets.push({ id: uid(), ...s, uses: 0, createdAt: Date.now() });
  }
  await save();
  render();
  toast('נוספו קיצורים לדוגמה');
});

/* ---------- אתחול + סנכרון בין לשוניות ---------- */
chrome.storage.local.get([STORE_KEY, SETTINGS_KEY], (res) => {
  snippets = Array.isArray(res[STORE_KEY]) ? res[STORE_KEY] : [];
  settings = Object.assign(settings, res[SETTINGS_KEY] || {});
  const known = Array.from($('trigger').options).some((o) => o.value === settings.trigger);
  if (!known) settings.trigger = '//';
  applySettingsToUI();
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORE_KEY]) {
    snippets = changes[STORE_KEY].newValue || [];
    if (editingId && !snippets.some((s) => s.id === editingId)) resetForm();
    else render();
  }
  if (changes[SETTINGS_KEY]) {
    settings = Object.assign(settings, changes[SETTINGS_KEY].newValue || {});
    applySettingsToUI();
    render();
  }
});
