// ═══════════════════════════════════════════════════════════════
//  SmashPad v2 — app.js
//  Features: QR scanner, haptics, D-pad, settings panel,
//            layout mirror, stick/dpad toggle
// ═══════════════════════════════════════════════════════════════

const PLAYER_COLORS = { 1: '#e74c3c', 2: '#3498db', 3: '#f1c40f', 4: '#2ecc71' };
const BUTTON_IDS = {
  A: 1,
  B: 2,
  X: 3,
  Y: 4,
  L: 5,
  R: 6,
  Z: 7,
  START: 8,
  UP: 9,
  DOWN: 10,
  LEFT: 11,
  RIGHT: 12,
};
const PROTOCOL_BUTTON_PLAYER = 0;
const PROTOCOL_BUTTON_HEARTBEAT = 255;
const ACTION_RELEASE = 0;
const ACTION_PRESS = 1;
const HEARTBEAT_FRAME = Uint8Array.of(PROTOCOL_BUTTON_HEARTBEAT, 0);
const HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 4000;
const PLAYER_HANDSHAKES = [null];
const INPUT_FRAMES = Object.create(null);

for (let player = 1; player <= 4; player += 1) {
  PLAYER_HANDSHAKES[player] = Uint8Array.of(PROTOCOL_BUTTON_PLAYER, player);
}

Object.entries(BUTTON_IDS).forEach(([name, id]) => {
  INPUT_FRAMES[name] = [
    Uint8Array.of(id, ACTION_RELEASE),
    Uint8Array.of(id, ACTION_PRESS),
  ];
});

const state = {
  socket:               null,
  selectedPlayer:       1,
  connectedPlayer:      null,
  wsUrl:                null,
  activeButtons:        new Set(),
  activeDirections:     new Set(),
  joystickPointerId:    null,
  gyroEnabled:          false,
  gyroPermissionGranted: false,
  gyroNeutral:          null,
  gyroLast:             null,
  inputMode:            'stick',   // 'stick' | 'dpad'
  mirrorLayout:         false,
  settingsOpen:         false,
  qrStream:             null,
  qrAnimFrame:          null,
  heartbeatIntervalId:  null,
  heartbeatTimeoutId:   null,
};

// ─── Entry ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  state.inputMode    = ls('smashpad_input')  || 'stick';
  state.mirrorLayout = ls('smashpad_mirror') === '1';

  installTouchGuards();
  bindController();
  applyPlayerTheme(1);
  applyInputMode(state.inputMode, false);
  applyMirror(state.mirrorLayout, false);

  if (isCapacitor()) {
    injectIpScreen();
  } else {
    state.wsUrl = buildWsUrl();
    initApp();
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ls(k)       { try { return localStorage.getItem(k); }        catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); }            catch {} }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function isCapacitor() {
  return (
    window.Capacitor !== undefined ||
    window.location.protocol === 'capacitor:' ||
    (window.location.hostname === 'localhost' && /iPhone|iPad/.test(navigator.userAgent))
  );
}

function buildWsUrl(hostOverride) {
  const p    = new URLSearchParams(window.location.search);
  const host = hostOverride || p.get('wsHost');
  const port = p.get('wsPort') || '8000';
  if (host) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${host}:${port}`;
  }
  const h = location.hostname || '127.0.0.1';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${h}:8000`;
}

// ─── Haptics ─────────────────────────────────────────────────────────────────

function haptic(style = 'LIGHT') {
  // Capacitor native Taptic Engine (iOS)
  try {
    if (window.Capacitor?.Plugins?.Haptics) {
      window.Capacitor.Plugins.Haptics.impact({ style });
      return;
    }
  } catch {}
  // Web Vibration API (Android / Chrome)
  try { navigator.vibrate(style === 'HEAVY' ? 55 : style === 'MEDIUM' ? 35 : 18); } catch {}
}

// ─── IP Screen (Capacitor) ───────────────────────────────────────────────────

