// Portado de milind-soni/openmausbot server/safety-floor.ts (Apache-2.0): o lexer e a nunca-lista,
// aqui só na leitura POSIX (a máquina é um Linux). O texto do piso vem de server/safety-floor-gate.ts,
// traduzido. Em cima disso entram as regras do Spherum (seção 6 do desenho) e a categoria do terminal.
//
// Invariante de segurança: uma linha que não dá para ler até o fim é "não consegui ler", nunca "limpo";
// um bloqueio achado antes dela continua valendo. Palavras usadas como dado (um echo, a mensagem de um
// commit, o corpo de um here-doc) nunca são um comando.
import type { Category } from "../xodos/policy";
import { FOLDERS } from "./desktop";

/**
 * Veredito do classificador do terminal.
 *  - deny: nunca é aprovado, em nenhuma autonomia (nunca-lista). O gateway recusa e manda o texto.
 *  - ask: sempre pergunta a uma pessoa (comando ilegível).
 *  - allow: segue a categoria junto da autonomia do xodó (quem decide é o decideApproval).
 */
export type CommandVerdict = { verdict: "deny" | "ask" | "allow"; category: Category; reason: string | null };

/** O que o modelo recebe no lugar de uma aprovação quando o comando cai na nunca-lista. */
export const DENY_MESSAGE =
  "Este comando nunca é aprovado automaticamente, em nenhum nível de autonomia. Não tente de novo nem procure outro jeito; diga à pessoa o que você queria fazer.";
/** Comando que não deu para ler com segurança: uma pessoa precisa olhar. */
export const ASK_MESSAGE =
  "Não consegui ler este comando com segurança (aspas sem fechar, aninhamento demais ou caracteres estranhos). Uma pessoa precisa olhar antes de rodar.";

/** Linha maior que isto não é lida: volta como "ilegível" sem ser analisada. */
export const MAX_COMMAND_LENGTH = 32 * 1024;

export function classifyCommand(command: string): CommandVerdict {
  if (typeof command !== "string" || !command.trim()) return allow("leitura");
  if (command.length > MAX_COMMAND_LENGTH) return ask();
  // Caracteres de controle (menos tab, nova linha e retorno) deixam a linha ilegível.
  const hasControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command);
  try {
    // Um comando não pode forjar os marcadores do lexer.
    const line = command.replace(MARKERS, "�");
    const out = scan(line, 0);
    if (out.kind === "deny") return deny(out.category);
    if (out.kind === "ask") return ask();
    if (hasControl) return ask();
    return allow(out.category);
  } catch {
    return ask();
  }
}

function allow(category: Category): CommandVerdict {
  return { verdict: "allow", category, reason: null };
}
function deny(category: Category): CommandVerdict {
  return { verdict: "deny", category, reason: DENY_MESSAGE };
}
function ask(): CommandVerdict {
  return { verdict: "ask", category: "alteracao", reason: ASK_MESSAGE };
}

// ------------------------------------------------------------------------------------------------
// Lexer POSIX (portado do OpenMausBot, sem a parte do Windows).
// ------------------------------------------------------------------------------------------------

/** Marcador do diretório pessoal: `~` ou `$HOME` sem aspas. */
const HOME = "";
/** Marcador de qualquer coisa trocada em tempo de execução; palavra que o contém é desconhecida. */
const DYNAMIC = "";
const MARKERS = /[]/g;

/** HOME do ambiente limpo da máquina (XODO_ENV em desktop.ts define HOME=/home/xodo). */
const MACHINE_HOME = "/home/xodo";

interface Command {
  /** Sem aspas; substituições viram HOME ou DYNAMIC. */
  words: string[];
  starts: number[];
  /** Alvos de redirecionamento de escrita. */
  writes: string[];
  from: number;
  to: number;
}

interface Reading {
  commands: Command[];
  /** O texto fora de toda aspa, here-doc e comentário. */
  bare: string;
  /** Falso quando algo não fechou ou aninhou fundo demais: o resto não foi lido. */
  synced: boolean;
}

