(function () {
  const SEARCH_QUERY_KEY = 'searchQuery';
  const SEARCH_JOB_IDS_KEY = 'searchJobIds';
  const SEARCH_FOCUS_KEY = 'searchFocus';
  const TRANSITION_KEY = 'pageTransition';
  const PAGE_ANIM_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
  const SEARCH_ARRIVE_MS = PAGE_ANIM_MS === 0 ? 0 : 160;

  const searchField = document.getElementById('search-field');
  if (!searchField) return;

  let activeJobIds = null;
  let applyingProgrammaticSearch = false;

  function initSearchClear() {
    const searchWrap = searchField.closest('.search-wrap');
    if (!searchWrap || searchWrap.querySelector('.search-clear')) return () => {};

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'search-clear';
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.hidden = true;
    clearBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<line x1="18" y1="6" x2="6" y2="18"/>' +
      '<line x1="6" y1="6" x2="18" y2="18"/>' +
      '</svg>';
    searchWrap.appendChild(clearBtn);

    function updateClearVisibility() {
      clearBtn.hidden = !searchField.value;
    }

    clearBtn.addEventListener('mousedown', (e) => e.stopPropagation());

    clearBtn.addEventListener('click', () => {
      searchField.value = '';
      searchField.focus();
      updateClearVisibility();
      searchField.dispatchEvent(new Event('input', { bubbles: true }));
    });

    searchField.addEventListener('input', updateClearVisibility);
    updateClearVisibility();
    return updateClearVisibility;
  }

  const updateClearVisibility = initSearchClear();

  const isHistoryPage = !!document.getElementById('page-history');
  const isGeneratePage = !!document.getElementById('page-generate');
  const isPrintGuidePage = !!document.getElementById('page-print-guide');

  function formatJobIdSetLabel(jobIds) {
    const ids = [...jobIds].map(Number).filter((id) => Number.isFinite(id));
    if (ids.length === 1) return String(ids[0]);
    if (window.AllokitJobIds?.formatBatchFilterLabel) {
      return window.AllokitJobIds.formatBatchFilterLabel(ids.length);
    }
    return `${ids.length} batch jobs`;
  }

  function setJobIdFilter(jobIds) {
    const ids = [...jobIds].map(Number).filter((id) => Number.isFinite(id));
    activeJobIds = ids.length > 0 ? new Set(ids) : null;
    return ids;
  }

  function clearJobIdFilter() {
    activeJobIds = null;
  }

  function hasJobIdFilter() {
    return Boolean(activeJobIds && activeJobIds.size > 0);
  }

  function getQuery() {
    return searchField.value.trim();
  }

  function filterJobs(jobs, query) {
    if (activeJobIds && activeJobIds.size > 0) {
      return jobs.filter((job) => activeJobIds.has(job.id));
    }

    const q = (query != null ? query : getQuery()).trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((job) =>
      String(job.id).includes(q) ||
      job.name.toLowerCase().includes(q) ||
      job.type.toLowerCase().includes(q) ||
      job.status.toLowerCase().includes(q)
    );
  }

  function applySearchState(query, jobIds) {
    applyingProgrammaticSearch = true;
    if (Array.isArray(jobIds) && jobIds.length > 0) {
      setJobIdFilter(jobIds);
    } else {
      clearJobIdFilter();
    }
    searchField.value = query || '';
    updateClearVisibility();
    applyingProgrammaticSearch = false;
  }

  function navigateToHistoryWithSearch(query, jobIds) {
    try {
      sessionStorage.setItem(SEARCH_QUERY_KEY, query || '');
      if (Array.isArray(jobIds) && jobIds.length > 0) {
        sessionStorage.setItem(SEARCH_JOB_IDS_KEY, JSON.stringify(jobIds.map(Number)));
      } else {
        sessionStorage.removeItem(SEARCH_JOB_IDS_KEY);
      }
      sessionStorage.setItem(SEARCH_FOCUS_KEY, '1');
      sessionStorage.setItem(TRANSITION_KEY, '1');
    } catch (_) {}

    if (PAGE_ANIM_MS === 0) {
      window.location.href = 'history.html';
      return;
    }

    const main = document.querySelector('main');
    if (!main) {
      window.location.href = 'history.html';
      return;
    }

    main.classList.add('is-exiting');
    window.setTimeout(() => {
      window.location.href = 'history.html';
    }, PAGE_ANIM_MS);
  }

  if (isGeneratePage || isPrintGuidePage) {
    let redirecting = false;
    const searchWrap = searchField.closest('.search-wrap');

    function goToHistorySearch() {
      if (redirecting) return;
      redirecting = true;
      navigateToHistoryWithSearch(getQuery());
    }

    if (searchWrap) {
      searchWrap.addEventListener('mousedown', (e) => {
        e.preventDefault();
        goToHistorySearch();
      });
    }

    searchField.addEventListener('focus', goToHistorySearch);
  }

  if (isHistoryPage) {
    let restoredQuery = '';
    let restoredJobIds = [];
    let shouldFocusSearch = false;
    try {
      restoredQuery = sessionStorage.getItem(SEARCH_QUERY_KEY) || '';
      const rawJobIds = sessionStorage.getItem(SEARCH_JOB_IDS_KEY);
      if (rawJobIds) {
        restoredJobIds = JSON.parse(rawJobIds);
        sessionStorage.removeItem(SEARCH_JOB_IDS_KEY);
      }
      shouldFocusSearch = sessionStorage.getItem(SEARCH_FOCUS_KEY) === '1';
      sessionStorage.removeItem(SEARCH_QUERY_KEY);
      sessionStorage.removeItem(SEARCH_FOCUS_KEY);
    } catch (_) {}

    if (restoredJobIds.length > 0) {
      applySearchState(restoredQuery || formatJobIdSetLabel(restoredJobIds), restoredJobIds);
    } else if (restoredQuery) {
      searchField.value = restoredQuery;
      updateClearVisibility();
    }

    searchField.addEventListener('input', () => {
      if (applyingProgrammaticSearch) return;
      if (hasJobIdFilter()) {
        clearJobIdFilter();
      }
    });

    function releaseSearchArriveStyles() {
      const root = document.documentElement;
      if (!root.classList.contains('search-arrive')) return;

      const clear = () => root.classList.remove('search-arrive');
      if (SEARCH_ARRIVE_MS === 0) {
        clear();
        return;
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.setTimeout(clear, SEARCH_ARRIVE_MS);
        });
      });
    }

    if (shouldFocusSearch || restoredQuery) {
      searchField.focus();
      if (restoredQuery) {
        const len = restoredQuery.length;
        searchField.setSelectionRange(len, len);
      }
      releaseSearchArriveStyles();
    }

    window.AllokitSearch = {
      filterJobs,
      getQuery,
      setJobIdFilter,
      clearJobIdFilter,
      hasJobIdFilter,
      formatJobIdSetLabel,
      applySearchState,
      bind(onQueryChange) {
        searchField.addEventListener('input', () => onQueryChange(getQuery()));
      },
    };
  }
})();
