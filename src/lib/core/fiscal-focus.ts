import { access, saveConnection, type IntegrationDeps } from "../integrations/store";
import { XodoError } from "../xodos/errors";
import type { FiscalProvider, NoteStatus } from "./fiscal";

/**
 * Focus NFe (NFS-e municipal). O token da empresa fica cifrado numa conexão `focusnfe`. Envio é
 * assíncrono: a nota fica "processando" até a prefeitura autorizar (o cron consulta).
 */

const BASE = { homologacao: "https://homologacao.focusnfe.com.br", producao: "https://api.focusnfe.com.br" } as const;
type Env = keyof typeof BASE;

type FocusNote = { status?: string; numero?: string; codigo_verificacao?: string; url?: string; url_danfse?: string; caminho_xml_nota_fiscal?: string; erros?: { mensagem?: string }[]; mensagem?: string };

async function call(deps: IntegrationDeps, token: string, env: Env, method: string, path: string, body?: unknown): Promise<{ status: number; data: FocusNote }> {
  let r: Response;
  try {
    r = await deps.fetch(`${BASE[env]}${path}`, {
      method, headers: { authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`, ...(body ? { "content-type": "application/json" } : {}), accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new XodoError(`Não consegui falar com a Focus NFe (${error instanceof Error ? error.message : error}).`, 502);
  }
  const text = await r.text();
  let data: FocusNote = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* resposta sem JSON */ }
  if (r.status === 401 || r.status === 403) throw new XodoError("A Focus NFe recusou o token. Confira o token da empresa em Notas e cobranças.", 401);
  return { status: r.status, data };
}

function toStatus(env: Env, d: FocusNote): NoteStatus {
  const errors = (d.erros ?? []).map((e) => e.mensagem).filter(Boolean).join("; ") || d.mensagem || null;
  if (d.status === "autorizado") return { status: "emitida", number: d.numero ?? null, verification_code: d.codigo_verificacao ?? null, pdf_url: d.url_danfse ?? d.url ?? null, xml_url: d.caminho_xml_nota_fiscal ? `${BASE[env]}${d.caminho_xml_nota_fiscal}` : null };
  if (d.status === "cancelado") return { status: "cancelada" };
  if (d.status === "erro_autorizacao" || d.status === "erro_cancelamento") return { status: "erro", error: errors ?? "A prefeitura recusou a nota." };
  return { status: "processando" };
}

export function focusProvider(deps: IntegrationDeps): FiscalProvider {
  const token = async (agencyId: string, connectionId: string) => (await access(deps, agencyId, connectionId)).accessToken;
  return {
    async emit(agencyId, connectionId, env, req) {
      const t = await token(agencyId, connectionId);
      const doc = req.tomador.doc.length === 14 ? { cnpj: req.tomador.doc } : { cpf: req.tomador.doc };
      const r = await call(deps, t, env, "POST", `/v2/nfse?ref=${encodeURIComponent(req.ref)}`, {
        data_emissao: req.issuedOn, optante_simples_nacional: req.simples,
        prestador: req.prestador,
        tomador: { ...doc, razao_social: req.tomador.name, ...(req.tomador.email ? { email: req.tomador.email } : {}) },
        servico: { aliquota: req.servico.aliquota, discriminacao: req.servico.discriminacao, iss_retido: req.servico.iss_retido, item_lista_servico: req.servico.item_lista_servico,
          ...(req.servico.codigo_tributario_municipio ? { codigo_tributario_municipio: req.servico.codigo_tributario_municipio } : {}), valor_servicos: Number(req.servico.valor.toFixed(2)) },
      });
      if (r.status >= 400) return { status: "erro", error: (r.data.erros ?? []).map((e) => e.mensagem).join("; ") || r.data.mensagem || `HTTP ${r.status}` };
      return toStatus(env, r.data);
    },
    async query(agencyId, connectionId, env, ref) {
      const r = await call(deps, await token(agencyId, connectionId), env, "GET", `/v2/nfse/${encodeURIComponent(ref)}`);
      if (r.status === 404) return { status: "erro", error: "A Focus NFe não encontrou a nota." };
      return toStatus(env, r.data);
    },
    async cancel(agencyId, connectionId, env, ref, reason) {
      const r = await call(deps, await token(agencyId, connectionId), env, "DELETE", `/v2/nfse/${encodeURIComponent(ref)}`, { justificativa: reason });
      if (r.status >= 400) throw new XodoError(r.data.mensagem || (r.data.erros ?? []).map((e) => e.mensagem).join("; ") || "A prefeitura não aceitou o cancelamento.", 422);
      return toStatus(env, r.data.status ? r.data : { status: "cancelado" });
    },
  };
}

/** Guarda o token da Focus NFe (confere antes: um token recusado não é gravado). */
export async function connectFocus(deps: IntegrationDeps, agencyId: string, userId: string, token: string, env: Env) {
  const t = token.trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(t)) throw new XodoError("Token inválido.", 400);
  await call(deps, t, env, "GET", "/v2/nfse/spherum-teste-de-token");
  return saveConnection(deps, { agencyId, provider: "focusnfe", label: `Focus NFe · ${env === "producao" ? "produção" : "homologação"}`, account: `focusnfe:${env}`, secret: { apiKey: t }, createdBy: userId });
}

/** Dependências fiscais no servidor. */
export async function fiscalDeps(sql: import("../xodos/db").Sql) {
  const { serverIntegrations } = await import("../integrations");
  const { mailerFromEnv } = await import("./email");
  return { sql, provider: focusProvider({ sql, ...serverIntegrations() }), mailer: mailerFromEnv() };
}
