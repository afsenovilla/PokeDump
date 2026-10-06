// Adaptación de la tarjeta Shiny Hunting a cualquier versión occidental de Rojo Fuego / Verde Hoja de
// la Switch. La tarjeta (shiny-card.js) es código ARM/Thumb que llama a funciones y variables del juego
// por dirección; esas direcciones cambian con cada idioma. Este módulo:
//  1. localiza las que necesita dentro de la ROM del usuario, buscando el código de cada función (patrones
//     sacados de pret/pokefirered, tools/shiny_build_ref.py) y leyendo las variables del pool de literales
//     de funciones que las usan;
//  2. escribe esas direcciones en la tarjeta, ajusta la comprobación de versión y traduce sus textos.
// La ROM no sale del navegador: solo se guarda el resultado de la búsqueda (direcciones).

import { SHINY_REF } from './shiny-ref.js';
import { SHINY_BASE_BASE64 } from './shiny-card.js';
import { encodeText } from './gen3.js';

const ROM_BASE = 0x08000000;
const CARD_BYTES = 332;
const SCRIPT_AT = 336;

const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const put32 = (b, at, v) => { b[at] = v & 255; b[at + 1] = (v >>> 8) & 255; b[at + 2] = (v >>> 16) & 255; b[at + 3] = (v >>> 24) & 255; };

function romString(rom) {
    const parts = [];
    for (let i = 0; i < rom.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, rom.subarray(i, i + 0x8000)));
    return parts.join('');
}

// Patrones ya preparados: seed = la tirada más larga de bytes fijos, para buscarla rápido.
const prepared = new Map();
function prepare(entry) {
    let p = prepared.get(entry);
    if (p) return p;
    const code = fromHex(entry.code), mask = fromHex(entry.mask);
    let best = [0, 0], run = 0;
    for (let k = 0; k <= code.length; k++) {
        if (k < code.length && mask[k]) run++;
        else { if (run > best[1]) best = [k - run, run]; run = 0; }
    }
    const [seedAt, seedLen] = best;
    p = { code, mask, seedAt, seed: String.fromCharCode(...code.subarray(seedAt, seedAt + Math.min(seedLen, 24))) };
    prepared.set(entry, p);
    return p;
}

function find(rom, str, entry, limit = 3) {
    const p = prepare(entry);
    if (!p.seed.length) return [];
    const hits = [];
    let pos = str.indexOf(p.seed);
    while (pos >= 0 && hits.length <= limit) {
        const start = pos - p.seedAt;
        if (start >= 0 && start % 2 === 0 && start + p.code.length <= rom.length) {
            let ok = true;
            for (let k = 0; k < p.code.length; k++) if (p.mask[k] && rom[start + k] !== p.code[k]) { ok = false; break; }
            if (ok) hits.push(start);
        }
        pos = str.indexOf(p.seed, pos + 1);
    }
    return hits;
}

const OPTIONAL_SYMBOLS = ['gLastUsedItem'];
const inRange = {
    func: (v, size) => v >= ROM_BASE && v < ROM_BASE + size,
    ewram: (v) => v >= 0x02000000 && v < 0x02040000,
    iwram: (v) => v >= 0x03000000 && v < 0x03008000,
};

