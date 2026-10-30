import { one, serverSql, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { requireAuth } from "../xodos/http";

/** Ajudas das rotas da base (as de autenticação e papel ficam em xodos/http). */

/** Código da resposta 403 quando falta o código do app autenticador (a tela do admin pede o código). */
export const MFA_REQUIRED = "mfa_required";

/**
 * Equipe do Spherum (portal admin). Mesmo erro para quem não é, sem revelar a rota. Quem é da
 * equipe precisa ter entrado com a verificação em duas etapas (aal2 no token); sem ela, 403 com
 * o código "mfa_required" para a tela pedir o código (ou o cadastro do app autenticador).
 */
export async function requireStaff(sql: Sql, user: { id: string; aal: string | null }): Promise<string> {
  const row = await one<{ role: string }>(sql, `select role from spherum_staff where user_id = $1`, [user.id]);
  if (!row) throw new XodoError("Não encontrado", 404);
  if (user.aal !== "aal2") throw new XodoError("Confirme o código do app autenticador para entrar no admin.", 403, MFA_REQUIRED);
  return row.role;
}

/** Rotas do admin: login, equipe do Spherum e verificação em duas etapas. */
export async function requireAdmin(request: Request): Promise<{ userId: string; role: string; sql: Sql }> {
  const user = await requireAuth(request);
  const sql = await serverSql();
  return { userId: user.id, role: await requireStaff(sql, user), sql };
}

/** Agência dona do cliente (para conferir o papel de quem pede). */
export async function clientAgency(sql: Sql, clientId: string): Promise<string> {
  const row = await one<{ agency_id: string }>(sql, `select agency_id from clients where id = $1`, [clientId]);
  if (!row) throw new XodoError("Cliente não encontrado.", 404);
  return row.agency_id;
}

/** Agência dona do projeto. */
export async function projectAgency(sql: Sql, projectId: string): Promise<string> {
  const row = await one<{ agency_id: string }>(sql, `select agency_id from projects where id = $1`, [projectId]);
  if (!row) throw new XodoError("Projeto não encontrado.", 404);
  return row.agency_id;
}

/** Agência dona do contrato. */
export async function contractAgency(sql: Sql, contractId: string): Promise<string> {
  const row = await one<{ agency_id: string }>(sql, `select agency_id from client_contracts where id = $1`, [contractId]);
  if (!row) throw new XodoError("Contrato não encontrado.", 404);
  return row.agency_id;
}

/** Agência dona do negócio do CRM. */
export async function dealAgency(sql: Sql, dealId: string): Promise<string> {
  const row = await one<{ agency_id: string }>(sql, `select agency_id from deals where id = $1`, [dealId]);
  if (!row) throw new XodoError("Negócio não encontrado.", 404);
  return row.agency_id;
}

/** Agência dona da reunião (atas). */
export async function meetingAgency(sql: Sql, meetingId: string): Promise<string> {
  const row = await one<{ agency_id: string }>(sql, `select agency_id from meetings where id = $1`, [meetingId]);
  if (!row) throw new XodoError("Reunião não encontrada.", 404);
  return row.agency_id;
}

/** Agência dona do chamado. */
export async function ticketAgency(sql: Sql, ticketId: string): Promise<string> {
  const row = await one<{ agency_id: string }>(sql, `select agency_id from tickets where id = $1`, [ticketId]);
  if (!row) throw new XodoError("Chamado não encontrado.", 404);
  return row.agency_id;
}

/** Agência dona da proposta. */
export async function proposalAgency(sql: Sql, proposalId: string): Promise<string> {
  const row = await one<{ agency_id: string }>(sql, `select agency_id from proposals where id = $1`, [proposalId]);
  if (!row) throw new XodoError("Proposta não encontrada.", 404);
  return row.agency_id;
}

/** Link do convite: o site abre o convite e pede login ou cadastro com o e-mail convidado. */
export function inviteLink(token: string, request: Request): string {
  const base = process.env.APP_URL?.trim() || new URL(request.url).origin;
  return `${base.replace(/\/$/, "")}/?convite=${encodeURIComponent(token)}`;
}

/** IP de quem chamou (primeiro da cadeia da Vercel). Usado só como hash, para limitar abuso. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || null;
}

export function leadSalt(): string {
  return process.env.LEADS_SALT?.trim() || process.env.XODOS_ENCRYPTION_KEY?.trim() || "spherum-leads";
}

/** Agência dona do canal do chat. */
export async function channelAgency(sql: Sql, channelId: string): Promise<string> {
  const row = await one<{ agency_id: string }>(sql, `select agency_id from team_channels where id = $1`, [channelId]);
  if (!row) throw new XodoError("Canal não encontrado.", 404);
  return row.agency_id;
}