function injectIpScreen() {
  const scr = document.createElement('div');
  scr.id = 'ipScreen';
  scr.style.cssText = `
    position:fixed;inset:0;z-index:999;display:flex;align-items:center;
    justify-content:center;background:rgba(6,6,14,.97);
    font-family:'Share Tech Mono',monospace;
  `;
  scr.innerHTML = `
    <div style="width:min(90%,380px);padding:28px 24px;border:1px solid rgba(255,255,255,.1);
                border-radius:22px;background:rgba(10,12,22,.9);display:grid;gap:16px;text-align:center;">
      <div style="font-family:'Orbitron',sans-serif;font-size:22px;color:#fff;">
        SMASH<span style="color:#e74c3c;">PAD</span>
      </div>
      <div style="font-size:12px;color:#7c8ba1;letter-spacing:.08em;">INTRODUCE LA IP DE TU PC</div>
      <input id="ipInput" type="text" inputmode="decimal" placeholder="192.168.1.X"
        value="${ls('smashpad_ip') || ''}"
        style="padding:14px 16px;border-radius:12px;border:1px solid rgba(6,182,212,.3);
               background:rgba(6,182,212,.07);color:#d7fbff;font-size:18px;
               font-family:'Share Tech Mono',monospace;text-align:center;outline:none;width:100%;">
      <button id="qrScanBtn" type="button"
        style="padding:12px;border-radius:12px;border:1px solid rgba(124,58,237,.3);
               background:rgba(124,58,237,.1);color:#c4b5fd;
               font-family:'Share Tech Mono',monospace;font-size:13px;cursor:pointer;">
        📷 Escanear QR del servidor
      </button>
      <p style="font-size:11px;color:#7c8ba1;line-height:1.5;">
        Ejecuta <code style="color:#06b6d4;">python server.py</code> en el PC.<br>
        La IP aparece en la terminal al arrancar.
      </p>
      <button id="ipConnectBtn" type="button"
        style="padding:14px;border-radius:999px;border:none;cursor:pointer;
               background:linear-gradient(180deg,#e74c3c,#c0392b);color:#fff;
               font-family:'Orbitron',sans-serif;font-size:14px;letter-spacing:.08em;">
        CONECTAR
      </button>
      <div id="ipError" style="font-size:12px;color:#e74c3c;min-height:16px;"></div>
    </div>
  `;
  document.body.appendChild(scr);

  const inp   = scr.querySelector('#ipInput');
  const btn   = scr.querySelector('#ipConnectBtn');
  const err   = scr.querySelector('#ipError');
  const qrBtn = scr.querySelector('#qrScanBtn');

  qrBtn.addEventListener('click', () => {
    startQrScanner((ip) => {
      inp.value = ip;
      err.textContent = `IP detectada: ${ip}`;
    });
  });

  const attempt = () => {
    const raw = inp.value.trim();
    if (!raw) { err.textContent = 'Escribe la IP del PC.'; return; }
    const ip = raw.replace(/^wss?:\/\//, '').split(':')[0];
    lsSet('smashpad_ip', ip);
    state.wsUrl = buildWsUrl(ip);
    err.textContent = 'Conectando…';
    btn.disabled = true;

    const probe = new WebSocket(state.wsUrl);
    const t = setTimeout(() => {
      probe.close();
      err.textContent = 'Sin respuesta. Revisa que server.py esté corriendo.';
      btn.disabled = false;
    }, 4000);

    probe.addEventListener('open', () => { clearTimeout(t); probe.close(); scr.remove(); initApp(); });
    probe.addEventListener('error', () => {
      clearTimeout(t);
      err.textContent = 'No se pudo conectar. Comprueba IP y Wi-Fi.';
      btn.disabled = false;
    });
  };

  btn.addEventListener('click', attempt);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
}

// ─── QR Scanner ──────────────────────────────────────────────────────────────

function startQrScanner(onDetected) {
  const el     = document.getElementById('qrScanner');
  const video  = document.getElementById('qrVideo');
  const canvas = document.getElementById('qrCanvas');
  const cancel = document.getElementById('qrCancelBtn');
  const ctx    = canvas.getContext('2d');

  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Tu navegador no soporta la cámara.');
    return;
  }

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then((stream) => {
      state.qrStream  = stream;
      video.srcObject = stream;
      el.classList.add('active');

      const tick = () => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width  = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = typeof jsQR === 'function'
            ? jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
            : null;
          if (code?.data) {
            stopQrScanner();
            try {
              const url = new URL(code.data);
              onDetected(url.hostname);
            } catch {
              onDetected(code.data.trim());
            }
            return;
          }
        }
        state.qrAnimFrame = requestAnimationFrame(tick);
      };
      state.qrAnimFrame = requestAnimationFrame(tick);
    })
    .catch(() => alert('No se pudo acceder a la cámara. Comprueba los permisos.'));

  const onCancel = () => stopQrScanner();
  cancel.addEventListener('click', onCancel, { once: true });
}

