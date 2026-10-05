// The game on the Switch, as the board's bridge relays it: the link leader's side of a
// trade. The board does the wireless, so nothing here needs Pia or a key.

import { join, u16, w16 } from '../js/trade/bytes.js';
import { linkCommand } from '../js/trade/engine.js';
import { playerBlock } from '../js/trade/rfu.js';

export function namingPayload() { return stateWord(2); }

function stateWord(state) {
    const f = state << 14;
    return Uint8Array.of(f & 0xff, (f >> 8) & 0xff, (f >> 16) & 0xff);
}

function slot(words) {
    const out = new Uint8Array(14);
    words.forEach((word, i) => w16(out, i * 2, word));
    return out;
}

// The leader's side of the trade: a script of steps, each waiting for the page to answer
// before the next begins, as the games pace each other. Its commands and its echo of
// ours fill the frame's five slots.
export class Leader {
    constructor() {
        this.queue = [];
        this.step = null;
        this.sending = null;
        this.echo = new Uint8Array(14);
        this.incoming = { count: 0, mask: 0, data: null };
        this.mirror = null;
        this.blocks = [];          // every block the page has sent, whole
        this.keyCount = 0;
        this.rounds = 0;           // standby rounds the page has started
        this.lastRound = -1;
        this.blocksIn = 0;
        this.requests = 0;
        this.blocksOut = 0;
    }

    get idle() { return this.queue.length === 0 && !this.step && !this.sending; }

    request(type = 1) { this.queue.push({ request: type }); return this; }
    block(data) { this.queue.push({ block: data }); return this; }
    command(value, cursor = 0) { return this.block(linkCommand(value, cursor)); }
    wait(until) { this.queue.push({ until, wait: true }); return this; }

    // Link-up: the two games introduce themselves.
    greet() {
        const hello = new Uint8Array(204);
        hello.set(playerBlock());
        return this.request().block(hello);
    }

    // Walking up to the table and sitting down, which is what starts a trade menu. The
    // page answers with its own seat and two standby rounds, mirrored here as they come.
    sit() {
        let from = -1;
        return this.keys(17, 4).keys(22, 1).wait(() => {
            if (from < 0) from = this.rounds;
            return this.rounds >= from + 2 && !this.mirror;
        });
    }

    keys(code, frames = 1) { this.queue.push({ keys: code, frames }); return this; }

    // The menu opening: the parties two Pokémon at a time, then mail, then gift ribbons.
    open(party, { mail = null, ribbons = null } = {}) {
        for (let i = 0; i < 3; i++) {
            const data = new Uint8Array(204);
            for (let k = 0; k < 2; k++) if (party[i * 2 + k]) data.set(party[i * 2 + k], k * 100);
            this.request().block(data);
        }
        const letters = new Uint8Array(228);
        if (mail) letters.set(mail);
        this.request(3).block(letters);
        const gifts = new Uint8Array(48);
        if (ribbons) gifts.set(ribbons);
        return this.request(4).block(gifts);
    }

    // The last trade-menu command the page sent, as its 16-bit value.
    get lastCommand() {
        const block = this.blocks.findLast((b) => b.length === 24);
        return block ? u16(block) : null;
    }

    // What the page sent last: blocks are followed as they arrive, so a step that is
    // waiting for one knows when it has it.
    observe(words) {
        this.echo = words ?? this.echo;
        if (!words) return;
        const word = u16(words), op = word & 0xff00;
        // The standby rounds the games run between steps are answered in kind.
        if (op === 0x6600 || op === 0x5f00) {
            this.mirror = [op, u16(words, 2)];
            if (op === 0x6600 && u16(words, 2) !== this.lastRound) { this.lastRound = u16(words, 2); this.rounds++; }
        }
        if (op === 0x8800) this.incoming = { count: u16(words, 2), mask: 0, data: new Uint8Array(u16(words, 2) * 12) };
        else if (op === 0x8900 && this.incoming.count) {
            const index = word & 31;
            this.incoming.data.set(words.subarray(2, 14), index * 12);
            this.incoming.mask |= 1 << index;
            if (this.incoming.mask === ((1 << this.incoming.count) - 1) >>> 0) {
                this.blocksIn++;
                this.blocks.push(this.incoming.data);
                this.incoming = { count: 0, mask: 0, data: null };
            }
        }
    }

    next(child) {
        this.observe(child);
        if (this.step?.until()) this.step = null;
        if (!this.step && !this.sending && this.queue.length > 0) {
            const step = this.queue.shift();
            if (step.block) this.sending = { data: step.block, count: Math.max(1, Math.ceil(step.block.length / 12)), index: -1 };
            else if (step.request) {
                this.requests++;
                const wanted = this.blocksIn + 1;
                // Asked for again until the page's block arrives, as the board does for a
                // request that goes unanswered.
                this.step = { until: () => this.blocksIn >= wanted, emit: () => [0xa100, step.request, 0, 0, 0, 0, 0] };
            } else if (step.keys !== undefined) {
                let left = step.frames;
                this.step = { until: () => left <= 0, emit: () => { left--; this.keyCount = (this.keyCount + 1) & 255; return [0xbe00, (this.keyCount << 8) | step.keys, 0, 0, 0, 0, 0]; } };
            } else this.step = step;
        }
        if (this.sending) {
            const send = this.sending;
            if (send.index < 0) { send.index = 0; return this.frame([0x8800, send.count, 0x81, 0, 0, 0, 0]); }
            const piece = new Uint8Array(12);
            piece.set(send.data.subarray(send.index * 12, Math.min(send.data.length, (send.index + 1) * 12)));
            const words = [0x8900 | send.index, u16(piece), u16(piece, 2), u16(piece, 4), u16(piece, 6), u16(piece, 8), u16(piece, 10)];
            if (++send.index >= send.count) { this.sending = null; this.blocksOut++; }
            return this.frame(words);
        }
        if (this.step?.emit) return this.frame(this.step.emit());
        if (this.mirror) { const [op, count] = this.mirror; this.mirror = null; return this.frame([op, count, 0, 0, 0, 0, 0]); }
        return this.frame([0, 0, 0, 0, 0, 0, 0]);
    }

    frame(words) { return join(stateWord(4), slot(words), this.echo, new Uint8Array(42)); }
}

