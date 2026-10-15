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
const F = { brand: "'Fredoka',sans-serif", ui: "'Geist',sans-serif", mono: "'Geist Mono',monospace", doto: "'Doto',monospace", unb: "'Unbounded',sans-serif", figtree: "'Figtree',sans-serif" };
const abs = (x, y, extra) => ({ position: 'absolute', left: x, top: y, ...extra });

function Char({ kind, size, state, x, y, sx = 1, sy = 1, rot = 0, op = 1 }) {
  const sp = SPECIES[kind], c = sp.colors[0], base = { size, state, motion: false, follow: false };
  const el = kind === 'pingo' ? _h(PingoBot, { ...base, color: c.body, eye: c.eye, ink: '#2B1D16' }) : kind === 'bibo' ? _h(BiboBot, { ...base, body: c.body }) : _h(OkiBot, { ...base, body: c.body, mouth: c.mouth, sats: c.sats });
  return <div style={abs(x, y, { transform: 'translate(-50%,-100%) rotate(' + rot + 'deg) scale(' + sx + ',' + sy + ')', transformOrigin: '50% 100%', opacity: op })}>{el}</div>;
}

function Opening({ T, C }) {
  const t0 = C.Opening, fall = Easing.easeInQuad(clamp((T - t0 - 0.2) / 0.7, 0, 1));
  const land = MOTION.pop(T, t0 + 0.9, 0.45), slide = MOTION.glide(T, t0 + 1.25, 0.8);
  const y = lerp(-80, 700, fall), squash = T < t0 + 0.9 ? 1 : lerp(0.7, 1, land);
  const out = MOTION.glide(T, C.Chaos - 0.5, 0.6);
  const x = lerp(960, 690, slide), word = MOTION.pop(T, t0 + 1.5, 0.6), sub = MOTION.enter(T, t0 + 2.2);
  const bob = Math.sin(T * 3) * 6 * slide;
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: 1 - out, transform: 'translateY(' + (-out * 120) + 'px)' })}>
    <Char kind="pingo" size={300} state={T > t0 + 1.5 ? 'done' : 'idle'} x={x} y={y + bob} sx={1 / squash * (T < t0 + 0.9 ? 0.92 : 1)} sy={squash * (T < t0 + 0.9 ? 1.08 : 1)} />
    <div style={abs(870, 360, { font: '700 300px/1 ' + F.brand, letterSpacing: '-.045em', color: P.ink, opacity: word, transform: 'scale(' + lerp(0.6, 1, word) + ')', transformOrigin: '0% 70%' })}>xodó</div>
    <div style={abs(880, 690, { font: '500 44px/1.2 ' + F.ui, color: P.mute, opacity: sub, transform: 'translateY(' + (1 - sub) * 20 + 'px)' })}>seu novo colega de IA</div>
  </div>;
}

const CHAOS = [['48 e-mails não lidos', 'Gmail', P.coral], ['Reunião às 15h', 'Agenda', P.sun], ['Relatório atrasado', 'Drive', P.lilac], ['Fatura vence hoje', 'Financeiro', P.coral], ['Responder a Marina', 'WhatsApp', P.mint], ['14 abas de pesquisa', 'Navegador', P.lime], ['Proposta para sexta', 'Notion', P.sun], ['Lembrete: ligar pro banco', 'Agenda', P.lilac]];
function Chaos({ T, C }) {
  const t0 = C.Chaos, op = vis(T, t0 - 0.2, C.Meet, 0.4), head = MOTION.enter(T, t0 + 0.2, 0.7);
  const peek = MOTION.pop(T, t0 + 3.6, 0.5), jump = MOTION.glide(T, t0 + 4.4, 0.6), shake = T > t0 + 1 && T < t0 + 4.4 ? Math.sin(T * 40) * 3 : 0;
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: op })}>
    <div style={abs(140, 170, { font: '700 120px/0.95 ' + F.brand, letterSpacing: '-.03em', color: P.ink, opacity: head, transform: 'translateX(' + (1 - head) * -40 + 'px)', width: 620 })}>Muita coisa. Pouco tempo.</div>
    <div style={abs(860, 120, { width: 920, height: 840, transform: 'translateX(' + shake + 'px)' })}>
      {CHAOS.map((c, i) => {
        const s = t0 + 0.5 + i * 0.32, p = MOTION.pop(T, s, 0.5), rot = ((i * 37) % 17) - 8, sweep = MOTION.glide(T, t0 + 4.4 + i * 0.03, 0.5);
        return <div key={i} style={abs(80 + (i % 2) * 300 + ((i * 53) % 60), 60 + i * 86, { width: 480, background: P.white, borderRadius: 24, padding: '22px 26px', boxSizing: 'border-box', boxShadow: '0 18px 40px rgba(0,0,0,.12)', display: 'flex', alignItems: 'center', gap: 18, opacity: p * (1 - sweep), transform: 'translate(' + sweep * 900 + 'px,' + (1 - p) * 60 + 'px) rotate(' + (rot + sweep * 30) + 'deg) scale(' + lerp(0.7, 1, p) + ')' })}>
          <span style={{ width: 18, height: 18, borderRadius: 9, background: c[2], flex: 'none' }}></span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ font: '600 30px/1.1 ' + F.ui, color: P.ink }}>{c[0]}</span><span style={{ font: '600 18px/1 ' + F.mono, color: P.mute, letterSpacing: '.06em', textTransform: 'uppercase' }}>{c[1]}</span></span>
        </div>;
      })}
    </div>
    <Char kind="pingo" size={220} state={T > t0 + 4.3 ? 'working' : 'needsYou'} x={lerp(1800, 1300, jump)} y={lerp(1180, 1180 - 260 * peek, 1) - jump * 120} rot={lerp(-14, 0, jump)} />
  </div>;
}

