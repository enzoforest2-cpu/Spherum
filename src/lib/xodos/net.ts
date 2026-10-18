import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Guarda contra endereços internos (SSRF) para URLs que a agência informa, como o endereço
 * de um modelo próprio. Adaptado de src/browser/security.ts do OpenDots (MIT).
 */

export function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    // Faixas reservadas exatas (o original bloqueava /16 inteiros, como 192.0.x, que tem endereços públicos).
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) === 6) {
    const normalized = new URL(`http://[${ip}]`).hostname.slice(1, -1);
    const second = Number.parseInt(normalized.split(":")[1] || "0", 16);
    if (normalized.startsWith("2001:") && second < 0x200) return false;
    if (normalized.startsWith("3fff:") && second < 0x1000) return false;
    return /^[23][0-9a-f]{3}:/.test(normalized) && !/^(2001:(0:|db8:|10:|20:)|2002:)/.test(normalized);
  }
  return false;
}

export type Resolver = (hostname: string) => Promise<{ address: string }[]>;

const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true });

/** Aceita só http(s) público, sem usuário e senha na URL. Qualquer porta (ex.: Ollama em 11434). */
export async function assertPublicUrl(input: string, resolve: Resolver = systemResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Endereço inválido.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use um endereço http(s) sem usuário e senha.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Endereços locais não são aceitos: o servidor do Spherum não alcança o seu computador.");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolve(hostname).catch(() => []);
  if (!addresses.length) throw new Error("Não encontrei esse endereço.");
  if (addresses.some((item) => !isPublicAddress(item.address))) {
    throw new Error("Endereços de rede privada não são aceitos.");
  }
  return url;
}
