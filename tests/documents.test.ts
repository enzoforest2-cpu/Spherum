import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { ComputerStorage } from "../src/lib/computer/provider";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { clientPortal } from "../src/lib/core/client-portal";
import { deleteDocument, downloadUrl, finishUpload, listDocuments, listSharedDocuments, safeFileName, startUpload, updateDocument } from "../src/lib/core/documents";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let db: PGlite;
let sql: Sql;
before(async () => {
  ({ db, sql } = await createTestDb());
});

/** Storage de mentira: guarda os caminhos "enviados" e assina com um token. */
function fakeStore() {
  const files = new Set<string>();
  const store: ComputerStorage = {
    async upload(path) { files.add(path); },
    async signedDownloadUrl(path, seconds) { if (!files.has(path)) throw new Error("Object not found"); return `https://sb.test/storage/v1/object/sign/documents/${path}?token=t${seconds}`; },
    async signedUploadUrl(path) { return `https://sb.test/storage/v1/object/upload/sign/documents/${path}?token=u`; },
    async remove(path) { files.delete(path); },
  };
  return { store, files };
}

async function user(email: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [email]))!.id;
}

test("nome seguro no Storage", () => {
  assert.equal(safeFileName("Contrato São João (final).pdf"), "Contrato-Sao-Joao-final-.pdf");
  assert.equal(safeFileName("../../etc/passwd"), "etc-passwd");
  assert.equal(safeFileName("???"), "arquivo");
});

test("documentos: envio em dois passos, visível no portal só quando marcado, download só para quem pode", async () => {
  const { store, files } = fakeStore();
  const dona = await user(`dona-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Docs" });
  const c = await createClient(sql, agencyId, dona, { name: "Cliente Docs" });
  const cli = await user(`cli-${randomUUID()}@x.com`);
  await sql.query(`insert into client_portal_users (client_id, agency_id, user_id) values ($1, $2, $3)`, [c.id, agencyId, cli]);
  const estranho = await user(`x-${randomUUID()}@x.com`);

  await assert.rejects(startUpload(sql, null, agencyId, dona, { name: "a.pdf", size: 10 }), /armazenamento/);
  await assert.rejects(startUpload(sql, store, agencyId, dona, { name: "a.pdf", size: 60 * 1024 * 1024 }), /50 MB/);

  const up = await startUpload(sql, store, agencyId, dona, { client_id: c.id, name: "Contrato 2026.pdf", category: "Contratos", mime: "application/pdf", size: 2048 });
  assert.match(up.upload_url, new RegExp(`/object/upload/sign/documents/${agencyId}/${c.id}/`));
  assert.equal((await listDocuments(sql, agencyId)).length, 0, "pendente não aparece");
  await assert.rejects(finishUpload(sql, store, agencyId, dona, up.id), /ainda não chegou/);

  const path = (await one<{ storage_path: string }>(sql, `select storage_path from documents where id = $1`, [up.id]))!.storage_path;
  files.add(path);
  const doc = await finishUpload(sql, store, agencyId, dona, up.id);
  assert.deepEqual([doc.name, doc.category, doc.client_name, doc.shared, doc.size_bytes], ["Contrato 2026.pdf", "Contratos", "Cliente Docs", false, 2048]);
  assert.equal((await listDocuments(sql, agencyId, c.id)).length, 1);
  assert.equal((await listSharedDocuments(sql, c.id)).length, 0);

  // O cliente não baixa enquanto não estiver visível; a equipe baixa.
  assert.match(await downloadUrl(sql, store, dona, up.id), /token=t120&download=Contrato%202026\.pdf$/);
  await assert.rejects(downloadUrl(sql, store, cli, up.id), /não encontrado/);
  await updateDocument(sql, agencyId, up.id, { shared: true });
  assert.ok(await downloadUrl(sql, store, cli, up.id));
  await assert.rejects(downloadUrl(sql, store, estranho, up.id), /não encontrado/);
  assert.deepEqual((await clientPortal(sql, c.id, cli)).documents.map((d) => d.name), ["Contrato 2026.pdf"]);

  // RLS: o cliente lê pelo banco só o que está visível; documento interno, não.
  const internal = await startUpload(sql, store, agencyId, dona, { name: "Planilha interna.xlsx", size: 10, shared: true });
  files.add((await one<{ storage_path: string }>(sql, `select storage_path from documents where id = $1`, [internal.id]))!.storage_path);
  const intDoc = await finishUpload(sql, store, agencyId, dona, internal.id);
  assert.equal(intDoc.shared, false, "documento sem cliente nunca fica visível no portal");
  await assert.rejects(updateDocument(sql, agencyId, internal.id, { shared: true }), /Só documentos de um cliente/);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [cli]);
  await db.query(`set role authenticated`);
  try {
    const seen = await db.query<{ name: string }>(`select name from documents order by name`);
    assert.deepEqual(seen.rows.map((r) => r.name), ["Contrato 2026.pdf"]);
  } finally {
    await db.query(`reset role`);
  }

  await deleteDocument(sql, store, agencyId, dona, up.id);
  assert.equal(files.has(path), false);
  assert.equal((await listDocuments(sql, agencyId)).length, 1);
});
