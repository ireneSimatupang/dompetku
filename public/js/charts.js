// Small SVG chart helper, no libraries. Responsive: redraws when its container resizes.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const short = n => {
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(1).replace('.0', '') + ' T';
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + ' M';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' jt';
  if (a >= 1e3) return (n / 1e3).toFixed(0) + ' rb';
  return String(Math.round(n));
};

/**
 * trendChart(container, { labels, series: [{name, color, values}], type: 'line'|'bar', format })
 */
export function trendChart(container, opts) {
  container.classList.add('chart');
  container.innerHTML = '';
  const svgWrap = document.createElement('div');
  svgWrap.className = 'chart-svg';
  const tip = document.createElement('div');
  tip.className = 'chart-tip'; tip.hidden = true;
  container.append(svgWrap, tip);

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML = opts.series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('');
  container.prepend(legend);

  const fmt = opts.format || (v => v.toLocaleString('id-ID'));
  if (!opts.series.some(s => s.values.some(v => v))) {
    svgWrap.innerHTML = '<p class="empty-note chart-empty">Belum ada data di periode ini.</p>';
    return { destroy() {} };
  }
  let lastW = 0;

  function draw() {
    const W = Math.max(280, svgWrap.clientWidth);
    if (W === lastW) return; lastW = W;
    const H = W < 520 ? 210 : 260;
    const pad = { l: 46, r: 10, t: 12, b: 28 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const n = opts.labels.length;
    const all = opts.series.flatMap(s => s.values);
    const minV = Math.min(0, ...all);
    const maxV = niceMax(Math.max(...all, 0));
    const span = maxV - minV || 1;
    const y = v => pad.t + ih - ((v - minV) / span) * ih;
    const slot = iw / Math.max(1, n);
    const x = i => opts.type === 'bar' ? pad.l + slot * i + slot / 2 : pad.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.ariaLabel || 'Grafik tren' });
    // grid
    for (let g = 0; g <= 4; g++) {
      const v = minV + (span * g) / 4, yy = y(v);
      svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: 'grid' }));
      const t = el('text', { x: pad.l - 6, y: yy + 4, 'text-anchor': 'end', class: 'axis' }); t.textContent = short(v); svg.append(t);
    }
    // x labels
    const maxLabels = Math.max(2, Math.floor(iw / 58));
    const step = Math.ceil(n / maxLabels);
    opts.labels.forEach((lab, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      if (i === n - 1 && i % step !== 0 && (n - 1) % step < step / 2) return;
      const t = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'axis' }); t.textContent = lab; svg.append(t);
    });

    if (opts.type === 'bar') {
      const k = opts.series.length, bw = Math.max(2, Math.min(22, (slot * 0.72) / k));
      opts.series.forEach((s, si) => s.values.forEach((v, i) => {
        if (!v) return;
        const bx = x(i) - (bw * k) / 2 + si * bw;
        svg.append(el('rect', { x: bx, y: Math.min(y(v), y(0)), width: bw - 1, height: Math.max(1, Math.abs(y(v) - y(0))), rx: 2, fill: s.color }));
      }));
    } else {
      opts.series.forEach(s => {
        const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
        if (s.fill) svg.append(el('polygon', { points: `${x(0)},${y(Math.max(0, minV))} ${pts} ${x(n - 1)},${y(Math.max(0, minV))}`, fill: s.color, opacity: 0.12 }));
        svg.append(el('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2.25, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        if (n <= 31) s.values.forEach((v, i) => svg.append(el('circle', { cx: x(i), cy: y(v), r: 2.5, fill: s.color })));
      });
    }
    const cursor = el('line', { x1: 0, x2: 0, y1: pad.t, y2: pad.t + ih, class: 'cursor', visibility: 'hidden' });
    svg.append(cursor);

    const hit = el('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent' });
    svg.append(hit);
    const show = ev => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) * (W / r.width);
      let i = opts.type === 'bar' ? Math.floor((px - pad.l) / slot) : Math.round(((px - pad.l) / iw) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = `<b>${opts.labels[i]}</b>` + opts.series.map(s => `<div><i style="background:${s.color}"></i>${s.name}<span>${fmt(s.values[i])}</span></div>`).join('');
      const left = (x(i) / W) * r.width;
      tip.style.left = Math.min(Math.max(left, 70), r.width - 70) + 'px';
    };
    const hide = () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); };
    hit.addEventListener('mousemove', show);
    hit.addEventListener('touchstart', show, { passive: true });
    hit.addEventListener('touchmove', show, { passive: true });
    hit.addEventListener('mouseleave', hide);

    svgWrap.replaceChildren(svg);
  }

  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(svgWrap);
  return { destroy: () => ro.disconnect() };
}

// Horizontal share bars (category breakdown, account distribution) — plain HTML.
export function shareBars(container, items, { color = 'var(--keluar)', format } = {}) {
  const total = items.reduce((s, i) => s + Math.max(0, i.amount), 0);
  if (!items.length || total <= 0) { container.innerHTML = '<p class="empty-note">Belum ada data di periode ini.</p>'; return; }
  const max = Math.max(...items.map(i => i.amount));
  container.innerHTML = items.slice(0, 8).map(i => `
    <div class="share">
      <div class="share-top"><span>${escapeHtml(i.name)}</span><b>${format(i.amount)}</b></div>
      <div class="share-rail"><span style="width:${Math.max(1, (i.amount / max) * 100)}%;background:${i.color || color}"></span></div>
      <small>${Math.round((Math.max(0, i.amount) / total) * 100)}%</small>
    </div>`).join('');
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
