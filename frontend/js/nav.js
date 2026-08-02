(function () {
  const PAGE_ANIM_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
  const TRANSITION_KEY = 'pageTransition';
  const THEME_KEY = 'allokitTheme';
  const DEFAULT_SIZE_KEY = 'allokitDefaultSize';

  // iPad/iPhone (incl. iPadOS desktop UA): Safari can't keep backdrop-filter
  // inside View Transition snapshots, so settings uses a solid scrim there.
  function isIPadLike() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    if (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1) return true;
    try {
      if (navigator.userAgentData?.platform === 'macOS' && (navigator.maxTouchPoints || 0) > 1) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  if (isIPadLike()) {
    document.documentElement.classList.add('is-ipad');
  }

  function getStoredTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (_) {
      return null;
    }
  }

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (_) {}
  }

  function getTheme() {
    const stored = getStoredTheme();
    if (stored === 'dark' || stored === 'light') return stored;
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function normalizeSize(size) {
    return size === 'small' ? 'small' : 'large';
  }

  function getStoredDefaultSize() {
    try {
      return localStorage.getItem(DEFAULT_SIZE_KEY);
    } catch (_) {
      return null;
    }
  }

  function setStoredDefaultSize(size) {
    try {
      localStorage.setItem(DEFAULT_SIZE_KEY, size);
    } catch (_) {}
  }

  function getDefaultSize() {
    return normalizeSize(getStoredDefaultSize());
  }

  function setDefaultSize(size) {
    const next = normalizeSize(size);
    setStoredDefaultSize(next);
    syncDefaultSizeToggle(next);
    // Saved for the next page load only — do not live-sync Generate toggles.
    return next;
  }

  window.AllokitPrefs = {
    getDefaultSize,
    setDefaultSize,
  };

  function syncThemeToggle(theme) {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;

    const isDark = theme === 'dark';
    toggle.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    toggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');

    const label = toggle.querySelector('[data-theme-label]');
    if (label) label.textContent = isDark ? 'Dark' : 'Light';
  }

  function syncDefaultSizeToggle(size) {
    const next = normalizeSize(size);
    const toggle = document.getElementById('settings-size-toggle');
    if (!toggle) return;

    toggle.classList.toggle('is-small', next === 'small');
    toggle.querySelectorAll('button[data-size]').forEach((btn) => {
      const on = btn.dataset.size === next;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    const label = document.querySelector('[data-default-size-label]');
    if (label) label.textContent = next === 'small' ? 'Small' : 'Large';
  }

  function commitTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    syncThemeToggle(theme);
  }

  function applyTheme(theme, { animate = false } = {}) {
    const next = theme === 'dark' ? 'dark' : 'light';
    const root = document.documentElement;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shouldAnimate = animate && !reduceMotion;

    if (!shouldAnimate) {
      commitTheme(next);
      return;
    }

    // Prefer View Transitions for a true crossfade (gradients/images included).
    if (typeof document.startViewTransition === 'function') {
      const transition = document.startViewTransition(() => {
        commitTheme(next);
      });
      transition.finished.catch(() => {});
      return;
    }

    // Fallback: CSS property transitions while `.theme-transition` is active.
    root.classList.add('theme-transition');
    commitTheme(next);
    window.setTimeout(() => {
      root.classList.remove('theme-transition');
    }, 450);
  }

  function ensureSettingsModal() {
    let modal = document.getElementById('settings-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'settings-modal';
    modal.className = 'settings-modal';
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <button type="button" class="settings-modal__backdrop" data-settings-close aria-label="Close settings"></button>
      <div class="settings-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
        <div class="settings-modal__header">
          <h2 id="settings-modal-title">Settings</h2>
          <button type="button" class="settings-modal__close" data-settings-close aria-label="Close settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="settings-modal__body">
          <span class="settings-modal__section-label">Appearance</span>
          <button type="button" class="theme-toggle" id="theme-toggle" aria-pressed="false" aria-label="Switch to dark mode">
            <span class="theme-toggle-icon" aria-hidden="true">
              <svg class="theme-icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="4"/>
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
              </svg>
              <svg class="theme-icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z"/>
              </svg>
            </span>
            <span class="theme-toggle-meta">
              <span class="theme-toggle-label">Theme</span>
              <span class="theme-toggle-value" data-theme-label>Light</span>
            </span>
            <span class="theme-toggle-switch" aria-hidden="true">
              <span class="theme-toggle-knob"></span>
            </span>
          </button>

          <span class="settings-modal__section-label settings-modal__section-label--spaced">Stickers</span>
          <div class="settings-size-block">
            <div class="settings-size-row">
              <div class="settings-size-row__meta">
                <span class="settings-size-row__label">Default size</span>
                <span class="settings-size-row__value" data-default-size-label>Large</span>
              </div>
              <div class="size-toggle settings-size-toggle" id="settings-size-toggle" role="group" aria-label="Default sticker size">
                <button type="button" data-size="large" aria-pressed="true">Large</button>
                <button type="button" data-size="small" aria-pressed="false">Small</button>
              </div>
            </div>
            <p class="settings-size-hint">Applies on the next page reload. The Generate size toggle is unchanged until then.</p>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  function initSettings() {
    applyTheme(getTheme());

    const openBtn = document.getElementById('settings-open');
    const modal = ensureSettingsModal();
    const themeToggle = document.getElementById('theme-toggle');
    const sizeToggle = document.getElementById('settings-size-toggle');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let closing = false;
    let lastFocus = null;

    syncThemeToggle(getTheme());
    syncDefaultSizeToggle(getDefaultSize());

    function setOpenState(isOpen) {
      if (openBtn) openBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      modal.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
      document.body.classList.toggle('settings-modal-open', isOpen);
    }

    function openSettings() {
      if (!modal.hidden && modal.classList.contains('is-open')) return;

      closing = false;
      lastFocus = document.activeElement;
      modal.hidden = false;
      modal.classList.remove('is-closing');
      // Force reflow so the open transition runs.
      void modal.offsetWidth;
      modal.classList.add('is-open');
      setOpenState(true);

      window.requestAnimationFrame(() => {
        (themeToggle || modal.querySelector('[data-settings-close]'))?.focus();
      });
    }

    function closeSettings() {
      if (modal.hidden || closing) return;

      closing = true;
      modal.classList.add('is-closing');
      modal.classList.remove('is-open');
      setOpenState(false);

      const finish = () => {
        modal.hidden = true;
        modal.classList.remove('is-closing');
        closing = false;
        if (lastFocus && typeof lastFocus.focus === 'function') {
          lastFocus.focus();
        } else {
          openBtn?.focus();
        }
      };

      if (reduceMotion) {
        finish();
        return;
      }

      window.setTimeout(finish, 380);
    }

    openBtn?.addEventListener('click', openSettings);

    modal.querySelectorAll('[data-settings-close]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        closeSettings();
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (modal.hidden || !modal.classList.contains('is-open')) return;
      e.preventDefault();
      closeSettings();
    });

    themeToggle?.addEventListener('click', () => {
      const next = getTheme() === 'dark' ? 'light' : 'dark';
      setStoredTheme(next);
      applyTheme(next, { animate: true });
    });

    sizeToggle?.querySelectorAll('button[data-size]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setDefaultSize(btn.dataset.size);
      });
    });
  }

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

  // Mobile layout gate: inject overlay markup (visibility controlled in CSS).
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
      <p class="mobile-gate-text">This tool needs a larger screen. Open it on a desktop or laptop.</p>
    `;
    document.body.appendChild(gate);
  }

  function init() {
    initMobileGate();
    initSettings();
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