// -> { found: { nombre: dirección }, problems: [texto] }
export function locateSymbols(rom, ref = SHINY_REF) {
    const str = romString(rom);
    const found = {}, problems = [];
    for (const [name, variants] of Object.entries(ref.funcs)) {
        let hit = null, seen = 0;
        for (const entry of variants) {
            const hits = find(rom, str, entry);
            seen = Math.max(seen, hits.length);
            if (hits.length === 1 || (name === 'Random' && hits.length === 2)) { hit = hits[0]; break; }   // Random y Random2 son idénticas: la primera
        }
        if (hit === null) problems.push(`${name}: ${seen ? `${seen} coincidencias` : 'no encontrada'}`);
        else found[name] = ((ROM_BASE + hit) | 1) >>> 0;
    }
    for (const [name, anchors] of Object.entries(ref.vars)) {
        const votes = new Map();
        for (const entry of anchors) {
            const hits = find(rom, str, entry);
            if (hits.length !== 1) continue;
            const v = u32(rom, hits[0] + entry.pool);
            votes.set(v, (votes.get(v) ?? 0) + 1);
        }
        if (!votes.size) { problems.push(`${name}: ninguna función de referencia encontrada`); continue; }
        const [value, count] = [...votes].sort((a, b) => b[1] - a[1])[0];
        if (votes.size > 1) problems.push(`${name}: las funciones de referencia no coinciden (${[...votes].map(([v, c]) => `${v.toString(16)}×${c}`).join(', ')})`);
        else if (!inRange.ewram(value) && !inRange.iwram(value)) problems.push(`${name}: valor fuera de la RAM (${value.toString(16)})`);
        found[name] = value;
        void count;
    }
    // Relaciones que cumplen todas las compilaciones conocidas (pret rev0/rev1, FR y LG, y el juego de la Switch en
    // inglés). Si no se cumplen no es un error seguro, pero merece mirarlo.
    const warnings = [];
    // Direcciones que solo usa la tarjeta de bolas: si fallan no invalidan la calibración de Shiny Hunting.
    for (const name of OPTIONAL_SYMBOLS) {
        const at = problems.findIndex((p) => p.startsWith(`${name}:`));
        if (at >= 0) { warnings.push(`${problems.splice(at, 1)[0]} (solo la tarjeta de bolas)`); delete found[name]; }
    }
    const rel = (a, b, diff, what) => { if (found[a] !== undefined && found[b] !== undefined && found[a] - found[b] !== diff) warnings.push(`${what}: ${(found[a] - found[b]).toString(16)} en vez de ${diff.toString(16)}`); };
    rel('gIntrTable', 'gMain', 0x450, 'gIntrTable − gMain');
    rel('sLockFieldControls', 'sGlobalScriptContext', 0xec, 'sLockFieldControls − sGlobalScriptContext');
    return { found, problems, warnings };
}

// Dónde va cada dirección en el script de la tarjeta (posición dentro del script de RAM): [offset, símbolo, sumando].
export const SHINY_SLOTS = [
    [0x100, 'gIntrTable', 0x10], [0x33c, 'gMain', 0], [0x340, 'gEnemyParty', 0], [0x344, 'gSaveBlock2Ptr', 0],
    [0x348, 'gBattleOutcome', 0], [0x34c, 'gBattleMainFunc', 0], [0x350, 'SetActionsAndBattlersTurnOrder', 0],
    [0x354, 'gBattleTypeFlags', 0], [0x358, 'gChosenActionByBattler', 0], [0x35c, 'Random', 0], [0x360, 'GetMonData', 0],
    [0x364, 'SetMonData', 0], [0x36c, 'CalculateMonStats', 0], [0x37c, 'gQuestLogState', 0], [0x380, 'CB1_Overworld', 0],
    [0x384, 'CB2_Overworld', 0], [0x388, 'sLockFieldControls', 0], [0x38c, 'sGlobalScriptContextStatus', 0],
    [0x390, 'ScriptContext_SetupScript', 0], [0x394, 'gSpecialVar_0x8004', 0],
    [0x050, 'sGlobalScriptContext', 0x64 + 1],        // callnative al buffer `data` del script (Thumb)
    [0x39d, 'DismissMapNamePopup', 0],                // callnative de la secuencia de la tecla R (sin alinear)
];

// Valores del juego original (inglés, Switch, revisión 10) para comprobar que la plantilla es la esperada.
const ENGLISH_CHECK = [[0x33c, 0x03002380], [0x340, 0x02024028], [0x35c, 0x08048671]];

const GATE_THIRD = 12, GATE_LANG = 24, GATE_REVISION = 36;     // bytes de la comprobación de versión en el script

const line = (text) => [...encodeText(text, text.length)];
const message = (...lines) => { const out = []; lines.forEach((l, i) => { if (i) out.push(0xfe); out.push(...line(l)); }); out.push(0xff); return out; };
function writeText(bytes, at, max, text) {
    if (text.length > max) throw new Error(`texto demasiado largo (${text.length} > ${max})`);
    bytes.fill(0xff, at, at + max);
    bytes.set(text, at);
}

export const SHINY_TEXT_ES = {
    title: 'CAZA SHINY', subtitle: 'POKéMON shiny más a menudo',
    lines: ['Captura o derrota al mismo', 'POKéMON una y otra vez para', 'verlo shiny. Habla con el', 'repartidor del CENTRO POKéMON.'],
    credit: 'GB-Link Team',
};

// Probabilidad fija en lugar de la cadena: 1/N con N potencia de dos (1 = siempre shiny). Sustituye, en el gancho, el cálculo
// `umbral = (min(cadena, 30) + 2) × 32` por `umbral = 65536 / N` (se compara con un valor de 16 bits).
export const SHINY_FIXED_ODDS = [64, 32, 16, 8, 4, 2, 1];
const THRESHOLD_AT = 0x23c, THRESHOLD_ORIGINAL = '00228842', THRESHOLD_BYTES = 0x12;       // desde `movs r2, #0` hasta `lsls r2, r2, #5`

