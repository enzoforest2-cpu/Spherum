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


const SB = { blue: '#465FFF', ink: '#101828', mute: '#667085', line: '#E4E7EC', bg: '#F7F8FA', white: '#FFFFFF', green: '#12B76A', red: '#F04438', tomato: '#EF5B3B', soft: '#EEF1FF', body: '#344054' };
const cl = v => Math.max(0, Math.min(1, v));
const lp = (a, b, t) => a + (b - a) * t;
const ss = t => { t = cl(t); return t * t * (3 - 2 * t); };
const SH = '0 24px 60px rgba(16,24,40,.12), 0 4px 12px rgba(16,24,40,.06)';
const pressAt = (T, tc) => T > tc && T < tc + 0.5 ? (T - tc) / 0.5 : 0;

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
function XPill({ size }) { return <span style={{ font: '700 ' + size + 'px/1 ' + F.brand, background: SB.tomato, color: '#2B1D16', borderRadius: 999, padding: (size * 0.12) + 'px ' + (size * 0.34) + 'px ' + (size * 0.18) + 'px', letterSpacing: '-.02em' }}>xodó</span>; }
function Cursor({ x, y, press, op = 1 }) {
  return <div style={abs(x, y, { width: 46, height: 46, marginLeft: -23, marginTop: -23, borderRadius: '50%', background: 'rgba(16,24,40,.88)', border: '4px solid #fff', boxSizing: 'border-box', boxShadow: '0 8px 18px rgba(0,0,0,.25)', transform: 'scale(' + (1 - Math.sin(press * Math.PI) * 0.25) + ')', opacity: op })}>
    {press > 0 && <div style={abs(-33, -33, { width: 104, height: 104, borderRadius: '50%', border: '5px solid ' + SB.blue, boxSizing: 'border-box', opacity: 1 - press, transform: 'scale(' + (0.3 + press) + ')' })} />}
  </div>;
}
function Title({ T, t0, x, y, children, w = 1200, center }) {
  const e = MOTION.enter(T, t0, 0.6);
  return <div style={abs(x, y, { width: w, textAlign: center ? 'center' : 'left', font: '700 60px/1.05 ' + F.ui, letterSpacing: '-.03em', color: SB.ink, opacity: e, transform: 'translateY(' + (1 - e) * 24 + 'px)' })}>{children}</div>;
}

const APPS = [['Planilha de clientes', '#12B76A', 380, 470, -6], ['WhatsApp', '#25D366', 1540, 450, 5], ['Meta Ads', '#465FFF', 260, 660, 4], ['Google Ads', '#F79009', 1640, 660, -4], ['Contrato_final_v3.pdf', '#F04438', 610, 850, 3], ['Drive', '#FDB022', 1300, 860, -5], ['Boletos', '#7A5AF8', 960, 940, 2], ['Relatório.pptx', '#EF5B3B', 730, 640, -3], ['E-mail', '#98A2B3', 1220, 640, 4], ['Trello', '#2E90FA', 1700, 900, -2], ['Canva', '#06AED4', 220, 900, 6]];
function Chaos({ T, C }) {
  const a = C.Chaos, b = C.Platform; if (T > b + 0.1) return null;
  const l1 = MOTION.enter(T, a + 0.2, 0.6), l2 = MOTION.enter(T, a + 1.0, 0.6), suck = MOTION.glide(T, a + 2.9, 0.8);
  const sp = MOTION.pop(T, a + 3.4, 0.6), wm = MOTION.enter(T, a + 3.7, 0.5), out = MOTION.glide(T, b - 0.45, 0.45);
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: 1 - out })}>
    <div style={abs(0, 170, { width: 1920, textAlign: 'center', opacity: 1 - suck })}>
      <div style={{ font: '700 100px/1.05 ' + F.ui, letterSpacing: '-.035em', color: SB.ink, opacity: l1, transform: 'translateY(' + (1 - l1) * 30 + 'px)' }}>Sua agência tem 47 clientes.</div>
      <div style={{ font: '500 64px/1.2 ' + F.ui, letterSpacing: '-.02em', color: SB.mute, marginTop: 18, opacity: l2, transform: 'translateY(' + (1 - l2) * 24 + 'px)' }}>E umas 14 abas abertas.</div>
    </div>
    {APPS.map((p, i) => { const e = MOTION.pop(T, a + 1.4 + i * 0.1, 0.5), jig = Math.sin(T * 7 + i) * 3; const x = lp(p[2], 960, suck), y = lp(p[3], 560, suck);
      return <div key={i} style={abs(x, y, { transform: 'translate(-50%,-50%) rotate(' + (p[4] + jig) * (1 - suck) + 'deg) scale(' + Math.max(0, e) * lp(1, 0.15, suck) + ')', opacity: cl(e) * (1 - ss((suck - 0.7) / 0.3)), display: 'flex', alignItems: 'center', gap: 14, background: '#fff', borderRadius: 18, padding: '18px 26px', boxShadow: SH, font: '600 32px/1 ' + F.ui, color: SB.ink, whiteSpace: 'nowrap' })}><span style={{ width: 18, height: 18, borderRadius: 5, background: p[1] }} />{p[0]}</div>; })}
    <div style={abs(960, 560, { transform: 'translate(-50%,-50%)', display: 'flex', alignItems: 'center' })}>
      <div style={{ transform: 'scale(' + Math.max(0, sp) + ')' }}><Sphere size={170} T={T} /></div>
      <div style={{ overflow: 'hidden', width: wm * 760, marginLeft: wm * 44 }}><div style={{ font: 'italic 400 ' + Math.round(180 * 1.18) + 'px/1.05 ' + F.serif, letterSpacing: '-.01em', color: SB.ink, whiteSpace: 'nowrap', opacity: wm }}>Spherum</div></div>
    </div>
  </div>;
}

