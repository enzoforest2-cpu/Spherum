import { createCipheriv, createDecipheriv, randomBytes, scrypt, type ScryptOptions } from "node:crypto";

/**
 * Cofre das chaves de API das agências (formato herdado do Rakazo).
 *
 * AES-256-GCM com chave derivada por scrypt e sal novo a cada gravação. O AAD amarra o
 * texto cifrado à agência e ao registro: copiar a coluna para outra linha não decifra.
 */

const VERSION = "v1:";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SCRYPT: ScryptOptions = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(master: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(master, salt, 32, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export function masterKeyFromEnv(): string {
  const key = process.env.XODOS_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error("XODOS_ENCRYPTION_KEY ausente ou curta (mínimo de 32 caracteres)");
  }
  return key;
}

export function credentialAad(agencyId: string, credentialId: string): string {
  return `ai_credentials:${agencyId}:${credentialId}`;
}

export async function sealSecret(plaintext: string, aad: string, master: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", await deriveKey(master, salt), iv);
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return VERSION + Buffer.concat([salt, iv, cipher.getAuthTag(), enc]).toString("base64");
}

export async function openSecret(ciphertext: string, aad: string, master: string): Promise<string> {
  if (!ciphertext.startsWith(VERSION)) throw new Error("Chave cifrada em formato desconhecido");
  const buf = Buffer.from(ciphertext.slice(VERSION.length), "base64");
  if (buf.length < SALT_BYTES + IV_BYTES + TAG_BYTES) throw new Error("Chave cifrada corrompida");
  const salt = buf.subarray(0, SALT_BYTES);
  const iv = buf.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const tag = buf.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + TAG_BYTES);
  const enc = buf.subarray(SALT_BYTES + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", await deriveKey(master, salt), iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function lastFour(secret: string): string {
  return secret.trim().slice(-4);
}
