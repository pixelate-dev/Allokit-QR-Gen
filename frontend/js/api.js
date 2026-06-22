(function () {
  const LOCAL_DEV_API = 'http://localhost:8000';

  if (typeof window.API_BASE !== 'string') {
    if (window.location.protocol === 'file:') {
      window.API_BASE = LOCAL_DEV_API;
    } else {
      window.API_BASE = '';
    }
  }

  window.allokitApiHeaders = function allokitApiHeaders(extra) {
    const headers = new Headers(extra || {});
    if (window.ALLOKIT_API_KEY && !headers.has('X-API-Key')) {
      headers.set('X-API-Key', window.ALLOKIT_API_KEY);
    }
    return headers;
  };

  window.allokitFetch = function allokitFetch(path, options) {
    const opts = options || {};
    const base = window.API_BASE || '';
    const url = path.startsWith('http') ? path : `${base}${path}`;
    return fetch(url, { ...opts, headers: allokitApiHeaders(opts.headers) });
  };
})();
