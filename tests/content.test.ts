import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { decideApproval } from "../src/lib/core/collab";
import {
  contentBoard, createPost, deletePost, linkSocial, markPublished, publishPost, publishSweep, schedulePost, sendForApproval, setAutoPublish, updatePost, type ContentDeps, type PublishArgs,
} from "../src/lib/core/content";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

const user = async (email: string) => (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [email]))!.id;

test("conteúdo: rascunho → aprovação no portal → ajuste → nova versão → aprovado → fila → publicado", async () => {
  const dona = await user(`d-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Conteúdo" });
  const c = await createClient(sql, agencyId, dona, { name: "Clínica Aurora" });
  const cli = await user(`c-${randomUUID()}@x.com`);
  await sql.query(`insert into client_portal_users (client_id, agency_id, user_id) values ($1, $2, $3)`, [c.id, agencyId, cli]);
  const doc = async (mime: string) => (await one<{ id: string }>(sql, `insert into documents (agency_id, client_id, name, mime, size_bytes, storage_path, status) values ($1, $2, 'a', $3, 10, $4, 'ready') returning id`, [agencyId, c.id, mime, randomUUID()]))!.id;
  const img1 = await doc("image/jpeg"), img2 = await doc("image/png");
  const meta = (await one<{ id: string }>(sql, `insert into integration_connections (agency_id, provider, label, status, ciphertext) values ($1, 'meta', 'M', 'active', 'v1:x') returning id`, [agencyId]))!.id;

  const calls: PublishArgs[] = [];
  let failNext = 0;
  const deps: ContentDeps = {
    sql, collab: { sql },
    mediaUrls: async (_a, ids) => ids.map((id) => ({ id, url: `https://cdn.test/${id}`, mime: "image/jpeg" })),
    publish: async (a) => { if (failNext) { failNext--; throw Object.assign(new Error("Rede fora"), { status: 502 }); } calls.push(a); return { id: a.net + "-1", url: `https://social.test/${a.net}` }; },
  };

  const p = await createPost(sql, agencyId, dona, { client_id: c.id, title: "3 mitos sobre botox", caption: "Legenda #botox", kind: "carrossel", nets: ["IG", "FB"], publish_at: "2026-10-23T21:00:00Z", media_ids: [img1] });
  await assert.rejects(schedulePost(sql, agencyId, dona, p.id, true), /2 a 10 arquivos/);
  await updatePost(sql, agencyId, dona, p.id, { media_ids: [img1, img2] });

  await sendForApproval(deps, agencyId, dona, p.id);
  const ap1 = (await one<{ approval_id: string }>(sql, `select approval_id from content_posts where id = $1`, [p.id]))!.approval_id;
  const appr = await one<{ details: string; document_id: string }>(sql, `select details, document_id from client_approvals where id = $1`, [ap1]);
  assert.match(appr!.details, /Instagram e Facebook/);
  assert.equal(appr!.document_id, img1);
  await assert.rejects(updatePost(sql, agencyId, dona, p.id, { caption: "outra" }), /nova versão/);

  await decideApproval(sql, cli, ap1, { decision: "alteracoes", comment: "Texto maior na arte" });
  let b = (await contentBoard(sql, agencyId, "2026-10-01", "2026-11-01")).posts[0];
  assert.equal(b.status, "fix");
  assert.equal(b.comments.at(-1)!.text, "Texto maior na arte");

  await sendForApproval(deps, agencyId, dona, p.id, { note: "Aumentei o texto" });
  const ap2 = (await one<{ approval_id: string; version: number }>(sql, `select approval_id, version from content_posts where id = $1`, [p.id]))!;
  assert.equal(ap2.version, 2);
  await decideApproval(sql, cli, ap2.approval_id, { decision: "aprovado" });
  b = (await contentBoard(sql, agencyId, "2026-10-01", "2026-11-01")).posts[0];
  assert.equal(b.status, "appr");

  // Sem perfis ligados não sai.
  await schedulePost(sql, agencyId, dona, p.id, true);
  const early = await publishSweep(deps, new Date("2026-10-23T20:00:00Z"));
  assert.deepEqual(early, { published: 0, failed: 0 }, "ainda não é a hora");
  await assert.rejects(publishPost(deps, agencyId, p.id), /Ligue o Instagram/);
  assert.equal((await one<{ status: string }>(sql, `select status from content_posts where id = $1`, [p.id]))!.status, "fail");

  await linkSocial(sql, agencyId, c.id, { connection_id: meta, page_id: "111", page_name: "Aurora", ig_user_id: "222", ig_username: "aurora" });
  await schedulePost(sql, agencyId, dona, p.id, true);
  // Falha passageira: volta para a fila; na próxima, sai.
  failNext = 1;
  assert.deepEqual(await publishSweep(deps, new Date("2026-10-23T21:01:00Z")), { published: 0, failed: 1 });
  assert.equal((await one<{ status: string }>(sql, `select status from content_posts where id = $1`, [p.id]))!.status, "sched");
  assert.deepEqual(await publishSweep(deps, new Date("2026-10-23T21:16:00Z")), { published: 1, failed: 0 });
  assert.deepEqual(calls.map((x) => [x.net, x.kind, x.pageId, x.igUserId, x.media.length]), [["IG", "carrossel", "111", "222", 2], ["FB", "carrossel", "111", "222", 2]]);
  b = (await contentBoard(sql, agencyId, "2026-10-01", "2026-11-01")).posts[0];
  assert.equal(b.status, "pub");
  assert.equal(b.results.IG.url, "https://social.test/IG");
  await assert.rejects(updatePost(sql, agencyId, dona, p.id, { title: "x" }), /publicado não muda/);

  // Publicar sozinho quando aprovado; editar depois da aprovação pede aprovação de novo.
  await setAutoPublish(sql, agencyId, true);
  const p2 = await createPost(sql, agencyId, dona, { client_id: c.id, title: "Story", kind: "story", nets: ["IG"], publish_at: "2026-10-24T12:00:00Z", media_ids: [img1] });
  await sendForApproval(deps, agencyId, dona, p2.id);
  await decideApproval(sql, cli, (await one<{ approval_id: string }>(sql, `select approval_id from content_posts where id = $1`, [p2.id]))!.approval_id, { decision: "aprovado" });
  assert.equal((await one<{ status: string }>(sql, `select status from content_posts where id = $1`, [p2.id]))!.status, "sched");
  await updatePost(sql, agencyId, dona, p2.id, { caption: "mudou" });
  assert.equal((await one<{ status: string }>(sql, `select status from content_posts where id = $1`, [p2.id]))!.status, "draft");

  // Agendar direto (sem cliente), regras da Meta e marcar como publicado à mão.
  await assert.rejects(createPost(sql, agencyId, dona, { client_id: c.id, title: "Só texto", caption: "oi", nets: ["IG"], publish_at: "2026-10-25T12:00:00Z" }, { schedule: true }), /só publica com foto/);
  const p3 = await createPost(sql, agencyId, dona, { client_id: c.id, title: "Aviso", caption: "Feriado", nets: ["FB"], publish_at: "2026-10-25T12:00:00Z" }, { schedule: true });
  await markPublished(sql, agencyId, dona, p3.id, "https://facebook.com/p/1");
  assert.equal((await one<{ status: string }>(sql, `select status from content_posts where id = $1`, [p3.id]))!.status, "pub");
  await deletePost(sql, agencyId, p2.id);
  assert.equal((await contentBoard(sql, agencyId, "2026-10-01", "2026-11-01")).posts.length, 2);
});
