import React from "react";
// Os bonequinhos dos xodós, copiados do Spherum (design/project/spherum/agencia_tpl.html).
const _h = React.createElement;
const _ab = { position: 'absolute' };
const BOT_STATES = [
  { k: 'idle', pt: 'À toa', en: 'Idle' },
  { k: 'listening', pt: 'Ouvindo', en: 'Listening' },
  { k: 'thinking', pt: 'Pensando', en: 'Thinking' },
  { k: 'working', pt: 'Trabalhando', en: 'Working' },
  { k: 'needsYou', pt: 'Precisa de você', en: 'Needs you' },
  { k: 'done', pt: 'Feito!', en: 'Done!' },
];

const BOT_MOUSE = window.__botMouse || (window.__botMouse = (() => {
  const m = { x: null, y: null, subs: new Set(), raf: 0 };
  window.addEventListener('pointermove', e => {
    m.x = e.clientX; m.y = e.clientY;
    if (!m.raf) m.raf = requestAnimationFrame(() => { m.raf = 0; m.subs.forEach(f => f()); });
  }, { passive: true });
  return m;
})());

function botGaze(el) {
  if (!el || BOT_MOUSE.x == null) return [0, 0];
  const r = el.getBoundingClientRect();
  const dx = BOT_MOUSE.x - (r.left + r.width / 2), dy = BOT_MOUSE.y - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy) || 1, k = Math.min(d / 240, 1);
  return [dx / d * k, dy / d * k];
}

function useBotGaze(ref, on, cb) {
  const cbRef = React.useRef(cb); cbRef.current = cb;
  React.useEffect(() => {
    if (!on) { cbRef.current(0, 0); return; }
    const f = () => { const g = botGaze(ref.current); cbRef.current(g[0], g[1]); };
    BOT_MOUSE.subs.add(f); f();
    return () => { BOT_MOUSE.subs.delete(f); };
  }, [on]);
}

function useBotReaction(interactive) {
  const [on, setOn] = React.useState(false);
  const t = React.useRef(0);
  React.useEffect(() => () => clearTimeout(t.current), []);
  const fire = interactive ? () => { setOn(true); clearTimeout(t.current); t.current = setTimeout(() => setOn(false), 1800); } : undefined;
  return [on, fire];
}

