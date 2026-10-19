# Adaptado de packages/core/src/node/desktop-runtime.ts do Rakazo (Apache-2.0): tela, VNC em socket Unix e gateway com TokenFile.
# Funções comuns dos scripts da máquina. Tudo aqui roda como root; o xodó (usuário xodo, sem
# sudo) só usa a tela, o navegador e o terminal da ferramenta.

SPHERUM_RUN=/run/spherum
SPHERUM_BIN=/opt/spherum/bin
SPHERUM_WEB=/opt/spherum/web
SPHERUM_ETC=/etc/spherum
SPHERUM_LOG=/var/log/spherum
SPHERUM_DISPLAY=:20
SPHERUM_DISPLAY_NUM=20
SPHERUM_GATEWAY_PORT=6100
SPHERUM_CDP_PORT=9222
TOKEN_DIR=$SPHERUM_RUN/tokens
EXPIRY_DIR=$SPHERUM_RUN/expiry
STAGING_DIR=$SPHERUM_RUN/staging
VIEW_SOCKET=$SPHERUM_RUN/vnc-view.sock
CONTROL_SOCKET=$SPHERUM_RUN/vnc-control.sock
PTY_SOCKET=$SPHERUM_RUN/pty.sock
PTY_SHELLS=$SPHERUM_RUN/pty-shells
XODO_USER=xodo
XODO_HOME=/home/xodo
# Tela e navegador num usuário à parte: o terminal do xodo (e o da pessoa) não alcança a tela,
# o CDP, os cookies dos perfis nem o arquivo de perfil ativo.
NAV_USER=navegador
NAV_HOME=/home/navegador
SPHERUM_XAUTH=$NAV_HOME/.Xauthority

# Comando como xodo, sem fork (setpriv troca o uid e executa), no ambiente limpo e sem tela.
SPHERUM_AS_XODO=(setpriv --reuid="$XODO_USER" --regid="$XODO_USER" --init-groups --no-new-privs --
  env -i HOME="$XODO_HOME" PATH=/usr/local/bin:/usr/bin:/bin LANG=pt_BR.UTF-8 TZ=America/Sao_Paulo)

# Comando como navegador (tela, fluxbox, Chromium e page-browser).
SPHERUM_AS_NAV=(setpriv --reuid="$NAV_USER" --regid="$NAV_USER" --init-groups --no-new-privs --
  env -i HOME="$NAV_HOME" PATH=/usr/local/bin:/usr/bin:/bin LANG=pt_BR.UTF-8 TZ=America/Sao_Paulo
  DISPLAY="$SPHERUM_DISPLAY" XAUTHORITY="$SPHERUM_XAUTH")

spherum_require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "precisa rodar como root" >&2
    exit 77
  fi
}

# Pastas de root (0700): tokens, vencimentos, sockets e registros ficam fora do alcance do xodó.
spherum_dirs() {
  umask 077
  mkdir -p "$SPHERUM_RUN" "$TOKEN_DIR" "$EXPIRY_DIR" "$STAGING_DIR" "$PTY_SHELLS" "$SPHERUM_LOG"
  chown root:root "$SPHERUM_RUN" "$TOKEN_DIR" "$EXPIRY_DIR" "$STAGING_DIR" "$PTY_SHELLS" "$SPHERUM_LOG"
  chmod 700 "$SPHERUM_RUN" "$TOKEN_DIR" "$EXPIRY_DIR" "$STAGING_DIR" "$PTY_SHELLS" "$SPHERUM_LOG"
}

# Espera uma condição por até N décimos de segundo.
spherum_wait() {
  local n=$1 i
  shift
  for ((i = 0; i < n; i++)); do
    if "$@"; then return 0; fi
    sleep 0.1
  done
  "$@"
}

# O pid gravado no arquivo está vivo e é o processo esperado?
spherum_pid_alive() {
  local file=$1 pattern=$2 pid
  pid=$(cat -- "$file" 2>/dev/null) || return 1
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -Eq -- "$pattern"
}

# Para o processo do arquivo (TERM, depois KILL) e apaga o arquivo.
spherum_stop_pid() {
  local file=$1 pattern=$2 pid i
  if spherum_pid_alive "$file" "$pattern"; then
    pid=$(cat -- "$file")
    kill -TERM "$pid" 2>/dev/null || true
    for ((i = 0; i < 20; i++)); do
      spherum_pid_alive "$file" "$pattern" || break
      sleep 0.1
    done
    if spherum_pid_alive "$file" "$pattern"; then kill -KILL "$pid" 2>/dev/null || true; fi
  fi
  rm -f -- "$file"
}

spherum_display_up() {
  DISPLAY=$SPHERUM_DISPLAY XAUTHORITY=$SPHERUM_XAUTH xdpyinfo >/dev/null 2>&1
}

spherum_port_open() {
  (echo >"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

spherum_socket_ready() {
  [ -S "$1" ]
}
