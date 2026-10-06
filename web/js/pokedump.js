// PokeDump: la página. Conecta el ESP32-S3, instala su firmware y las claves, y dirige el volcado
// de solo lectura por Mystery Gift. La conexión con la placa (esp.js, flash-esp.js, keys.js,
// manifest.js) y el enlace de Mystery Gift (gift/) vienen de GB-Link Switch LDN (AGPL-3.0); la
// lógica de esta página sigue la de su app.js, reducida a lo que necesita este proyecto.

import { EspDevice, ESP_FILTERS, FAST_BAUD, newer, reopenPort } from './esp.js';
import { parseProdKeys } from './keys.js';
import { loadManifest } from './manifest.js';
import { GiftDistribution } from './gift/distribution.js';
import { describeGameCode } from './gift/mystery-gift.js';
import { DUMP_EVENTS } from './dump/ramdump.js';
import { GIFT_EVENT_ID, LEGENDARY_EVENT_ID, SHINY_EVENT_ID, ULTRA_EVENT_ID, calibrationSummary, clearCalibration, giftEvent, parseCalibrationReport, resetEvent, loadCalibration, saveCalibration, shinyEvent, supportsGifts, supportsKeep, supportsUltra, ultraEvent } from './dump/shiny-event.js';

const $ = (id) => document.getElementById(id);
const CHIP_NAMES = { esp32: 'ESP32', esp32c3: 'ESP32-C3', esp32c6: 'ESP32-C6', esp32s3: 'ESP32-S3' };
const GIFT_FIRMWARE = '2.1.0';
const KEY_NAMES = {
    kek: 'aes_kek_generation_source', gen: 'aes_key_generation_source', master00: 'master_key_00', master12: 'master_key_12',
};

const state = {
    manifest: null,
    esp: null, espPort: null, espPhase: 'idle', espProblem: null, espNote: '', askForEsp: false,
    keys: null, keysNote: null, replacingKeys: false,
    gift: null, giftClosing: false, giftStatus: null, giftResult: null, giftNote: null, game: null,
    files: [],                       // descargas del último volcado
    decision: null,                  // la Switch ya tiene la tarjeta: ¿se envía otra vez?
};

// ---------------------------------------------------------------- utilidades

const logLines = [];
function log(source, text) {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    logLines.push(`${stamp}  ${source.padEnd(7)} ${text}`);
    if (logLines.length > 600) logLines.splice(0, logLines.length - 600);
    const view = $('log');
    const pinned = view.scrollTop + view.clientHeight >= view.scrollHeight - 8;
    view.textContent = logLines.join('\n');
    if (pinned) view.scrollTop = view.scrollHeight;
}

const describe = (error) => error?.message || String(error);

async function choose(request) {
    try { return await request(); } catch (error) {
        if (error?.name !== 'NotFoundError') log('web', `el navegador no mostró la lista de dispositivos: ${describe(error)}`);
        return null;
    }
}

function setText(id, text, tone = '') {
    const el = $(id);
    el.textContent = text ?? '';
    el.className = `${el.dataset.base ??= el.className.split(' ')[0]} ${tone}`.trim();
}

function setProgress(id, fraction) {
    const el = $(id);
    el.hidden = fraction === null || fraction === undefined || fraction === false;
    el.classList.toggle('indeterminate', fraction === true);
    el.firstElementChild.style.width = typeof fraction === 'number' ? `${Math.round(fraction * 100)}%` : '';
}

// ---------------------------------------------------------------- placa: qué enseñar

const PROBLEMS = {
    'no-firmware': () => ({ tone: 'warn', text: 'Esta placa aún no tiene el firmware.', primary: ['Instalar firmware', () => onEspInstall()], secondary: ['Elegir otro puerto', onEspPickAnother] }),
    'download-mode': () => ({ tone: 'warn', text: 'La placa está en modo de instalación (bootloader).', hint: 'Si ya tiene el firmware, pulsa su botón RESET (EN) y conecta de nuevo.', primary: ['Instalar firmware', () => onEspInstall()], secondary: ['Conectar de nuevo', onEspConnect] }),
    'crash-loop': (p) => ({ tone: 'bad', text: 'El firmware de la placa se bloquea al arrancar.', hint: p.hint ? `${p.hint} (también en el registro)` : 'Reinstalarlo suele arreglarlo.', primary: ['Reinstalar firmware', () => onEspInstall()] }),
    'port-busy': () => ({ tone: 'bad', text: 'Otro programa tiene abierto el puerto.', hint: 'Cierra cualquier monitor serie o herramienta de flasheo y reintenta.', primary: ['Reintentar', onEspConnect], secondary: ['Elegir otro puerto', onEspPickAnother] }),
    'port-lost': () => ({ tone: 'bad', text: 'El navegador perdió el puerto al abrirlo.', hint: 'Desconecta la placa, vuelve a conectarla y pulsa Conectar.', primary: ['Conectar', onEspConnect] }),
    'install-failed': (p) => ({ tone: 'bad', text: p.text, hint: p.hint, primary: ['Reintentar', () => onEspInstall()], secondary: ['Elegir otro puerto', onEspPickAnother] }),
    'silent-after-install': () => ({ tone: 'warn', text: 'Instalado, pero la placa aún no contesta.', hint: 'Pulsa su botón RESET o desconéctala y vuélvela a conectar; luego pulsa Conectar.', primary: ['Conectar', onEspConnect] }),
    gone: (p) => ({ tone: p.tone ?? '', text: p.text, primary: ['Conectar', onEspConnect] }),
};

