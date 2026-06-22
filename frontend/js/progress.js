function initProgressBar(el) {
  if (!el || el.dataset.inited) return;
  el.classList.add('progress-bar');
  el.innerHTML = `
    <div class="progress-bar__track" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar__fill"></div>
    </div>
    <span class="progress-bar__pct">0%</span>`;
  el.dataset.inited = '1';
}

function setProgressBar(el, percent, { active = false, cancelled = false } = {}) {
  if (!el) return;
  initProgressBar(el);
  const fill = el.querySelector('.progress-bar__fill');
  const track = el.querySelector('.progress-bar__track');
  const pct = el.querySelector('.progress-bar__pct');

  if (cancelled) {
    if (fill) fill.style.width = '0%';
    if (track) {
      track.setAttribute('aria-valuenow', '0');
      track.setAttribute('aria-valuetext', 'Cancelled');
    }
    if (pct) pct.textContent = '—';
    el.classList.remove('is-active', 'is-complete');
    el.classList.add('is-cancelled');
    return;
  }

  const value = Math.max(0, Math.min(100, Math.round(percent)));
  if (fill) fill.style.width = `${value}%`;
  if (track) {
    track.setAttribute('aria-valuenow', String(value));
    track.removeAttribute('aria-valuetext');
  }
  if (pct) pct.textContent = `${value}%`;

  el.classList.remove('is-cancelled');
  el.classList.toggle('is-active', active && value > 0 && value < 100);
  el.classList.toggle('is-complete', value >= 100);
}

function buildProgressBar(percent, { active = false, cancelled = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'progress-bar';

  if (cancelled) {
    wrap.classList.add('is-cancelled');
    wrap.innerHTML = `
      <div class="progress-bar__track" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" aria-valuetext="Cancelled">
        <div class="progress-bar__fill"></div>
      </div>
      <span class="progress-bar__pct">—</span>`;
    return wrap;
  }

  const value = Math.max(0, Math.min(100, Math.round(percent)));
  if (active && value > 0 && value < 100) wrap.classList.add('is-active');
  if (value >= 100) wrap.classList.add('is-complete');
  wrap.innerHTML = `
    <div class="progress-bar__track" role="progressbar" aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar__fill" style="width:${value}%"></div>
    </div>
    <span class="progress-bar__pct">${value}%</span>`;
  return wrap;
}
