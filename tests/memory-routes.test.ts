import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { ZodError } from "zod";
import { one, type Sql } from "../src/lib/xodos/db";
import type { LlmClient } from "../src/lib/xodos/llm";
import { updateXodo } from "../src/lib/xodos/manage";
import { addItem, MemoryConflict, upsertTopic, type MemoryXodo } from "../src/lib/xodos/memory/store";
import {
  conflictBody,
  createNote,
  deleteNote,
  deleteTopic,
  editNote,
  exportMarkdown,
  listCaptures,
  listMemory,
  listMemoryChanges,
  noteNumber,
  revertNotes,
  updateTopic,
  type TeamActor,
} from "../src/lib/xodos/memory/team";
import { loadXodo } from "../src/lib/xodos/runner";
import type { Xodo } from "../src/lib/xodos/types";
import { createTestDb, FakeModel, seedAgency, seedClient, seedXodo } from "./helpers";

let sql: Sql;
let llm: LlmClient;
before(async () => {
  ({ sql } = await createTestDb());
  llm = new FakeModel([]).llm;
});

const NOW = new Date("2026-10-19T12:00:00Z");
const owner: TeamActor = { userId: randomUUID(), manage: true };
const member: TeamActor = { userId: randomUUID(), manage: false };

const status = (code: number) => (error: unknown) => (error as { status?: number }).status === code;
const mem = (x: Xodo): MemoryXodo => ({ id: x.id, agency_id: x.agency_id, memory_core_chars: x.memory_core_chars });

async function fresh(overrides: Partial<Record<keyof Xodo, unknown>> = {}) {
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId, overrides);
  return { agencyId, xodo };
}

test("equipe cria nota: origem equipe, autor no diário, sem segredo; repetida não duplica; fixar só owner/admin", async () => {
  const { xodo } = await fresh();
  const a = await createNote(sql, xodo, { texto: "Relatórios mensais saem até o 5º dia útil.", motivo: "combinado na reunião" }, member, NOW);
  assert.equal(a.criada, true);
  assert.equal(a.nota.source, "equipe");
  assert.equal(a.nota.created_by, member.userId);
  assert.equal(a.nota.status, "ativo");
  assert.equal("identity" in a.nota, false, "a tela não recebe a identidade");
  const [change] = (await listMemoryChanges(sql, xodo, {})).mudancas;
  assert.deepEqual([change.op, change.actor, change.actor_user, change.reason], ["criar", "equipe", member.userId, "combinado na reunião"]);

  const again = await createNote(sql, xodo, { texto: "relatorios mensais saem ate o 5º dia util" }, member, NOW);
  assert.deepEqual([again.criada, again.nota.n, again.lote], [false, a.nota.n, null]);

  await assert.rejects(createNote(sql, xodo, { texto: "Nunca usar a cor laranja.", fixada: true }, member, NOW), status(403));
  const pinned = await createNote(sql, xodo, { texto: "Nunca usar a cor laranja.", fixada: true }, owner, NOW);
  assert.equal(pinned.nota.pinned, true);

  const secret = await createNote(sql, xodo, { texto: "Instagram da Acme, senha: Abc@12345" }, member, NOW);
  assert.ok(secret.segredos_removidos >= 1);
  assert.ok(!secret.nota.content.includes("Abc@12345"));

  await assert.rejects(createNote(sql, xodo, { texto: "Promo de outubro", valido_ate: "2026-10-18" }, member, NOW), /validade/);
  await assert.rejects(createNote(sql, xodo, { texto: "   " }, member, NOW), ZodError);
  await assert.rejects(createNote(sql, xodo, { texto: "x", tipo: "ordem" }, member, NOW), ZodError);
});

test("a mesma nota que a captura deixou proposta: a equipe escrever é aceitar", async () => {
  const { xodo } = await fresh({ autonomy: "sempre_pergunta" });
  const proposed = await addItem(sql, mem(xodo), { content: "A Acme aprova posts às sextas.", source: "captura", status: "proposto" }, { actor: "captura" });
  const r = await createNote(sql, xodo, { texto: "A Acme aprova posts às sextas" }, member, NOW);
  assert.deepEqual([r.criada, r.aceita, r.nota.n, r.nota.status], [false, true, proposed.item.n, "ativo"]);
});

