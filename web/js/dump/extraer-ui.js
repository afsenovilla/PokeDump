// Interfaz de extraer.html: elige NSP y prod.keys, extrae la ROM en el navegador y enseña el juego.
import { ExtractError, extractRom } from './nsp.js';
import { calibrationFrom, saveCalibration } from './shiny-event.js';

const $ = (id) => document.getElementById(id);
const state = { nsp: null, keys: null, result: null };

function setupDrop(dropId, inputId, onFile) {
    const drop = $(dropId), input = $(inputId);
    input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && onFile(e.dataTransfer.files[0]));
}

function marked(prefix, file, sub) {
    $(`${prefix}-drop`).classList.add('done');
    $(`${prefix}-title`).textContent = `✓ ${file.name}`;
    $(`${prefix}-sub`).textContent = sub;
}

const size = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : `${(n / (1 << 20)).toFixed(1)} MB`);

function refresh() { $('go').disabled = !(state.nsp && state.keys); }

setupDrop('nsp-drop', 'nsp-file', (file) => {
    state.nsp = file;
    marked('nsp', file, size(file.size));
    refresh();
});

setupDrop('keys-drop', 'keys-file', async (file) => {
    state.keys = await file.text();
    marked('keys', file, 'Se queda en tu navegador');
    refresh();
});

function status(text, tone = '') {
    const el = $('status');
    el.textContent = text;
    el.className = `status ${tone}`;
}

function download(bytes, name, type = 'application/octet-stream') {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('go').addEventListener('click', async () => {
    $('go').disabled = true;
    $('result').hidden = true;
    $('progress').hidden = false;
    status('Empezando…');
    try {
        state.result = await extractRom(state.nsp, state.keys, (t) => status(t));
        show(state.result);
        status('Hecho.', 'good');
    } catch (error) {
        status(error instanceof ExtractError ? error.message : `Algo falló: ${error.message}`, 'bad');
        console.error(error);
    } finally {
        $('progress').hidden = true;
        refresh();
    }
});

function show({ report, game }) {
    $('result').hidden = false;
    const ok = report.header_checksum_ok;
    $('badge').textContent = ok ? 'ROM válida' : 'Cabecera no válida';
    $('badge').className = `badge ${ok ? 'ok' : 'bad'}`;
    $('game').textContent = `${game.game} · ${game.language}`;
    $('r-code').textContent = report.game_code;
    $('r-rev').textContent = `0x${report.revision.toString(16).padStart(2, '0')} (${report.revision})`;
    $('r-size').textContent = size(report.size);
    $('r-sha1').textContent = report.sha1;
    const pools = report.rom_facts?.client_pool ?? [];
    const good = pools.filter((p) => p.cmp_r0_1_before_pool);
    $('r-pool').textContent = good.length
        ? `✓ encontrado (${good.length}): puntero del PC en 0x${good[0].storage_ptr_address_guess.toString(16)}`
        : pools.length ? '⚠ patrón parecido, sin confirmar' : '✗ no encontrado';
    const shiny = report.rom_facts?.shiny;
    if (shiny) {
        const cal = calibrationFrom(shiny, { game_code: report.game_code, revision: report.revision });
        const total = Object.keys(shiny.found).length;
        if (ok && cal.ok && saveCalibration(cal.data)) $('r-shiny').textContent = `✓ ${total} direcciones encontradas y guardadas en este navegador (buscador: ${shiny.ref ?? 'versión antigua'}): ya puedes usar las tarjetas en la página principal, abierta en esta misma ventana (si usaste una ventana privada, copia el informe y pégalo en «Calibración» de la otra)${cal.warnings.length ? ` (avisos: ${cal.warnings.join('; ')})` : ''}`;
        else if (ok && cal.ok) $('r-shiny').textContent = `✓ ${total} direcciones encontradas, pero el navegador no deja guardarlas`;
        else $('r-shiny').textContent = `✗ ${total} encontradas${cal.missing.length ? `; faltan ${cal.missing.join(', ')}` : ''}${cal.problems.length ? `; ${cal.problems.join('; ')}` : ''}`;
    }
    $('advice').textContent = ok
        ? 'Pulsa «Copiar informe» y pégalo en el chat. Con eso basta para saber qué direcciones de memoria usa tu juego.'
        : 'La extracción no dio una ROM de GBA correcta. Copia el informe y cuéntalo.';
}

const reportText = () => JSON.stringify(state.result.report, null, 2);
$('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(reportText());
    $('copy').textContent = '¡Copiado!';
    setTimeout(() => { $('copy').textContent = 'Copiar informe'; }, 1500);
});
$('dl-report').addEventListener('click', () => download(reportText(), 'informe.json', 'application/json'));
$('dl-rom').addEventListener('click', () => download(state.result.rom, state.result.fileName || 'rom.gba'));