const MAX_NESTING = 40;
/** Palavras que vêm antes de um comando sem serem um. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);

function lex(source: string): Reading {
  const commands: Command[] = [];
  const heredocs: Array<{ end: string; tabs: boolean }> = [];
  let bare = "";
  let at = 0;
  let nesting = 0;
  let synced = true;

  const variable = (name: string): string => (/^HOME(?::?\?[^}]*)?$/.test(name) ? HOME : DYNAMIC);

  const endOf = (mark: string, from: number): number => {
    const found = source.indexOf(mark, from);
    return found === -1 ? source.length : found;
  };

  const balanced = (open: string, shut: string, inDoubleQuotes: boolean): string => {
    const from = at;
    for (let depth = 1; at < source.length; at++) {
      const c = source[at];
      if (c === "\\") at++;
      else if (c === "'" && !inDoubleQuotes) at = endOf("'", at + 1);
      else if (c === '"') {
        for (at++; at < source.length && source[at] !== '"'; at++) if (source[at] === "\\") at++;
      } else if (c === open) depth++;
      else if (c === shut && --depth === 0) return source.slice(from, at++);
    }
    synced = false;
    return source.slice(from);
  };

  const variableAt = (inDoubleQuotes: boolean): string => {
    const next = source[at + 1];
    if (next === "{") {
      at += 2;
      return variable(balanced("{", "}", inDoubleQuotes));
    }
    if (next === "'" && !inDoubleQuotes) {
      // $'…' decodifica escapes como \x2f, então seu texto não é lido aqui.
      for (at += 2; at < source.length && source[at] !== "'"; at++) if (source[at] === "\\") at++;
      if (at >= source.length) synced = false;
      at++;
      return DYNAMIC;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at + 1, at + 130))?.[0];
    if (name) {
      at += 1 + name.length;
      return variable(name);
    }
    if (next !== undefined && /[0-9@*#?$!_-]/.test(next)) {
      at += 2;
      return DYNAMIC;
    }
    at++;
    return "$";
  };

  function script(close: string | null): boolean {
    let command: Command = { words: [], starts: [], writes: [], from: at, to: at };
    let word = null as string | null;
    let wordAt = 0;
    let token = 0;
    let next: "argument" | "write" | "read" | "heredoc" | "heredoc-tabs" = "argument";
    let depth = 0;

    const add = (text: string) => {
      if (word === null) {
        word = "";
        wordAt = token;
      }
      word += text;
    };
    const endWord = () => {
      if (word === null) return;
      if (next === "argument") {
        command.words.push(word);
        command.starts.push(wordAt);
      } else if (next === "write") command.writes.push(word);
      else if (next !== "read") heredocs.push({ end: word, tabs: next === "heredoc-tabs" });
      word = null;
      next = "argument";
    };
    const cut = (skip: number) => {
      endWord();
      next = "argument";
      command.to = at;
      if (command.words.length || command.writes.length) commands.push(command);
      at += skip;
      command = { words: [], starts: [], writes: [], from: at, to: at };
    };
    const nested = (shut: string) => {
      if (++nesting > MAX_NESTING) {
        at = source.length;
        synced = false;
      } else if (!script(shut)) synced = false;
      nesting--;
    };
    const dollar = (inDoubleQuotes: boolean): string => {
      if (source[at + 1] !== "(") return variableAt(inDoubleQuotes);
      at += 2;
      nested(")");
      return DYNAMIC;
    };
    const quoted = () => {
      while (at < source.length) {
        const c = source[at];
        const after = source[at + 1];
        if (c === '"') {
          at++;
          return;
        }
        if (c === "\\" && after !== undefined && "$`\"\\\n".includes(after)) {
          if (after !== "\n") add(after);
          at += 2;
        } else if (c === "$") add(dollar(true));
        else if (c === "`") {
          at++;
          nested("`");
          add(DYNAMIC);
        } else {
          add(c);
          at++;
        }
      }
      synced = false;
    };

    while (at < source.length) {
      const c = source[at];
      const after = source[at + 1];
      token = at;
      if (c === close && depth === 0) {
        cut(1);
        return true;
      }
      if (c === "\\") {
        // Uma nova linha escapada continua a linha; o resto é ele mesmo.
        if (after !== "\n" && after !== undefined) add(after);
        at += 2;
      } else if (c === "'") {
        const end = endOf("'", at + 1);
        if (end === source.length) synced = false;
        add(source.slice(at + 1, end));
        at = end + 1;
      } else if (c === '"') {
        add("");
        at++;
        quoted();
      } else if (c === "$") add(dollar(false));
      else if (c === "`") {
        at++;
        nested("`");
        add(DYNAMIC);
      } else if (c === " " || c === "\t" || c === "\r") {
        endWord();
        bare += c;
        at++;
      } else if (c === "\n") {
        cut(1);
        bare += c;
        // O corpo de um here-doc é entrada, não comandos.
        for (const heredoc of heredocs.splice(0)) {
          let ended = false;
          while (at < source.length && !ended) {
            const end = endOf("\n", at);
            const line = source.slice(at, end).replace(/\r$/, "");
            at = Math.min(end + 1, source.length);
            ended = (heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.end;
          }
          if (!ended) synced = false;
        }
        command.from = command.to = at;
      } else if (c === "#" && word === null) at = endOf("\n", at);
      else if (c === ";" || c === "|" || (c === "&" && after !== ">")) {
        bare += c;
        cut(1);
      } else if (
        c === "(" &&
        word !== null &&
        !/^\s*\)/.test(source.slice(at + 1, at + 40)) &&
        !(command.words.length === 0 && (KEYWORDS.has(word) || word === "time"))
      ) {
        // Dentro de uma palavra `( … )` é dado (`name=( … )`, `logs/(old|tmp)`), menos `name()`
        // (define função) e uma palavra-chave antes (`then(…)`), que leva a um subshell.
        at++;
        balanced("(", ")", false);
        add(DYNAMIC);
      } else if (c === "(" || c === ")") {
        bare += c;
        depth = Math.max(0, depth + (c === "(" ? 1 : -1));
        cut(1);
      } else if ((c === "<" || c === ">") && after === "(") {
        at += 2;
        nested(")");
        add(DYNAMIC);
      } else if (c === "<" || c === ">" || c === "&") {
        // Dígitos antes de um redirecionamento nomeiam um descritor (2>).
        if (word !== null && /^\d+$/.test(word)) word = null;
        else endWord();
        bare += c;
        at += c === "&" ? 2 : 1;
        const duplicate = () => {
          const descriptor = /^&[\d-]+/.exec(source.slice(at, at + 12))?.[0];
          if (descriptor) at += descriptor.length;
          else if (source[at] === "&") at++;
          return Boolean(descriptor);
        };
        if (c !== "<") {
          if (source[at] === ">" || source[at] === "|") at++;
          next = duplicate() ? "argument" : "write";
        } else if (source[at] === "<") {
          at++;
          const hereString = source[at] === "<";
          const tabs = !hereString && source[at] === "-";
          if (source[at] === "<" || tabs) at++;
          next = hereString ? "read" : tabs ? "heredoc-tabs" : "heredoc";
        } else if (source[at] === ">") {
          at++;
          next = "write";
        } else next = duplicate() ? "argument" : "read";
      } else if (c === "~" && word === null) {
        // `~` e `~/…` são o diretório pessoal; `~nome` é de outra pessoa.
        add(after === undefined || /[\s/;&|()<>`]/.test(after) ? HOME : DYNAMIC);
        bare += c;
        at++;
      } else {
        add(c);
        bare += c;
        at++;
      }
    }
    cut(0);
    if (depth > 0) synced = false;
    return close === null;
  }

  script(null);
  if (heredocs.length) synced = false;
  return { commands, bare, synced };
}

// ------------------------------------------------------------------------------------------------
// Resolução de comando (prefixos, env -S, atalhos).
// ------------------------------------------------------------------------------------------------

/** Comandos que rodam o comando seguinte sem serem um alvo (sudo e su são negados à parte). */
const PREFIXES: Record<string, { values?: string; named?: string[]; operands?: number; asks?: string; asksNamed?: string[]; split?: { letter: string; named: string } }> = {
  env: { values: "uCS", named: ["unset", "chdir", "split-string"], split: { letter: "S", named: "split-string" } },
  nice: { values: "n", named: ["adjustment"] },
  timeout: { values: "ks", named: ["kill-after", "signal"], operands: 1 },
  exec: { values: "a" },
  command: { asks: "vV" },
  nohup: {},
  time: {},
  builtin: {},
  busybox: {},
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);
const MAX_DEPTH = 4;

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1).toLowerCase().replace(/\.(?:exe|com|cmd|bat|py)$/, "");
}