function stopQrScanner() {
  if (state.qrAnimFrame) cancelAnimationFrame(state.qrAnimFrame);
  if (state.qrStream) { state.qrStream.getTracks().forEach(t => t.stop()); state.qrStream = null; }
  document.getElementById('qrScanner').classList.remove('active');
}

// ─── Init app ────────────────────────────────────────────────────────────────

function initApp() {
  bindSetup();
  updateServerAddress();
  const p = getInitialPlayer();
  if (p) connectAs(p); else setSetupMessage('Toca tu jugador para conectarte.');
}

function getInitialPlayer() {
  const p = Number.parseInt(new URLSearchParams(location.search).get('player') || '', 10);
  return Number.isInteger(p) && p >= 1 && p <= 4 ? p : null;
}

function bindSetup() {
  document.querySelectorAll('.player-card').forEach((card) => {
    card.addEventListener('click', () => {
      const p = Number.parseInt(card.dataset.player || '', 10);
      if (p) connectAs(p);
    });
  });
}

// ─── Settings panel ──────────────────────────────────────────────────────────

function bindController() {
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  document.getElementById('settingsBackdrop').addEventListener('click', closeSettings);

  // Input mode
  document.getElementById('useStick').addEventListener('click', () => setInputMode('stick'));
  document.getElementById('useDpad').addEventListener('click', () => setInputMode('dpad'));

  // Layout mirror
  document.getElementById('layoutNormal').addEventListener('click', () => setMirror(false));
  document.getElementById('layoutMirror').addEventListener('click', () => setMirror(true));

  // Gyro
  document.getElementById('gyroBtn').addEventListener('click', toggleGyroMode);
  document.getElementById('gyroCenterBtn').addEventListener('click', calibrateGyro);

  // Fullscreen
  document.getElementById('fullscreenBtn').addEventListener('click', toggleFullscreen);

  // Disconnect
  document.getElementById('resetBtn').addEventListener('click', () => {
    closeSettings(); disconnect('manual'); disableGyro(); showSetup();
  });

  // Player mini buttons
  document.querySelectorAll('.player-mini').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = Number.parseInt(btn.dataset.player || '', 10);
      if (!p) return;
      document.querySelectorAll('.player-mini').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      connectAs(p);
      closeSettings();
    });
  });

  bindButtonPad();
  bindJoystick();
  bindDpad();

  window.addEventListener('beforeunload', () => disconnect('pagehide'));
  window.addEventListener('pagehide', () => disconnect('pagehide'));
  window.addEventListener('blur', releaseAllInputs);
  window.addEventListener('deviceorientation', handleDeviceOrientation);

  updateGyroUi();
  updateInputModeUi();
  updateMirrorUi();
}

function openSettings() {
  state.settingsOpen = true;
  document.getElementById('settingsPanel').classList.add('open');
  document.getElementById('settingsBackdrop').classList.add('active');
}

