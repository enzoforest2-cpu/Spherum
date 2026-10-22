# Estúdio

Criativos com IA na conta da própria agência. Código em `src/lib/core/studio.ts` (provedores,
armazenamento e links em `studio-providers.ts`), tabelas em `supabase/migrations/20261022310000_studio.sql`.

- **Conexão** (dono ou admin): chave da fal.ai (imagem e vídeo) ou token do Replicate (imagem; o token
  é conferido na hora). A chave fica cifrada numa conexão `fal` ou `replicate`; os créditos são
  cobrados direto pelo provedor. Modelos padrão: `fal-ai/qwen-image` e
  `fal-ai/wan/v2.2-a14b/image-to-video` (fal.ai) e `qwen/qwen-image` (Replicate); dá para trocar.
- **Kit da marca** por cliente: produto, estilo das cenas, cores, fonte, título, preço e botão. Na
  tela, tocar no cliente já escolhido abre o kit.
- **Gerar**: o pedido vira um prompt com o kit, sempre sem texto na imagem (título, preço, botão e logo
  são camadas na prévia). Até 4 opções por vez, em feed (1:1) ou Stories (9:16). Cada imagem é baixada
  e guardada em Documentos do cliente (Criativos).
- **Vídeo**: anima uma imagem gerada (5 s) na fila da fal.ai; o cron busca o resultado (desiste depois
  de 2 horas).
- **Enviar para o cliente aprovar**: vira rascunho no Conteúdo (post, carrossel ou Reels) e vai para a
  aprovação no portal. A imagem vai sem as camadas de texto; o título e o botão vão na legenda.
- **Limites por mês** (imagens / vídeos): Solo 0/0, Agência 40/0, Escala 150/20, Rede 500/80,
  Empresarial sem limite.

Ainda não: usar uma foto real do produto como base, exportar a peça com as camadas aplicadas e o
servidor próprio (ComfyUI).

## API

- `GET /api/studio?agency_id=&client_id=` (CAN_READ): kit, conversa com links das imagens (1 hora), uso e configuração.
- `POST /api/studio` (CAN_USE), com `{ agency_id, client_id, acao }`: `gerar { text, format?, count? }`,
  `animar { document_id, text }`, `conteudo { document_ids, title, caption?, publish_at, nets? }`, `kit { kit }`.
- `POST /api/studio/connect` (CAN_MANAGE), com `{ agency_id, provider, key, image_model?, video_model? }`.