const MEET = [['pingo', 'Pingo', 'Gota de brinquedo. Amassa, estica e quica.', P.sun], ['bibo', 'Bibo', 'Rosto de LED, ponto a ponto.', P.lilac], ['oki', 'Oki', 'Núcleo com satélites que orbitam.', P.lime]];
function Meet({ T, C }) {
  const t0 = C.Meet, op = vis(T, t0 - 0.45, C.Work, 0.4), head = MOTION.enter(T, t0 + 2.4, 0.7);
  const zoom = lerp(1, 1.04, clamp((T - t0) / 6.5, 0, 1));
  const states = ['listening', 'thinking', 'done'];
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: op, transform: 'scale(' + zoom + ')' })}>
    <div style={abs(0, 90, { width: 1920, textAlign: 'center', font: '700 96px/1 ' + F.brand, letterSpacing: '-.02em', color: P.ink, opacity: head, transform: 'translateY(' + (1 - head) * 30 + 'px)' })}>Escolha o seu.</div>
    {MEET.map((m, i) => {
      const s = t0 - 0.35 + i * 0.5, p = MOTION.pop(T, s, 0.6), st = states[Math.min(2, Math.max(0, Math.floor((T - s - 0.6) / 1.6)))];
      const hop = st === 'done' ? Math.abs(Math.sin((T - s) * 6)) * 26 : Math.sin(T * 2.4 + i) * 6;
      const x = 180 + i * 540;
      return <div key={i} style={abs(x, 240, { width: 500, height: 700, borderRadius: 40, background: m[3], overflow: 'hidden', opacity: clamp(p, 0, 1), transform: 'translateY(' + (1 - p) * 140 + 'px) rotate(' + (1 - p) * (i - 1) * 6 + 'deg)', backgroundImage: m[0] === 'bibo' ? 'radial-gradient(rgba(20,23,20,.16) 2px,transparent 2.5px)' : 'none', backgroundSize: '16px 16px' })}>
        <Char kind={m[0]} size={m[0] === 'oki' ? 270 : 250} state={T < s + 0.6 ? 'idle' : st} x={250} y={430 - hop} />
        <div style={abs(40, 480, { width: 420, background: P.white, borderRadius: 26, padding: '24px 28px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12 })}>
          <span style={{ font: SPECIES[m[0]].font.replace(/\d+px/, '46px'), color: P.ink }}>{m[1]}</span>
          <span style={{ font: '500 24px/1.35 ' + F.ui, color: P.mute }}>{m[2]}</span>
        </div>
      </div>;
    })}
  </div>;
}

const STEPS = ['Abrir o Gmail', 'Ler 48 e-mails', 'Separar o que importa', 'Rascunhar 3 respostas'];
function AppWindow({ T, C }) {
  const t0 = C.Work, op = vis(T, t0 - 0.1, C.Brain, 0.45), enter = MOTION.enter(T, t0, 0.8);
  const step = clamp(Math.floor((T - t0 - 1.6) / 1.1), 0, 4), k = T < t0 + 1.6 ? 0 : step;
  const zin = MOTION.glide(T, t0 + 2.6, 1.2), zout = MOTION.glide(T, C.Approve - 1.2, 1.0), zapp = MOTION.glide(T, C.Approve + 0.1, 1.0), zend = MOTION.glide(T, C.Brain - 0.9, 0.8);
  let sc = 1 + 0.12 * zin * (1 - zout), tx = 0, ty = 0;
  sc += 0.55 * zapp * (1 - zend); tx += 535 * zapp * (1 - zend); ty += -320 * zapp * (1 - zend);
  const bubble1 = MOTION.pop(T, t0 + 0.5), bubble2 = MOTION.pop(T, t0 + 1.1), task = MOTION.enter(T, t0 + 1.4);
  const askIn = MOTION.pop(T, C.Approve - 0.5, 0.6);
  const curX = lerp(1240, 575, MOTION.glide(T, C.Approve + 0.6, 1.2)), curY = lerp(980, 772, MOTION.glide(T, C.Approve + 0.6, 1.2));
  const press = T > C.Approve + 1.9 && T < C.Approve + 2.15 ? 0.94 : 1, ok = T > C.Approve + 2.1;
  const hl = 30 + Math.min(k, 3) * 62 + Math.sin(T * 2) * 4;
  const botState = ok ? 'done' : T > C.Approve - 0.5 ? 'needsYou' : k >= 1 ? 'working' : 'thinking';
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: op })}>
    <div style={abs(160, 110, { width: 1600, height: 860, transform: 'translate(' + tx + 'px,' + ty + 'px) scale(' + sc * lerp(0.96, 1, enter) + ')', transformOrigin: '50% 50%' })}>
      <div style={abs(0, 0, { width: 1600, height: 860, background: P.white, borderRadius: 36, boxShadow: '0 30px 80px rgba(0,0,0,.14)', overflow: 'hidden', display: 'grid', gridTemplateColumns: '1fr 560px' })}>
        <div style={{ position: 'relative', borderRight: '2px solid ' + P.line, background: P.paper }}>
          <div style={abs(0, 0, { width: '100%', height: 110, borderBottom: '2px solid ' + P.line, display: 'flex', alignItems: 'center', gap: 20, padding: '0 34px', boxSizing: 'border-box' })}>
            <div style={{ width: 80, height: 84, position: 'relative' }}><Char kind="pingo" size={76} state={botState} x={40} y={84} /></div>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><span style={{ font: '600 34px/1 ' + F.brand }}>Faísca</span><span style={{ font: '500 20px/1 ' + F.ui, color: P.mute }}>{ok ? 'feito!' : botState === 'needsYou' ? 'precisa de você' : 'trabalhando no computador dele…'}</span></span>
            <span style={{ marginLeft: 'auto', border: '2px solid ' + P.line, borderRadius: 99, padding: '12px 20px', font: '600 20px/1 ' + F.ui, display: 'flex', gap: 10 }}><span style={{ font: '600 14px/1.4 ' + F.mono, color: P.mute }}>CÉREBRO</span>Claude Opus</span>
          </div>
          <div style={abs(820 - 540 - 20, 150, { width: 540, background: P.tomato, color: P.ink, borderRadius: '28px 28px 8px 28px', padding: '20px 26px', boxSizing: 'border-box', font: '500 26px/1.35 ' + F.ui, opacity: bubble1, transform: 'scale(' + lerp(0.8, 1, bubble1) + ')', transformOrigin: '100% 100%' })}>Organizar minha caixa de entrada</div>
          <div style={abs(40, 260, { width: 620, background: P.white, border: '2px solid ' + P.line, borderRadius: '28px 28px 28px 8px', padding: '20px 26px', boxSizing: 'border-box', font: '500 26px/1.35 ' + F.figtree, opacity: bubble2, transform: 'scale(' + lerp(0.8, 1, bubble2) + ')', transformOrigin: '0% 100%' })}>Bora! Vou abrir seu Gmail no meu computador.</div>
          <div style={abs(40, 380, { width: 620, background: P.white, border: '2px solid ' + P.line, borderRadius: 28, padding: '24px 28px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 16, opacity: task * (1 - MOTION.enter(T, C.Approve - 0.7, 0.4)) })}>
            <div style={{ display: 'flex', justifyContent: 'space-between', font: '600 26px/1 ' + F.ui }}><span>Organizar a caixa de entrada</span><span style={{ font: '600 22px/1 ' + F.mono, color: P.mute }}>{k}/4</span></div>
            <div style={{ height: 12, borderRadius: 99, background: P.chip, overflow: 'hidden' }}><div style={{ width: k * 25 + '%', height: '100%', background: P.tomato, borderRadius: 99 }}></div></div>
            {STEPS.map((s, i) => <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, font: '500 24px/1 ' + F.ui, color: i <= k ? P.ink : P.mute }}><span style={{ width: 28, height: 28, borderRadius: 14, boxSizing: 'border-box', border: '3px solid ' + (i < k ? P.tomato : i === k ? P.ink : P.line), background: i < k ? P.tomato : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '800 16px/1 ' + F.ui }}>{i < k ? '✓' : ''}</span>{s}</div>)}
          </div>
          <div style={abs(40, 520, { width: 700, background: P.white, border: '3px solid ' + (ok ? P.line : P.tomato), borderRadius: 30, padding: '28px 30px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 18, opacity: clamp(askIn, 0, 1), transform: 'translateY(' + (1 - askIn) * 40 + 'px)' })}>
            <span style={{ font: '600 34px/1.15 ' + F.brand }}>Posso enviar as 3 respostas?</span>
            <span style={{ font: '500 22px/1 ' + F.ui, color: P.mute }}>Como ana@estudio.com</span>
            {ok ? <span style={{ alignSelf: 'flex-start', background: P.tomato, borderRadius: 99, padding: '12px 20px', font: '600 22px/1 ' + F.ui, transform: 'scale(' + MOTION.pop(T, C.Approve + 2.1, 0.4) + ')' }}>✓ Permitido uma vez</span> :
              <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}><span style={{ border: '2.5px solid ' + P.ink, borderRadius: 99, padding: '16px 22px', font: '600 22px/1 ' + F.ui }}>Sempre permitir</span><span style={{ background: P.ink, color: P.white, borderRadius: 99, padding: '18px 26px', font: '600 22px/1 ' + F.ui, transform: 'scale(' + press + ')' }}>Permitir uma vez</span><span style={{ font: '600 22px/1 ' + F.ui, color: P.mute, padding: '0 8px' }}>Negar</span></div>}
          </div>
        </div>
        <div style={{ position: 'relative', padding: 34, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ font: '600 18px/1 ' + F.mono, letterSpacing: '.08em', color: P.mute }}>COMPUTADOR NA NUVEM</span><span style={{ display: 'flex', alignItems: 'center', gap: 10, font: '600 18px/1 ' + F.mono, color: P.mute }}><span style={{ width: 14, height: 14, borderRadius: 7, background: k > 0 && k < 4 ? P.coral : P.mute, opacity: k > 0 && k < 4 ? 0.55 + 0.45 * Math.abs(Math.sin(T * 4)) : 1 }}></span>{k > 0 && k < 4 ? 'AO VIVO' : 'EM REPOUSO'}</span></div>
          <div style={{ borderRadius: 24, overflow: 'hidden', border: '3px solid ' + P.ink, background: P.white }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: '#EDEAE4', borderBottom: '2px solid #DDD8CF' }}>{['#E0705A', '#E8B74A', '#6DBB7B'].map(c => <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }}></span>)}<span style={{ flex: 1, marginLeft: 8, background: P.white, borderRadius: 8, padding: '9px 12px', font: '500 18px/1 ' + F.mono, color: '#5D5850' }}>mail.google.com/inbox</span></div>
            <div style={{ position: 'relative', height: 300, padding: 20, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div style={abs(10, hl, { right: 10, height: 44, borderRadius: 12, background: P.tomato, opacity: k > 0 ? 0.3 : 0 })}></div>
              {[[22, 58], [30, 46], [18, 62], [26, 50]].map((r, i) => <div key={i} style={{ position: 'relative', height: 38, display: 'flex', alignItems: 'center', gap: 14 }}><span style={{ width: r[0] + '%', height: 12, borderRadius: 6, background: '#2B2824' }}></span><span style={{ width: r[1] + '%', height: 12, borderRadius: 6, background: '#CFC9BF' }}></span></div>)}
            </div>
          </div>
          <span style={{ font: '500 22px/1.4 ' + F.ui, color: P.mute }}>{k > 0 && k < 4 ? STEPS[Math.min(k, 3)] + '…' : 'Navegador, arquivos e terminal só dele.'}</span>
          <div style={{ marginTop: 'auto', background: P.paper, borderRadius: 22, padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', font: '600 22px/1 ' + F.ui }}><span>Hoje</span><span style={{ font: '600 20px/1 ' + F.mono }}>{'R$ ' + (k * 0.09).toFixed(2).replace('.', ',') + ' de R$ 20,00'}</span></div>
            <div style={{ height: 10, borderRadius: 99, background: P.chip, overflow: 'hidden' }}><div style={{ width: k * 1.8 + '%', height: '100%', background: P.ink }}></div></div>
          </div>
        </div>
      </div>
      <div style={abs(curX - 160, curY - 110, { width: 0, height: 0, opacity: MOTION.enter(T, C.Approve + 0.4, 0.3) * (1 - MOTION.enter(T, C.Approve + 3.2, 0.4)) })}>
        <div style={{ width: 0, height: 0, borderLeft: '16px solid transparent', borderRight: '16px solid transparent', borderBottom: '40px solid ' + P.ink, transform: 'rotate(-30deg) scale(' + (press < 1 ? 0.85 : 1) + ')', transformOrigin: '50% 0%', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,.25))' }}></div>
      </div>
    </div>
  </div>;
}

const CONF = ['#3E64DE', '#3DBB8E', '#FF9DA6', '#EF5B3B', '#F6C443', '#C9B8F2', '#3A3AF4', '#C8F04B'];
function Celebrate({ T, C }) {
  const s = C.Approve + 2.2, p = clamp((T - s) / 1.4, 0, 1), op = vis(T, s, s + 2.4, 0.2);
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: op, pointerEvents: 'none' })}>
    {Array.from({ length: 28 }).map((_, i) => { const a = i * 2.39, r = 120 + (i * 47) % 340, e = MOTION.enter(T, s, 1.1); return <span key={i} style={abs(880 + Math.cos(a) * r * e, 560 + Math.sin(a) * r * e + p * p * 260, { width: 18 + (i % 3) * 8, height: 18 + (i % 3) * 8, borderRadius: i % 4 === 0 ? 4 : 99, background: CONF[i % CONF.length], transform: 'rotate(' + i * 40 * p + 'deg)', opacity: 1 - p * 0.6 })}></span>; })}
  </div>;
}