/** As palavras que `env -S` faz do valor, ou null. */
function splitWords(value: string | undefined): string[] | null {
  if (value === undefined) return [];
  if (/[$\\#]/.test(value) || value.includes(DYNAMIC)) return null;
  const words: string[] = [];
  let word: string | null = null;
  let quote = "";
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = "";
      else word = (word ?? "") + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

/** Índice da palavra do comando depois de atribuições, palavras-chave e prefixos, ou -1. */
function commandIndex(words: string[], unread: () => void): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (ASSIGNMENT.test(word) || KEYWORDS.has(word)) {
      index++;
      continue;
    }
    if (word === "function") {
      index += 2;
      continue;
    }
    const prefix = PREFIXES[programName(word)];
    if (!prefix) return index;
    index++;
    while (index < words.length && /^-./.test(words[index])) {
      const option = words[index++];
      if (option === "--") break;
      let line: string | undefined;
      let spliced = 0;
      if (option.startsWith("--")) {
        if (prefix.asksNamed?.includes(option.slice(2))) return -1;
        const equals = option.indexOf("=");
        const name = option.slice(2, equals < 0 ? undefined : equals);
        if (name && prefix.split?.named.startsWith(name)) {
          line = equals < 0 ? words[index] : option.slice(equals + 1);
          spliced = equals < 0 ? 2 : 1;
        } else {
          if (prefix.named?.includes(option.slice(2))) index++;
          else if (name && equals < 0 && prefix.named?.some((known) => known.startsWith(name))) unread();
          continue;
        }
      } else {
        const letters = option.slice(1).split("");
        const value = letters.findIndex((letter) => prefix.values?.includes(letter));
        if (letters.slice(0, value < 0 ? undefined : value).some((letter) => prefix.asks?.includes(letter))) return -1;
        if (value >= 0 && letters[value] === prefix.split?.letter) {
          const rest = option.slice(value + 2);
          line = rest || words[index];
          spliced = rest ? 1 : 2;
        } else {
          if (value === letters.length - 1) index++;
          continue;
        }
      }
      const parts = splitWords(line);
      if (!parts) {
        unread();
        return -1;
      }
      words.splice(--index, spliced, ...parts);
    }
    index += prefix.operands ?? 0;
  }
  return -1;
}

/** A linha que um shell recebe com `-c`, ou null. */
function inlineScript(args: string[]): string | null {
  let inline = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (/^--[a-z-]+$/.test(arg)) {
      if (arg === "--rcfile" || arg === "--init-file") index++;
    } else if (/^[-+][A-Za-z]+$/.test(arg)) {
      if (arg[0] === "-" && arg.includes("c")) inline = true;
      if (/[oO]$/.test(arg)) index++;
    } else return inline ? arg : null;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Caminhos: resolução, pastas do sistema, rascunho (/tmp e tmp do xodó).
// ------------------------------------------------------------------------------------------------

/** Resolve `.` e `..` pela escrita e tira um `*` final; `above` conta passos acima do começo. */
function resolved(segments: string[]): { parts: string[]; above: number } {
  const parts: string[] = [];
  let above = 0;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") parts.push(segment);
    else if (parts.length) parts.pop();
    else above++;
  }
  if (parts.at(-1) === "*" || parts.at(-1) === "*.*") parts.pop();
  return { parts, above };
}

/** Pastas cuja remoção recursiva cai na nunca-lista. */
const SYSTEM_DIRECTORIES = [
  "/etc", "/usr", "/bin", "/sbin", "/var", "/boot", "/home", "/lib", "/lib32", "/lib64", "/libx32", "/lib*",
  "/root", "/opt", "/dev", "/proc", "/sys", "/run", "/srv", "/media", "/mnt",
];
/** Raízes de sistema para chmod/chown (qualquer coisa abaixo delas, fora do workspace e do rascunho). */
const SYSTEM_ROOTS = ["/etc", "/usr", "/bin", "/sbin", "/var", "/boot", "/home", "/lib", "/lib32", "/lib64", "/libx32", "/root", "/opt", "/dev", "/proc", "/sys", "/run", "/srv", "/media", "/mnt"];
const SCRATCH_PREFIXES = ["/tmp", "/var/tmp", "/dev/shm"];

/** Transforma uma palavra num caminho absoluto resolvido, ou null se não dá para saber. */
function absolutePath(word: string): { parts: string[]; above: number; spelled: string } | null {
  if (word.includes(DYNAMIC)) return null;
  let raw = word.startsWith(HOME) ? MACHINE_HOME + word.slice(1) : word;
  if (raw.includes(HOME)) return null;
  if (!raw.startsWith("/")) return null;
  raw = raw.replace(/\/{2,}/g, "/");
  const { parts, above } = resolved(raw.split("/"));
  return { parts, above, spelled: `/${parts.join("/")}` };
}

/** A regra de nunca-lista que a remoção recursiva desta palavra encontra, ou null. */
function deleteRule(word: string): "root" | "home" | "system" | null {
  if (word.includes(DYNAMIC)) return null;
  const fromHome = word.startsWith(HOME);
  const path = fromHome ? word.slice(1) : word;
  if (path.includes(HOME) || !(path.startsWith("/") || (fromHome && path === ""))) return null;
  const { parts } = resolved(path.split("/"));
  // `~/..` ainda é home; `~/../nome` não dá para localizar, então passa.
  if (fromHome) return parts.length ? null : "home";
  if (!parts.length) return "root";
  const spelled = `/${parts.join("/")}`;
  if (SYSTEM_DIRECTORIES.includes(spelled)) return "system";
  if (spelled === MACHINE_HOME) return "home";
  return null;
}

/** O caminho é rascunho (/tmp, /var/tmp, /dev/shm ou xodos/<id>/tmp)? Palavra desconhecida: não. */
function isScratch(word: string): boolean {
  const abs = absolutePath(word);
  if (!abs || abs.above) return false;
  const { spelled } = abs;
  if (SCRATCH_PREFIXES.some((p) => spelled === p || spelled.startsWith(`${p}/`))) return true;
  const xodos = FOLDERS.xodos.replace(/\/+$/, "");
  if (spelled.startsWith(`${xodos}/`)) {
    const rest = spelled.slice(xodos.length + 1).split("/");
    if (rest.length >= 2 && rest[1] === "tmp") return true;
  }
  return false;
}

/** O caminho é de uma pasta do sistema (fora do workspace do xodó e do rascunho)? */
function isSystemPath(word: string): boolean {
  const abs = absolutePath(word);
  if (!abs || abs.above) return false;
  const { spelled } = abs;
  if (spelled === "/") return true;
  if (spelled === MACHINE_HOME || spelled.startsWith(`${MACHINE_HOME}/`)) return false;
  if (SCRATCH_PREFIXES.some((p) => spelled === p || spelled.startsWith(`${p}/`))) return false;
  return SYSTEM_ROOTS.some((r) => spelled === r || spelled.startsWith(`${r}/`));
}

/** O caminho mexe no próprio Spherum (/opt/spherum, /run/spherum) ou lê um environ de processo? */
function protectedPath(word: string): boolean {
  const abs = absolutePath(word);
  if (!abs) return false;
  const { spelled } = abs;
  if (spelled === "/opt/spherum" || spelled.startsWith("/opt/spherum/")) return true;
  if (spelled === "/run/spherum" || spelled.startsWith("/run/spherum/")) return true;
  if (/^\/proc\/[^/]+\/environ$/.test(spelled)) return true;
  return false;
}

// ------------------------------------------------------------------------------------------------
// Discos (improvável no sandbox, mas barato manter).
// ------------------------------------------------------------------------------------------------

const DISK_DEVICE = /^\/dev\/(?:sd[a-z]{1,3}\d*|hd[a-z]\d*|x?vd[a-z]{1,2}\d*|nvme\d+(?:n\d+)?(?:p\d+)?|mmcblk\d+(?:p\d+)?|md\d+(?:p\d+)?|md\/[^/]+|dm-\d+|mapper\/(?!loop\d)[^/]+)$/;
const SCRATCH_DEVICE = /^\/dev\/(?:mapper\/)?(?:loop|ram|nbd|zram)\d/;
const diskDevice = (word: string): boolean => DISK_DEVICE.test(word.replace(/\/{2,}/g, "/"));
const formatsDevice = (word: string): boolean => {
  const path = word.replace(/\/{2,}/g, "/");
  return path.startsWith("/dev/") && path.length > 5 && !path.includes(HOME) && !path.includes(DYNAMIC) && !SCRATCH_DEVICE.test(path);
};

// Bombas de fork: uma função que se encana em si mesma ao fundo e depois roda.
const BOMB_BODY = String.raw`\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1(?![\w:.-])`;
const BOMB_NAME = String.raw`([A-Za-z_:.][\w:.-]{0,63})`;
const FORK_BOMBS = [
  new RegExp(String.raw`(?:^|[\s;&|(){}])${BOMB_NAME}\s*\(\s*\)${BOMB_BODY}`),
  new RegExp(String.raw`(?:^|[\s;&|(){}])function\s+${BOMB_NAME}\s*(?:\(\s*\))?${BOMB_BODY}`),
];

// ------------------------------------------------------------------------------------------------
// Regras do Spherum (nunca-lista somada) e categorias do terminal.
// ------------------------------------------------------------------------------------------------

/** Escalada de privilégio e firewall: negados de cara. */
const DENY_PROGRAMS = new Set(["sudo", "su", "doas", "pkexec", "iptables", "ip6tables", "iptables-save", "iptables-restore", "ip6tables-restore", "nft"]);
/** Programas que matam processos. */
const KILLERS = new Set(["kill", "pkill", "killall", "fuser", "systemctl"]);
/** Processos protegidos (tela, navegador, gateway, vigia). */
const PROTECTED = ["xvfb", "x11vnc", "websockify", "chromium-browser", "chromium", "chrome", "fluxbox", "spherum-vigia", "vigia", "page-browser"];
/** chmod/chown/chgrp em pasta do sistema é negado. */
const PERM_PROGRAMS = new Set(["chmod", "chown", "chgrp"]);
/** Ferramentas de rede que viram negação quando miram a metadata. */
const FETCHERS = new Set(["curl", "wget", "lynx", "links", "links2", "w3m", "http", "httpie", "aria2c", "fetch", "nc", "ncat", "socat", "telnet"]);
/** Impressoras inofensivas: seus argumentos são só texto, não mexem em caminho. */
const HARMLESS_PRINTERS = new Set(["echo", "printf", "true", "false", ":"]);
/** Programas que mandam dados para fora. */
const SEND_PROGRAMS = new Set(["scp", "ssh", "sftp", "ftp", "lftp", "telnet", "nc", "ncat", "socat", "mail", "mailx", "sendmail", "ssmtp", "mutt", "s-nail"]);
/** Só leitura conhecida. */
const READ_ONLY = new Set([
  "ls", "dir", "vdir", "cat", "tac", "head", "tail", "nl", "grep", "egrep", "fgrep", "rg", "wc", "du", "df", "ps", "pgrep",
  "echo", "printf", "pwd", "stat", "file", "which", "type", "whereis", "tree", "date", "cal", "uname", "whoami", "id",
  "groups", "hostname", "uptime", "free", "realpath", "readlink", "dirname", "basename", "sort", "uniq", "comm", "column",
  "od", "xxd", "hexdump", "strings", "cksum", "md5sum", "sha1sum", "sha256sum", "sha512sum", "b2sum", "cmp", "diff",
  "true", "false", "test", "[", "sleep", "seq", "tr", "cut", "jq", "less", "more", "zcat", "bzcat", "xzcat", "tty",
  "locale", "printenv", "lsblk", "lscpu", "lsusb", "lspci", "ping", "dig", "host", "nslookup", "cal", "yes",
]);
/** Subcomandos do git que só leem. */
const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "cat-file", "show-ref", "describe", "shortlog", "reflog", "grep", "whatchanged", "rev-list"]);
/** Destinos de escrita que não contam como mudança. */
const NULL_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"]);