function patchThreshold(script, oneIn) {
    if (!SHINY_FIXED_ODDS.includes(oneIn)) throw new Error(`probabilidad no admitida: 1/${oneIn}`);
    const at = THRESHOLD_AT;
    const hex = (from, n) => [...script.slice(from, from + n)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex(at, 4) !== THRESHOLD_ORIGINAL || hex(at + THRESHOLD_BYTES - 2, 2) !== '5201') throw new Error('la plantilla de la tarjeta no es la esperada (umbral)');
    const shift = 16 - Math.log2(oneIn);
    const movs = 0x2201;                          // movs r2, #1
    const lsls = 0x0012 | (shift << 6);           // lsls r2, r2, #shift  → r2 = 65536 / N
    const out = [movs & 0xff, movs >> 8, lsls & 0xff, lsls >> 8];
    while (out.length < THRESHOLD_BYTES) out.push(0xc0, 0x46);    // nop (mov r8, r8)
    script.set(out, at);
}

// Modo «R alterna siempre shiny»: la tecla R conmuta un indicador (halfword en +2 del estado del gancho, 0 o 60) y el umbral pasa a
// `((min(cadena, 30) + 2) << 5) | (indicador << 16)`: con el indicador no nulo siempre es ≥ 65536, así que todo salvaje sale shiny.
// Para hacer sitio: el umbral deja de exigir que la especie sea la del encuentro anterior (la cadena cuenta para cualquier
// especie) y el gestor de R ya no comprueba sLockFieldControls ni muestra la especie. Todas las posiciones son del script de RAM.
export const SHINY_TOGGLE = 'toggle';
const hexAt = (bytes, from, n) => [...bytes.slice(from, from + n)].map((b) => b.toString(16).padStart(2, '0')).join('');
function patchHalfwords(script, at, expected, replacement, what) {
    if (hexAt(script, at, expected.length * 2) !== expected.map((w) => (w & 0xff).toString(16).padStart(2, '0') + (w >> 8).toString(16).padStart(2, '0')).join('')) {
        throw new Error(`la plantilla de la tarjeta no es la esperada (${what})`);
    }
    replacement.forEach((w, i) => { script[at + 2 * i] = w & 0xff; script[at + 2 * i + 1] = w >> 8; });
}
// Mensaje de R: «Siempre shiny: Sí/No». El indicador vale 0 (No) o 60 (Sí) y el gestor de R deja en el `bufferstring` del script de R un
// puntero a «No» o, restándole el indicador, a «Sí». Posiciones en el script de RAM; el gancho está en 0x0203FC00 + (pos − 0x104).
const HOOK_RAM = 0x0203fc00, HOOK_FROM = 0x104, STATE_RAM = 0x0203ff60;
const ramAt = (pos) => HOOK_RAM + pos - HOOK_FROM;
const R_SCRIPT = 0x39c, R_OPERAND = 0x3a4, R_MESSAGE_TEXT = 0x3b2, R_NO = 0x3c4, R_YES = 0x388;
const RTEXT_STEP = R_NO - R_YES, RSTATE_BACK = STATE_RAM - ramAt(R_OPERAND), RTEXT_NO_AT = R_NO - R_OPERAND;

