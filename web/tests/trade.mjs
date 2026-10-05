// Tests for the trade code (web/js/trade); no hardware: node web/tests/trade.mjs
//
// The Pokémon data and the trade engine are checked against the C# host in host/, which
// has made real trades: trade-vectors.json holds what it produced, and
// `dotnet run --project host/tests -c Release -- --web-vectors` regenerates it.

import { readFileSync } from 'node:fs';
import { DataError, fromHex, toHex, w16 } from '../js/trade/bytes.js';
import { Pk3, parse, toWire } from '../js/trade/pk3.js';
import { LINK, TradeEngine, linkCommand } from '../js/trade/engine.js';
import { gameData, playerBlock, trainerCard } from '../js/trade/rfu.js';
import { FrameReader, RFU, clientFrame, command, frameSize, hostPayload, toGbFrames } from '../js/trade/adapter.js';
import { GB_CHANNEL, GbFrameParser } from '../js/wire.js';
import { POOL_PATH, POOL_SERVER, PoolClient, poolRecord } from '../js/trade/pool.js';
import { FakePool } from './fake-pool.mjs';

let failures = 0, checks = 0;
function check(ok, what) {
    checks++;
    if (!ok) { failures++; console.log('FAIL', what); }
}
function rejects(action, what) {
    try { action(); } catch (error) { check(error instanceof DataError, `${what} (threw ${error?.name})`); return; }
    check(false, what);
}
const same = (a, b) => toHex(a) === toHex(b);
const reference = JSON.parse(readFileSync(new URL('../../host/tests/fixtures/vectors.json', import.meta.url)));
const vectors = JSON.parse(readFileSync(new URL('./trade-vectors.json', import.meta.url)));

// ---- the adapter's frames, and the pieces they travel in

{
    check(frameSize(RFU.BROADCAST) === 36 && frameSize(RFU.HOST_SEND) === 104 && frameSize(RFU.CONNECT_REQ) === 16, 'frame sizes by type');
    const payload = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const frame = clientFrame(payload);
    check(frame.length === 104 && toHex(frame.subarray(0, 4)) === '52465531', 'a frame of ours is 104 bytes behind the magic');
    check(toHex(frame.subarray(8, 12)) === '10000000', 'our length goes in the top byte of the header');
    // What the board sends puts the length in the low bits instead.
    const fromBoard = frame.slice();
    fromBoard.set([0, 0, 0, 16], 8);
    check(same(hostPayload(fromBoard), payload), 'the board\'s length is read from the low bits');

    const gb = new GbFrameParser(512);
    const reader = new FrameReader();
    const stream = toGbFrames(frame);
    let frames = [];
    for (const piece of gb.push(stream)) {
        check(piece.channel === GB_CHANNEL.DATA && piece.payload.length === 64, 'frames travel as 64-byte data pieces');
        frames = frames.concat(reader.push(piece.payload));
    }
    check(frames.length === 1 && frames[0].type === RFU.CLIENT_SEND && same(hostPayload(fromBoard), payload), 'a frame comes back whole');

    // Torn across reads, padded, and behind something that is not a frame.
    const torn = new FrameReader();
    const noise = new Uint8Array(30).fill(0x52);
    const bytes = [...noise, ...command(RFU.CONNECT_ACK, 0x1234), ...new Uint8Array(48), ...clientFrame(payload)];
    let seen = [];
    for (let at = 0; at < bytes.length; at += 7) seen = seen.concat(torn.push(Uint8Array.from(bytes.slice(at, at + 7))));
    check(seen.length === 2 && seen[0].type === RFU.CONNECT_ACK && seen[0].header === 0x1234 && seen[1].type === RFU.CLIENT_SEND,
        `a torn, padded stream resynchronises (${seen.length} frames)`);
}

// ---- the blocks a joining game sends

check(same(playerBlock(), fromHex(reference.player)), 'link player block');
check(same(trainerCard(), fromHex(reference.card)), 'trainer card block');
check(gameData().length === reference.ni.length && gameData().every((packet, i) => same(packet, fromHex(reference.ni[i]))), 'name exchange packets');

// ---- PK3, against what the reference host gets from PKHeX

