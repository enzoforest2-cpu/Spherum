# Marca da agência e endereço do portal

Código em `src/lib/core/brand.ts`, rotas `/api/agencies/:id/brand`, `/api/agencies/:id/domain`,
`/api/public/logo/:agencyId` e `/api/public/brand`, e o desvio por domínio em `src/middleware.ts`.
Tabelas e colunas em `supabase/migrations/20261030180000_brand_domains.sql`.

## Marca

Fica no servidor (antes ficava só no navegador de quem configurava): nome, logo (PNG, JPG, WEBP ou
SVG, até 1 MB), cor, onde aparece e "Desenvolvido com Spherum".

| O quê | A partir de |
|---|---|
| Portal do cliente com a marca (logo, nome e cor) | Agência (vale no teste) |
| Portal da agência com a marca, barra na cor da marca | Escala |
| Tirar "Desenvolvido com Spherum" | Escala |

A logo é servida por `/api/public/logo/:agencyId?v=…` (pública, com cache; o SVG não roda script).

## Endereço do portal do cliente

- **Padrão**: `app.spherum.com.br`, com a marca Spherum.
- **Subdomínio** (Agência): `suaagencia.spherum.com.br`. A agência só escolhe o nome; não mexe em DNS.
- **Domínio próprio** (Escala): por exemplo `portal.suaagencia.com.br`. O Spherum cadastra o domínio
  no projeto da Vercel e mostra os registros de DNS que a agência precisa criar (um CNAME para
  `cname.vercel-dns.com`, ou um A para `76.76.21.21` no domínio raiz, e o TXT de verificação quando a
  Vercel pede). "Verificar DNS" confere de novo; com o DNS certo, o domínio fica ativo e a Vercel
  emite o certificado.

Quem abre o subdomínio ou o domínio próprio cai direto no portal do cliente, com uma tela de entrada
com a marca da agência (entrar, esqueci a senha, senha nova). O site, o portal da agência e o admin
não abrem por esses endereços.

## Para ligar

1. Na Vercel, crie um token com acesso ao projeto e defina `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` e
   `VERCEL_TEAM_ID` (sem eles, a tela avisa que o domínio próprio ainda não foi ligado).
2. Para os subdomínios: no DNS de `spherum.com.br` (Hostinger), um registro `*` do tipo CNAME para
   `cname.vercel-dns.com`.
3. No Supabase Auth, em URLs de redirecionamento, inclua `https://*.spherum.com.br/**`. Domínios
   próprios das agências também precisam estar ali para o link de "esqueci a senha" voltar para eles;
   sem isso, o link volta para o site do Spherum.
