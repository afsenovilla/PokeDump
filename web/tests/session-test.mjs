// Whole visits to the trade room, offline: the page's session code against a stand-in
// board that relays the Switch's game, and a stand-in trade pool.
// node web/tests/session-test.mjs

import { readFileSync } from 'node:fs';
import { fromHex, toHex, w16 } from '../js/trade/bytes.js';
import { TradeSession } from '../js/trade/session.js';
import { LINK } from '../js/trade/engine.js';
import { PoolClient, poolRecord } from '../js/trade/pool.js';
import { EspDevice } from '../js/esp.js';
import { FakeBoardPort } from './fake-port.mjs';
import { FakePool } from './fake-pool.mjs';

const vectors = JSON.parse(readFileSync(new URL('./trade-vectors.json', import.meta.url)));
const pk3 = await import('../js/trade/pk3.js');
let failures = 0, checks = 0;
function check(ok, what) {
    checks++;
    if (!ok) { failures++; console.log('FAIL', what); }
}

const hostParty = vectors.engine.hostParty.map(fromHex);
const ownParty = () => vectors.engine.party.map((h) => (h ? fromHex(h) : null));

// script(leader, { session, port, engine }) plays the Switch. The engine exists once the
// session has started, which the script's steps run after.
async function visit({ pool = null, script }) {
    const port = new FakeBoardPort({ tickMs: 4 });
    const board = new EspDevice();
    await board.open(port);
    const events = [];
    const session = new TradeSession({ device: board, party: pool ? null : ownParty(), selected: 1, pool, emit: (event) => events.push(event) });
    port.onLinkUp = (leader) => {
        session.engine.animationFrames = 5;   // the Switch's trade animation, shortened
        script(leader, { session, port, engine: session.engine });
        leader.wait(() => { port.leaveRoom(); return true; });
    };
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 60000);
    try { await session.run(controller.signal); }
    catch (error) { events.push({ event: 'error', message: error.message }); }
    finally { clearTimeout(guard); await board.close(); }
    return { events, session, port, engine: session.engine };
}

// What the Switch does, in the pieces a visit is made of.
const arrive = (leader) => leader.greet().sit();
const tradeFor = (leader, { session, engine }, slot, cursor = 0) => {
    let commits = 0;
    leader.wait(() => engine.menuComplete);
    leader.wait(() => { commits = engine.commits + 1; session.offerSlot(slot); return true; });
    leader.wait(() => engine.state === 2);
    leader.command(LINK.SET_MONS, cursor);
    leader.wait(() => leader.lastCommand === LINK.INIT_BLOCK);
    leader.command(LINK.INIT_BLOCK).command(LINK.START).command(LINK.READY_FINISH).command(LINK.CONFIRM_FINISH);
    leader.wait(() => engine.commits === commits);
};
const cancelUnoffered = (leader, engine) => {
    leader.wait(() => engine.menuComplete);
    leader.command(LINK.CANCEL);
    leader.wait(() => engine.declining && engine.selected);
    leader.command(LINK.BOTH_CANCEL);
    leader.wait(() => engine.done);
};

