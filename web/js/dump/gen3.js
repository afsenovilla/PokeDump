// PokeDump: reconstruye un .sav de Pokémon Rojo Fuego / Verde Hoja (GBA, 128 KB) y un JSON a partir
// de SaveBlock2, SaveBlock1 y PokemonStorage leídos de la RAM de la consola.
// Estructuras de pret/pokefirered (include/global.h, pokemon.h, save.h, src/save.c);
// el descifrado de Pokémon sigue pokeldn/frlg/save/mon.py (AGPL-3.0).

import { EXP_TABLES, GROWTH_BY_NATIONAL } from './gen3-data.js';

export const SB2_SIZE = 0xf24;
export const SB1_SIZE = 0x3d68;
export const ST_SIZE = 0x83d0;
export const SAVE_BYTES = 0x20000;
export const SECTOR_BYTES = 0x1000;
export const SECTOR_DATA = 3968;
export const SECTORS_PER_SLOT = 14;
export const SIGNATURE = 0x08012025;
export const TOTAL_BOXES = 14;
export const IN_BOX = 30;
export const BOX_MON_BYTES = 80;
export const BOX_MONS_AT = 4;        // PokemonStorage: currentBox (u8) + relleno; las cajas empiezan en +4
export const PARTY_MON_BYTES = 100;
export const FORMAT = 'pokedump/1';

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

// ---------------------------------------------------------------- texto (charmap internacional)
const CHARS = new Map();
{
    const set = (code, text) => CHARS.set(code, text);
    set(0x00, ' '); set(0xab, '!'); set(0xac, '?'); set(0xad, '.'); set(0xae, '-'); set(0xaf, '·');
    set(0xb0, '…'); set(0xb1, '“'); set(0xb2, '”'); set(0xb3, '‘'); set(0xb4, '’'); set(0xb5, '♂');
    set(0xb6, '♀'); set(0xb7, '¥'); set(0xb8, ','); set(0xb9, '×'); set(0xba, '/');
    for (let i = 0; i < 10; i++) set(0xa1 + i, String(i));
    for (let i = 0; i < 26; i++) {
        set(0xbb + i, String.fromCharCode(65 + i));
        set(0xd5 + i, String.fromCharCode(97 + i));
    }
    // Latinas acentuadas del charmap internacional (0x01-0x2E) y sueltas.
    const acc = {
        0x01: 'À', 0x02: 'Á', 0x03: 'Â', 0x04: 'Ç', 0x05: 'È', 0x06: 'É', 0x07: 'Ê', 0x08: 'Ë', 0x09: 'Ì',
        0x0b: 'Î', 0x0c: 'Ï', 0x0d: 'Ò', 0x0e: 'Ó', 0x0f: 'Ô', 0x10: 'Œ', 0x11: 'Ù', 0x12: 'Ú', 0x13: 'Û',
        0x14: 'Ñ', 0x15: 'ß', 0x16: 'à', 0x17: 'á', 0x19: 'ç', 0x1a: 'è', 0x1b: 'é', 0x1c: 'ê', 0x1d: 'ë',
        0x1e: 'ì', 0x20: 'î', 0x21: 'ï', 0x22: 'ò', 0x23: 'ó', 0x24: 'ô', 0x25: 'œ', 0x26: 'ù', 0x27: 'ú',
        0x28: 'û', 0x29: 'ñ', 0x2a: 'º', 0x2b: 'ª', 0x2d: '&', 0x2e: '+', 0x35: '=', 0x36: ';', 0x51: '¿',
        0x52: '¡', 0x5a: 'Í', 0x5b: '%', 0x5c: '(', 0x5d: ')', 0x68: 'â', 0x6f: 'í', 0x85: '<', 0x86: '>',
        0xf0: ':', 0xf1: 'Ä', 0xf2: 'Ö', 0xf3: 'Ü', 0xf4: 'ä', 0xf5: 'ö', 0xf6: 'ü',
    };
    for (const [code, text] of Object.entries(acc)) set(Number(code), text);
}

const ENCODE = new Map([...CHARS].map(([code, text]) => [text, code]));

// Inverso de decodeText (para pruebas y fixtures): `width` bytes, relleno 0xFF.
export function encodeText(text, width) {
    const out = new Uint8Array(width).fill(0xff);
    [...text].slice(0, width).forEach((c, i) => { out[i] = ENCODE.get(c) ?? 0xac; });
    return out;
}

export function decodeText(bytes) {
    let out = '';
    for (const b of bytes) {
        if (b === 0xff) break;
        out += CHARS.get(b) ?? '?';
    }
    return out;
}

// ---------------------------------------------------------------- especies y niveles
// Número interno de Gen 3: 1-251 = nacional; 252-276 son huecos; 277-411 = nacional 252-386.
export function internalToNational(i) {
    if (i >= 1 && i <= 251) return i;
    if (i >= 277 && i <= 411) return i - 25;
    return null;
}

