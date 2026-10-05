// Tests for the page's protocol code; no hardware and no dependencies: node web/tests/run.mjs
//
// The framing is checked against vectors.json, which make_vectors.py writes from the
// Python framing that has carried real sessions. The session logic runs against a stand-in
// for the firmware's console.

import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { KIND, crc32, cobsDecode, buildFrame, FrameDecoder, GbFrameParser, buildGbFrame, GB_CHANNEL } from '../js/wire.js';
import { parseProdKeys, parseKeyStatus } from '../js/keys.js';
import { md5 } from '../js/md5.js';
import { EspDevice, FAST_BAUD, sleep } from '../js/esp.js';
import { GbLinkSerial } from '../js/gblink.js';
import { Bridge } from '../js/bridge.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (text) => Uint8Array.from(Buffer.from(text, 'hex'));
let failures = 0;
function check(ok, what) {
    if (!ok) { failures++; console.log('FAIL', what); }
}

// ---- framing, against the Python reference

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
for (const vector of vectors) {
    const payload = unhex(vector.payload);
    check(crc32(payload) === vector.crc, `crc32 of ${payload.length} bytes`);
    check(hex(buildFrame(6, 0x11223344, 0xa1b2c3d4, payload)) === vector.frame, `frame around ${payload.length} bytes`);
    const raw = cobsDecode(unhex(vector.frame).subarray(0, -1));
    check(raw && hex(raw.subarray(12, raw.length - 4)) === vector.payload, `decode of ${payload.length} bytes`);
}

// Frames torn across reads, behind boot text, all come out.
{
    const stream = [...Buffer.from('I (231) boot: text before binary mode LDN_READY chip=esp32s3\n'), 0];
    for (const vector of vectors) stream.push(...unhex(vector.frame));
    const decoder = new FrameDecoder();
    let frames = [];
    for (let at = 0; at < stream.length; at += 37) frames = frames.concat(decoder.push(Uint8Array.from(stream.slice(at, at + 37))));
    check(frames.length === vectors.length, `decoder recovered ${frames.length} of ${vectors.length} frames`);
    check(frames.every((frame, i) => hex(frame.payload) === vectors[i].payload && frame.kind === 6 &&
        frame.request === 0x11223344 && frame.session === 0xa1b2c3d4), 'decoder contents');
    const damaged = unhex(vectors[5].frame);
    damaged[3] ^= 0x40;
    check(new FrameDecoder().push(damaged).length === 0, 'a damaged frame is dropped');
}

// GB-Link frames through a stream that is not frame-aligned.
{
    const parser = new GbFrameParser();
    const status = buildGbFrame(GB_CHANNEL.STATUS, Uint8Array.from([0x02, 0xff]));
    const data = buildGbFrame(GB_CHANNEL.DATA, new Uint8Array(64).fill(9));
    const stream = Uint8Array.from([0x00, 0x47, ...status, ...data]);
    let frames = [];
    for (let at = 0; at < stream.length; at += 7) frames = frames.concat(parser.push(stream.subarray(at, at + 7)));
    check(frames.length === 2 && frames[0].channel === 2 && hex(frames[0].payload) === '02ff' && frames[1].payload.length === 64, 'GB-Link parser');
    check(hex(buildGbFrame(GB_CHANNEL.COMMAND, Uint8Array.from([0, 7, 0]))) === '4742000300000700', 'SetMode frame');
}

// ---- keys and MD5

{
    const parsed = parseProdKeys(`master_key_00 = ${'ab'.repeat(16)}\r\nmaster_key_12=${'CD'.repeat(16)}\n` +
        `aes_kek_generation_source = xyz\nheader_key = ${'11'.repeat(32)}\n`);
    check(Object.keys(parsed.keys).length === 2 && parsed.keys.master_key_12 === 'cd'.repeat(16), 'keys found');
    check(parsed.malformed.join() === 'aes_kek_generation_source' && parsed.missing.join() === 'aes_key_generation_source', 'keys missing and malformed');
    check(parseKeyStatus('LDN_KEYS kek=1 gen=1 master00=1 master12=1 protocol1=1 protocol3=1').complete === true, 'key status complete');
    check(parseKeyStatus('LDN_KEYS kek=1 gen=0 master00=1 master12=1 protocol1=0 protocol3=1').complete === false, 'key status incomplete');
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 4096, 70001]) {
        const data = new Uint8Array(randomBytes(length));
        check(md5(data) === createHash('md5').update(data).digest('hex'), `md5 of ${length} bytes`);
    }
}

// ---- the adapter's reset counter: a handful of resets is ordinary play, a stream is a loop

