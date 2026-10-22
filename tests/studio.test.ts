import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { animate, buildPrompt, generate, setConfig, setKit, studioBoard, toContent, videoSweep, type StudioDeps } from "../src/lib/core/studio";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("estúdio: prompt com o kit, limite do plano, imagens em Documentos, vídeo em fila e envio ao Conteúdo", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Estúdio" });
  await sql.query(`update agencies set plan = 'escala' where id = $1`, [agencyId]);
  const c = await createClient(sql, agencyId, dona, { name: "Loja Verano", segment: "Moda" });
  const fal = (await one<{ id: string }>(sql, `insert into integration_connections (agency_id, provider, label, status, ciphertext) values ($1, 'fal', 'fal.ai', 'active', 'v1:x') returning id`, [agencyId]))!.id;

  const prompts: string[] = [];
  let videoState: "fila" | "pronto" = "fila";
  const deps: StudioDeps = {
    sql,
    gen: {
      images: async (_a, _c, prompt, n) => { prompts.push(prompt); return Array.from({ length: n }, (_, i) => ({ url: `https://gen/${i}.png`, mime: "image/png" })); },
      video: async () => ({ request_id: "req-1" }),
      videoStatus: async () => videoState === "pronto" ? { status: "pronto", url: "https://gen/v.mp4" } : { status: "fila" },
    },
    store: async (agencyIdArg, clientId, name, _url, mime) => (await one<{ id: string }>(sql, `insert into documents (agency_id, client_id, name, category, mime, size_bytes, storage_path, status) values ($1, $2, $3, 'Criativos', $4, 10, $5, 'ready') returning id`, [agencyIdArg, clientId, name, mime, randomUUID()]))!.id,
    sign: async (_a, ids) => Object.fromEntries(ids.map((id) => [id, `https://signed/${id}`])),
  };

  await assert.rejects(generate(deps, agencyId, dona, c.id, { text: "vestido na praia" }), /Conecte a fal.ai/);
  await setConfig(sql, agencyId, { provider: "fal", connection_id: fal });
  await setKit(sql, agencyId, c.id, { product: "Vestido de linho", style: "luz dourada, clima leve", color1: "#F05A28", color2: "#FFD23F" });
  const g = await generate(deps, agencyId, dona, c.id, { text: "Vestido na praia ao fim da tarde", format: "story" });
  assert.equal(g.document_ids.length, 4);
  assert.match(prompts[0], /Loja Verano \(Moda\)\. Produto em destaque: Vestido de linho\. Vestido na praia ao fim da tarde\. Estilo da marca: luz dourada/);
  assert.match(prompts[0], /#F05A28 e #FFD23F/);
  assert.match(prompts[0], /vertical \(9:16\)/);
  assert.equal(buildPrompt("x", { name: "A", segment: null }, null, "feed").includes("quadrado"), true);

  let b = await studioBoard(deps, agencyId, c.id);
  assert.deepEqual(b.messages.map((m) => m.role), ["me", "ai"]);
  assert.equal(b.urls[g.document_ids[0]], `https://signed/${g.document_ids[0]}`);
  assert.deepEqual([b.usage.images, b.usage.image_limit], [4, 150]);

  await animate(deps, agencyId, dona, c.id, g.document_ids[0], "Vestido balançando com o vento");
  assert.equal((await videoSweep(deps)).videos, 0);
  videoState = "pronto";
  assert.equal((await videoSweep(deps)).videos, 1);
  b = await studioBoard(deps, agencyId, c.id);
  assert.equal(b.messages.at(-1)!.format, "video");

  const post = await toContent(sql, agencyId, dona, c.id, { document_ids: g.document_ids.slice(0, 2), title: "Verão 30% off", publish_at: "2026-10-30T21:00:00Z" });
  assert.equal((await one<{ kind: string; status: string }>(sql, `select kind, status from content_posts where id = $1`, [post.id]))!.kind, "carrossel");

  // Plano sem Estúdio.
  await sql.query(`update agencies set plan = 'solo' where id = $1`, [agencyId]);
  await assert.rejects(generate(deps, agencyId, dona, c.id, { text: "mais uma" }), /não está no seu plano/);
});
