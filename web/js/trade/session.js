// Una visita a la sala de intercambio de la Switch (GB-Link Switch LDN, AGPL-3.0, simplificado:
// sin el "pool" de Wonder Trade). La página toma el enlace con el adaptador de la placa
// (LDN_ADAPTER host) y hace de segundo juego; la placa busca la sala, entra y descifra.
//
// Se ofrece un Pokémon del equipo de seis que elige el jugador. Lo que llega de la Switch se
// entrega con onCommitted y ocupa el hueco del que salió.

import { ConnectionError } from './bytes.js';
import { GB_CHANNEL, GbFrameParser } from '../wire.js';
import { FrameReader, toGbFrames } from './adapter.js';
import { AdapterLink } from './link.js';
import { TradeEngine } from './engine.js';

const SILENT_S = 30;          // silencio máximo de la Switch estando conectados
const POLL_MS = 1000;         // cada cuánto se pregunta a la placa
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CancelledError extends Error {
    constructor() { super('Cancelado'); this.name = 'CancelledError'; }
}

export class TradeSession {
    // party: seis PK3 (80 o 100 bytes) o null. selected: hueco que se ofrece al empezar.
    constructor({ device, party, selected = 0, emit }) {
        this.device = device;
        this.emit = emit;
        this.party = party;
        this.selected = selected;
        this.engine = null;
        this.declineRequested = false;
        this.offerRequested = -1;
        this.failure = null;
    }

    declineTrade() { this.declineRequested = true; }
    offerSlot(slot) { this.offerRequested = slot; }

    phase(message, tone = '') { this.emit({ event: 'phase', message, tone }); }
    log(message) { this.emit({ event: 'log', message }); }

    async run(signal) {
        const device = this.device;
        const engine = this.engine = new TradeEngine(this.party, this.selected);
        engine.onLog = (message) => this.log(message);
        engine.onNotice = (message) => this.phase(message);
        engine.onDecliningChanged = (value) => this.emit({ event: 'declining', value });
        engine.onMenuOpen = () => this.emit({ event: 'menu' });
        engine.onTradeStart = () => this.emit({ event: 'trading' });
        engine.onOpponentParty = (party, name) => this.emit({ event: 'opponent_party', name, party });
        engine.onRoom = () => this.emit({ event: 'room', traded: engine.commits });
        engine.onCommitted = (data, slot) => this.emit({ event: 'received', slot, pk3: data });

        const link = new AdapterLink({ engine, send: (frame) => device.sendAdapter(toGbFrames(frame)) });
        link.onLog = (message) => this.log(message);
        const gb = new GbFrameParser(512);
        const reader = new FrameReader();
        let taken = false;
        try {
            const reply = await device.command('LDN_ADAPTER host', 3000);
            if (!reply.includes('LDN_ADAPTER host')) throw new ConnectionError('La placa no cedió su enlace del adaptador. Instala el firmware en el paso 1 y reinténtalo.');
            taken = true;
            this.emit({ event: 'device', model: device.info?.chip, firmware: device.info?.version });
            // Lo mueven las tramas que llegan; no hay reloj propio.
            device.onAdapterFrame = (payload) => {
                try {
                    for (const frame of gb.push(payload)) {
                        if (frame.channel !== GB_CHANNEL.DATA) continue;
                        for (const rfu of reader.push(frame.payload)) link.feed(rfu);
                    }
                } catch (error) { this.failure ??= error; }
            };
            this.phase('Esperando a que la placa encuentre la sala');
            await this.pump(link, signal);
        } finally {
            device.onAdapterFrame = null;
            if (taken) {
                try { link.leave(); } catch {}
                // Devuelve el enlace al puente de la placa. Falla si la placa ya se está
                // reiniciando porque la Switch salió de la sala.
                try { await device.command('LDN_ADAPTER uart', 2000); } catch (error) { this.log(`La placa no recuperó su enlace del adaptador: ${error.message}`); }
            }
        }
    }

    async pump(link, signal) {
        const device = this.device, engine = this.engine;
        const started = performance.now();
        const seconds = () => (performance.now() - started) / 1000;
        let nextPoll = 0, lastFrames = 0, lastMoved = 0, announced = '';
        while (!link.disconnected) {
            if (signal?.aborted) throw new CancelledError();
            if (this.failure) throw this.failure;
            // La placa se reinicia cuando la sala termina.
            if (!device.attached) { this.log('La placa se está reiniciando, que es lo que hace cuando termina la sala.'); break; }
            if (this.declineRequested) { this.declineRequested = false; engine.decline(); }
            if (this.offerRequested >= 0) {
                const slot = this.offerRequested;
                this.offerRequested = -1;
                this.emit({ event: 'offer', slot, taken: engine.offer(slot) });
            }
            const now = seconds();
            if (link.hostFrames !== lastFrames) { lastFrames = link.hostFrames; lastMoved = now; }
            if (link.connected && lastMoved > 0 && now - lastMoved > SILENT_S)
                throw new ConnectionError(`La Switch dejó de contestar durante ${SILENT_S} s y el enlace se cerró. Sal de la sala en la Switch y vuelve a conectar.`);
            if (now >= nextPoll && !link.connected) {
                nextPoll = now + POLL_MS / 1000;
                const line = await this.describe(link);
                if (line && line !== announced) { announced = line; this.phase(line); }
            }
            await sleep(30);
        }
    }

    // Línea de estado de la placa hasta que el enlace conecta.
    async describe(link) {
        let status = null;
        try { status = await this.device.bridgeStatus(); } catch { return null; }
        if (!status) return null;
        if (status.state === 'scan') {
            if (this.device.hearsUnreadableRoom) return 'La placa oye una sala de la Switch pero no puede leerla: las claves que tiene no coinciden. Cámbialas en el paso 1 por un prod.keys de tu propia consola.';
            return 'La placa busca una sala de Rojo Fuego o Verde Hoja. En la Switch, en el Centro de Intercambio, hazte líder del grupo.';
        }
        if (status.state === 'stopped' || status.state === 'idle') return 'La placa no está buscando sala. Desenchúfala y vuelve a conectarla.';
        if (status.state !== 'run') return 'La placa se está uniendo a la sala de la Switch.';
        return link.room === null ? 'En la sala. Esperando a que te ofrezcan el intercambio.' : 'En la sala, uniéndose al intercambio.';
    }
}
