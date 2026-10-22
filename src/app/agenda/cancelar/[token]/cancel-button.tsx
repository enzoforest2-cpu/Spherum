"use client";

import { useState } from "react";

export function CancelButton({ token }: { token: string }) {
  const [state, setState] = useState<"ask" | "busy" | "done" | "error">("ask");
  const [msg, setMsg] = useState("");
  if (state === "done") return <><h1 style={{ fontSize: 20 }}>Reunião cancelada</h1><p style={{ color: "#475467" }}>{msg}</p></>;
  return (
    <>
      <h1 style={{ fontSize: 20 }}>Cancelar a reunião?</h1>
      <p style={{ color: "#475467" }}>A agência é avisada e o horário fica livre de novo.</p>
      {state === "error" && <p style={{ color: "#D92D20" }}>{msg}</p>}
      <button
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          const r = await fetch(`/api/public/bookings/cancel/${token}`, { method: "POST" });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { setMsg(j.error || "Não deu certo agora."); return setState("error"); }
          setMsg(j.already ? "Ela já estava cancelada." : `${j.type} com ${j.agency} foi cancelada.`); setState("done");
        }}
        style={{ height: 44, padding: "0 20px", border: "none", borderRadius: 10, background: "#D92D20", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
      >{state === "busy" ? "Cancelando…" : "Cancelar reunião"}</button>
    </>
  );
}
