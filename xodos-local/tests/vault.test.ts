import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialAad, lastFour, openSecret, sealSecret } from "../src/xodos/vault";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
const AAD = credentialAad("agencia-1", "cred-1");

test("cifra e decifra a chave da agência", async () => {
  const sealed = await sealSecret("sk-ant-api-123456789", AAD, MASTER);
  assert.ok(sealed.startsWith("v1:"));
  assert.ok(!sealed.includes("sk-ant"));
  assert.equal(await openSecret(sealed, AAD, MASTER), "sk-ant-api-123456789");
});

test("cada gravação usa sal e IV novos", async () => {
  const a = await sealSecret("mesma-chave", AAD, MASTER);
  const b = await sealSecret("mesma-chave", AAD, MASTER);
  assert.notEqual(a, b);
});

test("não decifra em outra linha, com outra chave mestra ou adulterado", async () => {
  const sealed = await sealSecret("sk-segredo", AAD, MASTER);
  await assert.rejects(openSecret(sealed, credentialAad("agencia-2", "cred-1"), MASTER));
  await assert.rejects(openSecret(sealed, AAD, `${MASTER}-outra`));
  const raw = Buffer.from(sealed.slice(3), "base64");
  raw[raw.length - 1] ^= 1;
  await assert.rejects(openSecret(`v1:${raw.toString("base64")}`, AAD, MASTER));
  await assert.rejects(openSecret("formato-antigo", AAD, MASTER), /formato desconhecido/);
});

test("mostra só os 4 últimos caracteres", () => {
  assert.equal(lastFour("  sk-ant-abcdWXYZ  "), "WXYZ");
});
