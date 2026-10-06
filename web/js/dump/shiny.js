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

// found: lo que devuelve locateSymbols; game: { gameCode: 'BPGS', revision: 10 }.
export function buildShinyPayload(found, game, { text = SHINY_TEXT_ES } = {}) {
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

    if (text) {
        // Textos de los mensajes del script (mismo espacio; el resto se rellena con 0xFF)
        writeText(script, 0x6a, 0x92 - 0x6a, message('Hasta reiniciar.', 'R muestra la cadena.'));
        writeText(script, 0x92, 0xc8 - 0x92, message('Este regalo no funciona con', 'esta versión del juego.'));
        const chain = [...line('Cadena '), 0xfd, 0x02, ...line(': '), 0xfd, 0x03, 0xff];
        if (chain.length !== 14) throw new Error('mensaje de cadena de tamaño inesperado');
        script.set(chain, 0x3b8);
        // Wonder Card: título, subtítulo, cuatro líneas y créditos
        writeText(card, 10, 40, [...line(text.title), 0xff]);
        writeText(card, 50, 40, [...line(text.subtitle), 0xff]);
        text.lines.slice(0, 4).forEach((l, i) => writeText(card, 90 + 40 * i, 40, [...line(l), 0xff]));
        writeText(card, 250, 40, [...line(text.credit), 0xff]);
    }
    return { card, script };
}
