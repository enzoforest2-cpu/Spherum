
function mountSpherumLogo(host, o) {
  const NS = 'http://www.w3.org/2000/svg', CX = 23, CY = 27, RX = 22.5, RY = 7.2, T = -20 * Math.PI / 180;
  const mk = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const svg = mk('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true' }); svg.style.cssText = 'display:block;overflow:visible';
  const gB = mk('g', { transform: 'rotate(-20 23 27)' }), gF = mk('g', { transform: 'rotate(-20 23 27)' });
  const oB = mk('path', { d: 'M0.5 27 A22.5 7.2 0 0 1 45.5 27', fill: 'none', 'stroke-width': 1.8 });
  const oF = mk('path', { d: 'M0.5 27 A22.5 7.2 0 0 0 45.5 27', fill: 'none', 'stroke-width': 1.8 });
  const dB = mk('circle', { r: 3.8, 'stroke-width': 1.6 }), dF = mk('circle', { r: 3.8, 'stroke-width': 1.6 });
  const sph = mk('circle', { cx: CX, cy: CY, r: 16.5 });
  const eyes = [0, 1].map(() => ({ r: mk('rect', { width: 3.6, rx: 1.8 }), a: mk('path', { fill: 'none', 'stroke-width': 1.9, 'stroke-linecap': 'round' }) }));
  gB.append(oB, dB); gF.append(oF, dF);
  svg.append(gB, sph); eyes.forEach(e => svg.append(e.r, e.a)); svg.append(gF);
  host.appendChild(svg);
  let opt = Object.assign({}, o), lapAt = null, blinkAt = null, raf = 0, bt = 0, iv = 0, lastLap = o.lapKey;
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const hours = () => { if (opt.time != null && opt.time !== '') return ((+opt.time % 24) + 24) % 24; const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
  const phase = h => (h >= 22 || h < 6) ? 'sleep' : h >= 18 ? 'evening' : 'day';
  const paint = () => {
    const now = performance.now(), s = opt.size || 32, ink = opt.ink || '#101828', bg = opt.bg || '#FFFFFF', dot = opt.dot || '#465FFF';
    svg.setAttribute('width', s); svg.setAttribute('height', s);
    const h = hours(), ph = phase(h); let th = (90 + (h - 12) * 15) * Math.PI / 180, more = false;
    if (lapAt != null) { const p = Math.min(1, (now - lapAt) / 1500), e = 1 - Math.pow(1 - p, 3); th -= (1 - e) * Math.PI * 2; if (p < 1) more = true; else lapAt = null; }
    const x = CX + RX * Math.cos(th), y = CY + RY * Math.sin(th), front = Math.sin(th) > 0;
    oB.setAttribute('stroke', dot); oF.setAttribute('stroke', dot); sph.setAttribute('fill', ink);
    [[dB, !front], [dF, front]].forEach(([c, on]) => { c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('fill', dot); c.setAttribute('stroke', bg); c.style.display = on ? '' : 'none'; });
    const wx = (x - CX) * Math.cos(T) - (y - CY) * Math.sin(T), wy = (x - CX) * Math.sin(T) + (y - CY) * Math.cos(T), L = Math.hypot(wx, wy) || 1;
    const ox = wx / L * 3.4, oy = wy / L * 2.6;
    let bl = 1; if (blinkAt != null) { const q = (now - blinkAt) / 200; if (q < 1) { bl = Math.max(0.12, Math.abs(1 - 2 * q)); more = true; } else blinkAt = null; }
    const ec = /^#fff(fff)?$/i.test(ink) ? bg : '#FFFFFF';
    [[21.2, 25.6], [28.4, 27.4]].forEach((b, i) => { const cx = b[0] + ox, cy = b[1] + oy, e = eyes[i];
      if (ph === 'sleep' && lapAt == null) { e.r.style.display = 'none'; e.a.style.display = ''; e.a.setAttribute('d', 'M' + (cx - 2.1) + ' ' + cy + ' q2.1 2.4 4.2 0'); e.a.setAttribute('stroke', ec); }
      else { const hh = (ph === 'evening' ? 5.2 : 7) * bl; e.a.style.display = 'none'; e.r.style.display = ''; e.r.setAttribute('x', cx - 1.8); e.r.setAttribute('y', cy - hh / 2); e.r.setAttribute('height', hh); e.r.setAttribute('ry', Math.min(1.8, hh / 2)); e.r.setAttribute('fill', ec); e.r.setAttribute('transform', 'rotate(18 ' + cx + ' ' + cy + ')'); } });
    return more;
  };
  const loop = () => { cancelAnimationFrame(raf); const st = () => { if (paint()) raf = requestAnimationFrame(st); }; raf = requestAnimationFrame(st); };
  const lap = () => { if (reduce) return; lapAt = performance.now(); loop(); };
  const sched = () => { clearTimeout(bt); bt = setTimeout(() => { if (!reduce && phase(hours()) !== 'sleep') { blinkAt = performance.now(); loop(); } sched(); }, 2600 + Math.random() * 4000); };
  paint(); if (!opt.still) { if (opt.intro !== false) lap(); sched(); iv = setInterval(paint, 30000); }
  return { lap, update(n) { opt = Object.assign({}, n); if (n.lapKey !== lastLap) { lastLap = n.lapKey; lap(); } else paint(); }, destroy() { cancelAnimationFrame(raf); clearTimeout(bt); clearInterval(iv); svg.remove(); } };
}
function spPhaseLabel(h) { return (h >= 22 || h < 6) ? 'madrugada' : h >= 18 ? 'noite' : h >= 12 ? 'tarde' : 'manhã'; }
function LiveLogo(p) {
  const ref = React.useRef(null), ctl = React.useRef(null);
  React.useEffect(() => { ctl.current = mountSpherumLogo(ref.current, p); return () => { if (ctl.current) ctl.current.destroy(); }; }, []);
  React.useEffect(() => { if (ctl.current) ctl.current.update(p); });
  const d = new Date(), h = (p.time != null && p.time !== '') ? +p.time : d.getHours() + d.getMinutes() / 60;
  return React.createElement('span', { ref, title: p.still ? undefined : 'Spherum · ' + spPhaseLabel(h) + '. O ponto azul acompanha o horário.', onMouseEnter: () => { if (ctl.current && !p.still) ctl.current.lap(); }, onClick: p.onClick, style: { display: 'inline-block', lineHeight: 0, flexShrink: 0, width: p.size, height: p.size, cursor: p.onClick ? 'pointer' : 'default' } });
}
