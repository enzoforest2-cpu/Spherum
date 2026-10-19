#!/usr/bin/env bash
# Adaptado de PREPARE_LINUX_DESKTOP (packages/adapters/src/linux-desktop.ts), infra/sandboxes/computer/{Dockerfile,start.sh}
# e packages/core/src/node/desktop-runtime.ts do Rakazo (Apache-2.0); ambiente limpo e rede como no OpenMausBot (Apache-2.0).
#
# Preparo da máquina do Spherum (roda como root, idempotente). Monta:
# - usuário xodo (uid 1000 quando dá) sem sudo, com as pastas do xodó;
# - tela Xvfb :20 1280x800x24 com fluxbox (sem terminal no desktop);
# - Chromium como xodo, CDP só em 127.0.0.1:9222, perfis em ~/.perfis;
# - x11vnc -viewonly em socket Unix, websockify 0.0.0.0:6100 com TokenFile em /run/spherum/tokens;
# - vigia root (tokens vencidos, fim do controle);
# - iptables para o uid do xodo: sem redes privadas, metadata e SMTP;
# - verificação final: só a 6100 escuta fora do loopback (aborta se CDP, VNC ou terminal aparecerem).
#
# Ambiente: SPHERUM_STAGING (pasta com os arquivos enviados), SPHERUM_EGRESS (aberto|restrito),
# SPHERUM_TEMPLATE_USER (usuário padrão do template a desarmar), SPHERUM_ALLOWED_PORTS (portas do
# agente do provedor) e SPHERUM_RUNTIME_VERSION.
set -euo pipefail
umask 022
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

