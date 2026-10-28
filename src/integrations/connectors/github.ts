import { z } from "zod";
import type { Category } from "../../xodos/policy";
import { appCall, ToolError, openApp, type ToolContext, type ToolDef } from "../../xodos/tools";
import { requestJson } from "../http";
import { clip, tool } from "./common";

/**
 * GitHub da agência: repositórios, busca de issues e PRs, leitura de arquivos, criar issue e
 * comentar. Em repositório público, o que o xodó escreve fica visível para qualquer pessoa,
 * então conta como "envio"; em repositório privado, "alteracao".
 */

const GITHUB = "https://api.github.com";

type GitHub = Awaited<ReturnType<typeof openApp>>;
type Issue = {
  number: number;
  title: string;
  state: string;
  state_reason?: string | null;
  body?: string | null;
  html_url: string;
  repository_url?: string;
  user?: { login: string };
  labels?: ({ name?: string } | string)[];
  assignees?: { login: string }[];
  comments?: number;
  created_at?: string;
  updated_at?: string;
  pull_request?: unknown;
};

const call = <T = Record<string, unknown>>(g: GitHub, path: string, init: Parameters<typeof requestJson>[2] = {}) =>
  appCall(() =>
    requestJson<T>(g.http, `${GITHUB}${path}`, {
      ...init,
      bearer: g.accessToken,
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Spherum" },
    }),
  );

const repo = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "Use dono/repositório")
  .describe("dono/repositório, ex.: agencia/site-cliente");
const number = z.number().int().positive();

const repoPath = (r: string) => `/repos/${r.split("/").map(encodeURIComponent).join("/")}`;
const labelName = (l: { name?: string } | string) => (typeof l === "string" ? l : (l.name ?? ""));

function issueOut(i: Issue) {
  return {
    repo: i.repository_url?.split("/repos/")[1] ?? null,
    numero: i.number,
    tipo: i.pull_request ? "pr" : "issue",
    titulo: i.title,
    estado: i.state,
    autor: i.user?.login ?? null,
    etiquetas: (i.labels ?? []).map(labelName),
    comentarios: i.comments ?? 0,
    atualizado_em: i.updated_at ?? null,
    link: i.html_url,
  };
}

/** Busca do GitHub: a API pede is:issue ou is:pr na consulta. */
export function githubQuery(q: string, kind: "issue" | "pr"): string {
  return /\b(is:(issue|pr|pull-request)|type:(issue|pr))\b/i.test(q) ? q : `${q} is:${kind}`.trim();
}

async function repoCategory(ctx: ToolContext, r: string): Promise<Category> {
  const g = await openApp(ctx, "github");
  const info = await call<{ private: boolean }>(g, repoPath(r));
  return info.private ? "alteracao" : "envio";
}