const NAV = ['Visão geral', 'Clientes', 'Pontuação de leads', 'Propostas', 'Publicar', 'Retorno', 'DRE', 'Chat da equipe', 'Xodós'];
const KPI = [['Clientes ativos', 47, v => String(Math.round(v))], ['Receita mensal', 186, v => 'R$ ' + Math.round(v) + 'k'], ['ROAS médio', 5.1, v => v.toFixed(1).replace('.', ',') + 'x'], ['Propostas abertas', 9, v => String(Math.round(v))]];
const BARS = [42, 55, 48, 62, 58, 70, 66, 78, 74, 85, 82, 94];
const FEED = [['pingo', 'Faísca publicou o relatório da Loja Verano'], ['oki', 'Nina ajustou a verba da Academia Pulse'], ['bibo', 'Zuca respondeu 4 clientes']];
function Platform({ T, C }) {
  const a = C.Platform, b = C.Meet; if (T < a - 0.1 || T > b + 0.1) return null;
  const e = MOTION.enter(T, a, 0.8), ex = MOTION.glide(T, b - 0.9, 0.9), cap = vis(T, a + 0.4, b - 0.5, 0.4);
  const pos = cl((T - (a + 1.2)) / 4) * 8, k = Math.floor(pos), hl = Math.min(8, k + ss((pos - k - 0.55) / 0.45)), act = Math.round(hl);
  const WX = 200, WY = 150;
  return <div style={abs(0, 0, { width: 1920, height: 1080 })}>
    <div style={abs(0, 54, { width: 1920, textAlign: 'center', font: '700 52px/1 ' + F.ui, letterSpacing: '-.03em', color: SB.ink, opacity: cap * (1 - ex) })}>Tudo da agência num lugar só.</div>
    <div style={abs(WX, WY, { width: 1520, height: 820, borderRadius: 24, background: '#fff', boxShadow: SH, overflow: 'hidden', opacity: e * (1 - ss((ex - 0.35) / 0.65)), transform: 'scale(' + lp(0.94, 1, e) * lp(1, 2.4, ex) + ')', transformOrigin: '150px 624px' })}>
      <div style={abs(0, 0, { width: 300, height: 820, borderRight: '1px solid ' + SB.line, background: '#FCFCFD' })}>
        <div style={abs(30, 34, {})}><Wordmark size={34} T={T} /></div>
        <div style={abs(16, 120 + hl * 60, { width: 268, height: 48, borderRadius: 12, background: SB.soft })} />
        {NAV.map((n, i) => <div key={n} style={abs(36, 120 + i * 60, { height: 48, width: 240, display: 'flex', alignItems: 'center', gap: 16, font: (i === act ? '600' : '500') + ' 24px/1 ' + F.ui, color: i === act ? SB.blue : SB.body })}><span style={{ width: 18, height: 18, borderRadius: 6, border: '2.5px solid currentColor', boxSizing: 'border-box' }} />{n}{i === 8 && <span style={{ marginLeft: 'auto' }}><XPill size={20} /></span>}</div>)}
      </div>
      <div style={abs(340, 40, { font: '600 44px/1 ' + F.ui, letterSpacing: '-.02em', color: SB.ink })}>{NAV[act]}</div>
      <div style={abs(340, 96, { font: '500 22px/1 ' + F.ui, color: SB.mute })}>Marketing Pro · outubro de 2026</div>
      {KPI.map((q, i) => { const v = q[1] * ss((T - a - 0.8) / 1.6); return <div key={i} style={abs(340 + i * 290, 150, { width: 270, height: 150, borderRadius: 18, border: '1px solid ' + SB.line, boxSizing: 'border-box', padding: '24px 26px' })}><div style={{ font: '500 21px/1 ' + F.ui, color: SB.mute }}>{q[0]}</div><div style={{ font: '700 50px/1 ' + F.ui, letterSpacing: '-.03em', color: SB.ink, marginTop: 22, fontVariantNumeric: 'tabular-nums' }}>{q[2](v)}</div></div>; })}
      <div style={abs(340, 330, { width: 760, height: 450, borderRadius: 18, border: '1px solid ' + SB.line, boxSizing: 'border-box' })}>
        <div style={abs(28, 26, { font: '600 24px/1 ' + F.ui, color: SB.ink })}>Receita por mês</div>
        {BARS.map((h, i) => { const g = ss((T - a - 1.2 - i * 0.06) / 0.6); return <div key={i} style={abs(36 + i * 58, 410 - h * 3.3 * g, { width: 38, height: h * 3.3 * g, borderRadius: '8px 8px 3px 3px', background: i === 11 ? SB.blue : '#C7D0FF' })} />; })}
      </div>
      <div style={abs(1120, 330, { width: 360, height: 450, borderRadius: 18, border: '1px solid ' + SB.line, boxSizing: 'border-box' })}>
        <div style={abs(26, 26, { display: 'flex', alignItems: 'center', gap: 10, font: '600 24px/1 ' + F.ui, color: SB.ink })}><span style={{ width: 10, height: 10, borderRadius: '50%', background: SB.green, opacity: 0.5 + 0.5 * Math.sin(T * 6) }} />Xodós agora</div>
        {FEED.map((f, i) => { const p = MOTION.enter(T, a + 2.4 + i * 0.6, 0.5); return <div key={i} style={abs(20, 86 + i * 116, { width: 320, height: 100, opacity: p, transform: 'translateX(' + (1 - p) * 30 + 'px)' })}><Char kind={f[0]} size={50} state="working" x={32} y={74} /><div style={abs(74, 18, { width: 240, font: '500 21px/1.3 ' + F.ui, color: SB.body })}>{f[1]}</div></div>; })}
      </div>
    </div>
  </div>;
}

