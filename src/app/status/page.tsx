import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { publicStatus, type DayState } from "@/lib/core/status";
import { serverSql } from "@/lib/xodos/db";

/** Página pública de status do Spherum (sem login). Os dados vêm de publicStatus (core/status.ts). */

export const revalidate = 60;
export const metadata: Metadata = {
  title: "Status · Spherum",
  description: "Situação dos serviços do Spherum e histórico de incidentes dos últimos 30 dias.",
};

const geist = Geist({ subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const TZ = "America/Sao_Paulo";
const BLUE = "#465FFF";

const STATE: Record<DayState, { label: string; color: string; bg: string; ink: string }> = {
  ok: { label: "Operando", color: "#12B76A", bg: "#ECFDF3", ink: "#067647" },
  minor: { label: "Lentidão", color: "#FDB022", bg: "#FFFAEB", ink: "#B54708" },
  major: { label: "Parcialmente fora", color: "#F04438", bg: "#FEF3F2", ink: "#B42318" },
  critical: { label: "Fora do ar", color: "#D92D20", bg: "#FEF3F2", ink: "#B42318" },
  none: { label: "Sem dados", color: "#EAECF0", bg: "#F2F4F7", ink: "#475467" },
};
const DAY_TIP: Record<DayState, string> = { ok: "sem problemas", minor: "lentidão ou falhas pontuais", major: "parte fora do ar", critical: "fora do ar", none: "sem dados" };
const STEP: Record<string, string> = { investigating: "Investigando", identified: "Identificado", monitoring: "Monitorando", resolved: "Resolvido" };
const SEV: Record<string, string> = { minor: "Lentidão", major: "Parcialmente fora", critical: "Fora do ar" };
const HEAD: Record<DayState, string> = {
  ok: "Todos os sistemas operando",
  none: "Todos os sistemas operando",
  minor: "Lentidão em parte da plataforma",
  major: "Parte da plataforma com problemas",
  critical: "Parte da plataforma fora do ar",
};

const when = (t: string) => new Date(t).toLocaleString("pt-BR", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dayLabel = (d: string) => new Date(`${d}T12:00:00-03:00`).toLocaleDateString("pt-BR", { timeZone: TZ, day: "numeric", month: "short" });

type Status = Awaited<ReturnType<typeof publicStatus>>;
type Incident = Status["open"][number];

const card: React.CSSProperties = { background: "#FFFFFF", borderRadius: 16, boxShadow: "0 1px 2px rgba(16,24,40,.04), 0 8px 24px -12px rgba(16,24,40,.10)", overflow: "hidden" };

export default async function StatusPage() {
  const data = await publicStatus(await serverSql()).catch(() => null);
  const names = new Map<string, string>((data?.services ?? []).map((s) => [s.id, s.name]));
  return (
    <div className={geist.className} style={{ minHeight: "100vh", background: "#F5F6F8", color: "#101828", fontSize: 14, lineHeight: 1.5, WebkitFontSmoothing: "antialiased" }}>
      <style>{`
        .st-wrap { max-width: 860px; margin: 0 auto; padding: 32px 16px 56px; display: flex; flex-direction: column; gap: 20px; }
        .st-row { display: flex; gap: 16px; align-items: center; padding: 16px 20px; border-top: 1px solid #F2F4F7; flex-wrap: wrap; }
        .st-bars { display: flex; gap: 2px; height: 28px; flex: 1 1 100%; min-width: 0; }
        .st-bars span { flex: 1; min-width: 0; border-radius: 2px; }
        @media (min-width: 720px) { .st-bars { flex: 2 1 360px; } }
        a { color: ${BLUE}; }
      `}</style>
      <div className="st-wrap">
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#101828" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" width={28} height={28} />
            <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>Spherum</span>
            <span style={{ fontSize: 13, color: "#667085", fontWeight: 500 }}>Status</span>
          </a>
          <a href="/" style={{ fontSize: 13, fontWeight: 600, textDecoration: "none" }}>Ir para o Spherum</a>
        </header>

        {!data ? (
          <section style={{ ...card, padding: 24, textAlign: "center", color: "#667085" }}>Não deu para carregar o status agora. Tente de novo em instantes.</section>
        ) : (
          <>
            <section style={{ ...card, padding: "20px 22px", display: "flex", alignItems: "center", gap: 14, background: STATE[data.overall].bg }}>
              <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: "50%", background: STATE[data.overall === "none" ? "ok" : data.overall].color, boxShadow: `0 0 0 5px ${STATE[data.overall === "none" ? "ok" : data.overall].color}33`, flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>{HEAD[data.overall]}</h1>
                <p style={{ margin: "2px 0 0", fontSize: 13, color: "#475467" }}>
                  {data.open.length ? `${data.open.length} ${data.open.length === 1 ? "incidente aberto" : "incidentes abertos"}. ` : ""}Atualizado em {when(data.updated_at)} (horário de Brasília).
                </p>
              </div>
            </section>

            {data.open.length > 0 && (
              <section style={card} aria-labelledby="st-open">
                <h2 id="st-open" style={{ margin: 0, padding: "16px 20px", fontSize: 15, fontWeight: 600 }}>Incidentes abertos</h2>
                {data.open.map((i) => <IncidentRow key={i.id} i={i} service={names.get(i.service) ?? i.service} />)}
              </section>
            )}

            <section style={card} aria-labelledby="st-svcs">
              <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <h2 id="st-svcs" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Serviços</h2>
                <span style={{ fontSize: 12.5, color: "#667085" }}>últimos 30 dias</span>
              </div>
              {data.services.map((s) => {
                const st = STATE[s.state];
                return (
                  <div key={s.id} className="st-row">
                    <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</span>
                        <span style={{ fontSize: 11.5, fontWeight: 600, padding: "2px 9px", borderRadius: 99, background: st.bg, color: st.ink }}>{st.label}</span>
                      </div>
                      <div style={{ fontSize: 12, color: "#667085" }}>{s.desc}</div>
                      <div style={{ fontSize: 12, color: "#475467", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                        {s.uptime == null ? "Sem medições ainda" : `${s.uptime.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}% no ar`}
                      </div>
                    </div>
                    <div className="st-bars" role="img" aria-label={`${s.name}: últimos 30 dias`}>
                      {s.bars.map((b) => <span key={b.day} title={`${dayLabel(b.day)} · ${DAY_TIP[b.state]}`} style={{ background: STATE[b.state].color }} />)}
                    </div>
                  </div>
                );
              })}
              <div style={{ padding: "10px 20px 14px", borderTop: "1px solid #F2F4F7", display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "#667085" }}>
                {(["ok", "minor", "major", "none"] as DayState[]).map((k) => (
                  <span key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: STATE[k].color }} />{DAY_TIP[k][0].toUpperCase() + DAY_TIP[k].slice(1)}</span>
                ))}
              </div>
            </section>

            <section style={card} aria-labelledby="st-hist">
              <h2 id="st-hist" style={{ margin: 0, padding: "16px 20px", fontSize: 15, fontWeight: 600 }}>Histórico dos últimos 30 dias</h2>
              {data.history.length ? data.history.map((i) => <IncidentRow key={i.id} i={i} service={names.get(i.service) ?? i.service} />) : (
                <p style={{ margin: 0, padding: "18px 20px", borderTop: "1px solid #F2F4F7", color: "#667085" }}>Nenhum incidente nos últimos 30 dias.</p>
              )}
            </section>
          </>
        )}

        <footer style={{ fontSize: 12.5, color: "#667085", textAlign: "center" }}>
          Problema que não aparece aqui? Escreva para <a href="mailto:suporte@spherum.com.br">suporte@spherum.com.br</a>.
        </footer>
      </div>
    </div>
  );
}

function IncidentRow({ i, service }: { i: Incident; service: string }) {
  const resolved = i.status === "resolved";
  return (
    <article style={{ padding: "16px 20px", borderTop: "1px solid #F2F4F7", display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600 }}>{i.title}</h3>
          <span style={{ fontSize: 11.5, fontWeight: 600, padding: "2px 9px", borderRadius: 99, background: resolved ? "#ECFDF3" : "#FEF3F2", color: resolved ? "#067647" : "#B42318" }}>
            {resolved ? "Resolvido" : SEV[i.severity] ?? "Incidente"}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: "#667085" }}>
          {service} · começou em {when(i.started_at)}{i.resolved_at ? ` · resolvido em ${when(i.resolved_at)}` : ""}
        </div>
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: "0 0 0 14px", borderLeft: "2px solid #EAECF0", display: "flex", flexDirection: "column", gap: 10 }}>
        {i.updates.map((u, k) => (
          <li key={k}>
            <div style={{ fontSize: 12, color: "#667085" }}><strong style={{ color: k === 0 ? BLUE : "#101828", fontWeight: 600 }}>{STEP[u.status] ?? u.status}</strong> · {when(u.created_at)}</div>
            <div style={{ fontSize: 13.5, color: "#344054", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{u.text}</div>
          </li>
        ))}
      </ol>
    </article>
  );
}