export const GITHUB_TOOLS: ToolDef[] = [
  tool({
    name: "listar_repositorios_do_github",
    description: "Repositórios do GitHub que a conta conectada acessa, do atualizado mais recentemente para o mais antigo.",
    category: "leitura",
    app: "github",
    input: z.object({ quantidade: z.number().int().min(1).max(100).default(30) }),
    summarize: () => "listar repositórios do GitHub",
    async execute(ctx, i) {
      const g = await openApp(ctx, "github");
      const repos = await call<{ full_name: string; private: boolean; description: string | null; html_url: string; updated_at: string; open_issues_count: number; default_branch: string }[]>(
        g,
        `/user/repos?sort=updated&per_page=${i.quantidade}`,
      );
      return {
        repositorios: repos.map((r) => ({
          repo: r.full_name,
          privado: r.private,
          descricao: r.description,
          issues_abertas: r.open_issues_count,
          branch_principal: r.default_branch,
          atualizado_em: r.updated_at,
          link: r.html_url,
        })),
      };
    },
  }),
  tool({
    name: "buscar_no_github",
    description:
      "Busca issues ou pull requests no GitHub com a sintaxe de busca do GitHub (repo:dono/nome, is:open, label:bug, assignee:@me, author:…).",
    category: "leitura",
    app: "github",
    input: z.object({
      busca: z.string().min(1).max(500),
      tipo: z.enum(["issue", "pr"]).default("issue"),
      quantidade: z.number().int().min(1).max(50).default(20),
    }),
    summarize: (i) => `buscar no GitHub (${i.busca})`,
    async execute(ctx, i) {
      const g = await openApp(ctx, "github");
      const q = githubQuery(i.busca, i.tipo);
      const r = await call<{ total_count: number; items: Issue[] }>(
        g,
        `/search/issues?${new URLSearchParams({ q, per_page: String(i.quantidade), sort: "updated" })}`,
      );
      return { total: r.total_count, resultados: r.items.map(issueOut) };
    },
  }),
  tool({
    name: "ler_issue_do_github",
    description: "Lê uma issue ou pull request do GitHub com a descrição e os comentários.",
    category: "leitura",
    app: "github",
    input: z.object({ repo, numero: number }),
    summarize: (i) => `ler ${i.repo}#${i.numero}`,
    async execute(ctx, i) {
      const g = await openApp(ctx, "github");
      const base = `${repoPath(i.repo)}/issues/${i.numero}`;
      const issue = await call<Issue>(g, base);
      const comments = await call<{ user?: { login: string }; body?: string; created_at?: string }[]>(g, `${base}/comments?per_page=50`);
      const out: Record<string, unknown> = {
        ...issueOut(issue),
        repo: i.repo,
        descricao: clip(issue.body ?? "", 8_000),
        responsaveis: (issue.assignees ?? []).map((a) => a.login),
        criado_em: issue.created_at ?? null,
        comentarios: comments.map((c) => ({ autor: c.user?.login ?? null, quando: c.created_at ?? null, texto: clip(c.body ?? "", 2_000) })),
      };
      if (issue.pull_request) {
        const pr = await call<{ merged: boolean; draft?: boolean; head: { ref: string }; base: { ref: string }; changed_files: number; additions: number; deletions: number }>(
          g,
          `${repoPath(i.repo)}/pulls/${i.numero}`,
        );
        out.pr = { mesclado: pr.merged, rascunho: pr.draft ?? false, de: pr.head.ref, para: pr.base.ref, arquivos: pr.changed_files, linhas_adicionadas: pr.additions, linhas_removidas: pr.deletions };
      }
      return out;
    },
  }),
  tool({
    name: "ler_arquivo_do_github",
    description: "Lê um arquivo (ou lista uma pasta) de um repositório do GitHub.",
    category: "leitura",
    app: "github",
    input: z.object({
      repo,
      caminho: z.string().max(500).default("").describe("Caminho do arquivo ou da pasta; vazio para a raiz"),
      ref: z.string().max(200).optional().describe("Branch, tag ou commit"),
    }),
    summarize: (i) => `ler ${i.repo}/${i.caminho}`,
    async execute(ctx, i) {
      const g = await openApp(ctx, "github");
      const path = i.caminho.split("/").filter(Boolean).map(encodeURIComponent).join("/");
      const r = await call<unknown>(g, `${repoPath(i.repo)}/contents/${path}${i.ref ? `?ref=${encodeURIComponent(i.ref)}` : ""}`);
      if (Array.isArray(r)) {
        return { pasta: i.caminho || "/", itens: (r as { name: string; type: string; path: string }[]).map((f) => ({ nome: f.name, tipo: f.type, caminho: f.path })) };
      }
      const file = r as { type: string; encoding?: string; content?: string; size?: number; html_url?: string };
      if (file.type !== "file") throw new ToolError(`Isso é um ${file.type}, não um arquivo.`);
      if (file.encoding !== "base64" || !file.content) throw new ToolError("Arquivo grande demais para ler por aqui. Abra pelo link.");
      const text = Buffer.from(file.content, "base64").toString("utf8");
      if (/\u0000/.test(text)) throw new ToolError("É um arquivo binário; não dá para ler como texto.");
      return { arquivo: i.caminho, tamanho: file.size ?? null, link: file.html_url ?? null, conteudo: clip(text, 30_000) };
    },
  }),
  tool({
    name: "criar_issue_no_github",
    description: "Abre uma issue num repositório. Em repositório público, segue a autonomia de envio (fica visível para todos).",
    category: "envio",
    app: "github",
    input: z.object({
      repo,
      titulo: z.string().min(1).max(256),
      texto: z.string().max(60_000).optional(),
      etiquetas: z.array(z.string().max(50)).max(10).default([]),
      responsaveis: z.array(z.string().max(39)).max(10).default([]),
    }),
    summarize: (i) => `abrir a issue "${i.titulo}" em ${i.repo}`,
    categoryFor: (ctx, i) => repoCategory(ctx, i.repo),
    async execute(ctx, i) {
      const g = await openApp(ctx, "github");
      const issue = await call<Issue>(g, `${repoPath(i.repo)}/issues`, {
        method: "POST",
        json: { title: i.titulo, body: i.texto, labels: i.etiquetas, assignees: i.responsaveis },
      });
      return { numero: issue.number, link: issue.html_url };
    },
  }),
  tool({
    name: "comentar_no_github",
    description: "Comenta numa issue ou pull request. Em repositório público, segue a autonomia de envio.",
    category: "envio",
    app: "github",
    input: z.object({ repo, numero: number, texto: z.string().min(1).max(60_000) }),
    summarize: (i) => `comentar em ${i.repo}#${i.numero}: "${clip(i.texto, 120)}"`,
    categoryFor: (ctx, i) => repoCategory(ctx, i.repo),
    async execute(ctx, i) {
      const g = await openApp(ctx, "github");
      const c = await call<{ html_url: string }>(g, `${repoPath(i.repo)}/issues/${i.numero}/comments`, { method: "POST", json: { body: i.texto } });
      return { comentado: true, link: c.html_url };
    },
  }),
  tool({
    name: "mudar_estado_da_issue",
    description: "Fecha ou reabre uma issue (ou PR) do GitHub.",
    category: "alteracao",
    app: "github",
    input: z.object({
      repo,
      numero: number,
      estado: z.enum(["fechada", "aberta"]),
      motivo: z.enum(["concluida", "nao_planejada"]).optional().describe("Ao fechar uma issue"),
    }),
    summarize: (i) => `${i.estado === "fechada" ? "fechar" : "reabrir"} ${i.repo}#${i.numero}`,
    async execute(ctx, i) {
      const g = await openApp(ctx, "github");
      const json: Record<string, unknown> = { state: i.estado === "fechada" ? "closed" : "open" };
      if (i.estado === "fechada" && i.motivo) json.state_reason = i.motivo === "concluida" ? "completed" : "not_planned";
      const issue = await call<Issue>(g, `${repoPath(i.repo)}/issues/${i.numero}`, { method: "PATCH", json });
      return { numero: issue.number, estado: issue.state, link: issue.html_url };
    },
  }),
];
