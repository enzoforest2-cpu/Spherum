import assert from "node:assert/strict";
import { test } from "node:test";
import { MEMORY_TOOLS } from "../src/lib/xodos/memory/tools";
import { xodoPatch } from "../src/lib/xodos/manage";
import { STEP_RESERVE_MS, SLICE_MS } from "../src/lib/xodos/runner";
import type { ToolContext } from "../src/lib/xodos/tools";

/** Regressões da revisão de 24/10 no motor dos xodós (as que não precisam de banco). */

test("memória: depois de ler conteúdo de fora, lembrar/corrigir/esquecer pedem aprovação", async () => {
  const base = { trigger: "user", apps: null } as unknown as ToolContext;
  for (const name of ["lembrar", "corrigir_memoria", "esquecer"]) {
    const tool = MEMORY_TOOLS.find((t) => t.name === name)!;
    assert.ok(tool.mustAsk, `${name} tem mustAsk`);
    const why = await tool.mustAsk!({ ...base, tainted: true }, { n: null, texto: "x" });
    assert.match(String(why), /conteúdo de fora/);
  }
  // Sem leitura externa e sem nota da equipe, lembrar segue a autonomia normal (nada a consultar no banco).
  const lembrar = MEMORY_TOOLS.find((t) => t.name === "lembrar")!;
  assert.equal(await lembrar.mustAsk!({ ...base, tainted: false }, { texto: "x" }), null);
});

test("limites de campanha entram no ajuste do xodó; a fatia reserva tempo para o passo", () => {
  const p = xodoPatch.parse({ campaign_max_change_pct: 35, campaign_max_daily_brl: 500 });
  assert.deepEqual([p.campaign_max_change_pct, p.campaign_max_daily_brl], [35, 500]);
  assert.throws(() => xodoPatch.parse({ campaign_max_change_pct: 0 }));
  assert.ok(STEP_RESERVE_MS > 0 && STEP_RESERVE_MS < SLICE_MS);
});
