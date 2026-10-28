-- Pontuação de leads: critérios da agência (automáticos ou marcados à mão) e as faixas quente/morno.
-- A nota é calculada na leitura do CRM; os critérios manuais marcados em cada negócio ficam em score_flags.

alter table public.agencies add column lead_scoring jsonb;
alter table public.deals add column score_flags text[] not null default '{}';