const BRAINS = [['Claude Opus', 'Anthropic'], ['GPT-6 Astra', 'OpenAI'], ['Grok 4.6', 'xAI'], ['Gemini Ultra', 'Google'], ['Llama', 'roda no seu computador']];
const NOTES = ['Prefere foco pela manhã', 'Marina é fornecedora', 'Caixa de entrada às 8h', 'Tom: curioso'];
function Brain({ T, C }) {
  const t0 = C.Brain, op = vis(T, t0 - 0.15, C.Close + 0.1, 0.45), head = MOTION.enter(T, t0 + 0.3, 0.7);
  const idx = clamp(Math.floor((T - t0 - 0.6) / 0.75), 0, BRAINS.length - 1), sub = (T - t0 - 0.6) / 0.75 - idx, flip = idx > 0 || sub > 0 ? MOTION.pop(T, t0 + 0.6 + idx * 0.75, 0.35) : 1;
  const think = sub < 0.35 && T > t0 + 0.6 && T < t0 + 0.6 + BRAINS.length * 0.75;
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: op })}>
    <div style={abs(0, 110, { width: 1920, textAlign: 'center', font: '700 96px/1 ' + F.brand, letterSpacing: '-.02em', opacity: head, transform: 'translateY(' + (1 - head) * 30 + 'px)' })}>Troque o cérebro. O jeito fica.</div>
    <div style={abs(960, 300, { transform: 'translateX(-50%) scale(' + lerp(0.85, 1, flip) + ')', background: P.white, border: '3px solid ' + P.ink, borderRadius: 99, padding: '22px 34px', display: 'flex', alignItems: 'baseline', gap: 18, whiteSpace: 'nowrap' })}><span style={{ font: '600 20px/1 ' + F.mono, color: P.mute, letterSpacing: '.06em' }}>CÉREBRO</span><span style={{ font: '600 44px/1 ' + F.ui }}>{BRAINS[idx][0]}</span><span style={{ font: '500 26px/1 ' + F.ui, color: P.mute }}>{BRAINS[idx][1]}</span></div>
    <Char kind="pingo" size={300} state={think ? 'thinking' : 'idle'} x={960} y={860 + Math.sin(T * 3) * 6} />
    {NOTES.map((n, i) => { const a = T * 0.5 + i * Math.PI / 2, p = MOTION.pop(T, t0 + 0.8 + i * 0.25, 0.5); return <div key={i} style={abs(960 + Math.cos(a) * 560 - 190, 700 + Math.sin(a) * 150, { width: 380, textAlign: 'center', background: P.paper, border: '2.5px dashed ' + P.tomato, borderRadius: 20, padding: '16px 18px', boxSizing: 'border-box', font: '500 24px/1.3 ' + F.ui, opacity: clamp(p, 0, 1), transform: 'scale(' + lerp(0.6, 1, p) + ')' })}><span style={{ font: '600 15px/1 ' + F.mono, color: P.mute, letterSpacing: '.08em', display: 'block', marginBottom: 6 }}>MEMÓRIA</span>{n}</div>; })}
  </div>;
}

