// PokeDump: intercambio con la Switch. La página hace de segundo jugador en la sala de
// intercambio de Rojo Fuego / Verde Hoja: ofrece Pokémon de un .sav (por ejemplo el de una
// portátil de emulación) o de ficheros .pk3, y guarda como .pk3 lo que llega de la Switch.
// El motor (trade/) viene de GB-Link Switch LDN (AGPL-3.0). A diferencia del volcado, esto SÍ
// cambia la partida de la Switch: el juego guarda lo que recibe.

import { SAVE_BYTES } from './dump/gen3.js';
import { readSaveMons, SaveError } from './dump/savemons.js';
import { Party, describe as describeMon } from './trade/party.js';
import { parse as parsePk3 } from './trade/pk3.js';
import { CancelledError, TradeSession } from './trade/session.js';

const $ = (id) => document.getElementById(id);
const describeError = (error) => error?.message || String(error);

// api: { esp(), keysOk(), blocked() -> motivo o null, log(origen, texto), changed() }
export function initTrade(api) {
    const state = {
        party: new Party(),
        pool: [],              // Pokémon disponibles: { label, pk }
        source: '',
        session: null, stop: null,
        phase: '', tone: '', declining: false, trading: false, menuOpen: false,
        opponent: null, offered: -1, trades: 0, note: '',
        received: [],          // { pk, name }
    };
    state.party.load();
    state.party.selected = Math.max(0, state.party.slots.findIndex(Boolean));

    const running = () => Boolean(state.session);

    function blocker() {
        const esp = api.esp();
        if (!esp?.attached) return 'Primero conecta la placa (paso 1).';
        if (!esp.info) return 'Primero instala el firmware (paso 1).';
        if (!api.keysOk()) return 'A la placa le faltan las claves (paso 1).';
        const other = api.blocked();
        if (other) return other;
        if (state.party.occupied < 2) return 'Elige al menos dos Pokémon para el equipo: el juego exige dos.';
        if (!state.party.slots[state.party.selected]) return 'Elige cuál de ellos ofreces.';
        return null;
    }

    // ---------------------------------------------------------- ficheros

    async function onFiles(files) {
        if (running()) return;
        state.note = '';
        for (const file of files) {
            try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                if (bytes.length === SAVE_BYTES) loadSave(bytes, file.name);
                else addToFirstFree(parsePk3(bytes), file.name.replace(/\.pk3$/i, ''));
            } catch (error) {
                state.note = error instanceof SaveError ? error.message : `${file.name}: ${describeError(error)}`;
            }
        }
        render();
    }

    function loadSave(bytes, name) {
        const mons = readSaveMons(bytes);
        const pool = [];
        for (const m of mons.party) pool.push({ label: 'Equipo', pk: tryParse(m.bytes) });
        for (const m of mons.boxes) pool.push({ label: `Caja ${m.box} · ${m.slot}`, pk: tryParse(m.bytes) });
        state.pool = pool.filter((p) => p.pk);
        state.source = `${name} (${mons.trainer.name})`;
        const skipped = pool.length - state.pool.length;
        state.note = `Guardado de ${mons.trainer.name} leído: ${state.pool.length} Pokémon${skipped ? ` (${skipped} no válido${skipped > 1 ? 's' : ''} omitido${skipped > 1 ? 's' : ''})` : ''}.`;
        api.log('web', `leído ${name}: ${state.pool.length} Pokémon`);
    }

    function tryParse(bytes) { try { return parsePk3(bytes); } catch { return null; } }

    function addToFirstFree(pk) {
        const free = state.party.slots.findIndex((s) => !s);
        if (free < 0) { state.note = 'El equipo ya tiene seis Pokémon. Quita alguno antes.'; return; }
        state.party.set(free, pk);
        if (state.party.occupied === 1) state.party.select(free);
    }

    function savePk3(pk) {
        const name = (describeMon(pk).name || pk.speciesName || 'pokemon').replace(/[^\p{L}\p{N}_-]+/gu, '');
        const url = URL.createObjectURL(new Blob([pk.export()], { type: 'application/octet-stream' }));
        const a = Object.assign(document.createElement('a'), { href: url, download: `${name}.pk3` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ---------------------------------------------------------- sesión

    async function start() {
        if (running() || blocker()) return;
        const controller = new AbortController();
        state.stop = controller;
        Object.assign(state, { phase: 'Pidiendo a la placa su enlace del adaptador…', tone: '', declining: false, opponent: null, menuOpen: false, trading: false, trades: 0, offered: -1 });
        const session = new TradeSession({ device: api.esp(), party: state.party.export(), selected: state.party.selected, emit: onEvent });
        state.session = session;
        render();
        try {
            await session.run(controller.signal);
            state.phase = state.trades === 0 ? 'Terminado sin intercambiar.' : `Terminado. ${state.trades === 1 ? 'Ha cruzado un Pokémon' : `Han cruzado ${state.trades} Pokémon`}.`;
            state.tone = state.trades > 0 ? 'good' : '';
        } catch (error) {
            const stopped = error instanceof CancelledError;
            state.phase = stopped ? 'Desconectado.' : !api.esp() ? 'La placa dejó de contestar durante el intercambio.' : describeError(error);
            state.tone = stopped ? '' : 'bad';
            if (!stopped) api.log('trade', describeError(error));
        } finally {
            state.session = null; state.stop = null; state.opponent = null; state.menuOpen = state.trading = state.declining = false; state.offered = -1;
            api.changed();
            render();
        }
    }

    function onEvent(event) {
        switch (event.event) {
            case 'phase':
                state.phase = event.message;
                state.tone = event.tone || (state.opponent ? 'good' : '');
                break;
            case 'log': api.log('trade', event.message); return;
            case 'opponent_party':
                state.opponent = { name: event.name, party: event.party.map((b) => (b ? tryParse(b) : null)) };
                state.tone = 'good';
                break;
            case 'menu':
                // No se ofrece nada hasta que el jugador elige, para que la Switch pueda salir del menú con una sola cancelación.
                state.menuOpen = true;
                state.phase = `El menú de intercambio está abierto${state.trades ? ' otra vez' : ''}. Pulsa un Pokémon del equipo para ofrecerlo.`;
                state.tone = 'good';
                break;
            case 'offer': {
                const pk = state.party.slots[event.slot];
                if (event.taken && pk) { state.offered = event.slot; state.phase = `Ofreciendo a ${describeMon(pk).name}. Elige uno en la Switch.`; state.tone = 'good'; }
                else if (!state.opponent) state.phase = 'Siéntate primero en la mesa de intercambio de la Switch.';
                break;
            }
            case 'trading': state.trading = true; state.phase = 'El intercambio está en marcha.'; state.tone = 'good'; break;
            case 'declining': state.declining = event.value; if (event.value) state.offered = -1; break;
            case 'room':
                state.menuOpen = state.trading = false; state.opponent = null; state.offered = -1; state.declining = false;
                state.phase = 'De vuelta en la sala. Siéntate otra vez en la mesa para seguir, o sal de la sala para terminar.';
                state.tone = '';
                break;
            case 'received':
                try {
                    state.menuOpen = state.trading = false;
                    const gone = state.party.slots[event.slot];
                    state.party.receive(event.slot, event.pk3);
                    const got = state.party.slots[event.slot];
                    state.trades++; state.offered = -1; state.opponent = null;
                    state.received.push({ pk: got, name: describeMon(got).name, gave: gone ? describeMon(gone).name : '' });
                    state.phase = `Intercambiado. ${describeMon(got).name} está ahora en el hueco ${event.slot + 1}.`;
                    state.tone = 'good';
                } catch (error) { state.phase = describeError(error); state.tone = 'bad'; }
                break;
            default: break;
        }
        render();
    }

    // ---------------------------------------------------------- pintar

    const mon = (pk) => { const d = describeMon(pk); return `${d.shiny ? '★ ' : ''}${d.name}${d.name !== d.kind ? ` (${d.kind})` : ''} · ${d.level}${d.gender ? ` ${d.gender}` : ''}`.trim(); };

    function button(text, onclick, { quiet = true, disabled = false } = {}) {
        const b = document.createElement('button');
        b.textContent = text; b.className = quiet ? 'quiet small' : 'small'; b.disabled = disabled; b.onclick = onclick;
        return b;
    }

    function render() {
        const run = running(), why = blocker();
        const text = run ? state.phase : why ?? (state.phase || 'Todo listo. Pulsa Conectar y sigue los pasos de abajo.');
        const status = $('trade-status');
        status.textContent = text;
        status.className = `status ${run ? state.tone : why ? '' : state.tone}`.trim();
        $('trade-dot').className = `dot ${run ? state.tone || 'busy' : ''}`.trim();
        $('trade-connect').hidden = run;
        $('trade-connect').disabled = Boolean(why);
        $('trade-decline').hidden = !run || state.declining || !state.opponent;
        $('trade-decline').disabled = state.trading;
        $('trade-stop').hidden = !run;
        $('trade-note').textContent = state.note;

        const slots = $('trade-slots');
        slots.replaceChildren(...state.party.slots.map((pk, i) => {
            const li = document.createElement('li');
            li.className = `slot${i === state.party.selected && pk ? ' chosen' : ''}${i === state.offered ? ' offered' : ''}`;
            const label = document.createElement('span');
            label.className = 'slot-name';
            label.textContent = pk ? mon(pk) : 'vacío';
            if (pk) label.onclick = () => selectSlot(i);
            li.append(`${i + 1}. `, label);
            if (pk) {
                li.append(button('↓ .pk3', () => savePk3(pk)));
                li.append(button('Quitar', () => { state.party.set(i, null); render(); }, { disabled: run }));
            }
            return li;
        }));

        const pool = $('trade-pool');
        $('trade-pool-box').hidden = !state.pool.length;
        $('trade-pool-title').textContent = state.source ? `Pokémon de ${state.source}` : '';
        const filter = $('trade-filter').value.trim().toLowerCase();
        pool.replaceChildren(...state.pool.filter((p) => !filter || `${mon(p.pk)} ${p.label}`.toLowerCase().includes(filter)).slice(0, 200).map((p) => {
            const li = document.createElement('li');
            li.append(`${p.label}: ${mon(p.pk)} `);
            li.append(button('Añadir', () => { addToFirstFree(p.pk); render(); }, { disabled: run || state.party.occupied >= 6 }));
            return li;
        }));

        $('trade-opponent').hidden = !state.opponent;
        if (state.opponent) $('trade-opponent').textContent = `En la Switch (${state.opponent.name || 'tu entrenador'}): ${state.opponent.party.filter(Boolean).map((p) => describeMon(p).name).join(', ') || 'sin datos'}`;

        $('trade-received-box').hidden = !state.received.length;
        $('trade-received').replaceChildren(...state.received.map((r) => {
            const li = document.createElement('li');
            li.append(`${r.name}${r.gave ? ` (a cambio de ${r.gave})` : ''} `);
            li.append(button('Descargar .pk3', () => savePk3(r.pk)));
            return li;
        }));
        for (const id of ['trade-clear']) $(id).disabled = run;
        $('trade-file').disabled = run;
    }

    function selectSlot(i) {
        if (!state.party.slots[i]) return;
        state.party.select(i);
        if (running()) state.session.offerSlot(i);
        render();
    }

    // ---------------------------------------------------------- enlazar con la página

    $('trade-connect').onclick = start;
    $('trade-stop').onclick = () => state.stop?.abort();
    $('trade-decline').onclick = () => state.session?.declineTrade();
    $('trade-clear').onclick = () => { for (let i = 0; i < 6; i++) state.party.slots[i] = null; state.party.save(); state.offered = -1; render(); };
    $('trade-filter').oninput = render;
    const input = $('trade-file'), drop = $('trade-drop');
    input.onchange = () => { onFiles([...input.files]); input.value = ''; };
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => onFiles([...e.dataTransfer.files]));
    window.addEventListener('beforeunload', (e) => { if (running()) { e.preventDefault(); e.returnValue = ''; } });

    render();
    return { render, running, stop: () => state.stop?.abort(), state };
}