say() { printf 'spherum-preparo: %s\n' "$*"; }
die() {
  printf 'spherum-preparo: ERRO: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "precisa rodar como root"
STAGING=${SPHERUM_STAGING:?SPHERUM_STAGING ausente}
EGRESS=${SPHERUM_EGRESS:-aberto}
TEMPLATE_USER=${SPHERUM_TEMPLATE_USER:-}
ALLOWED_PORTS=${SPHERUM_ALLOWED_PORTS:-}
VERSION=${SPHERUM_RUNTIME_VERSION:-dev}
case "$EGRESS" in aberto | restrito) ;; *) die "modo de rede inválido" ;; esac
[[ "$TEMPLATE_USER" =~ ^([a-z_][a-z0-9_-]{0,31})?$ ]] || die "usuário do template inválido"
[[ "$ALLOWED_PORTS" =~ ^([0-9]{1,5}( [0-9]{1,5})*)?$ ]] || die "portas do provedor inválidas"
[[ "$VERSION" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "versão inválida"
case "$STAGING" in /opt/spherum/.preparo | /opt/spherum/.preparo/*) ;; *) die "pasta do preparo inválida" ;; esac
[ -f "$STAGING/bin/spherum-lib.sh" ] || die "arquivos do preparo não chegaram"

XODO=xodo
XODO_HOME=/home/xodo
SPHERUM_HOME=$XODO_HOME/spherum
ETC=/etc/spherum
BIN=/opt/spherum/bin
WEB=/opt/spherum/web

# ---------------------------------------------------------------------------
# 1. Pacotes (só os que faltam)
# ---------------------------------------------------------------------------
apt_ready=0
apt_install() {
  if [ "$apt_ready" -eq 0 ]; then
    apt-get -o DPkg::Lock::Timeout=120 update -qq
    apt_ready=1
  fi
  apt-get -o DPkg::Lock::Timeout=120 install -y -qq --no-install-recommends "$@"
}

missing=()
for pair in \
  Xvfb:xvfb xdpyinfo:x11-utils xsetroot:x11-xserver-utils x11vnc:x11vnc fluxbox:fluxbox \
  xdotool:xdotool wmctrl:wmctrl xclip:xclip scrot:scrot websockify:websockify python3:python3 \
  iptables:iptables ss:iproute2 pgrep:procps flock:util-linux setpriv:util-linux runuser:util-linux \
  curl:curl gpg:gnupg locale-gen:locales; do
  command -v "${pair%%:*}" >/dev/null 2>&1 || missing+=("${pair#*:}")
done
[ -d /usr/share/novnc/core ] || missing+=(novnc)
[ -e /usr/share/zoneinfo/America/Sao_Paulo ] || missing+=(tzdata)
[ -e /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
fc-list 2>/dev/null | grep -qi liberation || missing+=(fonts-liberation fonts-dejavu-core)
if [ "${#missing[@]}" -gt 0 ]; then
  say "instalando: $(printf '%s\n' "${missing[@]}" | sort -u | tr '\n' ' ')"
  mapfile -t unique < <(printf '%s\n' "${missing[@]}" | sort -u)
  apt_install "${unique[@]}"
fi

# Idioma e fuso do ambiente limpo (sem eles, todo comando reclama no stderr).
if ! locale -a 2>/dev/null | grep -qi '^pt_BR\.utf-\?8$'; then
  if [ -f /etc/locale.gen ]; then sed -i 's/^# *\(pt_BR.UTF-8 UTF-8\)/\1/' /etc/locale.gen; fi
  grep -q '^pt_BR.UTF-8 UTF-8' /etc/locale.gen 2>/dev/null || echo 'pt_BR.UTF-8 UTF-8' >>/etc/locale.gen
  locale-gen >/dev/null 2>&1 || locale-gen pt_BR.UTF-8 >/dev/null 2>&1 || say "aviso: não gerei o idioma pt_BR"
fi

# ---------------------------------------------------------------------------
# 2. Navegador: um Chromium de verdade (o do Ubuntu é um atalho para snap, que não roda aqui)
# ---------------------------------------------------------------------------
works() {
  [ -x "$1" ] || return 1
  # Atalho de script para o snap não conta.
  if [ "$(head -c 2 "$1")" = '#!' ] && grep -qs snap "$1"; then return 1; fi
  "$1" --version >/dev/null 2>&1
}
real=""
for candidate in /usr/bin/chromium /usr/lib/chromium/chromium /opt/google/chrome/chrome /usr/bin/google-chrome-stable; do
  if works "$candidate"; then real=$candidate; break; fi
done
if [ -z "$real" ]; then
  . /etc/os-release
  if [ "${ID:-}" = debian ]; then
    apt_install chromium
    real=/usr/bin/chromium
  else
    [ "$(dpkg --print-architecture)" = amd64 ] || die "sem Chromium para esta arquitetura"
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /usr/share/keyrings/google-chrome.gpg
    echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
      >/etc/apt/sources.list.d/google-chrome.list
    apt_ready=0
    apt_install google-chrome-stable
    real=/opt/google/chrome/chrome
  fi
  works "$real" || die "o Chromium instalado não abre"
fi

install -d -m 0755 "$ETC"
printf '%s\n' "$real" >"$ETC/chromium-real"
# Sandbox do Chromium: precisa de user namespaces (ou do chrome-sandbox setuid do Google Chrome).
flags="--disable-dev-shm-usage --no-default-browser-check --disable-background-networking --disable-sync"
if ! setpriv --reuid=65534 --regid=65534 --clear-groups -- unshare --user --map-root-user true >/dev/null 2>&1 &&
  ! { [ -u /opt/google/chrome/chrome-sandbox ] && [ "$real" = /opt/google/chrome/chrome ]; }; then
  # Sem namespaces: a fronteira passa a ser a própria máquina (microVM), que é da agência só.
  flags="$flags --no-sandbox --test-type"
  say "aviso: Chromium sem sandbox interno (a máquina não tem user namespaces)"
fi
printf '%s\n' "$flags" >"$ETC/chromium-flags"
cat >/usr/local/bin/chromium <<'EOF'
#!/bin/sh
# Navegador do xodó: o Chromium de verdade com as opções do Spherum (arquivos de root).
real=$(cat /etc/spherum/chromium-real)
# shellcheck disable=SC2046
exec "$real" $(cat /etc/spherum/chromium-flags) "$@"
EOF
chmod 0755 /usr/local/bin/chromium

# Políticas: sem gerenciador de senhas nem autopreenchimento, downloads na pasta do xodó.
policy=$(
  cat <<EOF
{
  "PasswordManagerEnabled": false,
  "AutofillCreditCardEnabled": false,
  "AutofillAddressEnabled": false,
  "BrowserSignin": 0,
  "SyncDisabled": true,
  "MetricsReportingEnabled": false,
  "DefaultBrowserSettingEnabled": false,
  "PromptForDownloadLocation": false,
  "DownloadDirectory": "$SPHERUM_HOME/downloads",
  "RemoteDebuggingAllowed": true
}
EOF
)
for dir in /etc/chromium/policies/managed /etc/opt/chrome/policies/managed; do
  install -d -m 0755 "$dir"
  printf '%s\n' "$policy" >"$dir/spherum.json"
  chmod 0644 "$dir/spherum.json"
done

# ---------------------------------------------------------------------------
# 3. Usuário xodo (uid 1000 quando dá), sem sudo e sem senha
# ---------------------------------------------------------------------------
if ! id "$XODO" >/dev/null 2>&1; then
  owner=$(getent passwd 1000 | cut -d: -f1 || true)
  if [ -z "$owner" ]; then
    getent group 1000 >/dev/null 2>&1 || groupadd -g 1000 "$XODO"
    if getent group "$XODO" >/dev/null 2>&1; then
      useradd -u 1000 -g "$XODO" -m -d "$XODO_HOME" -s /bin/bash "$XODO"
    else
      useradd -u 1000 -U -m -d "$XODO_HOME" -s /bin/bash "$XODO"
    fi
  elif [ -n "$TEMPLATE_USER" ] && [ "$owner" = "$TEMPLATE_USER" ]; then
    # O usuário padrão do template (com sudo) vira o xodo: mesmo uid 1000, sem nada do que tinha.
    say "o usuário $owner do template vira $XODO"
    pkill -KILL -u 1000 || true
    sleep 0.5
    group=$(id -gn "$owner")
    usermod -l "$XODO" -d "$XODO_HOME" -m -s /bin/bash "$owner" || die "não consegui converter o usuário $owner"
    if [ "$group" = "$owner" ]; then groupmod -n "$XODO" "$group"; fi
  else
    say "aviso: uid 1000 é de $owner; o xodo fica com outro uid"
    useradd -U -m -d "$XODO_HOME" -s /bin/bash "$XODO"
  fi
fi
XUID=$(id -u "$XODO")
XGID=$(id -g "$XODO")
[ "$XUID" -ne 0 ] || die "o xodo não pode ser root"

# Nenhum grupo extra (sudo, admin, wheel, docker...) e nenhuma regra de sudo.
usermod -G "" "$XODO"
strip_sudoers() {
  local who=$1 f
  [ -n "$who" ] || return 0
  if [ -d /etc/sudoers.d ]; then
    for f in /etc/sudoers.d/*; do
      [ -f "$f" ] || continue
      if grep -Eq "^[[:space:]]*$who([[:space:]]|,)" "$f"; then rm -f -- "$f"; fi
    done
  fi
  if [ -f /etc/sudoers ] && grep -Eq "^[[:space:]]*$who([[:space:]]|,)" /etc/sudoers; then
    cp /etc/sudoers /etc/sudoers.spherum-bak
    sed -i -E "/^[[:space:]]*$who([[:space:]]|,)/d" /etc/sudoers
    if command -v visudo >/dev/null 2>&1 && ! visudo -cq; then
      mv -f /etc/sudoers.spherum-bak /etc/sudoers
      die "não consegui tirar $who do sudoers"
    fi
    rm -f /etc/sudoers.spherum-bak
  fi
}
strip_sudoers "$XODO"
# O usuário padrão do template também perde o sudo (no E2B tudo de root vem direto pelo agente).
if [ -n "$TEMPLATE_USER" ] && [ "$TEMPLATE_USER" != "$XODO" ]; then
  strip_sudoers "$TEMPLATE_USER"
  if id "$TEMPLATE_USER" >/dev/null 2>&1; then
    for g in sudo admin wheel; do gpasswd -d "$TEMPLATE_USER" "$g" >/dev/null 2>&1 || true; done
    passwd -l "$TEMPLATE_USER" >/dev/null 2>&1 || true
  fi
fi
# Sem senha para ninguém virar root por su (root com senha vazia passaria pelo nullok do PAM).
passwd -l "$XODO" >/dev/null 2>&1 || true
passwd -l root >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 4. Pastas do xodó
# ---------------------------------------------------------------------------
install -d -m 0750 -o "$XUID" -g "$XGID" "$XODO_HOME"
for dir in "$SPHERUM_HOME" "$SPHERUM_HOME/agencia" "$SPHERUM_HOME/clientes" "$SPHERUM_HOME/xodos" \
  "$SPHERUM_HOME/downloads" "$SPHERUM_HOME/.lixeira"; do
  install -d -m 0750 -o "$XUID" -g "$XGID" "$dir"
done
install -d -m 0700 -o "$XUID" -g "$XGID" "$XODO_HOME/.perfis" "$XODO_HOME/.perfis/agencia"

# ---------------------------------------------------------------------------
# 5. Programas e páginas do Spherum (de root; o xodó só lê e executa o page-browser)
# ---------------------------------------------------------------------------
install -d -m 0755 /opt/spherum "$BIN" "$WEB"
for f in "$STAGING"/bin/*; do
  [ -f "$f" ] || continue
  install -m 0755 -o root -g root "$f" "$BIN/${f##*/}"
done
[ -f "$STAGING/page-browser.py" ] && install -m 0755 -o root -g root "$STAGING/page-browser.py" "$BIN/page-browser.py"
for f in "$STAGING"/web/*; do
  [ -f "$f" ] || continue
  install -m 0644 -o root -g root "$f" "$WEB/${f##*/}"
