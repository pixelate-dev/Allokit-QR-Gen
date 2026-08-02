/**
 * One-time asset cache refresh per browser profile.
 *
 * Bump CACHE_VERSION (and the ?v= on this script tag in each page) whenever
 * you want every device to pick up fresh CSS/JS once on next visit.
 *
 * - Clears Cache Storage only (not cookies)
 * - Never calls localStorage.clear() / sessionStorage.clear()
 *   so notifications and other app data stay intact
 * - Remembers completion in localStorage so the same system skips next time
 */
(function () {
  const CACHE_VERSION = '2026-08-03';
  const DONE_KEY = 'allokitCacheVersion';
  const RELOADING_KEY = 'allokitCacheReloading';

  // Capture while this classic script is still executing (null after await).
  const scriptSrc = document.currentScript && document.currentScript.src;
  const baseHref = scriptSrc || location.href;

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {}
  }

  function readSession(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function writeSession(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (_) {}
  }

  function clearSession(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (_) {}
  }

  // Already refreshed for this version; leave cookies + localStorage alone.
  if (read(DONE_KEY) === CACHE_VERSION) {
    clearSession(RELOADING_KEY);
    return;
  }

  // Reloaded after a refresh; mark done and stop (no loop).
  if (readSession(RELOADING_KEY) === CACHE_VERSION) {
    write(DONE_KEY, CACHE_VERSION);
    clearSession(RELOADING_KEY);
    return;
  }

  async function clearCacheStorage() {
    if (!window.caches || !caches.keys) return;
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch (_) {}
  }

  async function revalidateAssets() {
    const assets = [
      new URL('../css/styles.css', baseHref).href,
      new URL('../js/api.js', baseHref).href,
      new URL('../js/nav.js', baseHref).href,
      new URL('../js/notifications.js', baseHref).href,
      new URL('../js/search.js', baseHref).href,
      new URL('../js/progress.js', baseHref).href,
      new URL('../js/csv-upload-queue.js', baseHref).href,
      new URL('../js/app-notice.js', baseHref).href,
      new URL('../js/csv-limits.js', baseHref).href,
      new URL('../js/job-id-format.js', baseHref).href,
      new URL('/config.js', location.href).href,
      location.href,
    ];

    await Promise.allSettled(
      assets.map((url) =>
        fetch(url, { cache: 'reload', credentials: 'same-origin' }).catch(() => null)
      )
    );
  }

  (async function refreshOnce() {
    await clearCacheStorage();
    await revalidateAssets();

    writeSession(RELOADING_KEY, CACHE_VERSION);
    // Mark done before reload so a partial failure still won't loop forever
    // after the session flag is seen on the next load.
    write(DONE_KEY, CACHE_VERSION);
    location.reload();
  })();
})();