test("cliente informado precisa estar no alcance do xodó", async () => {
  const { agencyId, xodo } = await fresh({ client_scope: "selected" });
  const inside = await seedClient(sql, agencyId, "Acme");
  const outside = await seedClient(sql, agencyId, "Beta");
  const { agencyId: otherAgency } = await seedAgency(sql, "Outra");
  const foreign = await seedClient(sql, otherAgency, "Gama");
  await sql.query(`insert into xodo_clients (xodo_id, client_id, agency_id) values ($1, $2, $3)`, [xodo.id, inside, agencyId]);

  const ok = await createNote(sql, xodo, { texto: "A Acme fecha o mês no dia 25.", cliente_id: inside }, member, NOW);
  assert.equal(ok.nota.client_id, inside);
  await assert.rejects(createNote(sql, xodo, { texto: "A Beta paga em 30 dias.", cliente_id: outside }, member, NOW), /fora do alcance/);
  await assert.rejects(createNote(sql, xodo, { texto: "A Gama é de outra agência.", cliente_id: foreign }, member, NOW), /fora do alcance/);
  await assert.rejects(editNote(sql, xodo, ok.nota.n, { version: 1, cliente_id: outside }, member, NOW), /fora do alcance/);
});

test("lista com filtros, busca sem acento, página, medidor, contagem e ajustes", async () => {
  const { agencyId, xodo } = await fresh();
  const acme = await seedClient(sql, agencyId, "Acme");
  const core1 = await createNote(sql, xodo, { texto: "Relatórios mensais saem até o 5º dia útil." }, member, NOW);
  const core2 = await createNote(sql, xodo, { texto: "A equipe prefere reuniões curtas." }, member, NOW);
  const topical = await createNote(sql, xodo, { texto: "Desconto máximo de 30%.", topico: "Black Friday Acme", aliases: ["bf"] }, member, NOW);
  const client = await createNote(sql, xodo, { texto: "Contato principal é a Ana.", cliente_id: acme }, member, NOW);
  await addItem(sql, mem(xodo), { content: "A Acme quer stories diários.", source: "captura", status: "proposto" }, { actor: "captura" });
  const gone = await createNote(sql, xodo, { texto: "Nota que vai ser apagada." }, member, NOW);
  await deleteNote(sql, xodo, gone.nota.n, {}, member);

  const all = await listMemory(sql, xodo, {});
  assert.deepEqual(all.notas.map((n) => n.n), [core1.nota.n, core2.nota.n, topical.nota.n, client.nota.n], "só ativas, por #n");
  assert.equal(all.notas.find((n) => n.n === client.nota.n)!.client_name, "Acme");
  assert.equal(all.proximo, null);

  const core = await listMemory(sql, xodo, { topico: "nucleo" });
  assert.deepEqual(core.notas.map((n) => n.n), [core1.nota.n, core2.nota.n], "núcleo: sem tópico e sem cliente");
  assert.deepEqual((await listMemory(sql, xodo, { topico: "black-friday-acme" })).notas.map((n) => n.n), [topical.nota.n]);
  assert.deepEqual((await listMemory(sql, xodo, { cliente: acme })).notas.map((n) => n.n), [client.nota.n]);
  assert.deepEqual((await listMemory(sql, xodo, { cliente: "todos" })).notas.map((n) => n.n), [client.nota.n]);
  assert.equal((await listMemory(sql, xodo, { status: "proposto" })).notas.length, 1);
  assert.deepEqual((await listMemory(sql, xodo, { status: "apagado" })).notas.map((n) => n.n), [gone.nota.n]);
  assert.equal((await listMemory(sql, xodo, { status: "todas" })).notas.length, 6);

  assert.deepEqual((await listMemory(sql, xodo, { q: "relatorio" })).notas.map((n) => n.n), [core1.nota.n], "sem acento acha com acento");
  assert.deepEqual((await listMemory(sql, xodo, { q: "RELAT mensa" })).notas.map((n) => n.n), [core1.nota.n], "prefixo, todos os termos");
  assert.deepEqual((await listMemory(sql, xodo, { q: "bf" })).notas.map((n) => n.n), [topical.nota.n], "acha pelo apelido do tópico");
  assert.deepEqual((await listMemory(sql, xodo, { q: "acme" })).notas.map((n) => n.n), [topical.nota.n, client.nota.n], "título do tópico e nome do cliente");
  assert.equal((await listMemory(sql, xodo, { q: "", topico: "" })).notas.length, 4, "campos vazios não filtram");

  const page1 = await listMemory(sql, xodo, { limite: "2" });
  assert.deepEqual(page1.notas.map((n) => n.n), [core1.nota.n, core2.nota.n]);
  assert.equal(page1.proximo, core2.nota.n);
  const page2 = await listMemory(sql, xodo, { limite: "2", cursor: String(page1.proximo) });
  assert.deepEqual(page2.notas.map((n) => n.n), [topical.nota.n, client.nota.n]);

  const coreChars = core1.nota.content.length + core2.nota.content.length;
  assert.deepEqual(all.medidor, { nucleo_chars: coreChars, limite: 8000, notas: 2, fora_do_prompt: false });
  assert.deepEqual(all.contagem, { ativo: 4, proposto: 1, apagado: 1 });
  assert.equal(all.topicos.length, 1);
  assert.equal(all.topicos[0].slug, "black-friday-acme");
  assert.equal(all.topicos[0].notes, 1);
  assert.deepEqual(
    { ...all.ajustes, memory_tidied_on: null },
    { memory_enabled: true, memory_capture: true, memory_capture_channels: false, memory_tidy: true, memory_core_chars: 8000, memory_tidied_on: null },
  );

  await assert.rejects(listMemory(sql, xodo, { status: "sumida" }), ZodError);
  await assert.rejects(listMemory(sql, xodo, { limite: "500" }), ZodError);
  await assert.rejects(listMemory(sql, xodo, { topico: "!!!" }), /inválido/);
});

