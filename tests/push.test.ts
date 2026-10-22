import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { addDevice, appBoard, categoryOf, pushSweep, quiet, setPrefs, type PushMessage } from "../src/lib/core/push";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("silêncio e categorias", () => {
  assert.equal(categoryOf("approval_pending"), "appr");
  assert.equal(categoryOf("post_falhou"), "fail");
  assert.equal(categoryOf("qualquer_coisa"), null);
  assert.equal(quiet(22, 7, new Date("2026-10-22T02:00:00Z")), true, "23h em Brasília");
  assert.equal(quiet(22, 7, new Date("2026-10-22T15:00:00Z")), false, "12h");
  assert.equal(quiet(null, null, new Date()), false);
});

test("push: aviso vira notificação para quem tem aparelho e a categoria ligada", async () => {
  const user = async () => (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`${randomUUID()}@x.com`]))!.id;
  const ana = await user(), beto = await user();
  const { id: agencyId } = await createAgency(sql, ana, { name: "Agência Push" });
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'member')`, [agencyId, beto]);
  await addDevice(sql, agencyId, ana, { endpoint: "https://push.test/ana", keys: { p256dh: "p".repeat(20), auth: "a".repeat(10) }, label: "iPhone" });
  await addDevice(sql, agencyId, beto, { endpoint: "https://push.test/beto", keys: { p256dh: "p".repeat(20), auth: "a".repeat(10) } });
  await setPrefs(sql, agencyId, beto, { categories: ["appr"], quiet_start: null, quiet_end: null });
  await setPrefs(sql, agencyId, ana, { quiet_start: null, quiet_end: null });

  const sent: { endpoint: string; msg: PushMessage }[] = [];
  const send = async (d: { endpoint: string }, msg: PushMessage) => { sent.push({ endpoint: d.endpoint, msg }); return d.endpoint.endsWith("gone") ? "gone" as const : "ok" as const; };
  await sql.query(`insert into notifications (agency_id, kind, title) values ($1, 'post_falhou', 'Post não saiu'), ($1, 'approval_pending', 'Faísca precisa de você'), ($1, 'outro', 'Nada')`, [agencyId]);
  await sql.query(`insert into notifications (agency_id, user_id, kind, title) values ($1, $2, 'reconhecimento', 'Você recebeu um reconhecimento')`, [agencyId, beto]);

  const r = await pushSweep(sql, send, new Date());
  assert.deepEqual(sent.map((s) => [s.endpoint.split("/").pop(), s.msg.title]).sort(), [["ana", "Faísca precisa de você"], ["ana", "Post não saiu"], ["beto", "Faísca precisa de você"]]);
  assert.equal(r.skipped, 1, "tipo sem categoria");
  assert.equal((await pushSweep(sql, send, new Date())).sent, 0, "não reenvia");

  // Aparelho que sumiu sai da lista.
  await addDevice(sql, agencyId, ana, { endpoint: "https://push.test/gone", keys: { p256dh: "p".repeat(20), auth: "a".repeat(10) } });
  await sql.query(`insert into notifications (agency_id, kind, title) values ($1, 'post_falhou', 'Outro')`, [agencyId]);
  assert.equal((await pushSweep(sql, send, new Date())).gone, 1);
  const b = await appBoard(sql, agencyId, ana);
  assert.deepEqual([b.devices.length, b.team.n, b.team.with_app], [1, 2, 2]);
});