function espView() {
    if (state.espPhase === 'choosing') return { busy: true, text: 'Elige la placa en la lista que muestra el navegador.', hint: 'Aparece como «USB JTAG/serial debug unit», o «CP2102»/«CH340» si tiene un chip USB aparte.' };
    if (state.espPhase === 'connecting') return { busy: true, text: 'Buscando el firmware en la placa…' };
    if (state.espPhase === 'installing') return { busy: true, text: state.espNote, progress: state.espProgress };
    if (state.espPhase === 'starting') return { busy: true, text: 'Instalado. Esperando a que arranque la placa…' };
    const esp = state.esp;
    if (state.espProblem) return { ...(PROBLEMS[state.espProblem.code] ?? PROBLEMS.gone)(state.espProblem), connected: Boolean(esp) };
    if (!esp) return { text: 'Conecta la placa al ordenador con un cable USB de datos y pulsa Conectar.', hint: 'Si no aparece en la lista: mantén BOOT, pulsa y suelta RESET (o conéctala con BOOT pulsado).', primary: ['Conectar', onEspConnect] };
    const name = CHIP_NAMES[esp.info?.chip] ?? esp.info?.chip ?? 'placa';
    if (!esp.attached) return { busy: true, connected: true, text: `${name} · reiniciando, como tras cada sesión…` };
    const bundled = state.manifest?.bridge.version;
    if (!esp.info || (bundled && newer(bundled, esp.info.version))) {
        return { connected: true, tone: 'warn', text: esp.info ? `Tiene el firmware ${esp.info.version}; hay uno nuevo (${bundled}).` : 'El firmware de la placa es más antiguo de lo que necesita esta página.', primary: ['Actualizar firmware', () => onEspInstall()] };
    }
    if (!state.keys?.complete || state.replacingKeys) {
        return { connected: true, dot: 'warn', tone: state.keys?.complete ? '' : 'warn', text: state.keys?.complete ? `${name} conectada. Suelta un prod.keys para cambiar las claves guardadas.` : `${name} conectada. Le faltan las claves de tu consola.`, keys: true };
    }
    return { connected: true, done: true, tone: 'good', text: `${name} lista · firmware ${esp.info.version} · claves guardadas` };
}

function renderEsp() {
    const v = espView();
    setText('esp-status', v.text, v.tone ?? (v.done ? 'good' : ''));
    setText('esp-hint', v.hint ?? '');
    setProgress('esp-progress', v.progress ?? (v.busy ? true : null));
    const primary = $('esp-primary'), secondary = $('esp-secondary');
    primary.hidden = !v.primary;
    if (v.primary) { primary.textContent = v.primary[0]; primary.onclick = v.primary[1]; }
    secondary.hidden = !v.secondary;
    if (v.secondary) { secondary.textContent = v.secondary[0]; secondary.onclick = v.secondary[1]; }
    $('keys-drop').hidden = !v.keys;
    $('esp-more').hidden = !state.esp;
    $('esp-dot').className = `dot ${v.busy ? 'busy' : v.done ? 'good' : v.tone === 'bad' ? 'bad' : v.dot ?? (v.tone === 'warn' ? 'warn' : '')}`.trim();
    const keys = keysLine();
    setText('keys-status', keys.text, keys.tone);
    const esp = state.esp;
    if (esp?.info) $('esp-facts').textContent = `Chip: ${CHIP_NAMES[esp.info.chip] ?? esp.info.chip} · firmware ${esp.info.version} · ${esp.info.transport === 'UART' ? `UART a ${esp.baudRate} baudios` : esp.info.transport}`;
}

// ---------------------------------------------------------------- placa: acciones

async function onEspConnect() {
    if (state.espPhase !== 'idle' || state.esp) return;
    let port = (await livePort(state.espPort)) ?? (await rememberedEspPort());
    if (!port) {
        state.espPhase = 'choosing';
        render();
        port = await choose(() => EspDevice.requestPort());
        state.espPhase = 'idle';
    }
    if (port) await attachEsp(port); else render();
}

async function onEspPickAnother() {
    if (state.espPhase !== 'idle') return;
    state.askForEsp = true; state.espPort = null; state.espProblem = null;
    await onEspConnect();
}