const CREW = [['pingo', 'Faísca', 'Relatórios', 'Fecha o mês de cada cliente e publica no portal.', '700 66px/1 ' + F.brand], ['bibo', 'Zuca', 'Atendimento', 'Lê as mensagens e responde o que é simples.', '900 62px/1 ' + F.doto], ['oki', 'Nina', 'Campanhas', 'Vigia o CPL e sugere onde mexer na verba.', '700 52px/1 ' + F.unb]];
function Meet({ T, C }) {
  const a = C.Meet, b = C.Optimize; if (T < a - 0.1 || T > b + 0.1) return null;
  const h = MOTION.enter(T, a + 0.1, 0.6), out = MOTION.glide(T, b - 0.6, 0.6);
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: 1 - out })}>
    <div style={abs(0, 84, { width: 1920, textAlign: 'center', opacity: h, transform: 'translateY(' + (1 - h) * 24 + 'px)' })}>
      <div style={{ font: '700 92px/1.1 ' + F.ui, letterSpacing: '-.035em', color: SB.ink }}>Conheça os <span style={{ font: '700 104px/1 ' + F.brand, color: '#D9472A' }}>xodós</span>.</div>
      <div style={{ font: '500 36px/1.3 ' + F.ui, color: SB.mute, marginTop: 14 }}>Colegas de IA com computador próprio. Cada um com um trabalho.</div>
    </div>
    {CREW.map((c, i) => { const p = MOTION.pop(T, a + 0.8 + i * 0.5, 0.7), sp = SPECIES[c[0]].colors[0]; const st = T > a + 4.2 ? 'done' : ['working', 'listening', 'thinking'][i];
      return <div key={i} style={abs(260 + i * 480, 330, { width: 440, height: 600, borderRadius: 32, background: '#fff', boxShadow: SH, overflow: 'hidden', opacity: cl(p), transform: 'translateY(' + ((1 - p) * 120 - out * 80) + 'px)' })}>
        <div style={abs(0, 0, { width: 440, height: 340, background: sp.stage || '#F2F4F7' })}><Char kind={c[0]} size={c[0] === 'oki' ? 230 : 210} state={st} x={220} y={312} /></div>
        <div style={abs(36, 374, { width: 368 })}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}><span style={{ font: c[4], color: SB.ink }}>{c[1]}</span><span style={{ font: '600 22px/1 ' + F.mono, color: SB.mute, textTransform: 'uppercase', letterSpacing: '.06em' }}>{c[2]}</span></div>
          <div style={{ font: '500 28px/1.35 ' + F.ui, color: SB.body, marginTop: 24 }}>{c[3]}</div>
        </div>
      </div>; })}
  </div>;
}

