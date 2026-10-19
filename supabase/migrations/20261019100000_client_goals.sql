-- Meta de cada cliente (CPL, CPA ou ROAS), usada no portfólio, nas campanhas e nos relatórios.
alter table public.clients
  add column goal_metric text check (goal_metric in ('CPL', 'CPA', 'ROAS')),
  add column goal_value numeric(12, 2) check (goal_value > 0);