for (const v of vectors.pk3.valid) {
    const input = fromHex(v.input);
    const pk = parse(input);
    check(same(pk.data, fromHex(v.data)), `${v.name}: parsed data`);
    check(same(toWire(input), fromHex(v.wire)), `${v.name}: traded form`);
    check(same(new Pk3(fromHex(v.wire)).data.subarray(0, 0x55), fromHex(v.data).subarray(0, 0x55)), `${v.name}: traded form reads back`);
    const seen = { species: pk.species, speciesInternal: pk.speciesInternal, speciesName: pk.speciesName, nickname: pk.nickname, trainer: pk.trainerName,
        trainerGender: pk.trainerGender, tid: pk.tid, sid: pk.sid, language: pk.language, level: pk.level, gender: pk.gender, shiny: pk.isShiny,
        egg: pk.isEgg, form: pk.form, heldItem: pk.heldItem };
    for (const [field, value] of Object.entries(seen)) check(value === v[field], `${v.name}: ${field} is ${value}, expected ${v[field]}`);
    check(pk.ivs.join() === v.ivs.join() && pk.stats.join() === v.stats.join(), `${v.name}: IVs and stats`);
    check(same(pk.export(), fromHex(v.data)), `${v.name}: export`);
}
for (const v of vectors.pk3.invalid) rejects(() => parse(fromHex(v.input)), `rejected: ${v.name}`);
check(same(toWire(fromHex(vectors.pk3.valid[0].input)), fromHex(reference.party[0])), 'traded form matches the host fixture');
{
    const party = JSON.parse(readFileSync(new URL('../assets/party.json', import.meta.url)));
    const filled = party.slots.filter(Boolean);
    check(filled.length >= 2 && party.slots[party.selected], 'the party this page ships can start a trade');
    for (const slot of filled) check(parse(fromHex(slot)).species > 0, 'a member of that party parses');
}

// ---- the trade engine, replaying what the reference host's engine did call by call

function slotOf(words) {
    const slot = new Uint8Array(14);
    words.forEach((word, i) => w16(slot, i * 2, word));
    return slot;
}

function replayEngine(scenario) {
    const engine = new TradeEngine(vectors.engine.party.map((h) => (h ? fromHex(h) : null)), scenario.offered);
    engine.animationFrames = 5;
    // The reference host offers as soon as the menu opens; here that is the caller's
    // doing, so the traces are replayed with the offer made up front.
    engine.offer(scenario.offered);
    const events = [];
    engine.onCommitted = (data, slot) => events.push(['committed', slot, toHex(data)]);
    engine.onOpponentParty = (mons, name) => events.push(['party', name, mons.map((m) => (m ? toHex(m) : null))]);
    engine.onDecliningChanged = (value) => events.push(['declining', value]);
    let echo = new Uint8Array(14), steps = 0;
    const step = (host) => {
        engine.feed([host ? fromHex(host) : new Uint8Array(14), echo, new Uint8Array(14), new Uint8Array(14), new Uint8Array(14)]);
        echo = slotOf(engine.tick());
        steps++;
        return toHex(echo);
    };
    const quiet = '00'.repeat(14);
    let standing = null;
    for (const [index, entry] of scenario.trace.entries()) {
        let ok = true;
        const where = `${scenario.name}, record ${index} (${entry[0]}), frame ${steps}`;
        if (entry[0] === 'step') { const sent = step(entry[1]); ok = sent === (entry[2] || quiet); if (!ok) console.log('  sent', sent, 'expected', entry[2] || quiet); }
        else if (entry[0] === 'idle') for (let i = 0; i < entry[1] && ok; i++) ok = step('') === quiet;
        else if (entry[0] === 'block') {
            engine.hostBlock(entry[1], fromHex(entry[2]));
            // The reference host offers again by itself when the Switch picks against its
            // cancel; here that is the player's to do.
            if (entry[1] === 2 && entry[2].startsWith('ccee')) engine.offer(standing ?? engine.offered);
        }
        else if (entry[0] === 'decline') engine.decline();
        else if (entry[0] === 'offer') {
            // The reference host keeps an offer made during a confirmation for the next
            // trade. Here it is refused, and the player makes it again afterwards.
            const confirming = engine.state === 3 || engine.state === 4;
            ok = engine.offer(entry[1]) === (confirming ? false : entry[2]);
            if (confirming && entry[2]) standing = entry[1];
        }
        else if (entry[0] === 'state') ok = JSON.stringify([engine.state, engine.declining, standing ?? engine.offered, engine.commits, engine.done]) === JSON.stringify(entry.slice(1));
        else {
            const event = events.shift();
            ok = JSON.stringify(event) === JSON.stringify(entry);
            // The reference host keeps its offer standing after a trade; here the
            // player makes it again, so the replay does it on their behalf.
            if (ok && entry[0] === 'committed') { engine.offer(standing ?? engine.offered); standing = null; }
        }
        check(ok, where);
        if (!ok) return;
    }
    check(events.length === 0, `${scenario.name}: no events beyond the reference's`);
}
for (const scenario of vectors.engine.scenarios) replayEngine(scenario);

