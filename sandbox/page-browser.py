# Adaptado de infra/sandboxes/computer/rakazo-page-browser do Rakazo (Apache-2.0); campos sensíveis como server/browser/cdp/sensitive.ts do OpenMausBot (Apache-2.0).
"""Navegador do xodó por CDP (só biblioteca padrão).

Fica em /opt/spherum/bin/page-browser.py e roda como o usuário xodo:

    python3 page-browser.py <acao> -     (argumentos em base64 de JSON pela entrada padrão)

Ações: estado, abrir, ler, clicar, preencher, foco, tecla, abas. Sempre imprime uma linha de
JSON ({"ok": true, ...} ou {"ok": false, "erro": "<código>", "mensagem": "..."}).

- Fala com o Chromium em 127.0.0.1:9222 e lê a página num mundo isolado (o script da página
  não enxerga nem altera os ajudantes).
- Um perfil por cliente: ~/.perfis/agencia ou ~/.perfis/cliente-<id>. Trocar de perfil fecha
  o Chromium e abre outro com o perfil pedido.
- Campos de senha, código e cartão nunca têm o valor lido, e não podem ser preenchidos.
- Clicar, preencher e apertar tecla conferem, na mesma avaliação, que a página ainda é a
  esperada (endereço e rótulo do elemento); se mudou, nada é feito.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.request
from typing import Any
from urllib.parse import urlsplit

CDP_HOST = "127.0.0.1"
CDP_PORT = 9222
PERFIS = os.path.join(os.path.expanduser("~"), ".perfis")
ESTADO = os.path.join(PERFIS, ".ativo.json")
MAX_ELEMENTOS = 80
MAX_TEXTO = 20000
MAX_ROTULO = 200
MAX_VALOR = 200
MAX_ARGS = 1024 * 1024
WORLD_NAME = "spherum-page-browser"

PERFIL_RE = re.compile(r"^(agencia|cliente-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
REF_RE = re.compile(r"^[A-Za-z0-9]{1,80}$")

# Mesmo padrão do sensitive.ts do OpenMausBot, com os nomes em português.
SENSITIVE_FIELD = re.compile(
    r"(password|passwd|passcode|client.?secret|api.?key|secret.?key|private.?key|signing.?key|webhook.?secret|"
    r"secret.?access.?key|access.?token|auth.?token|refresh.?token|bearer.?token|one.?time|otp|verification.?code|"
    r"recovery.?code|seed.?phrase|mnemonic|recovery.?phrase|security.?answer|cc-.+|card.?(number|security|cvv|cvc)|"
    r"cvv|cvc|bank.?(account|routing)|routing.?(number|code)|account.?(number|no)|social.?(security|insurance)|ssn|tax.?id|"
    r"senha|codigo.?de.?(verificacao|seguranca|acesso|confirmacao)|token|cartao|numero.?do.?cartao|validade.?do.?cartao|"
    r"chave.?(secreta|de.?api|privada)|frase.?de.?recuperacao|assinatura.?eletronica)",
    re.IGNORECASE,
)
SENSITIVE_WORD = re.compile(r"(?:^| )(pin|security code|cod seguranca|2fa|mfa)(?: |$)")


class PageError(Exception):
    """Erro esperado, com um código que o servidor entende."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


# ---------------------------------------------------------------------------
# Funções puras (testadas sem navegador)
# ---------------------------------------------------------------------------


def _ascii(text: str) -> str:
    import unicodedata

    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")


def is_sensitive(kind: str, hints: list[Any]) -> bool:
    """Campo cujo valor nunca aparece e que o xodó não preenche (senha, código, cartão)."""
    if str(kind or "").lower() == "password":
        return True
    raw = _ascii(" ".join(str(h) for h in hints if h))
    words = re.sub(r"[^A-Za-z0-9]+", " ", re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw)).strip().lower()
    return bool(SENSITIVE_FIELD.search(raw)) or bool(SENSITIVE_WORD.search(words))


def parse_args(raw: str) -> dict[str, Any]:
    """Argumentos chegam em base64 de JSON (nunca interpolados no shell)."""
    if not raw:
        return {}
    if len(raw) > MAX_ARGS:
        raise PageError("invalido", "argumentos grandes demais")
    try:
        data = json.loads(base64.b64decode(raw, validate=True).decode("utf-8"))
    except ValueError as exc:  # base64, UTF-8 e JSON inválidos são todos ValueError
        raise PageError("invalido", "argumentos ilegíveis") from exc
    if not isinstance(data, dict):
        raise PageError("invalido", "argumentos precisam ser um objeto")
    return data