// Los chips con USB nativo reaparecen como otro objeto de puerto (mismo permiso) tras cada reinicio.
async function livePort(port) {
    if (!port) return null;
    let ports = [];
    try { ports = await navigator.serial.getPorts(); } catch {}
    if (ports.includes(port)) return port;
    const was = port.getInfo();
    const same = ports.filter((o) => o.getInfo().usbVendorId === was.usbVendorId && o.getInfo().usbProductId === was.usbProductId);
    return same.length === 1 ? same[0] : null;
}

async function rememberedEspPort() {
    if (state.askForEsp) return null;
    let ports = [];
    try { ports = await navigator.serial.getPorts(); } catch {}
    ports = ports.filter((port) => ESP_FILTERS.some((f) => f.usbVendorId === port.getInfo().usbVendorId));
    return ports.length === 1 ? ports[0] : null;
}

async function attachEsp(port) {
    state.espPhase = 'connecting'; state.espProblem = null;
    render();
    const device = new EspDevice();
    try {
        await device.open(port);
    } catch (error) {
        await device.close();
        state.espPort = error.code === 'port-lost' ? null : port;
        state.espProblem = { code: error.code ?? 'no-firmware', text: describe(error), hint: error.detail };
        if (error.code === 'crash-loop') log('placa', `se bloquea al arrancar: ${error.detail || 'sin detalle'}`);
        state.espPhase = 'idle';
        render();
        return;
    }
    state.askForEsp = false; state.espPhase = 'idle';
    await adoptEsp(device);
}

async function adoptEsp(device) {
    state.esp = device; state.espPort = null; state.espProblem = null;
    device.addEventListener('log', (e) => { const l = e.detail; if (!l.startsWith('LDN_HELLO') && !l.startsWith('LDN_ADV ') && !l.startsWith('LDN_ROOM ')) log('placa', l); });
    device.addEventListener('restarted', () => { if (state.esp === device) { log('placa', 'reiniciada'); render(); } });
    device.addEventListener('reattached', () => { if (state.esp === device) refreshEsp(); });
    device.addEventListener('failed', (e) => { if (state.esp === device) dropEsp({ code: 'gone', tone: 'bad', text: `La placa dejó de contestar (${describe(e.detail)}).` }); });
    device.addEventListener('disconnected', () => { if (state.esp === device) dropEsp({ code: 'gone', tone: 'warn', text: 'Se desconectó la placa.' }); });
    await refreshEsp();
}

async function refreshEsp() {
    const esp = state.esp;
    if (!esp) return;
    try {
        // Resto de una página cerrada a medias: la placa se queda con el puerto del adaptador.
        if (!state.gift && (await esp.adapterPort()) === 'host') await esp.setAdapterPort('uart');
        await refreshKeys();
    } catch (error) { log('web', describe(error)); }
    render();
}

async function dropEsp(problem = null) {
    const device = state.esp;
    if (state.gift) await giftStop();
    state.esp = null; state.keys = null; state.keysNote = null; state.replacingKeys = false; state.espProblem = problem;
    await device?.close();
    render();
}

async function onEspInstall(eraseAll = false) {
    if (state.espPhase !== 'idle') return;
    if (!state.manifest) {
        state.espProblem = { code: 'install-failed', text: 'No se pudo cargar el firmware incluido en esta página.' };
        render();
        return;
    }
    let port = state.esp?.port ?? (await livePort(state.espPort)) ?? (await rememberedEspPort());
    if (!port) {
        state.espPhase = 'choosing'; render();
        port = await choose(() => EspDevice.requestPort());
        state.espPhase = 'idle';
        if (!port) { render(); return; }
    }
    $('esp-more').open = false;
    state.espPhase = 'installing'; state.espNote = 'Preparando…'; state.espProgress = 0;
    render();
    try {
        if (state.esp) await dropEsp();
        state.espProblem = null;
        const { flashBridge } = await import('./flash-esp.js');
        const done = await flashBridge(port, state.manifest, {
            eraseAll,
            onStatus: (text) => { state.espNote = text; render(); },
            onProgress: (fraction) => { state.espProgress = fraction; setProgress('esp-progress', fraction); },
            onLog: (text) => log('flasheo', text),
        });
        log('web', `firmware ${done.version} instalado en el ${done.chip}`);
        state.espPhase = 'starting'; state.espProgress = null;
        render();
        let device = null;
        try { device = await reopenPort(port); } catch (error) { log('web', describe(error)); }
        state.espPhase = 'idle';
        if (device) await adoptEsp(device);
        else { state.espPort = port; state.espProblem = { code: 'silent-after-install' }; render(); }
    } catch (error) {
        log('flasheo', describe(error));
        state.espPort = port; state.espPhase = 'idle'; state.espProgress = null;
        state.espProblem = { code: 'install-failed', ...installAdvice(error) };
        render();
    }
}