const CPL = [16, 16.8, 15.6, 16.4, 17.1, 16.2, 17.4, 18.6, 21.1, 21.6, 21.0];
const CPL2 = [21.0, 18.9, 17.2, 16.1];
function Bubble({ x, y, p, text, font }) {
  return <div style={abs(x, y, { transform: 'translate(-50%,-100%) scale(' + Math.max(0, p) + ')', transformOrigin: '50% 100%', opacity: cl(p), background: '#fff', borderRadius: 28, padding: '22px 30px', boxShadow: SH, font: font || ('600 32px/1.2 ' + F.ui), color: SB.ink, whiteSpace: 'nowrap' })}>{text}<div style={abs('50%', '100%', { width: 26, height: 26, background: '#fff', transform: 'translate(-50%,-55%) rotate(45deg)', borderRadius: 4 })} /></div>;
}
function Optimize({ T, C }) {
  const a = C.Optimize, b = C.Report; if (T < a - 0.1 || T > b + 0.1) return null;
  const inn = MOTION.enter(T, a, 0.6), out = MOTION.glide(T, b - 0.5, 0.5);
  const W = 1040, H = 280, yOf = v => H - (v - 12) / 12 * H, xOf = i => i * (W / 14);
  const draw = ss((T - a - 0.4) / 1.6), tc = a + 4.7, draw2 = ss((T - tc - 0.3) / 1.0);
  const d1 = CPL.map((v, i) => (i ? 'L' : 'M') + xOf(i) + ' ' + yOf(v)).join(' '), d2 = CPL2.map((v, i) => (i ? 'L' : 'M') + xOf(i + 10) + ' ' + yOf(v)).join(' ');
  const alert = MOTION.pop(T, a + 2.2, 0.5) * (1 - MOTION.enter(T, tc + 0.8, 0.3)), ok = MOTION.pop(T, tc + 1.2, 0.5), sug = MOTION.enter(T, a + 3.1, 0.6);
  const mv = MOTION.glide(T, a + 3.8, 0.8), press = pressAt(T, tc), done = T > tc + 0.15;
  const st = T < a + 2.2 ? 'thinking' : T < a + 3.1 ? 'working' : T < tc ? 'needsYou' : 'done';
  const bk = T < a + 2.2 ? 0 : T < tc ? 1 : 2, bp = MOTION.pop(T, [a + 0.8, a + 2.3, tc + 0.4][bk], 0.45);
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: inn * (1 - out) })}>
    <Title T={T} t0={a + 0.1} x={640} y={58}>Nina otimiza as campanhas.</Title>
    <Char kind="oki" size={300} state={st} x={330} y={930} />
    <Bubble x={330} y={560} p={bp} text={['Hmm, o CPL subiu.', 'Achei onde ajustar.', 'De volta à meta!'][bk]} font={'600 30px/1.2 ' + F.unb} />
    <div style={abs(640, 150, { width: 1140, height: 500, borderRadius: 28, background: '#fff', boxShadow: SH })}>
      <div style={abs(50, 42, { font: '600 32px/1 ' + F.ui, color: SB.ink })}>Academia Pulse · CPL por dia</div>
      <div style={abs(50, 88, { font: '500 22px/1 ' + F.mono, color: SB.mute })}>META R$ 18,00</div>
      <div style={abs(740, 36, { width: 350, display: 'flex', justifyContent: 'flex-end' })}>
        {alert > 0.01 && <span style={{ transform: 'scale(' + Math.max(0, alert) + ')', background: '#FEE4E2', color: '#B42318', borderRadius: 999, padding: '12px 20px', font: '600 22px/1 ' + F.ui, whiteSpace: 'nowrap' }}>CPL 17% acima da meta há 3 dias</span>}
        {ok > 0.01 && <span style={{ transform: 'scale(' + Math.max(0, ok) + ')', background: '#DCFAE6', color: '#067647', borderRadius: 999, padding: '12px 20px', font: '600 22px/1 ' + F.ui, whiteSpace: 'nowrap' }}>De volta à meta · R$ 16,10</span>}
      </div>
      <svg width={W} height={H} viewBox={'0 0 ' + W + ' ' + H} style={abs(50, 160, { overflow: 'visible' })}>
        <line x1={0} x2={W} y1={yOf(18)} y2={yOf(18)} stroke="#98A2B3" strokeWidth={3} strokeDasharray="10 10" />
        <path d={d1} pathLength={1} fill="none" stroke={SB.blue} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1" strokeDashoffset={1 - draw} />
        <path d={d2} pathLength={1} fill="none" stroke={SB.green} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1" strokeDashoffset={1 - draw2} />
        {CPL.map((v, i) => draw * 10 >= i - 0.01 && <circle key={i} cx={xOf(i)} cy={yOf(v)} r={v > 18 ? 10 : 7} fill={v > 18 ? SB.red : SB.blue} />)}
        {CPL2.slice(1).map((v, i) => draw2 * 3 >= i + 0.99 && <circle key={'b' + i} cx={xOf(i + 11)} cy={yOf(v)} r={8} fill={SB.green} />)}
      </svg>
    </div>
    <div style={abs(640, 690, { width: 1140, height: 270, borderRadius: 28, background: '#fff', boxShadow: SH, opacity: sug, transform: 'translateY(' + (1 - sug) * 40 + 'px)' })}>
      <div style={abs(50, 40, { font: '600 22px/1 ' + F.mono, color: '#D9472A', letterSpacing: '.06em' })}>NINA SUGERE</div>
      <div style={abs(50, 80, { width: 1040, font: '600 33px/1.3 ' + F.ui, color: SB.ink })}>Pausar “Musculação 25–34” e passar R$ 300 para “Funcional”, que tem CPL 22% menor.</div>
      <div style={abs(50, 180, { display: 'flex', gap: 24, alignItems: 'center' })}>
        <div style={{ height: 64, padding: '0 30px', borderRadius: 14, display: 'flex', alignItems: 'center', background: done ? SB.green : SB.blue, color: '#fff', font: '600 26px/1 ' + F.ui, whiteSpace: 'nowrap' }}>{done ? '✓ Feito · verba ajustada' : 'Permitir uma vez'}</div>
        {!done && <div style={{ font: '600 26px/1 ' + F.ui, color: SB.mute }}>Negar</div>}
      </div>
    </div>
    {T > a + 3.6 && <Cursor x={lp(1700, 840, mv)} y={lp(1060, 902, mv)} press={press} op={1 - MOTION.enter(T, tc + 0.9, 0.4)} />}
  </div>;
}