test("editar com versão: 409 com a atual, fixar só owner/admin, reativar apagada, aceitar proposta", async () => {
  const { xodo } = await fresh();
  const { nota } = await createNote(sql, xodo, { texto: "Posts saem às 10h." }, member, NOW);
  const edited = await editNote(sql, xodo, nota.n, { version: 1, texto: "Posts saem às 11h.", motivo: "mudou o horário" }, member, NOW);
  assert.deepEqual([edited.nota.version, edited.nota.content], [2, "Posts saem às 11h."]);

  const stale = await editNote(sql, xodo, nota.n, { version: 1, texto: "Posts saem às 9h." }, member, NOW).catch((e) => e);
  assert.ok(stale instanceof MemoryConflict);
  const body = conflictBody(stale)!;
  assert.equal(body.atual.version, 2);
  assert.equal(body.atual.content, "Posts saem às 11h.");
  assert.equal("identity" in body.atual, false);
  assert.equal(conflictBody(new Error("outro")), null);

  await assert.rejects(editNote(sql, xodo, nota.n, { version: 2 }, member, NOW), /Nada para mudar/);
  await assert.rejects(editNote(sql, xodo, nota.n, { texto: "sem versão" }, member, NOW), ZodError);
  await assert.rejects(editNote(sql, xodo, nota.n, { version: 2, fixada: true }, member, NOW), status(403));
  const pinned = await editNote(sql, xodo, nota.n, { version: 2, fixada: true }, owner, NOW);
  assert.equal(pinned.nota.pinned, true);
  const ops = (await listMemoryChanges(sql, xodo, { n: String(nota.n) })).mudancas.map((c) => c.op);
  assert.deepEqual(ops, ["fixar", "editar", "criar"]);

  await assert.rejects(deleteNote(sql, xodo, nota.n, { version: "2" }, member), MemoryConflict);
  const forgotten = await deleteNote(sql, xodo, nota.n, { version: "3" }, member);
  assert.equal("nota" in forgotten && forgotten.nota.status, "apagado");
  const back = await editNote(sql, xodo, nota.n, { version: 4, status: "ativo" }, member, NOW);
  assert.equal(back.nota.status, "ativo");

  const proposed = await addItem(sql, mem(xodo), { content: "A Acme quer relatório em PDF.", source: "captura", status: "proposto" }, { actor: "captura" });
  const accepted = await editNote(sql, xodo, proposed.item.n, { version: 1, status: "ativo" }, member, NOW);
  assert.equal(accepted.nota.status, "ativo");
  const [acceptChange] = (await listMemoryChanges(sql, xodo, { n: String(proposed.item.n) })).mudancas;
  assert.deepEqual([acceptChange.op, acceptChange.actor_user], ["aceitar", member.userId]);
});

