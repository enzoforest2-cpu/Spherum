// Conversa com o servidor do app. O token vem escondido na página (ver server/main.ts).
const token = document.querySelector('meta[name="xodos-token"]')?.content ?? "";

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      headers: { "x-xodos-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("O app parece fechado. Abra os Xodós de novo e recarregue esta página.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || data.message || "Algo deu errado.", res.status, data);
  return data;
}

/** Avisa quando algo muda no servidor (uma execução andou, chegou pedido de aprovação...). */
export function onServerChange(fn) {
  let source;
  let retry;
  const open = () => {
    source = new EventSource("/api/eventos?t=" + encodeURIComponent(token));
    source.onmessage = (e) => {
      try {
        fn(JSON.parse(e.data));
      } catch {}
    };
    source.onerror = () => {
      source.close();
      retry = setTimeout(open, 3000);
    };
  };
  open();
  return () => {
    clearTimeout(retry);
    source?.close();
  };
}
