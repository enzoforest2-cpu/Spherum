import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ComputerStorage } from "../computer/provider";
import { supabaseStorage } from "../computer/storage";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";

/**
 * Documentos da agência e dos clientes, guardados no bucket privado "documents" do Supabase
 * Storage. O navegador nunca recebe a chave do Storage: sobe o arquivo por uma URL assinada de
 * upload e baixa por uma URL assinada curta, as duas geradas aqui depois de checar o acesso.
 */

export const DOCUMENTS_BUCKET = "documents";
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const CATEGORIES = ["Contratos", "Briefings", "Criativos", "Relatórios", "Financeiro", "Outros"] as const;
const DOWNLOAD_SECONDS = 120;

export type DocumentRow = {
  id: string;
  client_id: string | null;
  client_name: string | null;
  name: string;
  category: string;
  mime: string | null;
  size_bytes: number;
  shared: boolean;
  uploaded_by_name: string | null;
  created_at: string;
};

export const documentInput = z.object({
  client_id: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES).default("Outros"),
  mime: z.string().trim().max(120).optional(),
  size: z.number().int().min(1).max(MAX_DOCUMENT_BYTES, "Arquivo maior que 50 MB."),
  shared: z.boolean().default(false),
});

export const documentPatch = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES),
  shared: z.boolean(),
}).partial();

/** Nome seguro para o caminho no Storage (o nome original fica só no banco). */
export function safeFileName(name: string): string {
  const base = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return (base || "arquivo").slice(-80);
}

export function documentsStorage(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): ComputerStorage | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "https://fszbxwlxuncqefcwttru.supabase.co";
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceKey) return null;
  return supabaseStorage({ url, serviceKey, bucket: DOCUMENTS_BUCKET, fetch: fetchImpl });
}

function need(store: ComputerStorage | null): ComputerStorage {
  if (!store) throw new XodoError("O armazenamento de arquivos ainda não foi configurado no Spherum.", 503);
  return store;
}

const COLUMNS = `d.id, d.client_id, c.name as client_name, d.name, d.category, d.mime, d.size_bytes::float8 as size_bytes, d.shared,
  p.full_name as uploaded_by_name, d.created_at::text`;
const FROM = `from documents d left join clients c on c.id = d.client_id left join profiles p on p.id = d.uploaded_by`;

/** Registra o documento (ainda pendente) e devolve a URL para o navegador subir o arquivo com PUT. */
export async function startUpload(sql: Sql, store: ComputerStorage | null, agencyId: string, userId: string, raw: unknown) {
  const input = documentInput.parse(raw);
  const s = need(store);
  if (input.client_id) {
    const ok = await one(sql, `select 1 from clients where id = $1 and agency_id = $2 and archived_at is null`, [input.client_id, agencyId]);
    if (!ok) throw new XodoError("Cliente não encontrado.", 404);
  }
  const path = `${agencyId}/${input.client_id ?? "agencia"}/${randomUUID()}-${safeFileName(input.name)}`;
  const row = await one<{ id: string }>(
    sql,
    `insert into documents (agency_id, client_id, name, category, mime, size_bytes, storage_path, shared, uploaded_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [agencyId, input.client_id ?? null, input.name, input.category, input.mime || null, input.size, path, input.shared && !!input.client_id, userId],
  );
  return { id: row!.id, upload_url: await s.signedUploadUrl(path) };
}

/** Depois do PUT: confere que o arquivo chegou no Storage e libera o documento. */
export async function finishUpload(sql: Sql, store: ComputerStorage | null, agencyId: string, userId: string, id: string) {
  const s = need(store);
  const doc = await one<{ storage_path: string; status: string }>(sql, `select storage_path, status from documents where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!doc) throw new XodoError("Documento não encontrado.", 404);
  if (doc.status === "pending") {
    // Assinar falha quando o objeto não existe: é a confirmação de que o upload terminou.
    try {
      await s.signedDownloadUrl(doc.storage_path, 10);
    } catch {
      throw new XodoError("O arquivo ainda não chegou. Tente enviar de novo.", 409);
    }
    await sql.query(`update documents set status = 'ready' where id = $1`, [id]);
    await audit(sql, { agencyId, actor: userId, action: "documento_enviado", targetType: "document", targetId: id });
  }
  return getDocument(sql, agencyId, id);
}

