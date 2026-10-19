import assert from "node:assert/strict";
import { test } from "node:test";
import { ASK_MESSAGE, DENY_MESSAGE, MAX_COMMAND_LENGTH, classifyCommand } from "../src/lib/computer/safety-floor";
import type { Category } from "../src/lib/xodos/policy";

// Classificador do terminal: só recebe uma linha de comando e devolve {verdict, category, reason}.
// Nada aqui roda um comando de verdade.

const verdict = (command: string) => classifyCommand(command).verdict;
const category = (command: string) => classifyCommand(command).category;

/** Linhas que NUNCA são aprovadas automaticamente (nunca-lista). */
const DENY: string[] = [
  // raiz, home e pastas do sistema, em várias escritas
  "rm -rf /",
  "rm -fr /",
  "rm -r /",
  "rm -R /",
  "rm --recursive /",
  "rm / -rf",
  "rm -rf /*",
  "rm -rf --no-preserve-root /",
  "rm -rf -- /",
  "rm -rf /tmp/scratch /",
  'rm -rf "/"',
  "rm -rf '/'",
  "rm -rf //",
  "rm -rf /.",
  "rm -rf /usr/..",
  "rm -rf ~",
  "rm -rf ~/",
  "rm -rf ~/*",
  "rm -rf $HOME",
  'rm -rf "$HOME"',
  "rm -rf ${HOME}",
  "rm -rf $HOME/*",
  "rm -rf ~/..",
  "rm -rf /home/xodo",
  "rm -rf /etc",
  "rm -rf /etc/",
  "rm -rf /usr",
  "rm -rf /var/*",
  "rm -rf /lib*",
  "rm -rf /opt",
  "rm -rf /run",
  "rm -rf /tmp/../etc",
  // prefixos e atalhos de escrita
  "FORCE=1 rm -rf /",
  'A=1 B="two words" rm -rf /usr',
  "env FOO=bar rm -rf /",
  "env -S 'rm -rf /'",
  "env --split-string='rm -rf /'",
  "nohup rm -rf / &",
  "command rm -rf /",
  "exec rm -rf /",
  "/bin/rm -rf /",
  "\\rm -rf /",
  "'rm' -rf /",
  "RM -rf /",
  "timeout 10 rm -rf /",
  // shells e eval
  "sh -c 'rm -rf /'",
  'bash -lc "rm -rf /"',
  'bash -c "rm -rf $HOME"',
  "zsh -ic 'rm -rf /etc'",
  "bash -o pipefail -c 'rm -rf /'",
  "sudo sh -c \"bash -c 'rm -rf /'\"",
  "eval 'rm -rf /'",
  "eval eval eval rm -rf /",
  "bash -c -- 'rm -rf /'",
  // cadeias e subshells
  "ls; rm -rf /",
  "cd /tmp && rm -rf /",
  "test -d x || rm -rf /",
  "yes | rm -rf /",
  "echo start\nrm -rf /\necho done",
  "(rm -rf /)",
  "{ rm -rf /; }",
  "if true; then rm -rf /; fi",
  "echo $(rm -rf /)",
  "echo `rm -rf ~`",
  "while true; do rm -rf /; done",
  "case x in x) rm -rf / ;; esac",
  "x=$(rm -rf /usr)",
  "((rm -rf /))",
  "echo $[ $(rm -rf /) ]",
  // um bloqueio achado vale mesmo com o resto ilegível depois
  'rm -rf /\necho "sem fechar',
  // find -exec que roda rm destrutivo na raiz
  "find . -exec rm -rf / ;",
  "find . | xargs rm -rf /etc",
  // disco
  "mkfs.ext4 /dev/sda1",
  "sudo mkfs -t xfs /dev/nvme0n1p1",
  "dd if=/dev/zero of=/dev/sda bs=1M",
  "cat image.img > /dev/sda",
  "echo boom >/dev/nvme0n1",
  // bombas de fork
  ":(){ :|:& };:",
  "bomb() { bomb | bomb & }; bomb",
  "bash -c ':(){ :|:& };:'",
  // Spherum: escalada e firewall
  "sudo rm -rf /var/lib/apt/lists/*",
  "sudo ls",
  "sudo -u root whoami",
  "su",
  "su - root",
  "doas id",
  "pkexec whoami",
  "iptables -L",
  "iptables -F",
  "sudo iptables -A OUTPUT -j DROP",
  "ip6tables -L",
  "nft list ruleset",
  // Spherum: matar os processos da máquina
  "pkill chromium",
  "killall Xvfb",
  "pkill -f websockify",
  "killall x11vnc",
  "systemctl stop x11vnc",
  "pkill -9 fluxbox",
  "kill -9 $(pgrep chromium) ; pkill vigia",
  // Spherum: mexer no próprio Spherum
  "cat /run/spherum/tokens/abc",
  "ls /opt/spherum/web",
  "rm -rf /opt/spherum",
  "echo x > /opt/spherum/web/view.html",
  "cp payload /run/spherum/tokens/t1",
  // Spherum: ler environ de processo
  "cat /proc/1/environ",
  "cat /proc/self/environ",
  "grep SECRET /proc/123/environ",
  // Spherum: metadata
  "curl http://169.254.169.254/latest/meta-data/",
  "wget http://metadata.google.internal/computeMetadata/v1/",
  "curl -s http://metadata/token",
  // Spherum: chmod/chown em pasta do sistema
  "chmod -R 777 /usr",
  "chmod 600 /etc/shadow",
  "chown xodo /var/log",
  "chmod -R 755 /usr/local/share/example",
];