test("nota vencida só volta com validade nova (ou sem validade)", async () => {
  const { xodo } = await fresh();
  const { nota } = await createNote(sql, xodo, { texto: "Promo de outubro vale até o dia 25.", valido_ate: "2026-10-25" }, member, NOW);
  // Como a arrumação deixaria: venceu ontem.
  await sql.query(`update xodo_memory_items set status = 'expirado', valid_until = '2026-10-18', version = version + 1 where id = $1`, [nota.id]);
  await assert.rejects(editNote(sql, xodo, nota.n, { version: 2, status: "ativo" }, member, NOW), /venceu em 2026-10-18/);
  await assert.rejects(editNote(sql, xodo, nota.n, { version: 2, status: "ativo", valido_ate: "2026-10-01" }, member, NOW), /validade/);
  const back = await editNote(sql, xodo, nota.n, { version: 2, status: "ativo", valido_ate: null }, member, NOW);
  assert.deepEqual([back.nota.status, back.nota.valid_until], ["ativo", null]);
});

test("apagar, desfazer, desfazer o desfazer e excluir de vez (só owner/admin)", async () => {
  const { xodo } = await fresh();
  const { xodo: other } = await fresh();
  const { nota } = await createNote(sql, xodo, { texto: "Aprovação do cliente leva 2 dias." }, member, NOW);
  const forgotten = await deleteNote(sql, xodo, nota.n, { motivo: "não vale mais" }, member);
  assert.ok("lote" in forgotten && forgotten.lote);
  await assert.rejects(revertNotes(sql, other, forgotten.lote, member), /Lote não encontrado/, "lote de outro xodó");
  const undo = await revertNotes(sql, xodo, forgotten.lote, member);
  assert.equal(undo.desfeitas, 1);
  assert.equal((await listMemory(sql, xodo, {})).notas[0].status, "ativo");
  await revertNotes(sql, xodo, undo.lote, member);
  assert.equal((await listMemory(sql, xodo, { status: "apagado" })).notas.length, 1, "o desfazer também se desfaz");
  await assert.rejects(revertNotes(sql, xodo, "nao-e-uuid", member), ZodError);

  await assert.rejects(deleteNote(sql, xodo, nota.n, { definitivo: "1" }, member), status(403));
  const purged = await deleteNote(sql, xodo, nota.n, { definitivo: "1", motivo: "pedido LGPD" }, owner);
  assert.deepEqual(purged, { n: nota.n, excluida: true });
  assert.equal(await one(sql, `select 1 from xodo_memory_items where id = $1`, [nota.id]), null);
  const texts = await sql.query<{ before: unknown; after: unknown }>(
    `select before, after from xodo_memory_changes where xodo_id = $1 and op <> 'expurgar'`,
    [xodo.id],
  );
  assert.ok(texts.every((t) => t.before === null && t.after === null), "o texto some do diário");
  const purge = await one<{ actor_user: string; reason: string }>(sql, `select actor_user, reason from xodo_memory_changes where xodo_id = $1 and op = 'expurgar'`, [xodo.id]);
  assert.deepEqual([purge!.actor_user, purge!.reason], [owner.userId, "pedido LGPD"]);
  await assert.rejects(deleteNote(sql, xodo, nota.n, {}, member), status(404));
});