export function levelFromExp(national, exp) {
    const table = EXP_TABLES[GROWTH_BY_NATIONAL[national]];
    let level = 1;
    while (level < 100 && table[level + 1] <= exp) level++;
    return level;
}

// ---------------------------------------------------------------- Pokémon
const ORDERS = [
    'GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
    'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG',
];

// bytes: BoxPokemon de 80 bytes (o Pokemon de 100). Devuelve null si la casilla está vacía.
export function decodeMon(bytes, { party = false } = {}) {
    const pid = u32(bytes, 0);
    const otId = u32(bytes, 4);
    const key = (pid ^ otId) >>> 0;
    const secure = new Uint8Array(48);
    for (let i = 0; i < 12; i++) {
        const v = (u32(bytes, 32 + i * 4) ^ key) >>> 0;
        secure[i * 4] = v & 0xff; secure[i * 4 + 1] = (v >>> 8) & 0xff;
        secure[i * 4 + 2] = (v >>> 16) & 0xff; secure[i * 4 + 3] = v >>> 24;
    }
    let sum = 0;
    for (let i = 0; i < 24; i++) sum = (sum + u16(secure, i * 2)) & 0xffff;
    const checksumOk = sum === u16(bytes, 0x1c);
    const order = ORDERS[pid % 24];
    const sub = (letter) => secure.subarray(order.indexOf(letter) * 12, order.indexOf(letter) * 12 + 12);
    const growth = sub('G');
    const misc = sub('M');
    const internal = u16(growth, 0);
    if (internal === 0 && pid === 0) return null;
    const national = internalToNational(internal);
    const ivs = u32(misc, 4);
    const tid = otId & 0xffff;
    const sid = otId >>> 16;
    const exp = u32(growth, 4);
    const flags = bytes[0x13];
    const mon = {
        species: national,
        internalSpecies: internal,
        nickname: decodeText(bytes.subarray(8, 18)),
        otName: decodeText(bytes.subarray(0x14, 0x1b)),
        tid, sid,
        shiny: ((tid ^ sid ^ (pid >>> 16) ^ (pid & 0xffff)) >>> 0) < 8,
        egg: ((ivs >>> 30) & 1) === 1 || (flags & 4) !== 0,
        level: national ? (party ? bytes[0x54] : levelFromExp(national, exp)) : null,
        checksumOk,
    };
    return mon;
}

// ---------------------------------------------------------------- entrenador, Pokédex, equipo y cajas
export function parseTrainer(sb2) {
    return {
        name: decodeText(sb2.subarray(0, 7)),
        gender: sb2[8] === 0 ? 'm' : 'f',
        tid: u16(sb2, 0x0a),
        sid: u16(sb2, 0x0c),
        playTimeSeconds: u16(sb2, 0x0e) * 3600 + sb2[0x10] * 60 + sb2[0x11],
    };
}

const DEX_OWNED = 0x18 + 0x10;
const DEX_SEEN = 0x18 + 0x44;

export function parseDex(sb2) {
    const entries = {};
    let caught = 0;
    let seen = 0;
    for (let n = 1; n <= 386; n++) {
        const bit = (arr, base) => (arr[base + ((n - 1) >> 3)] >> ((n - 1) & 7)) & 1;
        const owned = bit(sb2, DEX_OWNED);
        const saw = bit(sb2, DEX_SEEN);
        if (owned) { entries[n] = 'c'; caught++; seen++; } else if (saw) { entries[n] = 'v'; seen++; }
    }
    return { nationalUnlocked: sb2[0x18 + 3] === 0xb9, caught, seen, entries };
}

function monEntry(mon, extra) {
    return {
        ...extra, species: mon.species, level: mon.level, shiny: mon.shiny,
        ...(mon.egg ? { egg: true } : {}),
        ...(mon.nickname ? { nickname: mon.nickname } : {}),
        ...(mon.checksumOk ? {} : { invalid: true }),
    };
}

export function parseParty(sb1) {
    const count = Math.min(sb1[0x34], 6);
    const out = [];
    for (let i = 0; i < count; i++) {
        const mon = decodeMon(sb1.subarray(0x38 + i * PARTY_MON_BYTES, 0x38 + (i + 1) * PARTY_MON_BYTES), { party: true });
        if (mon && mon.species) out.push(monEntry(mon, { slot: i + 1 }));
    }
    return out;
}

export function parseBoxes(storage) {
    const boxes = [];
    for (let b = 0; b < TOTAL_BOXES; b++) {
        const name = decodeText(storage.subarray(0x8344 + b * 9, 0x8344 + b * 9 + 9));
        const mons = [];
        for (let s = 0; s < IN_BOX; s++) {
            const at = BOX_MONS_AT + (b * IN_BOX + s) * BOX_MON_BYTES;
            const mon = decodeMon(storage.subarray(at, at + BOX_MON_BYTES));
            if (mon && mon.species) mons.push(monEntry(mon, { box: b + 1, slot: s + 1 }));
        }
        boxes.push({ box: b + 1, name, mons });
    }
    return boxes;
}

