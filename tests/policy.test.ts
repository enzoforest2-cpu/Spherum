import assert from "node:assert/strict";
import { test } from "node:test";
import { canAlwaysAllow, decideApproval, type ApprovalRule } from "../src/lib/xodos/policy";

const allowTool = (name: string): ApprovalRule => ({ effect: "always_allow", match_kind: "tool", match_value: name });
const requireTool = (name: string): ApprovalRule => ({ effect: "require_approval", match_kind: "tool", match_value: name });
const requireCategory = (c: string): ApprovalRule => ({ effect: "require_approval", match_kind: "category", match_value: c });
const allowCategory = (c: string): ApprovalRule => ({ effect: "always_allow", match_kind: "category", match_value: c });

test("leitura e trabalho interno rodam direto por padrão", () => {
  for (const category of ["leitura", "rascunho", "memoria", "equipe"] as const) {
    assert.deepEqual(decideApproval({ toolName: "x", category, rules: [] }), { decision: "allow", source: "default" });
  }
});

test("campanha pede aprovação por padrão, mas a agência pode liberar", () => {
  assert.equal(decideApproval({ toolName: "ajustar_orcamento", category: "campanha", rules: [] }).decision, "ask");
  assert.deepEqual(decideApproval({ toolName: "ajustar_orcamento", category: "campanha", rules: [allowTool("ajustar_orcamento")] }), {
    decision: "allow",
    source: "always_allow",
  });
});

test("o que vai para o cliente sempre pede aprovação, mesmo com regra de permitir", () => {
  const result = decideApproval({
    toolName: "publicar_relatorio",
    category: "cliente",
    rules: [allowTool("publicar_relatorio"), allowCategory("cliente")],
  });
  assert.deepEqual(result, { decision: "ask", source: "floor" });
  assert.equal(canAlwaysAllow("cliente"), false);
  assert.equal(canAlwaysAllow("campanha"), true);
});

test("exigir aprovação vence permitir, seja qual for a especificidade", () => {
  // Regra larga da agência (categoria) contra regra estreita do xodó (ferramenta).
  const rules = [requireCategory("rascunho"), allowTool("criar_rascunho_relatorio")];
  assert.deepEqual(decideApproval({ toolName: "criar_rascunho_relatorio", category: "rascunho", rules }), {
    decision: "ask",
    source: "require_approval",
  });
  // E o contrário também.
  const reversed = [allowCategory("rascunho"), requireTool("criar_rascunho_relatorio")];
  assert.equal(decideApproval({ toolName: "criar_rascunho_relatorio", category: "rascunho", rules: reversed }).decision, "ask");
});

test("regras de outras ferramentas e categorias não interferem", () => {
  const rules = [requireTool("publicar_relatorio"), requireCategory("campanha")];
  assert.equal(decideApproval({ toolName: "consultar_metricas", category: "leitura", rules }).decision, "allow");
});
