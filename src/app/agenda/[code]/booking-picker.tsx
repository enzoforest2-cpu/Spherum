"use client";

import { useState } from "react";

type Data = { name: string; description: string | null; duration_min: number; color: string; agency: string; brand_color: string | null; host: string | null; meet: boolean; days: { day: string; slots: string[] }[]; available: boolean; timezone: string };

const label = (day: string) => new Date(`${day}T12:00:00-03:00`).toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short", timeZone: "America/Sao_Paulo" }).replace(/\./g, "");

/** Escolha do dia e do horário, e os dados do convidado. */
export function BookingPicker({ code, data }: { code: string; data: Data }) {
  const [day, setDay] = useState(data.days[0]?.day ?? "");
  const [slot, setSlot] = useState("");
  const [v, setV] = useState({ name: "", email: "", phone: "", notes: "" });
  const [msg, setMsg] = useState("");
  const [state, setState] = useState<"open" | "busy" | "done">("open");
  const [done, setDone] = useState<{ meet: string | null; start: string } | null>(null);
  const color = /^#[0-9a-f]{6}$/i.test(data.brand_color ?? "") ? data.brand_color! : data.color;
  const input = { height: 42, border: "1px solid #D0D5DD", borderRadius: 9, padding: "0 12px", fontSize: 15, width: "100%", boxSizing: "border-box" } as const;
  const card = { background: "#fff", border: "1px solid #E4E7EC", borderTop: `6px solid ${color}`, borderRadius: 14, padding: 24, display: "flex", flexDirection: "column", gap: 16 } as const;
  const slots = data.days.find((d) => d.day === day)?.slots ?? [];

  if (state === "done" && done) {
    const s = new Date(done.start);
    return (
      <div style={{ ...card, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Reunião marcada!</h1>
        <p style={{ color: "#475467", margin: 0 }}>{s.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Sao_Paulo" })}, às {s.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })}.</p>
        {done.meet ? <a href={done.meet} style={{ color }}>Link da chamada</a> : null}
        <p style={{ color: "#667085", fontSize: 13.5, margin: 0 }}>Enviamos a confirmação para {v.email}, com o link para cancelar se precisar.</p>
      </div>
    );
  }
  return (
    <div style={card}>
      <div>
        <div style={{ fontSize: 13, color: "#667085" }}>{data.agency}{data.host ? ` · ${data.host}` : ""}</div>
        <h1 style={{ margin: "4px 0 0", fontSize: 22 }}>{data.name}</h1>
        <div style={{ fontSize: 13.5, color: "#475467", marginTop: 4 }}>{data.duration_min} min · {data.meet ? "Google Meet · " : ""}{data.timezone}</div>
        {data.description ? <p style={{ color: "#475467", fontSize: 14, marginBottom: 0 }}>{data.description}</p> : null}
      </div>
      {!data.available ? <p style={{ color: "#B54708" }}>Não conseguimos ver a agenda agora. Tente de novo em alguns minutos.</p> : !data.days.length ? <p style={{ color: "#667085" }}>Sem horários livres nos próximos dias.</p> : (
        <>
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
            {data.days.map((d) => (
              <button key={d.day} type="button" onClick={() => { setDay(d.day); setSlot(""); }} style={{ flex: "0 0 auto", padding: "8px 12px", borderRadius: 10, border: `1px solid ${d.day === day ? color : "#D0D5DD"}`, background: d.day === day ? `${color}14` : "#fff", fontSize: 13.5, cursor: "pointer" }}>{label(d.day)}</button>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(78px, 1fr))", gap: 6 }}>
            {slots.map((h) => (
              <button key={h} type="button" onClick={() => setSlot(h)} style={{ height: 38, borderRadius: 9, border: `1px solid ${h === slot ? color : "#D0D5DD"}`, background: h === slot ? color : "#fff", color: h === slot ? "#fff" : "#101828", fontSize: 14, cursor: "pointer" }}>{h}</button>
            ))}
          </div>
        </>
      )}
      {slot && (
        <form
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setState("busy"); setMsg("");
            const r = await fetch(`/api/public/bookings/${code}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start: `${day}T${slot}:00-03:00`, ...v }) });
            const j = await r.json().catch(() => ({}));
            if (r.ok) { setDone({ meet: j.meet, start: j.start }); return setState("done"); }
            setMsg(j.error || "Não deu certo agora. Tente de novo."); setState("open");
          }}
        >
          <input style={input} placeholder="Seu nome" required minLength={2} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
          <input style={input} placeholder="E-mail" type="email" required value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
          <input style={input} placeholder="WhatsApp (opcional)" type="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
          <textarea style={{ ...input, height: 80, padding: 12 }} placeholder="Quer adiantar algo? (opcional)" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
          {msg && <div style={{ color: "#D92D20", fontSize: 13.5 }}>{msg}</div>}
          <button disabled={state === "busy"} style={{ height: 46, border: "none", borderRadius: 10, background: color, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{state === "busy" ? "Marcando…" : `Confirmar ${label(day)}, ${slot}`}</button>
        </form>
      )}
    </div>
  );
}
