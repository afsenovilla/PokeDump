// PokeDump en Android: da a la página lo que un navegador de ordenador le daría —navigator.serial (Web Serial) y la descarga de
// archivos— apoyándose en el puente nativo (window.PokeDumpAndroid, ver SerialBridge.java). Es idempotente: se puede inyectar dos veces.
(() => {
    'use strict';
    const bridge = window.PokeDumpAndroid;
    if (!bridge || window.__poSerialInstalled) return;
    window.__poSerialInstalled = true;

    const toBase64 = (bytes) => {
        let binary = '';
        const step = 0x8000;
        for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
        return btoa(binary);
    };
    const fromBase64 = (text) => {
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    };
    const fail = (name, message) => new DOMException(message, name);

    const ports = new Map();         // id del dispositivo -> SerialPort
    const requests = new Map();      // petición -> { resolve, reject }
    let nextRequest = 1;

    class SerialPort extends EventTarget {
        constructor(info) {
            super();
            this.id = info.id;
            this.vid = info.vid;
            this.pid = info.pid;
            this.readable = null;
            this.writable = null;
            this._controller = null;
            this._open = false;
        }

        getInfo() {
            return { usbVendorId: this.vid, usbProductId: this.pid };
        }

        async open(options = {}) {
            if (this._open) throw fail('InvalidStateError', 'The port is already open.');
            if (!bridge.open(this.id, Number(options.baudRate) || 115200)) throw fail('NetworkError', 'Failed to open serial port.');
            this._open = true;
            this.readable = new ReadableStream({
                start: (controller) => { this._controller = controller; },
                cancel: () => { this._controller = null; },
            });
            this.writable = new WritableStream({
                write: (chunk) => {
                    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer ?? chunk, chunk.byteOffset ?? 0, chunk.byteLength);
                    const step = 16384;
                    for (let i = 0; i < bytes.length; i += step) {
                        if (bridge.write(this.id, toBase64(bytes.subarray(i, i + step))) < 0) throw fail('NetworkError', 'The device has been lost.');
                    }
                },
            });
        }

        async close() {
            if (!this._open) return;
            this._open = false;
            bridge.close(this.id);
            try { this._controller?.close(); } catch { /* ya cerrado o cancelado */ }
            this._controller = null;
            this.readable = null;
            this.writable = null;
        }

        async setSignals(signals = {}) {
            if (!this._open) throw fail('InvalidStateError', 'The port is not open.');
            const flag = (value) => (value === undefined ? -1 : (value ? 1 : 0));
            if (!bridge.signals(this.id, flag(signals.dataTerminalReady), flag(signals.requestToSend))) {
                throw fail('NetworkError', 'Failed to set control signals.');
            }
        }

        async getSignals() {
            return { dataCarrierDetect: false, clearToSend: false, ringIndicator: false, dataSetReady: false };
        }

        async forget() {}

        // Llamado por el puente nativo
        _data(bytes) {
            try { this._controller?.enqueue(bytes); } catch { /* flujo cancelado */ }
        }

        _lost(message) {
            if (!this._open) return;
            this._open = false;
            try { this._controller?.error(fail('NetworkError', message || 'The device has been lost.')); } catch { /* ya cerrado */ }
            this._controller = null;
            this.readable = null;
            this.writable = null;
            this.dispatchEvent(new Event('disconnect'));
        }
    }

    const portFor = (info) => {
        let port = ports.get(info.id);
        if (!port) {
            port = new SerialPort(info);
            ports.set(info.id, port);
        }
        return port;
    };

    const serial = new EventTarget();
    serial.requestPort = (options = {}) => new Promise((resolve, reject) => {
        const request = nextRequest++;
        requests.set(request, { resolve, reject });
        bridge.request(request, JSON.stringify(options.filters ?? []));
    });
    serial.getPorts = async () => JSON.parse(bridge.list()).filter((info) => info.granted).map(portFor);
    Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });

    window.__poSerial = {
        resolve(request, info) {
            const pending = requests.get(request);
            requests.delete(request);
            pending?.resolve(portFor(info));
        },
        reject(request, name, message) {
            const pending = requests.get(request);
            requests.delete(request);
            pending?.reject(fail(name, message));
        },
        data(id, text) { ports.get(id)?._data(fromBase64(text)); },
        lost(id, message) { ports.get(id)?._lost(message); },
        attached(info) {
            const port = portFor(info);
            const event = new Event('connect');
            port.dispatchEvent(event);
            serial.dispatchEvent(Object.assign(new Event('connect'), { target: serial }));
        },
        detached(id) {
            const port = ports.get(id);
            if (!port) return;
            port._lost('The device has been lost.');
            ports.delete(id);
            serial.dispatchEvent(new Event('disconnect'));
        },
    };

    // Descargas: Android no sabe «descargar» un blob:, así que los <a download href="blob:…"> se guardan en Descargas/PokeDump.
    const saveBlobLink = async (anchor) => {
        try {
            const blob = await (await fetch(anchor.href)).blob();
            const bytes = new Uint8Array(await blob.arrayBuffer());
            bridge.saveFile(anchor.download || 'archivo', blob.type || 'application/octet-stream', toBase64(bytes));
        } catch (error) {
            console.error('PokeDump: no se pudo guardar el archivo', error);
        }
    };
    const isBlobDownload = (anchor) => anchor instanceof HTMLAnchorElement && anchor.hasAttribute('download') && anchor.href.startsWith('blob:');
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
        if (isBlobDownload(this)) { saveBlobLink(this); return; }
        return originalClick.call(this);
    };
    document.addEventListener('click', (event) => {
        const anchor = event.target instanceof Element ? event.target.closest('a[download]') : null;
        if (anchor && isBlobDownload(anchor)) {
            event.preventDefault();
            saveBlobLink(anchor);
        }
    }, true);
})();
