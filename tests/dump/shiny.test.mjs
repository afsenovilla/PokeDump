// Pruebas de la tarjeta Shiny Hunting adaptada (web/js/dump/shiny*.js).
// Las que necesitan ROM compiladas de pret/pokefirered usan PRET_DIR (make firered_rev1 firered leafgreen_rev1);
// sin esa variable se saltan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SHINY_SLOTS, buildShinyPayload, locateSymbols } from '../../web/js/dump/shiny.js';
import { calibrationFrom, shinyEvent } from '../../web/js/dump/shiny-event.js';
import { MG_LINK, WonderCardServer, messageBlocks, MG_BLOCK_BYTES, parseGameData } from '../../web/js/gift/mystery-gift.js';
import { decodeText } from '../../web/js/dump/gen3.js';

const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const names = [...new Set(SHINY_SLOTS.map((s) => s[1]))];
const synthetic = () => Object.fromEntries(names.map((n, i) => [n, 0x03001000 + i * 0x10 + 1]));

test('las direcciones, la comprobación de versión y los textos se escriben donde toca', () => {
    const found = synthetic();
    const { card, script } = buildShinyPayload(found, { gameCode: 'BPGS', revision: 10 });
    assert.equal(card.length, 332);
    assert.equal(script.length, 968);
    assert.deepEqual([script[12], script[24], script[36]], [0x47, 0x53, 10]);        // 'G', 'S', revisión 10
    for (const [at, name, add] of SHINY_SLOTS) assert.equal(u32(script, at), (found[name] + add) >>> 0, `${name} en ${at.toString(16)}`);
    assert.equal(decodeText(card.subarray(10, 50)), 'CAZA SHINY');
    assert.match(decodeText(script.subarray(0x92, 0xc8)), /regalo no funciona/);
    assert.equal(script[0x3b8 + 13], 0xff);                                            // el mensaje de cadena termina donde debe
});

test('Rojo Fuego usa R y el idioma sale del código del juego', () => {
    const { script } = buildShinyPayload(synthetic(), { gameCode: 'BPRF', revision: 10 });
    assert.deepEqual([script[12], script[24]], [0x52, 0x46]);
});

test('si falta una dirección no se genera la tarjeta', () => {
    const found = synthetic();
    delete found.Random;
    assert.throws(() => buildShinyPayload(found, { gameCode: 'BPGS', revision: 10 }), /Random/);
});

test('la calibración exige todas las direcciones y un código de juego válido', () => {
    const ok = calibrationFrom({ found: synthetic(), problems: [] }, { game_code: 'BPGS', revision: 10 });
    assert.equal(ok.ok, true);
    assert.equal(calibrationFrom({ found: synthetic(), problems: ['x'] }, { game_code: 'BPGS', revision: 10 }).ok, false);
    assert.equal(calibrationFrom({ found: synthetic(), problems: [] }, { game_code: 'ABCD', revision: 10 }).ok, false);
    const partial = synthetic(); delete partial.gMain;
    assert.equal(calibrationFrom({ found: partial, problems: [] }, { game_code: 'BPGS', revision: 10 }).ok, false);
});

// Un cliente mínimo: contesta con los datos del juego y espera el final.
async function sendCardTo(game) {
    const cal = calibrationFrom({ found: synthetic(), problems: [] }, { game_code: 'BPGS', revision: 10 }).data;
    const event = shinyEvent(cal);
    const sent = [];
    let server;
    server = new WonderCardServer({
        link: { sendBlock: (block, ident) => sent.push([ident, block]) },
        payload: (g) => event.build(g), confirm: async () => false,
    });
    const run = server.run();
    const gameData = new Uint8Array(100);
    const v = new DataView(gameData.buffer);
    v.setUint32(0, 0x101, true); v.setUint16(4, 1, true); v.setUint32(8, 1, true); v.setUint16(12, 1, true); v.setUint32(16, 5, true);
    for (let i = 0; i < 4; i++) gameData[0x5c + i] = game.gameCode.charCodeAt(i);
    gameData[0x60] = game.revision;
    for (const b of messageBlocks(MG_LINK.GAME_DATA, gameData)) server.block(b);
    await new Promise((r) => setTimeout(r, 20));
    for (const b of messageBlocks(MG_LINK.READY_END, new Uint8Array(0))) server.block(b);
    const result = await run;
    return { result, sent };
}

function reassemble(sent, ident) {
    const blocks = sent.filter(([i]) => i === ident).map(([, b]) => b);
    if (!blocks.length) return null;
    const size = blocks[0][4] | (blocks[0][5] << 8);
    const out = new Uint8Array(size);
    blocks.slice(1).forEach((b, i) => out.set(b.subarray(0, Math.min(MG_BLOCK_BYTES, size - i * MG_BLOCK_BYTES)), i * MG_BLOCK_BYTES));
    return out;
}

test('el servidor envía la tarjeta y el script adaptados al juego de la Switch', async () => {
    const { result, sent } = await sendCardTo({ gameCode: 'BPGS', revision: 10 });
    assert.equal(result.outcome, 'sent');
    const script = reassemble(sent, MG_LINK.RAM_SCRIPT);
    assert.equal(script.length, 968);
    assert.deepEqual([script[12], script[24], script[36]], [0x47, 0x53, 10]);
    assert.equal(reassemble(sent, MG_LINK.CARD).length, 332);
});

test('con otro juego distinto del calibrado no se envía nada', async () => {
    const { result, sent } = await sendCardTo({ gameCode: 'BPGE', revision: 10 });
    assert.equal(result.outcome, 'unsupported');
    assert.equal(reassemble(sent, MG_LINK.RAM_SCRIPT), null);
});

const PRET = process.env.PRET_DIR;
for (const build of ['pokefirered_rev1', 'pokefirered', 'pokeleafgreen_rev1']) {
    test(`el localizador encuentra todas las direcciones en ${build} (pret)`, { skip: !PRET || !fs.existsSync(`${PRET}/${build}.gba`) }, () => {
        const rom = new Uint8Array(fs.readFileSync(`${PRET}/${build}.gba`));
        const { found, problems } = locateSymbols(rom);
        assert.deepEqual(problems, []);
        const nm = execFileSync('arm-none-eabi-nm', [`${PRET}/${build}.elf`], { maxBuffer: 1 << 28 }).toString();
        const sym = Object.fromEntries(nm.split('\n').map((l) => l.split(' ')).filter((p) => p.length === 3).map((p) => [p[2], parseInt(p[0], 16)]));
        const alias = { GetMonData: 'GetMonData3' };
        const thumb = new Set(['Random', 'GetMonData', 'SetMonData', 'CalculateMonStats', 'ScriptContext_SetupScript', 'CB1_Overworld', 'CB2_Overworld', 'SetActionsAndBattlersTurnOrder', 'DismissMapNamePopup']);
        for (const [name, value] of Object.entries(found)) assert.equal(value, thumb.has(name) ? (sym[alias[name] ?? name] | 1) >>> 0 : sym[name], name);
    });
}