test("desfazer: lote que fixou só owner/admin; lote sem nota dá 409; apagar de novo não gera lote", async () => {
  const { xodo } = await fresh();
  const { nota } = await createNote(sql, xodo, { texto: "Logo sempre no canto direito." }, member, NOW);
  const pinned = await editNote(sql, xodo, nota.n, { version: 1, fixada: true }, owner, NOW);
  await assert.rejects(revertNotes(sql, xodo, pinned.lote, member), status(403), "desfazer o fixar seria desafixar");
  const undo = await revertNotes(sql, xodo, pinned.lote, owner);
  assert.equal(undo.desfeitas, 1);
  assert.equal((await listMemory(sql, xodo, {})).notas[0].pinned, false);

  // A tela manda a nota inteira: fixada igual à atual não é fixar.
  const same = await editNote(sql, xodo, nota.n, { version: 3, texto: "Logo sempre no canto direito, em branco.", fixada: false }, member, NOW);
  assert.deepEqual([same.nota.content, same.nota.pinned], ["Logo sempre no canto direito, em branco.", false]);
  await assert.rejects(editNote(sql, xodo, nota.n, { version: 4, fixada: true }, member, NOW), status(403));
  await assert.rejects(editNote(sql, xodo, nota.n, { version: 4, fixada: false }, member, NOW), /Nada para mudar/);

  await createNote(sql, xodo, { texto: "Peças até dia 10.", topico: "campanha" }, member, NOW);
  await updateTopic(sql, xodo, "campanha", { titulo: "Campanha de verão" }, member);
  const [topicChange] = (await listMemoryChanges(sql, xodo, { limit: "1" })).mudancas;
  await assert.rejects(revertNotes(sql, xodo, topicChange.batch, owner), /nenhuma nota/);

  const first = await deleteNote(sql, xodo, nota.n, {}, member);
  assert.ok("lote" in first && first.lote);
  const again = await deleteNote(sql, xodo, nota.n, {}, member);
  assert.ok("lote" in again && again.lote === null, "já estava apagada: nada para desfazer");

  assert.throws(() => noteNumber.parse("99999999999"), ZodError, "#n acima de integer daria erro 500 no banco");
  await assert.rejects(editNote(sql, xodo, nota.n, { version: 99_999_999_999, texto: "x" }, member, NOW), ZodError);
});

test("diário com filtros (#n, execução) e página por before_id", async () => {
  const { agencyId, xodo } = await fresh();
  const run = await one<{ id: string }>(
    sql,
    `insert into xodo_runs (xodo_id, agency_id, trigger, provider, model) values ($1, $2, 'user', 'faux', 'faux-1') returning id`,
    [xodo.id, agencyId],
  );
  const a = await createNote(sql, xodo, { texto: "Fato A da equipe." }, member, NOW);
  await createNote(sql, xodo, { texto: "Fato B da equipe." }, member, NOW);
  await addItem(sql, mem(xodo), { content: "Fato C do xodó.", source: "xodo" }, { actor: "xodo", runId: run!.id });
  await editNote(sql, xodo, a.nota.n, { version: 1, texto: "Fato A corrigido." }, member, NOW);

  const page1 = await listMemoryChanges(sql, xodo, { limit: "2" });
  const ids1 = page1.mudancas.map((c) => c.id);
  assert.equal(ids1.length, 2);
  assert.ok(ids1.every((id) => typeof id === "number") && ids1[0] > ids1[1], "números, do mais novo para o mais antigo");
  assert.equal(page1.proximo, ids1[1]);
  const page2 = await listMemoryChanges(sql, xodo, { limit: "2", before_id: String(page1.proximo) });
  assert.equal(page2.mudancas.length, 2);
  assert.equal(page2.proximo, page2.mudancas[1].id);
  assert.ok(page2.mudancas.every((c) => c.id < ids1[1]));

  assert.equal((await listMemoryChanges(sql, xodo, { n: String(a.nota.n) })).mudancas.length, 2);
  const byRun = (await listMemoryChanges(sql, xodo, { run: run!.id })).mudancas;
  assert.deepEqual(byRun.map((c) => c.actor), ["xodo"]);
  await assert.rejects(listMemoryChanges(sql, xodo, { limit: "101" }), ZodError);
  await assert.rejects(listMemoryChanges(sql, xodo, { run: "x" }), ZodError);
});

