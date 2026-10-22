# Conteúdo e Publicar

As duas telas usam a mesma fila de posts. Código em `src/lib/core/content.ts` (Meta em
`content-meta.ts`), tabelas em `supabase/migrations/20261022240000_content.sql`. O navegador só lê
(RLS); toda escrita passa pelo servidor.

## Caminho de um post

| Status | Quer dizer |
| --- | --- |
| `draft` | Rascunho da agência |
| `wait` | Com o cliente, no portal (uma aprovação em `client_approvals`) |
| `fix` | O cliente pediu ajustes (o comentário dele fica no post) |
| `appr` | Aprovado pelo cliente |
| `sched` | Na fila: sai sozinho na hora marcada |
| `publishing` | Saindo agora |
| `pub` | Publicado |
| `fail` | Não saiu (o erro fica no post e vira aviso) |

- **Aprovação**: "Enviar para aprovação" cria a aprovação no portal com rede, formato, data, legenda e
  o primeiro arquivo do cliente. A decisão do cliente (pelo `decideApproval` de sempre) move o post.
- **Nova versão**: sobe a versão, cancela o pedido aberto e manda de novo.
- **Publicar sozinho quando aprovado** (`agencies.content_auto_publish`): o aprovado já entra na fila.
- **Agendar sem aprovação**: a agência pode pular o cliente (fica registrado no post).
- Mexer na legenda ou nos arquivos de um post já aprovado volta para rascunho.
- Comentário da equipe no post também vai para a conversa com o cliente no portal.

## Publicação (API da Meta)

- Cada cliente liga a página do Facebook e o Instagram profissional dela (`client_social`), a partir
  de uma conexão da Meta com o app "Instagram e Facebook" (`meta_social`: `pages_show_list`,
  `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`).
- Os arquivos vêm de Documentos (imagem ou vídeo); a Meta baixa por um link assinado de 1 hora.
- **Instagram**: post (foto ou vídeo como Reels), carrossel (2 a 10), Reels (vídeo) e Story. O vídeo
  espera processar na Meta antes de publicar.
- **Facebook**: só texto, foto, várias fotos num post ou vídeo, com o token da página.
- O Instagram não publica sem arquivo; Story só no Instagram.
- O cron publica o que está na fila e passou da hora. Falha passageira volta para a fila (até 3
  tentativas); erro de regra ou de acesso vira `fail`. Rede que já saiu não sai de novo. Publicação
  travada há 15 minutos volta para a fila.
- "Marcar como publicado" registra o que saiu por fora do Spherum.

## API (CAN_USE, salvo indicado)

- `GET /api/content?agency_id=&from=&to=` (CAN_READ): `{ auto_publish, posts (com comments), social, stats }`.
- `POST /api/content`, com `{ agency_id, client_id, title, publish_at, caption?, kind?, nets?, media_ids?, schedule? }`.
- `PATCH /api/content` (CAN_MANAGE), com `{ agency_id, auto_publish }`.
- `PATCH /api/content/:id`, com `{ acao }`: `editar { post }`, `aprovacao { note? }`, `versao { note? }`,
  `comentar { text }`, `agendar { publish_at? }`, `desagendar`, `publicar`, `publicado { url? }`.
- `DELETE /api/content/:id`.
- `GET /api/content/social?agency_id=&connection_id=`: páginas que a conexão administra.
- `PUT` e `DELETE /api/content/social/:clientId`: liga ou desliga os perfis do cliente.
