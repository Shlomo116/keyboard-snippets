'use strict';

const STORE_KEY = 'snippets';
const $ = (id) => document.getElementById(id);
const slugLive = (s) => s.replace(/\s+/g, '-').replace(/[/\\]+/g, '');
const slug = (s) => slugLive(s).replace(/^-+|-+$/g, '');
const uid = () => 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let snippets = [];
let trigger = '//';

function render() {
  $('badge').textContent = String(snippets.length);
  const el = $('list');
  el.textContent = '';
  if (!snippets.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = 'עדיין אין קיצורים.';
    el.appendChild(d);
    return;
  }
  const frag = document.createDocumentFragment();
  snippets
    .slice()
    .sort((a, b) => (b.uses || 0) - (a.uses || 0) || a.title.localeCompare(b.title, 'he'))
    .slice(0, 25)
    .forEach((s) => {
      const d = document.createElement('div');
      d.className = 'item';
      const b = document.createElement('b');
      b.textContent = trigger + s.title;
      const sp = document.createElement('span');
      sp.textContent = s.text.replace(/\s+/g, ' ').trim();
      d.append(b, sp);
      frag.appendChild(d);
    });
  el.appendChild(frag);
}

function toast(msg) {
  $('status').textContent = msg;
  setTimeout(() => { $('status').textContent = ''; }, 2000);
}

$('title').addEventListener('input', (e) => {
  const pos = e.target.selectionStart;
  const before = e.target.value;
  const clean = slugLive(before);
  if (clean !== before) {
    const at = Math.max(0, pos - (before.length - clean.length));
    e.target.value = clean;
    e.target.setSelectionRange(at, at);
  }
});

$('quick').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = slug($('title').value);
  const text = $('text').value;
  if (!title || !text.trim()) return;

  // קוראים מחדש כדי לא לדרוס עדכונים שקרו בזמן שהחלונית פתוחה
  chrome.storage.local.get([STORE_KEY], (res) => {
    const list = Array.isArray(res[STORE_KEY]) ? res[STORE_KEY] : [];
    if (list.some((s) => s.title.toLowerCase() === title.toLowerCase())) {
      toast('השם כבר תפוס');
      return;
    }
    list.push({ id: uid(), title, text, uses: 0, createdAt: Date.now() });
    chrome.storage.local.set({ [STORE_KEY]: list }, () => {
      snippets = list;
      $('quick').reset();
      $('title').focus();
      render();
      toast('נוסף!');
    });
  });
});

$('open').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.storage.local.get([STORE_KEY, 'settings'], (res) => {
  snippets = Array.isArray(res[STORE_KEY]) ? res[STORE_KEY] : [];
  trigger = (res.settings && res.settings.trigger) || '//';
  $('trig').textContent = trigger;
  render();
  $('title').focus();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORE_KEY]) {
    snippets = changes[STORE_KEY].newValue || [];
    render();
  }
});
