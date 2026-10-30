-- Alertas para a equipe do Spherum (etapa do agendador falhando, pagamento estranho no Asaas).
-- Cada assunto avisa no máximo uma vez por janela; só o servidor lê e grava.
create table public.staff_alerts (
  id bigint generated always as identity primary key,
  key text not null check (char_length(key) between 1 and 120),
  subject text not null,
  text text not null,
  created_at timestamptz not null default now()
);
create index staff_alerts_key on public.staff_alerts (key, created_at desc);
alter table public.staff_alerts enable row level security;
