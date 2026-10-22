import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { crmBoard } from "../src/lib/core/crm";
import { createForm, deleteForm, listForms, publicForm, submitForm, updateForm } from "../src/lib/core/forms";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("formulário: resposta vira negócio no CRM, com condição, validação e limite por IP", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, '{"full_name":"Ana Souza"}'::jsonb) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Forms" });
  const f = await createForm(sql, agencyId, dona, {
    name: "Diagnóstico gratuito", deal_stage: "contato", cta: "Quero meu diagnóstico",
    fields: [
      { id: "nome", t: "text", l: "Seu nome", req: true }, { id: "emp", t: "text", l: "Nome da empresa", req: true }, { id: "wa", t: "phone", l: "WhatsApp", req: true },
      { id: "seg", t: "choice", l: "Segmento", opts: ["Saúde", "Varejo"], req: true }, { id: "ja", t: "choice", l: "Já anuncia hoje?", opts: ["Sim", "Não"] },
      { id: "canal", t: "text", l: "Em quais canais?", req: true, cond: ["ja", "Sim"] },
    ],
  });
  assert.match(f.code, /^[a-z0-9]{10}$/);
  const pub = await publicForm(sql, f.code);
  assert.deepEqual([pub.name, pub.cta, pub.fields.length], ["Diagnóstico gratuito", "Quero meu diagnóstico", 6]);

  const bad = await submitForm(sql, f.code, { nome: "Rafael", wa: "123", seg: "Outro", ja: "Sim" }, "9.9.9.9", "sal").catch((e) => e);
  assert.deepEqual(bad.fields, { emp: "Campo obrigatório", wa: "Telefone incompleto", seg: "Escolha uma das opções", canal: "Campo obrigatório" });
  await submitForm(sql, f.code, { nome: "Rafael Couto", emp: "Clínica Sorriso", wa: "(41) 99999-0000", seg: "Saúde", ja: "Não", canal: "ignorado" }, "9.9.9.9", "sal");

  const [deal] = (await crmBoard(sql, agencyId)).deals;
  assert.deepEqual([deal.company, deal.contact_name, deal.phone, deal.segment, deal.stage, deal.source, deal.owner_name], ["Clínica Sorriso", "Rafael Couto", "(41) 99999-0000", "Saúde", "contato", "Formulário", "Ana Souza"]);
  assert.match(deal.notes!, /Já anuncia hoje\?: Não/);
  assert.doesNotMatch(deal.notes!, /ignorado/, "campo com condição falsa fica de fora");
  const [form] = await listForms(sql, agencyId);
  assert.deepEqual([form.views, form.submissions.length, form.submissions[0].deal_id], [1, 1, deal.id]);

  for (let i = 0; i < 10; i++) await submitForm(sql, f.code, { nome: "Spam " + i, emp: "X", wa: "41999990000", seg: "Varejo" }, "1.1.1.1", "sal");
  await assert.rejects(submitForm(sql, f.code, { nome: "Spam", emp: "X", wa: "41999990000", seg: "Varejo" }, "1.1.1.1", "sal"), /Muitas respostas/);

  await updateForm(sql, agencyId, f.id, { active: false });
  await assert.rejects(publicForm(sql, f.code), /não encontrado/);
  await deleteForm(sql, agencyId, f.id);
  assert.equal((await listForms(sql, agencyId)).length, 0);
});
