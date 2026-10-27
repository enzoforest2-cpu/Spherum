import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";
import { assertLimit } from "./subscription";

/** Clientes da agência e seus contatos. Arquivar esconde; os dados ficam (contratos, relatórios). */

const digits = (s: string) => s.replace(/\D/g, "");
const brl = z.number().nonnegative().max(10_000_000);

const fields = {
  name: z.string().trim().min(1).max(120),
  segment: z.string().trim().max(80).nullable(),
  status: z.enum(["ativo", "onboarding", "pausado", "encerrado"]),
  // Mensalidade em reais (com centavos); guardada em centavos.
  monthly_fee: brl.nullable(),
  started_on: z.iso.date().nullable(),
  website: z.string().trim().max(200).nullable(),
  instagram: z.string().trim().max(80).nullable(),
  cnpj: z
    .string()
    .transform(digits)
    .pipe(z.string().regex(/^(\d{11}|\d{14})$/, "CPF ou CNPJ inválido"))
    .nullable(),
  city: z.string().trim().max(80).nullable(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable(),
  notes: z.string().max(4000).nullable(),
  owner_user_id: z.uuid().nullable(),
  // Meta do cliente: CPL ou CPA em reais, ROAS em vezes.
  goal_metric: z.enum(["CPL", "CPA", "ROAS"]).nullable(),
  goal_value: z.number().positive().max(1_000_000).nullable(),
};

export const clientInput = z.object(fields).partial().required({ name: true });
export const clientPatch = z.object(fields).partial();

const COLUMNS = `c.id, c.name, c.segment, c.status, c.monthly_fee_cents::float8 / 100 as monthly_fee, c.started_on::text, c.website,
  c.instagram, c.cnpj, c.city, c.color, c.logo_path, c.notes, c.owner_user_id, op.full_name as owner_name,
  c.goal_metric, c.goal_value::float8 as goal_value, c.health_score, c.health_reason, c.health_updated_at::text, c.archived_at::text, c.created_at::text, c.updated_at::text,
  (select json_build_object('name', ct.name, 'email', ct.email, 'phone', ct.phone)
     from client_contacts ct where ct.client_id = c.id order by ct.is_primary desc, ct.created_at limit 1) as contact`;

function toRow(input: z.infer<typeof clientPatch>) {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (k === "monthly_fee") row.monthly_fee_cents = v === null ? null : Math.round((v as number) * 100);
    else row[k] = v;
  }
  return row;
}

async function assertOwner(sql: Sql, agencyId: string, ownerId: unknown) {
  if (typeof ownerId !== "string") return;
  const member = await one(sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [agencyId, ownerId]);
  if (!member) throw new XodoError("O responsável precisa ser da equipe da agência.", 400);
}

export async function listClients(sql: Sql, agencyId: string, opts: { archived?: boolean } = {}) {
  return sql.query<ClientRow>(
    `select ${COLUMNS} from clients c left join profiles op on op.id = c.owner_user_id
      where c.agency_id = $1 and (c.archived_at is not null) = $2
      order by lower(c.name)`,
    [agencyId, opts.archived ?? false],
  );
}

export type ClientRow = {
  id: string;
  name: string;
  segment: string | null;
  status: string;
  monthly_fee: number | null;
  started_on: string | null;
  cnpj: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  health_score: number | null;
  archived_at: string | null;
  contact: { name: string; email: string | null; phone: string | null } | null;
  [key: string]: unknown;
};

export type ContactRow = { id: string; name: string; email: string | null; phone: string | null; role: string | null; is_primary: boolean };

export async function getClient(sql: Sql, agencyId: string, clientId: string): Promise<ClientRow & { contacts: ContactRow[] }> {
  const client = await one<ClientRow>(sql, `select ${COLUMNS} from clients c left join profiles op on op.id = c.owner_user_id where c.id = $1 and c.agency_id = $2`, [
    clientId,
    agencyId,
  ]);
  if (!client) throw new XodoError("Cliente não encontrado.", 404);
  const contacts = await sql.query<ContactRow>(
    `select id, name, email, phone, role, is_primary, created_at::text from client_contacts where client_id = $1 and agency_id = $2
      order by is_primary desc, created_at`,
    [clientId, agencyId],
  );
  return { ...client, contacts };
}