/** Linhas que não dá para ler com segurança (sempre pergunta). */
const ASK: string[] = [
  'echo "sem fechar',
  "ls 'aspas abertas",
  "echo $(echo $(echo", // subshells sem fechar
  "cat `echo", // crase sem fechar
  "cat <<EOF\nsem terminador\n", // here-doc sem fim
  `ls ${"$(".repeat(45)}x${")".repeat(45)}`, // aninhamento > 40
  "ls\u0001 arquivo", // caractere de controle
  "x".repeat(MAX_COMMAND_LENGTH + 1), // grande demais
  'rm -rf /tmp/a ; echo "sem fechar', // sem bloqueio e ilegível no fim
];

const EXCLUSAO: string[] = [
  "rm file.txt",
  "rm -rf build",
  "rm -rf build dist node_modules",
  "rm -rf ~/projeto/dist",
  "rm -rf /home/xodo/spherum/clientes/1",
  "rm -rf $BUILD_DIR",
  "shred -u segredo.txt",
  "truncate -s 0 log.txt",
  "unlink importante",
  "find . -delete",
  "find src -name '*.tmp' -delete",
  "git clean -fd",
  "git reset --hard HEAD~1",
  "find . -name x -exec rm -rf {} +", // rm de cada achado ({}): alvo desconhecido -> exclusao
  "find / -name x -exec rm -rf {} ;", // idem: apaga {} e não a raiz
  "find /tmp | xargs rm -rf build", // rm de alvo relativo -> exclusao
];

const ALTERACAO_DELETE: string[] = [
  "rm -rf /tmp/x",
  "rm -rf /tmp/*",
  "rm -rf /var/tmp/cache",
  "rm -rf /dev/shm/scratch",
  "rm -rf /home/xodo/spherum/xodos/42/tmp/a",
  "find /tmp -delete",
];

const ENVIO: string[] = [
  "curl -d 'a=1' https://exemplo.test",
  "curl -X POST https://exemplo.test",
  "curl --data-binary @f https://exemplo.test",
  "curl -F file=@a.png https://exemplo.test",
  "curl -T arquivo.zip https://exemplo.test/up",
  "curl --request PUT https://exemplo.test",
  "wget --post-data='a=1' https://exemplo.test",
  "wget --post-file=corpo https://exemplo.test",
  "wget --method=POST --body-data=x https://exemplo.test",
  "git push origin main",
  "scp relatorio.pdf deploy@host:/tmp/",
  "rsync -a ./saida/ deploy@host:/dados/",
  "rsync -a ./a rsync://host/mod",
  "ssh deploy@host 'ls'",
  "nc host 80",
  "ncat host 443",
  "socat - TCP:host:25",
  "mail -s assunto pessoa@exemplo.test",
  "sendmail pessoa@exemplo.test",
  "ftp host",
  "sftp host",
];

const LEITURA: string[] = [
  "ls",
  "ls -la /home/xodo/spherum",
  "cat relatorio.md",
  "head -n 20 dados.csv",
  "tail -f app.log",
  "grep -r TODO .",
  "rg 'erro' logs/",
  "find . -name '*.log'",
  "find src -type f",
  "wc -l arquivo",
  "du -sh *",
  "df -h",
  "ps aux",
  "echo ola mundo",
  "pwd",
  "git status",
  "git log --oneline",
  "git diff",
  "git show HEAD",
  "stat arquivo",
  "which node",
  "echo ola > /dev/null",
  "curl https://exemplo.test/dados.json", // GET puro cai em alteracao, ver abaixo
];