const RPT = [['Loja Verano', '5,12x'], ['Clínica Aurora', '4,38x'], ['Imobiliária Horizonte', '3,91x'], ['Odonto Prime', '6,02x'], ['Academia Pulse', '4,75x'], ['Café Grão Nobre', '3,40x']];
const DONE_ROWS = [['Relatório de setembro publicado', 'Faísca'], ['Verba ajustada no Meta Ads', 'Nina'], ['4 dúvidas respondidas', 'Zuca']];
function Report({ T, C }) {
  const a = C.Report, b = C.Approve; if (T < a - 0.1 || T > b + 0.1) return null;
  const inn = MOTION.enter(T, a, 0.5), out = MOTION.glide(T, b - 0.5, 0.5);
  const n = Math.min(12, Math.round(cl((T - a - 0.6) / 3.0) * 12)), ph = MOTION.enter(T, a + 3.0, 0.7), nt = MOTION.pop(T, a + 3.9, 0.55);
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: inn * (1 - out) })}>
    <Title T={T} t0={a + 0.1} x={120} y={58}>Faísca fecha o mês.</Title>
    <div style={abs(120, 132, { font: '500 34px/1.2 ' + F.ui, color: SB.mute, opacity: MOTION.enter(T, a + 3.4, 0.5) })}>E o cliente vê o trabalho no portal.</div>
    <Char kind="pingo" size={280} state={T < a + 3.6 ? 'working' : 'done'} x={330} y={940} />
    <div style={abs(690, 210, { width: 420 })}>
      <div style={{ font: '600 26px/1 ' + F.ui, color: SB.mute }}>Relatórios de setembro</div>
      <div style={{ font: '700 66px/1 ' + F.ui, letterSpacing: '-.03em', color: SB.ink, marginTop: 14, fontVariantNumeric: 'tabular-nums' }}>{n} de 12</div>
      <div style={{ height: 10, borderRadius: 5, background: SB.line, marginTop: 18, overflow: 'hidden' }}><div style={{ height: '100%', width: (n / 12 * 100) + '%', background: n === 12 ? SB.green : SB.blue, borderRadius: 5 }} /></div>
    </div>
    {RPT.map((r, i) => { const t0 = a + 0.5 + i * 0.42; if (T < t0) return null; const f = MOTION.glide(T, t0, 0.6);
      const x = lp(420, 880 + i * 18, f), y = lp(720, 640 + i * 10, f) - Math.sin(f * Math.PI) * 170, rot = lp(-24, i % 2 ? 3 : -3, f);
      return <div key={i} style={abs(x, y, { width: 330, height: 400, marginLeft: -165, marginTop: -200, borderRadius: 18, background: '#fff', boxShadow: SH, overflow: 'hidden', transform: 'rotate(' + rot + 'deg) scale(' + lp(0.3, 1, f) + ')' })}>
        <div style={{ height: 12, background: SB.blue }} />
        <div style={{ padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ font: '600 15px/1 ' + F.mono, color: SB.mute, letterSpacing: '.08em' }}>MARKETING PRO</span>
          <span style={{ font: '600 27px/1.15 ' + F.ui, color: SB.ink }}>{r[0]}</span>
          <span style={{ font: '500 19px/1 ' + F.ui, color: SB.mute }}>Relatório de setembro</span>
          <span style={{ font: '700 64px/1 ' + F.ui, color: SB.blue, letterSpacing: '-.03em', marginTop: 14 }}>{r[1]}</span>
          <span style={{ font: '500 18px/1 ' + F.ui, color: SB.mute }}>ROAS do mês</span>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 70, marginTop: 10 }}>{[40, 58, 46, 70, 62, 84].map((h, j) => <span key={j} style={{ flex: 1, height: h * 0.8, borderRadius: 4, background: j === 5 ? SB.blue : '#C7D0FF' }} />)}</div>
        </div>
      </div>; })}
    <div style={abs(1400, 150, { width: 400, height: 820, borderRadius: 60, background: SB.ink, opacity: ph, transform: 'translateX(' + (1 - ph) * 200 + 'px)' })}>
      <div style={abs(14, 14, { width: 372, height: 792, borderRadius: 48, background: SB.bg, overflow: 'hidden' })}>
        <div style={abs(0, 0, { width: 372, height: 150, background: '#fff', borderBottom: '1px solid ' + SB.line })}>
          <div style={abs(28, 74, { font: '700 28px/1 ' + F.ui, color: SB.ink })}>Loja Verano</div>
          <div style={abs(28, 112, { font: '500 18px/1 ' + F.ui, color: SB.mute })}>Portal · Marketing Pro</div>
        </div>
        <div style={abs(20, 176, { width: 332, borderRadius: 22, background: '#fff', padding: '22px 22px 10px', boxSizing: 'border-box' })}>
          <div style={{ font: '600 21px/1 ' + F.ui, color: SB.ink, marginBottom: 12 }}>Feito pela sua agência</div>
          {DONE_ROWS.map((d, i) => { const p = MOTION.enter(T, a + 4.4 + i * 0.35, 0.4); return <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 0', borderTop: '1px solid ' + SB.line, opacity: p, transform: 'translateY(' + (1 - p) * 12 + 'px)' }}><span style={{ width: 26, height: 26, borderRadius: '50%', background: '#DCFAE6', color: '#067647', font: '700 15px/26px ' + F.ui, textAlign: 'center', flexShrink: 0 }}>✓</span><span style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ font: '600 19px/1.25 ' + F.ui, color: SB.ink }}>{d[0]}</span><span style={{ font: '500 16px/1 ' + F.ui, color: SB.mute }}>por {d[1]} · hoje</span></span></div>; })}
        </div>
        <div style={abs(14, 20, { width: 344, borderRadius: 22, background: 'rgba(16,24,40,.94)', color: '#fff', padding: '18px 20px', boxSizing: 'border-box', opacity: cl(nt), transform: 'translateY(' + (1 - cl(nt)) * -120 + 'px)' })}>
          <div style={{ font: '600 15px/1 ' + F.mono, letterSpacing: '.06em', color: '#A4BCFD' }}>MARKETING PRO · AGORA</div>
          <div style={{ font: '600 20px/1.3 ' + F.ui, marginTop: 8 }}>Seu relatório de setembro chegou. ROAS 5,12x, acima da meta.</div>
        </div>
      </div>
    </div>
  </div>;
}

const CONF = Array.from({ length: 44 }, (_, i) => { const r = Math.sin(i * 91.7) * 43758.5453, f = r - Math.floor(r), g = Math.sin(i * 12.9) * 9999, h = g - Math.floor(g); return { ang: -Math.PI / 2 + (f - 0.5) * 2.4, sp: 600 + h * 700, c: ['#EF5B3B', '#F6C443', '#465FFF', '#12B76A', '#C9B8F2', '#9FE3C5'][i % 6], w: 12 + (i % 3) * 6, rot: f * 720 }; });
function Approve({ T, C }) {
  const a = C.Approve, b = C.Proof; if (T < a - 0.1 || T > b + 0.1) return null;
  const inn = MOTION.enter(T, a, 0.5), out = MOTION.glide(T, b - 0.5, 0.5), h1 = MOTION.enter(T, a + 0.2, 0.6), h2 = MOTION.enter(T, a + 0.7, 0.6);
  const ph = MOTION.enter(T, a + 0.1, 0.7), nt = MOTION.pop(T, a + 0.5, 0.5), cd = MOTION.enter(T, a + 1.0, 0.5);
  const tc = a + 2.5, mv = MOTION.glide(T, a + 1.6, 0.8), press = pressAt(T, tc), done = T > tc + 0.15, ct = T - tc - 0.1;
  const BX = 1340, BY = 769;
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: inn * (1 - out) })}>
    <div style={abs(140, 250, { width: 900 })}>
      <div style={{ font: '700 104px/1.02 ' + F.ui, letterSpacing: '-.04em', color: SB.ink, opacity: h1, transform: 'translateY(' + (1 - h1) * 30 + 'px)' }}>Nada sai<br />sem você.</div>
      <div style={{ font: '500 40px/1.3 ' + F.ui, color: SB.mute, marginTop: 28, opacity: h2, transform: 'translateY(' + (1 - h2) * 20 + 'px)' }}>Aprovações pelo celular, num toque.</div>
    </div>
    <Char kind="bibo" size={240} state={done ? 'done' : 'needsYou'} x={560} y={1010} />
    <div style={abs(1120, 80, { width: 440, height: 920, borderRadius: 64, background: SB.ink, opacity: ph, transform: 'translateY(' + (1 - ph) * 120 + 'px)' })}>
      <div style={abs(14, 14, { width: 412, height: 892, borderRadius: 52, background: SB.bg, overflow: 'hidden' })}>
        <div style={abs(20, 40, { width: 372, borderRadius: 22, background: 'rgba(16,24,40,.94)', color: '#fff', padding: '18px 20px', boxSizing: 'border-box', opacity: cl(nt), transform: 'translateY(' + (1 - cl(nt)) * -120 + 'px)' })}>
          <div style={{ font: '600 15px/1 ' + F.mono, letterSpacing: '.06em', color: '#A4BCFD' }}>SPHERUM · AGORA</div>
          <div style={{ font: '600 21px/1.3 ' + F.ui, marginTop: 8 }}>Zuca precisa de você</div>
        </div>
        <div style={abs(20, 200, { width: 372, height: 620, borderRadius: 26, background: '#fff', boxShadow: '0 8px 24px rgba(16,24,40,.08)', opacity: cd, transform: 'translateY(' + (1 - cd) * 30 + 'px)' })}>
          <div style={abs(26, 28, { width: 320, height: 56 })}><Char kind="bibo" size={52} state="needsYou" x={26} y={56} /><div style={abs(66, 8, { font: '600 22px/1 ' + F.ui, color: SB.ink })}>Zuca</div><div style={abs(66, 36, { font: '500 17px/1 ' + F.ui, color: SB.mute })}>Atendimento</div></div>
          <div style={abs(26, 110, { width: 320, font: '600 29px/1.3 ' + F.ui, color: SB.ink })}>Responder a Clínica Aurora sobre a fatura vencida</div>
          <div style={abs(26, 250, { width: 320, borderRadius: 18, background: SB.bg, padding: '18px 20px', boxSizing: 'border-box', font: '500 21px/1.42 ' + F.ui, color: SB.body })}>“Oi, Carolina! A fatura de setembro venceu há 3 dias. Quer que eu reenvie o boleto atualizado?”</div>
          <div style={abs(26, 440, { width: 320, height: 70, borderRadius: 16, background: done ? SB.green : SB.blue, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '600 25px/1 ' + F.ui })}>{done ? '✓ Permitido · enviado' : 'Permitir uma vez'}</div>
          <div style={abs(26, 524, { width: 320, height: 62, borderRadius: 16, border: '2px solid ' + SB.line, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '600 23px/1 ' + F.ui, color: SB.ink, opacity: done ? 0.35 : 1 })}>Sempre permitir</div>
        </div>
      </div>
    </div>
    {ct > 0 && ct < 2.2 && CONF.map((p, i) => { const x = BX + Math.cos(p.ang) * p.sp * ct, y = BY + Math.sin(p.ang) * p.sp * ct + 900 * ct * ct; return <div key={i} style={abs(x, y, { width: p.w, height: p.w * 0.6, background: p.c, borderRadius: 3, transform: 'rotate(' + (p.rot + ct * 600) + 'deg)', opacity: 1 - cl((ct - 1.4) / 0.8) })} />; })}
    {T > a + 1.4 && <Cursor x={lp(1760, BX, mv)} y={lp(1080, BY, mv)} press={press} op={1 - MOTION.enter(T, tc + 0.8, 0.4)} />}
  </div>;
}

