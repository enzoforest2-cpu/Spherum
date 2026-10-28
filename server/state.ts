import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { one, type Sql } from "../src/xodos/db";
import { setFilesRoot } from "../src/local/files";
import { defaultFilesDir } from "./paths";

/**
 * O que o app precisa ter antes de abrir: a chave mestra (cifra as suas chaves de IA), você
 * como única pessoa e o "dono" dos xodós (no motor do Spherum isso é uma agência; aqui é só
 * você) e as configurações simples (seu nome e a pasta dos xodós).
 */

export type Settings = { nome: string; pasta: string };
export type AppState = { ownerId: string; userId: string; masterKey: string; settings: Settings; dataDir: string };

const SETTINGS_FILE = "configuracoes.json";
const KEY_FILE = "chave-mestra.txt";

export function loadMasterKey(dataDir: string): string {
  const file = path.join(dataDir, KEY_FILE);
  if (existsSync(file)) {
    const key = readFileSync(file, "utf8").trim();
    if (key.length >= 32) return key;
    throw new Error(`A chave mestra em ${file} está corrompida. Sem ela, as chaves de IA salvas não abrem.`);
  }
  const key = randomBytes(48).toString("base64");
  writeFileSync(file, key + "\n", { mode: 0o600 });
  return key;
}

export function readSettings(dataDir: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(path.join(dataDir, SETTINGS_FILE), "utf8"));
    return { nome: String(raw.nome ?? ""), pasta: String(raw.pasta || defaultFilesDir()) };
  } catch {
    return { nome: "", pasta: defaultFilesDir() };
  }
}

export function writeSettings(dataDir: string, s: Settings) {
  writeFileSync(path.join(dataDir, SETTINGS_FILE), JSON.stringify(s, null, 2) + "\n");
}

/** Cria (uma vez) você e o seu espaço; devolve os ids. */
export async function ensureOwner(sql: Sql, name: string): Promise<{ ownerId: string; userId: string }> {
  const existing = await one<{ agency_id: string; user_id: string }>(
    sql,
    `select agency_id, user_id from agency_members where role = 'owner' order by created_at limit 1`,
  );
  if (existing) {
    if (name) await sql.query(`update agencies set name = $2 where id = $1 and name is distinct from $2`, [existing.agency_id, name]);
    return { ownerId: existing.agency_id, userId: existing.user_id };
  }
  const userId = randomUUID();
  await sql.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'voce@xodos.local', $2::jsonb)`, [
    userId,
    JSON.stringify({ name: name || "Você" }),
  ]);
  const agency = await one<{ id: string }>(sql, `insert into agencies (name) values ($1) returning id`, [name || "Você"]);
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'owner')`, [agency!.id, userId]);
  return { ownerId: agency!.id, userId };
}

export async function prepare(sql: Sql, dataDir: string): Promise<AppState> {
  mkdirSync(dataDir, { recursive: true });
  const masterKey = loadMasterKey(dataDir);
  const settings = readSettings(dataDir);
  if (!existsSync(path.join(dataDir, SETTINGS_FILE))) writeSettings(dataDir, settings);
  await setFilesRoot(settings.pasta);
  const { ownerId, userId } = await ensureOwner(sql, settings.nome);
  return { ownerId, userId, masterKey, settings, dataDir };
}
