import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLE_INFO } from "../src/lib/xodos/persona";
import { TOOLS, TOOLS_BY_NAME, toolJsonSchema } from "../src/lib/xodos/tools";

test("todo esquema enviado ao modelo é um objeto enxuto, sem $schema nem regex", () => {
  for (const tool of TOOLS) {
    const schema = toolJsonSchema(tool);
    assert.equal(schema.type, "object", tool.name);
    const text = JSON.stringify(schema);
    assert.ok(!text.includes('"pattern"') && !text.includes("$schema"), tool.name);
  }
});

test("as ferramentas de cada função existem e só Relatórios publica para o cliente", () => {
  for (const [role, info] of Object.entries(ROLE_INFO)) {
    for (const name of info.tools) assert.ok(TOOLS_BY_NAME.has(name), `${role}: ${name}`);
    const publishes = info.tools.some((name) => TOOLS_BY_NAME.get(name)!.category === "cliente");
    assert.equal(publishes, role === "relatorios", role);
  }
});