const PROOF = [[5.1, v => v.toFixed(1).replace('.', ',') + 'x', 'ROAS médio da carteira'], [32, v => '−' + Math.round(v) + '%', 'de CPL em 90 dias'], [12, v => Math.round(v) + ' de 12', 'relatórios no prazo']];
function Proof({ T, C }) {
  const a = C.Proof, b = C.Tools; if (T < a - 0.1 || T > b + 0.1) return null;
  const out = MOTION.glide(T, b - 0.5, 0.5);
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: 1 - out })}>
    <Title T={T} t0={a + 0.1} x={0} y={190} w={1920} center><span style={{ fontSize: 92 }}>Prove o retorno. Até a venda.</span></Title>
    <div style={abs(0, 320, { width: 1920, textAlign: 'center', font: '500 38px/1.3 ' + F.ui, color: SB.mute, opacity: MOTION.enter(T, a + 0.6, 0.5) })}>Do clique ao contrato assinado, no portal do cliente.</div>
    {PROOF.map((p, i) => { const e = MOTION.enter(T, a + 1.0 + i * 0.35, 0.6), v = p[0] * ss((T - a - 1.0 - i * 0.35) / 1.4);
      return <div key={i} style={abs(260 + i * 480, 480, { width: 440, textAlign: 'center', opacity: e, transform: 'translateY(' + (1 - e) * 40 + 'px)' })}>
        <div style={{ font: '700 150px/1 ' + F.ui, letterSpacing: '-.05em', color: i === 2 ? SB.green : SB.blue, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{p[1](v)}</div>
        <div style={{ height: 2, background: SB.line, margin: '30px 40px 26px' }} />
        <div style={{ font: '500 34px/1.25 ' + F.ui, color: SB.body }}>{p[2]}</div>
      </div>; })}
  </div>;
}

const TOOLS = [
  ['Vender', '#465FFF', ['Prospecção', 'Caixa de conversas', 'Pontuação de leads', 'Formulários', 'Agendamentos', 'Propostas']],
  ['Criar e publicar', '#7A5AF8', ['Estúdio de criativos', 'Calendário de conteúdo', 'Aprovação pelo celular', 'Publicar no Meta']],
  ['Provar', '#0E9384', ['Retorno', 'Busca por IA', 'Radar de risco']],
  ['Operar', '#E04F8E', ['Automações', 'Chamados', 'Atas de reunião', 'Chat da equipe', 'App de celular']],
  ['Gerir', '#F79009', ['Xodós', 'DRE do mês', 'Contratos', 'Notas e cobranças', 'Integrações', 'Academy', 'Conquistas']]];
function Tools({ T, C }) {
  const a = C.Tools, b = C.Close; if (T < a - 0.1 || T > b + 0.1) return null;
  const out = MOTION.glide(T, b - 0.55, 0.55), cnt = Math.round(25 * ss((T - a - 0.9) / 3.2)), tag = MOTION.pop(T, a + 4.2, 0.6);
  let k = 0;
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: 1 - out, transform: 'scale(' + lp(1, 1.04, out) + ')' })}>
    <Title T={T} t0={a + 0.1} x={0} y={80} w={1920} center><span style={{ fontSize: 84 }}>E tudo o que a agência usa.</span></Title>
    <div style={abs(0, 190, { width: 1920, textAlign: 'center', font: '500 36px/1.3 ' + F.ui, color: SB.mute, opacity: MOTION.enter(T, a + 0.5, 0.5) })}>Do primeiro lead ao DRE do mês, com os mesmos clientes.</div>
    <div style={abs(130, 290, { width: 1660, display: 'flex', gap: 22, alignItems: 'flex-start' })}>
      {TOOLS.map((g, gi) => { const he = MOTION.enter(T, a + 0.8 + gi * 0.25, 0.5);
        return <div key={gi} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: he, transform: 'translateY(' + (1 - he) * 16 + 'px)', font: '600 22px/1 ' + F.mono, letterSpacing: '.08em', textTransform: 'uppercase', color: SB.body, padding: '0 6px 6px' }}><span style={{ width: 14, height: 14, borderRadius: '50%', background: g[1] }} />{g[0]}</div>
          {g[2].map((t, i) => { const p = MOTION.pop(T, a + 1.0 + gi * 0.25 + i * 0.16, 0.5); k++;
            const hot = (t === 'Xodós' || t === 'Publicar no Meta' || t === 'DRE do mês' || t === 'Pontuação de leads') && T > a + 3.6;
            return <div key={i} style={{ opacity: cl(p), transform: 'translateY(' + (1 - cl(p)) * 26 + 'px) scale(' + lp(0.8, 1, Math.max(0, p)) + ')', background: hot ? g[1] : '#fff', color: hot ? '#fff' : SB.ink, borderRadius: 16, padding: '17px 20px', boxShadow: '0 12px 28px -14px rgba(16,24,40,.25), 0 0 0 1px rgba(16,24,40,.05)', font: '600 26px/1.15 ' + F.ui, letterSpacing: '-.01em', transition: 'background .3s' }}>{t}</div>; })}
        </div>; })}
    </div>
    <div style={abs(960, 990, { transform: 'translate(-50%,-50%) scale(' + Math.max(0, tag) + ')', opacity: cl(tag), display: 'flex', alignItems: 'center', gap: 18, background: SB.ink, color: '#fff', borderRadius: 999, padding: '18px 34px', font: '600 32px/1 ' + F.ui, whiteSpace: 'nowrap' })}><span style={{ fontVariantNumeric: 'tabular-nums', color: '#8B9BFF' }}>{cnt}</span>ferramentas, liberadas conforme o plano</div>
  </div>;
}

