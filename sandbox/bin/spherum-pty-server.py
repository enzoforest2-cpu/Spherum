# Adaptado de packages/core/src/node/terminal-server.ts do Rakazo (Apache-2.0): servidor PTY atrás do websockify.
"""Terminal da pessoa no controle (só existe enquanto o controle dura).

Roda como root num socket Unix de root; cada conexão (o websockify repassa uma por aba) ganha um
bash do usuário xodo, no ambiente limpo e sem poder ganhar privilégios (no_new_privs). A saída
vai em bytes crus; a entrada chega em quadros [tipo:u8][tamanho:u32be][dados]: tipo 0 é texto,
tipo 1 é o tamanho da janela (colunas e linhas em u16be).
"""

import ctypes
import fcntl
import os
import pty
import pwd
import select
import signal
import socket
import struct
import sys
import termios

PATH = sys.argv[1]
SHELLS = sys.argv[2] if len(sys.argv) > 2 else "/run/spherum/pty-shells"
USER = "xodo"
CWD = "/home/xodo/spherum"
MAX_FRAME = 1 << 20
MAX_SESSIONS = 4
PR_SET_NO_NEW_PRIVS = 38


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


def drop_to_xodo():
    """No filho do PTY: vira xodo de vez (grupos, gid, uid) e trava novos privilégios."""
    entry = pwd.getpwnam(USER)
    os.initgroups(USER, entry.pw_gid)
    os.setgid(entry.pw_gid)
    os.setuid(entry.pw_uid)
    if os.getuid() == 0 or os.geteuid() == 0:
        os._exit(1)
    try:
        ctypes.CDLL(None, use_errno=True).prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
    except (OSError, AttributeError):
        pass
    return entry


def serve(conn):
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    # Parar o terminal manda TERM a cada sessão: sai pelo finally e fecha o bash.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    pid, fd = pty.fork()
    if pid == 0:
        entry = drop_to_xodo()
        env = {
            "HOME": entry.pw_dir,
            "USER": USER,
            "LOGNAME": USER,
            "SHELL": "/bin/bash",
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": "pt_BR.UTF-8",
            "TZ": "America/Sao_Paulo",
            "DISPLAY": ":20",
            "TERM": "xterm-256color",
        }
        try:
            os.chdir(CWD)
        except OSError:
            os.chdir(entry.pw_dir)
        os.execve("/bin/bash", ["/bin/bash", "-l"], env)
    marker = os.path.join(SHELLS, str(pid))
    try:
        with open(marker, "w") as fh:
            fh.write(str(pid))
    except OSError:
        pass
    pending = b""
    try:
        while True:
            ready = select.select([conn, fd], [], [])[0]
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                conn.sendall(data)
            if conn in ready:
                data = conn.recv(65536)
                if not data:
                    break
                pending += data
                while len(pending) >= 5:
                    kind = pending[0]
                    size = struct.unpack(">I", pending[1:5])[0]
                    if size > MAX_FRAME:
                        return
                    if len(pending) < 5 + size:
                        break
                    payload, pending = pending[5:5 + size], pending[5 + size:]
                    if kind == 0:
                        write_all(fd, payload)
                    elif kind == 1 and len(payload) == 4:
                        cols, rows = struct.unpack(">HH", payload)
                        if 0 < cols <= 1000 and 0 < rows <= 1000:
                            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    finally:
        try:
            os.killpg(pid, signal.SIGHUP)
        except OSError:
            pass
        os.close(fd)
        conn.close()
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
        try:
            os.unlink(marker)
        except OSError:
            pass


def main():
    os.makedirs(SHELLS, mode=0o700, exist_ok=True)
    try:
        os.unlink(PATH)
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    previous = os.umask(0o077)
    server.bind(PATH)
    os.umask(previous)
    server.listen(8)
    children = set()

    def reap(*_):
        while True:
            try:
                done, _status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if done == 0:
                return
            children.discard(done)

    signal.signal(signal.SIGCHLD, reap)
    while True:
        try:
            conn = server.accept()[0]
        except InterruptedError:
            continue
        if len(children) >= MAX_SESSIONS:
            conn.close()
            continue
        child = os.fork()
        if child == 0:
            server.close()
            try:
                serve(conn)
            finally:
                os._exit(0)
        children.add(child)
        conn.close()


if __name__ == "__main__":
    main()
