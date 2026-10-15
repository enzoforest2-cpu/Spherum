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
const DOT_IMG = 'radial-gradient(rgba(20,23,20,.16) 1.6px,transparent 1.9px)';
const PERSONAS = [
  { l: { pt: 'Curioso', en: 'Curious' }, d: { pt: 'Faz perguntas e sugere ideias.', en: 'Asks questions, suggests ideas.' }, g: { pt: 'Oi! Eu sou {n}. O que a gente descobre hoje?', en: "Hi! I'm {n}. What do we figure out today?" } },
  { l: { pt: 'Brincalhão', en: 'Playful' }, d: { pt: 'Leve, com piada na hora certa.', en: 'Light, jokes at the right time.' }, g: { pt: 'E aí! {n} na área. Manda a primeira tarefa?', en: 'Hey! {n} here. Toss me a first task?' } },
  { l: { pt: 'Direto', en: 'Straight' }, d: { pt: 'Curto, objetivo, sem rodeio.', en: 'Short and focused, no fluff.' }, g: { pt: '{n} pronto. Qual é a prioridade?', en: "{n} ready. What's the priority?" } },
  { l: { pt: 'Zen', en: 'Zen' }, d: { pt: 'Calmo, organiza o caos.', en: 'Calm, tames the chaos.' }, g: { pt: 'Olá, sou {n}. Sem pressa — por onde começamos?', en: "Hello, I'm {n}. No rush — where do we start?" } },
];


const { useComposition, CompositionStage, Captions, Easing, clamp } = window;
const lerp = (a, b, p) => a + (b - a) * p;
const MOTION = {
  enter: (T, s, d = 0.6) => Easing.easeOutCubic(clamp((T - s) / d, 0, 1)),
  pop: (T, s, d = 0.55) => Easing.easeOutBack(clamp((T - s) / d, 0, 1)),
  glide: (T, s, d = 0.9) => Easing.easeInOutCubic(clamp((T - s) / d, 0, 1)),
};
const vis = (T, a, b, f = 0.4) => MOTION.enter(T, a, f) * (1 - MOTION.enter(T, b - f, f));
const P = { paper: '#F3F1EC', ink: '#161514', mute: '#635E57', line: '#E2DED6', chip: '#E9E5DE', white: '#FFFFFF', tomato: '#EF5B3B', sun: '#F6C443', mint: '#9FE3C5', lilac: '#C9B8F2', ultra: '#3A3AF4', lime: '#C8F04B', coral: '#E0705A', green: '#6DBB7B' };
const F = { serif: "'Instrument Serif',serif", brand: "'Fredoka',sans-serif", ui: "'Geist',sans-serif", mono: "'Geist Mono',monospace", doto: "'Doto',monospace", unb: "'Unbounded',sans-serif", figtree: "'Figtree',sans-serif" };
const abs = (x, y, extra) => ({ position: 'absolute', left: x, top: y, ...extra });

function Char({ kind, size, state, x, y, sx = 1, sy = 1, rot = 0, op = 1 }) {
  const sp = SPECIES[kind], c = sp.colors[0], base = { size, state, motion: false, follow: false };
  const el = kind === 'pingo' ? _h(PingoBot, { ...base, color: c.body, eye: c.eye, ink: '#2B1D16' }) : kind === 'bibo' ? _h(BiboBot, { ...base, body: c.body }) : _h(OkiBot, { ...base, body: c.body, mouth: c.mouth, sats: c.sats });
  return <div style={abs(x, y, { transform: 'translate(-50%,-100%) rotate(' + rot + 'deg) scale(' + sx + ',' + sy + ')', transformOrigin: '50% 100%', opacity: op })}>{el}</div>;
}


const SB = { blue: '#465FFF', ink: '#161514', mute: '#635E57', line: '#E2DED6', green: '#12B76A', red: '#F04438', wa: '#25D366', waBub: '#D9FDD3' };
const cl = v => Math.max(0, Math.min(1, v));
const lp = (a, b, t) => a + (b - a) * t;
const ss = t => { t = cl(t); return t * t * (3 - 2 * t); };
const SH = '0 24px 60px rgba(22,21,20,.14), 0 4px 12px rgba(22,21,20,.06)';
const pressAt = (T, tc) => T > tc && T < tc + 0.5 ? (T - tc) / 0.5 : 0;
const brl = v => 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const SPF = { pingo: '600 46px/1.15 ' + F.brand, bibo: '900 44px/1.15 ' + F.doto, oki: '600 36px/1.2 ' + F.unb };