{
    const adapter = new GbLinkSerial();
    const events = [];
    adapter.addEventListener('resetloop', (event) => events.push(event.detail.looping));
    const telemetry = (count) => { const frame = new Uint8Array(25); frame[0] = 0x1d; frame[14] = count; adapter.deliver(1, frame); };
    for (const count of [250, 251, 253]) telemetry(count);
    check(events.length === 0, 'a few resets are not a loop');
    for (const count of [255, 1, 3, 5]) telemetry(count);          // wraps past 255
    check(events.join() === 'true', 'a stream of resets is, across the counter wrapping');
    adapter.resets = [{ at: Date.now(), count: 5 }];
    telemetry(5);
    check(events.join() === 'true,false', 'and it ends when they stop');
}

// ---- a board that stays silent: what it printed says why

{
    const esp = new EspDevice();
    esp.bootText = 'I (742) wifi:ic_enable_sniffer\r\nESP_ERROR_CHECK failed: esp_err_t 0xffffffff (ESP_FAIL) at 0x400e2890\r\n' +
        'file: "pico_link.c" line 188\r\nfunc: pico_link_start\r\nexpression: uart_driver_install(PICO_LINK_UART, 4096, 4096, 0, NULL, 0)\r\n' +
        'abort() was called at PC 0x4008a6bb on core 0\r\nRebooting...\r\nrst:0xc (SW_CPU_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n';
    let error = esp.silenceExplained();
    check(error.code === 'crash-loop' && error.detail.includes('ESP_ERROR_CHECK failed') && error.detail.includes('pico_link_start'), 'a crash loop is named, with where');
    esp.bootText = 'rst:0x1 (POWERON_RESET),boot:0x3 (DOWNLOAD_BOOT(UART0/UART1/SDIO_REI_REO_V2))\r\nwaiting for download\r\n';
    error = esp.silenceExplained();
    check(error.code === 'download-mode', 'a chip in its bootloader is named');
    esp.bootText = '';
    check(esp.silenceExplained().code === 'no-firmware', 'plain silence stays plain');

    // How long to keep trying is decided by the same text.
    check(esp.worthAnotherTry(0, true) && !esp.worthAnotherTry(1, true) && !esp.worthAnotherTry(0, false), 'silence earns one more try, at the last rate only');
    esp.bootText = 'rst:0x10 (RTCWDT_RTC_RESET),boot:0x13\r\ninvalid header: 0xffffffff\r\n';
    esp.bootSignAt = Date.now();
    check(!esp.worthAnotherTry(0, true), 'a blank chip is not waited for');
    esp.bootText = esp.bootText.repeat(6);
    check(esp.silenceExplained().code === 'no-firmware', 'and its endless restarts are not taken for a crash loop');
    esp.bootText = 'rst:0x1 (POWERON_RESET)\r\nI (27) boot: ESP-IDF v6.1 2nd stage bootloader\r\nI (466) app_init: Project name:     blink\r\n';
    check(!esp.worthAnotherTry(0, true) && /blink/.test(esp.silenceExplained().message), 'nor is somebody else\'s firmware');
    esp.bootText = 'rst:0x1 (POWERON_RESET)\r\nI (466) app_init: Project name:     ldn_bridge_esp32\r\n';
    check(esp.worthAnotherTry(0, true), 'ours, still starting, is');
    esp.bootSignAt = Date.now() - 5000;
    check(!esp.worthAnotherTry(2, true), 'but not for ever');
}

// ---- a session, against a stand-in for the firmware's console

class FakeBoard {
    constructor() {
        this.binary = false;
        this.session = 0;
        this.adapterPort = 'uart';
        this.fromAdapter = [];
        this.storedKeys = {};
        this.text = '';
        this.decoder = new FrameDecoder();
    }

    getInfo() { return { usbVendorId: 0x303a, usbProductId: 0x1001 }; }

    async setSignals(signals) { (this.signalCalls ??= []).push(signals); }

    async open() {
        this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
        this.writable = new WritableStream({ write: (chunk) => this.receive(chunk) });
    }

    async close() { try { this.controller.close(); } catch {} }

    emit(bytes) { this.controller.enqueue(bytes); }

    print(line, request = 0) {
        if (this.binary) this.emit(buildFrame(request ? KIND.RESPONSE : KIND.EVENT, request, this.session, new TextEncoder().encode(line)));
        else this.emit(new TextEncoder().encode(`${line}\n`));
    }

    // As the firmware does after a session: back to text mode, everything forgotten.
    restart() {
        this.binary = false;
        this.session = 0;
        this.adapterPort = 'uart';
        this.text = '';
        this.decoder = new FrameDecoder();
        this.print('LDN_READY chip=fake transport=test heap=1');
    }

