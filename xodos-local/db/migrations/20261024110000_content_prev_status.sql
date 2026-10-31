-- Publicação: de onde o post veio quando começou a sair. Se o processo cair no meio, só o que estava na fila
-- automática volta para a fila; o "publicar agora" vira falha para a agência conferir nas redes antes.
alter table public.content_posts add column if not exists prev_status text;
