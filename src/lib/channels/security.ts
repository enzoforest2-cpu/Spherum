import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ChannelError } from "./types";

/** Verificação das chamadas que chegam dos canais e dos gatilhos. */

/** Corpo máximo aceito numa chamada de canal ou gatilho. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Diferença máxima de relógio aceita na assinatura do Slack (5 minutos). */
export const SLACK_TOLERANCE_S = 300;

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
export const hmacHex = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

/** Comparação em tempo constante, sem vazar o tamanho (compara os hashes). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Segredo aleatório em base64url (seguro para URLs e para o cabeçalho do Telegram). */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** Lê o corpo inteiro, recusando o que passar do limite (sem confiar só no Content-Length). */
export async function readBody(request: Request, max = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > max) throw new ChannelError("Corpo grande demais.", 413);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ChannelError("Corpo grande demais.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Assinatura do Slack: X-Slack-Signature = "v0=" + HMAC-SHA256(signing secret, "v0:" + timestamp + ":" + corpo),
 * com X-Slack-Request-Timestamp de no máximo 5 minutos atrás.
 */
export function verifySlackSignature(
  signingSecret: string,
  headers: { timestamp: string | null; signature: string | null },
  body: string,
  now: Date,
): boolean {
  const { timestamp, signature } = headers;
  if (!signingSecret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SLACK_TOLERANCE_S) return false;
  return safeEqual(signature, `v0=${hmacHex(signingSecret, `v0:${timestamp}:${body}`)}`);
}

/** Assinatura da Meta (WhatsApp) e do GitHub: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(segredo, corpo). */
export function verifyHubSignature(secret: string, header: string | null, body: string): boolean {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  return safeEqual(header, `sha256=${hmacHex(secret, body)}`);
}
