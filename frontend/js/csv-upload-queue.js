(function () {
  const DB_NAME = 'allokit-csv-queue';
  const DB_VERSION = 1;
  const STORE = 'uploads';
  const LOCK_NAME = 'allokit-csv-queue';

  let processing = false;
  let userCancelled = false;
  let currentAbortController = null;
  const statusListeners = new Set();

  function apiBase() {
    return window.API_BASE ?? 'http://localhost:8000';
  }

  function mutateFetch(path, options) {
    if (window.allokitFetch) return window.allokitFetch(path, options);
    return fetch(`${apiBase()}${path}`, options);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readAll() {
    const db = await openDb();
    try {
      return await dbRequest(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    } finally {
      db.close();
    }
  }

  async function putItem(item) {
    const db = await openDb();
    try {
      await dbRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).put(item));
    } finally {
      db.close();
    }
  }

  async function deleteItem(id) {
    const db = await openDb();
    try {
      await dbRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
    } finally {
      db.close();
    }
  }

  async function resetStaleUploading() {
    const items = await readAll();
    await Promise.all(items
      .filter((item) => item.status === 'uploading')
      .map((item) => putItem({ ...item, status: 'pending' })));
  }

  async function getStatus() {
    const items = await readAll();
    const pending = items.filter((item) => item.status === 'pending').length;
    const uploading = items.filter((item) => item.status === 'uploading').length;
    const failed = items.filter((item) => item.status === 'failed').length;
    return {
      active: processing || pending > 0 || uploading > 0,
      pending,
      uploading,
      failed,
      total: items.length,
    };
  }

  function emitStatus(status) {
    const detail = status || {};
    statusListeners.forEach((fn) => {
      try { fn(detail); } catch (_) {}
    });
    window.dispatchEvent(new CustomEvent('allokit-csv-queue-update', { detail }));
  }

  async function uploadItem(item) {
    if (userCancelled) return null;

    await putItem({ ...item, status: 'uploading', error: null });

    const formData = new FormData();
    formData.append('name', item.name);
    formData.append('file', item.blob, item.fileName);
    // Idempotency key: if a navigation interrupts this upload after the job is
    // created but before we delete the queue item, the retry reuses the same
    // token so the server returns the existing job instead of duplicating it.
    formData.append('client_token', item.id);

    const abortController = new AbortController();
    currentAbortController = abortController;

    let res;
    try {
      res = await mutateFetch('/jobs/batch', {
        method: 'POST',
        body: formData,
        signal: abortController.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError' || userCancelled) {
        try { await deleteItem(item.id); } catch (_) {}
        return null;
      }
      throw err;
    } finally {
      if (currentAbortController === abortController) {
        currentAbortController = null;
      }
    }

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(detail || `Upload failed (${res.status})`);
    }

    const job = await res.json();

    if (userCancelled) {
      try {
        await mutateFetch(`/jobs/${job.id}/cancel`, { method: 'POST' });
      } catch (_) {}
      try { await deleteItem(item.id); } catch (_) {}
      return null;
    }

    if (item.batchId) {
      window.AllokitNotifications?.registerBatchJob?.(item.batchId, job.id);
    }
    await deleteItem(item.id);
    window.dispatchEvent(new CustomEvent('allokit-csv-queued', { detail: { job, fileName: item.fileName } }));
    return job;
  }

  async function processQueueInner() {
    if (processing) return;
    processing = true;

    try {
      await resetStaleUploading();

      while (true) {
        if (userCancelled) break;

        const items = await readAll();
        const next = items
          .filter((item) => item.status === 'pending')
          .sort((a, b) => a.createdAt - b.createdAt)[0];

        emitStatus(await getStatus());

        if (!next) break;

        try {
          await uploadItem(next);
        } catch (err) {
          if (err.name === 'AbortError' || userCancelled) {
            continue;
          }
          console.error(`Failed to queue ${next.fileName}:`, err);
          await putItem({
            ...next,
            status: 'failed',
            error: err.message || String(err),
          });
        }

        emitStatus(await getStatus());
      }
    } finally {
      processing = false;
      const status = await getStatus();
      emitStatus(status);

      if (status.failed > 0) {
        const failedCount = status.failed;
        window.setTimeout(async () => {
          alert(`${failedCount} file(s) could not be queued. Check the console for details.`);
          await clearFailed();
        }, 0);
      }
    }
  }

  function processQueue() {
    if (navigator.locks?.request) {
      return navigator.locks.request(LOCK_NAME, () => processQueueInner());
    }
    return processQueueInner();
  }

  async function enqueueFiles(files) {
    const csvFiles = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.csv'));
    if (csvFiles.length === 0) return 0;

    userCancelled = false;

    const batchId = crypto.randomUUID();
    window.AllokitNotifications?.registerUploadBatch?.(batchId, csvFiles.length);

    for (const file of csvFiles) {
      await putItem({
        id: crypto.randomUUID(),
        batchId,
        name: file.name.replace(/\.csv$/i, ''),
        fileName: file.name,
        blob: file,
        status: 'pending',
        error: null,
        createdAt: Date.now(),
      });
    }

    emitStatus(await getStatus());
    processQueue();
    return csvFiles.length;
  }

  async function clearFailed() {
    const items = await readAll();
    await Promise.all(
      items.filter((item) => item.status === 'failed').map((item) => deleteItem(item.id)),
    );
    emitStatus(await getStatus());
  }

  async function cancelAllPending() {
    userCancelled = true;
    if (currentAbortController) {
      currentAbortController.abort();
    }

    const items = await readAll();
    const batchCounts = {};
    let cleared = 0;

    for (const item of items) {
      if (item.status !== 'pending' && item.status !== 'uploading') continue;
      if (item.batchId) {
        batchCounts[item.batchId] = (batchCounts[item.batchId] || 0) + 1;
      }
      await deleteItem(item.id);
      cleared++;
    }

    if (Object.keys(batchCounts).length > 0) {
      window.AllokitNotifications?.cancelQueuedUploads?.(batchCounts);
    }

    const status = await getStatus();
    emitStatus(status);
    window.dispatchEvent(new CustomEvent('allokit-csv-queue-cancelled', { detail: { cleared } }));
    return { cleared, batchCounts };
  }

  function onStatusChange(fn) {
    statusListeners.add(fn);
    getStatus().then((status) => fn(status)).catch(() => {});
    return () => statusListeners.delete(fn);
  }

  window.AllokitCsvQueue = {
    enqueueFiles,
    processQueue,
    getStatus,
    clearFailed,
    cancelAllPending,
    onStatusChange,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { processQueue(); });
  } else {
    processQueue();
  }
})();
