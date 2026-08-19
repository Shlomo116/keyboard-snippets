/* ---------------------------------------------------------------
 *  שכבת האחסון — משותפת לסקריפט התוכן, לדפי התוסף ול-service worker
 *
 *  הקיצורים יושבים ב-chrome.storage.sync, מפתח נפרד לכל קיצור. הסיבה למפתח
 *  נפרד היא המגבלה של 8KB לפריט: מערך אחד עם כל הקיצורים היה חורג ממנה כבר
 *  אחרי כמה עשרות שורות טקסט בעברית. מפתח נפרד גם אומר שעריכה של קיצור אחד
 *  כותבת רשומה אחת, ושתי מכשירים שעורכים קיצורים שונים לא דורסים זה את זה.
 *
 *  מונה השימושים נשאר ב-local בכוונה: הוא מתעדכן בכל הדבקה, וסנכרון שלו היה
 *  שורף את מכסת הכתיבות (1800 לשעה) ומייצר תעבורה מיותרת. ממילא דירוג לפי
 *  תדירות שימוש הגיוני יותר כשהוא מקומי למכשיר.
 * --------------------------------------------------------------- */
(function (root) {
  'use strict';

  const SYNC = chrome.storage.sync;
  const LOCAL = chrome.storage.local;

  const PREFIX = 's:';            // קידומת למפתח קיצור ב-sync
  const SETTINGS_KEY = 'settings';
  const USAGE_KEY = 'usage';      // מקומי בלבד
  const LEGACY_KEY = 'snippets';  // המערך מהגרסאות הקודמות
  const MIGRATED_KEY = 'migratedToSync';

  /* מגבלות chrome.storage.sync */
  const LIMITS = {
    TOTAL_BYTES: 102400,
    ITEM_BYTES: 8192,
    MAX_ITEMS: 512,
    SAFE_ITEM_BYTES: 7800, // מרווח ביטחון מתחת למגבלת הפריט
  };

  const encoder = new TextEncoder();
  const byteSize = (v) => encoder.encode(typeof v === 'string' ? v : JSON.stringify(v)).length;

  const isSnippetKey = (k) => k.indexOf(PREFIX) === 0;
  const keyOf = (id) => PREFIX + id;

  const uid = () => 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- קריאה ---------- */

  async function getUsage() {
    const res = await LOCAL.get(USAGE_KEY);
    return res[USAGE_KEY] || {};
  }

  /* מחזיר את כל הקיצורים, עם נתוני השימוש המקומיים מוזרקים פנימה */
  async function getAll() {
    const [all, usage] = await Promise.all([SYNC.get(null), getUsage()]);
    const list = [];
    for (const key of Object.keys(all)) {
      if (!isSnippetKey(key)) continue;
      const s = all[key];
      if (!s || !s.id || !s.title) continue;
      const u = usage[s.id] || {};
      list.push({
        id: s.id,
        title: s.title,
        text: s.text || '',
        createdAt: s.createdAt || 0,
        updatedAt: s.updatedAt || 0,
        uses: u.uses || 0,
        lastUsed: u.lastUsed || 0,
      });
    }
    return list;
  }

  async function getSettings() {
    const res = await SYNC.get(SETTINGS_KEY);
    return Object.assign({ enabled: true, trigger: '//' }, res[SETTINGS_KEY] || {});
  }

  async function saveSettings(patch) {
    const cur = await getSettings();
    await SYNC.set({ [SETTINGS_KEY]: Object.assign(cur, patch) });
  }

  /* ---------- כתיבה ---------- */

  function record(s) {
    return {
      id: s.id || uid(),
      title: String(s.title || ''),
      text: String(s.text || ''),
      createdAt: s.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
  }

  /* שגיאות מובנות, כדי שהממשק יוכל להסביר למשתמש מה קרה */
  function quotaError(kind, detail) {
    const e = new Error(kind);
    e.kind = kind;
    e.detail = detail;
    return e;
  }

  async function put(s) {
    const rec = record(s);
    const size = byteSize(rec) + keyOf(rec.id).length;
    if (size > LIMITS.SAFE_ITEM_BYTES) {
      throw quotaError('ITEM_TOO_BIG', { size, limit: LIMITS.SAFE_ITEM_BYTES });
    }
    try {
      await SYNC.set({ [keyOf(rec.id)]: rec });
    } catch (err) {
      throw quotaError('QUOTA_FULL', { message: String(err && err.message || err) });
    }
    return rec;
  }

  async function remove(id) {
    await SYNC.remove(keyOf(id));
    const usage = await getUsage();
    if (usage[id]) {
      delete usage[id];
      await LOCAL.set({ [USAGE_KEY]: usage });
    }
  }

  /*
   * כתיבה בקבוצות: מכסת הכתיבות של sync היא 120 לדקה, וקריאת set אחת עם
   * מאה מפתחות נספרת לפי מספר המפתחות. ייבוא גדול היה נחסם באמצע.
   */
  async function putMany(list, onProgress) {
    const CHUNK = 30;
    let done = 0;
    for (let i = 0; i < list.length; i += CHUNK) {
      const batch = {};
      for (const s of list.slice(i, i + CHUNK)) {
        const rec = record(s);
        if (byteSize(rec) + keyOf(rec.id).length > LIMITS.SAFE_ITEM_BYTES) continue;
        batch[keyOf(rec.id)] = rec;
      }
      if (Object.keys(batch).length) await SYNC.set(batch);
      done += CHUNK;
      if (onProgress) onProgress(Math.min(done, list.length), list.length);
      if (i + CHUNK < list.length) await new Promise((r) => setTimeout(r, 600));
    }
  }

  async function clearAll() {
    const all = await SYNC.get(null);
    const keys = Object.keys(all).filter(isSnippetKey);
    if (keys.length) await SYNC.remove(keys);
    await LOCAL.set({ [USAGE_KEY]: {} });
  }

  /* עדכון מונה השימוש — מקומי, לא מסונכרן */
  async function bumpUsage(id) {
    const usage = await getUsage();
    const cur = usage[id] || {};
    usage[id] = { uses: (cur.uses || 0) + 1, lastUsed: Date.now() };
    await LOCAL.set({ [USAGE_KEY]: usage });
  }

  /* ---------- מצב המכסה ---------- */

  async function quota() {
    const [bytes, all] = await Promise.all([
      SYNC.getBytesInUse(null).catch(() => 0),
      SYNC.get(null),
    ]);
    const count = Object.keys(all).filter(isSnippetKey).length;
    return {
      bytes,
      maxBytes: LIMITS.TOTAL_BYTES,
      count,
      maxCount: LIMITS.MAX_ITEMS,
      percent: Math.round((bytes / LIMITS.TOTAL_BYTES) * 100),
    };
  }

  /* ---------- הגירה מהגרסאות המקומיות ---------- */

  /*
   * רץ פעם אחת לכל מכשיר. המערך הישן נשאר ב-local כגיבוי ולא נמחק, כדי
   * שכשל בהגירה לא יאבד למשתמש את הקיצורים.
   */
  async function migrate() {
    const local = await LOCAL.get([LEGACY_KEY, MIGRATED_KEY, USAGE_KEY]);
    if (local[MIGRATED_KEY]) return { migrated: 0, skipped: true };

    const old = Array.isArray(local[LEGACY_KEY]) ? local[LEGACY_KEY] : [];
    if (!old.length) {
      await LOCAL.set({ [MIGRATED_KEY]: true });
      return { migrated: 0, skipped: false };
    }

    const existing = await getAll();
    const taken = new Set(existing.map((s) => s.title.toLowerCase()));

    const toWrite = [];
    const usage = local[USAGE_KEY] || {};
    for (const s of old) {
      if (!s || !s.title || !s.text) continue;
      if (taken.has(String(s.title).toLowerCase())) continue;
      const id = s.id || uid();
      toWrite.push({ id, title: s.title, text: s.text, createdAt: s.createdAt });
      if (s.uses) usage[id] = { uses: s.uses, lastUsed: s.lastUsed || 0 };
    }

    if (toWrite.length) await putMany(toWrite);
    await LOCAL.set({ [USAGE_KEY]: usage, [MIGRATED_KEY]: true });
    return { migrated: toWrite.length, skipped: false };
  }

  /* ---------- האזנה לשינויים ---------- */

  /* קורא ל-cb כשקיצור השתנה בכל מכשיר, או כשנתוני השימוש המקומיים השתנו */
  function onSnippetsChanged(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && Object.keys(changes).some(isSnippetKey)) return cb();
      if (area === 'local' && changes[USAGE_KEY]) return cb();
    });
  }

  function onSettingsChanged(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[SETTINGS_KEY]) cb(changes[SETTINGS_KEY].newValue || {});
    });
  }

  root.SnippetStore = {
    LIMITS, PREFIX, SETTINGS_KEY,
    uid, byteSize,
    getAll, getSettings, saveSettings,
    put, putMany, remove, clearAll,
    bumpUsage, quota, migrate,
    onSnippetsChanged, onSettingsChanged,
  };
})(typeof self !== 'undefined' ? self : this);
