"""
server.py -- SmashPad | WebSocket + HTTP en un solo proceso
===========================================================
Levanta dos servidores simultaneamente:
  - WebSocket en :8000 -> recibe los inputs del mando
  - HTTP      en :3000 -> sirve los archivos estaticos del controlador

Requisitos:
    pip install websockets qrcode

Uso:
    python server.py

Al arrancar imprime la IP local, la URL y el QR en terminal.
"""

from __future__ import annotations

import asyncio
import ctypes
import http.server
import socket
import socketserver
import sys
import threading
from collections import defaultdict
from pathlib import Path

import websockets

# --- Configuracion ------------------------------------------------------------

WS_HOST = "0.0.0.0"
WS_PORT = 8000
HTTP_PORT = 3000

STATIC_DIR = Path(__file__).parent.resolve()

PROTOCOL_BUTTON_PLAYER = 0
PROTOCOL_BUTTON_HEARTBEAT = 255
ACTION_RELEASE = 0
ACTION_PRESS = 1
HEARTBEAT_TIMEOUT_S = 4.0

BUTTON_A = 1
BUTTON_B = 2
BUTTON_X = 3
BUTTON_Y = 4
BUTTON_L = 5
BUTTON_R = 6
BUTTON_Z = 7
BUTTON_START = 8
BUTTON_UP = 9
BUTTON_DOWN = 10
BUTTON_LEFT = 11
BUTTON_RIGHT = 12

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008
INPUT_KEYBOARD = 1
MAPVK_VK_TO_VSC = 0


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_uint),
        ("time", ctypes.c_uint),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class INPUT(ctypes.Structure):
    class _INPUTUNION(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT)]

    _anonymous_ = ("u",)
    _fields_ = [
        ("type", ctypes.c_uint),
        ("u", _INPUTUNION),
    ]


class KeySpec(tuple):
    __slots__ = ()

    @property
    def vk(self) -> int:
        return self[0]

    @property
    def extended(self) -> bool:
        return self[1]


def _key(vk: int, *, extended: bool = False) -> KeySpec:
    return KeySpec((vk, extended))


def _build_input(vk: int, *, extended: bool, key_up: bool) -> INPUT:
    scan_code = USER32.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)
    flags = KEYEVENTF_SCANCODE
    if extended:
        flags |= KEYEVENTF_EXTENDEDKEY
    if key_up:
        flags |= KEYEVENTF_KEYUP
    return INPUT(
        type=INPUT_KEYBOARD,
        ki=KEYBDINPUT(
            wVk=0,
            wScan=scan_code,
            dwFlags=flags,
            time=0,
            dwExtraInfo=0,
        ),
    )


if sys.platform != "win32":
    raise RuntimeError("Este servidor optimizado requiere Windows para usar SendInput.")

USER32 = ctypes.WinDLL("user32", use_last_error=True)
USER32.MapVirtualKeyW.argtypes = [ctypes.c_uint, ctypes.c_uint]
USER32.MapVirtualKeyW.restype = ctypes.c_uint
USER32.SendInput.argtypes = [ctypes.c_uint, ctypes.POINTER(INPUT), ctypes.c_int]
USER32.SendInput.restype = ctypes.c_uint


VK_RETURN = 0x0D
VK_RIGHT = 0x27
VK_LEFT = 0x25
VK_UP = 0x26
VK_DOWN = 0x28
VK_F4 = 0x73
VK_F5 = 0x74
VK_F6 = 0x75
VK_F7 = 0x76
VK_F8 = 0x77
VK_HOME = 0x24
VK_END = 0x23
VK_PRIOR = 0x21
VK_NEXT = 0x22
VK_OEM_COMMA = 0xBC
VK_OEM_4 = 0xDB

PLAYER_KEY_MAP: dict[int, dict[int, KeySpec]] = {
    1: {
        BUTTON_A: _key(ord("Z")),
        BUTTON_B: _key(ord("X")),
        BUTTON_X: _key(ord("C")),
        BUTTON_Y: _key(ord("V")),
        BUTTON_L: _key(ord("A")),
        BUTTON_R: _key(ord("S")),
        BUTTON_Z: _key(ord("D")),
        BUTTON_START: _key(VK_RETURN),
        BUTTON_UP: _key(VK_RIGHT, extended=True),
        BUTTON_DOWN: _key(VK_LEFT, extended=True),
        BUTTON_LEFT: _key(VK_UP, extended=True),
        BUTTON_RIGHT: _key(VK_DOWN, extended=True),
    },
    2: {
        BUTTON_A: _key(ord("Q")),
        BUTTON_B: _key(ord("W")),
        BUTTON_X: _key(ord("E")),
        BUTTON_Y: _key(ord("R")),
        BUTTON_L: _key(ord("U")),
        BUTTON_R: _key(ord("J")),
        BUTTON_Z: _key(ord("K")),
        BUTTON_START: _key(ord("Y")),
        BUTTON_UP: _key(ord("H")),
        BUTTON_DOWN: _key(ord("F")),
        BUTTON_LEFT: _key(ord("T")),
        BUTTON_RIGHT: _key(ord("G")),
    },
    3: {
        BUTTON_A: _key(ord("I")),
        BUTTON_B: _key(ord("L")),
        BUTTON_X: _key(ord("M")),
        BUTTON_Y: _key(VK_OEM_COMMA),
        BUTTON_L: _key(ord("O")),
        BUTTON_R: _key(ord("P")),
        BUTTON_Z: _key(VK_OEM_4),
        BUTTON_START: _key(VK_F7),
        BUTTON_UP: _key(VK_F8),
        BUTTON_DOWN: _key(VK_F5),
        BUTTON_LEFT: _key(VK_F4),
        BUTTON_RIGHT: _key(VK_F6),
    },
    4: {
        BUTTON_A: _key(ord("1")),
        BUTTON_B: _key(ord("2")),
        BUTTON_X: _key(ord("3")),
        BUTTON_Y: _key(ord("4")),
        BUTTON_L: _key(ord("5")),
        BUTTON_R: _key(ord("6")),
        BUTTON_Z: _key(ord("7")),
        BUTTON_START: _key(ord("0")),
        BUTTON_UP: _key(VK_END, extended=True),
        BUTTON_DOWN: _key(VK_HOME, extended=True),
        BUTTON_LEFT: _key(VK_PRIOR, extended=True),
        BUTTON_RIGHT: _key(VK_NEXT, extended=True),
    },
}