test("tópicos: editar troca os apelidos e a busca acompanha; apagar arquiva as notas num lote que se desfaz", async () => {
  const { xodo } = await fresh();
  const n1 = await createNote(sql, xodo, { texto: "Desconto máximo de 30%.", topico: "Black Friday Acme", aliases: ["liquidacao"] }, member, NOW);
  const n2 = await createNote(sql, xodo, { texto: "Peças entregues até 10/11.", topico: "black-friday-acme" }, member, NOW);
  const n3 = await addItem(sql, mem(xodo), { content: "Banner novo na home.", topic: "black-friday-acme", source: "captura", status: "proposto" }, { actor: "captura" });

  assert.equal((await listMemory(sql, xodo, { q: "liquidacao" })).notas.length, 2);
  const updated = await updateTopic(
    sql,
    xodo,
    "black-friday-acme",
    { titulo: "BF da Acme", descricao: "Campanha de novembro", aliases: ["promo novembro", "senha: Abc@12345"] },
    member,
  );
  assert.deepEqual([updated.topico.title, updated.topico.description], ["BF da Acme", "Campanha de novembro"]);
  assert.equal(updated.topico.aliases.length, 2);
  assert.ok(updated.topico.aliases.includes("promo novembro") && !updated.topico.aliases.some((a) => a.includes("Abc@12345")));
  assert.equal((await listMemory(sql, xodo, { q: "liquidacao" })).notas.length, 0, "apelido tirado sai da busca");
  assert.equal((await listMemory(sql, xodo, { q: "promo" })).notas.length, 2, "apelido novo entra na busca");
  assert.equal((await listMemory(sql, xodo, { q: "bf" })).notas.length, 2, "título novo entra na busca");
  const [topicChange] = (await listMemoryChanges(sql, xodo, { limit: "1" })).mudancas;
  const titles = [topicChange.before, topicChange.after].map((t) => (t as { title: string }).title);
  assert.deepEqual([topicChange.op, topicChange.topic, ...titles], ["topico", "black-friday-acme", "Black Friday Acme", "BF da Acme"]);
  await assert.rejects(updateTopic(sql, xodo, "nao-existe", { titulo: "x" }, member), status(404));
  await assert.rejects(updateTopic(sql, xodo, "black-friday-acme", {}, member), /Nada para mudar/);
  await assert.rejects(updateTopic(sql, xodo, "black-friday-acme", { aliases: Array(13).fill("a") }, member), ZodError);

  const removed = await deleteTopic(sql, xodo, "black-friday-acme", member);
  assert.deepEqual(removed.arquivadas, [n1.nota.n, n2.nota.n, n3.item.n]);
  assert.equal(removed.removido, false, "o tópico fica enquanto houver nota apontando para ele");
  assert.equal((await listMemory(sql, xodo, { topico: "black-friday-acme" })).notas.length, 0);
  assert.equal((await listMemory(sql, xodo, { topico: "black-friday-acme", status: "arquivo" })).notas.length, 3);
  const listed = await listMemory(sql, xodo, {});
  assert.equal(listed.topicos[0].notes, 0);

  const undo = await revertNotes(sql, xodo, removed.lote!, member);
  assert.equal(undo.desfeitas, 3);
  const after = await listMemory(sql, xodo, { topico: "black-friday-acme", status: "todas" });
  assert.deepEqual(after.notas.map((n) => n.status), ["ativo", "ativo", "proposto"]);

  await upsertTopic(sql, mem(xodo), "vazio", { title: "Vazio" });
  const empty = await deleteTopic(sql, xodo, "vazio", member);
  assert.deepEqual([empty.arquivadas, empty.removido, empty.lote], [[], true, null]);
  assert.equal(await one(sql, `select 1 from xodo_memory_topics where xodo_id = $1 and slug = 'vazio'`, [xodo.id]), null);
  await assert.rejects(deleteTopic(sql, xodo, "vazio", member), status(404));
});