function installAdvice(error) {
    const text = describe(error);
    if (/device has been lost/i.test(text)) return { text: 'El navegador perdió el puerto al abrirlo.', hint: 'Desconecta la placa, vuelve a conectarla y reintenta.' };
    if (/failed to connect|timed? ?out|no serial data|invalid head/i.test(text)) return { text: 'El chip no entró en modo de instalación.', hint: 'Mantén BOOT, pulsa y suelta RESET (o conecta la placa con BOOT pulsado) y reintenta.' };
    if (/failed to open|already open/i.test(text)) return { text: 'Otro programa tiene abierto el puerto.', hint: 'Ciérralo y reintenta.' };
    return { text: 'Falló la instalación.', hint: text };
}

// ---------------------------------------------------------------- claves

async function refreshKeys() {
    const esp = state.esp;
    if (!esp?.attached) return;
    state.keys = await esp.keyStatus();
    render();
}

async function onKeysFile(file) {
    const esp = state.esp;
    if (!file || !esp?.attached) return;
    const note = (text, tone) => { state.keysNote = { text, tone }; render(); };
    if (file.size > 1024 * 1024) { note('Ese fichero es demasiado grande para ser un prod.keys.', 'bad'); return; }
    const parsed = parseProdKeys(await file.text());
    if (parsed.missing.length || parsed.malformed.length) {
        const problems = [];
        if (parsed.missing.length) problems.push(`no están en el fichero: ${parsed.missing.join(', ')}`);
        if (parsed.malformed.length) problems.push(`no son 32 dígitos hexadecimales: ${parsed.malformed.join(', ')}`);
        note(`No se puede usar ese fichero (${problems.join('; ')}).`, 'bad');
        return;
    }
    note('Guardando las claves en la placa…');
    try {
        const rejected = await esp.storeKeys(parsed.keys);
        if (rejected.length) { note(`La placa no aceptó: ${rejected.join(', ')}.`, 'bad'); return; }
        state.replacingKeys = false; state.keysNote = null;
        await refreshKeys();
        if (state.keys?.complete) { await esp.startBridge(); log('web', 'claves guardadas'); }
    } catch (error) { note(`No se pudieron guardar las claves (${describe(error)}).`, 'bad'); }
}

async function onKeysErase() {
    const esp = state.esp;
    if (!esp?.attached) return;
    try { await esp.eraseKeys(); log('web', 'claves borradas de la placa'); await refreshKeys(); } catch (error) { state.keysNote = { text: describe(error), tone: 'bad' }; render(); }
}

function keysLine() {
    if (state.keysNote) return state.keysNote;
    const keys = state.keys;
    if (!keys || keys.complete) return { text: '' };
    const missing = Object.entries(KEY_NAMES).filter(([flag]) => !keys[flag]).map(([, name]) => name);
    return missing.length && missing.length < 4 ? { text: `Aún faltan: ${missing.join(', ')}.`, tone: 'warn' } : { text: '' };
}

// ---------------------------------------------------------------- volcado

let calibration = loadCalibration();
// Probabilidad elegida en el panel: null = original (cadena), 'toggle' = R alterna, o 1/N fija.
function chosenOdds() {
    const value = document.querySelector('input[name="odds"]:checked')?.value ?? '';
    if (value === 'none') return null;
    if (value === 'toggle') return 'toggle';
    if (value === 'fixed') return Number(document.querySelector('input[name="fixed"]:checked')?.value) || null;
    return Number(value) || null;
}
const chosenResets = () => [...document.querySelectorAll('input[name="reset"]:checked')].map((el) => el.value);
const chosenGiftReset = () => document.querySelector('input[name="giftreset"]:checked')?.value || null;
const chosenBalls = () => document.querySelector('input[name="balls"]:checked')?.value ?? 'ultra';
const eventById = (id) => (id === GIFT_EVENT_ID ? (supportsGifts(calibration) ? giftEvent(calibration, { oneIn: chosenOdds() ?? 1, reset: chosenGiftReset() }) : null) : id === ULTRA_EVENT_ID ? (supportsUltra(calibration) ? ultraEvent(calibration, { balls: chosenBalls(), keep: true, shiny: chosenOdds() }) : null) : id === LEGENDARY_EVENT_ID ? resetEvent(chosenResets()) : id === SHINY_EVENT_ID ? (calibration ? shinyEvent(calibration, { oneIn: chosenOdds() }) : null) : DUMP_EVENTS.find((e) => e.id === id));
const chosenMode = () => document.querySelector('input[name="mode"]:checked').value;

