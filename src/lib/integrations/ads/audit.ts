// Estados, pesos e cobertura do ads/references/scoring-system.md do claude-ads (Daniel Agrici, MIT);
// verificações escritas aqui sobre os dados que o Spherum sincroniza, sempre contra a própria conta.

/**
 * Auditoria de uma conta de anúncio, só leitura e determinística: cada verificação dá
 * "ok", "falha", "sem_dados" ou "nao_se_aplica". A nota só aparece com cobertura suficiente,
 * e a comparação é sempre com o período anterior da mesma conta (nunca com média de mercado).
 */

export type CheckState = "ok" | "falha" | "sem_dados" | "nao_se_aplica";
export type Severity = "critica" | "alta" | "media" | "info";
export const SEVERITY_WEIGHT: Record<Severity, number> = { critica: 5, alta: 3, media: 1, info: 0 };

export type Check = { id: string; titulo: string; severidade: Severity; estado: CheckState; detalhe: string };

export type CampaignWindow = {
  id: string;
  name: string | null;
  spend: number;
  results: number;
  impressions: number;
  clicks: number;
};

export type AuditInput = {
  platform: "meta" | "google" | "tiktok";
  dias: number;
  /** Última sincronização da conta e o erro dela, se houver. */
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  now: Date;
  /** Último dia com métricas da conta (AAAA-MM-DD) e o último dia da janela. */
  lastDataDay: string | null;
  windowEnd: string;
  current: CampaignWindow[];
  previous: CampaignWindow[];
  /** Gasto médio por dia nos últimos 7 dias e gasto dos últimos 3 dias, por campanha. */
  avgSpend7: Map<string, number>;
  spend3: Map<string, number>;
  /** Campanhas ao vivo (nulo quando não deu para consultar a plataforma). */
  live: { id: string; name: string; status: string; dailyBudget: number | null }[] | null;
};

const brl = (v: number) => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const sum = (rows: CampaignWindow[], k: keyof Omit<CampaignWindow, "id" | "name">) => rows.reduce((t, r) => t + r[k], 0);
const label = (c: { id: string; name: string | null }) => c.name || c.id;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Mínimos para comparar sem tirar conclusão de número pequeno. */
export const MIN_RESULTS = 20;
export const MIN_IMPRESSIONS = 5000;

