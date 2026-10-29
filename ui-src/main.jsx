import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, onServerChange } from "./api.js";
import { SPECIES, SP_KEYS, XodoChar } from "./bots.js";

// ---------------------------------------------------------------------------
// Textos e tabelas
// ---------------------------------------------------------------------------

const PERSONAS = [
  { k: "curioso", l: "Curioso", d: "Faz perguntas e sugere ideias." },
  { k: "brincalhao", l: "Brincalhão", d: "Leve, com piada na hora certa." },
  { k: "direto", l: "Direto", d: "Curto, objetivo, sem rodeio." },
  { k: "zen", l: "Zen", d: "Calmo, organiza o caos." },
];

const AUTONOMIES = [
  { k: "sempre_pergunta", l: "Sempre pergunta", d: "Só lê e pesquisa sozinho. Para escrever, mexer em arquivos ou avisar, pede antes." },
  { k: "pergunta_no_que_importa", l: "Pergunta no que importa", d: "Pesquisa, lê e organiza a pasta sozinho. Pede antes de enviar, apagar ou pagar.", rec: true },
  { k: "age_sozinho", l: "Age sozinho", d: "Faz tudo e te conta depois. Use só quando já confiar nele." },
];

const CATEGORY = {
  leitura: "Ler",
  rascunho: "Rascunho",
  memoria: "Memória",
  equipe: "Avisar você",
  alteracao: "Mudar algo",
  envio: "Enviar",
  exclusao: "Apagar",
  pagamento: "Pagar",
  campanha: "Campanha",
  cliente: "Falar com alguém",
};

const FEATURED = [
  { id: "anthropic", name: "Anthropic (Claude)", where: "console.anthropic.com → API Keys", url: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI (ChatGPT)", where: "platform.openai.com → API keys", url: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google (Gemini)", where: "aistudio.google.com → Get API key", url: "https://aistudio.google.com/apikey" },
  { id: "openrouter", name: "OpenRouter (vários)", where: "openrouter.ai → Keys", url: "https://openrouter.ai/keys" },
  { id: "local", name: "No meu computador", where: "Ollama ou LM Studio aberto no PC. Sem custo, mas mais lento." },
];

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

const THEMES = [
  { k: "sistema", icon: "monitor", l: "Igual ao Windows", d: "Segue o tema do computador." },
  { k: "claro", icon: "sun", l: "Claro", d: "Sempre claro." },
  { k: "escuro", icon: "moon", l: "Escuro", d: "Sempre escuro." },
];

// ---------------------------------------------------------------------------
// Tema (claro ou escuro). Fica guardado neste navegador.
// ---------------------------------------------------------------------------

const THEME_KEY = "xodos-tema";
const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function savedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.some((x) => x.k === t) ? t : "sistema";
  } catch {
    return "sistema";
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "claro") root.dataset.theme = "light";
  else if (theme === "escuro") root.dataset.theme = "dark";
  else delete root.dataset.theme;
}

// Antes da primeira pintura, para não piscar claro quando você escolheu escuro.
applyTheme(savedTheme());

function useTheme() {
  const [theme, setTheme] = useState(savedTheme);
  const [systemDark, setSystemDark] = useState(() => !!darkQuery?.matches);
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    if (!darkQuery) return;
    const f = (e) => setSystemDark(e.matches);
    darkQuery.addEventListener("change", f);
    return () => darkQuery.removeEventListener("change", f);
  }, []);
  const dark = theme === "escuro" || (theme === "sistema" && systemDark);
  return { theme, setTheme, dark };
}

// ---------------------------------------------------------------------------
// Pequenas peças
// ---------------------------------------------------------------------------

const cx = (...c) => c.filter(Boolean).join(" ");

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const f = () => setHash(location.hash.slice(1) || "/");
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return hash;
}
const go = (path) => {
  location.hash = path;
};

/** O Postgres devolve "2026-10-28 19:30:00.12+00"; o navegador só entende "…T19:30:00.12+00:00". */
function parseDate(iso) {
  return new Date(String(iso).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
}

function timeAgo(iso) {
  if (!iso) return "";
  const d = parseDate(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = parseDate(iso);
  return d.toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

const brl = (n) => (n ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function botState(x) {
  if (x.status === "paused") return "idle";
  if (x.pending > 0 || x.last_run?.status === "waiting_approval") return "needsYou";
  if (x.last_run?.status === "running") return "working";
  return "idle";
}
function stateLabel(x) {
  if (x.status === "paused") return "Pausado";
  const s = botState(x);
  if (s === "needsYou") return "Precisa de você";
  if (s === "working") return "Trabalhando…";
  if (x.last_run?.status === "failed") return "Travou na última tarefa";
  if (x.last_run?.status === "paused_budget") return "Parou: limite do dia";
  return "Disponível";
}

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={cx("toast", toast.bad && "toast-bad")} role="status">
      {toast.msg}
    </div>
  );
}

function Field({ label, hint, children, error }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="empty-text">{children}</p>}
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const hash = useHash();
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [tick, setTick] = useState(0);
  const toastTimer = useRef(0);
  const theme = useTheme();

  const notify = useCallback((msg, bad = false) => {
    setToast({ msg, bad });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), bad ? 6000 : 3200);
  }, []);

  const reload = useCallback(async () => {
    try {
      setOverview(await api("/estado"));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Algo mudou no servidor: atualiza a visão geral e avisa a tela aberta.
  useEffect(() => {
    let t = 0;
    return onServerChange(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        reload();
        setTick((n) => n + 1);
      }, 250);
    });
  }, [reload]);

  // Rede de segurança: a cada 20 s, mesmo sem eventos.
  useEffect(() => {
    const id = setInterval(() => {
      reload();
      setTick((n) => n + 1);
    }, 20000);
    return () => clearInterval(id);
  }, [reload]);

  if (error && !overview) {
    return (
      <div className="boot">
        <p className="boot-title">Não consegui falar com o app</p>
        <p>{error}</p>
        <button className="btn" onClick={() => location.reload()}>
          Tentar de novo
        </button>
      </div>
    );
  }
  if (!overview) return <div className="boot">Abrindo…</div>;

  const ctx = { overview, reload, notify, tick, theme };
  const needsSetup = !overview.nome || !overview.chaves.some((c) => !c.revoked_at) || overview.xodos.length === 0;
  if (needsSetup && !hash.startsWith("/configuracoes")) {
    return (
      <>
        <Welcome {...ctx} />
        <Toast toast={toast} />
      </>
    );
  }

  const [, section, id, tab] = hash.split("/");
  let page;
  if (section === "x" && id) page = <XodoPage key={id} id={id} tab={tab || "conversa"} {...ctx} />;
  else if (section === "aprovacoes") page = <ApprovalsPage {...ctx} />;
  else if (section === "avisos") page = <NoticesPage {...ctx} />;
  else if (section === "configuracoes") page = <SettingsPage {...ctx} />;
  else if (section === "integracoes") page = <IntegrationsPage {...ctx} />;
  else if (section === "novo") page = <NewXodoPage {...ctx} />;
  else page = <Home {...ctx} />;

  return (
    <div className="shell">
      <Sidebar overview={overview} hash={hash} theme={theme} />
      <main className="main">{page}</main>
      <Toast toast={toast} />
    </div>
  );
}

const BRAND_TRIO = [
  { species: "pingo", color: "Tomate" },
  { species: "bibo", color: "Menta" },
  { species: "oki", color: "Ultramar" },
];

function Brand() {
  return (
    <a href="#/" className="brand" aria-label="Xodós, início">
      <span className="brand-crew" aria-hidden="true">
        {BRAND_TRIO.map((x, i) => (
          <XodoChar key={x.species} xodo={x} size={i === 1 ? 26 : 30} follow={false} />
        ))}
      </span>
      <span className="brand-text">
        <span className="brand-name">Xodós</span>
        <span className="brand-tag">seus ajudantes de IA</span>
      </span>
    </a>
  );
}

// Ícones de traço (24×24), no estilo Lucide.
const ICONS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  check: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0",
  plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  plus: "M12 5v14M5 12h14",
  key: "M15.5 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM12 11v10M12 17h3M12 14h2",
  user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  palette: "M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-1.8a1.8 1.8 0 0 0-1.3 3.1A1.7 1.7 0 0 1 12 22zM7.5 11.5h.01M10.5 7.5h.01M15.5 7.5h.01",
  mail: "M3 5h18v14H3zM3 6l9 7 9-7",
  calendar: "M4 5h16v16H4zM4 10h16M8 3v4M16 3v4",
  folder: "M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z",
};

