import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";

/** Ajudas das rotas da base (as de autenticação e papel ficam em xodos/http). */

/** Equipe do Spherum (portal admin). Mesmo erro para quem não é, sem revelar a rota. */
export async function requireStaff(sql: Sql, userId: string): Promise<string> {
  const row = await one<{ role: string }>(sql, `select role from spherum_staff where user_id = $1`, [userId]);
  if (!row) throw new XodoError("Não encontrado", 404);
  return row.role;
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
