// Visitas completas a la sala de intercambio, sin hardware: el código de sesión de la página
// contra una placa simulada que hace de Switch (de GB-Link Switch LDN, AGPL-3.0).
// node --test tests/trade/session.test.mjs

import { readFileSync } from 'node:fs';
import { fromHex, toHex, w16 } from '../../web/js/trade/bytes.js';
import { TradeSession } from '../../web/js/trade/session.js';
import { LINK } from '../../web/js/trade/engine.js';
import { EspDevice } from '../../web/js/esp.js';
import { FakeBoardPort } from './fake-port.mjs';

const vectors = JSON.parse(readFileSync(new URL('./trade-vectors.json', import.meta.url)));
const pk3 = await import('../../web/js/trade/pk3.js');
let failures = 0, checks = 0;
function check(ok, what) {
    checks++;
    if (!ok) { failures++; console.log('FAIL', what); }
}

const hostParty = vectors.engine.hostParty.map(fromHex);
const ownParty = () => vectors.engine.party.map((h) => (h ? fromHex(h) : null));

// script(leader, { session, port, engine }) plays the Switch. The engine exists once the
// session has started, which the script's steps run after.
async function visit({ script }) {
    const port = new FakeBoardPort({ tickMs: 4 });
    const board = new EspDevice();
    await board.open(port);
    const events = [];
    const session = new TradeSession({ device: board, party: ownParty(), selected: 1, emit: (event) => events.push(event) });
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

if (failures) { console.log(`${failures} de ${checks} comprobaciones fallan`); process.exit(1); }
console.log(`${checks} comprobaciones de intercambio correctas`);