def _clip(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()[:limit]


def shape_elements(raw: Any, limit: int = MAX_ELEMENTOS) -> list[dict[str, Any]]:
    """Elementos que saem para o servidor: ref, papel, rótulo e valor (nunca de campo sensível)."""
    out: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if len(out) >= limit:
            break
        if not isinstance(item, dict) or not isinstance(item.get("ref"), str) or not REF_RE.match(item["ref"]):
            continue
        hints = item.get("dicas") if isinstance(item.get("dicas"), list) else []
        sensitive = bool(item.get("sensivel")) or is_sensitive(str(item.get("tipo") or ""), [*hints, item.get("rotulo")])
        element: dict[str, Any] = {
            "ref": item["ref"],
            "papel": _clip(item.get("papel"), 40) or "elemento",
            "rotulo": _clip(item.get("rotulo"), MAX_ROTULO),
            "h": item.get("h") if isinstance(item.get("h"), (int, str)) else "",
            "sensivel": sensitive,
        }
        value = item.get("valor")
        if sensitive:
            if value not in (None, ""):
                element["valor"] = "[oculto]"
        elif value not in (None, ""):
            element["valor"] = _clip(value, MAX_VALOR)
        if item.get("foco"):
            element["foco"] = True
            if item.get("envio"):
                element["envio"] = _clip(item.get("envio"), MAX_ROTULO)
        out.append(element)
    return out


def same_page(current: str, expected: str) -> bool:
    """Mesma página: o endereço sem o fragmento (#...)."""
    return str(current).split("#", 1)[0] == str(expected).split("#", 1)[0]


KEYS: dict[str, tuple[str, str, int, str | None]] = {
    "enter": ("Enter", "Enter", 13, "\r"),
    "return": ("Enter", "Enter", 13, "\r"),
    "tab": ("Tab", "Tab", 9, None),
    "escape": ("Escape", "Escape", 27, None),
    "esc": ("Escape", "Escape", 27, None),
    "backspace": ("Backspace", "Backspace", 8, None),
    "delete": ("Delete", "Delete", 46, None),
    "space": (" ", "Space", 32, " "),
    "arrowup": ("ArrowUp", "ArrowUp", 38, None),
    "arrowdown": ("ArrowDown", "ArrowDown", 40, None),
    "arrowleft": ("ArrowLeft", "ArrowLeft", 37, None),
    "arrowright": ("ArrowRight", "ArrowRight", 39, None),
    "up": ("ArrowUp", "ArrowUp", 38, None),
    "down": ("ArrowDown", "ArrowDown", 40, None),
    "left": ("ArrowLeft", "ArrowLeft", 37, None),
    "right": ("ArrowRight", "ArrowRight", 39, None),
    "home": ("Home", "Home", 36, None),
    "end": ("End", "End", 35, None),
    "pageup": ("PageUp", "PageUp", 33, None),
    "pagedown": ("PageDown", "PageDown", 34, None),
}
MODIFIERS = {"alt": 1, "control": 2, "ctrl": 2, "meta": 4, "cmd": 4, "shift": 8}
# Com Control/Meta só o básico de edição: nada de barra de endereço, abrir arquivo, ver código-fonte.
CTRL_ALLOWED = {"a", "c", "v", "x", "z", "y", "Enter", "Backspace", "Delete", "Home", "End", "ArrowLeft", "ArrowRight"}
NAVIGATION = {"Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"}


def key_spec(tecla: str) -> dict[str, Any]:
    """Tecla ("Enter", "Tab", "a", "Control+a", "Shift+Tab") no formato do Input.dispatchKeyEvent."""
    if not isinstance(tecla, str) or not re.fullmatch(r"[A-Za-z0-9+_]{1,40}", tecla):
        raise PageError("tecla", "tecla inválida")
    parts = tecla.split("+")
    if any(not p for p in parts):
        raise PageError("tecla", "tecla inválida")
    *mods, name = parts
    mask = 0
    for mod in mods:
        bit = MODIFIERS.get(mod.lower())
        if bit is None or mask & bit:
            raise PageError("tecla", "modificador inválido")
        mask |= bit
    lower = name.lower()
    if lower in KEYS:
        key, code, vk, text = KEYS[lower]
    elif re.fullmatch(r"[A-Za-z0-9]", name):
        key = name
        upper = name.upper()
        code = f"Key{upper}" if name.isalpha() else f"Digit{name}"
        vk = ord(upper)
        text = name.upper() if mask & 8 and name.isalpha() else name
    else:
        raise PageError("tecla", "tecla não permitida")
    if mask & (1 | 2 | 4):
        if mask & 1 or (key if len(key) > 1 else key.lower()) not in CTRL_ALLOWED:
            raise PageError("tecla", "combinação não permitida")
        if key != "Enter":
            text = None
    return {"key": key, "code": code, "vk": vk, "text": text, "modifiers": mask, "enter": key == "Enter"}


def types_text(spec: dict[str, Any]) -> bool:
    """A tecla mexe no conteúdo do campo (letra, número, espaço, apagar, colar)."""
    return spec["key"] not in NAVIGATION


# ---------------------------------------------------------------------------
# CDP (WebSocket mínimo, como no Rakazo)
# ---------------------------------------------------------------------------


# Sem proxy: o CDP é local (um proxy do ambiente nunca deve ver essa conversa).
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_get_json(url: str, timeout: float = 5.0) -> Any:
    with _OPENER.open(url, timeout=timeout) as resp:  # noqa: S310 (só 127.0.0.1)
        data = resp.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise RuntimeError("resposta do CDP grande demais")
        return json.loads(data.decode("utf-8"))


def cdp_ready(timeout_s: float) -> bool:
    deadline = time.time() + timeout_s
    while True:
        try:
            http_get_json(f"http://{CDP_HOST}:{CDP_PORT}/json/version", timeout=1.0)
            return True
        except Exception:  # noqa: BLE001
            if time.time() >= deadline:
                return False
            time.sleep(0.25)


def discover_ws_url() -> str:
    version = http_get_json(f"http://{CDP_HOST}:{CDP_PORT}/json/version")
    ws = version.get("webSocketDebuggerUrl")
    if not isinstance(ws, str) or not ws:
        raise RuntimeError("CDP sem webSocketDebuggerUrl")
    parsed = urlsplit(ws)
    if parsed.scheme != "ws" or parsed.hostname != CDP_HOST or parsed.port != CDP_PORT:
        raise RuntimeError("endereço do CDP inesperado")
    return ws


class CdpClient:
    def __init__(self, ws_url: str) -> None:
        self._ws_url = ws_url
        self._sock: socket.socket | None = None
        self._buf = bytearray()
        self._next_id = 1
        self.context_id: int | None = None
        self._pending: dict[int, dict[str, Any] | None] = {}
        self._contexts: dict[int, dict[str, Any]] = {}

    def connect(self) -> None:
        rest = self._ws_url[len("ws://") :]
        host_port, _, path = rest.partition("/")
        host, _, port_s = host_port.partition(":")
        sock = socket.create_connection((host, int(port_s or 80)), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(req.encode("ascii"))
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeError("CDP fechou no handshake")
            data += chunk
            if len(data) > 16_384:
                raise RuntimeError("handshake do CDP grande demais")
        header, _, leftover = data.partition(b"\r\n\r\n")
        if b"101" not in header.split(b"\r\n", 1)[0]:
            raise RuntimeError("CDP recusou o websocket")
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest())
        if expected not in header:
            raise RuntimeError("CDP com aceite inválido")
        self._sock = sock
        self._buf.extend(leftover)

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def _send(self, opcode: int, payload: bytes) -> None:
        assert self._sock is not None
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", n))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", n))
        header.extend(mask)
        self._sock.sendall(header + masked)

    def _read_more(self) -> None:
        assert self._sock is not None
        chunk = self._sock.recv(65536)
        if not chunk:
            raise RuntimeError("CDP fechou")
        self._buf.extend(chunk)

    def _read_frame(self) -> bytes:
        while True:
            while len(self._buf) < 2:
                self._read_more()
            b1, b2 = self._buf[0], self._buf[1]
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            offset = 2
            if length == 126:
                while len(self._buf) < 4:
                    self._read_more()
                length = struct.unpack("!H", self._buf[2:4])[0]
                offset = 4
            elif length == 127:
                while len(self._buf) < 10:
                    self._read_more()
                length = struct.unpack("!Q", self._buf[2:10])[0]
                offset = 10
            if length > 4 * 1024 * 1024:
                raise RuntimeError("mensagem do CDP grande demais")
            if not (b1 & 0x80):
                raise RuntimeError("mensagem fragmentada do CDP")
            mask = b""
            if masked:
                while len(self._buf) < offset + 4:
                    self._read_more()
                mask = bytes(self._buf[offset : offset + 4])
                offset += 4
            while len(self._buf) < offset + length:
                self._read_more()
            payload = bytes(self._buf[offset : offset + length])
            del self._buf[: offset + length]
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise RuntimeError("CDP fechou")
            if opcode == 0x9:
                self._send(0xA, payload)
                continue
            if opcode in (0x0, 0x1, 0x2):
                return payload

    def _event(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        params = message.get("params") or {}
        session_id = message.get("sessionId")
        if method == "Runtime.executionContextCreated":
            context = params.get("context")
            if isinstance(context, dict) and isinstance(context.get("id"), int):
                self._contexts[context["id"]] = {**context, "_sessionId": session_id}
        elif method == "Runtime.executionContextDestroyed":
            if isinstance(params.get("executionContextId"), int):
                self._contexts.pop(params["executionContextId"], None)
        elif method == "Runtime.executionContextsCleared":
            self._contexts = {k: v for k, v in self._contexts.items() if session_id is not None and v.get("_sessionId") != session_id}

    def find_world(self, frame_id: str, session_id: str) -> int | None:
        for context_id, context in self._contexts.items():
            aux = context.get("auxData") or {}
            if (
                context.get("name") == WORLD_NAME
                and context.get("_sessionId") == session_id
                and isinstance(aux, dict)
                and aux.get("frameId") == frame_id
                and aux.get("isDefault") is False
            ):
                return context_id
        return None

    def call(self, method: str, params: dict[str, Any] | None = None, *, session_id: str | None = None, timeout_s: float = 30.0) -> dict[str, Any]:
        assert self._sock is not None
        msg_id = self._next_id
        self._next_id += 1
        payload: dict[str, Any] = {"id": msg_id, "method": method, "params": params or {}}
        if session_id:
            payload["sessionId"] = session_id
        self._pending[msg_id] = None
        self._send(0x1, json.dumps(payload).encode("utf-8"))
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            done = self._pending.get(msg_id)
            if done is not None:
                self._pending.pop(msg_id, None)
                if "error" in done:
                    raise RuntimeError(f"{method} falhou")
                result = done.get("result")
                return result if isinstance(result, dict) else {}
            self._sock.settimeout(max(0.1, deadline - time.time()))
            try:
                frame = self._read_frame()
            except socket.timeout:
                continue
            message = json.loads(frame.decode("utf-8"))
            if not isinstance(message, dict):
                continue
            if message.get("id") in self._pending:
                self._pending[int(message["id"])] = message
            elif message.get("method"):
                self._event(message)
        raise TimeoutError(f"CDP demorou: {method}")


# ---------------------------------------------------------------------------
# Ajudantes da página (mundo isolado)
# ---------------------------------------------------------------------------

HELPERS = r"""
(() => {
  if (window.__spherumPage) return true;
  const refs = new Map();
  const refOf = new WeakMap();
  const SENS = /(password|passwd|passcode|client.?secret|api.?key|secret.?key|private.?key|access.?token|auth.?token|refresh.?token|one.?time|otp|verification.?code|recovery.?code|seed.?phrase|mnemonic|security.?answer|cc-.+|card.?(number|security|cvv|cvc)|cvv|cvc|bank.?(account|routing)|account.?(number|no)|ssn|tax.?id|senha|c[oó]digo.?de.?(verifica[cç][aã]o|seguran[cç]a|acesso|confirma[cç][aã]o)|token|cart[aã]o|chave.?(secreta|de.?api|privada))/i;
  function sensitive(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/(password|one-time-code|cc-)/.test(auto)) return true;
    const hints = [auto, el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"),
      Array.from(el.labels || []).map((l) => l.textContent).join(" ")].filter(Boolean).join(" ");
    return SENS.test(hints) || /(^|\W)(pin|2fa|mfa)(\W|$)/i.test(hints);
  }
  // Hash curto do rótulo (cyrb53): confere que o botão ainda é o mesmo sem guardar o texto.
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  function newRef() {
    return "e" + Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(16).padStart(8, "0")).join("");
  }
  function refFor(el) {
    let ref = refOf.get(el);
    if (!ref) {
      ref = newRef();
      refOf.set(el, ref);
      refs.set(ref, el);
    }
    return ref;
  }
  function prune() {
    for (const [ref, el] of refs) if (!el.isConnected) refs.delete(ref);
  }
  function visible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      return "textbox";
    }
    if (tag === "textarea" || el.isContentEditable) return "textbox";
    if (tag === "select") return "combobox";
    return tag;
  }
  function nameOf(el) {
    const raw = el.getAttribute("aria-label") ||
      Array.from(el.labels || []).map((l) => l.textContent).join(" ").trim() ||
      el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") ||
      ((el.tagName === "INPUT" && ["submit", "button"].includes(el.type)) ? el.value : "") ||
      (el.innerText || el.textContent || "").trim() || el.getAttribute("name") || "";
    return String(raw).replace(/\s+/g, " ").trim().slice(0, 200);
  }
  function interactive(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "hidden") return false;
    if (["a", "button", "input", "textarea", "select", "summary"].includes(tag)) return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute("role");
    if (role && ["button", "link", "textbox", "checkbox", "radio", "menuitem", "tab", "option", "switch", "combobox", "searchbox"].includes(role)) return true;
    return typeof el.onclick === "function" || el.hasAttribute("tabindex");
  }
  function valueOf(el) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "marcado" : "desmarcado";
    if ("value" in el && typeof el.value === "string") return el.value.slice(0, 200);
    return undefined;
  }
  function submitOf(el) {
    const form = el.form || (el.closest && el.closest("form"));
    if (!form) return "";
    const button = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    return button ? nameOf(button) : "";
  }
  function samePage(a, b) {
    return String(a).split("#")[0] === String(b).split("#")[0];
  }
  function fail(code) {
    throw new Error("SPHERUM:" + code);
  }
  function resolve(ref) {
    const el = refs.get(String(ref));
    if (!el || !el.isConnected || !visible(el)) fail("ref");
    if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") fail("desabilitado");
    return el;
  }
  function expect(esperado) {
    if (esperado && esperado.url && !samePage(location.href, esperado.url)) fail("mudou");
  }
  function page() {
    return { url: location.href, titulo: (document.title || "").slice(0, 200) };
  }
  function setValue(el, value) {
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype
        : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
      if (el.value !== String(value)) fail("nao_aceitou");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      document.execCommand("selectAll", false);
      if (!document.execCommand("insertText", false, String(value))) {
        el.textContent = String(value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else fail("nao_preenchivel");
  }
  window.__spherumPage = {
    snapshot(max) {
      prune();
      const active = document.activeElement;
      const elementos = [];
      for (const el of document.querySelectorAll("body *")) {
        if (!interactive(el) || !visible(el)) continue;
        const s = sensitive(el);
        const name = nameOf(el);
        const item = { ref: refFor(el), papel: roleOf(el), rotulo: name, h: hash(name), sensivel: s,
          tipo: (el.getAttribute("type") || el.tagName).toLowerCase() };
        if (!s) item.valor = valueOf(el);
        if (el === active) { item.foco = true; item.envio = submitOf(el); }
        elementos.push(item);
        if (elementos.length >= 80) break;
      }
      const texto = document.body ? document.body.innerText || "" : "";
      return { ...page(), texto: texto.slice(0, max), total: texto.length, elementos,
        quadros: Boolean(document.querySelector("iframe,frame")) };
    },
    click(ref, esperado) {
      expect(esperado);
      const el = resolve(ref);
      if (esperado && esperado.h !== undefined && String(hash(nameOf(el))) !== String(esperado.h)) fail("mudou");
      el.scrollIntoView({ block: "center" });
      el.focus();
      el.click();
      return page();
    },
    fill(campos, esperado) {
      expect(esperado);
      // Confere tudo antes de mexer em qualquer campo.
      const targets = campos.map((c) => {
        const el = resolve(c.ref);
        if (sensitive(el)) fail("campo_sensivel");
        if (c.h !== undefined && String(hash(nameOf(el))) !== String(c.h)) fail("mudou");
        if (el.readOnly) fail("somente_leitura");
        if (el instanceof HTMLInputElement && !["text", "search", "email", "url", "tel", "number", ""].includes(el.type)) fail("nao_preenchivel");
        return [el, c.texto];
      });
      for (const [el, texto] of targets) setValue(el, texto);
      return { ...page(), preenchidos: targets.length };
    },
    focus() {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { ...page(), foco: null };
      return { ...page(), foco: { papel: roleOf(el), rotulo: nameOf(el), envio: submitOf(el), sensivel: sensitive(el) } };
    },
    expect(esperado) {
      expect(esperado);
      const el = document.activeElement;
      return { sensivel: Boolean(el && el !== document.body && sensitive(el)) };
    },
  };
  return true;
})()
"""


def eval_json(client: CdpClient, session_id: str, expression: str) -> Any:
    result = client.call(
        "Runtime.evaluate",
        {"expression": expression, "contextId": client.context_id, "returnByValue": True, "awaitPromise": True},
        session_id=session_id,
    )
    details = result.get("exceptionDetails")
    if details:
        found = re.search(r"SPHERUM:([a-z_]+)", json.dumps(details))
        if found:
            raise PageError(found.group(1))
        raise RuntimeError("a página recusou o comando")
    return (result.get("result") or {}).get("value")


def ensure_world(client: CdpClient, session_id: str) -> None:
    frame_id = client.call("Page.getFrameTree", session_id=session_id)["frameTree"]["frame"]["id"]
    client.call("Runtime.enable", session_id=session_id)
    existing = client.find_world(frame_id, session_id)
    if existing is not None:
        client.context_id = existing
        return
    world = client.call("Page.createIsolatedWorld", {"frameId": frame_id, "worldName": WORLD_NAME}, session_id=session_id)
    client.context_id = world["executionContextId"]


def ensure_helpers(client: CdpClient, session_id: str) -> None:
    ensure_world(client, session_id)
    eval_json(client, session_id, HELPERS)


def call_helper(client: CdpClient, session_id: str, method: str, *args: Any) -> Any:
    ensure_helpers(client, session_id)
    return eval_json(client, session_id, f"window.__spherumPage.{method}({', '.join(json.dumps(a) for a in args)})")


# ---------------------------------------------------------------------------
# Perfil e Chromium
# ---------------------------------------------------------------------------


def read_state() -> dict[str, Any]:
    try:
        with open(ESTADO, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(state: dict[str, Any]) -> None:
    os.makedirs(PERFIS, mode=0o700, exist_ok=True)
    tmp = f"{ESTADO}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    os.replace(tmp, ESTADO)


def current_profile() -> str:
    if not cdp_ready(0.5):
        return "nenhum"
    perfil = read_state().get("perfil")
    return perfil if isinstance(perfil, str) and PERFIL_RE.match(perfil) else "desconhecido"


def stop_browser(state: dict[str, Any]) -> None:
    pid = state.get("pid")
    if isinstance(pid, int) and pid > 1:
        try:
            os.kill(pid, signal.SIGTERM)
            for _ in range(50):
                os.kill(pid, 0)
                time.sleep(0.1)
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    # Um Chromium de antes (sem estado) também precisa sair para liberar a porta.
    try:
        subprocess.run(["pkill", "-u", str(os.getuid()), "-f", "--", f"--remote-debugging-port={CDP_PORT}"], check=False, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass
    for _ in range(50):
        if not cdp_ready(0.1):
            return
        time.sleep(0.1)


def browser_binary() -> str:
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        found = shutil.which(name)
        if found:
            return found
    raise PageError("fechado", "Chromium não encontrado")


def ensure_profile(perfil: str) -> None:
    if not PERFIL_RE.match(perfil):
        raise PageError("perfil", "perfil inválido")
    state = read_state()
    if state.get("perfil") == perfil and cdp_ready(0.5):
        return
    stop_browser(state)
    directory = os.path.join(PERFIS, perfil)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    process = subprocess.Popen(  # noqa: S603 (argumentos fixos e perfil validado)
        [
            browser_binary(),
            f"--user-data-dir={directory}",
            f"--remote-debugging-address={CDP_HOST}",
            f"--remote-debugging-port={CDP_PORT}",
            "--no-first-run",
            "--no-default-browser-check",
            "--password-store=basic",
            "--lang=pt-BR",
            "--window-position=0,0",
            "--window-size=1280,800",
            "about:blank",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    write_state({"perfil": perfil, "pid": process.pid})
    if not cdp_ready(15.0):
        raise PageError("fechado", "o navegador não abriu")


def connect() -> CdpClient:
    if not cdp_ready(2.0):
        raise PageError("fechado")
    client = CdpClient(discover_ws_url())
    client.connect()
    return client


def pages(client: CdpClient) -> list[dict[str, Any]]:
    targets = client.call("Target.getTargets").get("targetInfos") or []
    return [t for t in targets if isinstance(t, dict) and t.get("type") == "page"][:32]


def attach(client: CdpClient, target_id: str) -> str:
    session_id = client.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})["sessionId"]
    client.call("Page.enable", session_id=session_id)
    return session_id


def active_tab(client: CdpClient) -> tuple[str, str]:
    """Aba ativa: a última escolhida pelo xodó, senão a visível com foco, senão a primeira."""
    tabs = pages(client)
    if not tabs:
        created = client.call("Target.createTarget", {"url": "about:blank"})
        tabs = [{"targetId": created["targetId"]}]
    chosen = read_state().get("aba")
    ids = [t["targetId"] for t in tabs]
    if chosen in ids:
        return chosen, attach(client, chosen)
    visible: list[tuple[str, str, bool]] = []
    for target_id in ids:
        try:
            session_id = attach(client, target_id)
            ensure_world(client, session_id)
            if eval_json(client, session_id, 'document.visibilityState === "visible"'):
                visible.append((target_id, session_id, bool(eval_json(client, session_id, "document.hasFocus()"))))
        except Exception:  # noqa: BLE001
            continue
    focused = [v for v in visible if v[2]]
    pick = focused[0] if focused else visible[0] if visible else None
    if pick:
        return pick[0], pick[1]
    return ids[0], attach(client, ids[0])


def remember_tab(target_id: str) -> None:
    state = read_state()
    state["aba"] = target_id
    write_state(state)


def settle(client: CdpClient, session_id: str, seconds: float = 10.0) -> dict[str, Any]:
    """Espera a página assentar depois de navegar ou clicar."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            ensure_world(client, session_id)
            if eval_json(client, session_id, "document.readyState") in ("interactive", "complete"):
                return {
                    "url": eval_json(client, session_id, "location.href"),
                    "titulo": eval_json(client, session_id, "(document.title || '').slice(0, 200)"),
                }
        except PageError:
            raise
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.2)
    raise PageError("demorou", "a página não terminou de carregar")


def check_profile(args: dict[str, Any]) -> str:
    perfil = current_profile()
    esperado = (args.get("esperado") or {}).get("perfil") if isinstance(args.get("esperado"), dict) else None
    if esperado is not None and esperado != perfil:
        raise PageError("perfil")
    if perfil == "nenhum":
        raise PageError("fechado")
    return perfil


# ---------------------------------------------------------------------------
# Ações
# ---------------------------------------------------------------------------


def do_abrir(args: dict[str, Any]) -> dict[str, Any]:
    url = str(args.get("url") or "")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or len(url) > 2000:
        raise PageError("url")
    perfil = str(args.get("perfil") or "")
    ensure_profile(perfil)
    client = connect()
    try:
        target_id, session_id = active_tab(client)
        result = client.call("Page.navigate", {"url": url}, session_id=session_id, timeout_s=20.0)
        if result.get("errorText") or result.get("isDownload"):
            raise PageError("navegacao", str(result.get("errorText") or "o endereço virou um download")[:200])
        client.call("Target.activateTarget", {"targetId": target_id})
        remember_tab(target_id)
        time.sleep(0.3)
        return {"ok": True, "perfil": perfil, **settle(client, session_id)}
    finally:
        client.close()


def with_page(args: dict[str, Any], fn: Any) -> dict[str, Any]:
    perfil = check_profile(args)
    client = connect()
    try:
        _, session_id = active_tab(client)
        return {"ok": True, "perfil": perfil, **fn(client, session_id)}
    finally:
        client.close()


def do_ler(args: dict[str, Any]) -> dict[str, Any]:
    limit = args.get("max")
    if not isinstance(limit, int) or not 1 <= limit <= MAX_TEXTO:
        raise PageError("invalido", "max inválido")

    def read(client: CdpClient, session_id: str) -> dict[str, Any]:
        data = call_helper(client, session_id, "snapshot", limit)
        if not isinstance(data, dict):
            raise RuntimeError("leitura vazia")
        return {
            "url": str(data.get("url") or ""),
            "titulo": _clip(data.get("titulo"), 200),
            "texto": str(data.get("texto") or "")[:limit],
            "total": data.get("total") if isinstance(data.get("total"), int) else 0,
            "elementos": shape_elements(data.get("elementos")),
            "quadros": bool(data.get("quadros")),
        }

    return with_page(args, read)


def expected(args: dict[str, Any]) -> dict[str, Any]:
    esperado = args.get("esperado")
    if not isinstance(esperado, dict) or not isinstance(esperado.get("url"), str):
        raise PageError("invalido", "falta o esperado")
    return {"url": esperado["url"], **({"h": esperado["h"]} if "h" in esperado else {})}


def do_clicar(args: dict[str, Any]) -> dict[str, Any]:
    ref = args.get("ref")
    if not isinstance(ref, str) or not REF_RE.match(ref):
        raise PageError("invalido", "ref inválido")
    esperado = expected(args)

    def click(client: CdpClient, session_id: str) -> dict[str, Any]:
        call_helper(client, session_id, "click", ref, esperado)
        time.sleep(0.8)
        return settle(client, session_id)

    return with_page(args, click)


def do_preencher(args: dict[str, Any]) -> dict[str, Any]:
    campos = args.get("campos")
    if not isinstance(campos, list) or not 1 <= len(campos) <= 20:
        raise PageError("invalido", "campos inválidos")
    clean = []
    for c in campos:
        if not isinstance(c, dict) or not isinstance(c.get("ref"), str) or not REF_RE.match(c["ref"]) or not isinstance(c.get("texto"), str):
            raise PageError("invalido", "campo inválido")
        if len(c["texto"]) > 4000:
            raise PageError("invalido", "texto grande demais")
        clean.append({"ref": c["ref"], "texto": c["texto"], **({"h": c["h"]} if "h" in c else {})})
    esperado = expected(args)

    def fill(client: CdpClient, session_id: str) -> dict[str, Any]:
        data = call_helper(client, session_id, "fill", clean, esperado)
        return {"preenchidos": int((data or {}).get("preenchidos") or 0), **settle(client, session_id, 3.0)}

    return with_page(args, fill)


def do_foco(args: dict[str, Any]) -> dict[str, Any]:
    def focus(client: CdpClient, session_id: str) -> dict[str, Any]:
        data = call_helper(client, session_id, "focus") or {}
        foco = data.get("foco")
        if isinstance(foco, dict):
            foco = {
                "papel": _clip(foco.get("papel"), 40),
                "rotulo": _clip(foco.get("rotulo"), MAX_ROTULO),
                "envio": _clip(foco.get("envio"), MAX_ROTULO),
                "sensivel": bool(foco.get("sensivel")),
            }
        return {"url": str(data.get("url") or ""), "titulo": _clip(data.get("titulo"), 200), "foco": foco if isinstance(foco, dict) else None}

    return with_page(args, focus)


def do_tecla(args: dict[str, Any]) -> dict[str, Any]:
    spec = key_spec(str(args.get("tecla") or ""))
    esperado = expected(args)

    def press(client: CdpClient, session_id: str) -> dict[str, Any]:
        state = call_helper(client, session_id, "expect", esperado) or {}
        if state.get("sensivel") and types_text(spec):
            raise PageError("campo_sensivel")
        base = {"key": spec["key"], "code": spec["code"], "windowsVirtualKeyCode": spec["vk"], "modifiers": spec["modifiers"]}
        down = {**base, "type": "keyDown" if spec["text"] else "rawKeyDown"}
        if spec["text"]:
            down["text"] = spec["text"]
        client.call("Input.dispatchKeyEvent", down, session_id=session_id)
        client.call("Input.dispatchKeyEvent", {**base, "type": "keyUp"}, session_id=session_id)
        time.sleep(0.8 if spec["enter"] else 0.1)
        return settle(client, session_id)

    return with_page(args, press)


def do_abas(args: dict[str, Any]) -> dict[str, Any]:
    acao = args.get("acao")
    if acao not in ("listar", "trocar", "fechar"):
        raise PageError("invalido", "ação de aba inválida")
    perfil = check_profile(args)
    client = connect()
    try:
        tabs = pages(client)
        active, _ = active_tab(client) if tabs else ("", "")
        if acao != "listar":
            index = args.get("aba")
            if not isinstance(index, int) or not 0 <= index < len(tabs):
                raise PageError("aba")
            target_id = tabs[index]["targetId"]
            if acao == "trocar":
                client.call("Target.activateTarget", {"targetId": target_id})
                remember_tab(target_id)
                active = target_id
            else:
                client.call("Target.closeTarget", {"targetId": target_id})
                if target_id == active:
                    state = read_state()
                    state.pop("aba", None)
                    write_state(state)
                    active = ""
                time.sleep(0.3)
            tabs = pages(client)
        listing = [
            {"indice": i, "titulo": _clip(t.get("title"), 200), "url": str(t.get("url") or "")[:2000], "ativa": t.get("targetId") == active}
            for i, t in enumerate(tabs)
        ]
        return {"ok": True, "perfil": perfil, "abas": listing}
    finally:
        client.close()


def do_estado(_args: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "perfil": current_profile()}


ACTIONS = {
    "estado": do_estado,
    "abrir": do_abrir,
    "ler": do_ler,
    "clicar": do_clicar,
    "preencher": do_preencher,
    "foco": do_foco,
    "tecla": do_tecla,
    "abas": do_abas,
}


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in ACTIONS:
        print(json.dumps({"ok": False, "erro": "invalido", "mensagem": "uso: page-browser.py <acao> -"}))
        return 2
    try:
        # Pela entrada padrão: um argumento de linha de comando tem limite de 128 KB no Linux.
        raw = sys.stdin.read(MAX_ARGS + 1) if len(argv) > 2 and argv[2] == "-" else (argv[2] if len(argv) > 2 else "")
        args = parse_args(raw.strip())
        result = ACTIONS[argv[1]](args)
    except PageError as exc:
        result = {"ok": False, "erro": exc.code, "mensagem": str(exc)[:300]}
    except Exception as exc:  # noqa: BLE001
        result = {"ok": False, "erro": "falha", "mensagem": str(exc)[:300]}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