    receive(chunk) {
        if (!this.binary) {
            this.text += new TextDecoder().decode(chunk);
            if (!this.text.includes('LDN_BINARY\n')) return;
            this.binary = true;
            this.emit(Uint8Array.of(0));
            this.print('LDN_HELLO 1 fake dynamic-session 1472');
            return;
        }
        for (const frame of this.decoder.push(chunk)) {
            if (frame.kind === KIND.ADAPTER_IN) { this.fromAdapter.push(...frame.payload); continue; }
            if (frame.kind !== KIND.COMMAND) continue;
            const command = new TextDecoder().decode(frame.payload);
            const reply = (line) => this.print(line, frame.request);
            if (frame.session !== this.session && command !== 'LDN_HELLO' && !command.startsWith('LDN_BEGIN ')) reply('LDN_ERROR STALE_SESSION');
            else if (command === 'LDN_HELLO') { this.session = 0; reply('LDN_HELLO 1 fake dynamic-session 1472'); }
            else if (command.startsWith('LDN_BEGIN ')) { this.session = parseInt(command.slice(10), 16); reply('LDN_BEGUN'); }
            else if (command === 'LDN_INFO') reply('LDN_INFO frlg-ldn-bridge 2.0.0 chip=esp32s3 transport=USB Serial/JTAG');
            else if (command === 'LDN_KEYS') reply('LDN_KEYS kek=1 gen=1 master00=1 master12=0 protocol1=1 protocol3=0');
            else if (command.startsWith('LDN_KEY ')) {
                const [, name, value] = command.split(' ');
                const known = ['aes_kek_generation_source', 'aes_key_generation_source', 'master_key_00', 'master_key_12'].includes(name);
                if (known && /^[0-9a-f]{32}$/.test(value)) this.storedKeys[name] = value;
                reply(known ? `LDN_KEY_OK ${name}` : 'LDN_KEY_BAD name');
            }
            else if (command === 'LDN_ADAPTER') reply(`LDN_ADAPTER ${this.adapterPort}`);
            else if (command.startsWith('LDN_ADAPTER ')) { this.adapterPort = command.slice(12); reply(`LDN_ADAPTER ${this.adapterPort}`); }
            else if (command === 'LDN_BRIDGE_STATUS') reply('LDN_BRIDGE_STATUS state=scan child=0 conn_state=0');
            else reply('LDN_ERROR UNKNOWN_COMMAND');
            reply('LDN_DONE');
        }
    }

    toAdapter(bytes) { this.emit(buildFrame(KIND.ADAPTER_OUT, 0, this.session, bytes)); }
}

class FakeAdapter {
    constructor() { this.onBytes = null; this.written = []; this.left = 0; }
    writeStream(bytes) { this.written.push(...bytes); }
    async leaveMode() { this.left++; }
}

{
    const board = new FakeBoard();
    const esp = new EspDevice();
    const events = [];
    for (const name of ['attached', 'restarted', 'reattached', 'failed']) esp.addEventListener(name, () => events.push(name));
    await esp.open(board);
    check(esp.attached && esp.info?.version === '2.0.0' && esp.info?.chip === 'esp32s3', 'handshake and LDN_INFO');
    check(board.session === esp.session && esp.session !== 0, 'session id agreed');
    const keys = await esp.keyStatus();
    check(keys && keys.kek && !keys.master12 && !keys.complete, 'key status through a command');
    check((await esp.bridgeStatus())?.state === 'scan', 'bridge status parsed');
    const rejected = await esp.storeKeys({ master_key_00: '0f'.repeat(16), master_key_12: 'a5'.repeat(16), not_a_key: '00'.repeat(16) });
    check(rejected.join() === 'not_a_key' && board.storedKeys.master_key_12 === 'a5'.repeat(16) && Object.keys(board.storedKeys).length === 2,
        'keys are stored one command each, and a refusal is reported');

    const adapter = new FakeAdapter();
    const bridge = new Bridge(esp, adapter);
    await bridge.start();
    check(board.adapterPort === 'host', 'bridge takes the adapter port');
    board.toAdapter(buildGbFrame(GB_CHANNEL.COMMAND, Uint8Array.from([0, 7, 0])));
    adapter.onBytes(buildGbFrame(GB_CHANNEL.STATUS, Uint8Array.from([0x02, 0xff])));
    await sleep(50);
    check(hex(adapter.written) === '4742000300000700', 'frames reach the adapter');
    check(hex(board.fromAdapter) === '474202020002ff', 'adapter bytes reach the board');

    board.restart();
    let refused = false;
    await sleep(100);
    try { await esp.bridgeStatus(); } catch { refused = true; }
    check(refused, 'commands are refused while the board is away');
    for (let waited = 0; waited < 40 && !events.includes('reattached'); waited++) await sleep(100);
    await sleep(100);
    check(events.join() === 'attached,restarted,attached,reattached', `restart is followed (${events.join()})`);
    check(board.adapterPort === 'host' && bridge.stats.reattached === 1, 'the adapter port is taken again after a restart');

    await bridge.stop();
    check(board.adapterPort === 'uart' && adapter.left === 1, 'stopping hands the port back and leaves the mode');
    await esp.close();
}

