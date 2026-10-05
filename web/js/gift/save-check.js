// Comprueba si un .sav de 128 KB de FireRed/LeafGreen tiene copias completas (firma, suma de
// comprobación e ids de sus 14 sectores). Extraído de gift/save-backup.js de GB-Link Switch LDN (AGPL-3.0).

const u16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);
const u32 = (bytes, at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

const SECTOR_BYTES = 0x1000;
const SECTOR_DATA = 0xf80;
const SECTORS_PER_SLOT = 14;
const SIGNATURE = 0x08012025;

// Whether a sector's checksum (save.c CalculateChecksum) holds over its data,
// whose size depends on the sector, the game and its language: some size, in
// steps of 4 bytes, up to the whole data area.
function checksumHolds(save, at) {
    const want = u16(save, at + 0xff6);
    let sum = 0;
    for (let i = 0; i < SECTOR_DATA; i += 4) {
        sum = (sum + u32(save, at + i)) >>> 0;
        if ((((sum >>> 16) + sum) & 0xffff) === want) return true;
    }
    return false;
}

// What a save holds: each slot's 14 sectors whole, and its counter.
export function describeSave(save) {
    const slots = [0, 1].map((slot) => {
        const ids = new Set();
        let counter = null;
        let sound = true;
        for (let i = 0; i < SECTORS_PER_SLOT; i++) {
            const at = (slot * SECTORS_PER_SLOT + i) * SECTOR_BYTES;
            const id = u16(save, at + 0xff4);
            const good = u32(save, at + 0xff8) === SIGNATURE && checksumHolds(save, at) && id < SECTORS_PER_SLOT;
            if (!good) { sound = false; continue; }
            ids.add(id);
            const count = u32(save, at + 0xffc);
            if (counter !== null && count !== counter) sound = false;
            counter = count;
        }
        return { sound: sound && ids.size === SECTORS_PER_SLOT, counter };
    });
    const sound = slots.filter((slot) => slot.sound);
    return { slots, sound: sound.length > 0, counter: sound.length ? Math.max(...sound.map((slot) => slot.counter)) : null };
}