export async function createClient(sql: Sql, agencyId: string, actorId: string, raw: unknown) {
  const input = clientInput.parse(raw);
  await assertOwner(sql, agencyId, input.owner_user_id);
  const count = await one<{ n: number }>(sql, `select count(*)::int as n from clients where agency_id = $1 and archived_at is null`, [agencyId]);
  if ((count?.n ?? 0) >= 2000) throw new XodoError("Limite de clientes ativos atingido.", 409);
  if (input.status !== "encerrado") await assertLimit(sql, agencyId, "clients");
  const row = toRow(input);
  const keys = Object.keys(row);
  const created = await one<{ id: string }>(
    sql,
    `insert into clients (agency_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
    [agencyId, ...keys.map((k) => row[k])],
  );
  await audit(sql, { agencyId, actor: actorId, action: "cliente_criado", targetType: "client", targetId: created!.id });
  return getClient(sql, agencyId, created!.id);
}

export async function updateClient(sql: Sql, agencyId: string, actorId: string, clientId: string, raw: unknown) {
  const input = clientPatch.parse(raw);
  await assertOwner(sql, agencyId, input.owner_user_id);
  // Voltar um cliente encerrado conta de novo no limite do plano.
  if (input.status && input.status !== "encerrado") {
    const cur = await one<{ status: string }>(sql, `select status from clients where id = $1 and agency_id = $2`, [clientId, agencyId]);
    if (cur?.status === "encerrado") await assertLimit(sql, agencyId, "clients");
  }
  const row = toRow(input);
  const keys = Object.keys(row);
  if (keys.length) {
    const updated = await one(
      sql,
      `update clients set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and agency_id = $2 returning id`,
      [clientId, agencyId, ...keys.map((k) => row[k])],
    );
    if (!updated) throw new XodoError("Cliente não encontrado.", 404);
  }
  return getClient(sql, agencyId, clientId);
}

/** Arquiva (ou volta) um cliente. Os xodós deixam de atender cliente arquivado. */
export async function setClientArchived(sql: Sql, agencyId: string, actorId: string, clientId: string, archived: boolean) {
  const row = await one(
    sql,
    `update clients set archived_at = case when $3 then coalesce(archived_at, now()) else null end where id = $1 and agency_id = $2 returning id`,
    [clientId, agencyId, archived],
  );
  if (!row) throw new XodoError("Cliente não encontrado.", 404);
  await audit(sql, { agencyId, actor: actorId, action: archived ? "cliente_arquivado" : "cliente_reativado", targetType: "client", targetId: clientId });
  return getClient(sql, agencyId, clientId);
}

// ---------------------------------------------------------------------------
// Contatos
// ---------------------------------------------------------------------------

export const contactInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().trim().toLowerCase().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  role: z.string().trim().max(80).nullable().optional(),
  is_primary: z.boolean().optional(),
});

export async function addContact(sql: Sql, agencyId: string, clientId: string, raw: unknown) {
  const input = contactInput.parse(raw);
  return sql.transaction(async (tx) => {
    const client = await one(tx, `select 1 from clients where id = $1 and agency_id = $2`, [clientId, agencyId]);
    if (!client) throw new XodoError("Cliente não encontrado.", 404);
    const total = await one<{ n: number }>(tx, `select count(*)::int as n from client_contacts where client_id = $1`, [clientId]);
    if ((total?.n ?? 0) >= 50) throw new XodoError("Limite de contatos do cliente atingido.", 409);
    // O primeiro contato vira o principal; marcar outro como principal tira o anterior.
    const primary = input.is_primary ?? (total?.n ?? 0) === 0;
    if (primary) await tx.query(`update client_contacts set is_primary = false where client_id = $1`, [clientId]);
    return one(
      tx,
      `insert into client_contacts (agency_id, client_id, name, email, phone, role, is_primary) values ($1, $2, $3, $4, $5, $6, $7)
       returning id, name, email, phone, role, is_primary, created_at::text`,
      [agencyId, clientId, input.name, input.email ?? null, input.phone ?? null, input.role ?? null, primary],
    );
  });
}

export async function removeContact(sql: Sql, agencyId: string, clientId: string, contactId: string) {
  const row = await one(sql, `delete from client_contacts where id = $1 and client_id = $2 and agency_id = $3 returning id`, [contactId, clientId, agencyId]);
  if (!row) throw new XodoError("Contato não encontrado.", 404);
}
