// Extrae la ROM de GBA (.gba) de un NSP de Pokémon Rojo Fuego / Verde Hoja de Switch, en el
// navegador y sin subir nada. Port de tools/extract_rom.py (que deriva de xci_read/romfs_read de
// pokeldn, AGPL-3.0, siguiendo las estructuras de hactool). Solo lee las partes necesarias del
// fichero (File.slice), así que un NSP grande no se carga entero en memoria.

import { Aes128, ctrCrypt, ecbDecrypt, xtsDecrypt } from './aes.js';

export class ExtractError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

const GAMES = { BPR: 'Rojo Fuego (FireRed)', BPG: 'Verde Hoja (LeafGreen)' };
const LANGS = { J: 'japonés', E: 'inglés', F: 'francés', D: 'alemán', I: 'italiano', S: 'español' };

const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u64 = (b, at) => Number(new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const text = (b) => new TextDecoder().decode(b);

export function parseKeys(content) {
    const keys = {};
    for (const line of content.split(/\r?\n/)) {
        const at = line.indexOf('=');
        if (at < 0) continue;
        const value = line.slice(at + 1).trim();
        if ((value.length === 32 || value.length === 64) && /^[0-9a-fA-F]+$/.test(value)) {
            keys[line.slice(0, at).trim()] = Uint8Array.from(value.match(/../g), (h) => parseInt(h, 16));
        }
    }
    return keys;
}

async function read(file, off, size) {
    const buf = new Uint8Array(await file.slice(off, off + size).arrayBuffer());
    if (buf.length < size) throw new ExtractError('truncated', 'El NSP está incompleto o truncado (¿la descarga terminó?).');
    return buf;
}

async function parsePfs0(file) {
    const head = await read(file, 0, 0x10);
    if (text(head.subarray(0, 4)) !== 'PFS0') {
        throw new ExtractError('not-nsp', 'Este fichero no es un NSP. Si es .nsz o .xci, conviértelo a .nsp primero.');
    }
    const count = u32(head, 4), strSize = u32(head, 8);
    const table = await read(file, 0x10, count * 0x18);
    const strings = await read(file, 0x10 + count * 0x18, strSize);
    const data = 0x10 + count * 0x18 + strSize;
    const files = [];
    for (let i = 0; i < count; i++) {
        const off = u64(table, i * 0x18), size = u64(table, i * 0x18 + 8), nameOff = u32(table, i * 0x18 + 16);
        let end = nameOff;
        while (strings[end] !== 0) end++;
        files.push({ name: text(strings.subarray(nameOff, end)), offset: data + off, size });
    }
    return files;
}

function parseFsHeader(fs) {
    const s = { fsType: fs[2], hashType: fs[3], crypt: fs[4], ctr: fs.slice(0x140, 0x148).reverse(), dataOffset: null };
    const sb = fs.subarray(0x8, 0x140);
    if (s.hashType === 3 && text(sb.subarray(0, 4)) === 'IVFC') {
        const levels = u32(sb, 0xc);
        for (let i = 0; i < Math.min(levels, 6); i++) {
            const off = u64(sb, 0x10 + i * 0x18), size = u64(sb, 0x18 + i * 0x18);
            if (size) s.dataOffset = off;
        }
    }
    return s;
}

async function ncaHeader(file, off, headerKey) {
    const clear = xtsDecrypt(headerKey, await read(file, off, 0xc00));
    if (text(clear.subarray(0x200, 0x203)) !== 'NCA') return null;
    const gen = Math.max(clear[0x206], clear[0x220]);
    const h = {
        contentType: clear[0x205], rightsId: clear.slice(0x230, 0x240), keyArea: clear.slice(0x300, 0x340),
        keygen: gen ? gen - 1 : 0, sections: [],
    };
    for (let i = 0; i < 4; i++) {
        const start = u32(clear, 0x240 + i * 0x10), end = u32(clear, 0x244 + i * 0x10);
        if (end) h.sections.push({ ...parseFsHeader(clear.subarray(0x400 + i * 0x200, 0x600 + i * 0x200)), offset: start * 0x200 });
    }
    return h;
}

function sectionKey(h, keys, tickets) {
    const hasRights = h.rightsId.some((b) => b !== 0);
    const gen = h.keygen.toString(16).padStart(2, '0');
    if (hasRights) {
        const name = `titlekek_${gen}`;
        if (!keys[name]) throw new ExtractError('no-key', `Tu prod.keys no tiene ${name}. Genera uno nuevo con Lockpick_RCM desde una consola con firmware igual o más reciente que el del juego.`);
        const tik = tickets.get(hex(h.rightsId));
        if (!tik) throw new ExtractError('no-ticket', `El NSP no trae el ticket ${hex(h.rightsId)}.tik.`);
        return ecbDecrypt(keys[name], tik.subarray(0x180, 0x190));
    }
    const name = `key_area_key_application_${gen}`;
    if (!keys[name]) throw new ExtractError('no-key', `Tu prod.keys no tiene ${name}. Genera uno nuevo con Lockpick_RCM.`);
    return ecbDecrypt(keys[name], h.keyArea).subarray(0x20, 0x30);
}

class CtrSection {
    constructor(file, ncaOffset, section, key) { Object.assign(this, { file, ncaOffset, section, key }); }

    async read(offset, size) {
        if (size <= 0) return new Uint8Array(0);
        const ncaOff = this.section.offset + offset;
        const pad = ncaOff % 16, aligned = ncaOff - pad;
        const raw = await read(this.file, this.ncaOffset + aligned, pad + size);
        const counter = new Uint8Array(16);
        counter.set(this.section.ctr);
        new DataView(counter.buffer).setBigUint64(8, BigInt(Math.floor(aligned / 16)));
        return (await ctrCrypt(this.key, counter, raw)).subarray(pad, pad + size);
    }
}

async function openRomFs(reader, base) {
    const head = await reader.read(base, 0x50);
    const dv = new DataView(head.buffer, head.byteOffset);
    const q = (i) => Number(dv.getBigUint64(i * 8, true));
    if (q(0) !== 0x50) throw new ExtractError('bad-romfs', 'No se pudo leer el RomFS: las claves no corresponden a este NSP.');
    const dirs = await reader.read(base + q(3), q(4));
    const files = await reader.read(base + q(7), q(8));
    return { reader, base, dataOffset: q(9), dirs, files };
}

function* walk(fs) {
    const dv = (b) => new DataView(b.buffer, b.byteOffset, b.length);
    const dd = dv(fs.dirs), fd = dv(fs.files);
    const stack = [[0, '']];
    while (stack.length) {
        const [d, prefix] = stack.pop();
        let off = dd.getUint32(d + 12, true);
        while (off !== 0xffffffff) {
            const sibling = fd.getUint32(off + 4, true);
            const dataOff = Number(fd.getBigUint64(off + 8, true)), size = Number(fd.getBigUint64(off + 16, true));
            const nameLen = fd.getUint32(off + 28, true);
            yield { path: `${prefix}/${text(fs.files.subarray(off + 32, off + 32 + nameLen))}`, offset: dataOff, size };
            off = sibling;
        }
        off = dd.getUint32(d + 8, true);
        while (off !== 0xffffffff) {
            const sibling = dd.getUint32(off + 4, true), nameLen = dd.getUint32(off + 20, true);
            stack.push([off, `${prefix}/${text(fs.dirs.subarray(off + 24, off + 24 + nameLen))}`]);
            off = sibling;
        }
    }
}

export function checkGbaHeader(rom) {
    if (rom.length < 0xc0) throw new ExtractError('bad-rom', 'El fichero es demasiado pequeño para ser una ROM de GBA.');
    let sum = 0;
    for (let i = 0xa0; i < 0xbd; i++) sum += rom[i];
    const code = String.fromCharCode(...rom.subarray(0xac, 0xb0));
    return {
        title: text(rom.subarray(0xa0, 0xac)).replace(/\0+$/, ''),
        game_code: code,
        revision: rom[0xbc],
        header_checksum_ok: ((-sum - 0x19) & 0xff) === rom[0xbd],
    };
}

export function describeGame(info) {
    const game = GAMES[info.game_code.slice(0, 3)] ?? 'juego desconocido';
    const lang = LANGS[info.game_code[3]] ?? 'idioma desconocido';
    return { game, language: lang, text: `${game}, ${lang}, código ${info.game_code}, revisión 0x${info.revision.toString(16).padStart(2, '0')}` };
}

async function sha1(bytes) {
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-1', bytes)));
}

// file: File/Blob del NSP; keysText: contenido de prod.keys. onProgress(texto) opcional.
export async function extractRom(file, keysText, onProgress = () => {}) {
    const keys = parseKeys(keysText);
    if (!keys.header_key) throw new ExtractError('no-key', 'Este prod.keys no contiene header_key. ¿Es el fichero correcto?');
    onProgress('Leyendo el NSP…');
    const entries = await parsePfs0(file);
    const tickets = new Map();
    for (const e of entries) if (e.name.endsWith('.tik')) tickets.set(e.name.slice(0, -4), await read(file, e.offset, e.size));
    const seen = [];
    for (const e of entries) {
        if (!e.name.endsWith('.nca') || e.name.endsWith('.cnmt.nca')) continue;
        onProgress(`Descifrando ${e.name.slice(0, 8)}…`);
        const h = await ncaHeader(file, e.offset, keys.header_key);
        if (!h) throw new ExtractError('bad-header', 'La cabecera no descifra: la header_key de tu prod.keys no corresponde a este NSP.');
        if (h.contentType !== 0) continue;
        const key = sectionKey(h, keys, tickets);
        for (const s of h.sections) {
            if (s.fsType !== 0 || s.crypt !== 3 || s.dataOffset === null) continue;
            const fs = await openRomFs(new CtrSection(file, e.offset, s, key), s.dataOffset);
            for (const f of walk(fs)) {
                seen.push(f.path);
                if (f.path.toLowerCase().endsWith('.gba')) {
                    onProgress(`Extrayendo ${f.path} (${(f.size / 1048576).toFixed(1)} MB)…`);
                    const rom = await fs.reader.read(fs.base + fs.dataOffset + f.offset, f.size);
                    const info = checkGbaHeader(rom);
                    const report = { romfs_path: f.path, size: rom.length, sha1: await sha1(rom), ...info };
                    return { rom, report, game: describeGame(info), fileName: f.path.split('/').pop() };
                }
            }
        }
    }
    throw new ExtractError('no-rom', `No encontré ninguna ROM .gba en el NSP (¿es solo una actualización o DLC?). Ficheros vistos: ${seen.join(', ') || 'ninguno'}.`);
}
