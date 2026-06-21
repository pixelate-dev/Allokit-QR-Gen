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

  function init() {
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