function Close({ T, C, total }) {
  const t0 = C.Close, op = vis(T, t0 - 0.3, total + 1, 0.4) * (1 - MOTION.glide(T, total - 0.7, 0.7));
  const word = MOTION.pop(T, t0 - 0.1, 0.7), tag = MOTION.enter(T, t0 + 0.8, 0.7);
  return <div style={abs(0, 0, { width: 1920, height: 1080, opacity: op })}>
    <div style={abs(0, 200, { width: 1920, textAlign: 'center', font: '700 340px/1 ' + F.brand, letterSpacing: '-.05em', opacity: clamp(word, 0, 1), transform: 'scale(' + lerp(0.7, 1, word) + ')' })}>xodó</div>
    <div style={abs(0, 560, { width: 1920, textAlign: 'center', font: '500 48px/1.3 ' + F.ui, color: P.mute, opacity: tag, transform: 'translateY(' + (1 - tag) * 20 + 'px)' })}>Colegas de IA com computador próprio, memória e jeito.</div>
    {[['pingo', 660, 0], ['bibo', 960, 0.18], ['oki', 1260, 0.36]].map(([k, x, d]) => { const p = MOTION.pop(T, t0 + 0.5 + d, 0.6), hop = Math.abs(Math.sin((T - t0) * 5 + d * 9)) * 30 * p; return <Char key={k} kind={k} size={k === 'oki' ? 210 : 190} state={T > t0 + 1.6 ? 'done' : 'idle'} x={x} y={1010 - hop + (1 - p) * 300} op={clamp(p, 0, 1)} />; })}
  </div>;
}

