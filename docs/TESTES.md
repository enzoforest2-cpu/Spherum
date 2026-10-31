# Testes do Spherum

| Comando | O que confere | Precisa de |
|---|---|---|
| `npm test` | 520+ testes das regras (banco PGlite em memória) | nada |
| `npm run test:pg` | os mesmos testes num Postgres de verdade, com o driver e as opções da produção | Postgres local (`TEST_PG_URL`) |
| `npm run smoke:links` | cada chamada das telas (`design/`) bate com uma rota e um método do servidor | nada |
| `npm run smoke` | o app compilado de verdade: fluxos de dono, equipe, cliente, admin, API pública, isolamento entre agências, carga (60 pedidos juntos) e todas as rotas GET sem erro 5xx | app rodando + Postgres + login simulado |
| `npm run smoke:e2e` | no navegador: abre cada tela do menu da agência, o portal do cliente e o admin, e confere que os dados criados pelo smoke aparecem | o mesmo do smoke, depois dele |

## Por que o Postgres de verdade

O PGlite dos testes esconde diferenças do driver `postgres` usado em produção. Três defeitos de
produção só apareceram assim: jsonb gravado como texto, savepoint feito à mão derrubando a
transação inteira e id `bigint` chegando como texto.

## Como rodar o smoke

```bash
# 1. Postgres local (qualquer um; aqui na porta 5499)
export TEST_PG_URL=postgres://postgres@127.0.0.1:5499/postgres

# 2. Login simulado do Supabase Auth (aceita tokens montados pelo smoke)
node smoke/fake-auth.mjs &

# 3. App compilado apontando para o login simulado e para o banco do smoke
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=smoke npx next build
DATABASE_URL=postgres://postgres@127.0.0.1:5499/smoke_app XODOS_ENCRYPTION_KEY=chave-de-teste-com-mais-de-32-caracteres \
  CRON_SECRET=smoke-cron-secret APP_URL=http://127.0.0.1:3100 npx next start -p 3100 &

# 4. Testes (o smoke recria o banco smoke_app a cada vez)
SMOKE_PG=postgres://postgres@127.0.0.1:5499 npm run smoke
npm run smoke:e2e
```

Não rode `next build` com o login simulado para publicar: o endereço do login fica gravado no build.