{
    // One trade with the player's own Pokémon, then both leave.
    const { events, engine, port } = await visit({ script: (leader, context) => {
        arrive(leader).open(hostParty);
        tradeFor(leader, context, 1);
        leader.open(hostParty);
        cancelUnoffered(leader, context.engine);
    } });
    const party = events.find((e) => e.event === 'opponent_party');
    check(party?.party.filter(Boolean).length === 2 && pk3.parse(party.party[0]).nickname === 'HOSTMON', 'the Switch\'s party arrives and reads');
    const received = events.find((e) => e.event === 'received');
    check(engine.commits === 1 && received?.slot === 1 && pk3.parse(received.pk3).nickname === 'HOSTMON', 'one trade, into the offered slot');
    const started = events.findIndex((e) => e.event === 'trading');
    check(started > events.findIndex((e) => e.event === 'offer') && started < events.indexOf(received), 'the page hears the trade start, after which it cannot be called off');
    check(engine.done, 'both left the menu');
    check(!port.commands.includes('LDN_BRIDGE_STOP') && port.adapter === 'uart', 'the board kept its bridge, and took its adapter link back');
    check(port.frames.out > 100 && port.frames.in > 100, `adapter frames both ways (${port.frames.in} in, ${port.frames.out} out)`);
    check(!events.some((e) => e.event === 'error'), `no error (${events.find((e) => e.event === 'error')?.message})`);
}
{
    // Two trades in one menu: the second sends back what the first brought in.
    const { events, engine } = await visit({ script: (leader, context) => {
        arrive(leader).open(hostParty);
        tradeFor(leader, context, 1);
        leader.open(hostParty);
        tradeFor(leader, context, 1);
        leader.open(hostParty);
        cancelUnoffered(leader, context.engine);
    } });
    const received = events.filter((e) => e.event === 'received');
    check(engine.commits === 2 && received.length === 2 && received.every((r) => r.slot === 1), 'two trades, both into the offered slot');
    check(events.findIndex((e) => e.event === 'declining' && e.value) > events.findLastIndex((e) => e.event === 'received'), 'no cancel went out between the trades');
}
{
    // With nothing offered, one cancel on the Switch closes the menu.
    const { events, engine } = await visit({ script: (leader, context) => {
        arrive(leader).open(hostParty);
        cancelUnoffered(leader, context.engine);
    } });
    check(engine.commits === 0 && engine.done, 'the menu closed after a single cancel');
    check(events.some((e) => e.event === 'menu') && events.some((e) => e.event === 'room'), 'the page heard the menu open and the return to the room');
}
{
    // An offer standing when the Switch cancels: the game asks its player twice.
    const { engine } = await visit({ script: (leader, { session, engine }) => {
        arrive(leader).open(hostParty);
        leader.wait(() => engine.menuComplete).wait(() => { session.offerSlot(1); return true; }).wait(() => engine.state === 2);
        leader.command(LINK.CANCEL).command(LINK.PLAYER_CANCEL);
        leader.wait(() => engine.declining && leader.lastCommand === LINK.CANCEL);
        leader.command(LINK.CANCEL).command(LINK.BOTH_CANCEL);
        leader.wait(() => engine.done);
    } });
    check(engine.done && engine.commits === 0, 'a standing offer is withdrawn and the second cancel closes the menu');
}
{
    // Changing the offer while connected trades the new choice.
    const { events } = await visit({ script: (leader, context) => {
        const { session, engine } = context;
        arrive(leader).open(hostParty);
        leader.wait(() => engine.menuComplete).wait(() => { session.offerSlot(1); return true; }).wait(() => engine.state === 2);
        leader.wait(() => { session.offerSlot(0); return true; }).wait(() => engine.sentCursor === 0);
        leader.command(LINK.SET_MONS, 0);
        leader.wait(() => leader.lastCommand === LINK.INIT_BLOCK);
        leader.command(LINK.INIT_BLOCK).command(LINK.START).command(LINK.READY_FINISH).command(LINK.CONFIRM_FINISH);
        leader.wait(() => engine.commits === 1);
        leader.open(hostParty);
        cancelUnoffered(leader, engine);
    } });
    check(events.find((e) => e.event === 'received')?.slot === 0, 'the changed offer is the one traded');
}
{
    // Leaving the menu and sitting down again opens a new one, in the same room.
    const { events, engine } = await visit({ script: (leader, context) => {
        arrive(leader).open(hostParty);
        cancelUnoffered(leader, context.engine);
        leader.keys(17, 30).sit().open(hostParty);
        tradeFor(leader, context, 1);
        leader.open(hostParty);
        cancelUnoffered(leader, context.engine);
    } });
    const order = events.map((e) => e.event).filter((name) => ['menu', 'room', 'received'].includes(name)).join(' ');
    check(order === 'menu room menu received menu room', `menu, room, menu again, a trade, and out (${order})`);
    check(engine.commits === 1 && engine.seatRound > 3, `the second visit's standby rounds carry on from the first's (${engine.seatRound})`);
    check(events.filter((e) => e.event === 'opponent_party').length === 3, 'the Switch\'s party arrived for every menu');
}

// ---- the trade pool

const poolRecords = vectors.pk3.valid.filter((v) => v.name.endsWith('party') && !v.egg).slice(2, 6).map((v) => poolRecord(fromHex(v.wire)));
// The first of the three party blocks the page sent last.
const offeredTo = (leader) => toHex(leader.blocks.filter((b) => b.length === 204).at(-3).subarray(0, 100));