function Caption({ T, items }) {
  const it = items.find(x => T >= x[0] && T < x[1]); if (!it) return null;
  const p = vis(T, it[0], it[1], 0.35);
  return <div style={abs(960, 960, { transform: 'translate(-50%,' + (1 - p) * 20 + 'px)', opacity: p, background: '#161514', color: '#FFFFFF', borderRadius: 99, padding: '22px 38px', font: '600 34px/1.2 ' + F.ui, whiteSpace: 'nowrap', boxShadow: '0 12px 30px rgba(0,0,0,.2)' })}>{it[2]}</div>;
}
function Piece() {
  const { T, CUES: C, authoredTotal } = useComposition();
  const drift = 1 + 0.015 * Math.sin(T * 0.4);
  return <div data-screen-label={'t=' + Math.floor(T) + 's'} style={{ position: 'absolute', inset: 0, background: P.paper, overflow: 'hidden', fontFamily: F.ui, color: P.ink }}>
    <div style={abs(0, 0, { width: 1920, height: 1080, transform: 'scale(' + drift + ')' })}>
      <Opening T={T} C={C} /><Chaos T={T} C={C} /><Meet T={T} C={C} /><AppWindow T={T} C={C} /><Celebrate T={T} C={C} /><Brain T={T} C={C} /><Close T={T} C={C} total={authoredTotal} />
    </div>
    <Caption T={T} items={[[C.Work + 1.4, C.Approve - 0.6, 'Ele trabalha no computador dele. Você segue a vida.'], [C.Approve + 0.2, C.Brain - 0.4, 'E pergunta antes de enviar, pagar ou apagar.']]} />
  </div>;
}

window.XodoVideo = function XodoVideo() {
  return <CompositionStage width={1920} height={1080} scenes={window.OM_SCENES} playback={window.OM_PLAYBACK} bg="#F3F1EC"><Piece /></CompositionStage>;
};
