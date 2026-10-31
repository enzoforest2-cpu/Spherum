// Monta o pacote para Windows: dist/Xodos-windows.zip, com o Node portátil dentro.
// Quem recebe só descompacta e dá dois cliques em "Abrir Xodos.bat"; não precisa instalar nada.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "v22.23.4";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const out = path.join(dist, "Xodos");
const app = path.join(out, "app");
const cache = path.join(root, ".cache");

const crlf = (text) => text.replace(/\r?\n/g, "\r\n");
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
mkdirSync(cache, { recursive: true });

// 1. Tela e servidor
run("node", ["scripts/build-ui.mjs"]);
await build({
  entryPoints: [path.join(root, "server/main.ts")],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(app, "main.mjs"),
  logLevel: "warning",
});
cpSync(path.join(root, "ui"), path.join(app, "ui"), { recursive: true });
cpSync(path.join(root, "db"), path.join(app, "db"), { recursive: true });

// 2. Bibliotecas (só as de execução; nenhuma é nativa, então as baixadas aqui servem no Windows)
cpSync(path.join(root, "package.json"), path.join(app, "package.json"));
cpSync(path.join(root, "package-lock.json"), path.join(app, "package-lock.json"));
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], app);

// 3. Node portátil para Windows (só o node.exe)
const zipName = `node-${NODE_VERSION}-win-x64.zip`;
const zipPath = path.join(cache, zipName);
if (!existsSync(zipPath)) {
  console.log(`Baixando ${zipName}...`);
  const res = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/${zipName}`);
  if (!res.ok) throw new Error(`Download do Node falhou: ${res.status}`);
  await pipeline(res.body, createWriteStream(zipPath));
}
mkdirSync(path.join(out, "node"), { recursive: true });
run("python3", [
  "-c",
  `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); open(sys.argv[2],'wb').write(z.read(sys.argv[3]))`,
  zipPath,
  path.join(out, "node", "node.exe"),
  `node-${NODE_VERSION}-win-x64/node.exe`,
]);

// 4. Atalhos e guia
writeFileSync(
  path.join(out, "Abrir Xodos.bat"),
  crlf(`@echo off
chcp 65001 >nul
title Xodos
cd /d "%~dp0"
if /i "%~1"=="/fundo" set XODOS_NAO_ABRIR=1
"%~dp0node\\node.exe" "%~dp0app\\main.mjs"
if errorlevel 1 (
  echo.
  echo Algo deu errado. Tire um print desta janela e mande para quem te ajuda.
  pause
)
`),
);
writeFileSync(
  path.join(out, "Iniciar com o Windows.bat"),
  crlf(`@echo off
chcp 65001 >nul
set "LNK=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Xodos.lnk"
if exist "%LNK%" (
  del "%LNK%"
  echo Pronto: os Xodos NAO vao mais abrir sozinhos quando o computador ligar.
  pause
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath='%~dp0Abrir Xodos.bat'; $s.Arguments='/fundo'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if exist "%LNK%" (
  echo Pronto: os Xodos vao abrir sozinhos, minimizados, sempre que o computador ligar.
  echo Assim as rotinas rodam no horario. Para desfazer, abra este arquivo de novo.
) else (
  echo Nao consegui criar o atalho de inicializacao.
)
pause
`),
);
writeFileSync(
  path.join(out, "LEIA-ME.txt"),
  crlf(`XODÓS — seus ajudantes de IA, no seu computador
================================================

ABRIR
  Dê dois cliques em "Abrir Xodos.bat".
  Uma janela preta abre (é o app trabalhando) e o navegador abre a tela.
  Deixe a janela preta aberta (pode minimizar). Fechar a janela = fechar os Xodós.

  Se a tela não abrir sozinha, abra o navegador e vá em:  http://127.0.0.1:4747

ABRIR SOZINHO QUANDO O COMPUTADOR LIGAR (para as rotinas rodarem no horário)
  Dê dois cliques em "Iniciar com o Windows.bat". Para desfazer, abra de novo.

ATALHO NA ÁREA DE TRABALHO
  Clique com o botão direito em "Abrir Xodos.bat" > Enviar para > Área de trabalho.

ONDE FICAM AS COISAS
  - Seus dados (conversas, memória, chaves cifradas):  %LOCALAPPDATA%\\Xodos
  - Arquivos que os xodós leem e escrevem:            Documentos\\Xodós
  Para fazer backup, copie essas duas pastas.
  Não apague o arquivo "chave-mestra.txt": sem ele, as chaves de IA salvas não abrem.

ATUALIZAR
  Feche os Xodós, apague esta pasta e descompacte a versão nova no mesmo lugar.
  Seus dados ficam em %LOCALAPPDATA%\\Xodos e não se perdem.
`),
);

// 5. Zip
const zipOut = path.join(dist, "Xodos-windows.zip");
rmSync(zipOut, { force: true });
run("python3", [
  "-c",
  `import os,sys,zipfile
src,dst=sys.argv[1],sys.argv[2]
base=os.path.dirname(src)
with zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for d,_,fs in os.walk(src):
        for f in fs:
            p=os.path.join(d,f); z.write(p,os.path.relpath(p,base))`,
  out,
  zipOut,
]);
console.log(`Pacote pronto: ${zipOut}`);