function Icon({ name, size = 18 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

function Sidebar({ overview, hash, theme }) {
  const item = (path, icon, label, badge) => (
    <a href={"#" + path} className={cx("nav", (hash === path || (path !== "/" && hash.startsWith(path))) && "nav-on")}>
      <Icon name={icon} />
      <span className="nav-label">{label}</span>
      {badge ? <span className="badge">{badge}</span> : null}
    </a>
  );
  return (
    <nav className="side" aria-label="Menu">
      <Brand />
      {item("/", "home", "Início")}
      {item("/aprovacoes", "check", "Aprovações", overview.aprovacoes_pendentes)}
      {item("/avisos", "bell", "Avisos", overview.avisos_nao_lidos)}
      <p className="side-head">Seus xodós</p>
      {overview.xodos.map((x) => (
        <a key={x.id} href={`#/x/${x.id}`} className={cx("side-xodo", hash.startsWith(`/x/${x.id}`) && "nav-on")}>
          <span className="side-char">
            <XodoChar xodo={x} size={30} state={botState(x)} follow={false} />
          </span>
          <span className="side-name">{x.name}</span>
          {x.pending > 0 && <span className="badge">{x.pending}</span>}
        </a>
      ))}
      <a href="#/novo" className="side-add">
        <span className="side-char">
          <Icon name="plus" />
        </span>
        Novo xodó
      </a>
      <div className="side-foot">
        {item("/integracoes", "plug", "Integrações")}
        {item("/configuracoes", "gear", "Configurações")}
        <div className="theme-switch" role="group" aria-label="Tema">
          <button type="button" className={cx(!theme.dark && "on")} aria-pressed={!theme.dark} onClick={() => theme.setTheme("claro")}>
            <Icon name="sun" size={16} />
            Claro
          </button>
          <button type="button" className={cx(theme.dark && "on")} aria-pressed={theme.dark} onClick={() => theme.setTheme("escuro")}>
            <Icon name="moon" size={16} />
            Escuro
          </button>
        </div>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

function Home({ overview, reload, notify, tick }) {
  const [approvals, setApprovals] = useState([]);
  const [notices, setNotices] = useState([]);
  useEffect(() => {
    api("/aprovacoes").then((r) => setApprovals(r.aprovacoes)).catch(() => {});
    api("/avisos").then((r) => setNotices(r.avisos.slice(0, 5))).catch(() => {});
  }, [tick, overview.aprovacoes_pendentes]);

  const spent = overview.xodos.reduce((s, x) => s + (x.spent_today_brl || 0), 0);
  return (
    <div className="page">
      <header className="page-head">
        <h1>
          {greeting()}, {overview.nome}
        </h1>
        <p className="muted">
          {approvals.length ? `${approvals.length} ${approvals.length === 1 ? "pedido espera" : "pedidos esperam"} você.` : "Nada esperando por você agora."} Gasto de hoje com IA: {brl(spent)}.
        </p>
      </header>

      <section className="crew">
        {overview.xodos.map((x) => (
          <a key={x.id} href={`#/x/${x.id}`} className="crew-card">
            <div className="crew-char">
              <XodoChar xodo={x} size={96} state={botState(x)} />
            </div>
            <div className="crew-text">
              <span className="crew-name">{x.name}</span>
              <span className="crew-role">{x.role || "Ajudante"}</span>
              <span className={cx("pill", botState(x) === "needsYou" && "pill-warn", botState(x) === "working" && "pill-live")}>{stateLabel(x)}</span>
            </div>
          </a>
        ))}
      </section>

      {approvals.length > 0 && (
        <section className="block">
          <h2>Esperando você</h2>
          <div className="stack">
            {approvals.slice(0, 4).map((a) => (
              <ApprovalCard key={a.id} a={a} showXodo onDone={reload} notify={notify} />
            ))}
          </div>
          {approvals.length > 4 && (
            <a className="link" href="#/aprovacoes">
              Ver todos os {approvals.length}
            </a>
          )}
        </section>
      )}

      {notices.length > 0 && (
        <section className="block">
          <h2>Avisos recentes</h2>
          <div className="stack">
            {notices.map((n) => (
              <Notice key={n.id} n={n} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aprovações
// ---------------------------------------------------------------------------

function ApprovalCard({ a, showXodo, onDone, notify }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const decide = async (approve, scope = "once") => {
    setBusy(true);
    try {
      const r = await api(`/aprovacoes/${a.id}`, { method: "POST", body: { approve, scope } });
      notify(approve ? (r.alwaysRuleCreated ? "Feito. Da próxima vez ele não pergunta." : "Aprovado. Ele continua daqui.") : "Negado. Ele vai seguir sem isso.");
      onDone?.();
    } catch (e) {
      notify(e.message, true);
      setBusy(false);
    }
  };
  const limit = a.reason?.startsWith("limite: ") ? a.reason.slice(8) : null;
  return (
    <article className="approval">
      <div className="approval-top">
        {showXodo && (
          <span className="approval-who">
            <XodoChar xodo={{ species: a.species, color: a.color }} size={28} state="needsYou" follow={false} />
            {a.xodo_name}
          </span>
        )}
        <span className="tag">{CATEGORY[a.category] || a.category}</span>
        <span className="muted small">{timeAgo(a.created_at)}</span>
      </div>
      <p className="approval-what">{a.resumo}</p>
      {limit && <p className="muted small">Motivo: {limit}</p>}
      <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "Esconder detalhes" : "Ver detalhes"}
      </button>
      {open && <pre className="details">{JSON.stringify(a.input, null, 2)}</pre>}
      <div className="row gap">
        <button className="btn" disabled={busy} onClick={() => decide(true)}>
          Pode fazer
        </button>
        <button className="btn btn-soft" disabled={busy} onClick={() => decide(true, "always")} title="Aprova e não pergunta mais para esse tipo de ação">
          Pode sempre
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => decide(false)}>
          Não
        </button>
      </div>
    </article>
  );
}

function ApprovalsPage({ reload, notify, tick, overview }) {
  const [list, setList] = useState(null);
  const load = useCallback(() => api("/aprovacoes").then((r) => setList(r.aprovacoes)), []);
  useEffect(() => {
    load().catch((e) => notify(e.message, true));
  }, [load, tick, overview.aprovacoes_pendentes]);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Aprovações</h1>
        <p className="muted">O que seus xodós querem fazer e esperam o seu sim. Pedidos sem resposta vencem sozinhos.</p>
      </header>
      {!list ? (
        <p className="muted">Carregando…</p>
      ) : list.length === 0 ? (
        <Empty title="Nada esperando você">Quando um xodó precisar de permissão, o pedido aparece aqui.</Empty>
      ) : (
        <div className="stack">
          {list.map((a) => (
            <ApprovalCard key={a.id} a={a} showXodo notify={notify} onDone={() => (load(), reload())} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------

function Notice({ n }) {
  return (
    <article className={cx("notice", !n.read_at && "notice-new")}>
      <div className="row between">
        <strong>{n.title}</strong>
        <span className="muted small">{timeAgo(n.created_at)}</span>
      </div>
      {n.body && <p className="pre">{n.body}</p>}
    </article>
  );
}

function NoticesPage({ reload, tick }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    api("/avisos").then((r) => setList(r.avisos));
  }, [tick]);
  const readAll = async () => {
    await api("/avisos/lidos", { method: "POST", body: {} });
    setList((l) => l.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
    reload();
  };
  return (
    <div className="page">
      <header className="page-head row between">
        <div>
          <h1>Avisos</h1>
          <p className="muted">Recados dos xodós e do app.</p>
        </div>
        {list?.some((n) => !n.read_at) && (
          <button className="btn btn-soft" onClick={readAll}>
            Marcar tudo como lido
          </button>
        )}
      </header>
      {!list ? <p className="muted">Carregando…</p> : list.length === 0 ? <Empty title="Sem avisos por enquanto" /> : <div className="stack">{list.map((n) => <Notice key={n.id} n={n} />)}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página de um xodó
// ---------------------------------------------------------------------------

function XodoPage({ id, tab, overview, reload, notify, tick }) {
  const xodo = overview.xodos.find((x) => x.id === id);
  if (!xodo) {
    return (
      <div className="page">
        <Empty title="Esse xodó não existe mais" action={<a className="btn" href="#/">Voltar ao início</a>} />
      </div>
    );
  }
  const tabs = [
    ["conversa", "Conversa"],
    ["rotinas", "Rotinas"],
    ["memoria", "Memória"],
    ["ajustes", "Ajustes"],
  ];
  return (
    <div className="page page-xodo">
      <header className="xodo-head">
        <div className="xodo-char">
          <XodoChar xodo={xodo} size={84} state={botState(xodo)} interactive />
        </div>
        <div>
          <h1>{xodo.name}</h1>
          <p className="muted">
            {xodo.role || "Ajudante"} · {stateLabel(xodo)} · hoje {brl(xodo.spent_today_brl)}
            {xodo.daily_budget_brl ? ` de ${brl(xodo.daily_budget_brl)}` : ""}
          </p>
        </div>
      </header>
      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => (
          <a key={k} role="tab" aria-selected={tab === k} className={cx("tab", tab === k && "tab-on")} href={`#/x/${id}/${k}`}>
            {l}
          </a>
        ))}
      </div>
      {tab === "conversa" && <Chat xodo={xodo} reload={reload} notify={notify} tick={tick} />}
      {tab === "rotinas" && <Routines xodo={xodo} notify={notify} tick={tick} />}
      {tab === "memoria" && <Memory xodo={xodo} notify={notify} />}
      {tab === "ajustes" && <XodoSettings xodo={xodo} overview={overview} reload={reload} notify={notify} />}
    </div>
  );
}

// ---- Conversa

function Chat({ xodo, reload, notify, tick }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);
  const stick = useRef(true);

  const load = useCallback(() => api(`/xodos/${xodo.id}/conversa`).then(setData), [xodo.id]);
  useEffect(() => {
    load().catch((e) => notify(e.message, true));
  }, [load, tick]);

  // Enquanto ele trabalha, confere a cada 2,5 s (os eventos já avisam, isto é só garantia).
  const running = data?.ultima_execucao?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => load().catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [running, load]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  const send = async (e) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await api(`/xodos/${xodo.id}/mensagens`, { method: "POST", body: { text: t } });
      setText("");
      stick.current = true;
      await load();
      reload();
    } catch (err) {
      notify(err.message, true);
    } finally {
      setSending(false);
    }
  };

  const last = data?.ultima_execucao;
  const persona = PERSONAS.find((p) => p.k === xodo.personality);
  return (
    <div className="chat">
      <div
        className="chat-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        aria-live="polite"
      >
        {data && data.mensagens.length === 0 && (
          <div className="chat-hello">
            <p>
              Oi! Eu sou {xodo.name}
              {persona ? ` (${persona.l.toLowerCase()})` : ""}. Me peça algo, por exemplo:
            </p>
            <div className="chips">
              {["Pesquise as melhores opções de notebook até R$ 4.000 e me resuma", "Crie um arquivo com minha lista de compras da semana", "O que tem na minha pasta?"].map((s) => (
                <button key={s} className="chip" onClick={() => setText(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {data?.mensagens.map((m) => (
          <div key={m.id} className={cx("msg", m.role === "user" ? "msg-me" : m.role === "note" ? "msg-note" : "msg-bot")}>
            <div className="msg-text">{m.text}</div>
            <span className="msg-time">{timeAgo(m.created_at)}</span>
          </div>
        ))}
        {data?.pendentes.map((a) => (
          <ApprovalCard key={a.id} a={a} notify={notify} onDone={() => (load(), reload())} />
        ))}
        {running && (
          <div className="msg msg-bot msg-typing" aria-label={`${xodo.name} está trabalhando`}>
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
            <span className="muted small">trabalhando… passo {last.steps ?? 0}</span>
          </div>
        )}
      </div>
      <form className="composer" onSubmit={send}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) send(e);
          }}
          placeholder={`Peça algo para ${xodo.name}…`}
          rows={2}
          aria-label="Mensagem"
          disabled={xodo.status === "paused"}
        />
        <button className="btn" disabled={sending || !text.trim() || xodo.status === "paused"}>
          Enviar
        </button>
      </form>
      {xodo.status === "paused" && <p className="muted small">Este xodó está pausado. Reative em Ajustes.</p>}
    </div>
  );
}

// ---- Rotinas

function cronFrom(f) {
  const [h, m] = (f.time || "08:00").split(":").map((v) => Number(v));
  if (f.freq === "diario") return `${m} ${h} * * *`;
  if (f.freq === "uteis") return `${m} ${h} * * 1-5`;
  if (f.freq === "semanal") return `${m} ${h} * * ${f.dow}`;
  if (f.freq === "mensal") return `${m} ${h} ${f.dom} * *`;
  return f.cron.trim();
}

function cronText(cron) {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) return `Agenda: ${cron}`;
  const at = `às ${p[1].padStart(2, "0")}:${p[0].padStart(2, "0")}`;
  if (p[2] === "*" && p[3] === "*" && p[4] === "*") return `Todo dia ${at}`;
  if (p[2] === "*" && p[3] === "*" && p[4] === "1-5") return `Dias úteis ${at}`;
  if (p[2] === "*" && p[3] === "*" && /^[0-6]$/.test(p[4])) return `Toda ${WEEKDAYS[+p[4]]} ${at}`;
  if (/^\d+$/.test(p[2]) && p[3] === "*" && p[4] === "*") return `Todo dia ${p[2]} do mês ${at}`;
  return `Agenda: ${cron}`;
}

function Routines({ xodo, notify, tick }) {
  const [list, setList] = useState(null);
  const [form, setForm] = useState(null);
  const load = useCallback(() => api(`/xodos/${xodo.id}/rotinas`).then((r) => setList(r.rotinas)), [xodo.id]);
  useEffect(() => {
    load().catch((e) => notify(e.message, true));
  }, [load, tick]);

  const blank = { name: "", prompt: "", freq: "uteis", time: "08:00", dow: "1", dom: "1", cron: "0 8 * * 1-5", continuity: false };
  const save = async (e) => {
    e.preventDefault();
    try {
      await api(`/xodos/${xodo.id}/rotinas`, {
        method: "POST",
        body: { name: form.name, prompt: form.prompt, cron: cronFrom(form), continuity: form.continuity },
      });
      setForm(null);
      notify("Rotina criada.");
      load();
    } catch (err) {
      notify(err.message, true);
    }
  };
  const toggle = async (r) => {
    try {
      await api(`/xodos/${xodo.id}/rotinas/${r.id}`, { method: "PATCH", body: { active: !r.active } });
      load();
    } catch (err) {
      notify(err.message, true);
    }
  };
  const remove = async (r) => {
    if (!confirm(`Apagar a rotina "${r.name}"?`)) return;
    try {
      await api(`/xodos/${xodo.id}/rotinas/${r.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      notify(err.message, true);
    }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  return (
    <div className="tab-body">
      <p className="muted">Tarefas que {xodo.name} faz sozinho no horário marcado, enquanto o app estiver aberto.</p>
      {!form && (
        <button className="btn" onClick={() => setForm(blank)}>
          + Nova rotina
        </button>
      )}
      {form && (
        <form className="card form" onSubmit={save}>
          <Field label="Nome">
            <input value={form.name} onChange={set("name")} placeholder="Ex.: Resumo da manhã" required maxLength={80} />
          </Field>
          <Field label="O que ele deve fazer" hint="Escreva como se fosse pedir na conversa.">
            <textarea value={form.prompt} onChange={set("prompt")} rows={3} required maxLength={4000} placeholder="Ex.: Pesquise as notícias de tecnologia de hoje e me mande um resumo em 5 tópicos." />
          </Field>
          <div className="row gap wrap">
            <Field label="Quando">
              <select value={form.freq} onChange={set("freq")}>
                <option value="diario">Todo dia</option>
                <option value="uteis">Dias úteis (seg a sex)</option>
                <option value="semanal">Toda semana</option>
                <option value="mensal">Todo mês</option>
                <option value="avancado">Avançado (cron)</option>
              </select>
            </Field>
            {form.freq === "semanal" && (
              <Field label="Dia">
                <select value={form.dow} onChange={set("dow")}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={i} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {form.freq === "mensal" && (
              <Field label="Dia do mês">
                <input type="number" min={1} max={28} value={form.dom} onChange={set("dom")} />
              </Field>
            )}
            {form.freq === "avancado" ? (
              <Field label="Expressão cron" hint="minuto hora dia mês dia-da-semana">
                <input value={form.cron} onChange={set("cron")} />
              </Field>
            ) : (
              <Field label="Horário">
                <input type="time" value={form.time} onChange={set("time")} required />
              </Field>
            )}
          </div>
          <label className="check">
            <input type="checkbox" checked={form.continuity} onChange={set("continuity")} />
            Lembrar da vez anterior (útil para acompanhar algo ao longo dos dias)
          </label>
          <div className="row gap">
            <button className="btn">Criar rotina</button>
            <button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>
              Cancelar
            </button>
          </div>
        </form>
      )}
      {list && list.length === 0 && !form && <Empty title="Nenhuma rotina ainda">Ex.: todo dia às 8h, um resumo das notícias que importam para você.</Empty>}
      <div className="stack">
        {list?.map((r) => (
          <article key={r.id} className={cx("card", !r.active && "card-off")}>
            <div className="row between wrap gap">
              <div>
                <strong>{r.name}</strong>
                <p className="muted small">
                  {cronText(r.cron)}
                  {r.active && r.next_run_at ? ` · próxima: ${fmtDate(r.next_run_at)}` : ""}
                  {!r.active ? " · desligada" : ""}
                </p>
              </div>
              <div className="row gap">
                <button className="btn btn-soft" onClick={() => toggle(r)}>
                  {r.active ? "Desligar" : "Ligar"}
                </button>
                <button className="btn btn-ghost" onClick={() => remove(r)}>
                  Apagar
                </button>
              </div>
            </div>
            <p className="pre small">{r.prompt}</p>
            {r.last_summary && <p className="muted small">Última vez: {r.last_summary}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}

// ---- Memória

const KIND = { fato: "Fato", preferencia: "Preferência", decisao: "Decisão", resultado: "Resultado" };

function Memory({ xodo, notify }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const load = useCallback(
    (query = q) => api(`/xodos/${xodo.id}/memoria${query.trim() ? "?q=" + encodeURIComponent(query.trim()) : ""}`).then(setData),
    [xodo.id, q],
  );
  useEffect(() => {
    load("").catch((e) => notify(e.message, true));
  }, [xodo.id]);

  const add = async (e) => {
    e.preventDefault();
    try {
      await api(`/xodos/${xodo.id}/memoria`, { method: "POST", body: { texto: text } });
      setText("");
      notify("Guardado na memória.");
      load();
    } catch (err) {
      notify(err.message, true);
    }
  };
  const forget = async (n) => {
    if (!confirm("Esquecer esta nota?")) return;
    try {
      await api(`/xodos/${xodo.id}/memoria/${n.n}?version=${n.version}`, { method: "DELETE" });
      load();
    } catch (err) {
      notify(err.message, true);
    }
  };
  return (
    <div className="tab-body">
      <p className="muted">
        O que {xodo.name} sabe sobre você. Ele aprende sozinho com as conversas{xodo.memory_enabled === false ? " (desligado)" : ""}; você também pode ensinar e apagar.
      </p>
      <form className="row gap" onSubmit={add}>
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ex.: Prefiro reuniões depois das 14h." maxLength={2000} aria-label="Nova nota" />
        <button className="btn" disabled={!text.trim()}>
          Ensinar
        </button>
      </form>
      <form
        className="row gap"
        onSubmit={(e) => {
          e.preventDefault();
          load().catch((err) => notify(err.message, true));
        }}
      >
        <input className="grow" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar na memória" aria-label="Buscar na memória" />
        <button className="btn btn-soft">Buscar</button>
      </form>
      {data && data.notas.length === 0 && <Empty title={q ? "Nada encontrado" : "A memória está vazia"}>Conforme vocês conversam, ele guarda o que for útil lembrar.</Empty>}
      <div className="stack">
        {data?.notas.map((n) => (
          <article key={n.id} className="card note">
            <div className="row between gap">
              <span className="tag">{KIND[n.kind] || n.kind}</span>
              <button className="link small" onClick={() => forget(n)}>
                Esquecer
              </button>
            </div>
            <p className="pre">{n.content}</p>
            {n.topic && <p className="muted small">Tópico: {n.topic}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}

// ---- Ajustes do xodó

function ModelPicker({ chaves, value, onChange }) {
  const active = chaves.filter((c) => !c.revoked_at);
  const cred = active.find((c) => c.id === value.credential_id) || active[0];
  const [models, setModels] = useState([]);
  useEffect(() => {
    if (!cred) return;
    api(`/catalogo?provider=${encodeURIComponent(cred.provider)}`)
      .then((r) => {
        setModels(r.models);
        if (cred.id !== value.credential_id || (r.models.length && !r.models.some((m) => m.id === value.model))) {
          onChange({ provider: cred.provider, credential_id: cred.id, model: value.credential_id === cred.id && !r.models.length ? value.model : suggestModel(r.models) });
        }
      })
      .catch(() => setModels([]));
  }, [cred?.id]);
  if (!cred) return <p className="muted">Cadastre uma chave de IA em Configurações primeiro.</p>;
  return (
    <div className="row gap wrap">
      <Field label="Chave de IA">
        <select value={cred.id} onChange={(e) => onChange({ ...value, credential_id: e.target.value, provider: active.find((c) => c.id === e.target.value).provider, model: "" })}>
          {active.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Modelo" hint={models.length ? "Os maiores pensam melhor e custam mais." : "Nome do modelo no seu servidor (ex.: llama3.1)."}>
        {models.length ? (
          <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · US$ {m.cost.input}/{m.cost.output} por milhão
              </option>
            ))}
          </select>
        ) : (
          <input value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} placeholder="llama3.1" />
        )}
      </Field>
    </div>
  );
}

function suggestModel(models) {
  if (!models.length) return "";
  const pick = (re) => models.filter((m) => re.test(m.id)).sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
  // Anthropic: Sonnet. OpenAI: o "Sol" mais novo. Google: o Flash estável mais novo (funciona no uso gratuito).
  return (pick(/sonnet/) || pick(/^gpt-[\d.]+-sol$/) || pick(/^gemini-[\d.]+-flash$/) || pick(/^gemini-.*flash(?!-lite)/) || models[0]).id;
}

/** "Pode usar": quais apps do Google o xodó mexe e, com mais de uma conta, qual. */
function AppsPicker({ xodo, accounts, value, onChange }) {
  if (!accounts) return null;
  const active = accounts.filter((a) => a.status === "active");
  const current = (k) => value.find((a) => a.app === k);
  const toggle = (k) => onChange(current(k) ? value.filter((a) => a.app !== k) : [...value, { app: k, connection_id: null }]);
  const pin = (k, id) => onChange(value.map((a) => (a.app === k ? { ...a, connection_id: id || null } : a)));
  return (
    <fieldset className="choices">
      <legend className="field-label">Pode usar</legend>
      {!active.length ? (
        <p className="muted small">
          Nenhuma conta do Google conectada ainda. <a href="#/integracoes">Conectar em Integrações</a>.
        </p>
      ) : (
        <div className="stack-tight">
          {GOOGLE_APPS.map((a) => {
            const able = active.filter((acc) => acc.apps.includes(a.k));
            const on = current(a.k);
            return (
              <div key={a.k} className={cx("choice", "choice-app", on && "choice-on")}>
                <label className="app-pick">
                  <input type="checkbox" checked={!!on} disabled={!able.length && !on} onChange={() => toggle(a.k)} />
                  <span>
                    <strong>{a.l}</strong>
                    <span className="muted small">{able.length ? a.d : "Nenhuma conta conectada deu essa permissão. Conecte de novo em Integrações marcando este app."}</span>
                  </span>
                </label>
                {on && able.length > 1 && (
                  <select value={on.connection_id || ""} onChange={(e) => pin(a.k, e.target.value)} aria-label={`Conta do ${a.l} para ${xodo.name}`}>
                    <option value="">A mais recente</option>
                    {able.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.external_account}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function XodoSettings({ xodo, overview, reload, notify }) {
  const [f, setF] = useState(() => ({
    name: xodo.name,
    role: xodo.role || "",
    instructions: xodo.instructions || "",
    autonomy: xodo.autonomy,
    personality: xodo.personality,
    budget: xodo.daily_budget_brl ? String(xodo.daily_budget_brl).replace(".", ",") : "",
    model: { provider: xodo.provider, model: xodo.model, credential_id: xodo.credential_id },
    apps: xodo.apps || [],
  }));
  const [busy, setBusy] = useState(false);
  const [integrations] = useIntegrations(0);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const budget = f.budget.trim() ? Number(f.budget.replace(",", ".")) : null;
      await api(`/xodos/${xodo.id}`, {
        method: "PATCH",
        body: {
          name: f.name,
          role: f.role.trim() || null,
          instructions: f.instructions,
          autonomy: f.autonomy,
          personality: f.personality,
          daily_budget_brl: budget,
          apps: f.apps,
          ...f.model,
        },
      });
      notify("Ajustes salvos.");
      reload();
    } catch (err) {
      notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  const pause = async () => {
    try {
      await api(`/xodos/${xodo.id}`, { method: "PATCH", body: { status: xodo.status === "paused" ? "active" : "paused" } });
      reload();
    } catch (err) {
      notify(err.message, true);
    }
  };
  const remove = async () => {
    const typed = prompt(`Para apagar ${xodo.name} de vez (com conversas, rotinas e memória), digite o nome dele:`);
    if (typed === null) return;
    try {
      await api(`/xodos/${xodo.id}?confirmar=${encodeURIComponent(typed)}`, { method: "DELETE" });
      notify(`${xodo.name} foi apagado.`);
      go("/");
      reload();
    } catch (err) {
      notify(err.message, true);
    }
  };
  return (
    <form className="tab-body form" onSubmit={save}>
      <div className="row gap wrap">
        <Field label="Nome">
          <input value={f.name} onChange={set("name")} required maxLength={40} />
        </Field>
        <Field label="Função" hint="Ex.: Secretário, Pesquisador">
          <input value={f.role} onChange={set("role")} maxLength={40} />
        </Field>
        <Field label="Jeito">
          <select value={f.personality} onChange={set("personality")}>
            {PERSONAS.map((p) => (
              <option key={p.k} value={p.k}>
                {p.l} – {p.d}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Instruções" hint="Como ele deve trabalhar para você. Ele segue isso sempre.">
        <textarea value={f.instructions} onChange={set("instructions")} rows={5} maxLength={8000} />
      </Field>
      <fieldset className="choices">
        <legend className="field-label">Quanta liberdade ele tem</legend>
        {AUTONOMIES.map((a) => (
          <label key={a.k} className={cx("choice", f.autonomy === a.k && "choice-on")}>
            <input type="radio" name="autonomy" value={a.k} checked={f.autonomy === a.k} onChange={set("autonomy")} />
            <span>
              <strong>{a.l}</strong>
              <span className="muted small">{a.d}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ModelPicker chaves={overview.chaves} value={f.model} onChange={(model) => setF((s) => ({ ...s, model }))} />
      <AppsPicker xodo={xodo} accounts={integrations?.contas} value={f.apps} onChange={(apps) => setF((s) => ({ ...s, apps }))} />
      <Field label="Limite de gasto por dia (R$)" hint="Vazio: sem limite (o gasto aparece mesmo assim).">
        <input inputMode="decimal" value={f.budget} onChange={set("budget")} placeholder="Ex.: 5,00" />
      </Field>
      <div className="row gap wrap">
        <button className="btn" disabled={busy}>
          Salvar
        </button>
        <button type="button" className="btn btn-soft" onClick={pause}>
          {xodo.status === "paused" ? "Reativar" : "Pausar"}
        </button>
        <button type="button" className="btn btn-danger" onClick={remove}>
          Apagar xodó
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Novo xodó
// ---------------------------------------------------------------------------

function XodoForm({ overview, notify, onCreated, compact }) {
  const [sp, setSp] = useState("pingo");
  const [ci, setCi] = useState(0);
  const [f, setF] = useState(() => ({
    name: SPECIES.pingo.names[Math.floor(Math.random() * SPECIES.pingo.names.length)],
    role: "Secretário",
    personality: "curioso",
    autonomy: "pergunta_no_que_importa",
    instructions: "",
    model: { provider: "", model: "", credential_id: "" },
  }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const color = SPECIES[sp].colors[ci] || SPECIES[sp].colors[0];

  const create = async (e) => {
    e.preventDefault();
    if (!f.model.credential_id || !f.model.model) return notify("Escolha a chave de IA e o modelo.", true);
    setBusy(true);
    try {
      const r = await api("/xodos", {
        method: "POST",
        body: {
          name: f.name,
          species: sp,
          color: color.n.pt,
          personality: f.personality,
          role: f.role.trim() || null,
          instructions: f.instructions,
          autonomy: f.autonomy,
          ...f.model,
        },
      });
      notify(`${f.name} chegou!`);
      onCreated(r.xodo);
    } catch (err) {
      notify(err.message, true);
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={create}>
      <div className="maker">
        <div className="maker-stage" style={{ background: color.stage }}>
          <XodoChar xodo={{ species: sp, color: color.n.pt }} size={compact ? 150 : 180} state="idle" interactive />
          <span className="maker-name" style={{ color: color.stageInk }}>
            {f.name || "…"}
          </span>
        </div>
        <div className="maker-controls">
          <fieldset className="choices">
            <legend className="field-label">Forma</legend>
            <div className="row gap wrap">
              {SP_KEYS.map((k) => (
                <button
                  type="button"
                  key={k}
                  className={cx("species", sp === k && "species-on")}
                  aria-pressed={sp === k}
                  onClick={() => {
                    setSp(k);
                    setCi(0);
                  }}
                >
                  <XodoChar xodo={{ species: k, color: SPECIES[k].colors[0].n.pt }} size={48} follow={false} />
                  <span>{SPECIES[k].label}</span>
                </button>
              ))}
            </div>
            <p className="muted small">{SPECIES[sp].desc.pt}</p>
          </fieldset>
          <fieldset className="choices">
            <legend className="field-label">Cor</legend>
            <div className="row gap">
              {SPECIES[sp].colors.map((c, i) => (
                <button type="button" key={c.n.pt} className={cx("swatch", ci === i && "swatch-on")} style={{ background: c.body }} onClick={() => setCi(i)} aria-label={c.n.pt} aria-pressed={ci === i} title={c.n.pt} />
              ))}
            </div>
          </fieldset>
          <div className="row gap wrap">
            <Field label="Nome">
              <input value={f.name} onChange={set("name")} required maxLength={40} />
            </Field>
            <Field label="Função">
              <input value={f.role} onChange={set("role")} maxLength={40} placeholder="Ex.: Pesquisador" />
            </Field>
          </div>
        </div>
      </div>

      <fieldset className="choices">
        <legend className="field-label">Jeito</legend>
        <div className="grid4">
          {PERSONAS.map((p) => (
            <label key={p.k} className={cx("choice", f.personality === p.k && "choice-on")}>
              <input type="radio" name="persona" value={p.k} checked={f.personality === p.k} onChange={set("personality")} />
              <span>
                <strong>{p.l}</strong>
                <span className="muted small">{p.d}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <Field label="Instruções (opcional)" hint="Ex.: Sempre responda em tópicos. Moro em Curitiba. Quando pesquisar preços, mostre 3 opções.">
        <textarea value={f.instructions} onChange={set("instructions")} rows={3} maxLength={8000} />
      </Field>

      <fieldset className="choices">
        <legend className="field-label">Quanta liberdade ele tem</legend>
        <div className="stack-tight">
          {AUTONOMIES.map((a) => (
            <label key={a.k} className={cx("choice", f.autonomy === a.k && "choice-on")}>
              <input type="radio" name="autonomy" value={a.k} checked={f.autonomy === a.k} onChange={set("autonomy")} />
              <span>
                <strong>
                  {a.l}
                  {a.rec ? " (recomendado)" : ""}
                </strong>
                <span className="muted small">{a.d}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <ModelPicker chaves={overview.chaves} value={f.model} onChange={(model) => setF((s) => ({ ...s, model }))} />

      <button className="btn btn-big" disabled={busy}>
        {busy ? "Criando…" : `Criar ${f.name || "xodó"}`}
      </button>
    </form>
  );
}

function NewXodoPage({ overview, reload, notify }) {
  return (
    <div className="page">
      <header className="page-head">
        <h1>Novo xodó</h1>
        <p className="muted">Cada xodó é um ajudante com jeito, função e memória próprios.</p>
      </header>
      <XodoForm
        overview={overview}
        notify={notify}
        onCreated={async (x) => {
          await reload();
          go(`/x/${x.id}`);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chaves de IA
// ---------------------------------------------------------------------------

function KeyForm({ notify, onSaved }) {
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/catalogo").then((r) => setProviders(r.providers));
  }, []);
  const featured = FEATURED.find((p) => p.id === provider);
  const selfHosted = provider === "local" || provider === "custom";
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const label = featured?.name || providers.find((p) => p.id === provider)?.name || provider;
      const r = await api("/chaves", { method: "POST", body: { provider, label, api_key: apiKey, ...(selfHosted ? { base_url: baseUrl } : {}) } });
      setApiKey("");
      notify(r.chave.note || "Chave guardada com segurança neste computador.");
      onSaved(r.chave);
    } catch (err) {
      notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={save}>
      <fieldset className="choices">
        <legend className="field-label">De onde vem a inteligência</legend>
        <div className="grid-keys">
          {FEATURED.map((p) => (
            <label key={p.id} className={cx("choice", provider === p.id && "choice-on")}>
              <input type="radio" name="prov" value={p.id} checked={provider === p.id} onChange={() => setProvider(p.id)} />
              <span>
                <strong>{p.name}</strong>
              </span>
            </label>
          ))}
        </div>
        <Field label="Ou outro provedor">
          <select value={FEATURED.some((p) => p.id === provider) ? "" : provider} onChange={(e) => e.target.value && setProvider(e.target.value)}>
            <option value="">Escolher…</option>
            {providers
              .filter((p) => !FEATURED.some((f) => f.id === p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </Field>
      </fieldset>
      {featured?.url && (
        <p className="muted small">
          Onde pegar: {featured.where} (
          <a href={featured.url} target="_blank" rel="noreferrer">
            abrir
          </a>
          ). É pago por uso; o app mostra quanto cada xodó gastou.
        </p>
      )}
      {provider === "local" && <p className="muted small">{featured.where}</p>}
      {selfHosted && (
        <Field label="Endereço do servidor" hint="Ollama: http://127.0.0.1:11434/v1 · LM Studio: http://127.0.0.1:1234/v1">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
        </Field>
      )}
      <Field label={selfHosted ? "Chave (se o servidor pedir)" : "Chave de API"} hint="Fica cifrada só neste computador. Ninguém mais vê.">
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required={!selfHosted} autoComplete="off" spellCheck={false} placeholder={selfHosted ? "" : "Cole aqui"} />
      </Field>
      <button className="btn" disabled={busy}>
        {busy ? "Conferindo…" : "Guardar chave"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------

function SettingsPage({ overview, reload, notify, theme }) {
  const [nome, setNome] = useState(overview.nome);
  const [pasta, setPasta] = useState(overview.pasta);
  const [adding, setAdding] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    try {
      await api("/configuracoes", { method: "PUT", body: { nome, pasta } });
      notify("Salvo.");
      reload();
    } catch (err) {
      notify(err.message, true);
    }
  };
  const revoke = async (c) => {
    if (!confirm(`Remover a chave "${c.label}"? Os xodós que usam essa chave param até você escolher outra.`)) return;
    try {
      await api(`/chaves/${c.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      notify(err.message, true);
    }
  };
  const keys = overview.chaves.filter((c) => !c.revoked_at);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Configurações</h1>
        <p className="muted">Seu nome, a pasta dos xodós, a aparência do app e as chaves de IA.</p>
      </header>

      <section className="card integ">
        <IntegHead logo="user" tone="plain" title="Você" sub="Como os xodós chamam você e onde eles guardam arquivos." />
        <form className="form" onSubmit={save}>
          <div className="integ-grid">
            <Field label="Seu nome" hint="Os xodós chamam você assim.">
              <input value={nome} onChange={(e) => setNome(e.target.value)} maxLength={60} />
            </Field>
            <Field label="Pasta dos xodós" hint="Eles só mexem dentro dela. O que apagam vai para a Lixeira dos Xodós, lá dentro.">
              <input value={pasta} onChange={(e) => setPasta(e.target.value)} />
            </Field>
          </div>
          <div className="integ-actions">
            <button className="btn">Salvar</button>
          </div>
        </form>
      </section>

      <section className="card integ">
        <IntegHead logo="palette" tone="plain" title="Aparência" sub="Também dá para trocar pelo botão no pé da barra lateral." />
        <div className="theme-tiles" role="radiogroup" aria-label="Tema">
          {THEMES.map((t) => (
            <label key={t.k} className={cx("theme-tile", theme.theme === t.k && "theme-tile-on")}>
              <input type="radio" name="tema" value={t.k} checked={theme.theme === t.k} onChange={() => theme.setTheme(t.k)} />
              <span className={cx("theme-preview", `theme-preview-${t.k}`)} aria-hidden="true">
                <i />
                <i />
              </span>
              <span className="row gap">
                <Icon name={t.icon} size={16} />
                <strong>{t.l}</strong>
              </span>
              <span className="muted small">{t.d}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="card integ">
        <IntegHead logo="key" tone="plain" title="Chaves de IA" sub="De onde vem a inteligência dos xodós. Ficam cifradas só neste computador." />
        {keys.length > 0 && (
          <ul className="list">
            {keys.map((c) => (
              <li key={c.id} className="list-row">
                <span className="avatar">
                  <Icon name="key" size={16} />
                </span>
                <div className="grow">
                  <strong className="ellipsis">{c.label}</strong>
                  <span className="muted small ellipsis">
                    {c.base_url ? c.base_url : `termina em …${c.key_last4}`} · desde {fmtDate(c.created_at)}
                  </span>
                </div>
                <button className="btn btn-ghost btn-sm integ-danger" onClick={() => revoke(c)}>
                  Remover
                </button>
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <div className="integ-sub">
            <KeyForm
              notify={notify}
              onSaved={() => {
                setAdding(false);
                reload();
              }}
            />
            <button className="link small" onClick={() => setAdding(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          <div className="integ-actions">
            <button className="btn btn-soft" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> Adicionar chave
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integrações: Google (Gmail, Agenda, Drive), Telegram e WhatsApp
// ---------------------------------------------------------------------------

const GOOGLE_APPS = [
  { k: "gmail", icon: "mail", l: "Gmail", d: "Ler, organizar, escrever rascunhos e enviar e-mails (enviar pede sua aprovação)." },
  { k: "calendar", icon: "calendar", l: "Agenda", d: "Ver seus compromissos e marcar ou mudar eventos." },
  { k: "drive", icon: "folder", l: "Drive", d: "Procurar e ler seus arquivos, e criar novos." },
];
const appLabel = (k) => GOOGLE_APPS.find((a) => a.k === k)?.l || k;

function useIntegrations(tick) {
  const [data, setData] = useState(null);
  const load = useCallback(() => api("/integracoes").then(setData), []);
  useEffect(() => {
    load().catch(() => {});
  }, [load, tick]);
  return [data, load];
}

function XodoSelect({ xodos, value, onChange }) {
  return (
    <select value={value || ""} onChange={(e) => onChange(e.target.value)} required>
      <option value="" disabled>
        Escolher…
      </option>
      {xodos.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </select>
  );
}

/** Cabeçalho de um cartão de integração: logo, nome, o que faz e como está. */
function IntegHead({ logo, tone, title, sub, status, statusTone }) {
  return (
    <div className="integ-head">
      <span className={cx("integ-logo", `integ-logo-${tone}`)}>
        <Icon name={logo} size={22} />
      </span>
      <div className="integ-title">
        <strong>{title}</strong>
        {sub && <span className="muted small">{sub}</span>}
      </div>
      {status && <span className={cx("pill", statusTone && `pill-${statusTone}`)}>{status}</span>}
    </div>
  );
}

/** Passo a passo numerado, com o número em bolinha. */
function Steps({ children }) {
  return <ol className="steps-list">{children}</ol>;
}

const ext = (href, text) => (
  <a href={href} target="_blank" rel="noreferrer">
    {text}
  </a>
);

function GoogleClientForm({ data, notify, onSaved, onCancel }) {
  const [f, setF] = useState({ client_id: "", client_secret: "" });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/integracoes/google/app", { method: "PUT", body: f });
      notify("App do Google guardado. Agora conecte sua conta.");
      onSaved();
    } catch (err) {
      notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="integ-setup">
      <div className="integ-col">
        <p className="integ-lead">
          <strong>Uma vez só:</strong> crie o seu “app do Google”. É grátis, leva uns 5 minutos e é o que deixa os xodós pedirem acesso à sua conta.
        </p>
        <Steps>
          <li>Abra o {ext("https://console.cloud.google.com/projectcreate", "Google Cloud")} e crie um projeto (ex.: “Xodós”).</li>
          <li>
            Ative as APIs: {ext("https://console.cloud.google.com/apis/library/gmail.googleapis.com", "Gmail")},{" "}
            {ext("https://console.cloud.google.com/apis/library/calendar-json.googleapis.com", "Agenda")} e{" "}
            {ext("https://console.cloud.google.com/apis/library/drive.googleapis.com", "Drive")}.
          </li>
          <li>
            Em <em>Tela de consentimento OAuth</em>, escolha <em>Externo</em> e adicione o seu Gmail em <em>Usuários de teste</em>.
          </li>
          <li>
            Em <em>Credenciais → ID do cliente OAuth</em>, escolha <strong>App para computador</strong>.
          </li>
          <li>Copie o ID e a chave secreta para o lado.</li>
        </Steps>
      </div>
      <form className="integ-col integ-form" onSubmit={save}>
        <Field label="ID do cliente" hint="Termina em .apps.googleusercontent.com">
          <input value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })} required spellCheck={false} autoComplete="off" placeholder="123…apps.googleusercontent.com" />
        </Field>
        <Field label="Chave secreta do cliente" hint="Fica cifrada só neste computador.">
          <input type="password" value={f.client_secret} onChange={(e) => setF({ ...f, client_secret: e.target.value })} required spellCheck={false} autoComplete="off" placeholder="GOCSPX-…" />
        </Field>
        <div className="row gap wrap">
          <button className="btn" disabled={busy}>
            {busy ? "Guardando…" : "Guardar app do Google"}
          </button>
          {onCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancelar
            </button>
          )}
        </div>
        <p className="muted small">Depois do login o Google volta para {data.google.volta}. Não precisa cadastrar esse endereço.</p>
      </form>
    </div>
  );
}

function GoogleSection({ data, reload, notify }) {
  const [editing, setEditing] = useState(false);
  const [apps, setApps] = useState(["gmail", "calendar"]);
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const r = await api("/integracoes/google/conectar", { method: "POST", body: { apps } });
      window.open(r.url, "_blank", "noopener");
      notify("Abri o login do Google numa nova aba. Quando terminar, a conta aparece aqui.");
    } catch (err) {
      notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (acc) => {
    if (!confirm(`Desconectar ${acc.label}? Os xodós param de usar essa conta.`)) return;
    try {
      await api(`/integracoes/${acc.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      notify(err.message, true);
    }
  };
  const toggle = (k) => setApps((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));
  const n = data.contas.length;
  const status = !data.google.configurado ? "Falta configurar" : n ? `${n} conta${n > 1 ? "s" : ""}` : "Pronto para conectar";

  return (
    <section className="card integ">
      <IntegHead logo="mail" tone="google" title="Google" sub="Gmail, Agenda e Drive" status={status} statusTone={n ? "live" : !data.google.configurado ? "warn" : null} />
      {!data.google.configurado || editing ? (
        <GoogleClientForm
          data={data}
          notify={notify}
          onCancel={data.google.configurado ? () => setEditing(false) : null}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      ) : (
        <>
          {n > 0 && (
            <ul className="list">
              {data.contas.map((acc) => (
                <li key={acc.id} className="list-row">
                  <span className="avatar">{(acc.external_account || acc.label || "?").slice(0, 1).toUpperCase()}</span>
                  <div className="grow">
                    <strong className="ellipsis">{acc.label}</strong>
                    <span className="muted small">
                      {acc.apps.length ? acc.apps.map(appLabel).join(" · ") : "Sem permissões"}
                      {acc.status !== "active" ? ` · ${acc.status === "expired" ? "o login venceu, conecte de novo" : acc.last_error || "com erro"}` : ""}
                    </span>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => remove(acc)}>
                    Desconectar
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="integ-sub">
            <p className="field-label">{n ? "Conectar outra conta ou dar mais permissões" : "O que os xodós podem acessar"}</p>
            <div className="app-tiles">
              {GOOGLE_APPS.map((a) => (
                <label key={a.k} className={cx("app-tile", apps.includes(a.k) && "app-tile-on")}>
                  <input type="checkbox" checked={apps.includes(a.k)} onChange={() => toggle(a.k)} />
                  <Icon name={a.icon} size={20} />
                  <strong>{a.l}</strong>
                  <span className="muted small">{a.d}</span>
                </label>
              ))}
            </div>
            <div className="row gap wrap">
              <button className="btn" disabled={busy || !apps.length} onClick={connect}>
                Entrar com o Google
              </button>
              <button className="link small" onClick={() => setEditing(true)}>
                Trocar o app do Google
              </button>
            </div>
            <p className="muted small">Depois, em cada xodó → Ajustes → “Pode usar”, escolha o que ele pode mexer.</p>
          </div>
        </>
      )}
    </section>
  );
}

const CHANNELS = {
  telegram: { l: "Telegram", logo: "send", d: "Grátis e direto do seu computador. Você aprova pedidos com um toque." },
  whatsapp: { l: "WhatsApp", logo: "chat", d: "API oficial da Meta. Para receber mensagens, precisa de um endereço público." },
};

function ChannelCard({ ch, overview, reload, notify }) {
  const [code, setCode] = useState(null);
  const info = CHANNELS[ch.canal];
  const call = async (fn, msg) => {
    try {
      await fn();
      if (msg) notify(msg);
      reload();
    } catch (err) {
      notify(err.message, true);
    }
  };
  const newCode = () => call(async () => setCode(await api(`/canais/${ch.id}/codigo`, { method: "POST", body: {} })));
  const remove = () => {
    if (!confirm(`Desconectar ${ch.nome} (${info.l})? O xodó para de responder por lá.`)) return;
    call(() => api(`/integracoes/${ch.id}`, { method: "DELETE" }));
  };
  const linked = ch.canal === "whatsapp" || !!ch.vinculado;
  const status = ch.status !== "active" ? "Com erro" : linked ? "Ligado" : "Falta vincular";
  const sub =
    ch.canal === "whatsapp" ? (ch.meu_numero ? `Atende o número ${ch.meu_numero}` : ch.nome) : ch.vinculado ? `${ch.nome} · vinculado a ${ch.vinculado}` : ch.nome;
  return (
    <section className="card integ">
      <IntegHead logo={info.logo} tone={ch.canal} title={info.l} sub={sub} status={status} statusTone={ch.status !== "active" ? "warn" : linked ? "live" : "warn"} />
      {ch.status !== "active" && ch.erro && <p className="integ-error small">{ch.erro}</p>}
      <div className="integ-grid">
        <Field label="Quem responde">
          <XodoSelect xodos={overview.xodos} value={ch.xodo_id} onChange={(id) => call(() => api(`/canais/${ch.id}`, { method: "PATCH", body: { xodo_id: id } }), "Trocado.")} />
        </Field>
        <label className="switch-row">
          <input type="checkbox" checked={ch.avisos} onChange={(e) => call(() => api(`/canais/${ch.id}`, { method: "PATCH", body: { avisos: e.target.checked } }))} />
          <span>
            <strong>Avisos do sino</strong>
            <span className="muted small">Lembretes, pedidos de aprovação e rotinas também chegam aqui.</span>
          </span>
        </label>
      </div>
      {ch.canal === "telegram" && (!ch.vinculado || code) && (
        <div className="pairing">
          {code ? (
            <>
              <p>
                Mande este código para o bot{ch.usuario_bot ? ` @${ch.usuario_bot}` : ""} no Telegram. Vale 10 minutos.
              </p>
              <p className="code">{code.codigo}</p>
              {code.link && (
                <a className="btn btn-soft" href={code.link} target="_blank" rel="noreferrer">
                  Abrir o bot no Telegram
                </a>
              )}
            </>
          ) : (
            <>
              <p>Falta um passo: vincular o seu Telegram, para o bot só atender você.</p>
              <button className="btn" onClick={newCode}>
                Gerar código de vínculo
              </button>
            </>
          )}
        </div>
      )}
      {ch.canal === "whatsapp" && (
        <details className="integ-details">
          <summary>Para o xodó também receber suas mensagens</summary>
          <Steps>
            <li>
              Exponha o app por um túnel, ex.: <code>cloudflared tunnel --url http://127.0.0.1:4747</code>
            </li>
            <li>
              No app da Meta → WhatsApp → Configuração, use a URL <code>https://SEU-TUNEL/webhook/whatsapp</code> e o token <code>{ch.verify_token}</code>
            </li>
            <li>Assine o campo “messages”. A chave secreta do app da Meta precisa estar cadastrada.</li>
          </Steps>
        </details>
      )}
      <div className="integ-actions">
        <button className="btn btn-soft btn-sm" onClick={() => call(() => api(`/canais/${ch.id}/teste`, { method: "POST", body: {} }), "Mensagem de teste enviada.")}>
          Mandar teste
        </button>
        {ch.canal === "telegram" && ch.vinculado && (
          <button className="btn btn-ghost btn-sm" onClick={newCode}>
            Vincular outro Telegram
          </button>
        )}
        <button className="btn btn-ghost btn-sm integ-danger" onClick={remove}>
          Desconectar
        </button>
      </div>
    </section>
  );
}

function TelegramForm({ overview, notify, onDone, onCancel }) {
  const [f, setF] = useState({ token: "", xodo_id: overview.xodos[0]?.id || "" });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/canais/telegram", { method: "POST", body: f });
      notify("Bot conectado. Agora vincule o seu Telegram.");
      onDone();
    } catch (err) {
      notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card integ">
      <IntegHead logo="send" tone="telegram" title="Conectar Telegram" sub="Leva 2 minutos" />
      <div className="integ-setup">
        <div className="integ-col">
          <Steps>
            <li>No Telegram, abra o {ext("https://t.me/BotFather", "@BotFather")} e mande <code>/newbot</code>.</li>
            <li>Escolha um nome (ex.: “Pipoca dos Xodós”) e um usuário que termine em “bot”.</li>
            <li>Ele responde com um token. Cole ao lado.</li>
          </Steps>
        </div>
        <form className="integ-col integ-form" onSubmit={save}>
          <Field label="Token do bot">
            <input type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} required spellCheck={false} autoComplete="off" placeholder="123456789:ABC…" />
          </Field>
          <Field label="Quem responde">
            <XodoSelect xodos={overview.xodos} value={f.xodo_id} onChange={(id) => setF({ ...f, xodo_id: id })} />
          </Field>
          <div className="row gap">
            <button className="btn" disabled={busy}>
              {busy ? "Conferindo…" : "Conectar Telegram"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function WhatsappForm({ overview, notify, onDone, onCancel }) {
  const [f, setF] = useState({ phone_number_id: "", token: "", app_secret: "", meu_numero: "", xodo_id: overview.xodos[0]?.id || "" });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/canais/whatsapp", { method: "POST", body: f });
      notify("WhatsApp conectado.");
      onDone();
    } catch (err) {
      notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card integ">
      <IntegHead logo="chat" tone="whatsapp" title="Conectar WhatsApp" sub="API oficial da Meta" />
      <div className="integ-setup">
        <div className="integ-col">
          <Steps>
            <li>Em {ext("https://developers.facebook.com/apps", "developers.facebook.com")}, crie um app do tipo <em>Empresa</em> com o produto <em>WhatsApp</em>.</li>
            <li>
              Em <em>WhatsApp → Configuração da API</em>, copie o <strong>ID do número de telefone</strong> e gere um token.
            </li>
            <li>Cadastre o seu número como destinatário e mande um “oi” para o número do xodó.</li>
          </Steps>
          <p className="muted small">A Meta só deixa o xodó escrever livremente até 24 h depois da sua última mensagem para ele.</p>
        </div>
        <form className="integ-col integ-form" onSubmit={save}>
          <Field label="ID do número de telefone">
            <input value={f.phone_number_id} onChange={set("phone_number_id")} required inputMode="numeric" spellCheck={false} />
          </Field>
          <Field label="Seu número" hint="Com DDI e DDD: 55 41 99999-8888">
            <input value={f.meu_numero} onChange={set("meu_numero")} required inputMode="tel" />
          </Field>
          <Field label="Token de acesso" hint="Fica cifrado só neste computador.">
            <input type="password" value={f.token} onChange={set("token")} required spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Chave secreta do app (opcional)" hint="Configurações do app → Básico. Precisa dela para receber mensagens.">
            <input type="password" value={f.app_secret} onChange={set("app_secret")} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Quem responde">
            <XodoSelect xodos={overview.xodos} value={f.xodo_id} onChange={(id) => setF({ ...f, xodo_id: id })} />
          </Field>
          <div className="row gap">
            <button className="btn" disabled={busy}>
              {busy ? "Conferindo…" : "Conectar WhatsApp"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function IntegrationsPage({ overview, notify, tick }) {
  const [data, load] = useIntegrations(tick);
  const [adding, setAdding] = useState(null);
  const reload = () => load().catch((e) => notify(e.message, true));
  if (!data) {
    return (
      <div className="page">
        <p className="muted">Carregando…</p>
      </div>
    );
  }
  const done = () => (setAdding(null), reload());
  return (
    <div className="page">
      <header className="page-head">
        <h1>Integrações</h1>
        <p className="muted">Ligue suas contas para os xodós cuidarem de e-mail e agenda, e fale com eles pelo celular.</p>
      </header>

      <section className="block">
        <h2 className="section-title">
          <Icon name="mail" /> Contas
        </h2>
        <GoogleSection data={data} reload={reload} notify={notify} />
      </section>

      <section className="block">
        <h2 className="section-title">
          <Icon name="chat" /> Falar pelo celular
        </h2>
        <div className="stack">
          {data.canais.map((ch) => (
            <ChannelCard key={ch.id} ch={ch} overview={overview} reload={reload} notify={notify} />
          ))}
          {adding === "telegram" && <TelegramForm overview={overview} notify={notify} onDone={done} onCancel={() => setAdding(null)} />}
          {adding === "whatsapp" && <WhatsappForm overview={overview} notify={notify} onDone={done} onCancel={() => setAdding(null)} />}
          {!adding && (
            <div className="channel-pick">
              {Object.entries(CHANNELS).map(([k, c]) => {
                const count = data.canais.filter((x) => x.canal === k).length;
                return (
                  <button key={k} type="button" className="channel-tile" onClick={() => setAdding(k)}>
                    <span className={cx("integ-logo", `integ-logo-${k}`)}>
                      <Icon name={c.logo} size={22} />
                    </span>
                    <span className="channel-text">
                      <strong>{count ? `Outro ${c.l}` : `Conectar ${c.l}`}</strong>
                      <span className="muted small">{c.d}</span>
                    </span>
                    <Icon name="plus" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primeira vez
// ---------------------------------------------------------------------------

function Welcome({ overview, reload, notify }) {
  const hasName = !!overview.nome;
  const hasKey = overview.chaves.some((c) => !c.revoked_at);
  const step = !hasName ? 1 : !hasKey ? 2 : 3;
  const [nome, setNome] = useState("");
  const saveName = async (e) => {
    e.preventDefault();
    try {
      await api("/configuracoes", { method: "PUT", body: { nome: nome.trim() } });
      reload();
    } catch (err) {
      notify(err.message, true);
    }
  };
  const trio = BRAND_TRIO;
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="steps" aria-label={`Passo ${step} de 3`}>
          {[1, 2, 3].map((n) => (
            <span key={n} className={cx("step", n <= step && "step-on")} />
          ))}
        </div>
        {step === 1 && (
          <>
            <div className="trio">
              {trio.map((x, i) => (
                <XodoChar key={i} xodo={x} size={i === 1 ? 92 : 104} state="idle" interactive />
              ))}
            </div>
            <h1>Oi! Vamos conhecer seus xodós.</h1>
            <p className="muted">São ajudantes de IA que rodam aqui no seu computador: pesquisam na internet, organizam arquivos e cuidam de rotinas. Eles pedem permissão antes de fazer qualquer coisa importante.</p>
            <form className="row gap" onSubmit={saveName}>
              <input className="grow" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Como você quer ser chamado?" required maxLength={60} autoFocus aria-label="Seu nome" />
              <button className="btn">Continuar</button>
            </form>
          </>
        )}
        {step === 2 && (
          <>
            <h1>Agora, a inteligência deles</h1>
            <p className="muted">
              Os xodós usam um serviço de IA para pensar. Você cria uma chave nesse serviço e cola aqui. Ela fica guardada cifrada só neste computador.
            </p>
            <KeyForm notify={notify} onSaved={reload} />
          </>
        )}
        {step === 3 && (
          <>
            <h1>Crie seu primeiro xodó</h1>
            <p className="muted">Dá para mudar tudo depois.</p>
            <XodoForm
              overview={overview}
              notify={notify}
              compact
              onCreated={async (x) => {
                await reload();
                go(`/x/${x.id}`);
              }}
            />
          </>
        )}
      </div>
      <a className="link small welcome-skip" href="#/configuracoes">
        Configurações
      </a>
    </div>
  );
}

createRoot(document.getElementById("app")).render(<App />);
