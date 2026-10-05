import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, buildSav, decodeMon, levelFromExp, sectorChunk, verifySav, SAVE_BYTES } from '../../web/js/dump/gen3.js';
import { SHINY_PID, PLAIN_PID, makeBlocks, encodeMon, OTID } from './fixture.mjs';

test('shiny fixture is shiny and plain is not', () => {
    const shiny = decodeMon(encodeMon({ pid: SHINY_PID, otId: OTID, internal: 25, exp: 1000 }));
    const plain = decodeMon(encodeMon({ pid: PLAIN_PID, otId: OTID, internal: 25, exp: 1000 }));
    assert.equal(shiny.shiny, true);
    assert.equal(plain.shiny, false);
});

test('levels from experience at growth-rate boundaries', () => {
    assert.equal(levelFromExp(1, 0), 1);
    assert.equal(levelFromExp(25, 999), 9);       // Pikachu: Medio rápido, 10^3 = 1000
    assert.equal(levelFromExp(25, 1000), 10);
    assert.equal(levelFromExp(6, 1059860), 100);  // Charizard: Medio lento
    assert.equal(levelFromExp(6, 1059859), 99);
    assert.equal(levelFromExp(150, 1250000), 100); // Mewtwo: Lento
});

test('report: trainer, dex, party, boxes', () => {
    const report = buildReport(makeBlocks(), { gameCode: 'BPRS', revision: 10 }, { dumpedAt: 'x' });
    assert.deepEqual(report.game, { title: 'firered', code: 'BPRS', revision: 10, language: 'es', source: 'ram' });
    assert.equal(report.trainer.name, 'JOSÉÑA');
    assert.equal(report.trainer.tid, 12345);
    assert.equal(report.trainer.sid, 6789);
    assert.equal(report.trainer.gender, 'f');
    assert.equal(report.trainer.playTimeSeconds, 12 * 3600 + 34 * 60 + 56);
    assert.deepEqual(report.dex.entries, { 1: 'c', 2: 'v', 3: 'v', 4: 'c', 25: 'c', 52: 'v', 150: 'c', 386: 'c' });
    assert.equal(report.dex.caught, 5);
    assert.equal(report.dex.seen, 8);
    assert.equal(report.dex.nationalUnlocked, true);
    assert.deepEqual(report.party.map((p) => [p.species, p.level, p.shiny]), [[6, 50, false], [386, 100, true]]);
    assert.deepEqual(report.boxes.map((m) => [m.box, m.slot, m.species, m.level, m.shiny, !!m.egg]), [
        [1, 1, 25, 10, true, false],
        [1, 30, 252, 6, false, false],
        [14, 7, 175, 5, false, true],
    ]);
    assert.equal(report.boxes[1].nickname, 'ÁRBOL');
});

test('report without storage warns', () => {
    const { sb2, sb1 } = makeBlocks();
    const report = buildReport({ sb2, sb1 }, { gameCode: 'BPGS', revision: 10 });
    assert.equal(report.game.title, 'leafgreen');
    assert.ok(report.warnings.length === 1 && !report.boxes);
});

test('.sav: size, both slots sound, data lands in the right sectors', () => {
    const blocks = makeBlocks();
    const sav = buildSav(blocks);
    assert.equal(sav.length, SAVE_BYTES);
    const check = verifySav(sav);
    assert.equal(check.sound, true);
    assert.deepEqual(check.slots.map((s) => [s.sound, s.counter]), [[true, 2], [true, 1]]);
    assert.deepEqual(sav.subarray(0, 0xf24), blocks.sb2);
    assert.deepEqual(sav.subarray(4 * 0x1000, 4 * 0x1000 + 0xee8), blocks.sb1.subarray(3 * 3968));
    assert.deepEqual(sav.subarray(13 * 0x1000, 13 * 0x1000 + 0x7d0), blocks.storage.subarray(8 * 3968));
    assert.equal(sectorChunk(13, blocks).length, 0x7d0);
    assert.ok(sav.subarray(28 * 0x1000, 32 * 0x1000).every((b) => b === 0xff));
});

test('.sav checksum detects corruption', () => {
    const sav = buildSav(makeBlocks());
    sav[0x1000 * 2 + 5] ^= 1;
    const check = verifySav(sav);
    assert.equal(check.slots[0].sound, false);
    assert.equal(check.slots[1].sound, true);
});
