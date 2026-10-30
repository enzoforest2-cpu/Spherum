-- Disparos com variação: a IA da agência escreve as variações (custo em ai_usage, finalidade própria).
alter table public.ai_usage drop constraint if exists ai_usage_purpose_check;
alter table public.ai_usage add constraint ai_usage_purpose_check check (purpose in ('execucao', 'captura', 'arrumacao', 'busca_ia', 'prospeccao'));
