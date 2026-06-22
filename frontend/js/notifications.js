(function () {
  const STATES_KEY = 'allokitJobStates';
  const NOTIFS_KEY = 'allokitNotifications';
  const BATCHES_KEY = 'allokitNotificationBatches';
  const FOCUS_JOB_KEY = 'notificationJobId';
  const FOCUS_JOBS_KEY = 'notificationJobIds';
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

  function loadBatchState() {
    return loadJson(BATCHES_KEY, { batches: {}, jobToBatch: {} });
  }

  function saveBatchState(state) {
    saveJson(BATCHES_KEY, state);
  }

  function isTerminalStatus(status) {
    return status === 'ready' || status === 'failed' || status === 'cancelled';
  }

  function registerUploadBatch(batchId, expectedCount) {
    if (!batchId || expectedCount < 1) return;
    const state = loadBatchState();
    state.batches[batchId] = {
      expectedCount,
      jobIds: [],
      outcomes: {},
      notified: false,
    };
    saveBatchState(state);
  }

  function registerBatchJob(batchId, jobId) {
    if (!batchId || jobId == null) return;
    const state = loadBatchState();
    const batch = state.batches[batchId];
    if (!batch) return;

    const id = Number(jobId);
    if (!batch.jobIds.includes(id)) {
      batch.jobIds.push(id);
    }
    state.jobToBatch[String(id)] = batchId;
    saveBatchState(state);
  }

  function cleanupBatch(batchId) {
    const state = loadBatchState();
    const batch = state.batches[batchId];
    if (!batch) return;
    batch.jobIds.forEach((jobId) => {
      delete state.jobToBatch[String(jobId)];
    });
    delete state.batches[batchId];
    saveBatchState(state);
  }

  function cancelQueuedUploads(batchCounts) {
    if (!batchCounts || typeof batchCounts !== 'object') return;
    const state = loadBatchState();
    let changed = false;

    for (const [batchId, count] of Object.entries(batchCounts)) {
      const removed = Number(count);
      if (!removed) continue;
      const batch = state.batches[batchId];
      if (!batch) continue;

      batch.expectedCount = Math.max(batch.jobIds.length, batch.expectedCount - removed);
      changed = true;

      if (batch.expectedCount <= 0 && batch.jobIds.length === 0) {
        delete state.batches[batchId];
      }
    }

    if (changed) saveBatchState(state);
  }

  function formatJobIdRange(jobIds) {
    if (window.AllokitJobIds?.formatJobRef) {
      return window.AllokitJobIds.formatJobRef(jobIds);
    }
    const sorted = [...jobIds].sort((a, b) => a - b);
    if (sorted.length === 1) return `Job #${sorted[0]}`;
    return `Jobs #${sorted[0]}–${sorted[sorted.length - 1]}`;
  }

  function formatGroupedStatusMessage(kind, jobIds) {
    const count = jobIds.length;
    if (count === 1) return null;

    const countLabel = window.AllokitJobIds?.jobCountLabel
      ? window.AllokitJobIds.jobCountLabel(count)
      : `${count} jobs`;
    const verb = { ready: 'completed', failed: 'failed', cancelled: 'cancelled' }[kind];
    return `${countLabel} ${verb}`;
  }

  function batchIsFullyTerminal(batch) {
    if (batch.jobIds.length === 0) return false;
    if (batch.jobIds.length < batch.expectedCount) return false;
    return batch.jobIds.every((jobId) => {
      const outcome = batch.outcomes[String(jobId)];
      return outcome && isTerminalStatus(outcome.status);
    });
  }

  function buildGroupedNotification(kind, jobIds, outcomes) {
    const sorted = [...jobIds].sort((a, b) => a - b);
    const ref = formatJobIdRange(sorted);
    const isSingle = sorted.length === 1;
    const first = outcomes[String(sorted[0])] || {};
    const groupedMessage = formatGroupedStatusMessage(kind, sorted);

    let message;
    let title;

    if (kind === 'ready') {
      title = isSingle ? (first.name || 'Untitled job') : 'Batch upload';
      message = isSingle ? `${ref} · Ready` : groupedMessage;
    } else if (kind === 'failed') {
      title = isSingle ? (first.name || 'Untitled job') : 'Batch upload';
      message = isSingle
        ? `${ref} · ${first.error || 'Generation failed'}`
        : groupedMessage;
    } else {
      title = isSingle ? (first.name || 'Untitled job') : 'Batch upload';
      message = isSingle ? `${ref} · Cancelled` : groupedMessage;
    }

    const item = {
      id: `batch-${sorted.join('-')}-${kind}-${Date.now()}`,
      dedupeKey: `batch-${sorted.join('-')}-${kind}`,
      jobId: sorted[0],
      jobIds: sorted,
      kind,
      type: 'batch',
      grouped: !isSingle,
      read: false,
      timestamp: new Date().toISOString(),
      jobName: title,
      title,
      message,
    };

    if (kind === 'failed') {
      item.fullError = isSingle
        ? (first.error || 'Generation failed')
        : sorted.map((id) => {
            const outcome = outcomes[String(id)] || {};
            return `Job #${id}: ${outcome.error || 'Generation failed'}`;
          }).join('\n\n');
    }

    return item;
  }

  function buildBatchNotifications(batch, allJobs) {
    const jobsById = new Map((allJobs || []).map((job) => [job.id, job]));
    const byKind = { ready: [], failed: [], cancelled: [] };

    batch.jobIds.forEach((jobId) => {
      const stored = batch.outcomes[String(jobId)];
      const live = jobsById.get(jobId);
      const status = stored?.status || live?.status;
      if (status === 'ready') byKind.ready.push(jobId);
      else if (status === 'failed') byKind.failed.push(jobId);
      else if (status === 'cancelled') byKind.cancelled.push(jobId);
    });

    const outcomes = { ...batch.outcomes };
    batch.jobIds.forEach((jobId) => {
      if (outcomes[String(jobId)]) return;
      const live = jobsById.get(jobId);
      if (!live) return;
      outcomes[String(jobId)] = {
        status: live.status,
        name: live.name,
        error: live.error,
      };
    });

    const items = [];
    if (byKind.ready.length) items.push(buildGroupedNotification('ready', byKind.ready, outcomes));
    if (byKind.failed.length) items.push(buildGroupedNotification('failed', byKind.failed, outcomes));
    if (byKind.cancelled.length) items.push(buildGroupedNotification('cancelled', byKind.cancelled, outcomes));
    return items;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  function isTerminalNotificationKind(kind) {
    return kind === 'ready' || kind === 'failed' || kind === 'cancelled';
  }

  function buildNotification(job, kind) {
    const name = job.name || 'Untitled job';
    const jobRef = `Job #${job.id}`;

    const statusLine = {
      ready: 'Ready',
      failed: job.error ? String(job.error) : 'Generation failed',
      cancelled: 'Cancelled',
    }[kind];

    const base = {
      id: `${job.id}-${kind}-${Date.now()}`,
      dedupeKey: `${job.id}-${kind}`,
      jobId: job.id,
      kind,
      type: job.type,
      read: false,
      timestamp: new Date().toISOString(),
      jobName: name,
      title: name,
      message: `${jobRef} · ${statusLine}`,
    };

    if (kind === 'failed') {
      base.fullError = job.error ? String(job.error) : 'Generation failed';
    }

    return base;
  }

  function getNotificationError(item) {
    if (item?.fullError) return item.fullError;
    const msg = item?.message || '';
    const sep = ' · ';
    const idx = msg.indexOf(sep);
    if (idx !== -1) return msg.slice(idx + sep.length);
    return msg || 'Generation failed';
  }

  function collectTransitionNotifications(prevStatus, job, allJobs) {
    const items = [];

    if (prevStatus === job.status) {
      return items;
    }

    // A fast-failing job (e.g. an invalid-URL batch) can be observed for the
    // first time already terminal, so prevStatus is undefined. We still notify
    // in that case — the first-ever ingest is seeded separately in ingestJobs,
    // so this only fires for genuinely new terminal jobs (deduped downstream).
    if (!isTerminalStatus(job.status)) {
      return items;
    }

    const state = loadBatchState();
    const batchId = state.jobToBatch[String(job.id)];
    const batch = batchId ? state.batches[batchId] : null;

    if (!batch || batch.jobIds.length <= 1) {
      items.push(buildNotification(job, job.status));
      return items;
    }

    batch.outcomes[String(job.id)] = {
      status: job.status,
      name: job.name,
      error: job.error,
    };
    batch.notified = batch.notified || false;
    saveBatchState(state);

    if (!batchIsFullyTerminal(batch)) {
      return items;
    }

    if (batch.notified) {
      return items;
    }

    batch.notified = true;
    saveBatchState(state);

    items.push(...buildBatchNotifications(batch, allJobs));
    cleanupBatch(batchId);
    return items;
  }

  function appendNotifications(newItems) {
    if (newItems.length === 0) {
      renderUi();
      return;
    }

    const items = loadNotifications();
    const added = [];
    newItems.forEach((item) => {
      if (!item || !isTerminalNotificationKind(item.kind)) return;
      if (notificationExists(items, item.dedupeKey)) return;
      items.unshift(item);
      added.push(item);
    });
    saveNotifications(items);
    renderUi();
    maybeAutoReveal(added);
  }

  function isHistoryPage() {
    return !!document.getElementById('page-history');
  }

  // When a job finishes (ready/failed/cancelled) anywhere but the History
  // page, a compact popup slides down from the bell — same card style and
  // animation as the hover panel, but showing only the notification(s) that
  // just happened. Hovering the bell still reveals the full list. Clicking a
  // popup item navigates to Jobs & History (failed items open the error modal).
  const REVEAL_DISMISS_MS = 9000;
  const REVEAL_MAX_ITEMS = 3;
  let revealTimer = null;

  function pulseNotificationBell() {
    const btn = document.getElementById('notifications-btn');
    if (!btn) return;
    btn.classList.remove('has-bell-pop');
    void btn.offsetWidth;
    btn.classList.add('has-bell-pop');
    window.setTimeout(() => btn.classList.remove('has-bell-pop'), 480);
  }

  function cancelRevealDismiss() {
    if (revealTimer) {
      window.clearTimeout(revealTimer);
      revealTimer = null;
    }
  }

  function scheduleRevealDismiss() {
    cancelRevealDismiss();
    revealTimer = window.setTimeout(() => {
      revealTimer = null;
      hideReveal();
    }, REVEAL_DISMISS_MS);
  }

  function hideReveal() {
    const reveal = document.getElementById('notifications-reveal');
    if (!reveal) return;
    cancelRevealDismiss();
    reveal.classList.remove('is-open');
    reveal.setAttribute('aria-hidden', 'true');
  }

  function showReveal(items) {
    const reveal = document.getElementById('notifications-reveal');
    const list = document.getElementById('notifications-reveal-list');
    if (!reveal || !list || panelOpen) return;

    // Newest first, capped — we only surface what just happened.
    const shown = [...items].reverse().slice(0, REVEAL_MAX_ITEMS);
    list.innerHTML = shown.map(notificationItemHtml).join('');

    reveal.setAttribute('aria-hidden', 'false');
    reveal.classList.add('is-open');
    pulseNotificationBell();
    scheduleRevealDismiss();
  }

  function maybeAutoReveal(added) {
    const onHistory = isHistoryPage();
    const revealable = added.filter((item) => {
      // Manual single generations already show inline on the Generate page.
      if (item.type === 'single') return false;
      // Failures are important enough to surface on every page, History included.
      if (item.kind === 'failed') return true;
      // Other completions only pop outside the History page.
      return !onHistory;
    });
    if (revealable.length === 0) return;
    showReveal(revealable);
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

      newItems.push(...collectTransitionNotifications(prevStates[id], job, jobs));
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
    const newItems = collectTransitionNotifications(prevStates[id], job, [job]);
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
    navigateToHistoryGroup([Number(jobId)]);
  }

  function navigateToHistoryGroup(jobIds) {
    const ids = [...jobIds].map(Number).filter((id) => Number.isFinite(id)).sort((a, b) => a - b);
    if (ids.length === 0) return;

    const query = ids.length === 1
      ? String(ids[0])
      : (window.AllokitJobIds?.formatBatchFilterLabel
        ? window.AllokitJobIds.formatBatchFilterLabel(ids.length)
        : `${ids.length} batch jobs`);

    if (document.getElementById('page-history')) {
      window.dispatchEvent(new CustomEvent('allokit:focus-jobs', {
        detail: { jobIds: ids, query },
      }));
      return;
    }

    try {
      if (ids.length === 1) {
        sessionStorage.setItem(FOCUS_JOB_KEY, String(ids[0]));
        sessionStorage.removeItem(FOCUS_JOBS_KEY);
      } else {
        sessionStorage.setItem(FOCUS_JOBS_KEY, JSON.stringify(ids));
        sessionStorage.removeItem(FOCUS_JOB_KEY);
      }
      sessionStorage.setItem('searchQuery', query);
      sessionStorage.setItem('searchJobIds', JSON.stringify(ids));
      sessionStorage.setItem('searchFocus', '1');
      sessionStorage.setItem(TRANSITION_KEY, '1');
    } catch (_) {}

    const go = () => { window.location.href = 'history.html'; };

    if (PAGE_ANIM_MS === 0) {
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

  function notificationItemHtml(item) {
    return `
      <button type="button" class="notifications-item${item.read ? '' : ' notifications-item--unread'}${item.kind === 'failed' ? ' notifications-item--failed' : ''}" data-notif-id="${escapeHtml(item.id)}" data-job-id="${item.jobId}" data-kind="${escapeHtml(item.kind)}">
        <span class="notifications-item-icon notifications-item-icon--${escapeHtml(item.kind)}" aria-hidden="true">${kindIcon(item.kind)}</span>
        <span class="notifications-item-body">
          <span class="notifications-item-row">
            <span class="notifications-item-title">${escapeHtml(item.title)}</span>
            <span class="notifications-item-time">${escapeHtml(formatRelativeTime(item.timestamp))}</span>
          </span>
          <span class="notifications-item-message">${escapeHtml(item.message)}</span>
        </span>
      </button>
    `;
  }

  function renderList(listEl) {
    const items = loadNotifications().filter((item) => isTerminalNotificationKind(item.kind));
    const unread = unreadCount(items);

    if (items.length === 0) {
      listEl.innerHTML = '<p class="notifications-empty">No job activity yet. Submit a job on Generate to see updates here.</p>';
      return unread;
    }

    listEl.innerHTML = items.map(notificationItemHtml).join('');

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

    if (open) hideReveal();
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

  let errorModalOpen = false;

  function showErrorDetailModal(item) {
    const modal = document.getElementById('notifications-error-modal');
    const titleEl = document.getElementById('notifications-error-title');
    const metaEl = document.getElementById('notifications-error-meta');
    const bodyEl = document.getElementById('notifications-error-body');
    if (!modal || !titleEl || !metaEl || !bodyEl) return;

    const jobRef = item.grouped && item.jobIds?.length > 1
      ? (window.AllokitJobIds?.formatBatchFilterLabel
        ? window.AllokitJobIds.formatBatchFilterLabel(item.jobIds.length)
        : `${item.jobIds.length} batch jobs`)
      : `Job #${item.jobId}`;
    titleEl.textContent = item.title || item.jobName || 'Failed job';
    metaEl.textContent = jobRef;
    bodyEl.textContent = getNotificationError(item);

    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    errorModalOpen = true;
    document.body.classList.add('notifications-error-modal-open');

    const closeBtn = modal.querySelector('.notifications-error-close');
    closeBtn?.focus();
  }

  function closeErrorDetailModal() {
    const modal = document.getElementById('notifications-error-modal');
    if (!modal || modal.hidden) return;

    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    errorModalOpen = false;
    document.body.classList.remove('notifications-error-modal-open');
  }

  function handleNotificationClick(itemEl) {
    const notifId = itemEl.dataset.notifId;
    const kind = itemEl.dataset.kind;
    const item = loadNotifications().find((entry) => entry.id === notifId);

    markRead(notifId);

    if (kind === 'failed') {
      if (item) showErrorDetailModal(item);
      return;
    }

    setPanelOpen(false);

    if (item?.jobIds?.length > 1) {
      navigateToHistoryGroup(item.jobIds);
      return;
    }

    navigateToHistory(Number(item?.jobId ?? itemEl.dataset.jobId));
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
        <div class="notifications-reveal" id="notifications-reveal" role="status" aria-live="polite" aria-hidden="true">
          <div class="notifications-reveal-list" id="notifications-reveal-list"></div>
        </div>
      </div>
    `;

    const wrap = actions.querySelector('.notifications-wrap');
    const btn = document.getElementById('notifications-btn');
    const panel = document.getElementById('notifications-panel');
    const markReadBtn = document.getElementById('notifications-mark-read');
    const listEl = document.getElementById('notifications-list');
    const reveal = document.getElementById('notifications-reveal');
    const revealList = document.getElementById('notifications-reveal-list');

    reveal.addEventListener('mouseenter', cancelRevealDismiss);
    reveal.addEventListener('mouseleave', scheduleRevealDismiss);
    revealList.addEventListener('click', (e) => {
      const item = e.target.closest('.notifications-item');
      if (!item) return;
      hideReveal();
      handleNotificationClick(item);
    });

    if (canHover) {
      const hoverOpen = () => {
        cancelPanelClose();
        setPanelOpen(true);
      };

      const hoverMaybeClose = (e) => {
        const related = e.relatedTarget;
        if (related && (
          btn.contains(related) ||
          panel.contains(related)
        )) {
          return;
        }
        schedulePanelClose();
      };

      btn.addEventListener('mouseenter', hoverOpen);
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

    if (!document.getElementById('notifications-error-modal')) {
      document.body.insertAdjacentHTML('beforeend', `
        <div id="notifications-error-modal" class="notifications-error-modal" hidden aria-hidden="true">
          <button type="button" class="notifications-error-backdrop" aria-label="Close error details"></button>
          <div class="notifications-error-dialog" role="dialog" aria-modal="true" aria-labelledby="notifications-error-title">
            <div class="notifications-error-header">
              <div class="notifications-error-heading">
                <h2 id="notifications-error-title"></h2>
                <p id="notifications-error-meta" class="notifications-error-meta"></p>
              </div>
              <button type="button" class="notifications-error-close btn-icon" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
            <pre id="notifications-error-body" class="notifications-error-body"></pre>
          </div>
        </div>
      `);

      const errorModal = document.getElementById('notifications-error-modal');
      errorModal?.querySelector('.notifications-error-backdrop')?.addEventListener('click', closeErrorDetailModal);
      errorModal?.querySelector('.notifications-error-close')?.addEventListener('click', closeErrorDetailModal);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (errorModalOpen) {
        closeErrorDetailModal();
        return;
      }
      if (panelOpen) setPanelOpen(false);
    });
  }

  function initPolling() {
    if (pollTimer) return;
    pollJobs();
    pollTimer = window.setInterval(pollJobs, POLL_MS);
  }

  function init() {
    buildUi();
    const all = loadNotifications();
    const existing = all.filter((item) => isTerminalNotificationKind(item.kind));
    if (existing.length !== all.length || existing.length > MAX_NOTIFS) {
      saveNotifications(existing);
    }
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
    registerUploadBatch,
    registerBatchJob,
    cancelQueuedUploads,
    focusJobKey: FOCUS_JOB_KEY,
    focusJobsKey: FOCUS_JOBS_KEY,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