test("capturas com custo: soma só as chamadas daquela captura", async () => {
  const { agencyId, xodo } = await fresh();
  const done = await one<{ id: string }>(
    sql,
    `insert into xodo_memory_captures (xodo_id, agency_id, after_message_id, until_message_id, status, due_at, attempts, result, created_at, finished_at)
     values ($1, $2, 0, 10, 'feito', now(), 2, $3::jsonb, '2026-10-19T10:00:00Z', '2026-10-19T10:05:00Z') returning id`,
    [xodo.id, agencyId, JSON.stringify({
      propostos: 3,
      gravados: 2,
      status_notas: "ativo",
      notas: [1, 2],
      lote: randomUUID(),
      descartados: [{ texto: "Já tinha. senha: Abc@12345", motivo: "já está nas notas (#1)" }],
    })],
  );
  const pending = await one<{ id: string }>(
    sql,
    `insert into xodo_memory_captures (xodo_id, agency_id, after_message_id, until_message_id, due_at, created_at)
     values ($1, $2, 10, 14, now(), '2026-10-19T11:00:00Z') returning id`,
    [xodo.id, agencyId],
  );
  const usage = async (callId: string, purpose: string, usd: number, brl: number | null) =>
    sql.query(
      `insert into ai_usage (agency_id, xodo_id, provider, model, cost_usd, cost_source, cost_brl, call_id, day, purpose)
       values ($1, $2, 'faux', 'faux-1', $3, 'catalog', $4, $5, '2026-10-19', $6)`,
      [agencyId, xodo.id, usd, brl, callId, purpose],
    );
  await usage(`captura:${done!.id}:1:0:1`, "captura", 0.01, 0.055);
  await usage(`captura:${done!.id}:2:0:1`, "captura", 0.002, 0.011);
  await usage(`${randomUUID()}:0:0:1`, "execucao", 1, 5.5);
  await usage(`captura:${randomUUID()}:1:0:1`, "captura", 1, 5.5);

  const { capturas, proximo } = await listCaptures(sql, xodo, {});
  assert.deepEqual(capturas.map((c) => c.id), [pending!.id, done!.id], "mais nova primeiro");
  assert.equal(proximo, null);
  const [p, d] = capturas;
  assert.deepEqual([p.status, p.chamadas, p.custo_usd, p.custo_brl, p.propostos], ["pendente", 0, 0, null, 0]);
  assert.deepEqual([d.status, d.chamadas, d.propostos, d.gravados, d.notas, d.status_notas], ["feito", 2, 3, 2, [1, 2], "ativo"]);
  assert.ok(Math.abs(d.custo_usd - 0.012) < 1e-9);
  assert.ok(Math.abs(d.custo_brl! - 0.066) < 1e-9);
  assert.equal(d.descartados.length, 1);
  assert.ok(!d.descartados[0].texto.includes("Abc@12345"));
  assert.equal(d.created_at, "2026-10-19T10:00:00.000Z");

  assert.deepEqual((await listCaptures(sql, xodo, { status: "feito" })).capturas.map((c) => c.id), [done!.id]);
  const page1 = await listCaptures(sql, xodo, { limite: "1" });
  assert.equal(page1.proximo, "2026-10-19T11:00:00.000000Z", "cursor com microssegundos");
  assert.deepEqual((await listCaptures(sql, xodo, { limite: "1", antes: page1.proximo! })).capturas.map((c) => c.id), [done!.id]);
  await assert.rejects(listCaptures(sql, xodo, { status: "feita" }), ZodError);

  // O erro guardado pode trazer o que o provedor devolveu: a tela recebe sem segredo.
  await sql.query(`update xodo_memory_captures set status = 'falhou', error = $2 where id = $1`, [
    pending!.id,
    "provedor respondeu 401: chave sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 inválida",
  ]);
  const failed = (await listCaptures(sql, xodo, { status: "falhou" })).capturas[0];
  assert.ok(failed.erro && !failed.erro.includes("abcdefghijklmnop"), failed.erro ?? "");
});

