import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appCall, ToolError, openApp, type ToolDef } from "../../xodos/tools";
import { requestJson, requestText } from "../http";
import { clip, tool } from "./common";

/**
 * Google Drive: buscar, ler (Docs, Planilhas, Apresentações e arquivos de texto) e criar
 * documentos. Com `drive.file`, o xodó só altera o que ele mesmo criou; o resto é leitura.
 */

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const MAX_DOWNLOAD = 2 * 1024 * 1024;

type Drive = Awaited<ReturnType<typeof openApp>>;
type File = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
};

const FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName,emailAddress)";
const ALL_DRIVES = "supportsAllDrives=true";

/** Como exportar cada tipo do Google para texto. */
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|javascript|x-yaml|yaml))/;

const KIND: Record<string, string> = {
  "application/vnd.google-apps.document": "Documento",
  "application/vnd.google-apps.spreadsheet": "Planilha",
  "application/vnd.google-apps.presentation": "Apresentação",
  "application/vnd.google-apps.folder": "Pasta",
  "application/pdf": "PDF",
};

const fileOut = (f: File) => ({
  id: f.id,
  nome: f.name,
  tipo: KIND[f.mimeType] ?? f.mimeType,
  alterado_em: f.modifiedTime ?? null,
  dono: f.owners?.[0]?.displayName ?? f.owners?.[0]?.emailAddress ?? null,
  link: f.webViewLink ?? null,
});

const TYPE_FILTER = {
  documento: "application/vnd.google-apps.document",
  planilha: "application/vnd.google-apps.spreadsheet",
  apresentacao: "application/vnd.google-apps.presentation",
  pasta: "application/vnd.google-apps.folder",
  pdf: "application/pdf",
} as const;

/** Texto na consulta do Drive: aspas e barras escapadas. */
const quote = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function driveQuery(i: { busca?: string; tipo?: keyof typeof TYPE_FILTER; pasta?: string }): string {
  const parts = ["trashed = false"];
  if (i.busca) parts.push(`(name contains ${quote(i.busca)} or fullText contains ${quote(i.busca)})`);
  if (i.tipo) parts.push(`mimeType = '${TYPE_FILTER[i.tipo]}'`);
  if (i.pasta) parts.push(`${quote(i.pasta)} in parents`);
  return parts.join(" and ");
}

const getJson = <T>(d: Drive, url: string, init: Parameters<typeof requestJson>[2] = {}) =>
  appCall(() => requestJson<T>(d.http, url, { ...init, bearer: d.accessToken }));
const getText = (d: Drive, url: string) => appCall(() => requestText(d.http, url, { bearer: d.accessToken, timeoutMs: 30_000 }));

export const DRIVE_TOOLS: ToolDef[] = [
  tool({
    name: "buscar_no_drive",
    description: "Busca arquivos no Google Drive pelo nome ou pelo conteúdo, do mais recente para o mais antigo.",
    category: "leitura",
    app: "drive",
    input: z.object({
      busca: z.string().max(200).optional(),
      tipo: z.enum(["documento", "planilha", "apresentacao", "pasta", "pdf"]).optional(),
      pasta: z.string().max(100).optional().describe("Id de uma pasta para buscar só dentro dela"),
      quantidade: z.number().int().min(1).max(50).default(20),
    }),
    summarize: (i) => `buscar no Drive${i.busca ? ` (${i.busca})` : ""}`,
    async execute(ctx, i) {
      const d = await openApp(ctx, "drive");
      const params = new URLSearchParams({
        q: driveQuery(i),
        fields: `files(${FIELDS})`,
        pageSize: String(i.quantidade),
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
      });
      // O Drive não ordena quando a busca é por conteúdo (fullText).
      if (!i.busca) params.set("orderBy", "modifiedTime desc");
      const { files = [] } = await getJson<{ files?: File[] }>(d, `${DRIVE}/files?${params}`);
      return { arquivos: files.map(fileOut) };
    },
  }),
  tool({
    name: "ler_arquivo_do_drive",
    description: "Lê o conteúdo de um Documento, Planilha (primeira aba, em CSV), Apresentação ou arquivo de texto do Drive.",
    category: "leitura",
    app: "drive",
    input: z.object({ id: z.string().min(1).max(100) }),
    summarize: () => "ler arquivo do Drive",
    async execute(ctx, i) {
      const d = await openApp(ctx, "drive");
      const id = encodeURIComponent(i.id);
      const file = await getJson<File>(d, `${DRIVE}/files/${id}?fields=${FIELDS}&${ALL_DRIVES}`);
      const out = fileOut(file);
      const exportAs = EXPORTS[file.mimeType];
      if (exportAs) {
        return { ...out, conteudo: clip(await getText(d, `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`), 30_000) };
      }
      if (TEXT_TYPES.test(file.mimeType)) {
        if (Number(file.size ?? 0) > MAX_DOWNLOAD) throw new ToolError("Arquivo grande demais para ler (máximo de 2 MB).");
        return { ...out, conteudo: clip(await getText(d, `${DRIVE}/files/${id}?alt=media&${ALL_DRIVES}`), 30_000) };
      }
      return { ...out, conteudo: null, aviso: "Ainda não consigo ler esse tipo de arquivo. Abra pelo link." };
    },
  }),
  tool({
    name: "criar_documento_no_drive",
    description: "Cria um Documento Google com o texto informado (por exemplo, um relatório ou uma pauta).",
    category: "alteracao",
    app: "drive",
    input: z.object({
      nome: z.string().min(1).max(200),
      texto: z.string().min(1).max(200_000),
      pasta: z.string().max(100).optional().describe("Id da pasta onde salvar"),
    }),
    summarize: (i) => `criar o documento "${i.nome}" no Drive`,
    async execute(ctx, i) {
      const d = await openApp(ctx, "drive");
      const boundary = `spherum-${randomUUID()}`;
      const metadata = { name: i.nome, mimeType: "application/vnd.google-apps.document", ...(i.pasta ? { parents: [i.pasta] } : {}) };
      const body = [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify(metadata),
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "",
        i.texto,
        `--${boundary}--`,
        "",
      ].join("\r\n");
      const created = await getJson<File>(d, `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}&${ALL_DRIVES}`, {
        method: "POST",
        raw: { body, contentType: `multipart/related; boundary=${boundary}` },
        timeoutMs: 30_000,
      });
      return fileOut(created);
    },
  }),
];