function CharC({ kind, ci = 0, size, state, x, y, sx = 1, sy = 1, rot = 0, op = 1 }) {
  const sp = SPECIES[kind], c = sp.colors[ci] || sp.colors[0], base = { size, state, motion: false, follow: false };
  const el = kind === 'pingo' ? _h(PingoBot, { ...base, color: c.body, eye: c.eye, ink: '#2B1D16' }) : kind === 'bibo' ? _h(BiboBot, { ...base, body: c.body }) : _h(OkiBot, { ...base, body: c.body, mouth: c.mouth, sats: c.sats });
  return <div style={abs(x, y, { transform: 'translate(-50%,-100%) rotate(' + rot + 'deg) scale(' + sx + ',' + sy + ')', transformOrigin: '50% 100%', opacity: op })}>{el}</div>;
}
function Obs({ size, T = 0, ink = SB.ink, bg = '#FFFFFF', dot = SB.blue, spin = 0.9 }) {
  const CX = 23, CY = 27, RX = 22.5, RY = 7.2, TL = -20 * Math.PI / 180;
  const th = -0.52 + T * spin, x = CX + RX * Math.cos(th), y = CY + RY * Math.sin(th), front = Math.sin(th) > 0;
  const wx = (x - CX) * Math.cos(TL) - (y - CY) * Math.sin(TL), wy = (x - CX) * Math.sin(TL) + (y - CY) * Math.cos(TL), L = Math.hypot(wx, wy) || 1, ox = wx / L * 3.4, oy = wy / L * 2.6;
  const blink = (T % 3.7) < 0.14 ? 0.15 : 1, ec = /^#fff(fff)?$/i.test(ink) ? bg : '#FFFFFF';
  const eye = (bx, by, k) => { const cx = bx + ox, cy = by + oy, h = 7 * blink; return <rect key={k} x={cx - 1.8} y={cy - h / 2} width={3.6} height={h} rx={1.8} ry={Math.min(1.8, h / 2)} fill={ec} transform={'rotate(18 ' + cx + ' ' + cy + ')'} />; };
  const dotEl = <circle cx={x} cy={y} r={3.8} fill={dot} stroke={bg} strokeWidth={1.6} />;
  return <svg width={size} height={size} viewBox="0 0 48 48" style={{ display: 'block', overflow: 'visible', flexShrink: 0 }}>
    <g transform="rotate(-20 23 27)"><path d="M0.5 27 A22.5 7.2 0 0 1 45.5 27" fill="none" stroke={dot} strokeWidth={1.8} />{!front && dotEl}</g>
    <circle cx={CX} cy={CY} r={16.5} fill={ink} />{eye(21.2, 25.6, 'a')}{eye(28.4, 27.4, 'b')}
    <g transform="rotate(-20 23 27)"><path d="M0.5 27 A22.5 7.2 0 0 0 45.5 27" fill="none" stroke={dot} strokeWidth={1.8} />{front && dotEl}</g>
  </svg>;
}
function Sphere({ size, T }) { return <Obs size={size * 1.25} T={T} />; }
function Wordmark({ size, T, ink = SB.ink, bg = '#FFFFFF' }) { return <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.3 }}><Obs size={size * 1.3} T={T} ink={ink} bg={bg} /><span style={{ font: 'italic 400 ' + Math.round(size * 1.3) + 'px/1 ' + F.serif, letterSpacing: '-.01em', color: ink === SB.ink ? SB.ink : ink, whiteSpace: 'nowrap' }}>Spherum</span></div>; }
function XPill({ size }) { return <span style={{ font: '700 ' + size + 'px/1 ' + F.brand, background: '#EF5B3B', color: '#2B1D16', borderRadius: 999, padding: (size * 0.12) + 'px ' + (size * 0.34) + 'px ' + (size * 0.18) + 'px' }}>xodó</span>; }
function Cursor({ x, y, press, op = 1 }) {
  return <div style={abs(x, y, { width: 64, height: 64, marginLeft: -32, marginTop: -32, borderRadius: '50%', background: 'rgba(22,21,20,.88)', border: '6px solid #fff', boxSizing: 'border-box', boxShadow: '0 10px 22px rgba(0,0,0,.25)', transform: 'scale(' + (1 - Math.sin(press * Math.PI) * 0.25) + ')', opacity: op })}>
    {press > 0 && <div style={abs(-46, -46, { width: 144, height: 144, borderRadius: '50%', border: '7px solid ' + SB.blue, boxSizing: 'border-box', opacity: 1 - press, transform: 'scale(' + (0.3 + press) + ')' })} />}
  </div>;
}
function Words({ T, t0, text, hi, hiBg, y, size = 100, out = 0 }) {
  const ws = text.split(' ');
  return <div style={abs(70, y, { width: 940, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '6px 22px', opacity: 1 - out, transform: 'translateY(' + (-out * 40) + 'px)' })}>
    {ws.map((w, i) => { const p = MOTION.pop(T, t0 + i * 0.11, 0.45), h = hi && hi.includes(i);
      return <span key={i} style={{ display: 'inline-block', font: '700 ' + size + 'px/1.08 ' + F.ui, letterSpacing: '-.04em', color: SB.ink, background: h ? hiBg : 'transparent', borderRadius: 18, padding: h ? '0 14px' : 0, opacity: cl(p), transform: 'translateY(' + (1 - cl(p)) * 40 + 'px) scale(' + Math.max(0, p) + ')' }}>{w}</span>; })}
  </div>;
}
function Bubble({ x, y, p, text, font }) {
  return <div style={abs(x, y, { transform: 'translate(-50%,-100%) scale(' + Math.max(0, p) + ')', transformOrigin: '50% 100%', opacity: cl(p), background: '#fff', borderRadius: 36, padding: '26px 38px', boxShadow: SH, font, color: SB.ink, whiteSpace: 'nowrap' })}>{text}<div style={abs('50%', '100%', { width: 34, height: 34, background: '#fff', transform: 'translate(-50%,-55%) rotate(45deg)', borderRadius: 6 })} /></div>;
}
const CONF = Array.from({ length: 56 }, (_, i) => { const r = Math.sin(i * 91.7) * 43758.5453, f = r - Math.floor(r), g = Math.sin(i * 12.9) * 9999, h = g - Math.floor(g); return { ang: -Math.PI / 2 + (f - 0.5) * 2.6, sp: 900 + h * 1000, c: ['#EF5B3B', '#F6C443', '#465FFF', '#12B76A', '#C9B8F2', '#9FE3C5'][i % 6], w: 18 + (i % 3) * 8, rot: f * 720 }; });
function Confetti({ T, t0, x, y }) {
  const ct = T - t0; if (ct < 0 || ct > 2.4) return null;
  return <>{CONF.map((p, i) => <div key={i} style={abs(x + Math.cos(p.ang) * p.sp * ct, y + Math.sin(p.ang) * p.sp * ct + 1500 * ct * ct, { width: p.w, height: p.w * 0.6, background: p.c, borderRadius: 4, transform: 'rotate(' + (p.rot + ct * 700) + 'deg)', opacity: 1 - cl((ct - 1.6) / 0.8) })} />)}</>;
}
const card = (x, y, w, h, extra) => abs(x, y, { width: w, height: h, borderRadius: 36, background: '#fff', boxShadow: SH, ...extra });
const mono = (sz, c) => ({ font: '600 ' + sz + 'px/1 ' + F.mono, letterSpacing: '.06em', color: c || SB.mute });

