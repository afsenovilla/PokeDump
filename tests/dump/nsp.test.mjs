import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtractError, extractRom, parseKeys } from '../../web/js/dump/nsp.js';

let pycrypto = true;
try { execFileSync('python3', ['-c', 'import Crypto'], { stdio: 'ignore' }); } catch { pycrypto = false; }
const opts = { skip: pycrypto ? false : 'falta pycryptodome para generar el NSP sintético' };

function fixture(ticket) {
    const dir = mkdtempSync(join(tmpdir(), 'nsp-'));
    execFileSync('python3', ['tests/make_nsp.py', dir, ...(ticket ? ['t'] : [])]);
    return {
        nsp: new Blob([readFileSync(join(dir, 'juego.nsp'))]),
        keys: readFileSync(join(dir, 'prod.keys'), 'utf8'),
        rom: readFileSync(join(dir, 'rom.gba')),
    };
}

for (const ticket of [false, true]) {
    test(`extrae la ROM de un NSP sintético (${ticket ? 'con ticket' : 'sin ticket'})`, opts, async () => {
        const f = fixture(ticket);
        const steps = [];
        const out = await extractRom(f.nsp, f.keys, (t) => steps.push(t));
        assert.deepEqual(Buffer.from(out.rom), f.rom);
        assert.equal(out.report.game_code, 'BPRS');
        assert.equal(out.report.header_checksum_ok, true);
        assert.match(out.game.text, /Rojo Fuego.*español.*BPRS/);
        assert.ok(steps.length >= 2);
    });
}

test('errores claros: header_key mala, NSP que no es NSP, prod.keys sin claves', opts, async () => {
    const f = fixture(false);
    const bad = f.keys.replace(/header_key = ../, 'header_key = 00');
    await assert.rejects(extractRom(f.nsp, parseKeysText(bad)), (e) => e instanceof ExtractError);
    await assert.rejects(extractRom(new Blob([new Uint8Array(64)]), f.keys), (e) => e.code === 'not-nsp');
    await assert.rejects(extractRom(f.nsp, 'nada = 1'), (e) => e.code === 'no-key');
    await assert.rejects(extractRom(f.nsp, f.keys.split('\n').filter((l) => !l.startsWith('key_area')).join('\n')), (e) => e.code === 'no-key');
});
function parseKeysText(t) { return t.replace('header_key = 00', 'header_key = ' + '00'.repeat(32)); }

import { findClientPool } from '../../web/js/dump/nsp.js';

test('findClientPool: encuentra el pool de literales y el cmp r0,#1 de Client_RunBufferScript', () => {
    const rom = new Uint8Array(0x1000);
    const dv = new DataView(rom.buffer);
    const at = 0x200;
    dv.setUint16(at - 0x14, 0x2801, true);
    dv.setUint32(at, 0x0201c000, true);
    dv.setUint32(at + 4, 0x0300422c, true);     // &gSaveBlock2Ptr (disposición francesa)
    dv.setUint32(at + 8, 0x03004228, true);     // &gSaveBlock1Ptr
    dv.setUint32(0x800, 0x03004230, true);      // otra referencia al puntero del almacenamiento
    dv.setUint32(0x900, 0x0201c000, true);      // ruido: mismo búfer sin punteros contiguos
    dv.setUint32(0x904, 0x03004000, true);
    dv.setUint32(0x908, 0x03005000, true);
    const found = findClientPool(rom);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0], {
        rom_address: 0x08000200, pointer_addresses: [0x0300422c, 0x03004228],
        storage_ptr_address_guess: 0x03004230, storage_ptr_rom_references: 1, cmp_r0_1_before_pool: true,
    });
});
