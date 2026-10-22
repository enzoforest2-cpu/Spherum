import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { crmBoard } from "../src/lib/core/crm";
import {
  importLeads, inWindow, leadMessages, leadToCrm, normPhone, phoneKeys, prospectBoard, prospectInbound, prospectSweep, queueLeads, replyLead, setConfig, templateParams, type SenderFor,
} from "../src/lib/core/prospect";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("números: normaliza, valida e casa o celular com e sem o 9", () => {
  assert.equal(normPhone("(41) 99221-5850"), "5541992215850");
  assert.equal(normPhone("+55 41 3322-1100"), "554133221100");
  assert.equal(normPhone("041 99221 5850"), "5541992215850");
  assert.equal(normPhone("123"), null);
  assert.equal(normPhone("41 89221-5850"), null, "celular sem o 9");
  assert.deepEqual(phoneKeys("554192215850"), ["554192215850", "5541992215850"]);
  assert.deepEqual(templateParams("Oi {nome}, a {empresa}…", { name: "Ana Souza", company: "Studio X", segment: null, city: null }), ["Ana", "Studio X"]);
  assert.equal(inWindow(new Date("2026-10-22T13:00:00Z")), true, "quinta 10h");
  assert.equal(inWindow(new Date("2026-10-22T22:00:00Z")), false, "quinta 19h");
  assert.equal(inWindow(new Date("2026-10-24T13:00:00Z")), false, "sábado");
});

