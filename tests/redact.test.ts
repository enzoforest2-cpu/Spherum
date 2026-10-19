import assert from "node:assert/strict";
import { test } from "node:test";
import { redactDeep, redactSecrets } from "../src/lib/xodos/redact";

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
  const { text, removed } = redactSecrets(input);
  assert.ok(removed >= 7);
  for (const secret of ["sk-ant-api03", "sk-proj-", "AIzaSy", "eyJhbGci", "123.456.789-09", "4111 1111", "hunter2"]) {
    assert.ok(!text.includes(secret), `vazou ${secret}`);
  }
  assert.match(text, /senha: \[removido\]/);
  assert.deepEqual(redactSecrets(text), { text, removed: 0 }, "limpar de novo não muda nada");
});

test("não mexe em IDs de campanha, valores e contatos", () => {
  const input = "Campanha Meta 23851234567890123, Google Ads 1234567890, CPL alvo R$ 25,00, contato ana@loja.com.br";
  assert.deepEqual(redactSecrets(input), { text: input, removed: 0 });
});

test("limpa todos os textos de um objeto, mantendo a forma", () => {
  const { value, removed } = redactDeep({ texto: "token: abc123", lista: ["ok", "senha=xyz"], n: 3, nada: null });
  assert.deepEqual(value, { texto: "token: [removido]", lista: ["ok", "senha=[removido]"], n: 3, nada: null });
  assert.equal(removed, 2);
});