function closeSettings() {
  state.settingsOpen = false;
  document.getElementById('settingsPanel').classList.remove('open');
  document.getElementById('settingsBackdrop').classList.remove('active');
}

// ─── Input mode: stick / dpad ────────────────────────────────────────────────

function setInputMode(mode) {
  state.inputMode = mode;
  lsSet('smashpad_input', mode);
  applyInputMode(mode, true);
  if (state.gyroEnabled) { syncDirections(new Set()); updateStickHandle(0, 0); }
}

function applyInputMode(mode, closePanel = false) {
  document.getElementById('joystickZone').style.display = mode === 'stick' ? 'flex' : 'none';
  document.getElementById('dpadZone').style.display     = mode === 'dpad'  ? 'flex' : 'none';
  updateInputModeUi();
  if (closePanel) closeSettings();
}

function updateInputModeUi() {
  document.getElementById('useStick').classList.toggle('active', state.inputMode === 'stick');
  document.getElementById('useDpad').classList.toggle('active', state.inputMode === 'dpad');
}

// ─── Mirror layout (zurdo) ───────────────────────────────────────────────────

function setMirror(mirrored) {
  state.mirrorLayout = mirrored;
  lsSet('smashpad_mirror', mirrored ? '1' : '0');
  applyMirror(mirrored, true);
}

function applyMirror(mirrored, closePanel = false) {
  const main = document.querySelector('.controls-main');
  if (main) main.style.direction = mirrored ? 'rtl' : 'ltr';
  updateMirrorUi();
  if (closePanel) closeSettings();
}

function updateMirrorUi() {
  document.getElementById('layoutNormal').classList.toggle('active', !state.mirrorLayout);
  document.getElementById('layoutMirror').classList.toggle('active',  state.mirrorLayout);
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

function connectAs(player) {
  state.selectedPlayer = player;
  applyPlayerTheme(player);
  setDot('connecting');
  setSetupMessage(`Conectando P${player}...`);

  if (state.socket) disconnect('switch');

  let socket;
  try { socket = new WebSocket(state.wsUrl); } catch {
    showSetup(); setSetupMessage('No se pudo abrir el WebSocket.'); return;
  }
  socket.binaryType = 'arraybuffer';
  state.socket = socket;

  socket.addEventListener('open', () => {
    refreshHeartbeatDeadline(socket);
    startHeartbeat(socket);
    safeSendRaw(PLAYER_HANDSHAKES[player]);
  });

  socket.addEventListener('message', (ev) => {
    if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength < 2) return;
    const msg = new Uint8Array(ev.data);
    refreshHeartbeatDeadline(socket);
    if (msg[0] === PROTOCOL_BUTTON_HEARTBEAT) return;
    if (msg[0] === PROTOCOL_BUTTON_PLAYER && msg[1] >= 1 && msg[1] <= 4) {
      const playerId = msg[1];
      state.connectedPlayer = playerId;
      applyPlayerTheme(playerId);
      updatePlayerBadge(playerId);
      showController();
      setDot('connected');
      haptic('MEDIUM');
    }
  });

  socket.addEventListener('error', () => {
    if (state.socket !== socket) return;
    stopHeartbeat();
    showSetup(); setDot('error');
    setSetupMessage('No se pudo conectar. Revisa la IP y la Wi-Fi.');
  });

  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    stopHeartbeat();
    state.socket = null;
    releaseAllInputs(false);
    if (state.connectedPlayer !== null) {
      showSetup(); setSetupMessage('Conexion perdida. Toca tu jugador para volver.');
    }
    state.connectedPlayer = null; setDot('off');
  });
}

function disconnect(reason) {
  stopHeartbeat();
  releaseAllInputs();
  if (!state.socket) { state.connectedPlayer = null; return; }
  const s = state.socket; state.socket = null; state.connectedPlayer = null;
  try { s.close(1000, reason); } catch {}
}

