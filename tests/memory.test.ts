import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMemory, MEMORY_MAX_CHARS, redactSecrets, restoreMemory, saveMemory } from "../src/lib/xodos/memory";
import { createTestDb, seedAgency, seedXodo } from "./helpers";

test("apaga chaves, tokens, CPF, cartão e senhas rotuladas", () => {
  const input = [
    "Anthropic sk-ant-api03-abcdefghijklmnop",
    "OpenAI sk-proj-ABCDEFGHIJKLMNOPQRST",
    "Google AIzaSyA1234567890abcdefghijklmnopqrstu",
    "jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
    "CPF 123.456.789-09",
    "cartão 4111 1111 1111 1111",
    "senha: hunter2",
  ].join("\n");
  const { text, redacted } = redactSecrets(input);
  assert.equal(redacted, true);
  for (const secret of ["sk-ant-api03", "sk-proj-", "AIzaSy", "eyJhbGci", "123.456.789-09", "4111 1111", "hunter2"]) {
    assert.ok(!text.includes(secret), `vazou ${secret}`);
  }
  assert.match(text, /senha: \[removido\]/);
});

test("não mexe em IDs de campanha, valores e contatos", () => {
  const input = "Campanha Meta 23851234567890123, Google Ads 1234567890, CPL alvo R$ 25,00, contato ana@loja.com.br";
  assert.deepEqual(redactSecrets(input), { text: input, redacted: false });
});

test("guarda versões, limpa segredos e permite desfazer", async () => {
  const { sql } = await createTestDb();
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId);

  await saveMemory(sql, agencyId, xodo.id, "Loja Verano prefere relatório às segundas.", "primeira nota");
  const second = await saveMemory(sql, agencyId, xodo.id, "Loja Verano: segundas. token: abc123", "adicionou token");
  assert.equal(second.redacted, true);
  assert.equal(await loadMemory(sql, agencyId, xodo.id), "Loja Verano: segundas. token: [removido]");

  const revisions = await sql.query<{ id: number; content: string }>(
    `select id, content from xodo_memory_revisions where xodo_id = $1 order by id`,
    [xodo.id],
  );
  assert.deepEqual(revisions.map((r) => r.content), ["", "Loja Verano prefere relatório às segundas."]);
  await restoreMemory(sql, agencyId, xodo.id, revisions[1].id);
  assert.equal(await loadMemory(sql, agencyId, xodo.id), "Loja Verano prefere relatório às segundas.");

  await assert.rejects(saveMemory(sql, agencyId, xodo.id, "x".repeat(MEMORY_MAX_CHARS + 1), "grande"), /passou de/);
});

test("memória de um xodó não é lida nem restaurada por outra agência", async () => {
  const { sql } = await createTestDb();
  const a = await seedAgency(sql, "A");
  const b = await seedAgency(sql, "B");
  const xodo = await seedXodo(sql, a.agencyId);
  await saveMemory(sql, a.agencyId, xodo.id, "segredo comercial da A", "nota");
  assert.equal(await loadMemory(sql, b.agencyId, xodo.id), "");
  const [rev] = await sql.query<{ id: number }>(`select id from xodo_memory_revisions where xodo_id = $1`, [xodo.id]);
  await assert.rejects(restoreMemory(sql, b.agencyId, xodo.id, rev.id), /não encontrada/);
});
