"use client";

import { useState } from "react";

/** Aceite eletrônico da proposta: nome, e-mail e a confirmação. Também dá para recusar. */
export function AcceptForm({ token, status, acceptedAt, acceptedName, color }: { token: string; status: string; acceptedAt: string | null; acceptedName: string | null; color: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [agree, setAgree] = useState(false);
  const [state, setState] = useState<"open" | "busy" | "accepted" | "declined">(status === "aceita" ? "accepted" : status === "recusada" ? "declined" : "open");
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const card = { background: "#fff", border: "1px solid #E4E7EC", borderRadius: 14, padding: "20px 22px" } as const;
  const input = { height: 40, border: "1px solid #D0D5DD", borderRadius: 9, padding: "0 12px", fontSize: 14, width: "100%", boxSizing: "border-box" } as const;

  async function post(path: string, body: unknown) {
    const r = await fetch(`/api/public/proposals/${token}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Não deu certo agora. Tente de novo.");
  }

  if (state === "accepted") {
    return <div style={{ ...card, borderColor: "#12B76A" }}><b>Proposta aceita{acceptedName || name ? ` por ${acceptedName || name}` : ""}.</b> {acceptedAt ? `Em ${new Date(acceptedAt).toLocaleString("pt-BR")}.` : "A agência já foi avisada e entra em contato para começar."}</div>;
  }
  if (state === "declined") return <div style={card}>Proposta recusada. Obrigado pelo retorno: a agência foi avisada.</div>;
  if (status === "vencida") return <div style={card}>A validade desta proposta acabou. Peça uma nova para a agência.</div>;
  if (status !== "enviada") return <div style={card}>Esta proposta não está aberta para aceite.</div>;

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Aceitar a proposta</h2>
      <p style={{ margin: 0, fontSize: 13.5, color: "#667085" }}>O aceite registra seu nome, e-mail, a data e o endereço de rede de onde você aceitou.</p>
      <input style={input} placeholder="Seu nome completo" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome completo" />
      <input style={input} placeholder="Seu e-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="E-mail" />
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14 }}>
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> Li e aceito a proposta e as condições acima.
      </label>
      {error && <div style={{ color: "#D92D20", fontSize: 13.5 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          disabled={state === "busy"}
          onClick={async () => {
            setError("");
            if (name.trim().length < 3 || !/^\S+@\S+\.\S+$/.test(email.trim()) || !agree) return setError("Preencha nome, e-mail e marque a confirmação.");
            setState("busy");
            try { await post("accept", { name: name.trim(), email: email.trim(), agree: true }); setState("accepted"); } catch (e) { setError((e as Error).message); setState("open"); }
          }}
          style={{ height: 42, padding: "0 18px", border: "none", borderRadius: 10, background: color, color: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer" }}
        >
          {state === "busy" ? "Registrando…" : "Aceitar proposta"}
        </button>
        <button onClick={() => setDeclining(!declining)} style={{ height: 42, padding: "0 16px", border: "1px solid #D0D5DD", borderRadius: 10, background: "#fff", fontSize: 14, cursor: "pointer" }}>Recusar</button>
      </div>
      {declining && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea rows={3} placeholder="Se quiser, conte o motivo" value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...input, height: "auto", padding: 10 }} aria-label="Motivo" />
          <button
            onClick={async () => { try { await post("decline", { reason }); setState("declined"); } catch (e) { setError((e as Error).message); } }}
            style={{ alignSelf: "flex-start", height: 38, padding: "0 14px", border: "1px solid #F04438", borderRadius: 9, background: "#fff", color: "#D92D20", fontSize: 13.5, cursor: "pointer" }}
          >
            Confirmar recusa
          </button>
        </div>
      )}
    </div>
  );
}