const ALTERACAO: string[] = [
  "git commit -m 'mensagem'",
  "git checkout -b nova",
  "git fetch origin",
  "git remote add origin https://x.test/r.git",
  "git branch -d antiga",
  "mkdir -p pasta/nova",
  "cp a.txt b.txt",
  "mv a.txt b.txt",
  "touch novo.txt",
  "echo linha >> notas.txt",
  "echo linha > notas.txt",
  "sed -i 's/a/b/' arquivo",
  "npm install",
  "python script.py",
  "python -c 'import os; os.system(\"rm -rf /\")'", // não lemos Python por dentro
  "node -e 'require(\"fs\")'",
  "wget https://exemplo.test/arquivo.zip", // download puro
  "curl https://exemplo.test/dados.json", // GET puro
  "rsync -a ./a ./b", // local -> local
  "chmod +x /home/xodo/spherum/xodos/1/run.sh", // dentro do workspace
  "chmod 644 relativo.txt",
  "kill -9 1234", // pid, sem nome protegido
  "pkill node",
  "base64 -d payload | sh", // não vemos o que é decodificado
  "alias nuke='rm -rf /'", // o rm é dado entre aspas, não roda
  "export CMD='rm -rf /'",
];

test("nunca-lista: deny com o texto do piso", () => {
  for (const command of DENY) {
    const v = classifyCommand(command);
    assert.equal(v.verdict, "deny", `deveria negar: ${JSON.stringify(command)}`);
    assert.equal(v.reason, DENY_MESSAGE, `texto do piso: ${JSON.stringify(command)}`);
  }
});

test("ilegível: ask com o aviso de revisão", () => {
  for (const command of ASK) {
    const v = classifyCommand(command);
    assert.equal(v.verdict, "ask", `deveria pedir pessoa: ${JSON.stringify(command.slice(0, 40))}`);
    assert.equal(v.reason, ASK_MESSAGE);
  }
});

test("apagar fora do rascunho: exclusao", () => {
  for (const command of EXCLUSAO) {
    assert.equal(verdict(command), "allow", `não deveria negar: ${JSON.stringify(command)}`);
    assert.equal(category(command), "exclusao" satisfies Category, JSON.stringify(command));
  }
});

test("apagar dentro de /tmp ou do tmp do xodó: alteracao", () => {
  for (const command of ALTERACAO_DELETE) {
    assert.equal(verdict(command), "allow", JSON.stringify(command));
    assert.equal(category(command), "alteracao" satisfies Category, JSON.stringify(command));
  }
});

test("mandar dados para fora: envio", () => {
  for (const command of ENVIO) {
    assert.equal(verdict(command), "allow", `não deveria negar: ${JSON.stringify(command)}`);
    assert.equal(category(command), "envio" satisfies Category, JSON.stringify(command));
  }
});

test("só leitura conhecida: leitura", () => {
  for (const command of LEITURA) {
    if (command.startsWith("curl")) continue; // o GET puro é verificado na lista de alteracao
    assert.equal(verdict(command), "allow", JSON.stringify(command));
    assert.equal(category(command), "leitura" satisfies Category, JSON.stringify(command));
  }
});

test("o resto: alteracao", () => {
  for (const command of ALTERACAO) {
    assert.equal(verdict(command), "allow", `não deveria negar: ${JSON.stringify(command)}`);
    assert.equal(category(command), "alteracao" satisfies Category, JSON.stringify(command));
  }
});

test("combinação: fica com a parte mais restrita", () => {
  // leitura + envio -> envio
  assert.equal(category("ls && git push"), "envio");
  // leitura + exclusao -> exclusao
  assert.equal(category("cat a.txt; rm -rf build"), "exclusao");
  // exclusao em /tmp + exclusao relativo -> exclusao (um alvo não é rascunho)
  assert.equal(category("rm -rf /tmp/a build"), "exclusao");
  // envio + exclusao -> exclusao
  assert.equal(category("curl -d x https://h.test && rm -rf build"), "exclusao");
  // deny vence tudo
  assert.equal(verdict("ls && sudo reboot"), "deny");
  assert.equal(verdict("git push && rm -rf /"), "deny");
  // pipeline leitura puro
  assert.equal(category("cat a | grep x | wc -l"), "leitura");
});

test("entrada vazia é leitura inofensiva", () => {
  assert.equal(verdict(""), "allow");
  assert.equal(verdict("   "), "allow");
  assert.equal(category(""), "leitura");
});

test("echo com o texto perigoso entre aspas não vira comando", () => {
  // o payload é dado, não é executado
  assert.equal(verdict("echo 'rm -rf /'"), "allow");
  assert.equal(category("echo 'rm -rf /'"), "leitura");
  assert.equal(verdict("git commit -m 'nunca rode: rm -rf /'"), "allow");
  assert.equal(verdict("echo ':(){ :|:& };:'"), "allow");
  // here-doc com o texto perigoso no corpo é dado
  assert.equal(verdict("cat <<'EOF'\nrm -rf /\nEOF"), "allow");
});
