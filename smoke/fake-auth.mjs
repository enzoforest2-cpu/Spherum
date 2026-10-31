// Login simulado do Supabase Auth para o teste smoke: aceita um token no formato de JWT
// (cabeçalho.dados.assinatura) e devolve o usuário dos "dados". Só GET /auth/v1/user.
import { createServer } from "node:http";

const port = Number(process.env.FAKE_AUTH_PORT || 54321);
createServer((req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (!req.url.startsWith("/auth/v1/user")) return send(404, { msg: "não simulado" });
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (!p.sub) throw new Error("sem sub");
    send(200, { id: p.sub, aud: "authenticated", role: "authenticated", email: p.email ?? null, user_metadata: p.meta ?? {}, app_metadata: {}, created_at: new Date().toISOString() });
  } catch {
    send(401, { code: 401, msg: "invalid JWT" });
  }
}).listen(port, "127.0.0.1", () => console.log(`login simulado em ${port}`));