KEY_INPUTS: dict[KeySpec, tuple[INPUT, INPUT]] = {}
for player_map in PLAYER_KEY_MAP.values():
    for spec in player_map.values():
        if spec not in KEY_INPUTS:
            KEY_INPUTS[spec] = (
                _build_input(spec.vk, extended=spec.extended, key_up=False),
                _build_input(spec.vk, extended=spec.extended, key_up=True),
            )

CONNECTED_ACKS = {player_id: bytes((PROTOCOL_BUTTON_PLAYER, player_id)) for player_id in PLAYER_KEY_MAP}
active_keys: dict[int, set[int]] = defaultdict(set)


def _send_key(spec: KeySpec, key_up: bool) -> None:
    event = KEY_INPUTS[spec][1 if key_up else 0]
    sent = USER32.SendInput(1, ctypes.byref(event), ctypes.sizeof(INPUT))
    if sent != 1:
        raise ctypes.WinError(ctypes.get_last_error())


# === WebSocket ================================================================

async def handle_connection(websocket) -> None:
    player_id: int | None = None
    player_map: dict[int, KeySpec] | None = None
    try:
        while True:
            try:
                raw = await asyncio.wait_for(websocket.recv(), timeout=HEARTBEAT_TIMEOUT_S)
            except asyncio.TimeoutError:
                if player_id is not None:
                    _release_all(player_id)
                await websocket.close(code=4000, reason="heartbeat-timeout")
                break
            except websockets.exceptions.ConnectionClosed:
                break

            if not isinstance(raw, (bytes, bytearray, memoryview)) or len(raw) < 2:
                continue

            button_id = raw[0]
            action_id = raw[1]

            if button_id == PROTOCOL_BUTTON_HEARTBEAT:
                await websocket.send(raw[:2])
                continue

            if button_id == PROTOCOL_BUTTON_PLAYER:
                player_map = PLAYER_KEY_MAP.get(action_id)
                if player_map is None:
                    continue
                player_id = action_id
                await websocket.send(CONNECTED_ACKS[player_id])
                print(f"  [+] Jugador {player_id} conectado")
                continue

            if player_id is None or player_map is None:
                continue

            spec = player_map.get(button_id)
            if spec is None:
                continue

            _apply_key(player_id, button_id, spec, action_id)
    finally:
        if player_id is not None:
            _release_all(player_id)
            print(f"  [-] Jugador {player_id} desconectado")


def _apply_key(player_id: int, button_id: int, spec: KeySpec, action_id: int) -> None:
    pressed = active_keys[player_id]
    if action_id == ACTION_PRESS:
        if button_id in pressed:
            return
        _send_key(spec, key_up=False)
        pressed.add(button_id)
        return

    if action_id == ACTION_RELEASE and button_id in pressed:
        _send_key(spec, key_up=True)
        pressed.discard(button_id)


def _release_all(player_id: int) -> None:
    pressed = active_keys[player_id]
    if not pressed:
        return

    player_map = PLAYER_KEY_MAP[player_id]
    for button_id in tuple(pressed):
        try:
            _send_key(player_map[button_id], key_up=True)
        except Exception:
            pass
    pressed.clear()


# === HTTP (archivos estaticos) ===============================================

class _QuietHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, *_):
        pass


def _start_http_server() -> None:
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", HTTP_PORT), _QuietHTTPHandler) as httpd:
        httpd.serve_forever()


# === QR en terminal ==========================================================

def _print_terminal_qr(url: str) -> None:
    try:
        import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        print()
        qr.print_ascii(invert=True)
        print()
    except ImportError:
        print("  (pip install qrcode  ->  para ver QR en terminal)\n")


# === Main ====================================================================

def _detect_local_ip() -> str:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"
    finally:
        probe.close()


async def main() -> None:
    local_ip = _detect_local_ip()
    controller_url = f"http://{local_ip}:{HTTP_PORT}"

    threading.Thread(target=_start_http_server, daemon=True).start()

    print("\n" + "=" * 52)
    print("  SmashPad Server")
    print("=" * 52)
    print(f"  Controlador  ->  {controller_url}")
    print(f"  QR page      ->  {controller_url}/pair.html")
    print(f"  WebSocket    ->  ws://{local_ip}:{WS_PORT}")
    print("-" * 52)
    print("  Escanea el QR o comparte la URL con los jugadores.")
    print("=" * 52)

    _print_terminal_qr(controller_url)

    async with websockets.serve(
        handle_connection,
        WS_HOST,
        WS_PORT,
        compression=None,
        max_queue=64,
        write_limit=2048,
        ping_interval=20,
        ping_timeout=20,
    ):
        print("  Esperando jugadores... (Ctrl+C para salir)\n")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  Servidor detenido.")