test("prospecção: importa, dispara com modelo, recebe resposta, SAIR bloqueia e vira negócio", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Prospect" });
  const conn = (await one<{ id: string }>(sql,
    `insert into integration_connections (agency_id, provider, label, status, ciphertext, external_account, metadata) values ($1, 'whatsapp_cloud', 'WA', 'active', 'v1:x', '123456', '{}'::jsonb) returning id`, [agencyId]))!.id;

  await assert.rejects(importLeads(sql, agencyId, dona, { list: "Evento", text: "41999990000" }), /Confirme/);
  const r = await importLeads(sql, agencyId, dona, { list: "Evento", consent: true, text: "(41) 99999-0001, Ana Lima, Studio Ana\n41999990002, Beto\n41999990001, Repetido\n123\n41999990003, Caio, Box 41" });
  assert.deepEqual(r, { added: 3, bad: 1, dup: 1, blocked: 0 });
  assert.equal((await importLeads(sql, agencyId, dona, { list: "Outra", consent: true, text: "41999990002" })).dup, 1, "já existe na agência");

  await assert.rejects(setConfig(sql, agencyId, { running: true }), /Conecte/);
  await assert.rejects(setConfig(sql, agencyId, { connection_id: conn, running: true }), /Falta o modelo/);
  await assert.rejects(setConfig(sql, agencyId, { steps: [{ t: "A", day: 0, text: "{Oi|Olá} {nome}", template: "a" }] }), /texto fixo/);
  await setConfig(sql, agencyId, {
    connection_id: conn, daily_limit: 10, running: true,
    steps: [{ t: "Primeira", day: 0, text: "Olá, {nome}! Posso mandar ideias para a {empresa}?", template: "primeiro_contato" }, { t: "Última", day: 3, text: "Se preferir não receber mais, responda SAIR.", template: "ultima" }],
    variations: [{ style: "A", text: "Olá, {nome}! Ideias para a {empresa}?", template: "var_a" }, { style: "B", text: "{nome}, tudo bem? Tenho ideias para a {empresa}.", template: "var_b" }],
  });

  const leads = (await prospectBoard(sql, agencyId)).leads;
  const ana = leads.find((l) => l.name === "Ana Lima")!;
  assert.deepEqual((await queueLeads(sql, agencyId, leads.map((l) => l.id), new Date("2026-10-22T12:00:00Z"))).queued, 3);

  const sent: { to: string; m: unknown }[] = [];
  const ok: SenderFor = () => async (to, m) => { sent.push({ to, m }); };
  assert.equal((await prospectSweep(sql, ok, new Date("2026-10-22T23:00:00Z"))).sent, 0, "fora do horário");
  const thu = new Date("2026-10-22T13:00:00Z");
  assert.equal((await prospectSweep(sql, ok, thu)).sent, 3);
  const toAna = sent.find((s) => s.to === "5541999990001")!.m as { name: string; params: string[] };
  assert.ok(["var_a", "var_b"].includes(toAna.name));
  assert.deepEqual(toAna.params, ["Ana", "Studio Ana"]);
  assert.equal((await prospectSweep(sql, ok, thu)).sent, 0, "segundo passo só daqui a 3 dias");

  // Resposta (com o número sem o 9) tira da cadência.
  const res = await prospectInbound(sql, agencyId, "554199990001", "Oi! Pode mandar", "wamid.1", new Date("2026-10-22T14:00:00Z"));
  assert.equal(res?.status, "reply");
  assert.equal((await prospectInbound(sql, agencyId, "554199990001", "Oi! Pode mandar", "wamid.1", new Date()))?.status, "duplicate");
  assert.equal(await prospectInbound(sql, agencyId, "5511988887777", "oi", "wamid.x", new Date()), null, "não é de prospecção");
  assert.equal((await prospectBoard(sql, agencyId)).stats.unread, 1);

  // Beto pede para sair.
  assert.equal((await prospectInbound(sql, agencyId, "5541999990002", "SAIR", "wamid.2", new Date("2026-10-22T14:00:00Z")))?.status, "optout");
  assert.equal((await importLeads(sql, agencyId, dona, { list: "De novo", consent: true, text: "41999990002" })).blocked, 1);

  // Três dias depois: só o Caio (que não respondeu) recebe o último passo.
  sent.length = 0;
  const mon = new Date("2026-10-26T13:00:00Z");
  assert.equal((await prospectSweep(sql, ok, mon)).sent, 1);
  assert.equal(sent[0].to, "5541999990003");
  assert.equal((sent[0].m as { name: string }).name, "ultima");

  // Resposta manual: dentro das 24 horas da última mensagem do lead.
  await assert.rejects(replyLead(sql, ok, agencyId, dona, ana.id, "Mando já!", mon), /24 horas/);
  await replyLead(sql, ok, agencyId, dona, ana.id, "Mando já!", new Date("2026-10-22T15:00:00Z"));
  const msgs = await leadMessages(sql, agencyId, ana.id, new Date("2026-10-22T16:00:00Z"));
  assert.deepEqual(msgs.map((m) => m.dir), ["out", "in", "out"]);
  assert.equal((await prospectBoard(sql, agencyId)).stats.unread, 0);

  const deal = await leadToCrm(sql, agencyId, dona, ana.id);
  const d = (await crmBoard(sql, agencyId)).deals.find((x) => x.id === deal.id)!;
  assert.deepEqual([d.company, d.contact_name, d.phone, d.stage, d.source], ["Studio Ana", "Ana Lima", "(41) 99999-0001", "contato", "Prospecção"]);
  assert.match(d.notes!, /Lead: Oi! Pode mandar/);
  const board = await prospectBoard(sql, agencyId);
  assert.deepEqual([board.stats.crm, board.stats.opted_out, board.stats.contacted, board.stats.replied], [1, 1, 3, 1]);

  // Limite do dia e erro da Meta.
  await importLeads(sql, agencyId, dona, { list: "Mais", consent: true, text: Array.from({ length: 12 }, (_, i) => `4198888${String(i).padStart(4, "0")}`).join("\n") });
  const more = (await prospectBoard(sql, agencyId)).leads.filter((l) => l.list_name === "Mais");
  await queueLeads(sql, agencyId, more.map((l) => l.id), mon);
  const tue = new Date("2026-10-27T13:00:00Z");
  let n = 0;
  const flaky: SenderFor = () => async () => { if (++n === 2) throw Object.assign(new Error("Sem WhatsApp"), { status: 422 }); };
  const swept = await prospectSweep(sql, flaky, tue);
  assert.deepEqual([swept.sent, swept.failed], [9, 1], "limite de 10 por dia");
  assert.equal((await prospectBoard(sql, agencyId, tue)).stats.errors, 1);
});
