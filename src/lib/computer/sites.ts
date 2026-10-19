// Palavras de ação dos rótulos adaptadas de shared/outbound.ts do OpenMausBot (Apache-2.0), em pt-BR e inglês.
import type { Sql } from "../xodos/db";
import type { Category } from "../xodos/policy";

/**
 * Categoria de aprovação por site para as ferramentas do navegador.
 *
 * Ordem: regra da agência (computer_site_rules) vence a tabela padrão; páginas de senha,
 * segurança, PIX e transferência são sempre "so_voce" (regras fixas do design: trocar senhas e
 * transferir dinheiro só a pessoa faz). Site desconhecido é "alteracao".
 *
 * Padrão de host: "exemplo.com" casa só esse host; "*.exemplo.com" casa o próprio domínio e os
 * subdomínios. Um caminho opcional depois do host casa pelo começo ("linkedin.com/messaging").
 */

/** "so_voce": nem vira pedido de aprovação; a ferramenta recusa e o xodó pede o controle. */
export type SiteCategory = Category | "so_voce";

/** Categorias aceitas numa regra de site (as mesmas do check da migração). */
export const SITE_RULE_CATEGORIES = ["leitura", "alteracao", "envio", "exclusao", "pagamento", "campanha", "cliente", "so_voce"] as const;

const RANK: Record<SiteCategory, number> = {
  leitura: 0,
  rascunho: 1,
  memoria: 1,
  equipe: 1,
  alteracao: 2,
  envio: 3,
  campanha: 4,
  exclusao: 5,
  cliente: 6,
  pagamento: 7,
  so_voce: 8,
};

export const isStricter = (a: SiteCategory, b: SiteCategory) => RANK[a] > RANK[b];

/** A mais restrita das categorias (ignora as vazias); sem nenhuma, "leitura". */
export function strictest(...cats: (SiteCategory | null | undefined)[]): SiteCategory {
  let best: SiteCategory = "leitura";
  for (const c of cats) if (c && RANK[c] > RANK[best]) best = c;
  return best;
}

/** Host em minúsculas, sem ponto final; nulo para endereço que não é http(s). */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

export function matchHost(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/\.$/, "");
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return Boolean(base) && (host === base || host.endsWith(`.${base}`));
  }
  return host === p;
}

type DefaultRule = { host: string; path?: RegExp; category: SiteCategory };

const BANKS = [
  "itau.com.br", "bradesco.com.br", "santander.com.br", "bb.com.br", "caixa.gov.br", "nubank.com.br",
  "inter.co", "bancointer.com.br", "c6bank.com.br", "btgpactual.com", "sicoob.com.br", "sicredi.com.br", "banrisul.com.br",
  "original.com.br", "bancopan.com.br", "safra.com.br", "picpay.com", "next.me", "neon.com.br", "agibank.com.br", "bancobmg.com.br",
];
const PAYMENTS = [
  "mercadopago.com.br", "mercadopago.com", "pagseguro.uol.com.br", "pagbank.com.br", "paypal.com", "stripe.com", "pagar.me",
  "asaas.com", "iugu.com", "cielo.com.br", "getnet.com.br", "stone.com.br", "pay.google.com", "pay.hotmart.com", "ebanx.com",
  "vindi.com.br", "juno.com.br", "efipay.com.br", "gerencianet.com.br",
];
const SIGNATURES = ["docusign.com", "docusign.net", "clicksign.com", "d4sign.com.br", "zapsign.com.br", "zapsign.co", "autentique.com.br", "adobesign.com", "echosign.com"];

/** Host do Spherum (portal do cliente e o próprio app): tudo o que chega ao cliente é "cliente". */
function spherumHosts(): string[] {
  const hosts = ["*.spherum.com.br"];
  const app = process.env.APP_URL ? hostOf(process.env.APP_URL) : null;
  if (app) hosts.push(app);
  return hosts;
}

