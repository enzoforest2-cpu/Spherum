# Agendamentos

Páginas públicas para marcar reunião. Código em `src/lib/core/bookings.ts` (Google Agenda em
`bookings-google.ts`), tabelas em `supabase/migrations/20261022230000_bookings.sql`. O navegador só
lê (RLS); o público agenda e cancela pelo servidor.

## Tipos de reunião

Cada tipo tem nome, duração (15, 30, 45, 60 ou 90 min), dias da semana, janela de horas, aviso
mínimo (padrão 2 h), até quantos dias à frente (padrão 30), responsável e, opcionalmente, uma
conexão Google com a Agenda. O link público é `/agenda/<código>`.

## Horários livres

- De 30 em 30 minutos, no fuso de Brasília, dentro dos dias e horas do tipo.
- Saem os horários já marcados com a mesma pessoa (mesmo responsável, em qualquer tipo) ou no mesmo
  tipo.
- Com a Google Agenda ligada, saem também os eventos ocupados dela (cancelados, marcados como
  "livre" e recusados não contam). Se o Google não responde, a página avisa e não oferece horários.

## Ao agendar

1. O horário é conferido de novo (com a agenda) e gravado com uma trava, para duas pessoas não
   pegarem o mesmo horário.
2. Com a agenda ligada: evento com o convidado e link do Meet (o Google manda o convite). Se falhar,
   a reunião continua marcada e o erro fica registrado ("sem evento na agenda").
3. E-mail de confirmação com o link para cancelar (`/agenda/cancelar/<token>`).
4. Quem é contato de cliente fica ligado ao cliente. Quem não é vira negócio no CRM em "Diagnóstico"
   (ou atualiza o próximo passo do negócio aberto com o mesmo e-mail), se o tipo pedir.
5. Aviso no Spherum. No máximo 5 agendamentos por hora por IP em cada tipo.

## Cancelar

- **Convidado**: pelo link do e-mail (pede confirmação). A agência recebe um aviso.
- **Agência**: pela tela, com motivo opcional; o convidado recebe um e-mail.
- Nos dois casos o evento sai da Google Agenda (o Google avisa os convidados).

Tipo com reunião futura marcada não pode ser apagado (desative ou cancele as reuniões).

## API

- `GET /api/bookings?agency_id=` (CAN_READ): `{ types, bookings }`.
- `POST /api/bookings/types` (CAN_USE); `PATCH` e `DELETE /api/bookings/types/:id`;
  `GET /api/bookings/types/:id` devolve os horários livres.
- `DELETE /api/bookings/:id` (CAN_USE), com `{ reason? }`.
- Público: `GET` e `POST /api/public/bookings/:code` (`{ start, name, email, phone?, notes? }`);
  `POST /api/public/bookings/cancel/:token`.

## Regras que valem sempre

- A consulta à agenda do Google acontece dentro da trava do dono: dois tipos de reunião na mesma agenda não passam juntos.
