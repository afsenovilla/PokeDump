// Prueba de la interfaz en Chromium (Playwright): estados de la página con una placa simulada.
// Uso: node tests/ui.mjs   (sirve web/ en un puerto libre; necesita playwright y chromium)
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('../web/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon', '.bin': 'application/octet-stream' };
const server = createServer((req, res) => {
    const file = join(root, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
}).listen(0);
const port = server.address().port;

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => window.__pokedump);

assert.equal(await page.$eval('#start', (b) => b.disabled), true);       // sin placa
await page.evaluate(() => {
    const { state, render } = window.__pokedump;
    state.esp = { attached: true, info: { chip: 'esp32s3', version: '2.1.4', transport: 'USB' }, baudRate: 921600, port: {} };
    state.keys = { complete: true };
    render();
});
assert.match(await page.$eval('#esp-status', (e) => e.textContent), /ESP32-S3 lista/);
assert.equal(await page.$eval('#start', (b) => b.disabled), false);       // placa lista: se puede empezar

await page.evaluate(() => {
    const { state, render } = window.__pokedump;
    state.gift = {};
    state.giftStatus = { stage: 'backing-up', player: { name: 'ASH' }, detail: { done: 20, total: 53 } };
    render();
});
assert.match(await page.$eval('#dump-status', (e) => e.textContent), /20 de 53 KB/);
assert.equal(await page.$eval('#stop', (b) => b.hidden), false);
assert.match(await page.$eval('#dump-progress div', (d) => d.style.width), /^38%$/);

const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
await page.evaluate((f) => {
    const { state, render, keepFiles } = window.__pokedump;
    state.gift = null;
    state.game = { gameCode: 'BPGS' };
    state.giftResult = { outcome: 'backed-up', player: { name: 'ASH' }, game: state.game };
    keepFiles({ save: Uint8Array.from(f.save), report: f.report }, { name: 'ASH' });
    render();
}, fixture);
assert.equal(await page.$eval('#result-card', (c) => c.hidden), false);
assert.equal(await page.$$eval('#downloads .file', (r) => r.length), 2);
const facts = await page.$eval('#result-facts', (e) => e.textContent);
assert.match(facts, /5 capturados/);
assert.match(facts, /2 Pokémon/);
assert.match(await page.$eval('#downloads', (e) => e.textContent), /\.sav/);
assert.match(await page.$eval('#downloads', (e) => e.textContent), /\.json/);

// la sonda: mensaje con punteros
await page.evaluate(() => {
    const { state, render } = window.__pokedump;
    state.files = [];
    state.giftResult = { outcome: 'probed', player: null, header: { gameCode: 'BPGS', revision: 10, status: 0, sb2: 0x2025504, sb1: 0x2029a60, storage: 0x2033000, storagePtrAddress: 0x3004230 } };
    render();
});
assert.match(await page.$eval('#dump-status', (e) => e.textContent), /Punteros correctos/);
assert.match(await page.$eval('#dump-hint', (e) => e.textContent), /&PC 0x3004230/);

// tarjeta Shiny Hunting: sin calibración no se puede elegir; con ella sí
assert.equal(await page.$eval('input[value="shiny-hunting"]', (r) => r.disabled), true);
assert.match(await page.$eval('#shiny-desc', (e) => e.textContent), /Comprobar mi juego/);
await page.evaluate(async () => {
    const { SHINY_SLOTS } = await import('/js/dump/shiny.js');
    const found = {};
    [...new Set(SHINY_SLOTS.map((x) => x[1]))].forEach((n, i) => { found[n] = 0x03001000 + i * 16 + 1; });
    localStorage.setItem('pokedump-shiny', JSON.stringify({ gameCode: 'BPGS', revision: 10, found, savedAt: 'x' }));
});
await page.reload();
await page.waitForFunction(() => window.__pokedump);
assert.equal(await page.$eval('input[value="shiny-hunting"]', (r) => r.disabled), false);
assert.match(await page.$eval('#shiny-desc', (e) => e.textContent), /LeafGreen \(Spanish\)/);
assert.equal(await page.$eval('.card-only', (e) => e.hidden), true);
await page.click('#shiny-choice');
assert.equal(await page.$eval('.card-only', (e) => e.hidden), false);
await page.evaluate(() => { const { state, render } = window.__pokedump; state.decision = { reasons: ['same-card'] }; render(); });
assert.equal(await page.$eval('#decision', (e) => e.hidden), false);
await page.evaluate(() => { const { state, render } = window.__pokedump; state.esp = { attached: true, info: { chip: 'esp32s3', version: '2.1.4', transport: 'USB' }, baudRate: 921600, port: {} }; state.keys = { complete: true }; state.decision = null; state.giftResult = { outcome: 'sent', player: { name: 'ASH' }, event: { id: 'shiny-hunting' } }; render(); });
assert.match(await page.$eval('#dump-status', (e) => e.textContent), /Tarjeta enviada a ASH/);

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log('ui: ok');