function patchToggle(script) {
    const at = (file) => file - SCRIPT_AT;
    // Umbral: movs r2,#0 / cmp r0,r1 / bne / ldrh r2,[r4,#4] / cmp r2,#30 / bls / movs r2,#30 / adds r2,#2 / lsls r2,r2,#5
    patchHalfwords(script, at(0x38c), [0x2200, 0x4288, 0xd103, 0x88a2, 0x2a1e, 0xd900, 0x221e, 0x3202, 0x0152], [
        0x88a2,   // ldrh r2, [r4, #4]     cadena
        0x2a1e,   // cmp  r2, #30
        0xd900,   // bls  +0               (salta el siguiente)
        0x221e,   // movs r2, #30
        0x3202,   // adds r2, #2
        0x0152,   // lsls r2, r2, #5
        0x8861,   // ldrh r1, [r4, #2]     indicador (0/1)
        0x0409,   // lsls r1, r1, #16
        0x430a,   // orrs r2, r1
    ], 'umbral');
    // Gestor de R: comprobaciones (CB1, bloqueo, script, quest log) y escritura de variables.
    patchHalfwords(script, at(0x304), [0x4874, 0x7800, 0x2800, 0xd110, 0x4873, 0x7800, 0x2802, 0xd10c,
        0x486d, 0x7800, 0x2802, 0xd208, 0x4871, 0x88a1, 0x8041, 0x88e1, 0x8081], [
        0x4875, 0x7800, 0x2802, 0xd110,           // ldr r0,=sGlobalScriptContextStatus ; ldrb ; cmp #2 ; bne fin   (antes: bloqueo del campo)
        0x486f, 0x7800, 0x2802, 0xd20c,           // ldr r0,=gQuestLogState ; ldrb ; cmp #2 ; bcs fin
        0x8861, 0x2200 | RTEXT_STEP, 0x4051, 0x8061,   // ldrh r1,[r4,#2] ; movs r2,#60 ; eors r1,r2 ; strh r1,[r4,#2]   conmuta el indicador (0 ↔ 60)
        0x0020, 0x3800 | RSTATE_BACK,                  // movs r0,r4 ; subs r0,#K    r0 = dirección del puntero del `bufferstring`
        0x1a43, 0x3300 | RTEXT_NO_AT,                  // subs r3,r0,r1 ; adds r3,#c  r3 = texto «No» − indicador (= «Sí» si está activo)
        0x6003,                                        // str r3,[r0]                 el script mostrará «Sí» o «No»
    ], 'gestor de R');
    // Script de R (callnative lo escribe SHINY_SLOTS en 0x39d): lockall ; bufferstring 0,«No» ; message ; waitmessage ; waitbuttonpress ; closemessage ; releaseall ; end
    script.fill(0xff, R_SCRIPT + 5, 0x3c8);
    let o = R_SCRIPT + 5;
    script[o++] = 0x69;
    script[o++] = 0x85; script[o++] = 0x00;
    put32(script, o, ramAt(R_NO)); o += 4;
    script[o++] = 0x67;
    put32(script, o, ramAt(R_MESSAGE_TEXT)); o += 4;
    script.set([0x66, 0x6d, 0x68, 0x6b, 0x02], o); o += 5;
    const label = [...line('Siempre shiny: '), 0xfd, 0x02, 0xff];
    if (o !== R_MESSAGE_TEXT || R_MESSAGE_TEXT + label.length > R_NO) throw new Error('el script de R no cabe');
    script.set(label, R_MESSAGE_TEXT);
    script.set([...line('No'), 0xff], R_NO);
    script.set([...line('Sí'), 0xff, 0xff], R_YES);
}

const TOGGLE_LINES = ['R activa o desactiva el', 'SIEMPRE SHINY (dice Sí o No).', 'Habla con el repartidor del', 'CENTRO POKéMON.'];
const fixedLines = (oneIn) => (oneIn === 1
    ? ['Todos los POKéMON salvajes', 'salen shiny.', 'Habla con el repartidor del', 'CENTRO POKéMON.']
    : ['Los POKéMON salvajes salen', `shiny 1 de cada ${oneIn}.`, 'Habla con el repartidor del', 'CENTRO POKéMON.']);

