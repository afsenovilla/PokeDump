// Saca los Pokémon de un .sav de Rojo Fuego / Verde Hoja (128 KB): equipo y cajas del PC, tal
// como están guardados (80 o 100 bytes, cifrados). Cada uno se puede ofrecer en un intercambio
// (trade/pk3.js los descifra) o guardar como .pk3.

import {
    BOX_MONS_AT, BOX_MON_BYTES, IN_BOX, PARTY_MON_BYTES, SAVE_BYTES, SB1_SIZE, SB2_SIZE, SECTOR_BYTES, SECTOR_DATA,
    ST_SIZE, TOTAL_BOXES, decodeText, parseTrainer, verifySav,
} from './gen3.js';

const SB1_PARTY_COUNT = 0x34;
const SB1_PARTY = 0x38;
const BOX_NAMES = 0x8344;

export class SaveError extends Error {}

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

// Une los sectores de una ranura por su id y devuelve las tres regiones.
function regions(sav, slot) {
    const sectors = {};
    for (let i = 0; i < 14; i++) {
        const at = (slot * 14 + i) * SECTOR_BYTES;
        sectors[u16(sav, at + 0xff4)] = sav.subarray(at, at + SECTOR_DATA);
    }
    const join = (ids, size) => {
        const out = new Uint8Array(size);
        ids.forEach((id, k) => { if (sectors[id]) out.set(sectors[id].subarray(0, Math.min(SECTOR_DATA, size - k * SECTOR_DATA)), k * SECTOR_DATA); });
        return out;
    };
    return { sb2: join([0], SB2_SIZE), sb1: join([1, 2, 3, 4], SB1_SIZE), storage: join([5, 6, 7, 8, 9, 10, 11, 12, 13], ST_SIZE) };
}

const empty = (mon) => mon.every((b) => b === 0) || u32(mon, 0) === 0 && u32(mon, 4) === 0;

// -> { trainer, party: [{ bytes }], boxes: [{ box, slot, boxName, bytes }] }
export function readSaveMons(sav) {
    if (!(sav instanceof Uint8Array) || sav.length !== SAVE_BYTES) throw new SaveError('Ese fichero no es un .sav de 128 KB de Rojo Fuego / Verde Hoja.');
    const check = verifySav(sav);
    const sound = check.slots.map((s, i) => ({ ...s, i })).filter((s) => s.sound).sort((a, b) => b.counter - a.counter);
    if (!sound.length) throw new SaveError('El guardado no es válido: no pasa la comprobación de checksums. Si lo has editado, vuelve a guardarlo con PKHeX.');
    const { sb2, sb1, storage } = regions(sav, sound[0].i);
    const trainer = parseTrainer(sb2);
    const count = Math.min(6, u32(sb1, SB1_PARTY_COUNT));
    const party = [];
    for (let i = 0; i < count; i++) {
        const bytes = sb1.slice(SB1_PARTY + i * PARTY_MON_BYTES, SB1_PARTY + (i + 1) * PARTY_MON_BYTES);
        if (!empty(bytes)) party.push({ bytes });
    }
    const boxes = [];
    for (let b = 0; b < TOTAL_BOXES; b++) {
        const boxName = decodeText(storage.subarray(BOX_NAMES + b * 9, BOX_NAMES + b * 9 + 9));
        for (let s = 0; s < IN_BOX; s++) {
            const at = BOX_MONS_AT + (b * IN_BOX + s) * BOX_MON_BYTES;
            const bytes = storage.slice(at, at + BOX_MON_BYTES);
            if (!empty(bytes)) boxes.push({ box: b + 1, slot: s + 1, boxName, bytes });
        }
    }
    return { trainer, party, boxes };
}
