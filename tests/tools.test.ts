import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOLS, toolJsonSchema } from "../src/lib/xodos/tools";

test("todo esquema enviado ao modelo é um objeto enxuto, sem $schema nem regex", () => {
  for (const tool of TOOLS) {
    const schema = toolJsonSchema(tool);
    assert.equal(schema.type, "object", tool.name);
    const text = JSON.stringify(schema);
    assert.ok(!text.includes('"pattern"') && !text.includes("$schema"), tool.name);
  }
});

test("só publicar relatório vai para o cliente", () => {
  assert.deepEqual(TOOLS.filter((t) => t.category === "cliente").map((t) => t.name), ["publicar_relatorio"]);
});