// found: lo que devuelve locateSymbols; game: { gameCode: 'BPGS', revision: 10 }.
// oneIn: null = el comportamiento original (cadena); un número de SHINY_FIXED_ODDS = probabilidad fija 1/N.
export function buildShinyPayload(found, game, { text = SHINY_TEXT_ES, oneIn = null } = {}) {
    const toggle = oneIn === SHINY_TOGGLE;
    const missing = [...new Set(SHINY_SLOTS.map((s) => s[1]))].filter((k) => found[k] === undefined);
    if (missing.length) throw new Error(`faltan direcciones del juego: ${missing.join(', ')}`);
    const raw = Uint8Array.from(atob(SHINY_BASE_BASE64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    const card = raw.slice(0, CARD_BYTES);
    const script = raw.slice(SCRIPT_AT);
    for (const [at, value] of ENGLISH_CHECK) if (u32(script, at) !== value) throw new Error('la plantilla de la tarjeta no es la esperada');

    // Comprobación de versión: BP?? y revisión 10. El tercer carácter distingue Rojo Fuego (R) de Verde Hoja (G).
    const code = game.gameCode;
    script[GATE_THIRD] = code.charCodeAt(2);
    script[GATE_LANG] = code.charCodeAt(3);
    script[GATE_REVISION] = game.revision;
    for (const [at, name, add] of SHINY_SLOTS) put32(script, at, (found[name] + add) >>> 0);

    if (toggle) patchToggle(script);
    else if (oneIn) patchThreshold(script, oneIn);

    if (text) {
        // Textos de los mensajes del script (mismo espacio; el resto se rellena con 0xFF)
        writeText(script, 0x6a, 0x92 - 0x6a, message('Hasta reiniciar.', toggle ? 'R: siempre shiny.' : oneIn ? `Shiny 1/${oneIn}.` : 'R muestra la cadena.'));
        writeText(script, 0x92, 0xc8 - 0x92, message('Este regalo no funciona con', 'esta versión del juego.'));
        if (!toggle) {
            const chain = [...line('Cadena '), 0xfd, 0x02, ...line(': '), 0xfd, 0x03, 0xff];
            if (chain.length !== 14) throw new Error('mensaje de cadena de tamaño inesperado');
            script.set(chain, 0x3b8);
        }
        // Wonder Card: título, subtítulo, cuatro líneas y créditos
        writeText(card, 10, 40, [...line(text.title), 0xff]);
        writeText(card, 50, 40, [...line(text.subtitle), 0xff]);
        const lines = toggle ? TOGGLE_LINES : oneIn ? fixedLines(oneIn) : text.lines;
        lines.slice(0, 4).forEach((l, i) => writeText(card, 90 + 40 * i, 40, [...line(l), 0xff]));
        writeText(card, 250, 40, [...line(text.credit), 0xff]);
    }
    return { card, script };
}


// Tarjeta «Legendarios»: solo script del juego, sin código nativo ni direcciones. Borra las banderas FLAG_FOUGHT_* de MEWTWO,
// MOLTRES, ARTICUNO y ZAPDOS (0x2BC–0x2BF); al volver a cargar su mapa, el propio juego los vuelve a mostrar
// (`call_if_unset FLAG_FOUGHT_X → clearflag FLAG_HIDE_X`). Reutiliza de la tarjeta de Shiny Hunting la comprobación de versión
// y el mensaje final; el resto del script (que nunca llega a ejecutarse) queda sin usar.
export const LEGENDARY_FLAGS = [0x2bc, 0x2bd, 0x2be, 0x2bf];
const LEGENDARY_AT = 0x2b, LEGENDARY_END = 0x56;                 // hueco del script: de los loadword del arranque al mensaje final
const LEGENDARY_CARD_ID = 0x5044, MEWTWO_ICON = 150;

export function buildLegendaryPayload(game) {
    const raw = Uint8Array.from(atob(SHINY_BASE_BASE64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    const card = raw.slice(0, CARD_BYTES);
    const script = raw.slice(SCRIPT_AT);
    if (script[LEGENDARY_AT] !== 0x0f || script[LEGENDARY_END] !== 0xbd) throw new Error('la plantilla de la tarjeta no es la esperada');
    const code = game.gameCode;
    script[GATE_THIRD] = code.charCodeAt(2);
    script[GATE_LANG] = code.charCodeAt(3);
    script[GATE_REVISION] = game.revision;
    script.fill(0x00, LEGENDARY_AT, LEGENDARY_END);                // nop
    LEGENDARY_FLAGS.forEach((flag, i) => script.set([0x2a, flag & 0xff, flag >> 8], LEGENDARY_AT + 3 * i));     // clearflag
    writeText(script, 0x6a, 0x92 - 0x6a, message('Legendarios listos.', 'Reentra al mapa.'));
    writeText(script, 0x92, 0xc8 - 0x92, message('Este regalo no funciona con', 'esta versión del juego.'));
    card[0] = LEGENDARY_CARD_ID & 0xff; card[1] = LEGENDARY_CARD_ID >> 8;
    card[2] = MEWTWO_ICON & 0xff; card[3] = MEWTWO_ICON >> 8;
    writeText(card, 10, 40, [...line('LEGENDARIOS'), 0xff]);
    writeText(card, 50, 40, [...line('MEWTWO y las aves, de nuevo'), 0xff]);
    ['Reactiva a MEWTWO, ARTICUNO,', 'ZAPDOS y MOLTRES aunque ya', 'los hayas capturado. Habla con', 'el repartidor y vuelve a su mapa.']
        .forEach((l, i) => writeText(card, 90 + 40 * i, 40, [...line(l), 0xff]));
    writeText(card, 250, 40, [...line('PokeDump'), 0xff]);
    return { card, script };
}


// Tarjeta «Ultra Ball = Master Ball»: reutiliza el instalador y el gancho de V-Blank de la tarjeta de Shiny Hunting, pero deja solo
// una función en el gancho: si gLastUsedItem es una de las bolas elegidas (ULTRA 2, SUPER 3, POKé 4), la cambia por MASTER BALL (1)
// antes de que el combate calcule la captura. La mochila ya descontó la bola al elegirla (usa gSpecialVar_ItemId), así que se gasta
// la bola que lanzaste; el Pokémon queda registrado en una Master Ball. Solo cambia la RAM.
export const ULTRA_BALL_CHOICES = { ultra: 0, 'ultra-great': 1, 'all-standard': 2 };      // → N: ids 2..2+N
export const ULTRA_REQUIRED = ['gIntrTable', 'gMain', 'gLastUsedItem', 'sGlobalScriptContext'];
const ULTRA_CARD_ID = 0x5046;

export function buildUltraBallPayload(found, game, { balls = 'ultra' } = {}) {
    const n = ULTRA_BALL_CHOICES[balls];
    if (n === undefined) throw new Error(`bolas no admitidas: ${balls}`);
    const missing = ULTRA_REQUIRED.filter((k) => found[k] === undefined);
    if (missing.length) throw new Error(`faltan direcciones del juego: ${missing.join(', ')}`);
    const raw = Uint8Array.from(atob(SHINY_BASE_BASE64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    const card = raw.slice(0, CARD_BYTES);
    const script = raw.slice(SCRIPT_AT);
    const at = (file) => file - SCRIPT_AT;
    const code = game.gameCode;
    script[GATE_THIRD] = code.charCodeAt(2);
    script[GATE_LANG] = code.charCodeAt(3);
    script[GATE_REVISION] = game.revision;
    // Direcciones que usan el instalador y el gancho: la entrada de V-Blank, gMain y el buffer de comandos del script (arranque en Thumb).
    for (const [slot, name, add] of SHINY_SLOTS) if (['gIntrTable', 'gMain', 'sGlobalScriptContext'].includes(name)) put32(script, slot, (found[name] + add) >>> 0);
    put32(script, 0x340, found.gLastUsedItem >>> 0);               // (hueco de gEnemyParty en la plantilla)
    // El gancho llama a tres funciones: se anulan las dos primeras (bl → nop) y la tercera se sustituye.
    patchHalfwords(script, at(0x26c), [0xf000, 0xf80b, 0xf000, 0xf840], [0x46c0, 0x46c0, 0x46c0, 0x46c0], 'llamadas del gancho');
    patchHalfwords(script, at(0x330), [0xb500, 0x4d57], [0x4857, 0x8801], 'función del gancho');
    const fn = [
        0x4857,           // ldr  r0, =gLastUsedItem
        0x8801,           // ldrh r1, [r0]
        0x3902,           // subs r1, #2                 ULTRA BALL = 2
        0x2900 | n,       // cmp  r1, #n
        0xd801,           // bhi  fin
        0x2101,           // movs r1, #1                 MASTER BALL
        0x8001,           // strh r1, [r0]
        0x4770,           // bx   lr
    ];
    for (let i = at(0x330); i < at(0x3bc); i += 2) { script[i] = 0xc0; script[i + 1] = 0x46; }
    fn.forEach((w, i) => { script[at(0x330) + 2 * i] = w & 0xff; script[at(0x330) + 2 * i + 1] = w >> 8; });
    const which = { ultra: 'ULTRA BALL', 'ultra-great': 'ULTRA y SUPER BALL', 'all-standard': 'POKé, SUPER y ULTRA BALL' }[balls];
    writeText(script, 0x6a, 0x92 - 0x6a, message('Hasta reiniciar.', 'Bolas = MASTER BALL.'));
    writeText(script, 0x92, 0xc8 - 0x92, message('Este regalo no funciona con', 'esta versión del juego.'));
    card[0] = ULTRA_CARD_ID & 0xff; card[1] = ULTRA_CARD_ID >> 8;
    card[2] = 150; card[3] = 0;
    writeText(card, 10, 40, [...line('MASTER BALL'), 0xff]);
    writeText(card, 50, 40, [...line('Captura segura'), 0xff]);
    ['Hasta que cierres el juego,', `${which} captura`, 'siempre, como una MASTER BALL.', 'Habla con el repartidor del CENTRO.']
        .forEach((l, i) => writeText(card, 90 + 40 * i, 40, [...line(l), 0xff]));
    writeText(card, 250, 40, [...line('PokeDump'), 0xff]);
    return { card, script };
}
