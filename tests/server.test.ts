import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startApp, type App } from "../server/main";

let app: App;
let dir: string;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "xodos-srv-"));
  process.env.HOME = dir;
  app = await startApp({ dataDir: path.join(dir, "dados"), port: 0 });
});
after(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(app.url + p, {
    ...init,
    headers: { "content-type": "application/json", "x-xodos-token": app.token, ...(init.headers as Record<string, string>) },
  });

test("a página leva o token e as chamadas sem token são recusadas", async () => {
  const html = await (await fetch(app.url + "/")).text();
  assert.match(html, new RegExp(`name="xodos-token" content="${app.token}"`));
  assert.equal((await fetch(app.url + "/api/estado")).status, 401);
  assert.equal((await fetch(app.url + "/api/estado", { headers: { "x-xodos-token": "x" + app.token.slice(1) } })).status, 401);
});

test("recusa outro Host e outra origem", async () => {
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve) => {
    const u = new URL(app.url);
    request({ host: u.hostname, port: u.port, path: "/", headers: { host: "malicioso.com" } }, (res) => resolve(res.statusCode!)).end();
  });
  assert.equal(status, 421);
  const r = await api("/api/estado", { headers: { origin: "https://malicioso.com" } });
  assert.equal(r.status, 403);
});

test("exige JSON nas escritas", async () => {
  const r = await fetch(app.url + "/api/configuracoes", {
    method: "PUT",
    headers: { "x-xodos-token": app.token, "content-type": "text/plain" },
    body: "nome=x",
  });
  assert.equal(r.status, 415);
});

test("configura o nome e mostra a visão geral", async () => {
  const put = await api("/api/configuracoes", { method: "PUT", body: JSON.stringify({ nome: "Enzo" }) });
  assert.equal(put.status, 200);
  const estado = (await (await api("/api/estado")).json()) as { nome: string; xodos: unknown[]; aprovacoes_pendentes: number };
  assert.equal(estado.nome, "Enzo");
  assert.deepEqual(estado.xodos, []);
  assert.equal(estado.aprovacoes_pendentes, 0);
});

test("não serve arquivos fora da pasta da tela", async () => {
  const r = await fetch(app.url + "/..%2f..%2fpackage.json");
  assert.equal(r.status, 404);
});

test("caminho desconhecido da API dá 404", async () => {
  assert.equal((await api("/api/nada")).status, 404);
});

test("chave local, xodó, rotina e memória pela API", async () => {
  const chave = await api("/api/chaves", {
    method: "POST",
    body: JSON.stringify({ provider: "local", label: "Ollama", api_key: "", base_url: "http://127.0.0.1:11434/v1" }),
  });
  const cBody = (await chave.json()) as { chave: { id: string }; error?: string };
  assert.equal(chave.status, 201, cBody.error);

  const novo = await api("/api/xodos", {
    method: "POST",
    body: JSON.stringify({ name: "Pipoca", species: "pingo", color: "laranja", personality: "curioso", provider: "local", model: "llama3.1", credential_id: cBody.chave.id }),
  });
  const xBody = (await novo.json()) as { xodo: { id: string }; error?: string };
  assert.equal(novo.status, 201, xBody.error);
  const id = xBody.xodo.id;

  const rotina = await api(`/api/xodos/${id}/rotinas`, {
    method: "POST",
    body: JSON.stringify({ name: "Bom dia", prompt: "Resuma minha agenda", cron: "0 8 * * 1-5" }),
  });
  const rBody = (await rotina.json()) as { rotina: { id: string }; error?: string };
  assert.equal(rotina.status, 201, rBody.error);
  assert.equal((await api(`/api/xodos/${id}/rotinas/${rBody.rotina.id}`, { method: "PATCH", body: JSON.stringify({ active: false }) })).status, 200);
  const lista = (await (await api(`/api/xodos/${id}/rotinas`)).json()) as { rotinas: { active: boolean }[] };
  assert.equal(lista.rotinas[0].active, false);

  const nota = await api(`/api/xodos/${id}/memoria`, { method: "POST", body: JSON.stringify({ texto: "Prefiro reuniões à tarde." }) });
  const nBody = (await nota.json()) as { nota: { n: number }; error?: string };
  assert.ok(nota.status === 201 || nota.status === 200, nBody.error);
  const apagar = await api(`/api/xodos/${id}/memoria/${nBody.nota.n}?motivo=teste`, { method: "DELETE" });
  assert.equal(apagar.status, 200, JSON.stringify(await apagar.clone().json()));

  const estado = (await (await api("/api/estado")).json()) as { xodos: { name: string }[] };
  assert.deepEqual(estado.xodos.map((x) => x.name), ["Pipoca"]);
  const conversa = await api(`/api/xodos/${id}/conversa`);
  assert.equal(conversa.status, 200);
});
