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