function Close({ T, C, total }) {
  const a = C.Close; if (T < a - 0.1) return null;
  const op = MOTION.enter(T, a, 0.4) * (1 - MOTION.glide(T, total - 0.6, 0.6));
  const w = MOTION.pop(T, a + 0.1, 0.7), x = MOTION.pop(T, a + 0.7, 0.6), tg = MOTION.enter(T, a + 1.2, 0.6), pl = MOTION.enter(T, a + 1.7, 0.5);
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: op })}>
    <div style={abs(960, 330, { transform: 'translate(-50%,-50%)', display: 'flex', alignItems: 'center', gap: 40 })}>
      <div style={{ transform: 'scale(' + lp(0.7, 1, Math.max(0, w)) + ')', opacity: cl(w) }}><Wordmark size={130} T={T} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 34, opacity: cl(x), transform: 'scale(' + Math.max(0, x) + ')' }}><span style={{ font: '500 64px/1 ' + F.ui, color: SB.mute }}>com</span><XPill size={120} /></div>
    </div>
    <div style={abs(0, 510, { width: 1920, textAlign: 'center', font: '500 46px/1.3 ' + F.ui, color: SB.body, opacity: tg, transform: 'translateY(' + (1 - tg) * 20 + 'px)' })}>O sistema da sua agência, com colegas de IA que trabalham junto.</div>
    <div style={abs(960, 610, { transform: 'translateX(-50%)', opacity: pl, font: '600 26px/1 ' + F.mono, letterSpacing: '.06em', color: SB.ink, border: '2px solid ' + SB.ink, borderRadius: 999, padding: '16px 26px', whiteSpace: 'nowrap' })}>XODÓS A PARTIR DO PLANO AGÊNCIA</div>
    {[['pingo', 660, 0], ['bibo', 960, 0.18], ['oki', 1260, 0.36]].map(([k, cx, d]) => { const p = MOTION.pop(T, a + 0.9 + d, 0.6), hop = Math.abs(Math.sin((T - a) * 5 + d * 9)) * 30 * cl(p); return <Char key={k} kind={k} size={k === 'oki' ? 200 : 180} state={T > a + 2 ? 'done' : 'idle'} x={cx} y={1020 - hop + (1 - cl(p)) * 300} op={cl(p)} />; })}
  </div>;
}

function Piece() {
  const { T, CUES: C, authoredTotal } = useComposition();
  const drift = 1 + 0.012 * Math.sin(T * 0.4);
  return <div data-screen-label={'t=' + Math.floor(T) + 's'} style={{ position: 'absolute', inset: 0, background: SB.bg, overflow: 'hidden', fontFamily: F.ui, color: SB.ink }}>
    <div style={abs(0, 0, { width: 1920, height: 1080, transform: 'scale(' + drift + ')' })}>
      <Chaos T={T} C={C} /><Platform T={T} C={C} /><Meet T={T} C={C} /><Optimize T={T} C={C} /><Report T={T} C={C} /><Approve T={T} C={C} /><Proof T={T} C={C} /><Tools T={T} C={C} /><Close T={T} C={C} total={authoredTotal} />
    </div>
  </div>;
}

window.SpherumVideo = function SpherumVideo() {
  return <CompositionStage width={1920} height={1080} scenes={window.OM_SCENES} playback={window.OM_PLAYBACK} bg="#F7F8FA"><Piece /></CompositionStage>;
};
