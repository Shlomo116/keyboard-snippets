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
  let settings = { enabled: true, trigger: '//' };

  /* בניית הרגקס מהטריגר שהמשתמש בחר */
  const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function buildTriggerRe(t) {
    return new RegExp('(^|[\\s([{"\'\u2019\u201c<>\\-\u2013\u2014,;!?])' + escapeRe(t) + '(\\S*)$');
  }
  const validTrigger = (t) =>
    typeof t === 'string' && t.length >= 1 && t.length <= 3 && !/[\w\s]/.test(t);

  let TRIGGER_RE = buildTriggerRe('//');

  /*
   * עורכים עשירים (Lexical בוואטסאפ ווב, ProseMirror ואחרים) שותלים תווי אפס-רוחב
   * וסימני כיווניות בתוך הטקסט, בעיקר בהקשר RTL ובשדה ריק. \s לא תופס אותם, ולכן
   * תו אחד כזה לפני הטריגר היה מפיל את הזיהוי. מחליפים אותם ברווח — ולא מוחקים —
   * כדי לשמור על אורך הטקסט, שכל חישובי המיקום נשענים עליו.
   */
  const INVISIBLE_RE = /[\u200b-\u200f\u2060\u2061-\u2064\ufeff\u00ad]/g;
  // בלי test() מקדים: ל-RegExp עם דגל g יש lastIndex שנשמר בין קריאות ומחזיר תשובות שגויות
  const normalizeInvisible = (t) => t.replace(INVISIBLE_RE, ' ');
  // ליומן האבחון: הפיכת הבלתי-נראה לנראה
  const visible = (t) => String(t).replace(INVISIBLE_RE, (c) => '<' + c.codePointAt(0).toString(16) + '>');

  /* מצב דיבאג: בקונסולה של הדף הריצו  localStorage.snippetsDebug = 1  ורעננו */
  let DEBUG = false;
  try { DEBUG = !!localStorage.getItem('snippetsDebug'); } catch (_) { DEBUG = false; }
  const log = (...a) => { if (DEBUG) console.log('%c[//]', 'color:#4353d6;font-weight:bold', ...a); };

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
      if (!validTrigger(settings.trigger)) settings.trigger = '//';
      TRIGGER_RE = buildTriggerRe(settings.trigger);
      log('טריגר פעיל:', settings.trigger);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORE_KEY]) buildIndex(changes[STORE_KEY].newValue);
      if (changes[SETTINGS_KEY]) {
        settings = Object.assign(settings, changes[SETTINGS_KEY].newValue || {});
        if (!validTrigger(settings.trigger)) settings.trigger = '//';
        TRIGGER_RE = buildTriggerRe(settings.trigger);
        close();
      }
    });
  }

  /* ---------- מצב התפריט ---------- */
  const state = {
    open: false,
    target: null,   // האלמנט שבו מקלידים
    kind: null,     // 'input' | 'ce'
    node: null,     // contenteditable: צומת הטקסט של הסמן
    sel: null,      // contenteditable: אובייקט ה-Selection הרלוונטי
    start: 0,       // input: אינדקס תחילת ה-//
    trigger: '',    // המחרוזת המדויקת שיש להחליף, למשל "//תוד"
    caretInNode: 0, // contenteditable: היסט הסמן בתוך צומת הטקסט
    range: null,    // contenteditable: עותק של טווח הסמן ברגע הזיהוי
    dir: 'rtl',     // כיוון הכתיבה של השדה
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
  const SCAN_LIMIT = 200; // אין טעם לסרוק יותר מזה אחורה

  const BLOCK_TAGS = new Set([
    'P','DIV','LI','TD','TH','BLOCKQUOTE','PRE','SECTION','ARTICLE','MAIN','ASIDE',
    'HEADER','FOOTER','FIGCAPTION','DD','DT','FORM','BODY','H1','H2','H3','H4','H5','H6',
  ]);

  function blockAncestor(node, root) {
    let n = node && node.nodeType === Node.ELEMENT_NODE ? node : (node && node.parentNode);
    while (n && n !== root) {
      if (n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(n.tagName)) return n;
      n = n.parentNode;
    }
    return root;
  }

  /*
   * עורכים כמו Lexical (וואטסאפ ווב), ProseMirror או Draft מפצלים טקסט בין הרבה
   * span-ים, כך שה-"//" והמילה שאחריו יכולים לשבת בצמתים שונים לגמרי. לכן אוספים
   * את הטקסט שלפני הסמן בהליכה על כל בלוק התוכן, ולא רק מתוך צומת הסמן.
   */
  function textBeforeCaretCE(root, container, offset) {
    const block = blockAncestor(container, root);
    let stopNode = null;
    if (container.nodeType === Node.TEXT_NODE) stopNode = container;
    else stopNode = container.childNodes[offset] || null;

    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let out = '';
    let n;
    while ((n = walker.nextNode())) {
      if (n === stopNode) {
        if (n.nodeType === Node.TEXT_NODE) out += n.textContent.slice(0, offset);
        break;
      }
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
      else if (n.tagName === 'BR') out += '\n';
      else if (out && BLOCK_TAGS.has(n.tagName)) out += '\n';
    }
    return out.length > SCAN_LIMIT
      ? { text: out.slice(-SCAN_LIMIT), truncated: true }
      : { text: out, truncated: false };
  }

  function readContext() {
    const active = activeEditable();
    if (!active) return null;
    const { el, kind } = active;

    if (kind === 'input') {
      let caret;
      try { caret = el.selectionStart; } catch (_) { return null; }
      if (caret === null || caret !== el.selectionEnd) return null;
      const from = Math.max(0, caret - SCAN_LIMIT);
      return {
        el, kind, caret, node: null, sel: null,
        before: el.value.slice(from, caret),
        truncated: from > 0,
      };
    }

    const sel = selectionFor(el);
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
    const container = sel.anchorNode;
    if (!container || !el.contains(container)) return null;
    const scan = textBeforeCaretCE(el, container, sel.anchorOffset);
    const node = container.nodeType === Node.TEXT_NODE ? container : null;
    let range = null;
    try { range = sel.getRangeAt(0).cloneRange(); } catch (_) { range = null; }
    return {
      el, kind, node, sel, range,
      before: scan.text, truncated: scan.truncated, caret: sel.anchorOffset,
    };
  }

  function dirOf(el) {
    try { return getComputedStyle(el).direction === 'ltr' ? 'ltr' : 'rtl'; }
    catch (_) { return 'rtl'; }
  }

  function detect() {
    if (!settings.enabled) { log('כבוי בהגדרות'); return null; }
    const ctx = readContext();
    if (!ctx) { log('אין שדה עריכה פעיל / סמן לא מכווץ'); return null; }
    const before = normalizeInvisible(ctx.before);
    const m = TRIGGER_RE.exec(before);
    if (!m) {
      log('אין טריגר (' + settings.trigger + '). לפני הסמן:', JSON.stringify(before.slice(-30)));
      return null;
    }
    // חלון הסריקה חתוך, כך שהתאמה ל-"^" לא באמת מעידה על תחילת שורה
    if (m[1] === '' && ctx.truncated) { log('התאמה בגבול חלון הסריקה — נדחתה'); return null; }
    const query = m[2];
    const lastChar = settings.trigger.slice(-1);
    if (query.length > MAX_QUERY || query.startsWith(lastChar)) { log('שאילתה נפסלה:', query); return null; }
    log('טריגר זוהה. שאילתה:', JSON.stringify(query), '| סוג:', ctx.kind);
    return {
      el: ctx.el, kind: ctx.kind, node: ctx.node, sel: ctx.sel, caret: ctx.caret,
      start: (ctx.kind === 'input'
        ? ctx.caret - (query.length + settings.trigger.length)
        : m.index + m[1].length),
      trigger: settings.trigger + query,
      range: (ctx.sel && ctx.sel.rangeCount) ? ctx.sel.getRangeAt(0).cloneRange() : null,
      dir: dirOf(ctx.el),
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
      overflow: hidden;
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
      padding: 7px 9px; padding-inline-end: 26px;
      border-radius: 8px; cursor: pointer; position: relative;
    }
    .item[aria-selected="true"] { background: var(--sel); }
    .item[aria-selected="true"]::after {
      content: "\\21B5"; position: absolute; inset-inline-end: 9px; top: 7px;
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
    ui.box.setAttribute('dir', state.dir);
    const key = state.query + ' ' + state.items.map((s) => s.id).join(',');
    ui.q.textContent = settings.trigger + state.query;
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
          t.innerHTML = escapeHtml(settings.trigger) + highlight(String(s.title || ''), state.query);
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
    // ב-RTL הטקסט גדל שמאלה, ולכן הקצה הימני של התפריט הוא זה שנצמד לסמן.
    const rtl = state.dir === 'rtl';
    const wanted = rtl ? r.left - bw : r.left;
    const left = Math.min(Math.max(8, wanted), Math.max(8, vw - bw - 8));

    box.style.transformOrigin = (flip ? 'bottom ' : 'top ') + (rtl ? 'right' : 'left');
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
    state.trigger = hit.trigger;
    state.caretInNode = hit.caret;
    state.range = hit.range || null;
    state.dir = hit.dir;
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
    state.trigger = '';
    state.target = state.node = state.sel = state.range = null;
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

  function insertIntoInput(ctx, text) {
    const el = ctx.el;
    const value = el.value;
    let caret;
    try { caret = el.selectionStart; } catch (_) { caret = value.length; }
    const start = Math.max(0, Math.min(ctx.start, value.length));

    // מסלול ראשי: בחירת הטריגר והחלפתו דרך execCommand — שומר על Undo של הדפדפן
    // ומייצר את אותם אירועים שהקלדה אמיתית מייצרת, כך שגם React/Vue קולטים.
    try {
      el.setSelectionRange(start, Math.max(start, caret));
      if (document.execCommand('insertText', false, text)) { log('הודבק דרך execCommand'); return true; }
    } catch (_) { /* ממשיכים למסלול הגיבוי */ }

    setNativeValue(el, value.slice(0, start) + text + value.slice(caret));
    const pos = start + text.length;
    try { el.setSelectionRange(pos, pos); } catch (_) { /* טיפוס שלא תומך */ }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    log('הודבק דרך native setter');
    return true;
  }

  /*
   * בחירת הטריגר לאחור באמצעות Selection.modify. זו הדרך היחידה שחוצה נכון גבולות
   * של צמתים ושל span-ים שהעורך יצר, ולכן זה מה שעובד מול Lexical (וואטסאפ ווב),
   * ProseMirror ו-Draft, שם חיתוך טווח לפי אינדקסים בצומת בודד נכשל.
   */
  const stripInvisible = (t) => t.replace(INVISIBLE_RE, '');

  /*
   * ספירה עיוורת של תווים אחורה שבירה: תו אפס-רוחב אחד שהעורך שתל בתוך הטווח,
   * או צעד שמדלג על אשכול גרפמות שלם, מזיזים את הבחירה ממקומה. לכן מתקדמים
   * אחורה צעד-צעד ובודקים אחרי כל צעד אם הגענו בדיוק לטריגר.
   */
  function selectTriggerBackwards(sel, trigger) {
    if (typeof sel.modify !== 'function') { log('אין תמיכה ב-Selection.modify'); return false; }
    const want = stripInvisible(trigger);
    const maxSteps = Array.from(trigger).length + 8; // מרווח לתווים בלתי נראים
    let last = '';
    for (let i = 0; i < maxSteps; i++) {
      sel.modify('extend', 'backward', 'character');
      const got = sel.toString();
      if (got === last) break;          // הגענו לתחילת הטקסט ואין לאן להתקדם
      last = got;
      if (stripInvisible(got) === want) { log('הטריגר נבחר אחרי', i + 1, 'צעדים'); return true; }
    }
    log('לא הצלחתי לבחור את הטריגר. נבחר:', JSON.stringify(last), '| רצוי:', JSON.stringify(trigger));
    try { sel.collapseToEnd(); } catch (_) { /* ignore */ }
    return false;
  }

  /* ---------- מסלולי הדבקה ל-contenteditable ---------- */

  /*
   * חתימת הצלחה: מחפשים את תחילת הטקסט שהודבק, ולא "משהו השתנה". ההבדל קריטי —
   * מסלול שמחק את הטריגר אבל לא הדביק כלום היה נספר כהצלחה, והמשתמש היה נשאר
   * בלי הטריגר וגם בלי הטקסט.
   */
  const flatten = (t) => stripInvisible(t).replace(/\s+/g, ' ');

  /*
   * החתימה נלקחת מהשורה הארוכה ביותר ולא מתחילת הטקסט, כי עורך שמפצל שורות
   * לפסקאות נפרדות לא בהכרח משאיר מפריד ביניהן — חתימה שחוצה גבול שורה הייתה
   * מייצרת כישלון שווא, ובעקבותיו הדבקה כפולה.
   */
  function fingerprint(t) {
    const lines = String(t).split('\n').map((l) => flatten(l).trim());
    let best = '';
    for (const l of lines) if (l.length > best.length) best = l;
    return best.slice(0, 24);
  }

  const occurrences = (hay, needle) =>
    (!needle ? 0 : flatten(hay).split(needle).length - 1);

  /* הצלחה = החתימה מופיעה יותר פעמים מקודם. עמיד גם למצב שבו הטקסט כבר היה בשדה. */
  const landed = (el, mark, beforeCount) =>
    !!mark && occurrences(el.textContent, mark) > beforeCount;

  function execInsert(text) {
    try { return document.execCommand('insertText', false, text); } catch (_) { return false; }
  }

  /* מסלול א: בחירת הטריגר והחלפתו */
  function ceReplace(ctx, text) {
    if (!selectTriggerBackwards(ctx.sel, ctx.trigger)) return false;
    return execInsert(text);
  }

  /* מסלול ב: אירוע הדבקה מסונתז — עורכי framework מטפלים בהדבקה כמסלול ליבה */
  function cePaste(ctx, text) {
    if (!selectTriggerBackwards(ctx.sel, ctx.trigger)) return false;
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      ctx.el.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true,
      }));
      return true;
    } catch (_) { return false; }
  }

  /*
   * מסלול ג: מחיקה תו-תו כמו Backspace אמיתי ואז הקלדה. עורכים מבוססי beforeinput
   * מטפלים ב-deleteContentBackward הכי אמין, כי זה בדיוק מה שהקלדה אמיתית מייצרת.
   */
  function ceBackspace(ctx, text) {
    try {
      ctx.sel.collapseToEnd();
      const steps = Array.from(ctx.trigger).length;
      for (let i = 0; i < steps; i++) document.execCommand('delete');
    } catch (_) { return false; }
    return execInsert(text);
  }

  /* מסלול ד: חיתוך טווח בצומת הסמן, ואם גם זה לא נתפס — בנייה ידנית */
  function ceManual(ctx, text) {
    const node = ctx.node;
    if (!node || !node.isConnected) { log('אין צומת סמן למסלול הידני'); return false; }

    const end = Math.min(ctx.caretInNode || node.textContent.length, node.textContent.length);
    const upto = node.textContent.slice(0, end);
    // מאתרים את ההיסט הגולמי שמכיל בדיוק את הטריגר, תוך התעלמות מתווים בלתי נראים
    let start = -1;
    for (let k = end; k >= 0; k--) {
      const seg = stripInvisible(upto.slice(k));
      if (seg === ctx.trigger) { start = k; break; }
      if (seg.length > ctx.trigger.length) break;
    }
    if (start < 0) { log('הטריגר לא יושב בצומת בודד'); return false; }

    const range = document.createRange();
    try { range.setStart(node, start); range.setEnd(node, end); } catch (_) { return false; }
    ctx.sel.removeAllRanges();
    ctx.sel.addRange(range);
    if (execInsert(text)) return true;

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
        ctx.sel.removeAllRanges();
        ctx.sel.addRange(after);
      }
      ctx.el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      return true;
    } catch (_) { return false; }
  }

  const CE_ROUTES = [
    ['execCommand', ceReplace],
    ['הדבקה מסונתזת', cePaste],
    ['מחיקה תו-תו', ceBackspace],
    ['טווח בצומת', ceManual],
  ];

  /*
   * Lexical ודומיו מיישמים את השינוי אחרי שהאירוע נגמר, ולכן ערך ההחזרה של
   * execCommand לא אומר כלום — הוא מחזיר true גם כשהעורך בלע את הפעולה. מנסים
   * מסלול, ממתינים, ובודקים אם הטקסט אכן נחת. האימות הוא גם מה שמונע הדבקה כפולה.
   */
  function insertIntoCE(ctx, text, done) {
    if (!ctx.sel) { log('אין אובייקט Selection'); return done(false); }

    // אם הפוקוס נדד (לחיצה בעכבר), מחזירים אותו ומשחזרים את טווח הסמן
    const focused = document.activeElement;
    if (focused !== ctx.el && !ctx.el.contains(focused)) {
      log('הפוקוס אבד מהשדה, משחזר');
      try {
        ctx.el.focus({ preventScroll: true });
        if (ctx.range) { ctx.sel.removeAllRanges(); ctx.sel.addRange(ctx.range); }
      } catch (_) { /* ממשיכים */ }
    }
    if (ctx.sel.rangeCount === 0) { log('אין טווח בחירה'); return done(false); }

    const mark = fingerprint(text);
    const beforeCount = occurrences(ctx.el.textContent, mark);
    let i = 0;
    const step = () => {
      if (i >= CE_ROUTES.length) {
        log('כל המסלולים נכשלו. בשדה:', visible(ctx.el.textContent.slice(-40)));
        return done(false);
      }
      const [name, run] = CE_ROUTES[i++];
      let ran = false;
      try { ran = run(ctx, text); } catch (_) { ran = false; }
      log('מסלול "' + name + '":', ran ? 'הופעל' : 'לא הופעל');
      setTimeout(() => {
        if (landed(ctx.el, mark, beforeCount)) { log('הצליח: ' + name); return done(true); }
        try { ctx.sel.collapseToEnd(); } catch (_) { /* ignore */ }
        step();
      }, 60);
    };
    step();
  }

  function insert(snippet) {
    if (!snippet) return;
    const el = state.target;
    if (!el) return;

    // מצלמים את כל מה שההדבקה צריכה, כדי שאפשר יהיה לסגור את התפריט מיד
    const ctx = {
      el,
      kind: state.kind,
      sel: state.sel || (state.kind === 'ce' ? selectionFor(el) : null),
      node: state.node,
      caretInNode: state.caretInNode,
      trigger: state.trigger,
      range: state.range,
      start: state.start,
    };
    const text = String(snippet.text || '');
    const id = snippet.id;

    busy = true;
    close();
    try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ }

    // רשת ביטחון: busy לא יישאר תקוע גם אם משהו נופל בדרך
    const bail = setTimeout(() => { busy = false; }, 3000);
    const finish = (ok) => {
      clearTimeout(bail);
      busy = false;
      if (ok) countUse(id);
    };

    if (ctx.kind === 'input') {
      let ok = false;
      try { ok = insertIntoInput(ctx, text); } catch (_) { ok = false; }
      return finish(ok);
    }
    try {
      insertIntoCE(ctx, text, finish);
    } catch (_) {
      finish(false);
    }
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
  /* על window ולא על document: שלב ה-capture מתחיל ב-window, כך שאנחנו מקדימים
     גם אתרים שתופסים Enter בעצמם (וואטסאפ שולח הודעה ב-Enter). */
  window.addEventListener('keydown', (e) => {
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

  /*
   * Lexical ודומיו מסיימים לכתוב את ה-DOM אחרי אירוע ה-input, ולכן קריאה סינכרונית
   * בלבד עלולה לראות מצב ביניים. בודקים גם בתור המשימות הבא.
   */
  let recheck = 0;
  function refreshSoon() {
    refresh();
    clearTimeout(recheck);
    recheck = setTimeout(refresh, 0);
  }

  document.addEventListener('input', refreshSoon, true);

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
