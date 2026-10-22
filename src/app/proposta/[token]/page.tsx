import type { Metadata } from "next";
import { viewProposal } from "@/lib/core/proposals";
import { serverSql } from "@/lib/xodos/db";
import { AcceptForm } from "./accept-form";

/** Página pública da proposta: o cliente lê, aceita (aceite eletrônico) ou recusa, sem login. */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Proposta", robots: { index: false, follow: false } };

type Item = { n?: string; d?: string; u?: string; p?: number; q?: number; disc?: number };
type Doc = { items?: Item[]; intro?: string; payDay?: number; reaj?: string; fine?: number; notice?: number; exitFee?: number; color?: string; ad?: number; split?: number };

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const day = (d: string | null) => (d ? d.split("-").reverse().join("/") : "");

export default async function ProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let p: Awaited<ReturnType<typeof viewProposal>> | null = null;
  try {
    p = await viewProposal(await serverSql(), token);
  } catch {
    p = null;
  }
  const page = { fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", color: "#101828", background: "#F7F8FA", minHeight: "100vh", padding: "32px 16px" } as const;
  if (!p) {
    return (
      <main style={page}>
        <div style={{ maxWidth: 560, margin: "80px auto", textAlign: "center" }}>
          <h1 style={{ fontSize: 22 }}>Proposta não encontrada</h1>
          <p style={{ color: "#667085" }}>O link pode ter sido trocado por um mais novo. Peça para a agência mandar de novo.</p>
        </div>
      </main>
    );
  }
  const doc = (p.doc ?? {}) as Doc;
  const color = (doc.color && /^#[0-9a-f]{6}$/i.test(doc.color) ? doc.color : null) ?? (p.agency.color && /^#[0-9a-f]{6}$/i.test(p.agency.color) ? p.agency.color : "#465FFF");
  const items = (doc.items ?? []).filter((i) => i && i.n);
  const value = (i: Item) => (i.p ?? 0) * (i.q ?? 1) * (1 - (i.disc ?? 0) / 100);
  const card = { background: "#fff", border: "1px solid #E4E7EC", borderRadius: 14, padding: "20px 22px" } as const;
  return (
    <main style={page}>
      <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ ...card, borderTop: `6px solid ${color}` }}>
          <div style={{ fontSize: 13, color: "#667085" }}>{p.agency.name} · proposta {p.number}</div>
          <h1 style={{ margin: "6px 0 0", fontSize: 26, letterSpacing: "-0.02em" }}>Proposta para {p.company}</h1>
          {p.contact_name && <div style={{ marginTop: 4, color: "#475467" }}>Aos cuidados de {p.contact_name}</div>}
          {doc.intro && <p style={{ marginTop: 14, lineHeight: 1.6, color: "#344054" }}>{doc.intro}</p>}
        </div>
        <div style={card}>
          <h2 style={{ margin: 0, fontSize: 16 }}>O que está incluso</h2>
          {items.map((i, k) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "12px 0", borderTop: k ? "1px solid #F2F4F7" : "none" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{i.n}{(i.q ?? 1) > 1 ? ` × ${i.q}` : ""}</div>
                {i.d && <div style={{ fontSize: 13.5, color: "#667085" }}>{i.d}</div>}
              </div>
              <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <div style={{ fontWeight: 600 }}>{value(i) ? brl(value(i)) : "Incluso"}</div>
                <div style={{ fontSize: 12.5, color: "#667085" }}>{i.u === "mês" ? "por mês" : "uma vez"}{i.disc ? ` · ${i.disc}% de desconto` : ""}</div>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 12, paddingTop: 14, borderTop: "1px solid #E4E7EC" }}>
            <div><div style={{ fontSize: 12.5, color: "#667085" }}>Mensalidade</div><div style={{ fontSize: 22, fontWeight: 700 }}>{brl(p.monthly_cents / 100)}</div></div>
            {p.one_time_cents > 0 && <div><div style={{ fontSize: 12.5, color: "#667085" }}>Valor único</div><div style={{ fontSize: 22, fontWeight: 700 }}>{brl(p.one_time_cents / 100)}</div></div>}
            <div><div style={{ fontSize: 12.5, color: "#667085" }}>Prazo</div><div style={{ fontSize: 22, fontWeight: 700 }}>{p.term_months} meses</div></div>
          </div>
          {doc.ad ? <div style={{ marginTop: 10, fontSize: 13, color: "#667085" }}>Verba de anúncios sugerida: {brl(doc.ad)} por mês, paga direto às plataformas.</div> : null}
        </div>
        <div style={card}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Condições</h2>
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.7, color: "#344054", fontSize: 14 }}>
            {doc.payDay ? <li>Vencimento todo dia {doc.payDay}.</li> : null}
            {doc.reaj ? <li>Reajuste anual pelo {doc.reaj}.</li> : null}
            {doc.fine ? <li>Multa de {doc.fine}% por atraso.</li> : null}
            {doc.notice ? <li>Aviso prévio de {doc.notice} dias para encerrar.</li> : null}
            {p.valid_until ? <li>Proposta válida até {day(p.valid_until)}.</li> : null}
          </ul>
        </div>
        <AcceptForm token={token} status={p.status} acceptedAt={p.accepted_at} acceptedName={p.accepted_name} color={color} />
      </div>
    </main>
  );
}
