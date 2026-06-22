(function () {
  function normalizeJobIds(jobIds) {
    return [...jobIds].map(Number).filter((id) => Number.isFinite(id)).sort((a, b) => a - b);
  }

  function compressSegments(sorted) {
    if (sorted.length === 0) return [];

    const segments = [];
    let start = sorted[0];
    let end = sorted[0];

    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] === end + 1) {
        end = sorted[i];
        continue;
      }
      segments.push([start, end]);
      start = sorted[i];
      end = sorted[i];
    }

    segments.push([start, end]);
    return segments;
  }

  function isContiguous(sorted) {
    if (sorted.length <= 1) return true;
    return sorted.every((id, index) => id === sorted[0] + index);
  }

  function formatSegmentList(sorted, { hashPrefix = true } = {}) {
    const segments = compressSegments(sorted);
    const hash = hashPrefix ? '#' : '';

    return segments.map(([start, end]) => {
      if (start === end) return `${hash}${start}`;
      return `${hash}${start}–${hash}${end}`;
    }).join(', ');
  }

  /** Notification copy: "Job #500" or "#500–502, #504, #506–509" */
  function formatJobRef(jobIds) {
    const sorted = normalizeJobIds(jobIds);
    if (sorted.length === 0) return '';
    if (sorted.length === 1) return `Job #${sorted[0]}`;
    if (isContiguous(sorted)) return `Jobs #${sorted[0]}–${sorted[sorted.length - 1]}`;
    return formatSegmentList(sorted, { hashPrefix: true });
  }

  /** Search field label: "500" or "500–502, 504, 506–509" */
  function formatSearchLabel(jobIds) {
    const sorted = normalizeJobIds(jobIds);
    if (sorted.length === 0) return '';
    if (sorted.length === 1) return String(sorted[0]);
    if (isContiguous(sorted)) return `${sorted[0]}-${sorted[sorted.length - 1]}`;
    return formatSegmentList(sorted, { hashPrefix: false });
  }

  function jobCountLabel(count) {
    return count === 1 ? '1 job' : `${count} jobs`;
  }

  function formatBatchFilterLabel(count) {
    if (count === 1) return '1 batch job';
    return `${count} batch jobs`;
  }

  window.AllokitJobIds = {
    normalizeJobIds,
    compressSegments,
    isContiguous,
    formatSegmentList,
    formatJobRef,
    formatSearchLabel,
    formatBatchFilterLabel,
    jobCountLabel,
  };
})();