function dumpBlocker() {
    if (!state.esp?.attached) return 'Primero conecta la placa (paso 1).';
    if (!state.esp.info) return 'Primero instala el firmware (paso 1).';
    if (newer(GIFT_FIRMWARE, state.esp.info.version)) return `Hace falta el firmware ${GIFT_FIRMWARE} o superior: reinstálalo en el paso 1.`;
    if (!state.keys?.complete) return 'A la placa le faltan las claves (paso 1).';
    if (chosenMode() === GIFT_EVENT_ID && !supportsGifts(calibration)) return 'Falta la calibración de la tarjeta de regalos: pega abajo, en «Calibración», el informe de «Comprobar mi juego» (si lo hiciste en otra ventana) o repítelo en esta.';
    if (chosenMode() === LEGENDARY_EVENT_ID && !chosenResets().length) return 'Marca al menos un evento que quieras reiniciar.';
    if (chosenMode() === ULTRA_EVENT_ID && !supportsUltra(calibration)) return 'Falta la calibración de la tarjeta de bolas: pega abajo, en «Calibración», el informe de «Comprobar mi juego» (si lo hiciste en otra ventana) o repítelo en esta.';
    if (chosenMode() === SHINY_EVENT_ID && !calibration) return 'Para la tarjeta Shiny Hunting falta la calibración: pasa tu NSP por «Comprobar mi juego» en esta ventana o pega el informe en «Calibración».';
    if (state.esp.info.transport === 'UART' && state.esp.baudRate < FAST_BAUD) return 'El firmware de esta placa va a 115200 baudios, que no basta: actualízalo en el paso 1.';
    return null;
}

async function giftStart() {
    const event = eventById(chosenMode());
    if (state.gift || !event || dumpBlocker()) return;
    const distribution = new GiftDistribution(state.esp);
    distribution.addEventListener('log', (e) => log('enlace', e.detail));
    distribution.addEventListener('status', (e) => {
        if (state.gift !== distribution || state.giftClosing) return;
        const status = e.detail;
        if (status.stage === 'joining') { state.giftResult = null; state.files = []; }
        if (status.stage === 'checked') {
            state.game = status.detail;
            log('enlace', `la Switch usa ${describeGameCode(status.detail.gameCode)}, revisión ${status.detail.revision}`);
        }
        if (status.stage === 'backing-up' && status.detail?.report) keepFiles(status.detail, status.player);
        state.giftStatus = status;
        render();
    });
    distribution.addEventListener('result', (e) => {
        if (state.gift !== distribution || state.giftClosing) return;
        state.giftResult = e.detail;
        state.decision = null;
        if (e.detail.report) keepFiles(e.detail, e.detail.player);
        log('enlace', resultView(e.detail).headline);
        render();
    });
    distribution.addEventListener('decision', (e) => {
        if (state.gift !== distribution) return;
        state.decision = e.detail;
        render();
    });
    distribution.addEventListener('failed', (e) => { if (state.gift === distribution) giftStop({ text: `Parado: ${describe(e.detail)}`, tone: 'bad' }); });
    state.gift = distribution; state.giftNote = null; state.giftStatus = null; state.giftResult = null;
    render();
    try {
        await distribution.start(event);
        log('web', 'el grupo de Mystery Gift está abierto');
    } catch (error) {
        if (state.gift === distribution) state.gift = null;
        state.giftNote = { text: describe(error), tone: 'bad' };
    }
    render();
}

async function giftStop(note = null) {
    const distribution = state.gift;
    if (!distribution || state.giftClosing) return;
    state.giftClosing = true;
    render();
    await distribution.stop();
    state.gift = null; state.giftClosing = false; state.giftStatus = null; state.giftNote = note;
    log('web', 'el grupo de Mystery Gift está cerrado');
    render();
}

