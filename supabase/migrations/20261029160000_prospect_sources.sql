-- Fontes da Prospecção: Google Maps, empresas por CNAE (Receita Federal), Instagram e grupos de
-- WhatsApp. Cada contato guarda de onde veio (LGPD) e o site, quando houver.

alter table public.prospect_leads drop constraint if exists prospect_leads_source_check;
alter table public.prospect_leads add constraint prospect_leads_source_check
  check (source in ('planilha', 'colado', 'manual', 'formulario', 'google_maps', 'cnpj', 'instagram', 'grupo_whatsapp'));
alter table public.prospect_leads add column if not exists website text check (char_length(website) <= 300);
alter table public.prospect_leads add column if not exists origin text check (char_length(origin) <= 200);