test("exporta as notas ativas em markdown, uma por linha", async () => {
  const { agencyId, xodo } = await fresh({ name: "Pipoca" });
  const acme = await seedClient(sql, agencyId, "Acme");
  await createNote(sql, xodo, { texto: "Relatórios saem até o 5º dia útil.\nSempre em PDF.", valido_ate: "2099-12-31" }, member, NOW);
  await createNote(sql, xodo, { texto: "Contato principal é a Ana.", cliente_id: acme }, member, NOW);
  await addItem(sql, mem(xodo), { content: "Desconto máximo de 30%.", topic: "Black Friday Acme", source: "xodo" }, { actor: "xodo" });
  await addItem(sql, mem(xodo), { content: "Proposta ainda não aceita.", source: "captura", status: "proposto" }, { actor: "captura" });
  const gone = await createNote(sql, xodo, { texto: "Nota apagada." }, member, NOW);
  await deleteNote(sql, xodo, gone.nota.n, {}, member);

  const { filename, markdown } = await exportMarkdown(sql, xodo, NOW);
  assert.equal(filename, "memoria-pipoca-2026-10-19.md");
  assert.match(markdown, /^# Memória de Pipoca\n\nExportada em 2026-10-19 · 3 notas ativas\.\n/);
  assert.match(markdown, /\n## Núcleo\n\n- \d{4}-\d{2}-\d{2} · equipe · Relatórios saem até o 5º dia útil\. Sempre em PDF\. · até 2099-12-31\n/);
  assert.match(markdown, /\n## Cliente: Acme\n\n- \d{4}-\d{2}-\d{2} · equipe · Contato principal é a Ana\.\n/);
  assert.match(markdown, /\n## Tópico: Black Friday Acme \(black-friday-acme\)\n\n- \d{4}-\d{2}-\d{2} · xodo · Desconto máximo de 30%\.\n$/);
  assert.ok(!markdown.includes("Proposta ainda") && !markdown.includes("Nota apagada"));
  assert.ok(markdown.indexOf("## Núcleo") < markdown.indexOf("## Cliente") && markdown.indexOf("## Cliente") < markdown.indexOf("## Tópico"));
});

test("ajustes da memória pelo PATCH do xodó: só os enviados mudam; núcleo entre 2000 e 16000", async () => {
  const { agencyId, xodo } = await fresh();
  const a = await updateXodo(sql, llm, agencyId, xodo.id, { memory_capture_channels: true, memory_core_chars: 12000 });
  assert.deepEqual(
    [a.memory_enabled, a.memory_capture, a.memory_capture_channels, a.memory_tidy, Number(a.memory_core_chars), a.name],
    [true, true, true, true, 12000, xodo.name],
  );
  const b = await updateXodo(sql, llm, agencyId, xodo.id, { memory_tidy: false, memory_enabled: false, memory_capture: false });
  assert.deepEqual(
    [b.memory_enabled, b.memory_capture, b.memory_capture_channels, b.memory_tidy, Number(b.memory_core_chars)],
    [false, false, true, false, 12000],
    "o que não veio no PATCH fica como estava",
  );
  const c = await updateXodo(sql, llm, agencyId, xodo.id, { name: "Bolota" });
  assert.deepEqual([c.name, c.memory_enabled, Number(c.memory_core_chars)], ["Bolota", false, 12000]);

  for (const bad of [{ memory_core_chars: 1999 }, { memory_core_chars: 16001 }, { memory_core_chars: 2500.5 }, { memory_enabled: "sim" }]) {
    await assert.rejects(updateXodo(sql, llm, agencyId, xodo.id, bad), ZodError, JSON.stringify(bad));
  }
  const reloaded = await loadXodo(sql, xodo.id);
  assert.deepEqual((await listMemory(sql, reloaded, {})).ajustes, {
    memory_enabled: false,
    memory_capture: false,
    memory_capture_channels: true,
    memory_tidy: false,
    memory_core_chars: 12000,
    memory_tidied_on: null,
  });
  assert.equal((await listMemory(sql, reloaded, {})).medidor.limite, 12000);
});
