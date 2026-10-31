import { num, one, type Sql } from "./db";

/**
 * Cotação do dólar para registrar em reais o gasto dos Xodós.
 *
 * Fonte: PTAX de venda do Banco Central (API pública Olinda). O cron guarda a cotação de
 * cada dia útil; fins de semana e feriados usam a última cotação conhecida.
 */

const PTAX_URL =
  "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)";

/** Data no formato que a API do Banco Central pede: MM-DD-AAAA. */
function bcbDate(day: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(day.getUTCMonth() + 1)}-${p(day.getUTCDate())}-${day.getUTCFullYear()}`;
}

type PtaxResponse = { value?: { cotacaoVenda?: number; dataHoraCotacao?: string }[] };

/** Busca as cotações dos últimos 10 dias e grava uma por dia. Devolve quantas gravou. */
export async function refreshFx(sql: Sql, now: Date, fetchImpl: typeof fetch = fetch): Promise<number> {
  const from = new Date(now.getTime() - 10 * 86_400_000);
  const query = new URLSearchParams({
    "@dataInicial": `'${bcbDate(from)}'`,
    "@dataFinalCotacao": `'${bcbDate(now)}'`,
    $format: "json",
    $select: "cotacaoVenda,dataHoraCotacao",
  });
  const response = await fetchImpl(`${PTAX_URL}?${query}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Banco Central respondeu ${response.status}`);
  const body = (await response.json()) as PtaxResponse;
  let saved = 0;
  for (const item of body.value ?? []) {
    const day = item.dataHoraCotacao?.slice(0, 10);
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !(Number(item.cotacaoVenda) > 0)) continue;
    await sql.query(
      `insert into fx_rates (day, usd_brl, source, fetched_at) values ($1::date, $2, 'bcb_ptax', $3::timestamptz)
       on conflict (day) do update set usd_brl = excluded.usd_brl, fetched_at = excluded.fetched_at`,
      [day, item.cotacaoVenda, now.toISOString()],
    );
    saved += 1;
  }
  return saved;
}

/** Última cotação conhecida até o dia (inclusive). Nula se ainda não há nenhuma. */
export async function usdBrl(sql: Sql, day: string): Promise<number | null> {
  const row = await one<{ usd_brl: unknown }>(
    sql,
    `select usd_brl from fx_rates where day <= $1::date order by day desc limit 1`,
    [day],
  );
  return row ? num(row.usd_brl) : null;
}