const GAMES = { BPR: 'firered', BPG: 'leafgreen' };
const LANGUAGES = { J: 'ja', E: 'en', F: 'fr', D: 'de', I: 'it', S: 'es', K: 'ko' };
// Idiomas con el juego de caracteres occidental (el que decodifica decodeText). En ja/ko los
// nombres no se pueden leer con él; el resto del volcado (Pokédex, especies, niveles) no depende de ello.
const WESTERN = new Set(['en', 'fr', 'de', 'it', 'es']);

// header: { gameCode: 'BPRS', revision: 10 } de la cabecera de la sonda. blocks: { sb2, sb1, storage? }.
export function buildReport(blocks, header = {}, { source = 'ram', dumpedAt = new Date().toISOString() } = {}) {
    const code = header.gameCode ?? '';
    const report = {
        format: FORMAT,
        dumpedAt,
        game: {
            title: GAMES[code.slice(0, 3)] ?? null, code, revision: header.revision ?? null,
            language: LANGUAGES[code[3]] ?? null, source,
        },
        trainer: parseTrainer(blocks.sb2),
        dex: parseDex(blocks.sb2),
        party: parseParty(blocks.sb1),
    };
    const warnings = [];
    if (report.game.language && !WESTERN.has(report.game.language)) {
        warnings.push(`Idioma «${report.game.language}»: los nombres (entrenador y motes) usan otro juego de caracteres y pueden salir con «?».`);
    }
    if (blocks.storage) report.boxes = parseBoxes(blocks.storage).filter((b) => b.mons.length).flatMap((b) => b.mons);
    else warnings.push('No se obtuvo el almacenamiento del PC: faltan las cajas.');
    if (warnings.length) report.warnings = warnings;
    return report;
}

// ---------------------------------------------------------------- .sav
export function sectorChecksum(data, size) {
    let sum = 0;
    for (let i = 0; i < (size >> 2); i++) sum = (sum + u32(data, i * 4)) >>> 0;
    return ((sum >>> 16) + sum) & 0xffff;
}

// Trozo de cada sector según sSaveSlotLayout de save.c: SB2, SB1 (4) y almacenamiento (9).
export function sectorChunk(id, blocks) {
    const [src, n, total] = id === 0 ? [blocks.sb2, 0, SB2_SIZE]
        : id <= 4 ? [blocks.sb1, id - 1, SB1_SIZE] : [blocks.storage, id - 5, ST_SIZE];
    const offset = n * SECTOR_DATA;
    const size = total >= offset ? Math.min(total - offset, SECTOR_DATA) : 0;
    return src ? src.subarray(offset, offset + size) : new Uint8Array(size);
}

// Un .sav de 128 KB: la copia actual en el espacio 0 (contador n) y la anterior en el 1 (n - 1),
// los sectores 28-31 (Salón de la Fama y Torre Entrenador) como flash borrada.
export function buildSav(blocks, { counter = 2 } = {}) {
    if (!blocks.storage) throw new Error('Sin el almacenamiento del PC no se puede reconstruir un .sav completo.');
    const sav = new Uint8Array(SAVE_BYTES).fill(0xff);
    const view = new DataView(sav.buffer);
    for (let slot = 0; slot < 2; slot++) {
        for (let id = 0; id < SECTORS_PER_SLOT; id++) {
            const at = (slot * SECTORS_PER_SLOT + id) * SECTOR_BYTES;
            const chunk = sectorChunk(id, blocks);
            sav.fill(0, at, at + SECTOR_BYTES);
            sav.set(chunk, at);
            view.setUint16(at + 0xff4, id, true);
            view.setUint16(at + 0xff6, sectorChecksum(chunk, chunk.length), true);
            view.setUint32(at + 0xff8, SIGNATURE, true);
            view.setUint32(at + 0xffc, slot === 0 ? counter : Math.max(counter - 1, 0), true);
        }
    }
    return sav;
}

// Comprobación inversa: ¿los 14 sectores de cada espacio llevan firma y suma correctas?
export function verifySav(sav) {
    const slots = [0, 1].map((slot) => {
        const ids = new Set();
        for (let i = 0; i < SECTORS_PER_SLOT; i++) {
            const at = (slot * SECTORS_PER_SLOT + i) * SECTOR_BYTES;
            const id = u16(sav, at + 0xff4);
            const ok = u32(sav, at + 0xff8) === SIGNATURE && id < SECTORS_PER_SLOT;
            const size = sectorChunk(id, { sb2: null, sb1: null, storage: null }).length;
            if (ok && sectorChecksum(sav.subarray(at, at + SECTOR_BYTES), size) === u16(sav, at + 0xff6)) ids.add(id);
        }
        return { sound: ids.size === SECTORS_PER_SLOT, counter: u32(sav, slot * SECTORS_PER_SLOT * SECTOR_BYTES + 0xffc) };
    });
    return { slots, sound: slots.some((s) => s.sound) };
}
