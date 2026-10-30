import assert from "node:assert/strict";
import { before, test } from "node:test";
import { forwardSweep } from "../src/lib/channels/notify-forward";
import type { Adapters, ChannelAdapter, ChannelDeps } from "../src/lib/channels/types";
import { saveConnection, type IntegrationDeps } from "../src/lib/integrations/store";
import type { Sql } from "../src/lib/xodos/db";
import { Clock, createTestDb, FakeModel, seedAgency, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("avisos do sino vão para o Telegram de quem ligou o celular, respeitando a preferência", async () => {
  const { agencyId, ownerId } = await seedAgency(sql, "Avisos");
  const integ: IntegrationDeps = { sql, masterKey: MASTER, fetch: fetch, appUrl: "https://spherum.com.br" };
  const conn = await saveConnection(integ, { agencyId, provider: "telegram", label: "Bot", account: "bot-1", secret: { apiKey: "123:abc" } });
  const xodo = await seedXodo(sql, agencyId);
  await sql.query(`insert into channel_identities (agency_id, provider, external_user, user_id) values ($1, 'telegram', '42', $2)`, [agencyId, ownerId]);
  await sql.query(`insert into xodo_conversations (agency_id, xodo_id, channel, connection_id, external_key, metadata) values ($1, $2, 'telegram', $3, '42', '{"chat_id":42}')`, [agencyId, xodo.id, conn]);
  const sent: { target: unknown; text: string }[] = [];
  const telegram: ChannelAdapter = { provider: "telegram", maxChars: 4000, send: async (ctx, m) => { sent.push({ target: ctx.target, text: m.text }); } };
  const deps = { ...testDeps(sql, new FakeModel([]), new Clock()), integrations: { masterKey: MASTER, fetch, appUrl: "https://spherum.com.br" } } as unknown as ChannelDeps;
  const noon = new Date("2026-10-30T15:00:00Z"); // 12h em Brasília, fora do silêncio
  await sql.query(`insert into notifications (agency_id, kind, title, body, created_at) values ($1, 'approval_pending', 'Mel pede aprovação', 'Publicar relatório', $2), ($1, 'outra_coisa', 'Sem categoria', '', $2)`, [agencyId, noon.toISOString()]);
  const r = await forwardSweep(deps, { telegram } as Adapters, noon);
  assert.equal(r.sent, 1);
  assert.deepEqual(sent[0].target, { chat_id: 42 });
  assert.match(sent[0].text, /Aviso do Spherum: Mel pede aprovação\nPublicar relatório/);
  assert.equal((await forwardSweep(deps, { telegram } as Adapters, noon)).sent, 0, "não repete");
  // Desligado em "App de celular": não recebe.
  await sql.query(`insert into push_prefs (agency_id, user_id, channels) values ($1, $2, false)`, [agencyId, ownerId]);
  await sql.query(`insert into notifications (agency_id, kind, title, created_at) values ($1, 'approval_pending', 'Outro pedido', $2)`, [agencyId, noon.toISOString()]);
  assert.equal((await forwardSweep(deps, { telegram } as Adapters, noon)).sent, 0);
});
