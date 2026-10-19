import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, score, type AuditInput, type CampaignWindow } from "../src/lib/integrations/ads/audit";
import { ADS_TOOLS } from "../src/lib/integrations/ads/tools";
import { buildSystemPrompt } from "../src/lib/xodos/persona";
import type { Xodo } from "../src/lib/xodos/types";

const camp = (id: string, spend: number, results: number, impressions = 10_000, clicks = 200): CampaignWindow => ({
  id,
  name: `Campanha ${id}`,
  spend,
  results,
  impressions,
  clicks,
});

function input(over: Partial<AuditInput> = {}): AuditInput {
  return {
    platform: "meta",
    dias: 14,
    lastSyncedAt: new Date("2026-10-19T06:00:00Z"),
    lastSyncError: null,
    now: new Date("2026-10-19T12:00:00Z"),
    lastDataDay: "2026-10-18",
    windowEnd: "2026-10-18",
    current: [camp("a", 1000, 40), camp("b", 500, 20)],
    previous: [camp("a", 900, 40), camp("b", 500, 22)],
    avgSpend7: new Map([["a", 70], ["b", 36]]),
    spend3: new Map([["a", 200], ["b", 100]]),
    live: [
      { id: "a", name: "Campanha a", status: "ativa", dailyBudget: 75 },
      { id: "b", name: "Campanha b", status: "ativa", dailyBudget: 40 },
    ],
    ...over,
  };
}

const state = (checks: ReturnType<typeof evaluate>, id: string) => checks.find((c) => c.id === id)?.estado;

test("conta saudável: tudo ok, nota 100 com cobertura total", () => {
  const checks = evaluate(input());
  assert.ok(checks.filter((c) => c.severidade !== "info").every((c) => c.estado === "ok" || c.estado === "nao_se_aplica"), JSON.stringify(checks));
  assert.deepEqual(score(checks), { saude: 100, cobertura: 100, situacao: "avaliada" });
});

test("rastreio parado, gasto sem resultado, custo subindo e CTR caindo viram falha", () => {
  const stopped = evaluate(input({ current: [camp("a", 1000, 0), camp("b", 500, 0)] }));
  assert.equal(state(stopped, "rastreio_parou"), "falha");
  assert.equal(state(stopped, "gasto_sem_resultado"), "falha");
  assert.equal(state(stopped, "custo_por_resultado"), "sem_dados", "sem resultados não compara custo");

  const worse = evaluate(input({ current: [camp("a", 2000, 40, 10_000, 100), camp("b", 1000, 20, 10_000, 100)] }));
  assert.equal(state(worse, "custo_por_resultado"), "falha");
  assert.equal(state(worse, "ctr"), "falha");
  const s = score(worse);
  assert.ok(s.saude! < 100 && s.cobertura === 100);
});

test("número pequeno não vira conclusão: poucos resultados e poucas impressões ficam sem dados", () => {
  const small = evaluate(input({ current: [camp("a", 100, 3, 800, 10)], previous: [camp("a", 90, 4, 900, 12)] }));
  assert.equal(state(small, "custo_por_resultado"), "sem_dados");
  assert.equal(state(small, "ctr"), "sem_dados");
  assert.equal(state(small, "rastreio_parou"), "nao_se_aplica");
  const noTracking = evaluate(input({ current: [camp("a", 500, 0)], previous: [camp("a", 500, 0)] }));
  assert.equal(state(noTracking, "rastreio_parou"), "sem_dados");
  assert.equal(state(noTracking, "gasto_sem_resultado"), "sem_dados");
});

test("dados velhos e sincronização com erro; sem campanhas ao vivo, ritmo fica sem dados", () => {
  const stale = evaluate(input({ lastSyncedAt: new Date("2026-10-10T00:00:00Z"), lastDataDay: "2026-10-10", live: null }));
  assert.equal(state(stale, "dados_atualizados"), "falha");
  assert.equal(state(stale, "metricas_recentes"), "falha");
  assert.equal(state(stale, "ritmo_verba"), "sem_dados");
  const broken = evaluate(input({ lastSyncError: "token vencido" }));
  assert.match(broken.find((c) => c.id === "dados_atualizados")!.detalhe, /token vencido/);
  // Muitas verificações sem dados: nota não aparece.
  const thin = score(evaluate(input({ live: null, current: [camp("a", 10, 1, 100, 1)], previous: [camp("a", 10, 1, 100, 1)] })));
  assert.equal(thin.situacao === "avaliada", false);
});

test("ritmo da verba e campanha ativa sem entrega", () => {
  const checks = evaluate(
    input({
      avgSpend7: new Map([["a", 120], ["b", 10]]),
      spend3: new Map([["a", 300], ["b", 0]]),
    }),
  );
  assert.equal(state(checks, "ritmo_verba"), "falha");
  assert.match(checks.find((c) => c.id === "ritmo_verba")!.detalhe, /Campanha a gasta em média/);
  assert.equal(state(checks, "ativa_sem_entrega"), "falha");
});

test("verba pulverizada e concentração só como informação", () => {
  const many = [camp("big", 10_000, 100), ...Array.from({ length: 9 }, (_, i) => camp(`p${i}`, 50, 1))];
  const checks = evaluate(input({ current: many, previous: many }));
  assert.equal(state(checks, "fragmentacao"), "falha");
  const conc = checks.find((c) => c.id === "concentracao")!;
  assert.equal(conc.severidade, "info");
});

test("a ferramenta existe e o guia de mídia paga entra só para quem tem ferramentas de campanha", () => {
  const audit = ADS_TOOLS.find((t) => t.name === "auditar_conta");
  assert.ok(audit && audit.category === "leitura");
  const xodo = { name: "Nina", personality: "direto", autonomy: "sempre_pergunta", timezone: "America/Sao_Paulo", instructions: "", role: null } as unknown as Xodo;
  const base = { agencyName: "A", today: "2026-10-19", memory: "", clients: [] };
  assert.match(buildSystemPrompt(xodo, { ...base, ads: true }), /<midia_paga>[\s\S]*Nunca apague campanhas/);
  assert.doesNotMatch(buildSystemPrompt(xodo, base), /midia_paga/);
});
