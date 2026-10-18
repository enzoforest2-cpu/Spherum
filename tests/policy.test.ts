import assert from "node:assert/strict";
import { test } from "node:test";
import { canAlwaysAllow, decideApproval, type ApprovalRule, type Category } from "../src/lib/xodos/policy";
import type { Autonomy } from "../src/lib/xodos/types";

const allowTool = (name: string): ApprovalRule => ({ effect: "always_allow", match_kind: "tool", match_value: name });
const requireTool = (name: string): ApprovalRule => ({ effect: "require_approval", match_kind: "tool", match_value: name });
const requireCategory = (c: string): ApprovalRule => ({ effect: "require_approval", match_kind: "category", match_value: c });
const allowCategory = (c: string): ApprovalRule => ({ effect: "always_allow", match_kind: "category", match_value: c });

const decide = (category: Category, autonomy: Autonomy, rules: ApprovalRule[] = [], toolName = "x") =>
  decideApproval({ toolName, category, rules, autonomy }).decision;

test("autonomia escolhida na criação define o padrão", () => {
  const ask = "ask" as const;
  const allow = "allow" as const;
  const table: Record<Autonomy, Record<Category, "allow" | "ask">> = {
    sempre_pergunta: { leitura: allow, rascunho: ask, memoria: ask, equipe: ask, alteracao: ask, envio: ask, exclusao: ask, pagamento: ask, campanha: ask, cliente: ask },
    pergunta_no_que_importa: { leitura: allow, rascunho: allow, memoria: allow, equipe: allow, alteracao: allow, envio: ask, exclusao: ask, pagamento: ask, campanha: ask, cliente: ask },
    age_sozinho: { leitura: allow, rascunho: allow, memoria: allow, equipe: allow, alteracao: allow, envio: allow, exclusao: allow, pagamento: allow, campanha: allow, cliente: ask },
  };
  for (const [autonomy, row] of Object.entries(table) as [Autonomy, Record<Category, string>][]) {
    for (const [category, expected] of Object.entries(row) as [Category, string][]) {
      assert.equal(decide(category, autonomy), expected, `${autonomy} / ${category}`);
    }
  }
});

test("o que vai para o cliente sempre pede aprovação, mesmo agindo sozinho e com regra de permitir", () => {
  const result = decideApproval({
    toolName: "publicar_relatorio",
    category: "cliente",
    rules: [allowTool("publicar_relatorio"), allowCategory("cliente")],
    autonomy: "age_sozinho",
  });
  assert.deepEqual(result, { decision: "ask", source: "floor" });
  assert.equal(canAlwaysAllow("cliente"), false);
  assert.equal(canAlwaysAllow("campanha"), true);
});

test("regra de permitir libera uma ferramenta mesmo em quem sempre pergunta", () => {
  assert.deepEqual(
    decideApproval({ toolName: "avisar_equipe", category: "equipe", rules: [allowTool("avisar_equipe")], autonomy: "sempre_pergunta" }),
    { decision: "allow", source: "always_allow" },
  );
});

test("exigir aprovação vence permitir e vence a autonomia", () => {
  // Regra larga da agência (categoria) contra regra estreita do xodó (ferramenta).
  const rules = [requireCategory("rascunho"), allowTool("criar_rascunho_relatorio")];
  assert.deepEqual(decideApproval({ toolName: "criar_rascunho_relatorio", category: "rascunho", rules, autonomy: "age_sozinho" }), {
    decision: "ask",
    source: "require_approval",
  });
  // E o contrário também.
  const reversed = [allowCategory("rascunho"), requireTool("criar_rascunho_relatorio")];
  assert.equal(decide("rascunho", "age_sozinho", reversed, "criar_rascunho_relatorio"), "ask");
});

test("regras de outras ferramentas e categorias não interferem", () => {
  const rules = [requireTool("publicar_relatorio"), requireCategory("campanha")];
  assert.equal(decide("leitura", "pergunta_no_que_importa", rules, "consultar_metricas"), "allow");
});

test("teto do gatilho: pergunta acima do teto mesmo com 'sempre permitir'; 'exigir' e o piso continuam na frente", () => {
  const allowAll: ApprovalRule[] = [{ effect: "always_allow", match_kind: "category", match_value: "envio" }];
  assert.deepEqual(decideApproval({ toolName: "enviar_email", category: "envio", rules: allowAll, autonomy: "age_sozinho", cap: "pergunta_no_que_importa" }), {
    decision: "ask",
    source: "cap",
  });
  assert.deepEqual(decideApproval({ toolName: "enviar_email", category: "envio", rules: allowAll, autonomy: "age_sozinho", cap: "age_sozinho" }), {
    decision: "allow",
    source: "always_allow",
  });
  assert.deepEqual(decideApproval({ toolName: "x", category: "alteracao", rules: [], autonomy: "age_sozinho", cap: "pergunta_no_que_importa" }), {
    decision: "allow",
    source: "autonomy",
  });
  const requireRule: ApprovalRule[] = [{ effect: "require_approval", match_kind: "tool", match_value: "enviar_email" }];
  assert.equal(decideApproval({ toolName: "enviar_email", category: "envio", rules: requireRule, autonomy: "age_sozinho", cap: "sempre_pergunta" }).source, "require_approval");
});
