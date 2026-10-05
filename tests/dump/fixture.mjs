// Partida sintética de Rojo Fuego/Verde Hoja para las pruebas (SaveBlock2, SaveBlock1, PC).
import { BOX_MON_BYTES, IN_BOX, PARTY_MON_BYTES, SB1_SIZE, SB2_SIZE, ST_SIZE, encodeText } from '../../web/js/dump/gen3.js';

const ORDERS = [
    'GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
    'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG',
];

// mon: { pid, otId, internal, exp, nickname, otName, egg, level (solo equipo), ivs }
export function encodeMon(mon, party = false) {
    const out = new Uint8Array(party ? PARTY_MON_BYTES : BOX_MON_BYTES);
    const v = new DataView(out.buffer);
    v.setUint32(0, mon.pid, true);
    v.setUint32(4, mon.otId, true);
    out.set(encodeText(mon.nickname ?? '', 10), 8);
    out[0x12] = 2;
    out[0x13] = 0x02 | (mon.egg ? 0x04 : 0);
    out.set(encodeText(mon.otName ?? 'ASH', 7), 0x14);
    const sub = { G: new Uint8Array(12), A: new Uint8Array(12), E: new Uint8Array(12), M: new Uint8Array(12) };
    const g = new DataView(sub.G.buffer);
    g.setUint16(0, mon.internal, true);
    g.setUint32(4, mon.exp, true);
    const m = new DataView(sub.M.buffer);
    m.setUint32(4, ((mon.ivs ?? 0x1234) | (mon.egg ? 1 << 30 : 0)) >>> 0, true);
    const order = ORDERS[mon.pid % 24];
    const secure = new Uint8Array(48);
    for (let i = 0; i < 4; i++) secure.set(sub[order[i]], i * 12);
    const sv = new DataView(secure.buffer);
    let sum = 0;
    for (let i = 0; i < 24; i++) sum = (sum + sv.getUint16(i * 2, true)) & 0xffff;
    v.setUint16(0x1c, sum, true);
    const key = (mon.pid ^ mon.otId) >>> 0;
    for (let i = 0; i < 12; i++) sv.setUint32(i * 4, (sv.getUint32(i * 4, true) ^ key) >>> 0, true);
    out.set(secure, 32);
    if (party) out[0x54] = mon.level;
    return out;
}

export const TID = 12345;
export const SID = 6789;
export const OTID = ((SID << 16) | TID) >>> 0;
// Un PID variocolor para ese OTID: tid ^ sid ^ hi ^ lo = 3 (< 8).
export const SHINY_PID = ((((TID ^ SID ^ 0x1112 ^ 3) & 0xffff) << 16) | 0x1112) >>> 0;
export const PLAIN_PID = 0x80001234;

export function makeBlocks() {
    const sb2 = new Uint8Array(SB2_SIZE);
    const v2 = new DataView(sb2.buffer);
    sb2.set(encodeText('JOSÉÑA', 8), 0);
    sb2[8] = 1;
    v2.setUint16(0x0a, TID, true);
    v2.setUint16(0x0c, SID, true);
    v2.setUint16(0x0e, 12, true); sb2[0x10] = 34; sb2[0x11] = 56;
    sb2[0x18 + 3] = 0xb9;
    const setBit = (base, n) => { sb2[base + ((n - 1) >> 3)] |= 1 << ((n - 1) & 7); };
    for (const n of [1, 4, 25, 150, 386]) { setBit(0x28, n); setBit(0x5c, n); }
    for (const n of [2, 3, 52]) setBit(0x5c, n);

    const sb1 = new Uint8Array(SB1_SIZE);
    sb1[0x34] = 2;
    sb1.set(encodeMon({ pid: PLAIN_PID, otId: OTID, internal: 6, exp: 125000, nickname: 'CHARIZARD', level: 50 }, true), 0x38);
    // Deoxys: interno 411 = nacional 386 (los huecos 252-276 desplazan a Hoenn).
    sb1.set(encodeMon({ pid: SHINY_PID, otId: OTID, internal: 411, exp: 1000000, level: 100 }, true), 0x38 + 100);

    const storage = new Uint8Array(ST_SIZE);
    storage[0] = 3;
    const put = (box, slot, mon) => storage.set(encodeMon(mon), 1 + ((box - 1) * IN_BOX + (slot - 1)) * BOX_MON_BYTES);
    put(1, 1, { pid: SHINY_PID, otId: OTID, internal: 25, exp: 1000 });                    // Pikachu, nivel 10
    put(1, 30, { pid: PLAIN_PID, otId: OTID, internal: 277, exp: 216, nickname: 'ÁRBOL' });  // Treecko (nac. 252), nivel 6
    put(14, 7, { pid: PLAIN_PID + 1, otId: OTID, internal: 175, exp: 100, egg: true });     // huevo
    for (let b = 0; b < 14; b++) storage.set(encodeText(`CAJA ${b + 1}`, 9), 0x8344 + b * 9);
    return { sb2, sb1, storage };
}
