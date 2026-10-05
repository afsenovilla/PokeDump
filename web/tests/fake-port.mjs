// A stand-in board behind a stand-in serial port: the firmware's console byte for byte,
// and the bridge's adapter link with the Switch's game behind it. Enough to run the
// page's trade card without hardware, in Node or in the browser
// (see web/README.md for driving the real page with it).

import { KIND, FrameDecoder, GB_CHANNEL, GbFrameParser, buildFrame, buildGbFrame } from '../js/wire.js';
import { b32, join, u32, wb32 } from '../js/trade/bytes.js';
import { FrameReader, RFU, hostPayload } from '../js/trade/adapter.js';
import { Leader, namingPayload } from './fake-switch.mjs';

const BANNER = 'rst:0x1 (POWERON_RESET)\r\nLDN_READY chip=esp32s3 transport=USB Serial/JTAG heap=200000\n';
// The board offers one room per union-room activity: trade, single battle, double battle.
const GROUPS = [{ activity: 4, devid: 0x1111 }, { activity: 1, devid: 0x2222 }, { activity: 2, devid: 0x3333 }];
const CHUNK = 64;

export class FakeBoardPort {
    constructor({ hostParty, firmware = '2.0.0', keys = true, tickMs = 16, naming = 12 } = {}) {
        this.firmware = firmware;
        this.hasKeys = keys;
        this.tickMs = tickMs;
        this.naming = naming;
        this.hostParty = hostParty ?? [];
        this.leader = new Leader();
        this.decoder = new FrameDecoder();
        this.gb = new GbFrameParser(512);
        this.reader = new FrameReader();
        this.text = '';
        this.binary = false;
        this.session = 0;
        this.adapter = 'uart';
        this.bridge = true;
        this.state = 'scan';       // what the board's own bridge reports
        this.childDevid = 0;
        this.connected = false;
        this.linkTicks = 0;
        this.child = [];           // the page's 14-byte commands, in order
        this.controller = null;
        this.clock = null;
        this.commands = [];
        this.frames = { out: 0, in: 0 };
        this.onLinkUp = null;
        this.linkUp = false;
    }

    getInfo() { return { usbVendorId: 0x303a, usbProductId: 0x1001 }; }

    async open() {
        this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
        this.writable = new WritableStream({ write: (chunk) => this.feed(chunk) });
        this.emit(new TextEncoder().encode(BANNER));
        this.clock = this.startClock();
    }