function safeSendRaw(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(payload);
}

function safeSendInput(button, action) {
  const frames = INPUT_FRAMES[button];
  if (!frames) return;
  safeSendRaw(frames[action === ACTION_PRESS ? 1 : 0]);
}

function startHeartbeat(socket) {
  stopHeartbeat();
  state.heartbeatIntervalId = window.setInterval(() => {
    if (state.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    safeSendRaw(HEARTBEAT_FRAME);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (state.heartbeatIntervalId !== null) {
    clearInterval(state.heartbeatIntervalId);
    state.heartbeatIntervalId = null;
  }
  if (state.heartbeatTimeoutId !== null) {
    clearTimeout(state.heartbeatTimeoutId);
    state.heartbeatTimeoutId = null;
  }
}

function refreshHeartbeatDeadline(socket) {
  if (state.socket !== socket) return;
  if (state.heartbeatTimeoutId !== null) clearTimeout(state.heartbeatTimeoutId);
  state.heartbeatTimeoutId = window.setTimeout(() => {
    if (state.socket !== socket) return;
    stopHeartbeat();
    state.socket = null;
    state.connectedPlayer = null;
    releaseAllInputs(false);
    try { socket.close(4000, 'heartbeat-timeout'); } catch {}
    showSetup();
    setDot('error');
    setSetupMessage('Conexion perdida. Toca tu jugador para volver.');
  }, HEARTBEAT_TIMEOUT_MS);
}

// ─── Button pad ──────────────────────────────────────────────────────────────

function bindButtonPad() {
  document.querySelectorAll('[data-btn]').forEach((btn) => {
    // Skip joystick area and dpad buttons (handled separately)
    if (btn.id === 'joystick' || btn.classList.contains('dpad-btn')) return;
    const name = btn.dataset.btn;
    if (!name) return;

    const press = (e) => {
      e.preventDefault();
      if (e.pointerId !== undefined) {
        try { btn.setPointerCapture(e.pointerId); } catch {}
      }
      if (btn.dataset.pressed === '1') return;
      btn.dataset.pressed = '1';
      btn.classList.add('pressed');
      state.activeButtons.add(name);
      safeSendInput(name, ACTION_PRESS);
      haptic(name === 'A' ? 'MEDIUM' : 'LIGHT');
    };
    const release = (e) => {
      if (e) e.preventDefault();
      if (btn.dataset.pressed !== '1') return;
      if (e?.pointerId !== undefined) {
        try { btn.releasePointerCapture(e.pointerId); } catch {}
      }
      btn.dataset.pressed = '0';
      btn.classList.remove('pressed');
      state.activeButtons.delete(name);
      safeSendInput(name, ACTION_RELEASE);
    };

    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('lostpointercapture', release);
  });
}

// ─── D-pad ───────────────────────────────────────────────────────────────────

function bindDpad() {
  document.querySelectorAll('.dpad-btn').forEach((btn) => {
    const name = btn.dataset.btn;
    if (!name) return;

    const press = (e) => {
      e.preventDefault();
      if (e.pointerId !== undefined) {
        try { btn.setPointerCapture(e.pointerId); } catch {}
      }
      if (btn.dataset.pressed === '1') return;
      btn.dataset.pressed = '1';
      btn.classList.add('pressed');
      state.activeDirections.add(name);
      safeSendInput(name, ACTION_PRESS);
      haptic('LIGHT');
    };
    const release = (e) => {
      if (e) e.preventDefault();
      if (btn.dataset.pressed !== '1') return;
      if (e?.pointerId !== undefined) {
        try { btn.releasePointerCapture(e.pointerId); } catch {}
      }
      btn.dataset.pressed = '0';
      btn.classList.remove('pressed');
      state.activeDirections.delete(name);
      safeSendInput(name, ACTION_RELEASE);
    };

    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('lostpointercapture', release);
  });
}

// ─── Joystick ────────────────────────────────────────────────────────────────

function bindJoystick() {
  const area   = document.getElementById('joystick');
  const handle = document.getElementById('stickHandle');
  if (!area || !handle) return;

  const resetStick = () => {
    state.joystickPointerId = null;
    updateStickHandle(0, 0);
    syncDirections(new Set());
  };

  const moveStick = (cx, cy) => {
    if (state.gyroEnabled) return;
    const r    = area.getBoundingClientRect();
    const dx   = cx - (r.left + r.width / 2);
    const dy   = cy - (r.top  + r.height / 2);
    const maxR = r.width * 0.34;
    const dist = Math.hypot(dx, dy);
    const lim  = dist > maxR ? maxR / dist : 1;
    const lx   = dx * lim, ly = dy * lim;
    updateStickHandle(lx, ly);

    const nx = lx / maxR, ny = ly / maxR;
    const next = new Set(), T = 0.35;
    if (nx >  T) next.add('RIGHT');
    if (nx < -T) next.add('LEFT');
    if (ny >  T) next.add('DOWN');
    if (ny < -T) next.add('UP');
    syncDirections(next);
  };

  area.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    state.joystickPointerId = e.pointerId;
    area.setPointerCapture(e.pointerId);
    moveStick(e.clientX, e.clientY);
  });
  area.addEventListener('pointermove', (e) => {
    if (state.joystickPointerId !== e.pointerId) return;
    e.preventDefault();
    moveStick(e.clientX, e.clientY);
  });
  const up = (e) => {
    if (state.joystickPointerId !== e.pointerId) return;
    e.preventDefault(); resetStick();
  };
  area.addEventListener('pointerup', up);
  area.addEventListener('pointercancel', up);
  area.addEventListener('lostpointercapture', resetStick);
}

function syncDirections(next) {
  state.activeDirections.forEach(d => { if (!next.has(d)) safeSendInput(d, ACTION_RELEASE); });
  next.forEach(d => { if (!state.activeDirections.has(d)) safeSendInput(d, ACTION_PRESS); });
  state.activeDirections = next;
}

// ─── Gyro ────────────────────────────────────────────────────────────────────

async function toggleGyroMode() {
  if (state.gyroEnabled) { disableGyro(); return; }
  const ok = await requestGyroPermission();
  if (!ok) { setGyroCopy('Permiso denegado. Pulsa de nuevo y acepta.'); return; }
  state.gyroEnabled = true;
  calibrateGyro();
  releaseAllInputs();
  updateGyroUi();
  setGyroCopy('Inclina el movil para mover. Gyro activo.');
}

function disableGyro() {
  state.gyroEnabled = false;
  state.gyroNeutral = state.gyroLast = null;
  syncDirections(new Set());
  updateStickHandle(0, 0);
  updateGyroUi();
  setGyroCopy('Gyro desactivado.');
}

async function requestGyroPermission() {
  if (state.gyroPermissionGranted) return true;
  if (typeof DeviceOrientationEvent === 'undefined') return false;
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const r = await DeviceOrientationEvent.requestPermission();
      state.gyroPermissionGranted = r === 'granted';
      return state.gyroPermissionGranted;
    } catch { return false; }
  }
  state.gyroPermissionGranted = true;
  return true;
}

