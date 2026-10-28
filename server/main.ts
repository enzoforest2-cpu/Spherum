import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localDeps } from "../src/xodos";
import { failure, handle, type Ctx } from "./api";
import { openDatabase } from "./database";
import { dataDir as defaultDataDir, PORT } from "./paths";
import { prepare } from "./state";
import { Worker } from "./worker";

/**
 * O programa: abre o banco, prepara você e os xodós, liga o trabalho em segundo plano e serve a
 * tela em http://127.0.0.1:4747.
 *
 * Segurança: o servidor só escuta o próprio computador (127.0.0.1). Mesmo assim, uma página
 * qualquer aberta no navegador poderia tentar chamar o app; por isso toda chamada à API precisa
 * do token sorteado a cada abertura (ele vai escondido na página do app e em nenhum outro
 * lugar), e o servidor recusa endereços (Host) e origens (Origin) que não sejam os dele.
 */

const MAX_BODY = 1_000_000;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

function uiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "ui"), path.join(here, "..", "ui")]) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  throw new Error("Pasta ui/ com a tela do app não encontrada.");
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("grande demais"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!size) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("JSON inválido"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sameToken(given: string | null | undefined, token: string) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type App = { server: Server; url: string; token: string; close: () => Promise<void> };

export async function startApp(opts: { dataDir?: string; port?: number; quiet?: boolean } = {}): Promise<App> {
  const dir = opts.dataDir ?? defaultDataDir();
  mkdirSync(dir, { recursive: true });
  const { pg, sql } = await openDatabase(path.join(dir, "banco"));
  const state = await prepare(sql, dir);
  const deps = localDeps(sql, state.masterKey);
  const worker = new Worker(deps);
  const ctx: Ctx = { deps, state, worker };
  const token = randomBytes(24).toString("base64url");
  const ui = uiDir();

  // A tela escuta /api/eventos para atualizar na hora (sem ficar perguntando).
  const listeners = new Set<ServerResponse>();
  worker.onChange = (runId) => {
    const line = `data: ${JSON.stringify({ run_id: runId })}\n\n`;
    for (const res of listeners) res.write(line);
  };
  const ping = setInterval(() => {
    for (const res of listeners) res.write(": ping\n\n");
  }, 25_000);

  let port = 0;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const server = createServer(async (req, res) => {
    try {
      // Endereço errado = alguém tentando chegar aqui por outro nome (DNS rebinding). Recusa.
      if (!allowedHosts().has(String(req.headers.host ?? ""))) return send(res, 421, { error: "Endereço não permitido." });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const origin = req.headers.origin;
      if (origin && !allowedOrigins().has(origin)) return send(res, 403, { error: "Origem não permitida." });

      if (url.pathname.startsWith("/api/")) {
        // O EventSource do navegador não manda cabeçalhos; ali o token vai no endereço.
        const given = url.pathname === "/api/eventos" ? url.searchParams.get("t") : req.headers["x-xodos-token"]?.toString();
        if (!sameToken(given, token)) return send(res, 401, { error: "Recarregue a página do app." });

        if (url.pathname === "/api/eventos" && req.method === "GET") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          res.write(": ok\n\n");
          listeners.add(res);
          req.on("close", () => listeners.delete(res));
          return;
        }

        const method = req.method ?? "GET";
        let body: unknown;
        if (method !== "GET" && method !== "DELETE") {
          const type = String(req.headers["content-type"] ?? "");
          if (req.headers["content-length"] !== "0" && !type.startsWith("application/json")) {
            return send(res, 415, { error: "Envie JSON." });
          }
          try {
            body = await readBody(req);
          } catch (error) {
            const status = (error as { status?: number }).status ?? 400;
            return send(res, status, { error: status === 413 ? "Envio grande demais." : "JSON inválido." });
          }
        }
        const result = await handle(ctx, { method, path: url.pathname, query: url.searchParams, body });
        return send(res, result.status, result.body);
      }

      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Método não permitido." });
      serveStatic(ui, url.pathname, token, res);
    } catch (error) {
      const r = failure(error);
      if (!res.headersSent) send(res, r.status, r.body);
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  worker.start();

  const close = async () => {
    clearInterval(ping);
    worker.stop();
    for (const res of listeners) res.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pg.close();
  };
  return { server, url: `http://127.0.0.1:${port}`, token, close };
}

function serveStatic(ui: string, pathname: string, token: string, res: ServerResponse) {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: "Endereço inválido." });
  }
  // Sem extensão = uma tela do app (o roteamento é na própria página).
  if (rel === "/" || !path.extname(rel)) rel = "/index.html";
  const file = path.resolve(ui, "." + path.posix.normalize(rel));
  if (!file.startsWith(ui + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    return send(res, 404, { error: "Não encontrado." });
  }
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };
  if (file.endsWith("index.html")) {
    const html = readFileSync(file, "utf8").replace("</head>", `<meta name="xodos-token" content="${token}">\n</head>`);
    headers["cache-control"] = "no-store";
    headers["content-security-policy"] =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    res.writeHead(200, headers);
    return res.end(html);
  }
  headers["cache-control"] = "no-cache";
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

function openBrowser(url: string) {
  if (process.env.XODOS_NAO_ABRIR) return;
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {}
}

async function main() {
  console.log("Abrindo os Xodós...");
  let app: App;
  try {
    app = await startApp();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // Já está aberto (ou outra coisa usa a porta): só mostra a tela.
      console.log(`Os Xodós já estão abertos em http://127.0.0.1:${PORT}`);
      openBrowser(`http://127.0.0.1:${PORT}`);
      return;
    }
    throw error;
  }
  console.log(`Pronto! A tela está em ${app.url}`);
  console.log("Deixe esta janela aberta enquanto usar os xodós. Para fechar, feche a janela (ou Ctrl+C).");
  openBrowser(app.url);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    console.log("Fechando com cuidado...");
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGBREAK", stop);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked || process.env.XODOS_MAIN === "1") {
  main().catch((error) => {
    console.error("Os Xodós não conseguiram abrir:", error);
    process.exitCode = 1;
  });
}
