import { homedir } from "node:os";
import path from "node:path";

/**
 * Onde o app guarda as coisas no seu computador.
 *  - Dados (banco, chave mestra, configurações): no Windows, %LOCALAPPDATA%\Xodos; nos outros,
 *    ~/.xodos. Pode trocar com a variável XODOS_DADOS.
 *  - Pasta dos xodós (os arquivos que eles leem e escrevem): Documentos\Xodós. Dá para trocar
 *    nas configurações do app.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XODOS_DADOS?.trim()) return path.resolve(env.XODOS_DADOS.trim());
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "Xodos");
  return path.join(homedir(), ".xodos");
}

export function defaultFilesDir(): string {
  return path.join(homedir(), "Documents", "Xodós");
}

export const PORT = Number(process.env.XODOS_PORTA || 4747);