/* ---------- A · Pingo (gota, squash & stretch) ---------- */
function PingoBot(p) {
  const s = p.size || 120, color = p.color || '#EF5B3B', eye = p.eye || '#2B1D16', cheek = p.cheek || '#FF9DA6', ink = p.ink || '#2B1D16';
  const motion = p.motion !== false, follow = p.follow !== false;
  const spark = p.spark || ['#3E64DE', '#3DBB8E', '#FF9DA6', '#EF5B3B', '#F6C443', '#3E64DE'];
  const [reacting, fire] = useBotReaction(p.interactive);
  const st = reacting ? 'done' : (p.state || 'idle');
  const root = React.useRef(null), gz = React.useRef(null);
  useBotGaze(root, follow && st !== 'thinking', (x, y) => { if (gz.current) gz.current.style.transform = 'translate(' + (x * s * 0.07).toFixed(2) + 'px,' + (y * s * 0.05).toFixed(2) + 'px)'; });
  const A = v => motion ? v : 'none';
  const H = s * 1.04, b = s * 0.8, cy = H - b / 2;
  const bodyAnim = { idle: 'pg-breathe 2.6s ease-in-out infinite', listening: 'pg-tilt 1.6s ease-in-out infinite', thinking: 'pg-breathe 3.6s ease-in-out infinite', working: 'pg-hop .8s cubic-bezier(.3,.7,.4,1) infinite', needsYou: 'pg-hop .55s ease-in-out infinite', done: 'pg-jump 1s cubic-bezier(.3,.7,.4,1) infinite' }[st];
  const eyeT = { idle: 'dot', listening: 'wide', thinking: 'dot', working: 'focus', needsYou: 'wide', done: 'happy' }[st];
  const mouthT = { idle: 'smile', listening: 'o', thinking: 'flat', working: 'flat', needsYou: 'o', done: 'grin' }[st];
  const look = st === 'thinking' ? 'translate(' + s * 0.06 + 'px,' + (-s * 0.06) + 'px)' : 'none';
  const eyeEl = (dx, key) => {
    const base = { ..._ab, left: s / 2 + dx, top: cy - s * 0.04, transform: 'translate(-50%,-50%)' };
    if (eyeT === 'happy') return _h('div', { key, style: { ...base, width: s * 0.13, height: s * 0.075, border: (s * 0.034) + 'px solid ' + eye, borderBottom: 'none', borderRadius: s + 'px ' + s + 'px 0 0', boxSizing: 'border-box' } });
    if (eyeT === 'focus') return _h('div', { key, style: { ...base, width: s * 0.13, height: s * 0.036, borderRadius: s, background: eye } });
    const w = eyeT === 'wide' ? 0.12 : 0.1, hh = eyeT === 'wide' ? 0.155 : 0.13;
    return _h('div', { key, style: { ...base, width: s * w, height: s * hh } },
      _h('div', { style: { width: '100%', height: '100%', borderRadius: '50%', background: eye, position: 'relative', animation: A('bot-blink 3.6s infinite') } },
        _h('div', { style: { ..._ab, width: '34%', height: '27%', borderRadius: '50%', background: '#FFFFFF', top: '16%', right: '14%', opacity: 0.9 } })));
  };
  const my = cy + s * 0.1, mb = { ..._ab, left: s / 2, top: my, transform: 'translate(-50%,-50%)' };
  const mouth = {
    smile: _h('div', { key: 'm', style: { ...mb, width: s * 0.13, height: s * 0.065, border: (s * 0.03) + 'px solid ' + eye, borderTop: 'none', borderRadius: '0 0 ' + s + 'px ' + s + 'px', boxSizing: 'border-box' } }),
    grin: _h('div', { key: 'm', style: { ...mb, width: s * 0.17, height: s * 0.085, background: eye, borderRadius: '0 0 ' + s + 'px ' + s + 'px', overflow: 'hidden' } },
      _h('div', { style: { ..._ab, left: '50%', bottom: -s * 0.02, width: s * 0.085, height: s * 0.06, marginLeft: -s * 0.0425, borderRadius: '50%', background: cheek } })),
    o: _h('div', { key: 'm', style: { ...mb, width: s * 0.065, height: s * 0.075, borderRadius: '50%', background: eye } }),
    flat: _h('div', { key: 'm', style: { ...mb, width: s * 0.075, height: s * 0.03, borderRadius: s, background: eye } }),
  }[mouthT];
  const cheeks = [-1, 1].map(side => _h('div', { key: 'c' + side, style: { ..._ab, left: s / 2 + side * s * 0.26 - s * 0.04, top: cy + s * 0.05 - s * 0.03, width: s * 0.08, height: s * 0.06, borderRadius: '50%', background: cheek, opacity: 0.85 } }));
  const ex = [];
  if (st === 'listening') [0, 1].forEach(i => [-1, 1].forEach(side => ex.push(_h('div', { key: 'r' + i + side, style: { ..._ab, width: s * 0.34, height: s * 0.34, left: s / 2 + side * s * 0.54 - s * 0.17, top: cy - s * 0.17, borderRadius: '50%', border: (s * 0.025) + 'px solid ' + ink, boxSizing: 'border-box', opacity: motion ? 0 : 0.35, animation: A('bot-ripple 1.6s ease-out ' + (i * 0.8) + 's infinite') } }))));
  if (st === 'thinking') [0, 1, 2].forEach(i => { const d = s * (0.05 + i * 0.022); ex.push(_h('div', { key: 't' + i, style: { ..._ab, width: d, height: d, left: s * (0.72 + i * 0.1), top: s * (0.16 - i * 0.08) - d / 2, borderRadius: '50%', background: ink, animation: A('bot-bob 1.2s ease-in-out ' + (i * 0.18) + 's infinite') } })); });
  if (st === 'working') ex.push(_h('div', { key: 'w', style: { ..._ab, width: s * 0.2, height: s * 0.2, left: s * 0.8, top: s * 0.06, borderRadius: '50%', border: (s * 0.035) + 'px solid ' + ink, borderTopColor: 'transparent', boxSizing: 'border-box', animation: A('bot-spin .9s linear infinite') } }));
  if (st === 'needsYou') ex.push(_h('div', { key: 'n', style: { ..._ab, width: s * 0.3, height: s * 0.3, left: s * 0.76, top: -s * 0.04, borderRadius: '50%', background: '#FFFFFF', border: (s * 0.025) + 'px solid ' + ink, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '700 ' + (s * 0.2) + "px/1 'Fredoka', sans-serif", color: '#2B1D16', animation: A('bot-bubble 1s ease-in-out infinite') } }, '!'));
  if (st === 'done') [[-0.42, -0.18], [0.44, -0.22], [-0.3, -0.42], [0.28, -0.48], [0, -0.56], [0.52, 0.08]].forEach((v, i) => { const d = s * (i % 2 ? 0.05 : 0.07); ex.push(_h('div', { key: 'd' + i, style: { ..._ab, width: d, height: d, left: s / 2 - d / 2, top: s * 0.3 - d / 2, borderRadius: '50%', background: spark[i % spark.length], '--dx': v[0] * s + 'px', '--dy': v[1] * s + 'px', transform: motion ? undefined : 'translate(' + v[0] * s * 0.7 + 'px,' + v[1] * s * 0.7 + 'px)', animation: A('pg-pop 1s ease-out ' + (i * 0.1) + 's infinite') } })); });
  return _h('div', { ref: root, onClick: fire, style: { position: 'relative', width: s, height: H, flex: 'none', cursor: fire ? 'pointer' : 'default' } },
    _h('div', { style: { ..._ab, inset: 0, transformOrigin: '50% 100%', animation: A(bodyAnim) } },
      _h('div', { style: { ..._ab, left: (s - b) / 2, top: H - b, width: b, height: b, background: color, borderRadius: '50% 0 50% 50%', transform: 'rotate(-45deg)', boxShadow: 'inset ' + (b * 0.07) + 'px ' + (-b * 0.07) + 'px 0 rgba(0,0,0,.09)' } }),
      _h('div', { style: { ..._ab, left: s / 2 - b * 0.3, top: cy - b * 0.34, width: b * 0.16, height: b * 0.1, borderRadius: '50%', background: '#FFFFFF', opacity: 0.45, transform: 'rotate(-35deg)' } }),
      _h('div', { style: { ..._ab, inset: 0, transform: look, transition: 'transform .4s cubic-bezier(.3,1.4,.5,1)' } },
        _h('div', { ref: gz, style: { ..._ab, inset: 0, transition: 'transform .18s ease-out' } }, eyeEl(-s * 0.15, 'l'), eyeEl(s * 0.15, 'r'), cheeks, mouth))),
    ex);
}