type Outcome = { kind: "deny" | "ask" | "ok"; category: Category };
const CAT_RANK: Record<string, number> = { exclusao: 3, envio: 2, alteracao: 1, leitura: 0 };

function merge(a: Outcome, b: Outcome): Outcome {
  if (a.kind === "deny" || b.kind === "deny") return { kind: "deny", category: "exclusao" };
  if (a.kind === "ask" || b.kind === "ask") return { kind: "ask", category: "alteracao" };
  return CAT_RANK[a.category] >= CAT_RANK[b.category] ? a : b;
}
const OK = (category: Category): Outcome => ({ kind: "ok", category });
const DENY: Outcome = { kind: "deny", category: "exclusao" };

/** Argumentos que não são opção (depois de `--`, tudo é operando). */
function operands(args: string[]): string[] {
  const out: string[] = [];
  let only = false;
  for (const arg of args) {
    if (only || !arg.startsWith("-")) out.push(arg);
    else if (arg === "--") only = true;
  }
  return out;
}

/** Alvos do truncate (pula o valor de -s/--size e -r/--reference). */
function truncateTargets(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-s" || a === "--size" || a === "-r" || a === "--reference") {
      i++;
      continue;
    }
    if (/^-s./.test(a) || /^--size=/.test(a) || /^--reference=/.test(a)) continue;
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

