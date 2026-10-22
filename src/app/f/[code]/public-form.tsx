"use client";

import { useState } from "react";

type Field = { id: string; t: "text" | "phone" | "email" | "choice"; l: string; req: boolean; opts?: string[]; cond?: [string, string] };
type Form = { name: string; agency: string; color: string | null; cta: string; thanks: string | null; fields: Field[] };

/** Formulário respondido pelo público. Campos com condição só aparecem quando a condição bate. */
export function PublicForm({ code, form }: { code: string; form: Form }) {
  const [v, setV] = useState<Record<string, string>>({});
  const [err, setErr] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [state, setState] = useState<"open" | "busy" | "done">("open");
  const color = form.color && /^#[0-9a-f]{6}$/i.test(form.color) ? form.color : "#465FFF";
  const visible = form.fields.filter((f) => !f.cond || v[f.cond[0]] === f.cond[1]);
  const input = { height: 42, border: "1px solid #D0D5DD", borderRadius: 9, padding: "0 12px", fontSize: 15, width: "100%", boxSizing: "border-box" } as const;

  if (state === "done") {
    return <div style={{ background: "#fff", border: "1px solid #E4E7EC", borderRadius: 14, padding: 24, textAlign: "center" }}><h1 style={{ fontSize: 20 }}>Recebido!</h1><p style={{ color: "#475467" }}>{form.thanks || `A ${form.agency} vai falar com você em breve.`}</p></div>;
  }
  return (
    <form
      style={{ background: "#fff", border: "1px solid #E4E7EC", borderTop: `6px solid ${color}`, borderRadius: 14, padding: 24, display: "flex", flexDirection: "column", gap: 14 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setState("busy"); setErr({}); setMsg("");
        const r = await fetch(`/api/public/forms/${code}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(visible.map((f) => [f.id, v[f.id] ?? ""]))) });
        const j = await r.json().catch(() => ({}));
        if (r.ok) return setState("done");
        setErr(j.fields || {}); setMsg(j.error || "Não deu certo agora. Tente de novo."); setState("open");
      }}
    >
      <div><div style={{ fontSize: 13, color: "#667085" }}>{form.agency}</div><h1 style={{ margin: "4px 0 0", fontSize: 22 }}>{form.name}</h1></div>
      {visible.map((f) => (
        <label key={f.id} style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 500 }}>
          <span>{f.l}{f.req ? " *" : ""}</span>
          {f.t === "choice" ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(f.opts || []).map((o) => (
                <button type="button" key={o} onClick={() => setV({ ...v, [f.id]: o })} style={{ padding: "8px 12px", borderRadius: 99, border: `1px solid ${v[f.id] === o ? color : "#D0D5DD"}`, background: v[f.id] === o ? `${color}14` : "#fff", fontSize: 14, cursor: "pointer" }}>{o}</button>
              ))}
            </div>
          ) : (
            <input style={{ ...input, borderColor: err[f.id] ? "#F04438" : "#D0D5DD" }} type={f.t === "email" ? "email" : f.t === "phone" ? "tel" : "text"} value={v[f.id] ?? ""} onChange={(e) => setV({ ...v, [f.id]: e.target.value })} />
          )}
          {err[f.id] && <span style={{ color: "#D92D20", fontSize: 12.5, fontWeight: 400 }}>{err[f.id]}</span>}
        </label>
      ))}
      {msg && <div style={{ color: "#D92D20", fontSize: 13.5 }}>{msg}</div>}
      <button disabled={state === "busy"} style={{ height: 46, border: "none", borderRadius: 10, background: color, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{state === "busy" ? "Enviando…" : form.cta}</button>
    </form>
  );
}
