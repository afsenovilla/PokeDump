// AES-128 en JavaScript puro (bloque suelto, ECB) y modos XTS (Nintendo) y CTR, sin dependencias.
// WebCrypto no ofrece ECB ni XTS; para CTR se usa WebCrypto si está (mucho más rápido) y, si no,
// este mismo AES. Probado contra los vectores de FIPS-197 y contra node:crypto (tests/dump/aes.test.mjs).

const SBOX = new Uint8Array(256);
const INV = new Uint8Array(256);
(() => {
    let p = 1, q = 1;
    do {
        p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);          // p * 3
        q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;  // q / 3
        const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
        SBOX[p] = (x ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
})();

const xtime = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; } return r; };

export class Aes128 {
    constructor(key) {
        if (key.length !== 16) throw new Error('AES-128 necesita una clave de 16 bytes');
        const w = new Uint8Array(176);
        w.set(key);
        let rcon = 1;
        for (let i = 16; i < 176; i += 4) {
            let t = w.slice(i - 4, i);
            if (i % 16 === 0) {
                t = Uint8Array.of(SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]);
                rcon = xtime(rcon);
            }
            for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
        }
        this.w = w;
    }

    encryptBlock(inp, out = new Uint8Array(16)) {
        const s = Uint8Array.from(inp), w = this.w;
        for (let i = 0; i < 16; i++) s[i] ^= w[i];
        for (let round = 1; round <= 10; round++) {
            for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
            // ShiftRows
            let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
            t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
            t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
            if (round < 10) {
                for (let c = 0; c < 16; c += 4) {
                    const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
                    const all = a0 ^ a1 ^ a2 ^ a3;
                    s[c] ^= all ^ xtime(a0 ^ a1);
                    s[c + 1] ^= all ^ xtime(a1 ^ a2);
                    s[c + 2] ^= all ^ xtime(a2 ^ a3);
                    s[c + 3] ^= all ^ xtime(a3 ^ a0);
                }
            }
            for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
        }
        out.set(s);
        return out;
    }

    decryptBlock(inp, out = new Uint8Array(16)) {
        const s = Uint8Array.from(inp), w = this.w;
        for (let i = 0; i < 16; i++) s[i] ^= w[160 + i];
        for (let round = 9; round >= 0; round--) {
            // InvShiftRows
            let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
            t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
            t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
            for (let i = 0; i < 16; i++) s[i] = INV[s[i]];
            for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
            if (round > 0) {
                for (let c = 0; c < 16; c += 4) {
                    const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
                    s[c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
                    s[c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
                    s[c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
                    s[c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
                }
            }
        }
        out.set(s);
        return out;
    }
}

// ECB sobre varios bloques.
export function ecbDecrypt(key, data) {
    const aes = new Aes128(key);
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 16) aes.decryptBlock(data.subarray(i, i + 16), out.subarray(i, i + 16));
    return out;
}

function gfMul(t) {                    // tweak *= x en GF(2^128), little endian
    let carry = 0;
    for (let i = 0; i < 16; i++) {
        const next = (t[i] >> 7) & 1;
        t[i] = ((t[i] << 1) | carry) & 0xff;
        carry = next;
    }
    if (carry) t[0] ^= 0x87;
}

// AES-128-XTS de Nintendo: el tweak es el número de sector en big-endian.
export function xtsDecrypt(key32, data, sector = 0, sectorSize = 0x200) {
    const dataAes = new Aes128(key32.subarray(0, 16));
    const tweakAes = new Aes128(key32.subarray(16, 32));
    const out = new Uint8Array(data.length);
    const block = new Uint8Array(16);
    for (let i = 0; i < data.length; i += sectorSize) {
        const raw = new Uint8Array(16);
        new DataView(raw.buffer).setBigUint64(8, BigInt(sector + i / sectorSize));
        const tweak = tweakAes.encryptBlock(raw);
        for (let j = i; j < Math.min(i + sectorSize, data.length); j += 16) {
            for (let k = 0; k < 16; k++) block[k] = data[j + k] ^ tweak[k];
            dataAes.decryptBlock(block, block);
            for (let k = 0; k < 16; k++) out[j + k] = block[k] ^ tweak[k];
            gfMul(tweak);
        }
    }
    return out;
}

// AES-128-CTR: el contador son 16 bytes (8 de nonce + 8 de número de bloque, big endian).
export async function ctrCrypt(key, counter16, data) {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        try {
            const k = await subtle.importKey('raw', key, 'AES-CTR', false, ['decrypt']);
            return new Uint8Array(await subtle.decrypt({ name: 'AES-CTR', counter: counter16, length: 64 }, k, data));
        } catch { /* sin WebCrypto utilizable: AES propio */ }
    }
    const aes = new Aes128(key);
    const ctr = Uint8Array.from(counter16);
    const view = new DataView(ctr.buffer);
    const out = new Uint8Array(data.length);
    const ks = new Uint8Array(16);
    for (let i = 0; i < data.length; i += 16) {
        aes.encryptBlock(ctr, ks);
        for (let k = 0; k < 16 && i + k < data.length; k++) out[i + k] = data[i + k] ^ ks[k];
        view.setBigUint64(8, (view.getBigUint64(8) + 1n) & 0xffffffffffffffffn);
    }
    return out;
}
