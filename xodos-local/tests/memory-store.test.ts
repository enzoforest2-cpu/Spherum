import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { fromPGlite, one, type Sql } from "../src/xodos/db";
import { factIdentity, slugTopic } from "../src/xodos/memory/entries";
import {
  addItem,
  coreUsage,
  editItem,
  forgetItem,
  listChanges,
  listItems,
  MemoryConflict,
  purgeItem,
  revertBatch,
  supersedeItem,
  type MemoryXodo,
} from "../src/xodos/memory/store";
import { createTestDb, seedAgency, seedClient, seedXodo } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

const team = { actor: "equipe" as const };
const bot = { actor: "xodo" as const };

async function xodoWith(coreChars = 8000): Promise<MemoryXodo & { agencyId: string }> {
  const { agencyId } = await seedAgency(sql);
  const x = await seedXodo(sql, agencyId, { memory_core_chars: coreChars });
  return { id: x.id, agency_id: agencyId, memory_core_chars: coreChars, agencyId };
}

test("identidade e slug: mesmo fato com outra caixa, acento ou ponto não duplica; igual ao SQL", async () => {
  assert.equal(factIdentity("- Relatórios saem até o 5º dia útil."), "relatorios saem ate o 5º dia util");
  assert.equal(factIdentity("relatorios   saem ate o 5º DIA ÚTIL"), "relatorios saem ate o 5º dia util");
  assert.equal(slugTopic("Black Friday da Acme!"), "black-friday-da-acme");
  assert.equal(slugTopic("Núcleo"), null, "nome reservado");
  for (const text of ["  1) Ação de Natal; ", "Ç ÃÉ", "- texto  com\tespaços."]) {
    const row = await one<{ id: string }>(sql, `select public.xodo_fact_identity($1) as id`, [text]);
    assert.equal(row!.id, factIdentity(text), text);
  }
});

test("acrescenta com número, não duplica e limpa dados sensíveis antes do limite", async () => {
  const x = await xodoWith();
  const a = await addItem(sql, x, { content: "- A Loja Verano prefere relatório às segundas.", source: "xodo" }, bot);
  assert.equal(a.item.n, 1);
  assert.equal(a.item.content, "A Loja Verano prefere relatório às segundas.");
  const again = await addItem(sql, x, { content: "a loja verano prefere relatório às segundas", source: "captura" }, { actor: "captura" });
  assert.deepEqual([again.created, again.item.n], [false, 1]);

  const secret = await addItem(sql, x, { content: "Senha do Instagram da Verano: senha: Abc@123", source: "xodo" }, bot);
  assert.equal(secret.removed, 1);
  assert.ok(!secret.item.content.includes("Abc@123"));
  // 1990 caracteres com um token longo: o limite vale depois da limpeza.
  const long = `${"x".repeat(900)} sk-ant-${"a".repeat(1000)}`;
  const ok = await addItem(sql, x, { content: long, source: "xodo" }, bot);
  assert.ok(ok.item.content.length <= 1000);
  await assert.rejects(addItem(sql, x, { content: "y".repeat(1001), source: "xodo" }, bot), /Nota longa demais/);

  // Números seguidos mesmo com gravações ao mesmo tempo.
  const many = await Promise.all(Array.from({ length: 5 }, (_, i) => addItem(sql, x, { content: `Fato número ${i}`, source: "xodo" }, bot)));
  assert.deepEqual(many.map((m) => m.item.n).sort((p, q) => p - q), [4, 5, 6, 7, 8]);
});

test("tópicos: cria com apelidos somados e a busca acha pelo título ou apelido", async () => {
  const x = await xodoWith();
  await addItem(sql, x, { content: "Desconto máximo de 30% na BF.", topic: "Black Friday Acme", aliases: ["bf", "promo novembro"], source: "xodo" }, bot);
  await addItem(sql, x, { content: "Peças entregues até 10/11.", topic: "black-friday-acme", aliases: ["novembro"], source: "xodo" }, bot);
  const t = await one<{ title: string; aliases: string[] }>(sql, `select title, aliases from xodo_memory_topics where xodo_id = $1`, [x.id]);
  assert.equal(t!.title, "Black Friday Acme");
  assert.deepEqual([...t!.aliases].sort(), ["bf", "novembro", "promo novembro"]);
  assert.equal((await listItems(sql, x, { q: "relatorio" })).length, 0);
  assert.equal((await listItems(sql, x, { q: "pecas" })).length, 1, "sem acento acha com acento");
  assert.equal((await listItems(sql, x, { topic: null })).length, 0, "nada no núcleo");
});

test("núcleo cheio arquiva as mais antigas, mas não fixadas, da equipe, de saúde/compliance nem a nova", async () => {
  const x = await xodoWith(2000);
  const fill = (text: string, extra: Partial<Parameters<typeof addItem>[2]> = {}) =>
    addItem(sql, x, { content: text.padEnd(450, "."), source: "xodo", ...extra }, bot);
  const pinned = await fill("Fixada pela equipe", { pinned: true, source: "equipe" });
  const health = await fill("Cliente Acme: alergia a amendoim, nunca usar em peças");
  const old = await fill("Nota antiga comum");
  await fill("Nota do meio");
  const result = await fill("Nota nova que estoura o núcleo");
  assert.deepEqual(result.archived.map((a) => a.n), [old.item.n]);
  const statuses = new Map((await listItems(sql, x, { status: "todas" })).map((i) => [i.n, i.status]));
  assert.equal(statuses.get(pinned.item.n), "ativo");
  assert.equal(statuses.get(health.item.n), "ativo");
  assert.equal(statuses.get(result.item.n), "ativo");
  const usage = await coreUsage(sql, x);
  assert.ok(usage.nucleo_chars <= 2000);
});