/* ---------- Shows (área útil: x 70–1010, y 380–1380) ---------- */
function ShowFaisca({ T, s }) {
  const n = Math.min(12, Math.round(cl((T - s - 0.4) / 4.6) * 12)), nt = MOTION.pop(T, s + 5.3, 0.5);
  const RP = [['Loja Verano', '5,12x'], ['Clínica Aurora', '4,38x'], ['Horizonte', '3,91x'], ['Odonto Prime', '6,02x'], ['Academia Pulse', '4,75x'], ['Grão Nobre', '3,40x'], ['Estúdio Lumen', '2,88x'], ['Moraes Adv.', '4,10x']];
  return <>
    <div style={abs(70, 380, { width: 940, textAlign: 'center' })}>
      <div style={{ font: '600 36px/1 ' + F.ui, color: SB.mute }}>Relatórios de setembro</div>
      <div style={{ font: '700 140px/1 ' + F.ui, letterSpacing: '-.05em', color: SB.ink, marginTop: 16, fontVariantNumeric: 'tabular-nums' }}>{n} de 12</div>
      <div style={{ height: 18, borderRadius: 9, background: 'rgba(22,21,20,.1)', margin: '26px 120px 0', overflow: 'hidden' }}><div style={{ height: '100%', width: n / 12 * 100 + '%', background: n === 12 ? SB.green : SB.blue, borderRadius: 9 }} /></div>
    </div>
    {RP.map((r, i) => { const t0 = s + 0.4 + i * 0.55; if (T < t0) return null; const f = MOTION.glide(T, t0, 0.6);
      return <div key={i} style={abs(lp(230, 540 + (i % 2 ? 16 : -16), f), lp(1460, 990 - i * 6, f) - Math.sin(f * Math.PI) * 320, { width: 440, height: 520, marginLeft: -220, marginTop: -260, borderRadius: 28, background: '#fff', boxShadow: SH, overflow: 'hidden', transform: 'rotate(' + lp(-30, i % 2 ? 4 : -4, f) + 'deg) scale(' + lp(0.25, 1, f) + ')' })}>
        <div style={{ height: 18, background: SB.blue }} />
        <div style={{ padding: '34px 38px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={mono(20)}>MARKETING PRO</span>
          <span style={{ font: '600 38px/1.1 ' + F.ui, color: SB.ink }}>{r[0]}</span>
          <span style={{ font: '700 104px/1 ' + F.ui, letterSpacing: '-.04em', color: SB.blue, marginTop: 18 }}>{r[1]}</span>
          <span style={{ font: '500 26px/1 ' + F.ui, color: SB.mute }}>ROAS do mês</span>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 100, marginTop: 14 }}>{[40, 58, 46, 70, 62, 84].map((h, k) => <span key={k} style={{ flex: 1, height: h, borderRadius: 6, background: k === 5 ? SB.blue : '#C7D0FF' }} />)}</div>
        </div></div>; })}
    <div style={abs(110, 1290, { width: 860, borderRadius: 32, background: 'rgba(22,21,20,.95)', color: '#fff', padding: '26px 32px', boxSizing: 'border-box', opacity: cl(nt), transform: 'scale(' + Math.max(0, nt) + ')' })}>
      <div style={mono(20, '#A4BCFD')}>PORTAL DO CLIENTE · AGORA</div>
      <div style={{ font: '600 32px/1.3 ' + F.ui, marginTop: 10 }}>Seu relatório de setembro chegou.</div>
    </div>
  </>;
}
const ZM = [['Carolina · Clínica Aurora', 'A fatura venceu?', 1], ['Tati · Academia Pulse', 'Cadê o relatório de agosto?', 0], ['Paulo · Horizonte', 'Reunião amanhã às 10h?', 0], ['Fernanda · Loja Verano', 'Pode subir o criativo novo?', 0], ['Otávio · Grão Nobre', 'Qual o horário de vocês?', 0]];
function ShowZuca({ T, s }) {
  const ap = MOTION.enter(T, s + 4.0, 0.5), tc = s + 5.2, mv = MOTION.glide(T, s + 4.4, 0.7), done = T > tc + 0.15;
  return <>
    {ZM.map((m, i) => { const p = MOTION.pop(T, s + 0.3 + i * 0.32, 0.45), rt = s + 2.1 + i * 0.36, res = T > rt, need = m[2] === 1, ok = !need || done;
      return <div key={i} style={abs(70, 390 + i * 150, { width: 940, height: 130, borderRadius: 30, background: '#fff', boxShadow: SH, boxSizing: 'border-box', padding: '22px 30px', opacity: cl(p) * (1 - ap * 0.35), transform: 'translateX(' + (1 - cl(p)) * -200 + 'px)' })}>
        <div style={{ font: '500 24px/1 ' + F.ui, color: SB.mute }}>{m[0]}</div>
        <div style={{ font: '600 36px/1.2 ' + F.ui, color: SB.ink, marginTop: 12 }}>{m[1]}</div>
        {res && <span style={abs(620, 20, { width: 290, textAlign: 'center', borderRadius: 999, padding: '12px 0', font: '600 22px/1 ' + F.ui, background: ok ? '#DCFAE6' : '#FEE4E2', color: ok ? '#067647' : '#B42318', transform: 'scale(' + Math.max(0, MOTION.pop(T, rt, 0.35)) + ')' })}>{ok ? '✓ Zuca respondeu' : 'Precisa de você'}</span>}
      </div>; })}
    <div style={card(70, lp(1500, 1150, ap), 940, 280, { opacity: ap })}>
      <div style={abs(40, 34, mono(22, '#B42318'))}>ZUCA PEDE APROVAÇÃO</div>
      <div style={abs(40, 76, { width: 860, font: '600 36px/1.25 ' + F.ui, color: SB.ink })}>Responder Carolina sobre a fatura</div>
      <div style={abs(40, 170, { height: 76, padding: '0 40px', borderRadius: 20, display: 'flex', alignItems: 'center', background: done ? SB.green : SB.blue, color: '#fff', font: '600 32px/1 ' + F.ui, whiteSpace: 'nowrap' })}>{done ? '✓ Enviado' : 'Permitir uma vez'}</div>
    </div>
    {T > s + 4.3 && <Cursor x={lp(980, 260, mv)} y={lp(1500, 1358, mv)} press={pressAt(T, tc)} op={1 - MOTION.enter(T, tc + 0.7, 0.3)} />}
  </>;
}
const NC1 = [16, 16.5, 16, 17, 17.6, 19.2, 21, 22.5], NC2 = [22.5, 19.4, 17.2, 16];
function ShowNina({ T, s }) {
  const W = 820, H = 380, yOf = v => H - (v - 13) / 11 * H, xOf = i => i * (W / 11);
  const tc = s + 4.1, draw = ss((T - s - 0.2) / 1.6), draw2 = ss((T - tc - 0.3) / 1.1), sug = MOTION.enter(T, s + 2.6, 0.5), mv = MOTION.glide(T, s + 3.2, 0.7), done = T > tc + 0.15;
  const d1 = NC1.map((v, i) => (i ? 'L' : 'M') + xOf(i) + ' ' + yOf(v)).join(' '), d2 = NC2.map((v, i) => (i ? 'L' : 'M') + xOf(i + 7) + ' ' + yOf(v)).join(' ');
  const bad = MOTION.pop(T, s + 1.8, 0.4) * (1 - MOTION.enter(T, tc + 0.6, 0.3)), good = MOTION.pop(T, tc + 1.4, 0.45);
  return <>
    <div style={card(70, 380, 940, 640)}>
      <div style={abs(50, 46, { font: '600 38px/1 ' + F.ui, color: SB.ink })}>Academia Pulse · CPL</div>
      <div style={abs(50, 100, mono(24))}>META R$ 18</div>
      {bad > 0.01 && <span style={abs(560, 40, { borderRadius: 999, padding: '14px 24px', background: '#FEE4E2', color: '#B42318', font: '600 26px/1 ' + F.ui, transform: 'scale(' + Math.max(0, bad) + ')' })}>25% acima da meta</span>}
      {good > 0.01 && <span style={abs(590, 40, { borderRadius: 999, padding: '14px 24px', background: '#DCFAE6', color: '#067647', font: '600 26px/1 ' + F.ui, transform: 'scale(' + Math.max(0, good) + ')' })}>De volta à meta</span>}
      <svg width={W} height={H} viewBox={'0 0 ' + W + ' ' + H} style={abs(60, 190, { overflow: 'visible' })}>
        <line x1={0} x2={W} y1={yOf(18)} y2={yOf(18)} stroke="#98A2B3" strokeWidth={4} strokeDasharray="14 14" />
        <path d={d1} pathLength={1} fill="none" stroke={SB.red} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1" strokeDashoffset={1 - draw} />
        <path d={d2} pathLength={1} fill="none" stroke={SB.green} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1" strokeDashoffset={1 - draw2} />
      </svg>
    </div>
    <div style={card(70, 1060, 940, 300, { opacity: sug, transform: 'translateY(' + (1 - sug) * 60 + 'px)' })}>
      <div style={abs(44, 38, mono(22, '#B8401F'))}>NINA SUGERE</div>
      <div style={abs(44, 80, { width: 850, font: '600 36px/1.25 ' + F.ui, color: SB.ink })}>Mover R$ 300 para o conjunto “Funcional”</div>
      <div style={abs(44, 190, { height: 76, padding: '0 40px', borderRadius: 20, display: 'flex', alignItems: 'center', background: done ? SB.green : SB.blue, color: '#fff', font: '600 32px/1 ' + F.ui, whiteSpace: 'nowrap' })}>{done ? '✓ Verba ajustada' : 'Permitir uma vez'}</div>
    </div>
    {T > s + 3.1 && <Cursor x={lp(980, 260, mv)} y={lp(1600, 1288, mv)} press={pressAt(T, tc)} op={1 - MOTION.enter(T, tc + 0.7, 0.3)} />}
  </>;
}
const AV = ['#F6C443', '#EF5B3B', '#9FE3C5', '#C9B8F2', '#465FFF', '#FFB199', '#C8F04B', '#7A5AF8', '#06AED4', '#F79009', '#12B76A', '#E0705A'];
const VARS = ['Oi, Renata! Vi que você curte pilates. Quer uma aula grátis?', 'Renata, tudo bem? Temos uma aula experimental. Bora agendar?', 'Oi Renata! Que tal conhecer o studio com uma aula de cortesia?'];
function ShowProsp({ T, s }) {
  const A = 1 - MOTION.enter(T, s + 2.0, 0.4), suck = MOTION.glide(T, s + 1.0, 0.7), lst = MOTION.pop(T, s + 1.5, 0.5), B = MOTION.enter(T, s + 2.2, 0.3) * (1 - MOTION.enter(T, s + 4.4, 0.3)), Cc = MOTION.enter(T, s + 4.5, 0.4);
  const conv = Math.round(38 * ss((T - s - 4.9) / 1.0)), reu = Math.round(9 * ss((T - s - 5.2) / 0.9));
  return <>
    {A > 0.01 && <div style={abs(0, 0, { width: 1080, height: 1920, opacity: A })}>
      <div style={card(70, 380, 940, 180)}>
        <div style={abs(40, 40, { width: 100, height: 100, borderRadius: '50%', background: 'linear-gradient(135deg,#F6C443,#EF5B3B,#C13584)' })} />
        <div style={abs(170, 46, { font: '700 40px/1 ' + F.ui, color: SB.ink })}>@studiorival</div>
        <div style={abs(170, 102, { font: '500 28px/1 ' + F.ui, color: SB.mute })}>12,4 mil seguidores</div>
      </div>
      {AV.map((c, i) => { const gx = 210 + (i % 4) * 220, gy = 680 + Math.floor(i / 4) * 200, p = MOTION.pop(T, s + 0.2 + i * 0.04, 0.4);
        return <div key={i} style={abs(lp(gx, 540, suck), lp(gy, 1180, suck), { width: 150, height: 150, marginLeft: -75, marginTop: -75, borderRadius: '50%', background: c, transform: 'scale(' + Math.max(0, p) * lp(1, 0.1, suck) + ')', opacity: 1 - ss((suck - 0.8) / 0.2) })} />; })}
      <div style={abs(540, 1180, { transform: 'translate(-50%,-50%) scale(' + Math.max(0, lst) + ')', background: SB.ink, color: '#fff', borderRadius: 999, padding: '28px 44px', font: '700 44px/1 ' + F.ui, whiteSpace: 'nowrap' })}>1.240 leads importados</div>
    </div>}
    {B > 0.01 && <div style={abs(0, 0, { width: 1080, height: 1920, opacity: B })}>
      <div style={abs(70, 390, { width: 940, textAlign: 'center', font: '600 36px/1.2 ' + F.ui, color: SB.ink })}>A mesma ideia, escrita de 3 jeitos</div>
      {VARS.map((v, i) => { const p = MOTION.pop(T, s + 2.4 + i * 0.4, 0.45); return <div key={i} style={abs(110, 480 + i * 270, { width: 860, borderRadius: '34px 34px 8px 34px', background: SB.waBub, padding: '26px 32px', boxSizing: 'border-box', boxShadow: SH, opacity: cl(p), transform: 'scale(' + Math.max(0, p) + ')', transformOrigin: '100% 100%' })}><div style={mono(20, '#067647')}>{'VARIAÇÃO ' + (i + 1)}</div><div style={{ font: '500 34px/1.3 ' + F.ui, color: SB.ink, marginTop: 10 }}>{v}</div></div>; })}
    </div>}
    {Cc > 0.01 && <div style={abs(0, 0, { width: 1080, height: 1920, opacity: Cc })}>
      {['Quero sim! Que horário?', 'Pode ser sábado de manhã?'].map((t, i) => { const p = MOTION.pop(T, s + 4.6 + i * 0.4, 0.45); return <div key={i} style={abs(110, 420 + i * 170, { borderRadius: '34px 34px 34px 8px', background: '#fff', padding: '28px 34px', boxShadow: SH, font: '600 38px/1.2 ' + F.ui, color: SB.ink, opacity: cl(p), transform: 'scale(' + Math.max(0, p) + ')', transformOrigin: '0 100%', whiteSpace: 'nowrap' })}>{t}</div>; })}
      <div style={card(70, 820, 940, 420)}>
        <div style={abs(0, 70, { width: 940, display: 'flex', justifyContent: 'space-around', textAlign: 'center' })}>
          <div><div style={{ font: '700 150px/1 ' + F.ui, letterSpacing: '-.05em', color: SB.ink }}>{conv}</div><div style={{ font: '500 34px/1 ' + F.ui, color: SB.mute, marginTop: 16 }}>conversas</div></div>
          <div><div style={{ font: '700 150px/1 ' + F.ui, letterSpacing: '-.05em', color: '#067647' }}>{reu}</div><div style={{ font: '500 34px/1 ' + F.ui, color: SB.mute, marginTop: 16 }}>reuniões</div></div>
        </div>
      </div>
    </div>}
  </>;
}
const PI = [['Gestão de tráfego', 1500], ['Criativos · 8 peças', 900], ['Social media', 1000]];
function ShowProp({ T, s, acc }) {
  const lg = MOTION.pop(T, s + 0.3, 0.6), cn = MOTION.enter(T, s + 0.8, 0.4), tot = 3400 * ss((T - s - 2.3) / 0.8) + 800 * ss((T - s - 5.2) / 0.7);
  const sig = cl((T - s - 3.3) / 0.8), st = MOTION.pop(T, s + 4.1, 0.45), ad = MOTION.enter(T, s + 4.8, 0.45);
  return <div style={card(120, 380, 840, 1000, { overflow: 'hidden' })}>
    <div style={abs(0, 0, { width: 840, height: 170, background: acc })}>
      <div style={abs(50, 60, { font: '800 48px/1 ' + F.ui, letterSpacing: '.08em', color: '#2B1D16', opacity: cl(lg), transform: 'translateY(' + (1 - Math.max(0, lg)) * -120 + 'px)' })}>MARKETING PRO</div>
      <div style={abs(50, 122, { ...mono(20, '#2B1D16'), opacity: cl(lg) })}>PROPOSTA COMERCIAL</div>
    </div>
    <div style={abs(50, 210, { font: '700 46px/1 ' + F.ui, color: SB.ink, opacity: cn })}>Studio Move Pilates</div>
    {PI.map((it, i) => { const p = MOTION.enter(T, s + 1.2 + i * 0.35, 0.4); return <div key={i} style={abs(50, 300 + i * 86, { width: 740, display: 'flex', justifyContent: 'space-between', font: '500 34px/1 ' + F.ui, color: SB.ink, borderBottom: '2px solid ' + SB.line, paddingBottom: 22, opacity: p, transform: 'translateX(' + (1 - p) * 60 + 'px)' })}><span>{it[0]}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{brl(it[1])}</span></div>; })}
    <div style={abs(50, 580, { width: 740, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', font: '700 44px/1 ' + F.ui, color: SB.ink, opacity: MOTION.enter(T, s + 2.2, 0.3) })}><span>Total</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{brl(tot)}/mês</span></div>
    <div style={abs(50, 680, { width: 740 * sig, overflow: 'hidden', whiteSpace: 'nowrap', font: 'italic 500 72px/1.2 Georgia,serif', color: '#1D2939' })}>Renata Alves</div>
    <div style={abs(50, 780, { width: 420, height: 3, background: '#98A2B3' })} />
    {st > 0.01 && <div style={abs(500, 650, { border: '7px solid ' + SB.green, color: SB.green, borderRadius: 18, padding: '14px 24px', font: '800 46px/1 ' + F.ui, letterSpacing: '.08em', transform: 'rotate(-12deg) scale(' + Math.max(0, st) + ')' })}>ASSINADO</div>}
    <div style={abs(0, lp(1000, 850, ad), { width: 840, height: 150, background: '#FFF3D6', borderTop: '3px dashed #F6C443', boxSizing: 'border-box', padding: '28px 50px', opacity: ad })}>
      <div style={mono(22, '#93370D')}>ADITIVO A-01</div>
      <div style={{ font: '600 36px/1.2 ' + F.ui, color: SB.ink, marginTop: 10 }}>TikTok Ads · +R$ 800/mês</div>
    </div>
  </div>;
}
const FUN = [['Investido', 3000, v => brl(v), 0.7], ['Leads', 142, v => String(Math.round(v)), 0.62], ['Vendas', 31, v => String(Math.round(v)), 0.48], ['Receita', 15360, v => brl(v), 0.94]];
function ShowRet({ T, s, hiBg }) {
  const rb = MOTION.pop(T, s + 3.4, 0.5), sub = MOTION.enter(T, s + 4.2, 0.5);
  return <>
    {FUN.map((f, i) => { const t0 = s + 0.3 + i * 0.65, p = MOTION.enter(T, t0, 0.45), v = f[1] * ss((T - t0) / 0.8), w = 940 * f[3];
      return <div key={i} style={abs(540 - w / 2, 390 + i * 180, { width: w, height: 150, borderRadius: 30, background: i === 3 ? SB.ink : '#fff', color: i === 3 ? '#fff' : SB.ink, boxShadow: SH, boxSizing: 'border-box', padding: '0 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: p, transform: 'scaleX(' + lp(0.6, 1, p) + ')' })}><span style={{ font: '500 34px/1 ' + F.ui, opacity: 0.8 }}>{f[0]}</span><span style={{ font: '700 58px/1 ' + F.ui, letterSpacing: '-.03em', fontVariantNumeric: 'tabular-nums' }}>{f[2](v)}</span></div>; })}
    <div style={abs(540, 1180, { transform: 'translate(-50%,-50%) scale(' + Math.max(0, rb) + ')', background: hiBg, borderRadius: 999, padding: '26px 56px', font: '700 96px/1 ' + F.ui, letterSpacing: '-.04em', color: SB.ink, whiteSpace: 'nowrap' })}>ROAS 5,12x</div>
    <div style={abs(70, 1290, { width: 940, textAlign: 'center', font: '600 36px/1.2 ' + F.ui, color: SB.ink, opacity: sub })}>Cada R$ 1 virou R$ 5,12</div>
  </>;
}
const KINDS = ['pingo', 'bibo', 'oki'], JEITOS = ['Curioso', 'Brincalhão', 'Direto', 'Zen'];
const critSel = (T, s) => { const sp = [s + 0.2, s + 0.8, s + 1.4, s + 2.0].filter(t => T >= t).length; const kindI = sp === 0 ? 0 : (sp - 1) % 3; const cc = [s + 2.4, s + 2.8, s + 3.2, s + 3.6].filter(t => T >= t).length; const colI = cc === 0 ? 0 : [1, 2, 3, 0][cc - 1]; return { kindI: T >= s + 2.0 ? 0 : kindI, colI }; };
function ShowCriar({ T, s }) {
  const { kindI, colI } = critSel(T, s), jc = [s + 3.8, s + 4.1, s + 4.4, s + 4.7].filter(t => T >= t).length, jI = jc === 0 ? -1 : [1, 2, 3, 0][jc - 1];
  const name = 'Faísca'.slice(0, Math.max(0, Math.floor((T - s - 4.9) / 0.11))), job = MOTION.pop(T, s + 5.8, 0.4);
  const row = (y, label, content) => <div style={abs(50, y, { width: 840 })}><div style={mono(22)}>{label}</div><div style={{ marginTop: 18 }}>{content}</div></div>;
  return <div style={card(70, 380, 940, 990)}>
    {row(40, 'ESPÉCIE', <div style={{ display: 'flex', gap: 24 }}>{KINDS.map((k, i) => <div key={k} style={{ position: 'relative', width: 264, height: 200, borderRadius: 26, background: '#F3F1EC', boxShadow: i === kindI ? '0 0 0 6px ' + SB.ink : 'none' }}><CharC kind={k} size={k === 'oki' ? 150 : 140} state="idle" x={132} y={185} /></div>)}</div>)}
    {row(330, 'COR', <div style={{ display: 'flex', gap: 26 }}>{SPECIES.pingo.colors.map((c, i) => <span key={i} style={{ width: 96, height: 96, borderRadius: '50%', background: c.body, boxShadow: i === colI ? '0 0 0 6px #fff, 0 0 0 12px ' + SB.ink : 'inset 0 0 0 2px rgba(0,0,0,.1)' }} />)}</div>)}
    {row(510, 'JEITO', <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>{JEITOS.map((j, i) => <span key={j} style={{ borderRadius: 999, padding: '18px 28px', font: '600 32px/1 ' + F.ui, background: i === jI ? SB.ink : '#F3F1EC', color: i === jI ? '#fff' : SB.ink }}>{j}</span>)}</div>)}
    {row(680, 'NOME', <div style={{ height: 96, borderRadius: 22, border: '3px solid ' + (T > s + 4.8 ? SB.ink : SB.line), display: 'flex', alignItems: 'center', padding: '0 30px', font: '700 50px/1 ' + F.brand, color: SB.ink }}>{name}<span style={{ width: 4, height: 54, background: SB.ink, marginLeft: 4, opacity: T > s + 4.8 && Math.floor(T * 3) % 2 ? 1 : 0 }} /></div>)}
    {row(860, 'TRABALHO', <span style={{ display: 'inline-block', borderRadius: 999, padding: '16px 28px', font: '600 32px/1 ' + F.ui, background: '#EF5B3B', color: '#2B1D16', transform: 'scale(' + Math.max(0, job) + ')' }}>Relatórios</span>)}
  </div>;
}

const REELS = {
  faisca: { k: 'pingo', bg: '#FCE9E1', hi: '#FFB199', hook: 'Dia 1º. 12 relatórios pra entregar.', hookHi: [2, 3], say: 'Deixa comigo!', chip: 'Faísca · Relatórios', Show: ShowFaisca, pay: '12 de 12. Antes do café.', payHi: [0, 1, 2], paySub: 'Publicados no portal de cada cliente', end: 'Faísca fecha o mês de cada cliente.' },
  zuca: { k: 'bibo', bg: '#EAF4DD', hi: '#C8F04B', hook: '7h da manhã. 23 mensagens de cliente.', hookHi: [3], say: 'Bora responder!', chip: 'Zuca · Atendimento', Show: ShowZuca, pay: 'Caixa em dia. Nada saiu sem você.', payHi: [0, 1, 2], paySub: '4 respondidas · 1 aprovada por você', end: 'Zuca cuida das mensagens dos clientes.' },
  nina: { k: 'oki', bg: '#E7ECFF', hi: '#B7C4FF', hook: 'Sexta, 18h. O CPL subiu.', hookHi: [4], say: 'Deixa eu ver…', chip: 'Nina · Campanhas', Show: ShowNina, pay: 'CPL de volta à meta.', payHi: [3, 4], paySub: 'E você aprovou com um toque', end: 'Nina vigia as campanhas por você.' },
  prosp: { k: 'bibo', bg: '#E3F6EA', hi: '#9FE3C5', hook: 'Os seguidores do concorrente viram seus leads.', hookHi: [5, 6], say: 'Vou chamar no zap!', chip: 'Prospecção · WhatsApp', Show: ShowProsp, pay: '9 reuniões. Nenhuma mensagem repetida.', payHi: [0, 1], paySub: 'Cada lead recebe uma versão diferente', end: 'Capte, converse e feche pelo WhatsApp.' },
  prop: { k: 'pingo', ci: 2, bg: '#FFF3D6', hi: '#F6C443', hook: 'Proposta pronta em 2 minutos.', hookHi: [3, 4], say: 'Já monto!', chip: 'Propostas e contratos', Show: ShowProp, pay: 'Assinou. E o aditivo também.', payHi: [0], paySub: 'Com a sua logo, valores e cláusulas', end: 'Proposta, contrato e aditivo num lugar só.' },
  ret: { k: 'oki', bg: '#EAE6FF', hi: '#C9B8F2', hook: 'Cliente achou caro?', hookHi: [2], say: 'Eu mostro!', chip: 'Retorno até a venda', Show: ShowRet, pay: 'Agora ele vê o retorno.', payHi: [3, 4], paySub: 'Do clique à venda, no portal do cliente', end: 'Prove o retorno até a venda.' },
  criar: { k: 'pingo', bg: '#F3F1EC', hi: '#FFB199', hook: 'Crie seu xodó.', hookHi: [2], say: null, chip: 'Novo xodó', Show: ShowCriar, pay: 'Pronto. Seu primeiro xodó.', payHi: [2, 3], paySub: 'Espécie, cor, jeito e trabalho', end: 'Crie o seu em menos de um minuto.', born: 'Oi! Eu sou Faísca.' },
};

function Reel({ id }) {
  const { T, CUES: C } = useComposition();
  const R = REELS[id] || REELS.faisca, h = C.Hook, s = C.Show, p = C.Payoff, e = C.End;
  const toShow = MOTION.glide(T, s - 0.25, 0.7), toPay = MOTION.glide(T, p - 0.2, 0.6), toEnd = MOTION.glide(T, e - 0.2, 0.6);
  let x = lp(540, 215, toShow), y = lp(1440, 1720, toShow), sc = lp(1, 0.58, toShow);
  x = lp(x, 540, toPay); y = lp(y, 1600, toPay); sc = lp(sc, 0.92, toPay);
  y = lp(y, 1680, toEnd); sc = lp(sc, 0.62, toEnd);
  const drop = MOTION.pop(T, h + 0.2, 0.6), land = Math.sin(cl((T - h - 0.62) / 0.32) * Math.PI) * 0.2;
  const hop = T > p ? Math.abs(Math.sin((T - p) * 7)) * 70 * sc : Math.sin(T * 2.4) * 10;
  let kind = R.k, ci = R.ci || 0;
  if (id === 'criar') { if (T < s) kind = KINDS[Math.floor(Math.max(0, T - h - 0.3) / 0.4) % 3]; else { const q = critSel(T, s); kind = KINDS[q.kindI]; ci = q.colI; } }
  const inShow = T >= s && T < p, st = T < s ? (T < h + 1.1 ? 'listening' : 'thinking') : inShow ? (id === 'criar' ? 'idle' : 'working') : 'done';
  const size = kind === 'oki' ? 470 : 440, yy = y - (1 - Math.max(0, drop)) * 1400 - hop;
  const say = R.say && vis(T, h + 1.3, s - 0.1, 0.25), born = R.born && vis(T, p + 0.3, e - 0.1, 0.25);
  const sayP = R.say ? MOTION.pop(T, h + 1.3, 0.45) * (1 - MOTION.enter(T, s - 0.35, 0.25)) : 0, bornP = R.born ? MOTION.pop(T, p + 0.3, 0.45) * (1 - MOTION.enter(T, e - 0.35, 0.25)) : 0;
  const chip = vis(T, s + 0.05, p - 0.1, 0.3), pOut = MOTION.enter(T, e - 0.3, 0.3), dark = MOTION.enter(T, e - 0.15, 0.45);
  const w1 = MOTION.pop(T, e + 0.2, 0.6), w2 = MOTION.pop(T, e + 0.6, 0.5), w3 = MOTION.enter(T, e + 0.9, 0.4), w4 = MOTION.enter(T, e + 1.2, 0.4);
  const SF = SPF[kind];
  return <div data-screen-label={'t=' + Math.floor(T) + 's'} style={{ position: 'absolute', inset: 0, background: R.bg, overflow: 'hidden', fontFamily: F.ui, color: SB.ink }}>
    <div style={abs(0, 0, { width: 1080, height: 1920, background: SB.ink, opacity: dark })} />
    {T < s + 0.3 && <Words T={T} t0={h + 0.15} text={R.hook} hi={R.hookHi} hiBg={R.hi} y={250} size={104} out={MOTION.enter(T, s - 0.3, 0.3)} />}
    {chip > 0.01 && <div style={abs(540, 250, { transform: 'translateX(-50%)', opacity: chip, background: SB.ink, color: '#fff', borderRadius: 999, padding: '20px 36px', font: '600 34px/1 ' + F.ui, whiteSpace: 'nowrap' })}>{R.chip}</div>}
    {inShow || (T > s - 0.1 && T < p + 0.3) ? <div style={abs(0, 0, { width: 1080, height: 1920, opacity: 1 - MOTION.enter(T, p - 0.25, 0.3) })}><R.Show T={T} s={s} acc={R.hi} hiBg={R.hi} /></div> : null}
    {T >= p - 0.1 && T < e + 0.2 && <>
      <Words T={T} t0={p + 0.05} text={R.pay} hi={R.payHi} hiBg={R.hi} y={260} size={100} out={pOut} />
      <div style={abs(70, 640, { width: 940, textAlign: 'center', font: '600 34px/1.3 ' + F.mono, letterSpacing: '.02em', color: SB.mute, opacity: MOTION.enter(T, p + 0.9, 0.4) * (1 - pOut) })}>{R.paySub}</div>
    </>}
    <Confetti T={T} t0={p + 0.15} x={540} y={1200} />
    <CharC kind={kind} ci={ci} size={size} state={st} x={x} y={yy} sx={sc * (1 + land * 0.6)} sy={sc * (1 - land)} rot={inShow && id !== 'criar' ? Math.sin(T * 8) * 3 : 0} />
    {sayP > 0.01 && <Bubble x={540} y={yy - size * sc - 40} p={sayP} text={R.say} font={SF} />}
    {bornP > 0.01 && <Bubble x={540} y={yy - size * sc - 40} p={bornP} text={R.born} font={SPF.pingo} />}
    {T > e - 0.1 && <>
      <div style={abs(540, 640, { transform: 'translate(-50%,-50%) scale(' + lp(0.7, 1, Math.max(0, w1)) + ')', opacity: cl(w1) })}><Wordmark size={110} T={T} ink="#FFFFFF" bg={SB.ink} /></div>
      <div style={abs(540, 820, { transform: 'translate(-50%,-50%) scale(' + Math.max(0, w2) + ')', opacity: cl(w2), display: 'flex', alignItems: 'center', gap: 30 })}><span style={{ font: '500 60px/1 ' + F.ui, color: '#A8A29A' }}>com</span><XPill size={110} /></div>
      <div style={abs(90, 960, { width: 900, textAlign: 'center', font: '600 52px/1.25 ' + F.ui, letterSpacing: '-.02em', color: '#fff', opacity: w3, transform: 'translateY(' + (1 - w3) * 20 + 'px)' })}>{R.end}</div>
      <div style={abs(540, 1150, { transform: 'translateX(-50%)', opacity: w4, ...mono(28, '#fff'), border: '3px solid #fff', borderRadius: 999, padding: '20px 34px', whiteSpace: 'nowrap' })}>A PARTIR DO PLANO AGÊNCIA</div>
    </>}
  </div>;
}

window.SpherumReel = function SpherumReel(props) {
  return <CompositionStage width={1080} height={1920} scenes={window.OM_SCENES} playback={window.OM_PLAYBACK} bg="#F3F1EC"><Reel id={props.reel || 'faisca'} /></CompositionStage>;
};