const DEFAULTS: DefaultRule[] = [
  // Anúncios: mexe em campanhas e verba.
  { host: "business.facebook.com", category: "campanha" },
  { host: "adsmanager.facebook.com", category: "campanha" },
  { host: "*.facebook.com", path: /^\/(adsmanager|ads\/manager)(\/|$)/, category: "campanha" },
  { host: "*.ads.google.com", category: "campanha" },
  { host: "ads.tiktok.com", category: "campanha" },
  { host: "business.tiktok.com", category: "campanha" },
  { host: "*.linkedin.com", path: /^\/campaignmanager(\/|$)/, category: "campanha" },
  { host: "ads.pinterest.com", category: "campanha" },
  // Mensagens: chega a alguém de fora.
  { host: "mail.google.com", category: "envio" },
  { host: "outlook.live.com", category: "envio" },
  { host: "outlook.office.com", category: "envio" },
  { host: "outlook.office365.com", category: "envio" },
  { host: "web.whatsapp.com", category: "envio" },
  { host: "web.telegram.org", category: "envio" },
  { host: "*.linkedin.com", path: /^\/messaging(\/|$)/, category: "envio" },
  { host: "mail.yahoo.com", category: "envio" },
  // Dinheiro: bancos, gateways e checkout.
  ...[...BANKS, ...PAYMENTS].map((h) => ({ host: `*.${h}`, category: "pagamento" as const })),
  // Faturamento e checkout em qualquer site (inclui a cobrança dos gerenciadores de anúncios).
  { host: "*", path: /\/(checkout|carrinho|cart|pagamento|pagamentos|payment|payments|billing|faturamento|cobranca)(\/|$)/i, category: "pagamento" },
  // Assinatura de contratos: só a pessoa.
  ...SIGNATURES.map((h) => ({ host: `*.${h}`, category: "so_voce" as const })),
];

/** Começo de host que indica checkout ou pagamento (checkout.loja.com, pay.loja.com). */
const PAY_HOST = /^(checkout|pay|pagamento|pagamentos|payment|payments|billing)\./;

/** Trecho de caminho (ou valor de parâmetro) de página de senha, segurança, PIX ou transferência. */
const SO_VOCE_SEGMENT =
  /^(senha|senhas|password|passwords|seguranca|security|pix|transferencia|transferencias|transfer|transfers|2fa|mfa|two[-_]?factor|((alterar|trocar|redefinir|recuperar|esqueci|nova|mudar|change|reset|forgot|new|update)[-_](a[-_]|minha[-_]|my[-_])?(senha|password)))$/i;

function fixedSoVoce(u: URL): boolean {
  const segments = u.pathname.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (segments.some((s) => SO_VOCE_SEGMENT.test(s.normalize("NFD").replace(/[̀-ͯ]/g, "")))) return true;
  for (const value of u.searchParams.values()) if (SO_VOCE_SEGMENT.test(value)) return true;
  return false;
}

export type SiteRule = { pattern: string; category: SiteCategory };

function ruleMatches(pattern: string, host: string, path: string): boolean {
  const slash = pattern.indexOf("/");
  const hostPattern = slash === -1 ? pattern : pattern.slice(0, slash);
  const pathPrefix = slash === -1 ? "" : pattern.slice(slash);
  if (!matchHost(hostPattern, host)) return false;
  return !pathPrefix || path.toLowerCase().startsWith(pathPrefix.toLowerCase());
}

/** Regra da agência mais específica: com caminho, sem curinga, mais longa. */
function bestAgencyRule(rules: SiteRule[], host: string, path: string): SiteRule | null {
  const score = (p: string) => (p.includes("/") ? 10_000 : 0) + (p.startsWith("*.") ? 0 : 1_000) + p.length;
  let best: SiteRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.pattern.trim(), host, path)) continue;
    if (!best || score(rule.pattern) > score(best.pattern)) best = rule;
  }
  return best;
}