export function evaluate(d: AuditInput): Check[] {
  const checks: Check[] = [];
  const spendNow = sum(d.current, "spend");
  const spendBefore = sum(d.previous, "spend");
  const resultsNow = sum(d.current, "results");
  const resultsBefore = sum(d.previous, "results");

  // 1. Dados atualizados.
  const syncAgeH = d.lastSyncedAt ? (d.now.getTime() - d.lastSyncedAt.getTime()) / 3_600_000 : null;
  checks.push({
    id: "dados_atualizados",
    titulo: "Dados sincronizados e recentes",
    severidade: "critica",
    estado: d.lastSyncError ? "falha" : syncAgeH === null ? "falha" : syncAgeH <= 36 ? "ok" : "falha",
    detalhe: d.lastSyncError
      ? `A última sincronização falhou: ${d.lastSyncError.slice(0, 160)}`
      : syncAgeH === null
        ? "A conta nunca sincronizou."
        : syncAgeH <= 36
          ? `Sincronizada há ${Math.round(syncAgeH)} h.`
          : `Sem sincronizar há ${Math.round(syncAgeH / 24)} dias; os números podem estar desatualizados.`,
  });

  // 2. Métricas chegando até perto do fim da janela.
  if (!d.lastDataDay) {
    checks.push({ id: "metricas_recentes", titulo: "Métricas dos últimos dias", severidade: "alta", estado: "sem_dados", detalhe: "Nenhuma métrica guardada para esta conta." });
  } else {
    const gap = daysBetween(d.lastDataDay, d.windowEnd);
    checks.push({
      id: "metricas_recentes",
      titulo: "Métricas dos últimos dias",
      severidade: "alta",
      estado: gap <= 2 ? "ok" : "falha",
      detalhe: gap <= 2 ? `Há métricas até ${d.lastDataDay}.` : `As métricas param em ${d.lastDataDay} (${gap} dias antes do fim do período).`,
    });
  }

  // 3. Rastreio parou: tinha resultado antes, agora gasta sem nenhum.
  if (resultsBefore < MIN_RESULTS) {
    checks.push({
      id: "rastreio_parou",
      titulo: "Conversões continuam chegando",
      severidade: "critica",
      estado: resultsBefore === 0 && resultsNow === 0 ? "sem_dados" : "nao_se_aplica",
      detalhe:
        resultsBefore === 0 && resultsNow === 0
          ? "Nenhuma conversão ou lead nos dois períodos: confira se o rastreio está configurado."
          : `Poucos resultados no período anterior (${resultsBefore}) para concluir.`,
    });
  } else {
    const stopped = spendNow > 0 && resultsNow === 0;
    checks.push({
      id: "rastreio_parou",
      titulo: "Conversões continuam chegando",
      severidade: "critica",
      estado: stopped ? "falha" : "ok",
      detalhe: stopped
        ? `Gastou ${brl(spendNow)} sem nenhuma conversão ou lead, contra ${resultsBefore} no período anterior. Confira o pixel, a tag e a página antes de mexer nas campanhas.`
        : `${resultsNow} resultados no período (antes: ${resultsBefore}).`,
    });
  }

  // 4. Gasto sem resultado por campanha (só quando a conta registra resultados).
  if (resultsNow + resultsBefore === 0) {
    checks.push({ id: "gasto_sem_resultado", titulo: "Campanhas gastando sem resultado", severidade: "alta", estado: "sem_dados", detalhe: "A conta não registra conversões nem leads." });
  } else {
    const floor = Math.max(50, spendNow * 0.05);
    const waste = d.current.filter((c) => c.spend >= floor && c.results === 0).sort((a, b) => b.spend - a.spend);
    checks.push({
      id: "gasto_sem_resultado",
      titulo: "Campanhas gastando sem resultado",
      severidade: "alta",
      estado: waste.length ? "falha" : "ok",
      detalhe: waste.length
        ? `${waste.length} campanha(s) gastaram sem nenhum resultado: ${waste.slice(0, 5).map((c) => `${label(c)} (${brl(c.spend)})`).join(", ")}. Confira o atraso de conversão e o objetivo antes de pausar.`
        : `Nenhuma campanha gastou ${brl(floor)} ou mais sem resultado.`,
    });
  }

  // 5. Custo por resultado contra o período anterior.
  if (resultsNow < MIN_RESULTS || resultsBefore < MIN_RESULTS) {
    checks.push({ id: "custo_por_resultado", titulo: "Custo por resultado estável", severidade: "alta", estado: "sem_dados", detalhe: `Precisa de pelo menos ${MIN_RESULTS} resultados em cada período para comparar.` });
  } else {
    const now = spendNow / resultsNow;
    const before = spendBefore / resultsBefore;
    const change = (now - before) / before;
    checks.push({
      id: "custo_por_resultado",
      titulo: "Custo por resultado estável",
      severidade: "alta",
      estado: change > 0.3 ? "falha" : "ok",
      detalhe: `${brl(now)} por resultado (antes ${brl(before)}, ${change >= 0 ? "+" : ""}${pct(change)}).`,
    });
  }

  // 6. CTR contra o período anterior.
  const impNow = sum(d.current, "impressions");
  const impBefore = sum(d.previous, "impressions");
  if (impNow < MIN_IMPRESSIONS || impBefore < MIN_IMPRESSIONS) {
    checks.push({ id: "ctr", titulo: "Taxa de cliques estável", severidade: "media", estado: "sem_dados", detalhe: `Precisa de pelo menos ${MIN_IMPRESSIONS.toLocaleString("pt-BR")} impressões em cada período.` });
  } else {
    const now = sum(d.current, "clicks") / impNow;
    const before = sum(d.previous, "clicks") / impBefore;
    const change = before > 0 ? (now - before) / before : 0;
    checks.push({
      id: "ctr",
      titulo: "Taxa de cliques estável",
      severidade: "media",
      estado: change < -0.25 ? "falha" : "ok",
      detalhe: `CTR de ${(now * 100).toFixed(2)}% (antes ${(before * 100).toFixed(2)}%). Queda grande costuma indicar criativo cansado ou público saturado.`,
    });
  }

  // 7. Verba pulverizada em muitas campanhas pequenas.
  const spending = d.current.filter((c) => c.spend > 0);
  if (spending.length < 5) {
    checks.push({ id: "fragmentacao", titulo: "Verba sem pulverizar", severidade: "media", estado: "nao_se_aplica", detalhe: `${spending.length} campanha(s) com gasto no período.` });
  } else {
    const tiny = spending.filter((c) => c.spend / spendNow < 0.02);
    checks.push({
      id: "fragmentacao",
      titulo: "Verba sem pulverizar",
      severidade: "media",
      estado: tiny.length >= 8 ? "falha" : "ok",
      detalhe: tiny.length >= 8
        ? `${tiny.length} campanhas recebem menos de 2% da verba cada; dados espalhados demais atrasam o aprendizado.`
        : `${spending.length} campanhas com gasto; ${tiny.length} com menos de 2% da verba.`,
    });
  }

  // 8. Concentração (só informação, sem nota).
  if (spendNow > 0 && spending.length >= 2) {
    const top = [...spending].sort((a, b) => b.spend - a.spend)[0];
    const share = top.spend / spendNow;
    checks.push({
      id: "concentracao",
      titulo: "Concentração da verba",
      severidade: "info",
      estado: "ok",
      detalhe: `${label(top)} recebe ${pct(share)} da verba do período.`,
    });
  }

  // 9 e 10. Precisam das campanhas ao vivo (situação e verba diária).
  if (!d.live) {
    checks.push({ id: "ritmo_verba", titulo: "Gasto no ritmo da verba diária", severidade: "alta", estado: "sem_dados", detalhe: "Não deu para consultar as campanhas ao vivo." });
    checks.push({ id: "ativa_sem_entrega", titulo: "Campanhas ativas entregando", severidade: "alta", estado: "sem_dados", detalhe: "Não deu para consultar as campanhas ao vivo." });
  } else {
    const active = d.live.filter((c) => c.status === "ativa" && c.dailyBudget !== null && c.dailyBudget > 0);
    if (!active.length) {
      checks.push({ id: "ritmo_verba", titulo: "Gasto no ritmo da verba diária", severidade: "alta", estado: "nao_se_aplica", detalhe: "Nenhuma campanha ativa com verba diária no nível da campanha." });
      checks.push({ id: "ativa_sem_entrega", titulo: "Campanhas ativas entregando", severidade: "alta", estado: "nao_se_aplica", detalhe: "Nenhuma campanha ativa com verba diária." });
    } else {
      const over = active.filter((c) => (d.avgSpend7.get(c.id) ?? 0) > c.dailyBudget! * 1.15);
      const under = active.filter((c) => {
        const avg = d.avgSpend7.get(c.id) ?? 0;
        return avg > 0 && avg < c.dailyBudget! * 0.5;
      });
      const problems = [
        ...over.map((c) => `${c.name} gasta em média ${brl(d.avgSpend7.get(c.id) ?? 0)}/dia com verba de ${brl(c.dailyBudget!)}`),
        ...under.map((c) => `${c.name} gasta só ${brl(d.avgSpend7.get(c.id) ?? 0)}/dia de ${brl(c.dailyBudget!)}`),
      ];
      checks.push({
        id: "ritmo_verba",
        titulo: "Gasto no ritmo da verba diária",
        severidade: "alta",
        estado: problems.length ? "falha" : "ok",
        detalhe: problems.length ? `${problems.slice(0, 5).join("; ")}. Média dos últimos 7 dias.` : `${active.length} campanha(s) ativas gastando perto da verba diária.`,
      });
      const silent = active.filter((c) => (d.spend3.get(c.id) ?? 0) === 0);
      checks.push({
        id: "ativa_sem_entrega",
        titulo: "Campanhas ativas entregando",
        severidade: "alta",
        estado: silent.length ? "falha" : "ok",
        detalhe: silent.length
          ? `${silent.length} campanha(s) ativas sem gastar nada nos últimos 3 dias: ${silent.slice(0, 5).map((c) => c.name).join(", ")}. Confira reprovação de anúncio, pagamento, público e lance.`
          : "Todas as campanhas ativas gastaram nos últimos 3 dias.",
      });
    }
  }
  return checks;
}