test("edição confere a versão (409 com a atual); substituir e esquecer ficam no diário", async () => {
  const x = await xodoWith();
  const a = await addItem(sql, x, { content: "Relatório mensal sai dia 5.", source: "equipe" }, team);
  const edited = await editItem(sql, x, a.item.n, { content: "Relatório mensal sai no 5º dia útil." }, a.item.version, team);
  assert.equal(edited.item.version, 2);
  await assert.rejects(editItem(sql, x, a.item.n, { pinned: true }, 1, team), (e: unknown) => e instanceof MemoryConflict && e.current.version === 2);

  const sup = await supersedeItem(sql, x, a.item.n, { content: "Relatório mensal sai no 3º dia útil." }, team);
  assert.equal(sup.old.status, "substituido");
  assert.equal(sup.old.superseded_by, sup.item.id);
  const gone = await forgetItem(sql, x, sup.item.n, { ...team, reason: "não vale mais; token: abc123" });
  assert.equal(gone.item.status, "apagado");
  const changes = await listChanges(sql, x);
  assert.deepEqual(changes.map((c) => c.op).slice(0, 4), ["apagar", "substituir", "criar", "editar"]);
  assert.equal((changes[0] as { reason: string }).reason, "não vale mais; token: [removido]");
});

test("desfazer um lote volta tudo, e o desfazer também se desfaz; nota mexida depois bloqueia", async () => {
  const x = await xodoWith();
  const a = await addItem(sql, x, { content: "A Acme fecha o mês no dia 25.", source: "xodo" }, bot);
  const sup = await supersedeItem(sql, x, a.item.n, { content: "A Acme fecha o mês no dia 28." }, bot);
  const undo = await revertBatch(sql, x, sup.batch, team);
  assert.equal(undo.reverted, 2);
  let items = await listItems(sql, x, { status: "todas" });
  assert.equal(items.find((i) => i.n === a.item.n)!.status, "ativo");
  assert.equal(items.find((i) => i.n === sup.item.n)!.status, "apagado");

  await revertBatch(sql, x, undo.batch, team);
  items = await listItems(sql, x, { status: "todas" });
  assert.equal(items.find((i) => i.n === a.item.n)!.status, "substituido");
  assert.equal(items.find((i) => i.n === sup.item.n)!.status, "ativo");

  // Mexeu depois do lote: não desfaz por cima.
  const b = await addItem(sql, x, { content: "A Beta prefere WhatsApp.", source: "xodo" }, bot);
  await editItem(sql, x, b.item.n, { content: "A Beta prefere e-mail." }, null, team);
  await assert.rejects(revertBatch(sql, x, b.batch, team), /mudou depois/);
});

test("exclusão definitiva tira a nota e o texto dela do diário", async () => {
  const x = await xodoWith();
  const a = await addItem(sql, x, { content: "Telefone pessoal da Ana: (11) 99999-0000", source: "xodo" }, bot);
  await purgeItem(sql, x, a.item.n, team);
  assert.equal((await listItems(sql, x, { status: "todas" })).length, 0);
  const left = await sql.query<{ before: unknown; after: unknown; op: string }>(
    `select before, after, op from xodo_memory_changes where xodo_id = $1 order by id`,
    [x.id],
  );
  assert.ok(left.every((c) => c.before === null && c.after === null));
  assert.equal(left.at(-1)!.op, "expurgar");
});

test("nota de outra agência não é lida nem alterada; cliente de outra agência é recusado", async () => {
  const a = await xodoWith();
  const b = await seedAgency(sql);
  const note = await addItem(sql, a, { content: "Segredo comercial da A.", source: "xodo" }, bot);
  const fake = { id: a.id, agency_id: b.agencyId, memory_core_chars: 8000 };
  await assert.rejects(editItem(sql, fake, note.item.n, { content: "x" }, null, team), /não encontrada/);
  assert.equal((await listItems(sql, fake)).length, 0);
  const foreign = await seedClient(sql, b.agencyId, "Cliente da B");
  await assert.rejects(addItem(sql, a, { content: "Fato", clientId: foreign, source: "xodo" }, bot), /não pertence/);
});

test("a migração transforma o texto antigo em notas do núcleo, uma por linha", async () => {
  const db = new PGlite();
  await db.exec(readFileSync("db/foundation.sql", "utf8"));
  const files = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
  const memory = files.find((f) => f.includes("xodo_memory"))!;
  for (const f of files.filter((f) => f < memory)) await db.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  const old = fromPGlite(db);
  const { agencyId } = await seedAgency(old);
  const x = await seedXodo(old, agencyId);
  await old.query(`insert into xodo_memories (xodo_id, agency_id, content) values ($1, $2, $3)`, [
    x.id,
    agencyId,
    `- Relatórios saem até o dia 5.\n\n- Relatórios saem até o dia 5\n${"z".repeat(1500)}\n- Acme prefere vídeos curtos.`,
  ]);
  for (const f of files.filter((f) => f >= memory)) await db.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  const items = await old.query<{ n: number; content: string; source: string }>(
    `select n, content, source from xodo_memory_items where xodo_id = $1 order by n`,
    [x.id],
  );
  assert.deepEqual(
    items.map((i) => [i.n, i.content.slice(0, 30), i.source]),
    [
      [1, "Relatórios saem até o dia 5.", "importacao"],
      [2, "z".repeat(30), "importacao"],
      [3, "z".repeat(30), "importacao"],
      [4, "Acme prefere vídeos curtos.", "importacao"],
    ],
  );
  const journal = await old.query(`select op from xodo_memory_changes where xodo_id = $1`, [x.id]);
  assert.equal(journal.length, 4);
  await assert.rejects(old.query(`select 1 from xodo_memories`), /does not exist/);
});
