// El shim de Web Serial de la app de Android (android/app/src/main/assets/android/po-serial.js), con un puente nativo simulado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SHIM = fs.readFileSync(new URL('../../android/app/src/main/assets/android/po-serial.js', import.meta.url), 'utf8');

function install() {
    const log = [];
    const device = { id: '/dev/bus/usb/001/002', vid: 0x303a, pid: 0x1001, name: 'USB JTAG/serial', granted: true };
    let opened = null;
    const win = {};
    const bridge = {
        list: () => JSON.stringify([device]),
        request(request, filters) { log.push(['request', JSON.parse(filters)]); queueMicrotask(() => win.__poSerial.resolve(request, device)); },
        open(id, baud) { opened = { id, baud }; log.push(['open', id, baud]); return true; },
        write(id, base64) { log.push(['write', id, Buffer.from(base64, 'base64').toString('hex')]); return Buffer.from(base64, 'base64').length; },
        signals(id, dtr, rts) { log.push(['signals', dtr, rts]); return true; },
        close(id) { log.push(['close', id]); },
        saveFile(name, mime, base64) { log.push(['save', name, mime, Buffer.from(base64, 'base64').toString()]); return `Descargas/${name}`; },
    };
    const anchors = [];
    class FakeAnchor {
        constructor(attrs) { Object.assign(this, attrs); }
        hasAttribute(name) { return name === 'download' && Boolean(this.download); }
        click() { log.push(['native-click']); }
    }
    const documentListeners = [];
    win.PokeDumpAndroid = bridge;
    const fakeNavigator = {};
    const globals = {
        window: win, navigator: fakeNavigator, HTMLAnchorElement: FakeAnchor, Element: class {},
        document: { addEventListener: (type, fn) => documentListeners.push([type, fn]) },
        fetch: async () => ({ blob: async () => new Blob(['hola'], { type: 'text/plain' }) }),
        console,
    };
    const names = Object.keys(globals);
    new Function(...names, SHIM)(...names.map((n) => globals[n]));
    return { log, win, navigator: fakeNavigator, device, FakeAnchor, opened: () => opened };
}

test('navigator.serial: requestPort, getPorts y getInfo', async () => {
    const { navigator, log, device } = install();
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a }] });
    assert.deepEqual(port.getInfo(), { usbVendorId: 0x303a, usbProductId: 0x1001 });
    assert.deepEqual(log[0], ['request', [{ usbVendorId: 0x303a }]]);
    const again = await navigator.serial.getPorts();
    assert.equal(again[0], port);                                  // el mismo objeto para el mismo dispositivo
    assert.ok(device.granted);
});

test('abrir, escribir, leer y señales como en Web Serial', async () => {
    const { navigator, win, log } = install();
    const [port] = await navigator.serial.getPorts();
    await port.open({ baudRate: 921600, bufferSize: 65536 });
    assert.deepEqual(log.find((l) => l[0] === 'open'), ['open', '/dev/bus/usb/001/002', 921600]);
    const writer = port.writable.getWriter();
    await writer.write(new Uint8Array([1, 2, 3, 255]));
    writer.releaseLock();
    assert.deepEqual(log.find((l) => l[0] === 'write'), ['write', '/dev/bus/usb/001/002', '010203ff']);
    await port.setSignals({ dataTerminalReady: false });
    await port.setSignals({ requestToSend: true });
    assert.deepEqual(log.filter((l) => l[0] === 'signals'), [['signals', 0, -1], ['signals', -1, 1]]);
    const reader = port.readable.getReader();
    win.__poSerial.data('/dev/bus/usb/001/002', Buffer.from('hello').toString('base64'));
    const { value } = await reader.read();
    assert.equal(Buffer.from(value).toString(), 'hello');
    reader.cancel();
    await port.close();
    assert.ok(log.some((l) => l[0] === 'close'));
    assert.equal(port.readable, null);
    await assert.rejects(() => port.setSignals({}), /not open/);
});

test('desconexión: el lector falla y la página recibe disconnect; el puerto se puede reabrir', async () => {
    const { navigator, win } = install();
    const [port] = await navigator.serial.getPorts();
    await port.open({ baudRate: 115200 });
    const reader = port.readable.getReader();
    let disconnected = false;
    port.addEventListener('disconnect', () => { disconnected = true; });
    win.__poSerial.lost('/dev/bus/usb/001/002', 'cable fuera');
    await assert.rejects(() => reader.read(), /cable fuera/);
    assert.ok(disconnected);
    await port.open({ baudRate: 115200 });                          // se puede volver a abrir
    assert.ok(port.readable);
});

test('descargas: los enlaces download con blob: se guardan por el puente', async () => {
    const { FakeAnchor, log } = install();
    const blobLink = new FakeAnchor({ href: 'blob:https://x/abc', download: 'informe.json' });
    FakeAnchor.prototype.click.call(blobLink);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(log.find((l) => l[0] === 'save'), ['save', 'informe.json', 'text/plain', 'hola']);
    const normal = new FakeAnchor({ href: 'https://x/a', download: 'a' });
    FakeAnchor.prototype.click.call(normal);
    assert.ok(log.some((l) => l[0] === 'native-click'));
});
