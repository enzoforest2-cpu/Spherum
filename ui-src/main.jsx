import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

  const ctx = { overview, reload, notify, tick };
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
  else if (section === "novo") page = <NewXodoPage {...ctx} />;
  else page = <Home {...ctx} />;

  return (
    <div className="shell">
      <Sidebar overview={overview} hash={hash} />
      <main className="main">{page}</main>
      <Toast toast={toast} />
    </div>
  );
}

function Sidebar({ overview, hash }) {
  const item = (path, label, badge) => (
    <a href={"#" + path} className={cx("nav", (hash === path || (path !== "/" && hash.startsWith(path))) && "nav-on")}>
      <span>{label}</span>
      {badge ? <span className="badge">{badge}</span> : null}
    </a>
  );
  return (
    <nav className="side" aria-label="Menu">
      <a href="#/" className="brand">
        Xodós
      </a>
      {item("/", "Início")}
      {item("/aprovacoes", "Aprovações", overview.aprovacoes_pendentes)}
      {item("/avisos", "Avisos", overview.avisos_nao_lidos)}
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
        + Novo xodó
      </a>
      <div className="side-foot">{item("/configuracoes", "Configurações")}</div>
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

function XodoSettings({ xodo, overview, reload, notify }) {
  const [f, setF] = useState(() => ({
    name: xodo.name,
    role: xodo.role || "",
    instructions: xodo.instructions || "",
    autonomy: xodo.autonomy,
    personality: xodo.personality,
    budget: xodo.daily_budget_brl ? String(xodo.daily_budget_brl).replace(".", ",") : "",
    model: { provider: xodo.provider, model: xodo.model, credential_id: xodo.credential_id },
  }));
  const [busy, setBusy] = useState(false);
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

function SettingsPage({ overview, reload, notify }) {
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
      </header>
      <section className="block">
        <h2>Você</h2>
        <form className="card form" onSubmit={save}>
          <Field label="Seu nome" hint="Os xodós chamam você assim.">
            <input value={nome} onChange={(e) => setNome(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Pasta dos xodós" hint="Eles só leem e escrevem arquivos dentro desta pasta. O que apagam vai para a Lixeira dos Xodós, lá dentro.">
            <input value={pasta} onChange={(e) => setPasta(e.target.value)} />
          </Field>
          <button className="btn">Salvar</button>
        </form>
      </section>
      <section className="block">
        <h2>Chaves de IA</h2>
        <div className="stack">
          {keys.map((c) => (
            <div key={c.id} className="card row between gap">
              <div>
                <strong>{c.label}</strong>
                <p className="muted small">
                  {c.base_url ? c.base_url : `termina em …${c.key_last4}`} · desde {fmtDate(c.created_at)}
                </p>
              </div>
              <button className="btn btn-ghost" onClick={() => revoke(c)}>
                Remover
              </button>
            </div>
          ))}
        </div>
        {adding ? (
          <div className="card">
            <KeyForm
              notify={notify}
              onSaved={() => {
                setAdding(false);
                reload();
              }}
            />
          </div>
        ) : (
          <button className="btn btn-soft" onClick={() => setAdding(true)}>
            + Adicionar chave
          </button>
        )}
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
  const trio = useMemo(
    () => [
      { species: "pingo", color: "Tomate" },
      { species: "bibo", color: "Menta" },
      { species: "oki", color: "Ultramar" },
    ],
    [],
  );
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
