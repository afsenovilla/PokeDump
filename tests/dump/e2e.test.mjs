// Servidor de volcado (JS) <-> consola falsa <-> payload ARM real en mGBA, con la partida sintética.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { RamDumpServer, PASSES_WITH_STORAGE } from '../../web/js/dump/ramdump.js';
import { buildReport, buildSav, verifySav } from '../../web/js/dump/gen3.js';
import { FakeConsole, MgbaRunner } from './fake-client.mjs';
import { makeBlocks } from './fixture.mjs';

let available = true;
try {
    execFileSync('python3', ['-c', 'import mgba.core'], { stdio: 'ignore' });
    execFileSync('arm-none-eabi-as', ['--version'], { stdio: 'ignore' });
} catch { available = false; }
const opts = { skip: available ? false : 'faltan mgba (pip) o binutils-arm-none-eabi' };

async function session({ blocks, init = {}, game, stopAfterPasses }) {
    const runner = new MgbaRunner();
    await runner.init(blocks, init);
    const consoleSide = new FakeConsole({ runner, game, stopAfterPasses });
    const server = new RamDumpServer({ link: consoleSide.link });
    consoleSide.attach(server);
    return { runner, consoleSide, server };
}

test('volcado completo de extremo a extremo (payload real en mGBA)', opts, async () => {
    const blocks = makeBlocks();
    const { runner, consoleSide, server } = await session({ blocks, game: { code: 'BPRS' } });
    try {
        const stages = [];
        server.onStage = (s, d) => stages.push([s, d?.done]);
        const result = await server.run();
        assert.equal(result.outcome, 'backed-up');
        assert.equal(consoleSide.returned, 14);                    // CLI_MSG_BUFFER_FAILURE: el juego no guarda
        assert.equal(consoleSide.passes, PASSES_WITH_STORAGE);
        assert.deepEqual(result.save, buildSav(blocks));           // el mismo .sav que desde los bloques originales
        assert.equal(verifySav(result.save).sound, true);
        const expected = buildReport(blocks, { gameCode: 'BPRS', revision: 10 });
        delete expected.dumpedAt; const got = { ...result.report }; delete got.dumpedAt;
        assert.deepEqual(got, expected);
        assert.equal(result.report.game.language, 'es');
        assert.equal(result.header.status, 0);
        assert.equal(stages.at(-1)[1], 53);
    } finally { runner.close(); }
});

test('disposición francesa de IWRAM y juego Verde Hoja', opts, async () => {
    const blocks = makeBlocks();
    const { runner, server } = await session({ blocks, init: { layout: 'french', gameCode: 'BPGS' }, game: { code: 'BPGS' } });
    try {
        const result = await server.run();
        assert.equal(result.outcome, 'backed-up');
        assert.equal(result.report.game.title, 'leafgreen');
        assert.equal(result.header.storagePtrAddress, 0x03004230);
    } finally { runner.close(); }
});

test('sin puntero fiable del PC: resultado parcial con aviso, sin .sav', opts, async () => {
    const blocks = makeBlocks();
    const { runner, consoleSide, server } = await session({ blocks, init: { sabotage: 'nopool' }, game: { code: 'BPRS' } });
    try {
        const result = await server.run();
        assert.equal(result.outcome, 'dumped-partial');
        assert.equal(result.save, undefined);
        assert.equal(result.header.status, 1);
        assert.ok(result.report.warnings.length === 1);
        assert.equal(consoleSide.passes, 21);
        assert.deepEqual(result.report.party.map((p) => p.species), [6, 386]);
    } finally { runner.close(); }
});

test('enlace perdido a medias: se sigue por donde iba (parche de .Lfirst)', opts, async () => {
    const blocks = makeBlocks();
    const game = { code: 'BPRS', trainerId: 0x777 };
    const first = await session({ blocks, game, stopAfterPasses: 30 });
    try {
        const pending = first.server.run();
        await new Promise((r) => setTimeout(r, 4000));             // el cliente se «cae» tras 30 pasadas
        first.server.fail(new Error('enlace perdido'));
        await assert.rejects(pending);
    } finally { first.runner.close(); }
    const second = await session({ blocks, game });                 // consola nueva: param a cero
    try {
        second.server.constructor;                                  // mismo jugador => mismo estado guardado
        const result = await second.server.run();
        assert.equal(result.outcome, 'backed-up');
        assert.deepEqual(result.save, buildSav(blocks));
        assert.ok(second.consoleSide.passes < PASSES_WITH_STORAGE, 'no repite las pasadas ya recibidas');
    } finally { second.runner.close(); }
});

test('sonda: una sola pasada, solo cabecera', opts, async () => {
    const blocks = makeBlocks();
    const runner = new MgbaRunner();
    await runner.init(blocks, {});
    const consoleSide = new FakeConsole({ runner, game: { code: 'BPRS', trainerId: 0x999 } });
    const server = new RamDumpServer({ link: consoleSide.link, probe: true });
    consoleSide.attach(server);
    try {
        const result = await server.run();
        assert.equal(result.outcome, 'probed');
        assert.equal(consoleSide.passes, 1);
        assert.equal(result.header.status, 0);
        assert.equal(result.header.gameCode, 'BPRS');
    } finally { runner.close(); }
});

// Todos los idiomas de FireRed y LeafGreen: el payload y la web no dependen del idioma.
for (const code of ['BPRE', 'BPRF', 'BPRD', 'BPRI', 'BPRS', 'BPGE', 'BPGF', 'BPGD', 'BPGI', 'BPGS', 'BPRJ', 'BPGJ']) {
    test(`volcado completo con ${code}`, opts, async () => {
        const blocks = makeBlocks();
        const { runner, server } = await session({ blocks, init: { gameCode: code }, game: { code } });
        try {
            const result = await server.run();
            assert.equal(result.outcome, 'backed-up');
            assert.equal(result.report.game.code, code);
            assert.equal(result.report.game.title, code.startsWith('BPR') ? 'firered' : 'leafgreen');
            assert.deepEqual(result.save, buildSav(blocks));
            const japanese = code.endsWith('J');
            assert.equal(!!result.report.warnings, japanese);
        } finally { runner.close(); }
    });
}
