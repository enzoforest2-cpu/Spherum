# Busca por IA

Como cada cliente aparece quando alguém pergunta a um assistente de IA. Código em
`src/lib/core/aivis.ts` (chamada aos modelos em `aivis-llm.ts`), tabelas em
`supabase/migrations/20261022300000_ai_visibility.sql`.

- **Perguntas**: até 20 por cliente, do jeito que um cliente do cliente perguntaria, com a cidade.
  Pergunta nova é checada na hora; todas são checadas de novo toda segunda (cron).
- **Modelos**: um por provedor com chave cadastrada pela agência em Xodós (OpenAI = ChatGPT,
  Google = Gemini, Anthropic = Claude, xAI = Grok, Mistral, DeepSeek), sempre o mais barato do
  catálogo. O custo entra em `ai_usage` com `purpose = 'busca_ia'` (aparece no DRE como Xodó).
  É a resposta do modelo pela API, sem a busca na web dos aplicativos; serve como termômetro de
  como os modelos conhecem a marca.
- **Leitura da resposta**: se a marca (ou outro nome dela) está numa lista numerada, a posição; se
  aparece no texto, "citado"; senão, "não aparece". Os concorrentes cadastrados citados entram na
  participação nas menções.
- **Dicas**: geradas pelos resultados; cada uma vira tarefa no projeto "Presença nas buscas por IA"
  do cliente.
- Na tela, tocar no cliente já escolhido abre: checar agora, concorrentes e outros nomes, remover
  pergunta.

Ainda não: o painel no portal do cliente (a flag `published` já existe) e o Resumo de IA do Google.

## API

- `GET /api/aivis?agency_id=&client_id=` (CAN_READ).
- `POST /api/aivis` (CAN_USE), com `{ agency_id, client_id, acao }`: `pergunta { question }`,
  `checar { only_new? }`, `config { aliases?, competitors?, published? }`, `tarefa { title, assignee_user?, due_date }`.
- `DELETE /api/aivis/queries/:id` (CAN_USE).