// ---- an offer is this side's to make, and the Switch's cancel is answered at once

function opened(offer) {
    const engine = new TradeEngine(vectors.engine.party.map((h) => (h ? fromHex(h) : null)), 1);
    const sent = [];
    let echo = new Uint8Array(14);
    const run = (steps, host) => {
        for (let i = 0; i < steps; i++) {
            engine.feed([host ? host() : new Uint8Array(14), echo, new Uint8Array(14), new Uint8Array(14), new Uint8Array(14)]);
            const words = engine.tick();
            echo = slotOf(words);
            if ((words[0] & 0xff00) === 0x8800) sent.push([]);
            if ((words[0] & 0xff00) === 0x8900 && sent.length) sent[sent.length - 1].push(echo.slice(2, 14));
        }
    };
    // Open the menu: the player block, three party blocks and the ribbons block.
    const request = () => slotOf([0xa100, 1, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) run(40, request);
    for (let i = 0; i < 3; i++) engine.hostBlock(17, new Uint8Array(204));
    engine.hostBlock(4, new Uint8Array(48));
    run(20);
    if (offer) engine.offer(1);
    run(60);
    return { engine, run, commands: () => sent.filter((block) => block.length === 2).map((block) => toHex(block[0]).slice(0, 4)) };
}

{
    const quiet = opened(false);
    check(quiet.engine.menuComplete && !quiet.engine.selected, 'the menu opens without anything being offered');
    check(quiet.commands().length === 0, `nothing is sent until a Pokémon is offered (${quiet.commands().join()})`);
    // One cancel on the Switch is answered with ours, so one more there finishes it.
    quiet.engine.hostBlock(2, linkCommand(LINK.CANCEL));
    quiet.run(90);
    check(quiet.engine.declining && quiet.commands().at(-1) === 'aaee', `the Switch's cancel is answered with a cancel (${quiet.commands().join()})`);
}
{
    // A cancel here that meets a pick on the Switch spends both answers.
    const spent = opened(false);
    spent.engine.decline();
    spent.run(90);
    spent.engine.hostBlock(2, linkCommand(LINK.PARTNER_CANCEL));
    spent.run(120);
    check(!spent.engine.declining && !spent.engine.offering && spent.commands().at(-1) === 'aaee', `after that, nothing is sent until the player answers again (${spent.commands().join()})`);
}
{
    const offered = opened(true);
    check(offered.commands().at(-1) === 'bbaa', `an offer sends Ready (${offered.commands().join()})`);
    offered.engine.hostBlock(2, linkCommand(LINK.CANCEL));
    offered.run(90);
    check(offered.commands().at(-1) === 'aaee', `a standing offer is withdrawn when the Switch cancels (${offered.commands().join()})`);
}

rejects(() => new TradeEngine([fromHex(vectors.engine.party[0]), null, null, null, null, null], 0), 'a party of one cannot trade');
{
    const pooled = new TradeEngine([null, null, null, null, null, null], 0, { minimum: 0 });
    check(!pooled.occupied(0) && pooled.offer(0) === false, 'the trade pool\'s party starts empty, with nothing to offer');
    pooled.setPartyMon(0, fromHex(vectors.engine.party[0]));
    check(pooled.occupied(0) && pooled.offer(0) === true, 'and takes the pool\'s Pokémon when it arrives');
}
rejects(() => new TradeEngine(vectors.engine.party.map((h) => (h ? fromHex(h) : null)), 3), 'an empty slot cannot be offered');
check(LINK.READY === 0xaabb && LINK.BOTH_CANCEL === 0xeebb, 'link command values');

// ---- the trade pool

{
    const wires = vectors.pk3.valid.filter((v) => v.name.endsWith('party') && !v.egg).map((v) => fromHex(v.wire));
    const mail = Uint8Array.from({ length: 36 }, (_, i) => i + 1);
    const record = poolRecord(wires[0], { mail, game: 1, ribbons: Uint8Array.from({ length: 11 }, (_, i) => 0x40 + i) });
    check(record.length === 149 && toHex(record.subarray(0, 100)) === toHex(wires[0]), 'a pool record starts with the Pokémon as traded');
    check(toHex(record.subarray(100, 136)) === toHex(mail) && record[136] === 1 && record[137] === 1 && record[138] === 0x40 && record[148] === 0x4a, 'then its mail, its game and the gift ribbons');
    check(POOL_SERVER + POOL_PATH === 'wss://pokemon-gb-online-trades.herokuapp.com/pool3', 'the pool is the Pokémon web client\'s');

    const fake = new FakePool(wires.slice(1, 4).map((wire) => poolRecord(wire)));
    const pool = new PoolClient('ws://pool/', { Socket: fake.Socket });
    check(pool.url === 'ws://pool/pool3', 'the address takes a trailing slash');
    await pool.connect();
    const first = await pool.fetchMon();
    check(toHex(first.wire) === toHex(wires[1]) && first.pk.species === new Pk3(wires[1]).species, 'the pool\'s Pokémon arrives whole');
    check(await pool.propose(record), 'the pool takes what is offered for it');
    check(await pool.complete(new Pk3(wires[0]), first.pk), 'and the swap is sealed');
    check(fake.swaps === 1 && toHex(fake.mons[0]) === toHex(record), 'the pool now holds the Pokémon it was given, mail and all');
    const second = await pool.fetchMon();
    check(toHex(second.wire) !== toHex(first.wire), 'a sealed swap brings a different Pokémon on the same connection');

    // What the pool asks for again is sent again; a connection that goes is reported.
    const written = [];
    const lossy = new FakePool(wires.slice(1, 4).map((wire) => poolRecord(wire)));
    const Lossy = class extends lossy.Socket {
        send(packet) {
            const tag = String.fromCharCode(...new Uint8Array(packet).subarray(0, 5));
            written.push(tag);
            if (tag !== 'SA3S1') super.send(packet);
        }
    };
    const patient = new PoolClient('ws://pool', { Socket: Lossy });
    await patient.connect();
    await patient.fetchMon();
    patient.send('P3SO', record);
    patient.onMessage(Uint8Array.from([...'GP3SO'].map((c) => c.charCodeAt(0))));
    check(written.filter((tag) => tag === 'SP3SO').length === 2, 'a message the pool asks for again is sent again');
    let lost = '';
    try { await patient.propose(record); } catch (error) { lost = error.message; }
    check(lost.includes('lost'), `a connection the pool drops is reported, not waited out (${lost})`);

    // A repeat of an old answer is not taken for the next one.
    const stale = new PoolClient('ws://pool', { Socket: fake.Socket });
    stale.otherId = 7;
    stale.received.set('A3S1', Uint8Array.of(6, 1, 2, 3));
    check(stale.takeCounted('A3S1') === null && stale.otherId === 7, 'an old answer sent again is ignored');
    stale.received.set('A3S1', Uint8Array.of(7, 1, 2, 3));
    check(toHex(stale.takeCounted('A3S1')) === '010203' && stale.otherId === 8, 'the next one is taken');

    // The pool turning a Pokémon down, and a swap the pool says did not go through.
    const picky = new FakePool([poolRecord(wires[1])], { refuses: () => true });
    const refused = new PoolClient('ws://pool', { Socket: picky.Socket });
    await refused.connect();
    await refused.fetchMon();
    check(await refused.propose(record) === false && picky.swaps === 0, 'a Pokémon the pool will not take is refused');
    const strict = new FakePool([poolRecord(wires[1])]);
    const wrong = new PoolClient('ws://pool', { Socket: strict.Socket });
    await wrong.connect();
    const theirs = await wrong.fetchMon();
    check(await wrong.propose(record) && await wrong.complete(new Pk3(wires[2]), theirs.pk) === false && strict.swaps === 0, 'a swap that does not match what was offered is not sealed');

    // One connection holds one of the pool's Pokémon; an empty pool says so.
    const small = new FakePool([poolRecord(wires[1])]);
    const holder = new PoolClient('ws://pool', { Socket: small.Socket });
    await holder.connect();
    await holder.fetchMon();
    const late = new PoolClient('ws://pool', { Socket: small.Socket });
    await late.connect();
    let message = '';
    try { await late.fetchMon(); } catch (error) { message = error.message; }
    check(message.includes('no Pokémon'), `a pool with nothing free says so (${message})`);
    for (const client of [pool, patient, stale, refused, wrong, holder, late]) client.close();
}

console.log(failures ? `${failures} of ${checks} FAILED` : `all ${checks} trade checks pass`);
process.exit(failures ? 1 : 0);