/** Apagar: rascunho vira alteracao; qualquer alvo fora do rascunho (ou desconhecido) é exclusao. */
function deletionCategory(targets: string[]): Category {
  if (!targets.length) return "exclusao";
  return targets.every(isScratch) ? "alteracao" : "exclusao";
}

/** Caminhos que o find percorre (vêm antes do primeiro predicado). */
function findRoots(args: string[]): string[] {
  const roots: string[] = [];
  for (const a of args) {
    if (a.startsWith("-") || a === "(" || a === "!") break;
    roots.push(a);
  }
  return roots.length ? roots : ["."];
}

function judgeFind(args: string[], depth: number): Outcome {
  let outcome: Outcome = OK("leitura");
  if (args.includes("-delete")) outcome = merge(outcome, OK(deletionCategory(findRoots(args))));
  const execAt = args.findIndex((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a));
  if (execAt >= 0) {
    const sub: string[] = [];
    for (let i = execAt + 1; i < args.length; i++) {
      const a = args[i];
      if (a === ";" || a === "+") break;
      sub.push(a);
    }
    outcome = merge(outcome, sub.length ? judgeWords(sub, [], depth + 1) : OK("alteracao"));
  }
  return outcome;
}

function gitSubcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-C" || a === "-c") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a.toLowerCase();
  }
  return null;
}