// ---- a dev board with a USB-UART chip: DTR and RTS reach its reset circuit, its console
// runs at one rate, and what it prints while starting arrives a few bytes at a time

class DevBoard extends FakeBoard {
    constructor({ resetOnOpen = false } = {}) {
        super();
        this.resetOnOpen = resetOnOpen;
        this.resets = 0;
        this.up = true;
    }

    getInfo() { return { usbVendorId: 0x10c4, usbProductId: 0xea60 }; }

    async open(options) {
        await super.open();
        this.rate = options.baudRate;
        this.lines = { dataTerminalReady: true, requestToSend: true };   // as the operating system leaves them
        if (this.resetOnOpen) this.reset();
    }

    // The chip moves its pins one after the other, DTR first. RTS without DTR is reset.
    async setSignals(signals) {
        await super.setSignals(signals);
        for (const name of ['dataTerminalReady', 'requestToSend']) {
            if (!(name in signals)) continue;
            this.lines[name] = signals[name];
            if (this.lines.requestToSend && !this.lines.dataTerminalReady) this.reset();
        }
    }

    reset() {
        this.resets++;
        this.up = false;
        this.binary = false;
        this.session = 0;
        this.text = '';
        this.decoder = new FrameDecoder();
        this.trickle('I (27) boot: ESP-IDF v6.1 2nd stage bootloader\r\nI (466) app_init: Project name:     ldn_bridge_esp32\r\n');
        setTimeout(() => { this.up = true; this.trickle('LDN_READY chip=esp32 transport=UART heap=39264\n'); }, 500);
    }

    trickle(text) {
        if (this.rate !== FAST_BAUD) return;
        for (let at = 0; at < text.length; at += 7) this.emit(new TextEncoder().encode(text.slice(at, at + 7)));
    }

    receive(chunk) { if (this.up && this.rate === FAST_BAUD) super.receive(chunk); }
}

{
    const native = new FakeBoard();
    let esp = new EspDevice();
    await esp.open(native);
    check(native.signalCalls.length === 1 && native.signalCalls[0].dataTerminalReady === false && native.signalCalls[0].requestToSend === false,
        'a chip with its own USB has both control lines released in one request');
    await esp.close();

    const board = new DevBoard();
    esp = new EspDevice();
    await esp.open(board);
    check(esp.attached && board.resets === 0, 'releasing the control lines does not reset a board behind a USB-UART chip');
    check(JSON.stringify(board.signalCalls) === '[{"requestToSend":false},{"dataTerminalReady":false}]' && esp.baudRate === FAST_BAUD,
        'RTS is let go before DTR, at the fast rate');
    await esp.close();

    const resetting = new DevBoard({ resetOnOpen: true });
    esp = new EspDevice();
    const began = Date.now();
    await esp.open(resetting);
    const took = Date.now() - began;
    check(esp.attached && resetting.resets === 1, 'a board that resets as the port opens is waited for, its start-up text arriving in pieces');
    check(took < 1300, `and answered soon after its banner (${took} ms)`);
    await esp.close();
}

// ---- a chip with its own USB port and nothing in flash: it prints, restarts, and the
// port goes away with it

class BlankNativeBoard extends FakeBoard {
    async open() {
        await super.open();
        setTimeout(() => {
            this.emit(new TextEncoder().encode('ESP-ROM:esp32c6-20220919\r\nrst:0x7 (TG0WDT_HPSYS),boot:0xc (SPI_FAST_FLASH_BOOT)\r\ninvalid header: 0xffffffff\r\n'));
            try { this.controller.close(); } catch {}
        }, 20);
    }

    receive() {}
}

{
    const esp = new EspDevice();
    let error = null;
    try { await esp.open(new BlankNativeBoard()); } catch (caught) { error = caught; }
    check(error?.code === 'no-firmware', `a blank chip that takes its port away is still a board without firmware (${error?.code})`);
    await esp.close();
}

console.log(failures ? `${failures} FAILED` : `all tests pass (${vectors.length} framing vectors)`);
process.exit(failures ? 1 : 0);
