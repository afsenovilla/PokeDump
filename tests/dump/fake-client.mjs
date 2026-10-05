// «Consola» falsa para probar RamDumpServer de extremo a extremo: implementa el lado cliente del
// enlace de Mystery Gift (mensajes por bloques con CRC, y el intérprete del guion de cliente) y
// delega CLI_RUN_BUFFER_SCRIPT en el payload REAL ejecutándose en mGBA (tests/mgba_rpc.py).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CLI, MG_LINK, MG_BLOCK_BYTES, crc16, messageBlocks } from '../../web/js/gift/mystery-gift.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

export class MgbaRunner {
    constructor() {
        this.proc = spawn('python3', ['tests/mgba_rpc.py'], { stdio: ['pipe', 'pipe', 'inherit'], cwd: new URL('../..', import.meta.url).pathname,
            env: { ...process.env, PYTHONPATH: 'tests' } });
        this.lines = createInterface({ input: this.proc.stdout })[Symbol.asyncIterator]();
    }

    async rpc(request) {
        this.proc.stdin.write(JSON.stringify(request) + '\n');
        const { value, done } = await this.lines.next();
        if (done) throw new Error('mgba_rpc terminó');
        return JSON.parse(value);
    }

    init(blocks, extra = {}) {
        return this.rpc({ cmd: 'init', sb2: hex(blocks.sb2), sb1: hex(blocks.sb1), storage: hex(blocks.storage), ...extra });
    }

    close() { this.proc.stdin.end(); this.proc.kill(); }
}

function gameData({ code = 'BPRS', revision = 10, trainerId = 0x1234 } = {}) {
    const b = new Uint8Array(100);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x101, true);
    v.setUint16(4, 1, true);
    v.setUint32(8, 1, true);
    v.setUint16(12, 1, true);
    v.setUint32(16, 5, true);
    v.setUint32(0x4c, trainerId, true);
    b.set([0xbb, 0xc5, 0xc8, 0xff, 0xff, 0xff, 0xff], 0x45);
    for (let i = 0; i < 4; i++) b[0x5c + i] = code.charCodeAt(i);
    b[0x60] = revision;
    return b;
}

export class FakeConsole {
    // runner: MgbaRunner ya inicializado. stopAfterPasses: deja de contestar tras N pasadas (enlace perdido).
    constructor({ runner, game = {}, stopAfterPasses = Infinity }) {
        this.runner = runner;
        this.gameData = gameData(game);
        this.stopAfter = stopAfterPasses;
        this.passes = 0;
        this.param = 0;                   // client->param: empieza a cero, como la estructura de la consola
        this.script = [[CLI.RECV, MG_LINK.CLIENT_SCRIPT], [CLI.COPY_RECV]];
        this.pc = 0;
        this.inbox = new Map();
        this.partial = null;
        this.lastRecv = null;
        this.loaded = null;
        this.queue = Promise.resolve();
        this.returned = null;
        this.sentMessages = [];
        this.server = null;
        this.link = { sendBlock: (block, ident, sent) => { this.queue = this.queue.then(() => this.deliver(block, ident, sent)); } };
    }

    attach(server) { this.server = server; }

    async deliver(block, ident, sent) {
        if (this.dead) return;
        const p = this.partial;
        if (!p) {
            const id = block[0] | (block[1] << 8);
            this.partial = { ident: id, crc: block[2] | (block[3] << 8), size: block[4] | (block[5] << 8), data: [] };
            if (this.partial.size === 0) await this.complete();
        } else {
            p.data.push(...block);
            if (p.data.length >= p.size) await this.complete();
        }
        sent?.();
    }

    async complete() {
        const { ident, crc, size, data } = this.partial;
        this.partial = null;
        const bytes = Uint8Array.from(data.slice(0, size));
        if (crc16(bytes) !== crc) throw new Error(`CRC incorrecto en el mensaje ${ident}`);
        this.inbox.set(ident, bytes);
        await this.run();
    }

    emit(ident, data) {
        for (const block of messageBlocks(ident, data)) this.server.block(block);
    }

    async run() {
        for (let guard = 0; guard < 100000 && !this.dead; guard++) {
            const cmd = this.script[this.pc];
            if (!cmd || this.returned !== null) return;
            const [instr, param] = cmd;
            switch (instr) {
                case CLI.RECV:
                    if (!this.inbox.has(param)) return;           // espera al mensaje
                    this.lastRecv = this.inbox.get(param);
                    this.inbox.delete(param);
                    break;
                case CLI.COPY_RECV: {
                    const s = [];
                    for (let i = 0; i + 8 <= this.lastRecv.length; i += 8) s.push([u32(this.lastRecv, i), u32(this.lastRecv, i + 4)]);
                    this.script = s; this.pc = 0;
                    continue;
                }
                case CLI.LOAD_GAME_DATA: this.loaded = [MG_LINK.GAME_DATA, this.gameData]; break;
                case CLI.LOAD_TOSS_RESPONSE: this.loaded = [MG_LINK.RESPONSE, Uint8Array.of(this.param & 255, (this.param >> 8) & 255, (this.param >> 16) & 255, this.param >>> 24)]; break;
                case CLI.RUN_BUFFER_SCRIPT: {
                    if (this.passes >= this.stopAfter) { this.dead = true; return; }
                    this.passes++;
                    const out = await this.runner.rpc({ cmd: 'pass', code: Buffer.from(this.lastRecv).toString('hex'), param: this.param });
                    if (out.ret !== 1) throw new Error(`el payload devolvió ${out.ret}`);
                    this.param = out.param;
                    this.loaded = [MG_LINK.RESPONSE, Uint8Array.from(Buffer.from(out.sent, 'hex'))];
                    break;
                }
                case CLI.SEND_LOADED: this.sentMessages.push(this.loaded[0]); this.emit(...this.loaded); break;
                case CLI.COPY_MSG: this.message = this.lastRecv; break;
                case CLI.SEND_READY_END: this.emit(MG_LINK.READY_END, new Uint8Array(0)); break;
                case CLI.RETURN: this.returned = param; return;
                default: throw new Error(`comando no implementado ${instr}`);
            }
            this.pc++;
        }
    }
}