function judgeGit(args: string[]): Outcome {
  const sub = gitSubcommand(args);
  if (!sub) return OK("leitura");
  if (sub === "push") return OK("envio");
  if (sub === "clean") return OK("exclusao");
  if (sub === "reset") return args.includes("--hard") ? OK("exclusao") : OK("alteracao");
  if (GIT_READ.has(sub)) return OK("leitura");
  return OK("alteracao");
}

/** curl com corpo ou método de escrita? */
function curlSends(args: string[]): boolean {
  const verbs = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--request") {
      if (verbs.has((args[i + 1] ?? "").toUpperCase())) return true;
    } else if (/^-X./.test(a)) {
      if (verbs.has(a.slice(2).toUpperCase())) return true;
    } else if (/^--request=/.test(a)) {
      if (verbs.has((a.split("=")[1] ?? "").toUpperCase())) return true;
    } else if (a === "-d" || a === "-F" || a === "-T" || a === "--json") return true;
    else if (/^--(data|form|upload-file|json)/.test(a)) return true;
    else if (/^-[A-Za-z]*[dFT]/.test(a)) return true;
  }
  return false;
}

/** wget com corpo ou método de escrita? */
function wgetSends(args: string[]): boolean {
  const verbs = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  return args.some((a) => /^--post-/.test(a) || /^--body-(data|file)/.test(a) || (/^--method=/.test(a) && verbs.has((a.split("=")[1] ?? "").toUpperCase())));
}

