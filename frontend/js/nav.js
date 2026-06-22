(function () {
  const PAGE_ANIM_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
  const TRANSITION_KEY = 'pageTransition';

  function shouldPageEnter() {
    try {
      if (sessionStorage.getItem(TRANSITION_KEY) === '1') return true;
    } catch (_) {}

    const nav = performance.getEntriesByType('navigation')[0];
    return nav && nav.type === 'reload';
  }

  function initEnter() {
    const shouldEnter = shouldPageEnter();

    try {
      sessionStorage.removeItem(TRANSITION_KEY);
    } catch (_) {}

    if (!shouldEnter || PAGE_ANIM_MS === 0) {
      document.documentElement.classList.remove('page-enter');
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.documentElement.classList.remove('page-enter');
      });
    });
  }

  function navigateWithFade(href, beforeNavigate) {
    if (PAGE_ANIM_MS === 0) {
      beforeNavigate?.();
      window.location.href = href;
      return;
    }

    const main = document.querySelector('main');
    if (!main) {
      beforeNavigate?.();
      window.location.href = href;
      return;
    }

    main.classList.add('is-exiting');
    window.setTimeout(() => {
      beforeNavigate?.();
      try {
        sessionStorage.setItem(TRANSITION_KEY, '1');
      } catch (_) {}
      window.location.href = href;
    }, PAGE_ANIM_MS);
  }

  function initExit() {
    document.querySelectorAll('.nav-page-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        const href = link.getAttribute('href');
        if (!href || href === '#' || link.classList.contains('active')) return;
        if (PAGE_ANIM_MS === 0) return;

        e.preventDefault();
        navigateWithFade(href);
      });
    });
  }

  function initReloadExit() {
    if (PAGE_ANIM_MS === 0) return;

    let suppressUnloadExit = false;

    document.addEventListener('click', (e) => {
      const anchor = e.target.closest('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href === '#') return;
      try {
        const url = new URL(anchor.href, window.location.href);
        if (url.origin !== window.location.origin) {
          suppressUnloadExit = true;
          window.setTimeout(() => { suppressUnloadExit = false; }, 2000);
        }
      } catch (_) {}
    }, true);

    window.addEventListener('beforeunload', () => {
      if (suppressUnloadExit) return;
      document.querySelector('main')?.classList.add('is-exiting');
      try {
        sessionStorage.setItem(TRANSITION_KEY, '1');
      } catch (_) {}
    });
  }

  // Small screens can't fit the dashboard layout, so we gate them with a
  // "open on desktop" overlay. CSS controls visibility via a media query;
  // this just injects the markup on every page that loads nav.js.
  function initMobileGate() {
    if (document.getElementById('mobile-gate')) return;

    const gate = document.createElement('div');
    gate.id = 'mobile-gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-labelledby', 'mobile-gate-title');
    gate.innerHTML = `
      <div class="mobile-gate-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      </div>
      <h1 id="mobile-gate-title" class="mobile-gate-title">Please open on desktop</h1>
      <p class="mobile-gate-text">Allokit's QR generator is designed for larger screens. Open this page on a desktop or laptop for the best experience.</p>
    `;
    document.body.appendChild(gate);
  }

  function init() {
    initMobileGate();
    initEnter();
    initExit();
    initReloadExit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