done
# O cliente VNC (noVNC) do pacote, copiado junto das páginas.
rm -rf "$WEB/core" "$WEB/vendor"
cp -rL /usr/share/novnc/core "$WEB/core"
[ -d /usr/share/novnc/vendor ] && cp -rL /usr/share/novnc/vendor "$WEB/vendor"
chown -R root:root "$WEB"
chmod -R u=rwX,go=rX "$WEB"

# Fluxbox: menu só com o navegador, atalhos sem "executar" e sem terminal.
install -d -m 0755 "$ETC/fluxbox"
cat >"$ETC/fluxbox/init" <<EOF
session.menuFile: $ETC/fluxbox/menu
session.keyFile: $ETC/fluxbox/keys
session.appsFile: $ETC/fluxbox/apps
session.styleFile: /usr/share/fluxbox/styles/Emerge
session.screen0.rootCommand: xsetroot -solid #111113
session.screen0.toolbar.visible: true
session.screen0.toolbar.placement: BottomCenter
session.screen0.toolbar.widthPercent: 100
session.screen0.toolbar.tools: iconbar, clock
session.screen0.workspaces: 1
session.screen0.fullMaximization: true
session.screen0.allowRemoteActions: false
session.overlay.menuDelay: 0
EOF
cat >"$ETC/fluxbox/menu" <<'EOF'
[begin] (Spherum)
  [exec] (Navegador) {/usr/local/bin/chromium}
