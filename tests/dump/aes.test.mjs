import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Aes128, ctrCrypt, ecbDecrypt, xtsDecrypt } from '../../web/js/dump/aes.js';

const h = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
const hex = (b) => Buffer.from(b).toString('hex');

test('FIPS-197: vector de AES-128', () => {
    const aes = new Aes128(h('000102030405060708090a0b0c0d0e0f'));
    const ct = aes.encryptBlock(h('00112233445566778899aabbccddeeff'));
    assert.equal(hex(ct), '69c4e0d86a7b0430d8cdb78070b4c55a');
    assert.equal(hex(aes.decryptBlock(ct)), '00112233445566778899aabbccddeeff');
});

test('ECB y CTR frente a node:crypto con datos aleatorios', async () => {
    const key = randomBytes(16);
    const data = randomBytes(592);
    const enc = createCipheriv('aes-128-ecb', key, null).setAutoPadding(false);
    const ct = Buffer.concat([enc.update(data), enc.final()]);
    assert.equal(hex(ecbDecrypt(key, ct)), data.toString('hex'));
    const counter = randomBytes(16);
    counter.fill(0, 8, 16); counter.set([0xff, 0xff, 0xff, 0xf0], 12);   // cruza los 32 bits del contador (en un NSP real no llega a 64)
    const c = createCipheriv('aes-128-ctr', key, counter);
    const ctr = Buffer.concat([c.update(data), c.final()]);
    assert.equal(hex(await ctrCrypt(key, counter, ctr)), data.toString('hex'));
    // sin WebCrypto (ruta de AES propio)
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
        assert.equal(hex(await ctrCrypt(key, Uint8Array.from(counter), ctr)), data.toString('hex'));
    } finally { Object.defineProperty(globalThis, 'crypto', saved); }
});

test('XTS de Nintendo: coincide con la implementación de Python', async () => {
    const { execFileSync } = await import('node:child_process');
    const key = randomBytes(32), data = randomBytes(0x400);
    const py = execFileSync('python3', ['-c', `
import sys; sys.path.insert(0, 'tools'); import extract_rom as e
k=bytes.fromhex('${key.toString('hex')}'); d=bytes.fromhex('${data.toString('hex')}')
sys.stdout.write(e.xts_crypt(k, d).hex())`]).toString();
    assert.equal(hex(xtsDecrypt(key, data)), py);
});