/** rsync com um lado remoto (host:caminho ou rsync://). */
function rsyncRemote(args: string[]): boolean {
  return operands(args).some((a) => /^rsync:\/\//.test(a) || /^[^/]*@[^/]*:/.test(a) || /^[^/:]+:/.test(a));
}

/** A palavra aponta para a metadata (IP fixo ou host metadata)? */
function metadataTarget(word: string): boolean {
  if (word.includes("169.254.169.254")) return true;
  const host = (/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/:?#]+)/i.exec(word)?.[1] ?? "").toLowerCase();
  return host === "metadata" || host === "metadata.google.internal" || host.endsWith(".metadata.google.internal");
}

/** O programa que mata processos mira um protegido? */
function killsProtected(args: string[]): boolean {
  return args.some((a) => {
    if (a.startsWith("-")) return false;
    const base = programName(a);
    const low = a.toLowerCase();
    return PROTECTED.includes(base) || PROTECTED.some((p) => low.includes(p));
  });
}

/** Opções do xargs que levam um valor, para achar o comando que ele roda. */
const XARGS_VALUE = new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars"]);
function xargsCommand(args: string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (!a.startsWith("-")) break;
    if (a === "--") {
      i++;
      break;
    }
    if (XARGS_VALUE.has(a)) i += 2;
    else i++;
  }
  return args.slice(i);
}

/** Julga um comando simples (lista de palavras + alvos de escrita). */
function judgeWords(words: string[], writes: string[], depth: number): Outcome {
  if (depth > MAX_DEPTH) return { kind: "ask", category: "alteracao" };

  // Redirecionamento de escrita para disco ou para o próprio Spherum.
  for (const w of writes) {
    if (diskDevice(w)) return DENY;
    if (protectedPath(w)) return DENY;
  }

  let unread = false;
  const w = [...words];
  const index = commandIndex(w, () => {
    unread = true;
  });
  if (index < 0) return unread ? { kind: "ask", category: "alteracao" } : OK("leitura");
  const program = programName(w[index]);
  const args = w.slice(index + 1);

  // Shells e eval: lê o que eles vão rodar.
  if (SHELLS.has(program)) {
    const inner = inlineScript(args);
    // Sem `-c`: lê de stdin ou de um arquivo que não dá para ver.
    return inner === null ? OK("alteracao") : scan(inner, depth + 1);
  }
  if (program === "eval") return args.length ? scan(args.join(" "), depth + 1) : OK("alteracao");
  if (program === "xargs") {
    const sub = xargsCommand(args);
    return sub.length ? judgeWords(sub, [], depth + 1) : OK("alteracao");
  }

  // Referências ao próprio Spherum e à metadata (menos impressoras, cujos args são só texto).
  if (!HARMLESS_PRINTERS.has(program)) {
    for (const word of words) {
      if (word.includes("169.254.169.254")) return DENY;
      if (protectedPath(word)) return DENY;
    }
  }
  if (FETCHERS.has(program) && args.some(metadataTarget)) return DENY;

  if (DENY_PROGRAMS.has(program)) return DENY;
  if (PERM_PROGRAMS.has(program) && operands(args).some(isSystemPath)) return DENY;
  if (KILLERS.has(program) && killsProtected(args)) return DENY;

  if (program === "rm") {
    const targets = operands(args);
    for (const target of targets) if (deleteRule(target)) return DENY;
    return OK(deletionCategory(targets));
  }
  if (program === "mkfs" || program.startsWith("mkfs.")) return args.some(formatsDevice) ? DENY : OK("alteracao");
  if (program === "dd") {
    if (args.some((a) => a.startsWith("of=") && diskDevice(a.slice(3)))) return DENY;
    return args.some((a) => a.startsWith("of=")) ? OK("alteracao") : OK("leitura");
  }
  if (program === "shred" || program === "unlink") return OK(deletionCategory(operands(args)));
  if (program === "truncate") return OK(deletionCategory(truncateTargets(args)));
  if (program === "find") return judgeFind(args, depth);
  if (program === "git") return judgeGit(args);

  if (program === "curl") return curlSends(args) ? OK("envio") : OK("alteracao");
  if (program === "wget") return wgetSends(args) ? OK("envio") : OK("alteracao");
  if (program === "rsync") return rsyncRemote(args) ? OK("envio") : OK("alteracao");
  if (SEND_PROGRAMS.has(program)) return OK("envio");

  if (READ_ONLY.has(program)) return OK("leitura");
  return OK("alteracao");
}

const nonTrivialWrite = (w: string): boolean => {
  if (w.includes(DYNAMIC)) return true;
  const p = w.replace(/\/{2,}/g, "/");
  if (NULL_SINKS.has(p)) return false;
  return !/^\/dev\/fd\/\d+$/.test(p);
};

function judgeCommand(command: Command, depth: number): Outcome {
  const outcome = judgeWords(command.words, command.writes, depth);
  // Escrever num arquivo é, no mínimo, alteracao (um echo com `>` não é mais só leitura).
  if (outcome.kind === "ok" && outcome.category === "leitura" && command.writes.some(nonTrivialWrite)) return OK("alteracao");
  return outcome;
}

function scan(source: string, depth: number): Outcome {
  if (depth > MAX_DEPTH) return { kind: "ask", category: "alteracao" };
  const reading = lex(source);
  if (FORK_BOMBS.some((bomb) => bomb.test(reading.bare))) return DENY;
  let agg: Outcome = OK("leitura");
  for (const command of reading.commands) agg = merge(agg, judgeCommand(command, depth));
  // Um bloqueio achado vale mesmo com o resto ilegível; sem bloqueio, o ilegível pede uma pessoa.
  if (agg.kind !== "deny" && !reading.synced) agg = { kind: "ask", category: "alteracao" };
  return agg;
}