function calibrateGyro() {
  if (!state.gyroLast) { setGyroCopy('Mueve el movil y pulsa "Centrar gyro".'); return; }
  state.gyroNeutral = { ...state.gyroLast };
  setGyroCopy('Centro guardado.');
}

function handleDeviceOrientation(ev) {
  if (typeof ev.beta !== 'number' || typeof ev.gamma !== 'number') return;
  state.gyroLast = { beta: ev.beta, gamma: ev.gamma };
  if (!state.gyroEnabled) return;
  if (!state.gyroNeutral) state.gyroNeutral = { ...state.gyroLast };

  const rawX = clamp((ev.gamma - state.gyroNeutral.gamma) / 18, -1, 1);
  const rawY = clamp((ev.beta  - state.gyroNeutral.beta)  / 18, -1, 1);
  const next = new Set(), T = 0.24;
  if (rawX >  T) next.add('RIGHT');
  if (rawX < -T) next.add('LEFT');
  if (rawY >  T) next.add('DOWN');
  if (rawY < -T) next.add('UP');
  syncDirections(next);

  const area = document.getElementById('joystick');
  const maxR = area ? area.getBoundingClientRect().width * 0.34 : 0;
  updateStickHandle(rawX * maxR, rawY * maxR);
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function releaseAllInputs(sendRemote = true) {
  if (sendRemote) state.activeButtons.forEach(b => safeSendInput(b, ACTION_RELEASE));
  state.activeButtons.clear();
  if (sendRemote) {
    syncDirections(new Set());
  } else {
    state.activeDirections.clear();
  }
  document.querySelectorAll('[data-btn]').forEach(b => {
    b.classList.remove('pressed'); b.dataset.pressed = '0';
  });
  updateStickHandle(0, 0);
}

function installTouchGuards() {
  const preventGesture = (e) => e.preventDefault();
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => {
    document.addEventListener(type, preventGesture, { passive: false });
  });

  document.addEventListener('contextmenu', preventGesture);

  const blockTouchScroll = (e) => {
    if (e.touches.length > 0) e.preventDefault();
  };

  document.addEventListener('touchmove', blockTouchScroll, { passive: false });
}

