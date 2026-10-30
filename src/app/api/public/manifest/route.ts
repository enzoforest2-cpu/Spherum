import { NextResponse } from "next/server";
import { brandForHost } from "@/lib/core/brand";
import { serverSql } from "@/lib/xodos/db";

/**
 * GET /api/public/manifest  o "app" do portal do cliente para instalar no celular. No domínio
 * próprio (ou subdomínio) da agência, com o nome, a cor e a logo dela; no Spherum, com a marca Spherum.
 */
export async function GET(request: Request) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const b = await brandForHost(await serverSql(), host).catch(() => null);
  const icons = b?.logo_url
    ? [{ src: b.logo_url, sizes: "any", purpose: "any" }]
    : [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }];
  return NextResponse.json(
    {
      name: b ? b.name : "Spherum · Portal do cliente",
      short_name: (b ? b.name : "Spherum").slice(0, 12),
      description: "Resultados, relatórios, aprovações e conversas com a agência.",
      start_url: b ? "/" : "/cliente",
      scope: "/",
      display: "standalone",
      background_color: "#FFFFFF",
      theme_color: b?.color ?? "#465FFF",
      lang: "pt-BR",
      icons,
    },
    { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=300" } },
  );
}