    // In a browser the ticks come from a worker, whose timers keep their pace when the
    // tab is not on show; the page's own are slowed to one a second there.
    startClock() {
        if (typeof Worker === 'function' && typeof Blob === 'function' && typeof document !== 'undefined') {
            const worker = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${this.tickMs});`], { type: 'text/javascript' })));
            worker.onmessage = () => this.tick();
            return () => worker.terminate();
        }
        const timer = setInterval(() => this.tick(), this.tickMs);
        return () => clearInterval(timer);
    }

    async setSignals() {}

    async close() {
        this.clock?.();
        this.clock = null;
        try { this.controller?.close(); } catch {}
        this.controller = null;
    }

    emit(bytes) { try { this.controller?.enqueue(bytes); } catch {} }
    reply(request, lines) {
        for (const line of [...lines, 'LDN_DONE']) this.emit(buildFrame(KIND.RESPONSE, request, this.session, new TextEncoder().encode(line)));
    }
    event(text) { if (this.binary) this.emit(buildFrame(KIND.EVENT, 0, this.session, new TextEncoder().encode(text))); }

    // One whole adapter frame to the page, in the 64-byte pieces the link uses.
    toAdapter(frame) {
        for (let at = 0; at < frame.length; at += CHUNK) {
            const piece = new Uint8Array(CHUNK);
            piece.set(frame.subarray(at, at + CHUNK));
            this.emit(buildFrame(KIND.ADAPTER_OUT, 0, this.session, buildGbFrame(GB_CHANNEL.DATA, piece)));
        }
        this.frames.out++;
    }

    feed(chunk) {
        for (const byte of chunk) {
            if (!this.binary) {
                if (byte === 0x0a) { if (this.text.trim() === 'LDN_BINARY') this.binary = true; this.text = ''; }
                else if (byte !== 0) this.text += String.fromCharCode(byte);
                continue;
            }
            for (const frame of this.decoder.push(Uint8Array.of(byte))) this.frame(frame);
        }
    }

    frame(frame) {
        if (frame.kind === KIND.ADAPTER_IN) { this.fromAdapter(frame.payload); return; }
        if (frame.kind !== KIND.COMMAND) return;
        const line = new TextDecoder().decode(frame.payload);
        this.commands.push(line.split(' ')[0]);
        this.reply(frame.request, this.command(line));
    }

    command(line) {
        const word = line.split(' ')[0];
        if (word === 'LDN_HELLO') { this.session = 0; return ['LDN_HELLO 1 esp32s3 dynamic-session,scan,auth,udp 1472']; }
        if (word === 'LDN_BEGIN') { this.session = Number.parseInt(line.slice(10), 16) >>> 0; return ['LDN_BEGUN']; }
        if (word === 'LDN_INFO') return [`LDN_INFO frlg-ldn-bridge ${this.firmware} chip=esp32s3 transport=USB Serial/JTAG`];
        if (word === 'LDN_KEYS') return [this.hasKeys
            ? 'LDN_KEYS kek=1 gen=1 master00=1 master12=1 protocol1=1 protocol3=1'
            : 'LDN_KEYS kek=0 gen=0 master00=0 master12=0 protocol1=0 protocol3=0'];
        if (word === 'LDN_BRIDGE_STATUS') return [`LDN_BRIDGE_STATUS state=${this.bridge ? this.state : 'stopped'} conn_state=2 child=${this.connected ? 1 : 0}`];
        if (word === 'LDN_BRIDGE_STOP') { this.bridge = false; return ['LDN_BRIDGE_STOPPED']; }
        if (word === 'LDN_BRIDGE_START') { this.bridge = true; return ['LDN_BRIDGE_STARTED']; }
        if (word === 'LDN_RF') return ['LDN_RF frames=12 avg=-45 min=-50 max=-40 last=-45'];
        if (line === 'LDN_ADAPTER host' || line === 'LDN_ADAPTER uart') {
            this.adapter = line.slice(12);
            return [`LDN_ADAPTER ${this.adapter}`];
        }
        if (word === 'LDN_ADAPTER') return [`LDN_ADAPTER ${this.adapter}`];
        if (word === 'LDN_PING') return ['LDN_PONG 0 0 0'];
        return ['LDN_ERROR UNKNOWN_COMMAND'];
    }

    // Frames from whatever is playing the adapter.
    fromAdapter(bytes) {
        for (const frame of this.gb.push(bytes)) {
            if (frame.channel !== GB_CHANNEL.DATA) continue;
            for (const { type, header, frame: rfu } of this.reader.push(frame.payload)) {
                this.frames.in++;
                if (type === RFU.CONNECT_REQ) {
                    if (!GROUPS.some((group) => group.devid === (header & 0xffff))) continue;
                    this.childDevid = 0x4444;
                    this.connected = true;
                    this.toAdapter(command(RFU.CONNECT_ACK, this.childDevid));
                } else if (type === RFU.CLIENT_SEND) {
                    const payload = hostPayload(withLength(rfu));
                    if (payload.length === 16) this.child.push(payload.slice(2, 16));
                } else if (type === RFU.DISCONNECT) this.connected = false;
            }
        }
    }

    // The room ending: the board's own bridge restarts, and the adapter is let go.
    leaveRoom() {
        if (!this.connected) return;
        this.toAdapter(command(RFU.DISCONNECT, this.childDevid));
        this.connected = false;
    }

    beacon(group) {
        const frame = new Uint8Array(36);
        frame.set(Uint8Array.of(0x52, 0x46, 0x55, 0x31));
        wb32(frame, 4, RFU.BROADCAST);
        wb32(frame, 8, group.devid | ((this.connected ? 1 : 0) << 16));
        const packet = new Uint8Array(24);
        packet[12] = group.activity;
        for (let i = 0; i < 6; i++) wb32(frame, 12 + i * 4, u32(packet, i * 4));
        return frame;
    }

    tick() {
        if (this.adapter !== 'host' || !this.bridge) return;
        this.state = 'run';
        if (!this.connected) {
            if (this.linkTicks++ % 30 === 0) for (const group of GROUPS) this.toAdapter(this.beacon(group));
            return;
        }
        // The adapter's name exchange first, then the link itself.
        this.linkTicks++;
        const naming = this.linkTicks <= this.naming;
        if (!naming && !this.linkUp) { this.linkUp = true; this.onLinkUp?.(this.leader); }
        const payload = naming ? namingPayload() : this.leader.next(this.child.shift());
        this.toAdapter(hostFrame(payload));
    }
}

function command(type, header) {
    const frame = new Uint8Array(16);
    frame.set(Uint8Array.of(0x52, 0x46, 0x55, 0x31));
    wb32(frame, 4, type);
    wb32(frame, 8, header);
    return frame;
}

function hostFrame(payload) {
    const frame = new Uint8Array(104);
    frame.set(Uint8Array.of(0x52, 0x46, 0x55, 0x31));
    wb32(frame, 4, RFU.HOST_SEND);
    wb32(frame, 8, payload.length & 0x7f);
    frame.set(payload.subarray(0, 92), 12);
    return frame;
}

// The page puts its length in the top byte; hostPayload reads the board's low bits.
function withLength(frame) {
    const copy = frame.slice();
    wb32(copy, 8, b32(frame, 8) >>> 24);
    return copy;
}

// Puts a stand-in board in front of the page, as if one were plugged in.
export function installFakeSerial(port) {
    navigator.serial.getPorts = async () => [port];
    navigator.serial.requestPort = async () => port;
    return port;
}

export { GROUPS };