export async function getDocument(sql: Sql, agencyId: string, id: string): Promise<DocumentRow> {
  const row = await one<DocumentRow>(sql, `select ${COLUMNS} ${FROM} where d.id = $1 and d.agency_id = $2 and d.status = 'ready'`, [id, agencyId]);
  if (!row) throw new XodoError("Documento não encontrado.", 404);
  return row;
}

/** Documentos prontos da agência (todos ou de um cliente). */
export async function listDocuments(sql: Sql, agencyId: string, clientId?: string | null) {
  return sql.query<DocumentRow>(
    `select ${COLUMNS} ${FROM} where d.agency_id = $1 and d.status = 'ready' and ($2::uuid is null or d.client_id = $2) order by d.created_at desc limit 500`,
    [agencyId, clientId ?? null],
  );
}

/** O que o cliente vê no portal: só o que a agência marcou como visível. */
export async function listSharedDocuments(sql: Sql, clientId: string) {
  return sql.query<DocumentRow>(
    `select ${COLUMNS} ${FROM} where d.client_id = $1 and d.status = 'ready' and d.shared order by d.created_at desc limit 200`,
    [clientId],
  );
}

export async function updateDocument(sql: Sql, agencyId: string, id: string, raw: unknown) {
  const input = documentPatch.parse(raw);
  const doc = await getDocument(sql, agencyId, id);
  if (input.shared && !doc.client_id) throw new XodoError("Só documentos de um cliente aparecem no portal.", 400);
  await sql.query(
    `update documents set name = coalesce($3, name), category = coalesce($4, category), shared = coalesce($5, shared) where id = $1 and agency_id = $2`,
    [id, agencyId, input.name ?? null, input.category ?? null, input.shared ?? null],
  );
  return getDocument(sql, agencyId, id);
}

export async function deleteDocument(sql: Sql, store: ComputerStorage | null, agencyId: string, userId: string, id: string) {
  const doc = await one<{ storage_path: string }>(sql, `select storage_path from documents where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!doc) throw new XodoError("Documento não encontrado.", 404);
  // Primeiro o registro, depois o arquivo: se o arquivo falhar ao sumir, não sobra registro apontando para o nada.
  await sql.query(`delete from documents where id = $1`, [id]);
  await need(store).remove(doc.storage_path).catch((error) => console.error("[documentos] arquivo não removido", doc.storage_path, error));
  await audit(sql, { agencyId, actor: userId, action: "documento_apagado", targetType: "document", targetId: id });
}

/**
 * URL curta para baixar. Vale para a equipe da agência e para quem é do cliente, se o
 * documento estiver visível no portal.
 */
export async function downloadUrl(sql: Sql, store: ComputerStorage | null, userId: string, id: string) {
  const doc = await one<{ storage_path: string; name: string; member: boolean; client_user: boolean; shared: boolean }>(
    sql,
    `select d.storage_path, d.name, d.shared,
            exists (select 1 from agency_members m where m.agency_id = d.agency_id and m.user_id = $2) as member,
            exists (select 1 from client_portal_users u where u.client_id = d.client_id and u.user_id = $2) as client_user
       from documents d join agencies a on a.id = d.agency_id where d.id = $1 and d.status = 'ready' and a.suspended_at is null`,
    [id, userId],
  );
  if (!doc || !(doc.member || (doc.shared && doc.client_user))) throw new XodoError("Documento não encontrado.", 404);
  const url = await need(store).signedDownloadUrl(doc.storage_path, DOWNLOAD_SECONDS);
  return `${url}${url.includes("?") ? "&" : "?"}download=${encodeURIComponent(doc.name)}`;
}

/** Uploads que o navegador começou e nunca concluiu: some com o registro (e o arquivo, se chegou a subir) depois de um dia. */
export async function cleanupPendingUploads(sql: Sql, store: ComputerStorage | null, now = new Date()) {
  const rows = await sql.query<{ id: string; storage_path: string }>(
    `delete from documents where status = 'pending' and created_at < $1::timestamptz - interval '1 day' returning id, storage_path`,
    [now.toISOString()],
  );
  if (store) for (const r of rows) await store.remove(r.storage_path).catch(() => undefined);
  return rows.length;
}
