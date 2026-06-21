(function () {
  const STATES_KEY = 'allokitJobStates';
  const NOTIFS_KEY = 'allokitNotifications';
  const FOCUS_JOB_KEY = 'notificationJobId';
  const TRANSITION_KEY = 'pageTransition';
  const MAX_NOTIFS = 20;
  const POLL_MS = 15000;
  const PAGE_ANIM_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;

  const apiBase = typeof API_BASE !== 'undefined' ? API_BASE : 'http://localhost:8000';

  let panelOpen = false;
  let pollTimer = null;
  let closeTimer = null;
  const HOVER_CLOSE_MS = 200;
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function loadNotifications() {
    return loadJson(NOTIFS_KEY, []);
  }

  function saveNotifications(items) {
    saveJson(NOTIFS_KEY, items.slice(0, MAX_NOTIFS));
  }

  function loadJobStates() {
    return loadJson(STATES_KEY, null);
  }

  function saveJobStates(states) {
    saveJson(STATES_KEY, states);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function stickerLabel(count) {
    const n = Number(count) || 1;
    return n === 1 ? '1 sticker' : `${n.toLocaleString()} stickers`;
  }

  function formatRelativeTime(iso) {
    try {
      const diffMs = Date.now() - new Date(iso).getTime();
      const sec = Math.floor(diffMs / 1000);
      if (sec < 10) return 'Just now';
      if (sec < 60) return `${sec}s ago`;
      const min = Math.floor(sec / 60);
      if (min < 60) return min === 1 ? '1 min ago' : `${min} min ago`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr === 1 ? '1 hr ago' : `${hr} hr ago`;
      const day = Math.floor(hr / 24);
      return day === 1 ? '1 day ago' : `${day} days ago`;
    } catch (_) {
      return '';
    }
  }

  function notificationExists(items, dedupeKey) {
    return items.some((item) => item.dedupeKey === dedupeKey);
  }

  function buildNotification(job, kind) {
    const name = job.name || 'Untitled job';
    const jobRef = `Job #${job.id}`;
    const countText = stickerLabel(job.sticker_count);

    const statusLine = {
      queued: `Queued · ${countText}`,
      generating: 'Generating',
      ready: 'Ready',
      failed: job.error ? String(job.error) : 'Generation failed',
      cancelled: 'Cancelled',
    }[kind];

    const base = {
      id: `${job.id}-${kind}-${Date.now()}`,
      dedupeKey: `${job.id}-${kind}`,
      jobId: job.id,
      kind,
      read: false,
      timestamp: new Date().toISOString(),
      jobName: name,
      title: name,
      message: `${jobRef} · ${statusLine}`,
    };

    return base;
  }

  function collectTransitionNotifications(prevStatus, job) {
    const items = [];

    if (prevStatus === undefined) {
      if (job.status === 'waiting') {
        items.push(buildNotification(job, 'queued'));
        return items;
      }
      items.push(buildNotification(job, 'queued'));
    } else if (prevStatus === job.status) {
      return items;
    } else if (job.status === 'generating' && prevStatus === 'waiting') {
      items.push(buildNotification(job, 'generating'));
      return items;
    } else if (job.status === 'ready') {
      items.push(buildNotification(job, 'ready'));
      return items;
    } else if (job.status === 'failed') {
      items.push(buildNotification(job, 'failed'));
      return items;
    } else if (job.status === 'cancelled') {
      items.push(buildNotification(job, 'cancelled'));
      return items;
    } else {
      return items;
    }

    if (job.status === 'generating') items.push(buildNotification(job, 'generating'));
    else if (job.status === 'ready') items.push(buildNotification(job, 'ready'));
    else if (job.status === 'failed') items.push(buildNotification(job, 'failed'));
    else if (job.status === 'cancelled') items.push(buildNotification(job, 'cancelled'));

    return items;
  }

  function appendNotifications(newItems) {
    if (newItems.length === 0) {
      renderUi();
      return;
    }

    const items = loadNotifications();
    newItems.forEach((item) => {
      if (!item || notificationExists(items, item.dedupeKey)) return;
      items.unshift(item);
    });
    saveNotifications(items);
    renderUi();
  }

  function ingestJobs(jobs) {
    if (!Array.isArray(jobs)) return;

    const prevStates = loadJobStates();
    const nextStates = {};
    const newItems = [];

    jobs.forEach((job) => {
      const id = String(job.id);
      nextStates[id] = job.status;

      if (!prevStates) return;

      newItems.push(...collectTransitionNotifications(prevStates[id], job));
    });

    saveJobStates(nextStates);

    if (!prevStates) {
      renderUi();
      return;
    }

    appendNotifications(newItems);
  }

  function ingestJobUpdate(job) {
    if (!job?.id || !job?.status) return;

    let prevStates = loadJobStates();
    if (!prevStates) {
      prevStates = {};
    }

    const id = String(job.id);
    const newItems = collectTransitionNotifications(prevStates[id], job);
    saveJobStates({ ...prevStates, [id]: job.status });
    appendNotifications(newItems);
  }

  async function pollJobs() {
    try {
      const res = await fetch(`${apiBase}/jobs`);
      if (!res.ok) return;
      ingestJobs(await res.json());
    } catch (_) {}
  }

  function unreadCount(items) {
    return items.filter((item) => !item.read).length;
  }

  function navigateToHistory(jobId) {
    const jobIdStr = String(jobId);

    if (document.getElementById('page-history')) {
      window.dispatchEvent(new CustomEvent('allokit:focus-job', { detail: { jobId: jobIdStr } }));
      return;
    }

    try {
      sessionStorage.setItem(FOCUS_JOB_KEY, jobIdStr);
      sessionStorage.setItem('searchQuery', jobIdStr);
      sessionStorage.setItem(TRANSITION_KEY, '1');
    } catch (_) {}

    const go = () => { window.location.href = 'history.html'; };

    if (PAGE_ANIM_MS === 0 || document.getElementById('page-history')) {
      go();
      return;
    }

    const main = document.querySelector('main');
    if (!main) {
      go();
      return;
    }

    main.classList.add('is-exiting');
    window.setTimeout(go, PAGE_ANIM_MS);
  }

  function markAllRead() {
    const items = loadNotifications().map((item) => ({ ...item, read: true }));
    saveNotifications(items);
    renderUi();
  }

  function markRead(id) {
    const items = loadNotifications().map((item) =>
      item.id === id ? { ...item, read: true } : item
    );
    saveNotifications(items);
    renderUi();
  }

  function kindIcon(kind) {
    if (kind === 'ready') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
    }
    if (kind === 'failed') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    }
    if (kind === 'cancelled') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
    }
    if (kind === 'generating') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  }

  function renderList(listEl) {
    const items = loadNotifications();
    const unread = unreadCount(items);

    if (items.length === 0) {
      listEl.innerHTML = '<p class="notifications-empty">No job activity yet. Submit a job on Generate to see updates here.</p>';
      return unread;
    }

    listEl.innerHTML = items.map((item) => `
      <button type="button" class="notifications-item" data-notif-id="${escapeHtml(item.id)}" data-job-id="${item.jobId}" data-kind="${escapeHtml(item.kind)}">
        <span class="notifications-item-icon notifications-item-icon--${escapeHtml(item.kind)}" aria-hidden="true">${kindIcon(item.kind)}</span>
        <span class="notifications-item-body">
          <span class="notifications-item-row">
            <span class="notifications-item-title">${escapeHtml(item.title)}</span>
            <span class="notifications-item-time">${escapeHtml(formatRelativeTime(item.timestamp))}</span>
          </span>
          <span class="notifications-item-message">${escapeHtml(item.message)}</span>
        </span>
      </button>
    `).join('');

    return unread;
  }

  function updateBadge(btn, unread) {
    const dot = btn.querySelector('.notification-dot');
    const show = unread > 0 && !panelOpen;

    if (dot) {
      dot.hidden = !show;
      dot.setAttribute('aria-hidden', show ? 'false' : 'true');
    }

    const label = unread > 0
      ? `Notifications, ${unread} unread`
      : 'Notifications';
    btn.setAttribute('aria-label', label);
  }

  function renderUi() {
    const btn = document.getElementById('notifications-btn');
    const listEl = document.getElementById('notifications-list');
    if (!btn || !listEl) return;

    const unread = renderList(listEl);
    updateBadge(btn, unread);
  }

  function setPanelOpen(open) {
    const wrap = document.querySelector('.notifications-wrap');
    const btn = document.getElementById('notifications-btn');
    const panel = document.getElementById('notifications-panel');
    if (!wrap || !btn || !panel) return;

    panelOpen = open;
    wrap.classList.toggle('notifications-wrap--open', open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('is-active', open);
    renderUi();
  }

  function cancelPanelClose() {
    if (closeTimer) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function schedulePanelClose() {
    cancelPanelClose();
    closeTimer = window.setTimeout(() => setPanelOpen(false), HOVER_CLOSE_MS);
  }

  function handleNotificationClick(itemEl) {
    const notifId = itemEl.dataset.notifId;
    const jobId = Number(itemEl.dataset.jobId);

    markRead(notifId);
    setPanelOpen(false);
    navigateToHistory(jobId);
  }

  function buildUi() {
    const actions = document.querySelector('.topbar-actions');
    if (!actions || document.getElementById('notifications-btn')) return;

    actions.innerHTML = `
      <div class="notifications-wrap">
        <button type="button" class="btn-icon" id="notifications-btn" aria-label="Notifications" aria-expanded="false" aria-haspopup="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
          <span class="notification-dot" hidden aria-hidden="true"></span>
        </button>
        <div class="notifications-panel" id="notifications-panel" role="region" aria-label="Notifications" aria-hidden="true">
          <div class="notifications-panel-header">
            <h2>Notifications</h2>
            <button type="button" class="notifications-mark-read" id="notifications-mark-read">Mark all read</button>
          </div>
          <div class="notifications-list" id="notifications-list"></div>
        </div>
      </div>
    `;

    const wrap = actions.querySelector('.notifications-wrap');
    const btn = document.getElementById('notifications-btn');
    const panel = document.getElementById('notifications-panel');
    const markReadBtn = document.getElementById('notifications-mark-read');
    const listEl = document.getElementById('notifications-list');

    if (canHover) {
      const hoverOpen = () => {
        cancelPanelClose();
        setPanelOpen(true);
      };

      const hoverMaybeClose = (e) => {
        if (wrap.contains(e.relatedTarget)) return;
        schedulePanelClose();
      };

      wrap.addEventListener('mouseenter', hoverOpen);
      btn.addEventListener('mouseleave', hoverMaybeClose);
      panel.addEventListener('mouseenter', hoverOpen);
      panel.addEventListener('mouseleave', hoverMaybeClose);
    } else {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setPanelOpen(!panelOpen);
      });

      document.addEventListener('click', (e) => {
        if (!panelOpen) return;
        if (e.target.closest('.notifications-wrap')) return;
        setPanelOpen(false);
      });
    }

    btn.addEventListener('focus', () => {
      cancelPanelClose();
      setPanelOpen(true);
    });

    wrap.addEventListener('focusout', (e) => {
      if (wrap.contains(e.relatedTarget)) return;
      schedulePanelClose();
    });

    markReadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      markAllRead();
    });

    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.notifications-item');
      if (!item) return;
      handleNotificationClick(item);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panelOpen) setPanelOpen(false);
    });
  }

  function initPolling() {
    if (pollTimer) return;
    pollJobs();
    pollTimer = window.setInterval(pollJobs, POLL_MS);
  }

  function init() {
    buildUi();
    const existing = loadNotifications();
    if (existing.length > MAX_NOTIFS) saveNotifications(existing);
    renderUi();
    window.setInterval(renderUi, 60000);
    // Generate & History already call ingestJobs() with their own refresh; poll only elsewhere.
    if (!document.getElementById('page-generate') && !document.getElementById('page-history')) {
      initPolling();
    }
  }

  window.AllokitNotifications = {
    ingestJobs,
    ingestJobUpdate,
    focusJobKey: FOCUS_JOB_KEY,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
