// A stand-in for the trade pool's server, following serving.py of
// PokemonGB_Online_Trades_and_Battles message for message: a Pokémon per connection, the
// one given for it, two accept rounds and seven success rounds, each counted, with a
// request to send again when an earlier step is missing.

import { Pk3 } from '../js/trade/pk3.js';

const ACCEPT = [0xa20000, 0xb20000];
const DECLINE = [0xa10000, 0xb10000];
const SUCCESS = [0x900000, 0x910000, 0x920000, 0x930000, 0x940000, 0x950000, 0x9c0000];
const FAILURE = 0x9f0000;
const ORDER = ['P3SO', 'A3S1', 'A3S2', 'S3S1', 'S3S2', 'S3S3', 'S3S4', 'S3S5', 'S3S6', 'S3S7'];
const FAULT = Symbol('fault');
const next = (id) => (id + 1) & 0xff;
const threeBytes = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];

export class FakePool {
    // records: the pool's Pokémon, 149 bytes each. refuses(record) makes the pool turn one down.
    constructor(records, { refuses = () => false } = {}) {
        this.mons = records.map((record) => record.slice());
        this.inUse = new Set();
        this.refuses = refuses;
        this.cursor = 0;
        this.connections = 0;
        this.swaps = 0;
        const pool = this;
        this.Socket = class {
            constructor() {
                this.readyState = 0;
                this.state = pool.open();
                setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
            }
            send(packet) {
                const reply = pool.handle(this.state, new Uint8Array(packet));
                if (reply === FAULT) setTimeout(() => { if (this.readyState === 1) { this.close(); this.onclose?.(); } }, 0);
                else if (reply) setTimeout(() => { if (this.readyState === 1) this.onmessage?.({ data: Uint8Array.from(reply).buffer }); }, 0);
            }
            close() {
                this.readyState = 3;
                if (this.state.index !== null) pool.inUse.delete(this.state.index);
            }
        };
    }

    open() {
        this.connections++;
        return { id: Math.floor(Math.random() * 256), index: null, clear: true, mon: null, accepted: [null, null], success: Array(7).fill(null),
            lastAccepted: [null, null], lastSuccess: Array(7).fill(null), canContinue: true };
    }

    pick() {
        for (let i = 0; i < this.mons.length; i++) {
            const index = (this.cursor + i) % this.mons.length;
            if (!this.inUse.has(index)) { this.cursor = index + 1; this.inUse.add(index); return index; }
        }
        return null;
    }

    handle(s, packet) {
        const kind = String.fromCharCode(packet[0]), tag = String.fromCharCode(...packet.subarray(1, 5));
        if (kind === 'S') { this.store(s, tag, packet.subarray(7, 7 + ((packet[5] << 8) | packet[6]))); return null; }
        if (kind !== 'G') return null;
        if (tag === 'P3SI') return this.offer(s);
        const step = ORDER.indexOf(tag);
        return step >= 1 ? this.answer(s, step) : null;
    }

    store(s, tag, data) {
        const step = ORDER.indexOf(tag);
        if (step < 0 || s.index === null) return;
        if (step === 0) {
            const record = data.length > 1 ? data.slice(1) : null;
            s.mon = [data[0], record && !this.refuses(record) ? record : null];
            s.accepted = [null, null];
            s.success = Array(7).fill(null);
            return;
        }
        if (!s.mon) return;
        const value = data[1] | (data[2] << 8) | (data[3] << 16);
        if (step <= 2) {
            if (step === 2 && !s.accepted[0]) return;
            if (step === 1) s.accepted[1] = null;
            s.success = Array(7).fill(null);
            s.accepted[step - 1] = [data[0], value];
        } else {
            const index = step - 3;
            if (s.accepted.includes(null) || s.success.slice(0, index).includes(null)) return;
            for (let i = index + 1; i < 7; i++) s.success[i] = null;
            s.success[index] = [data[0], value];
        }
    }

    offer(s) {
        if (s.index === null || s.clear) {
            s.mon = null; s.accepted = [null, null]; s.success = Array(7).fill(null);
            s.id = next(s.id);
            if (s.index !== null) this.inUse.delete(s.index);
            s.index = this.pick();
            s.clear = false;
        }
        if (s.index === null) return send('P3SI', [s.id, 0x7f]);
        return send('P3SI', [s.id, ...this.mons[s.index]]);
    }

    // What was sent, in the order it has to have come, each counted one past the last.
    missing(s, upTo) {
        const chain = [s.mon, ...s.accepted, ...s.success, null];
        for (let i = 1; i <= upTo; i++)
            if (!chain[i - 1] || (chain[i] && chain[i][0] !== next(chain[i - 1][0]))) return ORDER[i - 1];
        return null;
    }

    answer(s, step) {
        if (s.index === null) return null;
        const again = this.missing(s, step);
        if (again) return [0x47, ...again].map((c) => (typeof c === 'string' ? c.charCodeAt(0) : c));
        // Asked about a message that never came, the server fails and the connection
        // goes with it. A WebSocket loses nothing, so it takes a client asking early.
        if (!(step <= 2 ? s.accepted[step - 1] : s.success[step - 3])) return FAULT;
        const theirs = s.mon[1] ? new Pk3(s.mon[1].subarray(0, 100)) : null;
        const ours = new Pk3(this.mons[s.index].subarray(0, 100));
        let ok = s.canContinue && Boolean(theirs);
        const accepts = step <= 2 ? step : 2;
        for (let i = 0; ok && i < accepts; i++)
            ok = (s.accepted[i][1] & 0xff0000) === ACCEPT[i] && (s.accepted[i][1] & 0xffff) === theirs.speciesInternal;
        if (step <= 2) {
            const index = step - 1;
            if (s.lastAccepted[index] !== s.accepted[index][0]) { s.lastAccepted[index] = s.accepted[index][0]; s.id = next(s.id); }
            return send(ORDER[step], [s.id, ...threeBytes(ok ? ACCEPT[index] | ours.speciesInternal : DECLINE[index])]);
        }
        const index = step - 3;
        if (s.lastSuccess[index] !== s.success[index][0]) { s.lastSuccess[index] = s.success[index][0]; s.id = next(s.id); }
        const expected = (i, out, into) => [out.speciesInternal, out.pid & 0xffff, out.pid >>> 16, into.speciesInternal, into.pid & 0xffff, into.pid >>> 16, 0][i];
        for (let i = 0; ok && i <= index; i++)
            ok = (s.success[i][1] & 0xff0000) === SUCCESS[i] && (s.success[i][1] & 0xffff) === expected(i, theirs, ours);
        if (!ok) { s.canContinue = false; return send(ORDER[step], [s.id, ...threeBytes(FAILURE)]); }
        const reply = send(ORDER[step], [s.id, ...threeBytes(SUCCESS[index] | expected(index, ours, theirs))]);
        if (index === 6) { this.mons[s.index] = s.mon[1]; this.swaps++; s.clear = true; }
        return reply;
    }
}

function send(tag, data) {
    return [0x53, ...[...tag].map((c) => c.charCodeAt(0)), data.length >> 8, data.length & 0xff, ...data];
}
