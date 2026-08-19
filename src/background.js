/* ---------------------------------------------------------------
 *  service worker — הגירה חד-פעמית מאחסון מקומי לסנכרון
 * --------------------------------------------------------------- */
importScripts('/src/store.js');

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const res = await SnippetStore.migrate();
    if (res.migrated) {
      console.log('[//] הועברו', res.migrated, 'קיצורים לסנכרון');
    }
  } catch (err) {
    console.warn('[//] ההגירה נכשלה:', err);
  }

  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
