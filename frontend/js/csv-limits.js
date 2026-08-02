(function () {
  // Keep in sync with allokit/worker.py MAX_BATCH_ROWS.
  const MAX_BATCH_ROWS = 1024;

  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (c === '\r') {
        // ignore CR; LF handles row ends
      } else {
        field += c;
      }
    }

    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }

    while (rows.length && rows[rows.length - 1].every((cell) => String(cell).trim() === '')) {
      rows.pop();
    }
    return rows;
  }

  async function countUrlRows(file) {
    const text = await file.text();
    const rows = parseCsvRows(text);
    if (rows.length === 0) return 0;

    const header = rows[0].map((cell) => String(cell).trim());
    const urlIdx = header.findIndex((name) => name.toUpperCase() === 'URL');
    if (urlIdx < 0) return 0;

    let count = 0;
    for (let i = 1; i < rows.length; i++) {
      const value = String(rows[i][urlIdx] ?? '').trim();
      if (value) count++;
    }
    return count;
  }

  function formatCount(n) {
    return Number(n).toLocaleString();
  }

  function tooManyRowsMessage(fileName, count) {
    const name = fileName || 'That CSV';
    const countBit = Number.isFinite(count)
      ? `packed in ${formatCount(count)} URLs`
      : 'has too many URLs';
    return `${name} ${countBit}. We stop at ${formatCount(MAX_BATCH_ROWS)} so the little generator doesn't pull a hamstring. Split it up and try again.`;
  }

  function showTooManyRowsNotice({ fileName, count } = {}) {
    if (!window.AllokitNotice?.show) {
      window.alert(tooManyRowsMessage(fileName, count));
      return;
    }
    window.AllokitNotice.show({
      title: "Whoa, that's a sticker stampede",
      message: tooManyRowsMessage(fileName, count),
      okLabel: "I'll split it",
      art: 'stampede',
    });
  }

  function isTooManyRowsError(text) {
    return /too many rows/i.test(String(text || ''));
  }

  function parseApiDetail(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.detail === 'string') return parsed.detail;
    } catch (_) {}
    return raw;
  }

  window.AllokitCsvLimits = {
    MAX_BATCH_ROWS,
    countUrlRows,
    showTooManyRowsNotice,
    isTooManyRowsError,
    parseApiDetail,
    tooManyRowsMessage,
  };
})();
