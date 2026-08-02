(function () {
  const CLOSE_MS = 220;
  const MODAL_VERSION = '14';
  let closeTimer = null;
  let lastFocus = null;

  const STAMPEDE_ART = `
    <svg class="app-notice-art__svg" viewBox="0 0 340 156" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="an-sky" x1="0" y1="0" x2="0" y2="1">
          <stop class="app-notice-art__sky-top" offset="0%"/>
          <stop class="app-notice-art__sky-bot" offset="100%"/>
        </linearGradient>
        <filter id="an-soft" x="-15%" y="-15%" width="130%" height="130%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.14"/>
        </filter>
      </defs>

      <rect width="340" height="156" fill="url(#an-sky)"/>
      <ellipse class="app-notice-art__ground" cx="170" cy="138" rx="120" ry="9"/>

      <!-- Sticker 1 -->
      <g filter="url(#an-soft)" transform="translate(34 72) rotate(-8)">
        <path class="app-notice-art__speed" d="M-12 14h9M-14 24h11M-10 34h7"/>
        <rect class="app-notice-art__sticker app-notice-art__sticker--a" x="0" y="0" width="44" height="44" rx="10"/>
        <g class="app-notice-art__qr">
          <rect x="9" y="9" width="9" height="9" rx="1.5"/>
          <rect x="26" y="9" width="9" height="9" rx="1.5"/>
          <rect x="9" y="26" width="9" height="9" rx="1.5"/>
          <rect x="24" y="24" width="5" height="5" rx="1"/>
          <rect x="31" y="31" width="4" height="4" rx="1"/>
        </g>
        <path class="app-notice-art__legs" d="M14 46c0 7-4 11-4 11M30 46c2 6 6 10 6 10"/>
      </g>

      <!-- Sticker 2 -->
      <g filter="url(#an-soft)" transform="translate(96 62) rotate(4)">
        <path class="app-notice-art__speed" d="M-13 16h10M-15 28h12"/>
        <rect class="app-notice-art__sticker app-notice-art__sticker--b" x="0" y="0" width="48" height="48" rx="11"/>
        <g class="app-notice-art__qr">
          <rect x="10" y="10" width="10" height="10" rx="1.5"/>
          <rect x="28" y="10" width="10" height="10" rx="1.5"/>
          <rect x="10" y="28" width="10" height="10" rx="1.5"/>
          <rect x="27" y="27" width="5" height="5" rx="1"/>
          <rect x="34" y="34" width="4" height="4" rx="1"/>
        </g>
        <path class="app-notice-art__legs" d="M15 50c-1 8-6 12-6 12M34 50c3 7 8 11 8 11"/>
      </g>

      <!-- Sticker 3 (airborne) -->
      <g class="app-notice-art__runner--air">
        <g filter="url(#an-soft)" transform="translate(158 42) rotate(-12)">
          <rect class="app-notice-art__sticker app-notice-art__sticker--c" x="0" y="0" width="42" height="42" rx="10"/>
          <g class="app-notice-art__qr">
            <rect x="9" y="9" width="8" height="8" rx="1.5"/>
            <rect x="25" y="9" width="8" height="8" rx="1.5"/>
            <rect x="9" y="25" width="8" height="8" rx="1.5"/>
            <rect x="23" y="23" width="5" height="5" rx="1"/>
          </g>
          <path class="app-notice-art__legs" d="M13 44c1 6-2 10-2 10M29 44c4 5 7 9 7 9"/>
        </g>
      </g>

      <!-- Quiet little generator -->
      <g filter="url(#an-soft)" transform="translate(228 48)">
        <rect class="app-notice-art__bot-body" x="8" y="28" width="72" height="54" rx="14"/>
        <rect class="app-notice-art__bot-screen" x="18" y="38" width="52" height="28" rx="8"/>
        <text class="app-notice-art__bot-face" x="44" y="56" text-anchor="middle">x_x</text>
        <rect class="app-notice-art__bot-slot" x="26" y="72" width="36" height="4" rx="2"/>
        <circle class="app-notice-art__bot-knob" cx="68" cy="74" r="3"/>
        <path class="app-notice-art__bot-arm" d="M10 50c-9-7-13-3-15 2"/>
        <path class="app-notice-art__bot-arm" d="M78 50c9-7 13-3 15 2"/>
        <g class="app-notice-art__sweat">
          <path d="M20 24c0 3.5 2.4 5 2.4 5s2.4-1.5 2.4-5-2.4-5.5-2.4-5.5S20 20.5 20 24z"/>
          <path d="M78 20c0 3 2 4.4 2 4.4s2-1.4 2-4.4-2-5-2-5-2 2-2 5z"/>
        </g>
        <path class="app-notice-art__puff" d="M70 28c3.5-5 1.5-8.5-1-10 4 0 7 3.5 6 8 3.5 0 5.5 2.5 4.5 5h-12c1-1.5 1.8-2.5 2.5-3z"/>
      </g>
    </svg>
  `;

  function ensureModal() {
    let modal = document.getElementById('app-notice-modal');
    if (modal && modal.dataset.version !== MODAL_VERSION) {
      modal.remove();
      modal = null;
    }
    if (modal) return modal;

    document.body.insertAdjacentHTML('beforeend', `
      <div id="app-notice-modal" class="app-notice-modal" data-version="${MODAL_VERSION}" hidden>
        <button type="button" class="app-notice-modal__backdrop" data-app-notice-close aria-label="Close"></button>
        <div class="app-notice-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="app-notice-title">
          <div class="app-notice-art" id="app-notice-art" hidden>${STAMPEDE_ART}</div>
          <div class="app-notice-modal__copy">
            <h2 id="app-notice-title"></h2>
            <p id="app-notice-message"></p>
          </div>
          <div class="app-notice-modal__footer">
            <button type="button" class="app-notice-modal__ok" data-app-notice-close id="app-notice-ok">Got it</button>
          </div>
        </div>
      </div>
    `);

    modal = document.getElementById('app-notice-modal');
    modal.querySelectorAll('[data-app-notice-close]').forEach((el) => {
      el.addEventListener('click', () => hide());
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.hidden) hide();
    });
    return modal;
  }

  function hide() {
    const modal = document.getElementById('app-notice-modal');
    if (!modal || modal.hidden) return;

    const finish = () => {
      modal.hidden = true;
      modal.classList.remove('is-open', 'is-closing', 'app-notice-modal--art');
      document.body.classList.remove('app-notice-modal-open');
      if (lastFocus && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus(); } catch (_) {}
      }
      lastFocus = null;
    };

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      finish();
      return;
    }

    modal.classList.add('is-closing');
    modal.classList.remove('is-open');
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = window.setTimeout(finish, CLOSE_MS);
  }

  function show({ title, message, okLabel, art } = {}) {
    const modal = ensureModal();
    const titleEl = document.getElementById('app-notice-title');
    const messageEl = document.getElementById('app-notice-message');
    const okBtn = document.getElementById('app-notice-ok');
    const artEl = document.getElementById('app-notice-art');
    const showArt = art === 'stampede';

    titleEl.textContent = title || 'Heads up';
    messageEl.textContent = message || '';
    okBtn.textContent = okLabel || 'Got it';
    artEl.hidden = !showArt;
    modal.classList.toggle('app-notice-modal--art', showArt);

    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }

    lastFocus = document.activeElement;
    document.body.classList.add('app-notice-modal-open');
    modal.hidden = false;
    modal.classList.remove('is-closing');
    void modal.offsetWidth;
    modal.classList.add('is-open');
    okBtn.focus();
  }

  window.AllokitNotice = { show, hide };
})();