export type AuditScore = { saude: number | null; cobertura: number; situacao: "avaliada" | "provisoria" | "dados_insuficientes" };

/** Saúde = peso das que passaram ÷ peso das conhecidas; cobertura = conhecidas ÷ aplicáveis. */
export function score(checks: Check[]): AuditScore {
  const scored = checks.filter((c) => SEVERITY_WEIGHT[c.severidade] > 0 && c.estado !== "nao_se_aplica");
  const applicable = scored.reduce((t, c) => t + SEVERITY_WEIGHT[c.severidade], 0);
  const known = scored.filter((c) => c.estado !== "sem_dados");
  const knownWeight = known.reduce((t, c) => t + SEVERITY_WEIGHT[c.severidade], 0);
  const passWeight = known.filter((c) => c.estado === "ok").reduce((t, c) => t + SEVERITY_WEIGHT[c.severidade], 0);
  const cobertura = applicable ? Math.round((knownWeight / applicable) * 100) : 0;
  const situacao = cobertura >= 80 ? "avaliada" : cobertura >= 60 ? "provisoria" : "dados_insuficientes";
  return {
    saude: situacao === "dados_insuficientes" || !knownWeight ? null : Math.round((passWeight / knownWeight) * 100),
    cobertura,
    situacao,
  };
}
