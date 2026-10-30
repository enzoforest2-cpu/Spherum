import { logoOf } from "@/lib/core/brand";
import { serverSql } from "@/lib/xodos/db";
import { uuid } from "@/lib/xodos/http";

/** GET /api/public/logo/:agencyId  a logo da agência (pública: aparece no portal do cliente e no domínio próprio). */
export async function GET(_request: Request, { params }: { params: Promise<{ agencyId: string }> }) {
  const id = uuid.safeParse((await params).agencyId);
  if (!id.success) return new Response("Não encontrado", { status: 404 });
  const logo = await logoOf(await serverSql(), id.data);
  if (!logo) return new Response("Não encontrado", { status: 404 });
  return new Response(new Uint8Array(logo.body), {
    headers: {
      "content-type": logo.type,
      // A versão vai no endereço (?v=…): pode guardar por bastante tempo.
      "cache-control": "public, max-age=86400, immutable",
      // SVG aberto direto não roda script.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}