function fileName(game, player, ext) {
    const title = describeGameCode(game?.gameCode ?? '').replace(/ \(.*\)$/, '').replace(/\s+/g, '');
    const who = (player?.name || 'partida').replace(/[^\p{L}\p{N}_-]+/gu, '');
    return `${title || 'FRLG'}-${who}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function keepFiles(detail, player) {
    const files = [];
    if (detail.save) files.push({ name: fileName(state.game, player, 'sav'), bytes: detail.save, label: 'Guardado para PKHeX', note: '128 KB' });
    if (detail.report) {
        const bytes = new TextEncoder().encode(JSON.stringify(detail.report, null, 2));
        files.push({ name: fileName(state.game, player, 'json'), bytes, label: 'Datos de la partida (JSON)', note: `${(bytes.length / 1024).toFixed(0)} KB`, report: detail.report });
    }
    state.files = files;
    renderResult();
}

const REASONS = ['', 'no se encontró el pool de punteros del juego', 'los punteros hallados no coinciden con los de la consola', 'el puntero del almacenamiento no es fiable'];
const hex = (n) => `0x${n.toString(16)}`;

function resultView(result) {
    const who = result.player?.name || 'la Switch';
    switch (result.outcome) {
        case 'probed': {
            const h = result.header, ok = h.status === 0;
            return {
                headline: `Sonda: ${describeGameCode(h.gameCode)}, revisión ${h.revision}. Punteros ${ok ? 'correctos' : `NO fiables (estado ${h.status})`}.`,
                hint: `SB2 ${hex(h.sb2)} · SB1 ${hex(h.sb1)} · PC ${hex(h.storage)} · &PC ${hex(h.storagePtrAddress)}. ${ok ? 'Ya puedes hacer el volcado completo.' : 'Copia el registro y pásaselo a quien mantiene PokeDump.'}`,
                tone: ok ? 'good' : 'warn',
            };
        }
        case 'backed-up': return { headline: `Partida de ${who} volcada desde la RAM.`, hint: 'Descarga el .sav (PKHeX) y el .json. La Switch no ha guardado nada.', tone: 'good' };
        case 'dumped-partial': return { headline: `Volcado parcial de ${who}: faltan las cajas del PC.`, hint: `Descarga el .json (equipo, Pokédex y entrenador). Motivo: ${REASONS[result.header?.status] ?? 'desconocido'}.`, tone: 'warn' };
        case 'sent': return { headline: `Tarjeta enviada a ${who}.`, hint: 'Cuando la Switch termine de guardarla, habla con el repartidor (el de verde) en la planta de arriba de un Centro Pokémon. Dura hasta cerrar o reiniciar el juego; pulsa R en el campo para ver tu cadena.', tone: 'good' };
        case 'had-card': return { headline: 'La Switch ya tenía esta tarjeta y no se ha vuelto a enviar.', hint: 'Si quieres enviarla otra vez, pulsa Empezar de nuevo y elige enviarla.', tone: 'warn' };
        case 'kept-card': return { headline: 'No se ha enviado: en la Switch decidiste conservar la tarjeta que ya tenías.', hint: '', tone: 'warn' };
        case 'cant-accept': return { headline: 'La Switch no pudo aceptar el enlace.', hint: 'Comprueba que es Rojo Fuego o Verde Hoja y que REGALO MIST. (MYSTERY GIFT) está activado en el juego.', tone: 'warn' };
        case 'unsupported': return { headline: `Este juego no es compatible (${describeGameCode(result.game?.gameCode ?? '')}).`, hint: result.event?.id === SHINY_EVENT_ID ? 'La tarjeta se calibró con otra ROM distinta de la de esta Switch: vuelve a pasar tu NSP por «Comprobar mi juego».' : 'PokeDump funciona con Rojo Fuego y Verde Hoja.', tone: 'warn' };
        case 'lost':
            return state.files.length
                ? { headline: 'La partida llegó entera antes de que se cortase el enlace.', hint: 'Descarga los ficheros. La Switch puede mostrar un error de comunicación; su partida está como estaba.', tone: 'good' }
                : { headline: 'Se cortó el enlace con la Switch antes de terminar.', hint: 'Vuelve a entrar por REGALO MIST. → TARJETAS MISTERIOSAS → OTROS ENTRENADORES → GBLINK sin cerrar esta pestaña: el volcado sigue por donde iba.', tone: 'warn' };
        case 'error': return { headline: result.message ?? 'Falló el intercambio.', hint: '', tone: 'warn' };
        default: return { headline: '', hint: '', tone: '' };
    }
}

function dumpView() {
    if (state.giftClosing) return { headline: 'Cerrando el grupo…', hint: 'La placa se reinicia antes de poder abrirlo otra vez.', tone: '', busy: true };
    if (state.giftNote) return { headline: state.giftNote.text, hint: '', tone: state.giftNote.tone };
    const blocker = state.gift ? null : dumpBlocker();
    if (blocker) return { headline: blocker, hint: '', tone: '' };
    const status = state.giftStatus, result = state.giftResult;
    if (result) return { ...resultView(result), busy: false };
    if (!state.gift) return { headline: 'Todo listo. Elige sonda o volcado y pulsa Empezar.', hint: '', tone: '' };
    const name = status?.player?.name || 'la Switch';
    switch (status?.stage) {
        case 'restarting': return { headline: 'La placa se está reiniciando…', hint: 'El grupo se abre de nuevo en medio minuto.', busy: true };
        case 'joining': return { headline: 'La Switch se está uniendo…', hint: 'Mantén esta pestaña abierta.', tone: 'good', busy: true };
        case 'linked': case 'checking': case 'checked': return { headline: `Enlazado con ${name}.`, hint: 'Comprobando el juego…', tone: 'good', busy: true };
        case 'backing-up': return { headline: `Volcando la partida: ${status.detail?.done ?? 0} de ${status.detail?.total ?? 53} KB`, hint: 'Mantén la pestaña visible y la Switch cerca de la placa; la Switch muestra «Comunicando…». No se guarda nada.', tone: 'good', fraction: status.detail?.total ? status.detail.done / status.detail.total : true };
        case 'deciding': case 'asking': return { headline: 'La Switch tiene que decidir…', hint: 'Mira la pantalla de la Switch o responde aquí abajo.', tone: 'good', busy: true };
        case 'sending': return { headline: 'Enviando la tarjeta…', hint: 'La Switch muestra «Comunicando…». No cierres esta pestaña.', tone: 'good', busy: true };
        case 'closing': return { headline: 'Terminando el enlace…', hint: '', tone: 'good', busy: true };
        default: return { headline: 'Grupo abierto. Esperando a la Switch…', hint: 'En la Switch: REGALO MIST. → TARJETAS MISTERIOSAS → OTROS ENTRENADORES → GBLINK.', tone: 'good', busy: true };
    }
}

function renderDump() {
    const v = dumpView();
    setText('dump-status', v.headline, v.tone ?? '');
    setText('dump-hint', v.hint ?? '');
    setProgress('dump-progress', v.fraction ?? (v.busy ? true : null));
    const running = Boolean(state.gift);
    $('start').hidden = running;
    $('start').disabled = Boolean(dumpBlocker()) || state.espPhase !== 'idle';
    $('stop').hidden = !running;
    $('stop').disabled = state.giftClosing;
    $('dump-dot').className = `dot ${running ? 'busy' : state.giftResult ? (v.tone === 'good' ? 'good' : 'warn') : ''}`.trim();
    for (const radio of document.querySelectorAll('input[name="mode"]')) radio.disabled = running || (radio.value === SHINY_EVENT_ID && !calibration) || (radio.value === ULTRA_EVENT_ID && !supportsUltra(calibration)) || (radio.value === GIFT_EVENT_ID && !supportsGifts(calibration));
    const card = chosenMode() === SHINY_EVENT_ID;
    for (const li of document.querySelectorAll('.card-only')) li.hidden = !card;
    $('reset-panel').hidden = chosenMode() !== LEGENDARY_EVENT_ID;
    for (const input of document.querySelectorAll('#reset-panel input')) input.disabled = running;
    $('gift-reset-panel').hidden = chosenMode() !== GIFT_EVENT_ID;
    for (const input of document.querySelectorAll('#gift-reset-panel input')) input.disabled = running;
    $('balls-panel').hidden = chosenMode() !== ULTRA_EVENT_ID;
    for (const input of document.querySelectorAll('#balls-panel input')) input.disabled = running;
    for (const li of document.querySelectorAll('.ultra-only')) li.hidden = chosenMode() !== ULTRA_EVENT_ID;
    for (const li of document.querySelectorAll('.legendary-only')) li.hidden = chosenMode() !== LEGENDARY_EVENT_ID;
    const ultra = chosenMode() === ULTRA_EVENT_ID;
    const gifts = chosenMode() === GIFT_EVENT_ID;
    $('odds-panel').hidden = !(calibration && (card || ultra || gifts));
    $('odds-legend').textContent = ultra ? 'Además, probabilidad shiny' : 'Probabilidad shiny';
    for (const el of document.querySelectorAll('.ultra-opt')) el.hidden = !ultra;
    for (const el of document.querySelectorAll('.shiny-opt')) el.hidden = ultra || gifts;
    for (const el of document.querySelectorAll('.toggle-opt')) el.hidden = gifts;
    const oddsNow = document.querySelector('input[name="odds"]:checked');
    if (oddsNow && oddsNow.closest('label').hidden) document.querySelector(ultra ? 'input[name="odds"][value="none"]' : gifts ? 'input[name="odds"][value="1"]' : 'input[name="odds"][value=""]').checked = true;
    for (const li of document.querySelectorAll('.gift-only')) li.hidden = !gifts;
    $('fixed-chips').hidden = document.querySelector('input[name="odds"]:checked')?.value !== 'fixed';
    for (const input of document.querySelectorAll('#odds-panel input')) input.disabled = running;
    const summary = calibrationSummary(calibration);
    $('calib-summary').textContent = summary
        ? `Calibración: ${describeGameCode(calibration.gameCode)}${calibration.builtin ? ' (incluida, no hace falta hacer nada)' : ''}, ${summary.count} direcciones${summary.missingForAll.length ? ` · faltan para todas las tarjetas: ${summary.missingForAll.join(', ')}` : ' · completa'}`
        : 'Calibración: ninguna en esta ventana';
    $('calib-clear').disabled = !calibration;
    $('gift-desc').textContent = supportsGifts(calibration)
        ? `Salvajes, estáticos y regalos (iniciales, fósiles, Hitmon, Eevee, Lapras, huevos…) shiny, al equipo o a las cajas. Calibrada para ${describeGameCode(calibration.gameCode)}. Opcionalmente reinicia un evento (fósiles, Hitmon, Eevee…). Va aparte de la tarjeta de bolas y no lleva la tecla R.`
        : 'Antes pasa tu NSP por «Comprobar mi juego» (si ya lo hiciste, repítelo: ahora busca tres direcciones más).';
    $('ultra-desc').textContent = supportsUltra(calibration)
        ? `La ULTRA BALL (o las que elijas) captura siempre, como una MASTER BALL, mientras el juego esté abierto. Calibrada para ${describeGameCode(calibration.gameCode)}. Cambia el juego en memoria; el Pokémon se registra en la bola que lanzaste.`
        : 'Antes pasa tu NSP por «Comprobar mi juego» (si ya lo hiciste, repítelo: ahora busca una dirección más).';
    $('shiny-desc').textContent = calibration
        ? `Probabilidad shiny mucho más alta en combates salvajes, con cadena por especie. Calibrada para ${describeGameCode(calibration.gameCode)}. No es de solo lectura: cambia el juego hasta que lo cierres o reinicies.`
        : 'Antes pasa tu NSP por «Comprobar mi juego» una vez, para que la página encuentre las direcciones de tu versión del juego.';
    $('decision').hidden = !state.decision;
    if (state.decision) $('decision-text').textContent = 'La Switch ya tiene esta tarjeta. ¿Quieres enviarla otra vez?';
}

function renderResult() {
    const files = state.files;
    $('result-card').hidden = !files.length;
    if (!files.length) return;
    const report = files.find((f) => f.report)?.report;
    const result = state.giftResult;
    setText('result-headline', result ? resultView(result).headline : 'Partida recibida.', 'good');
    const facts = $('result-facts');
    facts.replaceChildren();
    if (report) {
        const add = (k, v) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; facts.append(dt, dd); };
        add('Juego', `${describeGameCode(report.game.code)} · revisión ${report.game.revision}`);
        add('Entrenador', `${report.trainer.name} · ID ${String(report.trainer.tid).padStart(5, '0')} · ${Math.floor(report.trainer.playTimeSeconds / 3600)} h jugadas`);
        add('Pokédex', `${report.dex.caught} capturados · ${report.dex.seen} vistos`);
        add('Equipo', `${report.party.length} Pokémon`);
        add('Cajas', report.boxes ? `${report.boxes.length} Pokémon` : 'no disponibles');
    }
    $('downloads').replaceChildren(...files.map((file) => {
        const row = document.createElement('div'); row.className = 'file';
        const text = document.createElement('div');
        const b = document.createElement('b'); b.textContent = file.label;
        const small = document.createElement('small'); small.textContent = `${file.name} · ${file.note}`;
        text.append(b, small);
        const button = document.createElement('button'); button.textContent = 'Descargar';
        button.onclick = () => download(file);
        row.append(text, button);
        return row;
    }));
    setText('result-note', report?.warnings?.join(' ') ?? '');
}

function download(file) {
    const url = URL.createObjectURL(new Blob([file.bytes], { type: 'application/octet-stream' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log('web', `descargado ${file.name}`);
}

// ---------------------------------------------------------------- pintar y arrancar

function render() {
    renderEsp();
    renderDump();
    renderResult();
}

function unsupported() {
    const notice = $('unsupported');
    if (navigator.serial && window.isSecureContext) return false;
    notice.hidden = false;
    notice.textContent = !window.isSecureContext
        ? 'La página debe abrirse por https:// o desde localhost para poder hablar con la placa.'
        : 'Este navegador no puede hablar con la placa. Usa Chrome o Edge en un ordenador (no móvil, no Safari).';
    return true;
}

function wire() {
    $('start').onclick = giftStart;
    $('stop').onclick = () => giftStop();
    for (const radio of document.querySelectorAll('input[name="mode"]')) radio.addEventListener('change', render);
    for (const radio of document.querySelectorAll('input[name="odds"], input[name="fixed"], input[name="balls"], input[name="reset"], input[name="giftreset"]')) radio.addEventListener('change', render);
    $('decision-yes').onclick = () => { state.gift?.decide(true); state.decision = null; render(); };
    $('decision-no').onclick = () => { state.gift?.decide(false); state.decision = null; render(); };
    $('esp-reinstall').onclick = () => onEspInstall();
    $('keys-replace').onclick = () => { state.replacingKeys = true; render(); };
    $('keys-erase').onclick = onKeysErase;
    $('esp-disconnect').onclick = () => dropEsp();
    $('copy-log').onclick = async () => { await navigator.clipboard.writeText(logLines.join('\n')); $('copy-log').textContent = '¡Copiado!'; setTimeout(() => { $('copy-log').textContent = 'Copiar el registro'; }, 1500); };
    const input = $('keys-file'), drop = $('keys-drop');
    input.onchange = () => { onKeysFile(input.files[0]); input.value = ''; };
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => onKeysFile(e.dataTransfer.files[0]));
    window.addEventListener('beforeunload', (e) => { if (state.gift) { e.preventDefault(); e.returnValue = ''; } });
}

// Para las pruebas de la interfaz (tests/ui.mjs): estado y pintado.
window.__pokedump = { state, render, keepFiles };

wire();
if (!unsupported()) {
    loadManifest().then((m) => { state.manifest = m; render(); }, (error) => { log('web', `no se pudo leer el manifiesto: ${describe(error)}`); render(); });
    navigator.serial.addEventListener?.('connect', () => {});
}
render();
