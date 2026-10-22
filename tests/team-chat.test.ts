import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { listTasks } from "../src/lib/core/projects";
import { chatBoard, createChannel, directChannel, listMessages, mentionedXodos, messageToTask, postMessage, setPin } from "../src/lib/core/team-chat";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb, seedXodo } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

const user = async (name: string) =>
  (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`, [`${randomUUID()}@x.com`, name]))!.id;

test("chat da equipe: canais padrão, não lidas, conversa direta, fixar, xodó citado e virar tarefa", async () => {
  const ana = await user("Ana Souza");
  const beto = await user("Beto Lima");
  const caio = await user("Caio Reis");
  const { id: agencyId } = await createAgency(sql, ana, { name: "Agência Chat" });
  for (const u of [beto, caio]) await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'member')`, [agencyId, u]);

  const board = await chatBoard(sql, agencyId, ana);
  assert.deepEqual(board.map((c) => c.name), ["geral", "criação", "tráfego"]);
  assert.equal((await chatBoard(sql, agencyId, ana)).length, 3, "padrões só uma vez");
  const geral = board[0].id;

  await postMessage(sql, agencyId, ana, geral, "Bom dia, time!");
  await postMessage(sql, agencyId, ana, geral, "Reunião às 10h");
  assert.equal((await chatBoard(sql, agencyId, ana))[0].unread, 0, "as próprias não contam");
  assert.equal((await chatBoard(sql, agencyId, beto))[0].unread, 2);
  const msgs = await listMessages(sql, agencyId, beto, geral);
  assert.deepEqual(msgs.map((m) => [m.author_name, m.text]), [["Ana Souza", "Bom dia, time!"], ["Ana Souza", "Reunião às 10h"]]);
  assert.equal((await chatBoard(sql, agencyId, beto))[0].unread, 0);

  const c = await createChannel(sql, agencyId, ana, { name: "Lançamento Verão!" });
  assert.equal((await one<{ name: string }>(sql, `select name from team_channels where id = $1`, [c.id]))!.name, "lancamento-verao");
  await assert.rejects(createChannel(sql, agencyId, ana, { name: "lançamento verão" }), /Já existe/);

  const dm = await directChannel(sql, agencyId, ana, beto);
  assert.equal((await directChannel(sql, agencyId, beto, ana)).id, dm.id, "mesma conversa nos dois sentidos");
  await postMessage(sql, agencyId, beto, dm.id, "Oi Ana");
  const dmRow = (await chatBoard(sql, agencyId, ana)).find((x) => x.kind === "direta")!;
  assert.deepEqual([dmRow.other_name, dmRow.unread], ["Beto Lima", 1]);
  assert.equal((await chatBoard(sql, agencyId, caio)).some((x) => x.kind === "direta"), false, "Caio não vê a conversa");
  await assert.rejects(listMessages(sql, agencyId, caio, dm.id), /não encontrado/);

  await setPin(sql, agencyId, ana, geral, "Entregas até sexta");
  assert.equal((await chatBoard(sql, agencyId, caio))[0].pinned_text, "Entregas até sexta");

  await seedXodo(sql, agencyId, { name: "Pipoca" });
  assert.deepEqual((await mentionedXodos(sql, agencyId, "@pipoca, puxa o relatório")).map((x) => x.name), ["Pipoca"]);
  assert.deepEqual(await mentionedXodos(sql, agencyId, "sem menção"), []);

  const task = await messageToTask(sql, agencyId, ana, { title: "Revisar peças do verão", assignee_user: caio }, new Date("2026-10-22T12:00:00Z"));
  const p = await one<{ id: string; name: string }>(sql, `select id, name from projects where agency_id = $1`, [agencyId]);
  assert.equal(p!.name, "Combinados da equipe");
  await messageToTask(sql, agencyId, ana, { title: "Mandar a pauta" }, new Date("2026-10-22T12:00:00Z"));
  const tasks = await listTasks(sql, agencyId, p!.id);
  assert.deepEqual(tasks.map((t) => t.title), ["Revisar peças do verão", "Mandar a pauta"]);
  assert.ok(task);
});