/** Categoria do site de um endereço, com as regras da agência. */
export function categorizeSite(url: string, agencyRules: SiteRule[] = []): SiteCategory {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "alteracao";
  }
  const host = hostOf(url);
  if (!host) return "alteracao";
  const fixed: SiteCategory | null = fixedSoVoce(u) ? "so_voce" : null;
  const agency = bestAgencyRule(agencyRules, host, u.pathname);
  if (agency) return strictest(agency.category, fixed);
  let found: SiteCategory | null = null;
  const rules: DefaultRule[] = [...DEFAULTS, ...spherumHosts().map((h) => ({ host: h, category: "cliente" as const }))];
  for (const rule of rules) {
    if (rule.host !== "*" && !matchHost(rule.host, host)) continue;
    if (rule.path && !rule.path.test(u.pathname)) continue;
    found = strictest(found, rule.category);
  }
  if (PAY_HOST.test(host)) found = strictest(found, "pagamento");
  return strictest(found ?? "alteracao", fixed);
}

export async function loadSiteRules(sql: Sql, agencyId: string): Promise<SiteRule[]> {
  return sql.query<SiteRule>(`select pattern, category from computer_site_rules where agency_id = $1 order by created_at limit 500`, [agencyId]);
}

export async function siteCategoryFor(sql: Sql, agencyId: string, url: string): Promise<SiteCategory> {
  return categorizeSite(url, await loadSiteRules(sql, agencyId));
}

// ---------------------------------------------------------------------------
// Rótulos e intenção: palavras que sobem a categoria do clique
// ---------------------------------------------------------------------------

const LABEL_RULES: { category: SiteCategory; re: RegExp }[] = [
  {
    category: "so_voce",
    re: /\b((alterar|trocar|redefinir|mudar|change|reset|update) (a |minha |sua |your |the )?(senha|password)|pix|transferir|transferencia|transfer (money|funds)|assinar (o |este |esse )?(documento|contrato)|assinar eletronicamente|sign (the |this )?(document|contract)|adopt and sign)\b/,
  },
  {
    category: "pagamento",
    re: /\b(pagar|pague|pay|pay now|comprar|compre|buy|purchase|checkout|finalizar (a )?compra|finalizar pedido|fechar pedido|place order|confirmar pagamento|confirm payment|adicionar (fundos|saldo|credito)|add funds|add money|recarregar|assinar (o )?plano|reembolsar|refund|cobrar|charge|doar|donate)\b/,
  },
  {
    // Mexer em acessos e permissões cai no piso (exclusao sempre pergunta), como apagar.
    category: "exclusao",
    re: /\b(excluir|exclua|apagar|apague|deletar|delete|remover|remova|remove|descartar|discard|arquivar|archive|revogar|revoke|desativar (a )?conta|deactivate|encerrar (a )?conta|close account|esvaziar|(alterar|mudar|change) (as |a |o )?(permissoes|permissao|permissions|papel|funcao|role)|tornar (administrador|admin)|make admin|transferir propriedade)\b/,
  },
  {
    category: "campanha",
    re: /\b((ativar|pausar|retomar|publicar|duplicar|criar|turn on|pause|activate|publish|duplicate) (a |o |the )?(campanha|campanhas|anuncio|anuncios|conjunto de anuncios|campaign|campaigns|ad set|ads?)|impulsionar|boost|promover (a )?publicacao|(aumentar|alterar|editar|mudar) (o |a )?(orcamento|lance|verba)|(increase|change|edit) (the )?(budget|bid))\b/,
  },
  {
    category: "envio",
    re: /\b(enviar|envie|send|send now|publicar|publique|publish|postar|post|responder|reply|encaminhar|forward|compartilhar|share|convidar|invite|tweet|tuitar|comentar|comment|disparar|broadcast|agendar (publicacao|post|envio)|schedule (post|send))\b/,
  },
];

export function normalizeLabel(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 400);
}

/** Categoria que o rótulo (ou a intenção declarada) indica; nula quando não indica nada. */
export function labelCategory(text: string | null | undefined): SiteCategory | null {
  if (!text) return null;
  const normalized = normalizeLabel(text);
  if (!normalized) return null;
  let found: SiteCategory | null = null;
  for (const rule of LABEL_RULES) if (rule.re.test(normalized)) found = strictest(found, rule.category);
  return found;
}
