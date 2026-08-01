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

  window.allokitDownloadJobPdf = async function allokitDownloadJobPdf(jobId, filename, triggerEl) {
    if (triggerEl && triggerEl.classList.contains('is-loading')) return;

    const isSmall = triggerEl && triggerEl.classList.contains('btn-download-sm');
    let saved = null;

    if (triggerEl) {
      saved = {
        html: triggerEl.innerHTML,
        disabled: triggerEl.disabled,
        ariaDisabled: triggerEl.getAttribute('aria-disabled'),
        tabIndex: triggerEl.tabIndex,
      };
      triggerEl.classList.add('is-loading');
      triggerEl.setAttribute('aria-disabled', 'true');
      triggerEl.tabIndex = -1;
      if ('disabled' in triggerEl) triggerEl.disabled = true;

      const spinnerClass = isSmall
        ? 'btn-download-spinner btn-download-spinner--sm'
        : 'btn-download-spinner';
      const label = isSmall ? ' PDF' : ' Downloading…';
      triggerEl.innerHTML =
        `<span class="${spinnerClass}" role="status" aria-label="Downloading"></span>${label}`;
    }

    try {
      const res = await allokitFetch(`/jobs/${jobId}/download`);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${filename || 'sticker'}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Failed to download PDF: ${err.message}`);
    } finally {
      if (triggerEl && saved) {
        triggerEl.innerHTML = saved.html;
        triggerEl.classList.remove('is-loading');
        if (saved.ariaDisabled === null) {
          triggerEl.removeAttribute('aria-disabled');
        } else {
          triggerEl.setAttribute('aria-disabled', saved.ariaDisabled);
        }
        triggerEl.tabIndex = saved.tabIndex;
        if ('disabled' in triggerEl) triggerEl.disabled = saved.disabled;
      }
    }
  };
})();
