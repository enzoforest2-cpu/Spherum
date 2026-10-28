import { NextResponse } from "next/server";
import { databaseUrl, serverSql } from "@/lib/xodos/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/saude  diz se o servidor fala com o banco. Em caso de erro, mostra só o tipo do
 * problema e o formato do endereço (porta, se é o pooler), nunca a senha nem o endereço inteiro.
 */
export async function GET() {
  const raw = databaseUrl(process.env);
  let formato: Record<string, unknown> = { configurada: Boolean(raw) };
  if (raw) {
    try {
      const u = new URL(raw);
      formato = { configurada: true, protocolo: u.protocol, porta: u.port || null, pooler: u.hostname.includes("pooler"), tem_senha: Boolean(u.password), usuario_com_projeto: u.username.includes(".") };
    } catch {
      // Só a forma do texto (nada da senha): como começa, tamanho, espaços, quantos @.
      const v = raw.trim();
      const inicio = (v.match(/^[a-z][a-z0-9+.-]*:\/\/|^[a-z_]+=|^psql\b|^[a-z]+\s/i)?.[0] ?? v.slice(0, 1).replace(/[a-z0-9]/i, "letra/número")).slice(0, 15);
      formato = { configurada: true, endereco_invalido: true, comeca_com: inicio, tamanho: v.length, tem_espaco: /\s/.test(v), arrobas: (v.match(/@/g) ?? []).length };
    }
  }
  try {
    const sql = await serverSql();
    await sql.query("select 1");
    return NextResponse.json({ banco: "ok", formato });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const message = String(e.message ?? "").replace(/postgres(ql)?:\/\/\S+/gi, "[endereço]");
    return NextResponse.json({ banco: "erro", codigo: e.code ?? null, mensagem: message.slice(0, 200), formato }, { status: 500 });
  }
}
