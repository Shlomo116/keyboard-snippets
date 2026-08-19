'use strict';

const $ = (id) => document.getElementById(id);
const slugLive = (s) => s.replace(/\s+/g, '-').replace(/[/\\]+/g, '');
const slug = (s) => slugLive(s).replace(/^-+|-+$/g, '');
const uid = () => SnippetStore.uid();

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

$('quick').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = slug($('title').value);
  const text = $('text').value;
  if (!title || !text.trim()) return;

  // קוראים מחדש כדי לא להתנגש בעריכה שקרתה במכשיר אחר בזמן שהחלונית פתוחה
  const list = await SnippetStore.getAll();
  if (list.some((s) => s.title.toLowerCase() === title.toLowerCase())) {
    toast('השם כבר תפוס');
    return;
  }
  try {
    await SnippetStore.put({ id: uid(), title, text });
    snippets = await SnippetStore.getAll();
    $('quick').reset();
    $('title').focus();
    render();
    toast('נוסף!');
  } catch (err) {
    toast(err.kind === 'ITEM_TOO_BIG' ? 'ההודעה ארוכה מדי' : 'נגמר מקום הסנכרון');
  }
});

$('open').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

(async () => {
  const [list, settings] = await Promise.all([SnippetStore.getAll(), SnippetStore.getSettings()]);
  snippets = list;
  trigger = settings.trigger || '//';
  $('trig').textContent = trigger;
  render();
  $('title').focus();
})();

SnippetStore.onSnippetsChanged(async () => {
  snippets = await SnippetStore.getAll();
  render();
});
