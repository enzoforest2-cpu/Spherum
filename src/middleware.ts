import { NextResponse, type NextRequest } from "next/server";

/**
 * Domínio próprio da agência (ex.: portal.suaagencia.com.br) ou subdomínio do Spherum
 * (suaagencia.spherum.com.br): a página inicial é o portal do
 * cliente, com a marca da agência, e as telas do Spherum (site, agência, admin) não abrem por ele.
 * Os domínios do próprio Spherum e as prévias da Vercel seguem as rotas normais (next.config.ts).
 */
const OWN = /^((www|app|status)\.)?spherum\.com\.br$|\.vercel\.app$|^localhost$|^127\.0\.0\.1$/;

export function middleware(request: NextRequest) {
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!host || OWN.test(host)) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (pathname === "/" || pathname === "/cliente") return NextResponse.rewrite(new URL("/prototipo/cliente.html", request.url));
  if (/^\/(agencia|admin|xodo|video|site|prototipo\/(agencia|admin|xodo|video))/.test(pathname)) return NextResponse.redirect(new URL("/", request.url));
  return NextResponse.next();
}

export const config = {
  // Só as páginas: API, arquivos do Next e estáticos passam direto.
  matcher: ["/((?!api/|_next/|favicon|icon|manifest|sw\\.js|f/).*)"],
};