[end]
EOF
cat >"$ETC/fluxbox/keys" <<'EOF'
OnDesktop Mouse1 :HideMenus
OnDesktop Mouse3 :RootMenu
OnWindow Mod1 Mouse1 :MacroCmd {Raise} {Focus} {StartMoving}
OnTitlebar Double Mouse1 :Maximize
Mod1 Tab :NextWindow {groups} (workspace=[current])
Mod1 Shift Tab :PrevWindow {groups} (workspace=[current])
Mod1 F4 :Close
EOF
cat >"$ETC/fluxbox/apps" <<'EOF'
[app] (class=Chromium)
  [Maximized] {yes}
[end]
[app] (class=chromium)
  [Maximized] {yes}
[end]
[app] (class=Google-chrome)
  [Maximized] {yes}
[end]
EOF
chmod 0644 "$ETC"/fluxbox/*

# Sem terminal gráfico: o único shell do xodó é a ferramenta "terminal" (com o piso de comandos).
TERMINALS="xterm uxterm lxterm koi8rxterm x-terminal-emulator xfce4-terminal gnome-terminal gnome-terminal.real \
lxterminal mate-terminal konsole qterminal terminator tilix kitty alacritty urxvt rxvt rxvt-unicode st sakura \
terminology xfce4-terminal.wrapper fbrun"
locked=()
for name in $TERMINALS; do
  for dir in /usr/bin /usr/local/bin /bin; do
    path="$dir/$name"
    [ -e "$path" ] || continue
    target=$(readlink -f "$path")
    [ -f "$target" ] || continue
    case "$target" in /opt/spherum/* | /usr/local/bin/chromium) continue ;; esac
    chown root:root "$target"
    chmod 0700 "$target"
    locked+=("$path")
  done
done

# ---------------------------------------------------------------------------
# 6. Rede do xodó (por uid): sem redes privadas, metadata e SMTP
# ---------------------------------------------------------------------------
IPT=iptables
if ! iptables -w -S OUTPUT >/dev/null 2>&1; then
  if command -v iptables-legacy >/dev/null 2>&1 && iptables-legacy -w -S OUTPUT >/dev/null 2>&1; then
    IPT=iptables-legacy
  else
    die "iptables não funciona nesta máquina; sem ele a rede do xodó ficaria aberta"
  fi
fi
IPT6=${IPT/iptables/ip6tables}

chain_rules() {
  local tool=$1 family=$2
  $tool -w -N SPHERUM_XODO 2>/dev/null || $tool -w -F SPHERUM_XODO
  $tool -w -A SPHERUM_XODO -o lo -j RETURN
  if [ "$EGRESS" = restrito ]; then
    # Modo restrito: até o gate por domínio existir, o xodó fica sem saída nenhuma.
    $tool -w -A SPHERUM_XODO -j REJECT
  else
    if [ "$family" = 4 ]; then
      # DNS do próprio provedor pode morar numa faixa privada: só a porta 53 dele passa.
      for ns in $(awk '/^nameserver[[:space:]]/ {print $2}' /etc/resolv.conf 2>/dev/null); do
        if [[ "$ns" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
          $tool -w -A SPHERUM_XODO -d "$ns" -p udp --dport 53 -j RETURN
          $tool -w -A SPHERUM_XODO -d "$ns" -p tcp --dport 53 -j RETURN
        fi
      done
      for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
        $tool -w -A SPHERUM_XODO -d "$net" -j REJECT
      done
    else
      for net in fc00::/7 fe80::/10; do
        $tool -w -A SPHERUM_XODO -d "$net" -j REJECT
      done
    fi
    $tool -w -A SPHERUM_XODO -p tcp -m multiport --dports 25,465,587 -j REJECT
  fi
  $tool -w -A SPHERUM_XODO -j RETURN
  $tool -w -C OUTPUT -m owner --uid-owner "$XUID" -j SPHERUM_XODO 2>/dev/null ||
    $tool -w -I OUTPUT 1 -m owner --uid-owner "$XUID" -j SPHERUM_XODO
}
chain_rules "$IPT" 4 || die "não consegui aplicar as regras de rede (IPv4)"
if command -v "$IPT6" >/dev/null 2>&1 && $IPT6 -w -S OUTPUT >/dev/null 2>&1; then
  chain_rules "$IPT6" 6 || die "não consegui aplicar as regras de rede (IPv6)"
elif ip -6 route show default 2>/dev/null | grep -q .; then
  die "a máquina tem IPv6 mas o ip6tables não funciona"
fi

# ---------------------------------------------------------------------------
# 7. Serviços: troca os de uma versão anterior e sobe tudo
# ---------------------------------------------------------------------------
previous=$(cat "$ETC/runtime-version" 2>/dev/null || true)
if [ -n "$previous" ] && [ "$previous" != "$VERSION" ]; then
  say "trocando a versão $previous por $VERSION"
  pkill -f '/opt/spherum/bin/spherum-vigia' || true
  pkill -f 'websockify .*--token-source=/run/spherum/tokens' || true
fi
"$BIN/spherum-start"

# ---------------------------------------------------------------------------
# 8. Verificação final
# ---------------------------------------------------------------------------
# a) Só a 6100 (gateway) e as portas do agente do provedor escutam fora do loopback.
exposed=()
while read -r local_addr process; do
  [ -n "$local_addr" ] || continue
  port=${local_addr##*:}
  host=${local_addr%:*}
  host=${host#\[}
  host=${host%\]}
  host=${host%%%*}
  case "$host" in 127.* | ::1 | ::ffff:127.*) continue ;; esac
  if [ "$port" = 6100 ] && [[ "$process" == *websockify* || "$process" == *python* ]]; then continue; fi
  allowed=0
  for p in $ALLOWED_PORTS; do [ "$port" = "$p" ] && allowed=1; done
  [ "$allowed" -eq 1 ] && continue
  exposed+=("$local_addr $process")
done < <(ss -Htlnp 2>/dev/null | awk '{print $4, $6}')
if [ "${#exposed[@]}" -gt 0 ]; then
  die "porta exposta fora do loopback: ${exposed[*]}"
fi
# b) O gateway está de pé e o CDP só no loopback.
(echo >/dev/tcp/127.0.0.1/6100) >/dev/null 2>&1 || die "o gateway da tela não está escutando"
if ss -Htln 2>/dev/null | awk '{print $4}' | grep -Eq '(^|[^0-9])(0\.0\.0\.0|\*|\[::\]):9222$'; then
  die "o CDP do navegador está exposto"
fi
# c) Os sockets de VNC e do terminal ficam numa pasta de root.
[ "$(stat -c '%U %a' /run/spherum)" = "root 700" ] || die "/run/spherum precisa ser de root com 0700"
[ "$(stat -c '%U %a' /run/spherum/tokens)" = "root 700" ] || die "/run/spherum/tokens precisa ser de root com 0700"
# d) O xodo não vira root.
if id -nG "$XODO" | tr ' ' '\n' | grep -Eqx 'sudo|admin|wheel|root|docker|lxd'; then die "o xodo está num grupo de administrador"; fi
if command -v sudo >/dev/null 2>&1 && setpriv --reuid="$XODO" --regid="$XODO" --init-groups -- sudo -n true >/dev/null 2>&1; then
  die "o xodo ainda tem sudo"
fi
# e) As regras de rede estão no lugar.
$IPT -w -C OUTPUT -m owner --uid-owner "$XUID" -j SPHERUM_XODO || die "as regras de rede do xodo sumiram"
if [ "$EGRESS" = aberto ]; then
  $IPT -w -S SPHERUM_XODO | grep -q -- '-d 169.254.0.0/16 .*REJECT' || die "o bloqueio da metadata não ficou"
fi
# f) Nenhum terminal gráfico que o xodo consiga abrir.
for path in "${locked[@]}"; do
  if setpriv --reuid="$XODO" --regid="$XODO" --init-groups -- test -x "$path"; then die "o xodo ainda abre $path"; fi
done

printf '%s\n' "$VERSION" >"$ETC/runtime-version"
rm -rf -- "$STAGING"
say "pronto (versão $VERSION, uid do xodo $XUID)"
echo SPHERUM_PREPARE_OK