function updateStickHandle(x, y) {
  const h = document.getElementById('stickHandle');
  if (h) h.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

function updateGyroUi() {
  const btn = document.getElementById('gyroBtn');
  const ctr = document.getElementById('gyroCenterBtn');
  if (!btn || !ctr) return;
  btn.textContent = state.gyroEnabled ? 'Gyro ON ✓' : 'Gyro OFF';
  btn.classList.toggle('active', state.gyroEnabled);
  ctr.disabled = !state.gyroEnabled;
}

function setGyroCopy(t) { const el = document.getElementById('gyroCopy'); if (el) el.textContent = t; }

function setDot(status) {
  const d = document.getElementById('statusDot');
  if (d) d.className = `dot-${status}`;
}

function updatePlayerBadge(p) {
  const b = document.getElementById('playerBadge'); if (b) b.textContent = `P${p}`;
}

function applyPlayerTheme(player) {
  const color = PLAYER_COLORS[player] || PLAYER_COLORS[1];
  document.documentElement.style.setProperty('--player-color', color);
  document.documentElement.style.setProperty('--player-glow', `${color}66`);
  document.querySelectorAll('.player-card').forEach(c => {
    const sel = Number.parseInt(c.dataset.player || '', 10) === player;
    c.classList.toggle('selected', sel);
    c.setAttribute('aria-checked', String(sel));
  });
  document.querySelectorAll('.player-mini').forEach(b => {
    b.classList.toggle('selected', Number.parseInt(b.dataset.player || '', 10) === player);
  });
}

function updateServerAddress() {
  const el = document.getElementById('serverAddress');
  if (el) el.textContent = state.wsUrl || '--';
}

function showController() {
  document.getElementById('setup').style.display      = 'none';
  document.getElementById('controller').style.display = 'flex';
}

function showSetup() {
  document.getElementById('controller').style.display = 'none';
  document.getElementById('setup').style.display      = 'flex';
}

function setSetupMessage(t) { const el = document.getElementById('setupCopy'); if (el) el.textContent = t; }

async function toggleFullscreen() {
  const root = document.documentElement;
  if (!document.fullscreenElement && root.requestFullscreen) {
    try { await root.requestFullscreen(); } catch {}
    return;
  }
  if (document.fullscreenElement && document.exitFullscreen) {
    try { await document.exitFullscreen(); } catch {}
  }
}