/* ---------- B · Bibo (matriz de pontos, quadro a quadro) ---------- */
const BB_EYE = { dot: ['##', '##'], wide: ['##', '##', '##'], blink: ['##'], focus: ['###'], happy: ['.#.', '#.#'] };
const BB_MOUTH = { smile: ['#....#', '.####.'], grin: ['#......#', '.######.', '..####..'], o: ['.##.', '#..#', '.##.'], small: ['##', '##'], flat: ['####'], none: [] };
function bbFace(eyeT, mouthT, dx, dy, extra) {
  const C = 12, R = 9, on = new Set();
  const put = (pat, c0, r0) => pat.forEach((row, r) => { for (let c = 0; c < row.length; c++) { const cc = c0 + c, rr = r0 + r; if (row[c] === '#' && cc >= 0 && cc < C && rr >= 0 && rr < R) on.add(rr * C + cc); } });
  const e = BB_EYE[eyeT], w = e[0].length, er = 3 - Math.ceil((e.length - 1) / 2) + dy;
  put(e, Math.ceil(2.5 - (w - 1) / 2) + dx, er);
  put(e, Math.floor(8.5 - (w - 1) / 2) + dx, er);
  const m = BB_MOUTH[mouthT];
  if (m.length) put(m, Math.round(5.5 - (m[0].length - 1) / 2) + dx, m.length > 2 ? (mouthT === 'grin' ? 5 : 6) : 6);
  extra.forEach(i => on.add(i));
  return on;
}
function BiboBot(p) {
  const s = p.size || 120, body = p.body || '#9FE3C5', led = p.led || '#C9F45B', scr = p.screen || '#151815', ink = p.ink || '#141714';
  const motion = p.motion !== false, follow = p.follow !== false;
  const [reacting, fire] = useBotReaction(p.interactive);
  const st = reacting ? 'done' : (p.state || 'idle');
  const [f, setF] = React.useState(0);
  const [g, setG] = React.useState([0, 0]);
  const root = React.useRef(null);
  React.useEffect(() => { if (!motion) { setF(0); return; } const id = setInterval(() => setF(x => x + 1), 120); return () => clearInterval(id); }, [motion]);
  useBotGaze(root, follow, (x, y) => { const nx = Math.max(-1, Math.min(1, Math.round(x * 1.5))), ny = Math.max(-1, Math.min(1, Math.round(y * 1.3))); setG(q => (q[0] === nx && q[1] === ny) ? q : [nx, ny]); });
  const fr = motion ? f : 13, A = v => motion ? v : 'none';
  let eyeT = 'dot', mouthT = 'smile', extra = [], dx = g[0], dy = g[1];
  if (st === 'idle') { if (fr % 28 === 27) eyeT = 'blink'; }
  else if (st === 'listening') { eyeT = 'wide'; mouthT = (fr >> 2) % 2 ? 'o' : 'small'; }
  else if (st === 'thinking') { dx = 1; dy = -1; mouthT = 'none'; const k = (fr >> 2) % 4; [[2, 3], [5, 6], [8, 9]].slice(0, k).forEach(c => extra.push(72 + c[0], 72 + c[1])); }
  else if (st === 'working') { eyeT = 'focus'; mouthT = 'none'; const q = fr % 15 - 3; for (let i = 0; i < 3; i++) if (q + i >= 0 && q + i < 12) extra.push(84 + q + i); }
  else if (st === 'needsYou') { eyeT = (fr >> 2) % 2 ? 'wide' : 'dot'; mouthT = 'o'; }
  else if (st === 'done') { eyeT = 'happy'; mouthT = 'grin'; dx = 0; dy = 0; extra = (fr >> 1) % 2 ? [0, 11, 96, 107] : [13, 22, 85, 94]; }
  const on = bbFace(eyeT, mouthT, dx, dy, extra);
  const cell = s * 0.051, dot = cell * 0.74, glow = (cell * 0.9).toFixed(1);
  const cells = [];
  for (let i = 0; i < 108; i++) { const lit = on.has(i); cells.push(_h('div', { key: i, style: { width: dot, height: dot, borderRadius: '50%', background: lit ? led : 'rgba(255,255,255,.07)', boxShadow: lit ? '0 0 ' + glow + 'px ' + led : 'none' } })); }
  const bodyAnim = { idle: 'bb-bob 1.8s steps(1) infinite', listening: 'bb-tilt 1.2s steps(1) infinite', thinking: 'bb-bob 2.6s steps(1) infinite', working: 'bb-bob .48s steps(1) infinite', needsYou: 'bb-hop .9s steps(1) infinite', done: 'bb-jump .9s steps(1) infinite' }[st];
  const bulbOn = st === 'listening' || st === 'needsYou' || st === 'working' || st === 'done';
  return _h('div', { ref: root, onClick: fire, style: { position: 'relative', width: s, height: s * 1.06, flex: 'none', cursor: fire ? 'pointer' : 'default' } },
    _h('div', { style: { ..._ab, inset: 0, transformOrigin: '50% 100%', animation: A(bodyAnim) } },
      _h('div', { style: { ..._ab, left: s / 2 - s * 0.018, top: s * 0.06, width: s * 0.036, height: s * 0.11, background: ink, borderRadius: s * 0.02 } }),
      _h('div', { style: { ..._ab, left: s / 2 - s * 0.06, top: 0, width: s * 0.12, height: s * 0.12, borderRadius: '50%', background: bulbOn ? led : body, border: (s * 0.022) + 'px solid ' + ink, boxSizing: 'border-box', boxShadow: bulbOn ? '0 0 ' + (s * 0.08) + 'px ' + led : 'none', animation: A(st === 'needsYou' || st === 'listening' ? 'bb-blink .5s steps(1) infinite' : 'none') } }),
      _h('div', { style: { ..._ab, left: 0, top: s * 0.45, width: s * 0.09, height: s * 0.26, borderRadius: s * 0.045, background: ink } }),
      _h('div', { style: { ..._ab, left: s * 0.91, top: s * 0.45, width: s * 0.09, height: s * 0.26, borderRadius: s * 0.045, background: ink } }),
      _h('div', { style: { ..._ab, left: s * 0.05, top: s * 0.15, width: s * 0.9, height: s * 0.86, borderRadius: s * 0.26, background: body, boxShadow: 'inset 0 ' + (-s * 0.05) + 'px 0 rgba(0,0,0,.1), inset 0 ' + (s * 0.03) + 'px 0 rgba(255,255,255,.4)' } }),
      _h('div', { style: { ..._ab, left: s * 0.13, top: s * 0.27, width: s * 0.74, height: s * 0.56, borderRadius: s * 0.13, background: scr, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 0 0 ' + (s * 0.015) + 'px rgba(0,0,0,.35)' } },
        _h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(12,' + cell + 'px)', gridAutoRows: cell + 'px', placeItems: 'center' } }, cells))));
}

/* ---------- C · Oki (núcleo + satélites, molas) ---------- */
const OKI_SZ = [0.17, 0.13, 0.11, 0.09, 0.07];
function okiTarget(k, i, n, t, s, sz) {
  const R = v => v * s;
  if (k === 'listening') { const side = i % 2 ? 1 : -1, j = i >> 1, pulse = Math.sin(t * 6 - j * 1.3) * 0.035; return { x: side * R(0.38 + j * 0.09 + pulse), y: R(-0.04 + j * 0.02), c: (0.11 - j * 0.025) / sz, z: 1 }; }
  if (k === 'thinking') { const a = t * 2.4 + i * (Math.PI * 2 / n); return { x: R(0.26) * Math.cos(a), y: R(-0.4) + R(0.07) * Math.sin(a), c: (0.075 / sz) * (0.85 + 0.25 * Math.sin(a)), z: Math.sin(a) }; }
  if (k === 'working') return { x: R((i - (n - 1) / 2) * 0.14), y: R(0.4) - R(0.08) * Math.abs(Math.sin(t * 5 - i * 0.7)), c: 0.08 / sz, z: 1 };
  if (k === 'needsYou') { const hop = Math.abs(Math.sin(t * 6)) * R(0.05); const yy = i < n - 1 ? -0.46 + i * 0.075 : -0.46 + (n - 1) * 0.075 + 0.06; return { x: R(0.42), y: R(yy) - hop, c: 0.065 / sz, z: 1 }; }
  if (k === 'done') { const a = i * (Math.PI * 2 / n) + t * 0.9 - Math.PI / 2, r = R(0.36 + 0.12 * Math.pow(Math.abs(Math.sin(t * 3.4)), 0.7)); return { x: r * Math.cos(a), y: r * Math.sin(a) * 0.9, c: 1, z: 1 }; }
  const a = i * 2.4 + t * (0.45 + i * 0.08) * (i % 2 ? 1 : -1), r = R(0.37 + 0.03 * Math.sin(t * 1.3 + i));
  return { x: r * Math.cos(a), y: r * Math.sin(a) * 0.4 + R(0.04), c: 0.85 + 0.2 * Math.sin(a), z: Math.sin(a) };
}
function OkiBot(p) {
  const s = p.size || 120, body = p.body || '#3A3AF4', ink = p.ink || '#10101A', mouthC = p.mouth || '#FFFFFF';
  const sats = p.sats || ['#FF7A68', '#C8F04B', '#9CB7FF', '#10101A', '#FF7A68'];
  const motion = p.motion !== false, follow = p.follow !== false;
  const [reacting, fire] = useBotReaction(p.interactive);
  const st = reacting ? 'done' : (p.state || 'idle');
  const root = React.useRef(null), satEls = React.useRef([]), pupils = React.useRef([]);
  const stRef = React.useRef(st); stRef.current = st;
  const gzT = React.useRef([0, 0]);
  useBotGaze(root, follow, (x, y) => { gzT.current = [x, y]; });
  React.useEffect(() => {
    const P = OKI_SZ.map(() => ({ x: 0, y: 0, c: 1, vx: 0, vy: 0, vc: 0 })), G = { x: 0, y: 0 };
    let raf = 0, first = true; const t0 = performance.now();
    const tick = now => {
      const t = motion ? (now - t0) / 1000 : 0.6, k = stRef.current;
      OKI_SZ.forEach((sz, i) => {
        const T = okiTarget(k, i, OKI_SZ.length, t, s, sz), q = P[i];
        if (first || !motion) { q.x = T.x; q.y = T.y; q.c = T.c; }
        else { q.vx = (q.vx + (T.x - q.x) * 0.09) * 0.8; q.vy = (q.vy + (T.y - q.y) * 0.09) * 0.8; q.vc = (q.vc + (T.c - q.c) * 0.09) * 0.8; q.x += q.vx; q.y += q.vy; q.c += q.vc; }
        const el = satEls.current[i];
        if (el) { el.style.transform = 'translate(' + q.x.toFixed(2) + 'px,' + q.y.toFixed(2) + 'px) scale(' + Math.max(0, q.c).toFixed(3) + ')'; el.style.zIndex = T.z > 0 ? 3 : 1; }
      });
      const tg = k === 'thinking' ? [0.6, -0.8] : gzT.current;
      if (first || !motion) { G.x = tg[0]; G.y = tg[1]; } else { G.x += (tg[0] - G.x) * 0.14; G.y += (tg[1] - G.y) * 0.14; }
      pupils.current.forEach(el => { if (el) el.style.transform = 'translate(' + (G.x * s * 0.035).toFixed(2) + 'px,' + (G.y * s * 0.035).toFixed(2) + 'px)'; });
      first = false;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [motion, s]);
  const A = v => motion ? v : 'none';
  const cx = s / 2, cy = s * 0.56, d = s * 0.56;
  const bodyAnim = { idle: 'ok-float 3s ease-in-out infinite', listening: 'ok-pulse .9s ease-in-out infinite', thinking: 'ok-float 2.2s ease-in-out infinite', working: 'ok-float .9s ease-in-out infinite', needsYou: 'ok-hop .7s ease-in-out infinite', done: 'pg-jump 1.1s cubic-bezier(.3,.7,.4,1) infinite' }[st];
  const happy = st === 'done', ew = (st === 'listening' || st === 'needsYou') ? 0.17 : 0.15, eh = st === 'working' ? 0.09 : ew;
  const eyeEl = (side, idx) => happy
    ? _h('div', { key: 'e' + idx, style: { ..._ab, left: cx + side * s * 0.1 - s * 0.065, top: cy - s * 0.09, width: s * 0.13, height: s * 0.07, border: (s * 0.032) + 'px solid #FFFFFF', borderBottom: 'none', borderRadius: s + 'px ' + s + 'px 0 0', boxSizing: 'border-box' } })
    : _h('div', { key: 'e' + idx, style: { ..._ab, left: cx + side * s * 0.1 - s * ew / 2, top: cy - s * 0.04 - s * eh / 2, width: s * ew, height: s * eh, borderRadius: '50%', background: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', animation: A('bot-blink 4.2s infinite') } },
        _h('div', { ref: el => { pupils.current[idx] = el; }, style: { width: s * 0.075, height: s * 0.075, borderRadius: '50%', background: ink, flex: 'none' } }));
  const my = cy + s * 0.12, mb = { ..._ab, left: cx, top: my, transform: 'translate(-50%,-50%)' };
  const mouth = {
    idle: _h('div', { style: { ...mb, width: s * 0.1, height: s * 0.05, border: (s * 0.025) + 'px solid ' + mouthC, borderTop: 'none', borderRadius: '0 0 ' + s + 'px ' + s + 'px', boxSizing: 'border-box' } }),
    listening: _h('div', { style: { ...mb, width: s * 0.06, height: s * 0.06, borderRadius: '50%', background: mouthC } }),
    thinking: _h('div', { style: { ...mb, left: cx + s * 0.03, width: s * 0.07, height: s * 0.025, borderRadius: s, background: mouthC } }),
    working: _h('div', { style: { ...mb, width: s * 0.07, height: s * 0.025, borderRadius: s, background: mouthC } }),
    needsYou: _h('div', { style: { ...mb, width: s * 0.06, height: s * 0.07, borderRadius: '50%', background: mouthC } }),
    done: _h('div', { style: { ...mb, width: s * 0.14, height: s * 0.07, borderRadius: '0 0 ' + s + 'px ' + s + 'px', background: mouthC } }),
  }[st];
  const satNodes = OKI_SZ.map((sz, i) => { const T0 = okiTarget(st, i, OKI_SZ.length, 0.6, s, sz); return _h('div', { key: 's' + i, ref: el => { satEls.current[i] = el; }, style: { ..._ab, left: cx - sz * s / 2, top: cy - sz * s / 2, width: sz * s, height: sz * s, borderRadius: '50%', background: sats[i % sats.length], willChange: 'transform', transform: 'translate(' + T0.x.toFixed(2) + 'px,' + T0.y.toFixed(2) + 'px) scale(' + Math.max(0, T0.c).toFixed(3) + ')', zIndex: T0.z > 0 ? 3 : 1 } }); });
  return _h('div', { ref: root, onClick: fire, style: { position: 'relative', width: s, height: s, flex: 'none', isolation: 'isolate', cursor: fire ? 'pointer' : 'default' } },
    satNodes,
    _h('div', { style: { ..._ab, inset: 0, zIndex: 2, transformOrigin: '50% 80%', animation: A(bodyAnim) } },
      _h('div', { style: { ..._ab, left: cx - d / 2, top: cy - d / 2, width: d, height: d, borderRadius: '50%', background: body, boxShadow: 'inset ' + (-s * 0.03) + 'px ' + (-s * 0.04) + 'px 0 rgba(0,0,0,.14)' } }),
      _h('div', { style: { ..._ab, left: cx - d * 0.32, top: cy - d * 0.38, width: d * 0.2, height: d * 0.12, borderRadius: '50%', background: '#FFFFFF', opacity: 0.3, transform: 'rotate(-30deg)' } }),
      eyeEl(-1, 0), eyeEl(1, 1), mouth));
}
const SPECIES = {
  pingo: { label: 'Pingo', font: "700 22px/1 'Fredoka',sans-serif", nameFont: "600 20px/1 'Fredoka',sans-serif", inputFont: "600 30px/1 'Fredoka',sans-serif", size: 230,
    desc: { pt: 'Gota de brinquedo. Amassa, estica e quica.', en: 'A toy drop. Squashes, stretches, bounces.' },
    bubble: { bg: '#FFFFFF', fg: '#2B1D16', font: "600 21px/1.25 'Fredoka',sans-serif" },
    names: ['Faísca', 'Mel', 'Bolota', 'Pipoca', 'Caju', 'Nhoque', 'Gota'],
    colors: [
      { n: { pt: 'Tomate', en: 'Tomato' }, body: '#EF5B3B', eye: '#2B1D16', stage: '#F6C443', stageInk: '#5A4318' },
      { n: { pt: 'Cobalto', en: 'Cobalt' }, body: '#3E64DE', eye: '#FFF4E8', stage: '#FFB8A6', stageInk: '#6B2416' },
      { n: { pt: 'Menta', en: 'Mint' }, body: '#3DBB8E', eye: '#2B1D16', stage: '#FBE3A0', stageInk: '#5A4318' },
      { n: { pt: 'Girassol', en: 'Sunflower' }, body: '#F6C443', eye: '#2B1D16', stage: '#3E64DE', stageInk: '#FFFFFF', ink: '#FBF4EA' },
    ] },
  bibo: { label: 'Bibo', font: "900 26px/1 'Doto',monospace", nameFont: "700 21px/1 'Doto',monospace", inputFont: "900 32px/1 'Doto',monospace", size: 220, dotted: true,
    desc: { pt: 'Bichinho com rosto de LED, ponto a ponto.', en: 'A pocket pet with an LED face, dot by dot.' },
    bubble: { bg: '#151815', fg: '#C9F45B', font: "500 17px/1.4 'Geist Mono',monospace" },
    names: ['Zuca', 'Tico', 'Lulu', 'Bip', 'Pixel', 'Neno', 'Biju'],
    colors: [
      { n: { pt: 'Menta', en: 'Mint' }, body: '#9FE3C5', stage: '#C9B8F2', stageInk: '#2E2650' },
      { n: { pt: 'Lilás', en: 'Lilac' }, body: '#C9B8F2', stage: '#9FE3C5', stageInk: '#173D2D' },
      { n: { pt: 'Manteiga', en: 'Butter' }, body: '#F4E38E', stage: '#F7B99A', stageInk: '#5A2A14' },
      { n: { pt: 'Pêssego', en: 'Peach' }, body: '#F7B99A', stage: '#F4E38E', stageInk: '#4D4310' },
    ] },
  oki: { label: 'Oki', font: "700 21px/1 'Unbounded',sans-serif", nameFont: "600 16px/1 'Unbounded',sans-serif", inputFont: "700 26px/1 'Unbounded',sans-serif", size: 260,
    desc: { pt: 'Núcleo com satélites que orbitam e explodem de alegria.', en: 'A core with orbiting dots that burst with joy.' },
    bubble: { bg: '#10101A', fg: '#FFFFFF', font: "600 17px/1.35 'Unbounded',sans-serif" },
    names: ['Nina', 'Juju', 'Bento', 'Kiki', 'Lua', 'Tuca', 'Zazá'],
    colors: [
      { n: { pt: 'Ultramar', en: 'Ultramarine' }, body: '#3A3AF4', stage: '#C8F04B', stageInk: '#2E3A08', sats: ['#FF7A68', '#FFFFFF', '#9CB7FF', '#10101A', '#FF7A68'] },
      { n: { pt: 'Coral', en: 'Coral' }, body: '#FF7A68', stage: '#9CB7FF', stageInk: '#14204A', sats: ['#3A3AF4', '#C8F04B', '#FFFFFF', '#10101A', '#3A3AF4'] },
      { n: { pt: 'Lima', en: 'Lime' }, body: '#C8F04B', mouth: '#10101A', stage: '#3A3AF4', stageInk: '#FFFFFF', sats: ['#FF7A68', '#FFFFFF', '#9CB7FF', '#10101A', '#FF7A68'] },
      { n: { pt: 'Noite', en: 'Night' }, body: '#10101A', stage: '#FF7A68', stageInk: '#3D0F08', sats: ['#C8F04B', '#3A3AF4', '#FFFFFF', '#C8F04B', '#3A3AF4'] },
    ] },
};
const SP_KEYS = ['pingo', 'bibo', 'oki'];
export { BOT_STATES, PingoBot, BiboBot, OkiBot, SPECIES, SP_KEYS };

const REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** O bonequinho de um xodó salvo (espécie + nome da cor), no estado que ele está. */
export function XodoChar({ xodo, size = 64, state = "idle", interactive = false, follow = true }) {
  const sp = SPECIES[xodo?.species] ? xodo.species : "pingo";
  const colors = SPECIES[sp].colors;
  const c = colors.find((k) => k.n.pt === xodo?.color) || colors[0];
  const base = { size, state, interactive, motion: !REDUCED && xodo?.status !== "paused", follow: follow && !REDUCED };
  if (sp === "pingo") return React.createElement(PingoBot, { ...base, color: c.body, eye: c.eye, ink: "#2B1D16" });
  if (sp === "bibo") return React.createElement(BiboBot, { ...base, body: c.body });
  return React.createElement(OkiBot, { ...base, body: c.body, mouth: c.mouth, sats: c.sats });
}
