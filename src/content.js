/* ---------------------------------------------------------------
 *  קיצורי הקלדה — content script
 *  מזהה "//" בכל שדה עריכה בדף, מציג תפריט חיפוש ומדביק את הטקסט.
 * --------------------------------------------------------------- */
(() => {
  'use strict';
  if (window.__snippetsTriggerLoaded) return;
  window.__snippetsTriggerLoaded = true;

  const STORE_KEY = 'snippets';
  const SETTINGS_KEY = 'settings';
  const MAX_QUERY = 40;
  const MAX_RESULTS = 50;
  const ZWSP = '\u200b'; // zero-width space

  /* אינדקס חיפוש: המחרוזות מומרות ל-lowercase פעם אחת בטעינה, לא בכל הקשה */
  let index = [];
  let settings = { enabled: true };

  const alive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  };

  function buildIndex(list) {
    index = (Array.isArray(list) ? list : []).map((s) => ({
      s,
      titleLc: String(s.title || '').toLowerCase(),
      textLc: String(s.text || '').toLowerCase(),
    }));
  }

  if (alive()) {
    chrome.storage.local.get([STORE_KEY, SETTINGS_KEY], (res) => {
      if (chrome.runtime.lastError) return;
      buildIndex(res[STORE_KEY]);
      if (res[SETTINGS_KEY]) settings = Object.assign(settings, res[SETTINGS_KEY]);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORE_KEY]) buildIndex(changes[STORE_KEY].newValue);
      if (changes[SETTINGS_KEY]) settings = Object.assign(settings, changes[SETTINGS_KEY].newValue || {});
    });
  }

  /* ---------- מצב התפריט ---------- */
  const state = {
    open: false,
    target: null,   // האלמנט שבו מקלידים
    kind: null,     // 'input' | 'ce'
    node: null,     // contenteditable: צומת הטקסט
    sel: null,      // contenteditable: אובייקט ה-Selection הרלוונטי
    start: 0,       // אינדקס תחילת ה-//
    query: '',
    items: [],
    index: 0,
    key: '',        // חתימת הרשימה המוצגת - כדי לא לבנות DOM מחדש לחינם
  };
  let busy = false; // מונע לולאות בזמן שאנחנו עצמנו נוגעים בסלקשן

  /* ---------- זיהוי שדות עריכה ---------- */
  /* רק טיפוסים שתומכים ב-Selection API. email/number זורקים InvalidStateError בכרום. */
  const SELECTABLE_INPUTS = new Set(['text', 'search', 'url', 'tel']);

  function editableKind(el) {
    if (!el) return null;
    if (el.tagName === 'TEXTAREA') return el.readOnly || el.disabled ? null : 'input';
    if (el.tagName === 'INPUT') {
      if (el.readOnly || el.disabled) return null;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return SELECTABLE_INPUTS.has(type) ? 'input' : null; // סיסמאות מוחרגות מעצם ההגדרה
    }
    if (el.isContentEditable) return 'ce';
    return null;
  }

  function activeEditable() {
    let el = document.activeElement;
    let guard = 0;
    while (el && el.shadowRoot && el.shadowRoot.activeElement && guard++ < 10) {
      el = el.shadowRoot.activeElement;
    }
    const kind = editableKind(el);
    return kind ? { el, kind } : null;
  }

  function selectionFor(el) {
    const rootNode = el.getRootNode();
    if (rootNode && typeof rootNode.getSelection === 'function') {
      const s = rootNode.getSelection();
      if (s) return s;
    }
    return window.getSelection();
  }

  /* ---------- קריאת הטקסט שלפני הסמן ---------- */
  function readContext() {
    const active = activeEditable();
    if (!active) return null;
    const { el, kind } = active;

    if (kind === 'input') {
      let caret;
      try { caret = el.selectionStart; } catch (_) { return null; }
      if (caret === null || caret !== el.selectionEnd) return null;
      return { el, kind, before: el.value.slice(0, caret), caret, node: null, sel: null };
    }

    const sel = selectionFor(el);
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    if (!el.contains(node)) return null;
    const offset = sel.anchorOffset;
    return { el, kind, before: node.textContent.slice(0, offset), caret: offset, node, sel };
  }

  // "//" בתחילת שורה או אחרי רווח/פיסוק - כך ש-http:// לא מפעיל את התפריט
  const TRIGGER_RE = /(^|[\s([{"'’“<>\-–—,;!?])\/\/(\S*)$/;

  function detect() {
    if (!settings.enabled) return null;
    const ctx = readContext();
    if (!ctx) return null;
    const m = TRIGGER_RE.exec(ctx.before);
    if (!m) return null;
    const query = m[2];
    if (query.length > MAX_QUERY || query.startsWith('/')) return null;
    return {
      el: ctx.el, kind: ctx.kind, node: ctx.node, sel: ctx.sel, caret: ctx.caret,
      start: m.index + m[1].length,
      query,
    };
  }

  /* ---------- חיפוש ודירוג ---------- */
  function subsequenceScore(hay, needle) {
    // ציון אם כל אותיות החיפוש מופיעות לפי הסדר, אחרת -1
    let i = 0, gaps = 0, last = -1;
    for (let p = 0; p < hay.length && i < needle.length; p++) {
      if (hay[p] === needle[i]) {
        if (last >= 0) gaps += p - last - 1;
        last = p;
        i++;
      }
    }
    return i === needle.length ? Math.max(0, 20 - gaps) : -1;
  }

  function search(query) {
    const q = query.trim().toLowerCase();
    const out = [];
    for (const e of index) {
      let score;
      if (!q) score = 0;
      else if (e.titleLc === q) score = 1000;
      else if (e.titleLc.startsWith(q)) score = 500 + (100 - Math.min(100, e.titleLc.length));
      else if (e.titleLc.includes(q)) score = 300;
      else {
        const sub = subsequenceScore(e.titleLc, q);
        if (sub >= 0) score = 150 + sub;
        else if (e.textLc.includes(q)) score = 50;
        else continue;
      }
      out.push({ s: e.s, score });
    }
    out.sort((a, b) =>
      b.score - a.score ||
      (b.s.uses || 0) - (a.s.uses || 0) ||
      String(a.s.title).localeCompare(String(b.s.title), 'he')
    );
    return out.slice(0, MAX_RESULTS).map((x) => x.s);
  }

  /* ---------- ממשק (Shadow DOM, נבנה פעם אחת ומוסתר/מוצג) ---------- */
  const CSS = `
    :host { all: initial !important; }
    * { box-sizing: border-box; }
    .box {
      position: fixed; z-index: 2147483647;
      min-width: 268px; max-width: 400px;
      background: var(--bg); color: var(--ink);
      border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 12px 34px rgba(15,18,40,.20), 0 3px 8px rgba(15,18,40,.10);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Rubik, Arial, sans-serif;
      overflow: hidden; direction: rtl;
      transform-origin: top right;
      animation: pop .09s cubic-bezier(.2,.9,.3,1.1);
      --bg: #fff; --ink: #171a24; --muted: #6b7280; --line: rgba(15,18,40,.12);
      --brand: #4353d6; --sel: #eef1ff; --mark: #ffe27a; --chip: #f1f3f9;
    }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(.985); } }
    @media (prefers-reduced-motion: reduce) { .box { animation: none; } }
    @media (prefers-color-scheme: dark) {
      .box {
        --bg: #1e2029; --ink: #e9ebf2; --muted: #9aa1b6; --line: rgba(255,255,255,.13);
        --brand: #a5b4ff; --sel: #2e3454; --mark: #8a7412; --chip: #282b37;
        box-shadow: 0 12px 34px rgba(0,0,0,.5), 0 3px 8px rgba(0,0,0,.35);
      }
    }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 11px; border-bottom: 1px solid var(--line);
    }
    .q {
      flex: 1; min-width: 0; font-weight: 600; color: var(--brand); font-size: 12.5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; unicode-bidi: plaintext;
    }
    .count {
      flex: none; font-size: 11px; color: var(--muted);
      background: var(--chip); border-radius: 20px; padding: 1px 8px;
    }

    .list { max-height: 264px; overflow-y: auto; overscroll-behavior: contain; padding: 5px; }
    .list::-webkit-scrollbar { width: 9px; }
    .list::-webkit-scrollbar-thumb {
      background: var(--line); border-radius: 9px; border: 3px solid transparent; background-clip: content-box;
    }

    .item {
      display: flex; align-items: baseline; gap: 8px;
      padding: 7px 9px; padding-inline-start: 24px;
      border-radius: 8px; cursor: pointer; position: relative;
    }
    .item[aria-selected="true"] { background: var(--sel); }
    .item[aria-selected="true"]::after {
      content: "\\21B5"; position: absolute; inset-inline-start: 9px; top: 7px;
      color: var(--brand); font-size: 12px; opacity: .75;
    }
    .col { flex: 1; min-width: 0; }
    .title { font-weight: 600; color: var(--brand); font-size: 12.5px; unicode-bidi: plaintext; }
    .title mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 1px; }
    .preview {
      color: var(--muted); font-size: 11.5px; margin-top: 1px; unicode-bidi: plaintext;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .lines { flex: none; font-size: 10.5px; color: var(--muted); opacity: .8; }

    .empty { padding: 15px 12px; color: var(--muted); text-align: center; font-size: 12.5px; }
    .empty b { color: var(--ink); unicode-bidi: plaintext; }

    .hint {
      display: flex; gap: 12px; padding: 6px 11px;
      border-top: 1px solid var(--line); color: var(--muted); font-size: 10.5px;
    }
    kbd {
      font: inherit; background: var(--chip); border: 1px solid var(--line);
      border-radius: 4px; padding: 0 4px; margin: 0 1px;
    }
  `;

  const ui = { host: null, root: null, box: null, list: null, q: null, count: null };

  function buildUI() {
    if (ui.host && ui.host.isConnected) return;
    const host = document.createElement('div');
    host.setAttribute('data-snippets-ui', '');
    host.style.cssText = 'all:initial!important;position:absolute!important;top:0!important;' +
                         'left:0!important;width:0!important;height:0!important;';
    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('role', 'listbox');
    box.style.display = 'none';

    const head = document.createElement('div');
    head.className = 'head';
    const q = document.createElement('div');
    q.className = 'q';
    const count = document.createElement('div');
    count.className = 'count';
    head.append(q, count);

    const list = document.createElement('div');
    list.className = 'list';

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML =
      '<span><kbd>&uarr;</kbd><kbd>&darr;</kbd> ניווט</span>' +
      '<span><kbd>Enter</kbd> הדבקה</span>' +
      '<span><kbd>Esc</kbd> ביטול</span>';

    box.append(head, list, hint);
    root.append(style, box);
    (document.body || document.documentElement).appendChild(host);

    // מונע איבוד פוקוס מהשדה בזמן לחיצה בתפריט
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    // האזנה מרוכזת לשורות מתוך הצל עצמו, במקום מאזין לכל שורה
    const rowAt = (e) => (e.target && e.target.closest ? e.target.closest('.item') : null);
    list.addEventListener('mousedown', (e) => {
      const row = rowAt(e);
      if (!row) return;
      e.preventDefault();
      insert(state.items[Number(row.dataset.i)]);
    });
    list.addEventListener('mousemove', (e) => {
      const row = rowAt(e);
      if (!row) return;
      const i = Number(row.dataset.i);
      if (i !== state.index) { state.index = i; updateSelection(); }
    });

    Object.assign(ui, { host, root, box, list, q, count });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function highlight(title, query) {
    const q = query.trim().toLowerCase();
    const idx = q ? title.toLowerCase().indexOf(q) : -1;
    if (idx < 0) return escapeHtml(title);
    return escapeHtml(title.slice(0, idx)) +
      '<mark>' + escapeHtml(title.slice(idx, idx + q.length)) + '</mark>' +
      escapeHtml(title.slice(idx + q.length));
  }

  function render() {
    buildUI();
    const key = state.query + ' ' + state.items.map((s) => s.id).join(',');
    ui.q.textContent = '//' + state.query;
    ui.count.textContent = state.items.length
      ? state.items.length + (state.items.length === MAX_RESULTS ? '+' : '')
      : '0';

    if (key !== state.key) {           // בונים DOM רק כשהרשימה באמת השתנתה
      state.key = key;
      ui.list.textContent = '';
      if (!state.items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML = index.length
          ? 'אין קיצור שמתאים ל-<b>' + escapeHtml(state.query) + '</b>'
          : 'עדיין אין קיצורים.<br>לחצו על אייקון התוסף כדי להוסיף.';
        ui.list.appendChild(empty);
      } else {
        const frag = document.createDocumentFragment();
        state.items.forEach((s, i) => {
          const item = document.createElement('div');
          item.className = 'item';
          item.setAttribute('role', 'option');
          item.dataset.i = String(i);

          const col = document.createElement('div');
          col.className = 'col';
          const t = document.createElement('div');
          t.className = 'title';
          t.innerHTML = '//' + highlight(String(s.title || ''), state.query);
          const p = document.createElement('div');
          p.className = 'preview';
          p.textContent = String(s.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
          col.append(t, p);
          item.append(col);

          const lines = String(s.text || '').split('\n').length;
          if (lines > 1) {
            const badge = document.createElement('div');
            badge.className = 'lines';
            badge.textContent = lines + ' שורות';
            item.append(badge);
          }
          frag.appendChild(item);
        });
        ui.list.appendChild(frag);
      }
    }
    ui.box.style.display = '';
    updateSelection();
    schedulePosition();
  }

  function updateSelection() {
    const nodes = ui.list.children;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].classList.contains('item')) {
        nodes[i].setAttribute('aria-selected', String(i === state.index));
      }
    }
    const cur = nodes[state.index];
    if (cur && cur.classList.contains('item')) cur.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- מיקום ליד הסמן (mirror div ממוחזר + throttle ב-rAF) ---------- */
  const MIRROR_PROPS = [
    'boxSizing','fontFamily','fontSize','fontWeight','fontStyle','fontVariant','letterSpacing',
    'lineHeight','textTransform','textIndent','wordSpacing','paddingTop','paddingRight',
    'paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth',
    'borderLeftWidth','direction','textAlign','tabSize',
  ];
  let mirror = null, mirrorMark = null;

  function caretRectForInput(el) {
    if (!mirror) {
      mirror = document.createElement('div');
      mirrorMark = document.createElement('span');
      mirrorMark.textContent = ZWSP;
      mirror.setAttribute('aria-hidden', 'true');
    }
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const st = mirror.style;
    st.cssText = '';
    st.position = 'absolute';
    st.visibility = 'hidden';
    st.top = '0';
    st.left = '-9999px';
    st.overflow = 'hidden';
    st.wordWrap = 'break-word';
    for (const p of MIRROR_PROPS) st[p] = cs[p];
    st.whiteSpace = el.tagName === 'INPUT' ? 'pre' : 'pre-wrap';
    st.width = el.clientWidth + 'px';
    st.height = 'auto';

    mirror.textContent = el.value.slice(0, el.selectionStart);
    mirror.appendChild(mirrorMark);
    document.body.appendChild(mirror);
    const top = mirrorMark.offsetTop - el.scrollTop;
    const left = mirrorMark.offsetLeft - el.scrollLeft;
    mirror.remove();

    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35 || 16;
    return {
      top: rect.top + Math.max(0, Math.min(top, Math.max(0, el.clientHeight - 2))),
      left: rect.left + Math.max(0, Math.min(left, el.clientWidth)),
      height: lh,
    };
  }

  function caretRectForCE() {
    const sel = state.sel || window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect && (rect.top || rect.left || rect.height)) {
      return { top: rect.top, left: rect.left, height: rect.height || 18 };
    }
    return null; // סמן ללא ממדים - נופלים לגבולות האלמנט במקום לגעת ב-DOM של הדף
  }

  let posRaf = 0;
  function schedulePosition() {
    if (posRaf) return;
    posRaf = requestAnimationFrame(() => { posRaf = 0; if (state.open) position(); });
  }

  function position() {
    if (!ui.box || !state.target || !state.target.isConnected) return;
    let r = null;
    try {
      r = state.kind === 'input' ? caretRectForInput(state.target) : caretRectForCE();
    } catch (_) { r = null; }
    if (!r) {
      const b = state.target.getBoundingClientRect();
      r = { top: b.top, left: b.left, height: Math.min(b.height, 24) };
    }

    const box = ui.box;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const bw = box.offsetWidth, bh = box.offsetHeight;

    let top = r.top + r.height + 6;
    let flip = false;
    if (top + bh > vh - 8) {
      const above = r.top - bh - 6;
      if (above > 8) { top = above; flip = true; }
      else top = Math.max(8, vh - bh - 8);
    }
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - bw - 8));

    box.style.transformOrigin = flip ? 'bottom right' : 'top right';
    box.style.top = Math.round(top) + 'px';
    box.style.left = Math.round(left) + 'px';
  }

  /* ---------- פתיחה / סגירה ---------- */
  function open(hit) {
    const items = search(hit.query);
    // הוקלד טקסט ואין שום התאמה - מתקפלים בשקט במקום להציק
    if (hit.query && !items.length && index.length) return close();

    const sameList = state.open &&
      items.length === state.items.length &&
      items.every((s, i) => s === state.items[i]);

    state.open = true;
    state.target = hit.el;
    state.kind = hit.kind;
    state.node = hit.node;
    state.sel = hit.sel;
    state.start = hit.start;
    state.query = hit.query;
    state.items = items;
    if (!sameList) state.index = 0;
    if (state.index >= items.length) state.index = 0;
    render();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    state.items = [];
    state.index = 0;
    state.key = '';
    state.target = state.node = state.sel = null;
    if (ui.box) ui.box.style.display = 'none';
  }

  function refresh() {
    if (busy) return;
    const hit = detect();
    if (hit) open(hit);
    else close();
  }

  /* ---------- הדבקת הטקסט ---------- */
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function insertIntoInput(el, text) {
    let caret;
    try { caret = el.selectionStart; } catch (_) { caret = el.value.length; }
    const value = el.value;
    const start = Math.min(state.start, value.length);
    setNativeValue(el, value.slice(0, start) + text + value.slice(caret));
    const pos = start + text.length;
    try { el.setSelectionRange(pos, pos); } catch (_) { /* טיפוס שלא תומך */ }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function insertIntoCE(el, text) {
    const sel = state.sel || selectionFor(el);
    const node = state.node;
    if (!sel || !node || !node.isConnected) return false;

    const len = node.textContent.length;
    const start = Math.min(state.start, len);
    const caret = sel.anchorNode === node
      ? sel.anchorOffset
      : Math.min(start + state.query.length + 2, len);

    const range = document.createRange();
    try {
      range.setStart(node, start);
      range.setEnd(node, Math.min(Math.max(caret, start), len));
    } catch (_) {
      return false; // הצומת התחלף מתחת לידיים (עורך שמרנדר מחדש)
    }

    sel.removeAllRanges();
    sel.addRange(range);

    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) { ok = false; }
    if (ok) return true;

    // מסלול גיבוי ידני
    try {
      range.deleteContents();
      const frag = document.createDocumentFragment();
      text.split('\n').forEach((line, i) => {
        if (i) frag.appendChild(document.createElement('br'));
        if (line) frag.appendChild(document.createTextNode(line));
      });
      const last = frag.lastChild;
      range.insertNode(frag);
      if (last) {
        const after = document.createRange();
        after.setStartAfter(last);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function insert(snippet) {
    if (!snippet) return;
    const el = state.target;
    const text = String(snippet.text || '');
    const id = snippet.id;
    busy = true;
    let ok = false;
    try {
      ok = state.kind === 'input' ? insertIntoInput(el, text) : insertIntoCE(el, text);
    } catch (_) {
      ok = false;
    } finally {
      busy = false;
    }
    close();
    if (el && el.isConnected) el.focus({ preventScroll: true });
    if (ok) countUse(id);
  }

  function countUse(id) {
    if (!alive()) return;
    chrome.storage.local.get([STORE_KEY], (res) => {
      if (chrome.runtime.lastError) return;
      const list = Array.isArray(res[STORE_KEY]) ? res[STORE_KEY] : [];
      const item = list.find((s) => s.id === id);
      if (!item) return;
      item.uses = (item.uses || 0) + 1;
      item.lastUsed = Date.now();
      chrome.storage.local.set({ [STORE_KEY]: list }, () => void chrome.runtime.lastError);
    });
  }

  /* ---------- מאזינים ---------- */
  document.addEventListener('keydown', (e) => {
    if (!state.open || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      close();
      return;
    }
    if (!state.items.length) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      state.index = (state.index + dir + state.items.length) % state.items.length;
      updateSelection();
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault(); e.stopPropagation();
      state.index = e.key === 'Home' ? 0 : state.items.length - 1;
      updateSelection();
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'Enter' && e.shiftKey) return; // Shift+Enter נשאר שורה חדשה
      e.preventDefault(); e.stopPropagation();
      insert(state.items[state.index]);
    }
  }, true);

  document.addEventListener('input', refresh, true);

  // גיבוי ל-selectionchange: תנועת סמן בחצים/עכבר בשדות input בדפדפנים ישנים
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Home' || e.key === 'End' || (e.key && e.key.startsWith('Arrow'))) refresh();
  }, true);
  document.addEventListener('mouseup', () => { if (!busy) refresh(); }, true);

  let selRaf = 0;
  document.addEventListener('selectionchange', () => {
    if (busy || selRaf) return;
    selRaf = requestAnimationFrame(() => { selRaf = 0; refresh(); });
  }, true);

  document.addEventListener('focusout', () => {
    setTimeout(() => { if (!activeEditable()) close(); }, 0);
  }, true);

  window.addEventListener('scroll', () => { if (state.open) schedulePosition(); }, { capture: true, passive: true });
  window.addEventListener('resize', () => { if (state.open) schedulePosition(); }, { passive: true });
  window.addEventListener('blur', () => close());
  document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
})();