{
    // A pool trade, the pool's next Pokémon in the reopened menu, then a cancel and a
    // return to the table, which brings a different one. The pool is reached before the
    // board is touched, and asked for a Pokémon only once the Switch has let the page in.
    const fake = new FakePool(poolRecords);
    const seen = [], asked = [];
    const pick = fake.pick.bind(fake);
    let current = null;
    fake.pick = () => { asked.push(Boolean(current?.engine?.established)); return pick(); };
    const { events, engine } = await visit({ pool: new PoolClient('ws://pool', { Socket: fake.Socket }), script: (leader, context) => {
        current = context.session;
        arrive(leader).open(hostParty, { ribbons: Uint8Array.of(1, 2, 3) });
        leader.wait(() => { seen.push(offeredTo(leader)); return true; });
        tradeFor(leader, context, 0);
        leader.open(hostParty);
        leader.wait(() => { seen.push(offeredTo(leader)); return true; });
        cancelUnoffered(leader, context.engine);
        leader.keys(17, 30).sit().open(hostParty);
        leader.wait(() => { seen.push(offeredTo(leader)); return true; });
        cancelUnoffered(leader, context.engine);
    } });
    const offers = events.filter((e) => e.event === 'pool_mon').map((e) => toHex(e.pk3));
    const traded = events.find((e) => e.event === 'pool_traded');
    check(offers.length >= 3 && new Set(offers.slice(0, 3)).size === 3, `the pool offered a different Pokémon each time (${offers.length})`);
    check(asked.length >= 3 && asked.every(Boolean) && events.findIndex((e) => e.event === 'pool_mon') > events.findIndex((e) => e.event === 'device'), 'no Pokémon was taken from the pool before the Switch had let the page in');
    check(seen.length === 3 && seen.every((wire, i) => wire === offers[i]), 'each menu showed the Switch the pool\'s Pokémon of the moment');
    check(traded?.sealed === true && engine.commits === 1 && fake.swaps === 1, 'the swap went through on both sides');
    check(events.findIndex((e) => e.event === 'trading') < events.indexOf(traded) && events.some((e) => e.event === 'trading'), 'with the start of the trade announced first');
    check(toHex(traded.got) === offers[0] && pk3.parse(traded.gave).nickname === 'HOSTMON', 'the Switch got the pool\'s Pokémon and gave its own');
    const kept = fake.mons.find((record) => toHex(record.subarray(0, 100)) === toHex(hostParty[0]));
    check(Boolean(kept) && kept[136] === 1 && toHex(kept.subarray(138, 141)) === '010203', 'the pool holds the Switch\'s Pokémon, with its game and gift ribbons');
    check(fake.connections === 3, `each time the menu was left, a new connection brought a different Pokémon (${fake.connections})`);
    check(!events.some((e) => e.event === 'error'), `no error (${events.find((e) => e.event === 'error')?.message})`);
}
{
    // The pool's Pokémon is held back however long the menu stays open, so one cancel on
    // the Switch closes it. A pick made first waits for the offer.
    const fake = new FakePool(poolRecords);
    let waited = false;
    const { events, engine, port } = await visit({ pool: new PoolClient('ws://pool', { Socket: fake.Socket }), script: (leader, context) => {
        const { session, engine } = context;
        arrive(leader).open(hostParty);
        const opened = { at: 0 };
        leader.wait(() => { opened.at ||= performance.now(); return performance.now() - opened.at > 600; });
        leader.wait(() => { waited = engine.state === 1 && !engine.offering; session.offerSlot(0); return true; });
        leader.wait(() => engine.state === 2);
        leader.command(LINK.SET_MONS, 0);
        leader.wait(() => leader.lastCommand === LINK.INIT_BLOCK);
        leader.command(LINK.INIT_BLOCK).command(LINK.START).command(LINK.READY_FINISH).command(LINK.CONFIRM_FINISH);
        leader.wait(() => engine.commits === 1);
        leader.open(hostParty);
        leader.wait(() => { opened.again ||= performance.now(); return performance.now() - opened.again > 600; });
        cancelUnoffered(leader, engine);
    } });
    check(waited && engine.commits === 1, 'nothing is offered until the page says so, and the offer then goes straight through');
    const readies = port.leader.blocks.filter((block) => block.length === 24 && (block[0] | (block[1] << 8)) === LINK.READY).length;
    check(engine.done && readies === 1 && events.filter((e) => e.event === 'offer').length === 1, `the reopened menu has nothing on offer, so one cancel closes it (${readies})`);
}
{
    // A pool with nothing to give: there is no party to show the Switch, so the visit ends.
    const fake = new FakePool([]);
    const { events, engine } = await visit({ pool: new PoolClient('ws://pool', { Socket: fake.Socket }), script: (leader) => { arrive(leader); leader.wait(() => false); } });
    const error = events.find((e) => e.event === 'error')?.message ?? '';
    check(error.includes('no Pokémon') && engine.sentParty === 0, `an empty pool ends the visit and says why (${error})`);
}
{
    // Mail travels with the Pokémon that holds it, both ways.
    const holding = (wire, index) => {
        const pk = pk3.parse(wire);
        w16(pk.data, 0x22, 121);
        pk.refreshChecksum();
        return pk3.toWire(pk.data, index);
    };
    const letter = (first) => Uint8Array.from({ length: 36 }, (_, i) => first + i);
    const fake = new FakePool([poolRecord(holding(poolRecords[0].subarray(0, 100), 4), { mail: letter(0x20) })]);
    const theirs = [holding(hostParty[0], 3), hostParty[1]];
    const switchMail = new Uint8Array(216);
    switchMail.set(letter(0x60), 3 * 36);
    let shown = null;
    await visit({ pool: new PoolClient('ws://pool', { Socket: fake.Socket }), script: (leader, context) => {
        arrive(leader).open(theirs, { mail: switchMail });
        leader.wait(() => { shown = { mon: leader.blocks.filter((b) => b.length === 204).at(-3), mail: leader.blocks.findLast((b) => b.length === 228) }; return true; });
        tradeFor(leader, context, 0);
        leader.open(theirs, { mail: switchMail });
        cancelUnoffered(leader, context.engine);
    } });
    check(shown?.mon[0x55] === 0 && toHex(shown.mail.subarray(0, 36)) === toHex(letter(0x20)), 'the pool\'s Pokémon brings its mail to the Switch');
    check(fake.swaps === 1 && toHex(fake.mons[0].subarray(100, 136)) === toHex(letter(0x60)), 'and the Switch\'s goes into the pool with its own');
}
{
    // The pool going away before a swap is sealed: the Switch's Pokémon is handed to the
    // page to keep, and a new connection brings the next one.
    const fake = new FakePool(poolRecords);
    let tripped = false;
    const Flaky = class extends fake.Socket {
        send(packet) {
            const tag = String.fromCharCode(...new Uint8Array(packet).subarray(0, 5));
            if (tag === 'SS3S4' && !tripped) { tripped = true; this.close(); this.onclose?.(); return; }
            super.send(packet);
        }
    };
    const seen = [];
    const { events, engine } = await visit({ pool: new PoolClient('ws://pool', { Socket: Flaky }), script: (leader, context) => {
        arrive(leader).open(hostParty);
        tradeFor(leader, context, 0);
        leader.open(hostParty);
        leader.wait(() => { seen.push(offeredTo(leader)); return true; });
        cancelUnoffered(leader, context.engine);
    } });
    const offers = events.filter((e) => e.event === 'pool_mon').map((e) => toHex(e.pk3));
    const traded = events.find((e) => e.event === 'pool_traded');
    check(tripped && traded?.sealed === false && pk3.parse(traded.gave).nickname === 'HOSTMON', 'an unsealed swap hands the Switch\'s Pokémon to the page');
    check(engine.commits === 1 && fake.swaps === 0 && offers[1] !== offers[0] && seen[0] === offers[1], 'and the reopened menu shows a Pokémon from a new connection');
}
{
    // A Pokémon the pool will not take: the trade is called off at the confirmation.
    const fake = new FakePool(poolRecords, { refuses: () => true });
    const { events, engine } = await visit({ pool: new PoolClient('ws://pool', { Socket: fake.Socket }), script: (leader, { session, engine }) => {
        arrive(leader).open(hostParty);
        leader.wait(() => engine.menuComplete).wait(() => { session.offerSlot(0); return true; }).wait(() => engine.state === 2);
        leader.command(LINK.SET_MONS, 0);
        leader.wait(() => leader.lastCommand === LINK.READY_CANCEL);
        leader.command(LINK.PLAYER_CANCEL);
        leader.wait(() => engine.state === 1);
        cancelUnoffered(leader, engine);
    } });
    check(engine.commits === 0 && fake.swaps === 0, 'nothing was traded');
    check(events.some((e) => e.event === 'phase' && e.message.includes('will not take')), 'the page said the pool turned it down');
}

console.log(failures ? `${failures} of ${checks} FAILED` : `session: ${checks} checks pass`);
process.exit(failures ? 1 : 0);
