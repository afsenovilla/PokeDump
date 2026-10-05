// PokeDump: volcado SOLO LECTURA de la partida de Rojo Fuego / Verde Hoja de la Switch, desde la
// RAM, por el enlace de Mystery Gift. Sigue la estructura de gift/save-backup.js (GB-Link Switch
// LDN, AGPL-3.0): el cliente de la consola ejecuta nuestro payload (payload/ramdump.s) una vez
// por pasada de su guion, y cada pasada devuelve hasta 1 KB. Al final, un mensaje que el juego
// muestra sin guardar.
//
// Pasadas: 0 = cabecera (diagnóstico), 1-4 SaveBlock2, 5-20 SaveBlock1, 21-53 PokemonStorage.
// El resultado: un .sav de 128 KB para PKHeX y un JSON pokedump/1 (ver docs/FORMATO_JSON.md).

import {
    CLI, CLIENT_SCRIPTS, MG_LINK, MysteryGiftError, WonderCardServer, clientScript, parseGameData,
} from '../gift/mystery-gift.js';
import { describeSave } from '../gift/save-check.js';
import { RAMDUMP_PAYLOAD_BASE64 } from './ramdump-payload.js';
import { SB1_SIZE, SB2_SIZE, ST_SIZE, buildReport, buildSav, encodeText } from './gen3.js';

const decodeBase64 = (text) => Uint8Array.from(atob(text.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
export const RAMDUMP_PAYLOAD = decodeBase64(RAMDUMP_PAYLOAD_BASE64);

const CHUNK = 1024;
const MAX_PASSES = 32;                 // 3 comandos de 8 bytes por pasada caben en el guion de 1 KB
const CLI_MSG_BUFFER_FAILURE = 14;     // el juego muestra el mensaje y no guarda
const FIRST_OFFSET = 4;                // palabra .Lfirst del payload
const HEADER_MAGIC = 0x50444b50;       // 'PKDP'
const HEADER_BYTES = 64;

// Regiones en orden de pasada.
export const REGIONS = [
    { key: 'sb2', first: 1, size: SB2_SIZE },
    { key: 'sb1', first: 5, size: SB1_SIZE },
    { key: 'storage', first: 21, size: ST_SIZE },
].map((r) => ({ ...r, count: Math.ceil(r.size / CHUNK) }));
export const PASSES_WITH_STORAGE = REGIONS[2].first + REGIONS[2].count;   // 54
export const PASSES_WITHOUT_STORAGE = REGIONS[2].first;                   // 21

const line = (text) => [...encodeText(text, text.length)];
// Mensaje final que muestra el juego (CLI_MSG_BUFFER_FAILURE: sin guardar).
export const DUMPED_MESSAGE = Uint8Array.from([...line('Datos copiados a la web.'), 0xfe, ...line('No se ha guardado nada.'), 0xff]);

const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

export const DUMP_EVENTS = [{
    id: 'ram-probe',
    label: 'PokeDump: sonda (solo comprueba juego, idioma y punteros)',
    kind: 'backup',
    dump: true,
    probe: true,
    payloads: {},
    description: 'Una sola pasada de solo lectura: devuelve el código de juego, la revisión y los punteros que el payload encuentra. No copia la partida. Úsalo primero para comprobar que todo funciona con tu juego.',
}, {
    id: 'ram-dump',
    label: 'PokeDump: volcar la partida desde la RAM (.sav + JSON)',
    kind: 'backup',           // la página lo trata como una copia: progreso, descarga y mensajes
    dump: true,
    payloads: {},
    description: 'Lee SaveBlock1, SaveBlock2 y el PC de la memoria del juego (no de la flash) y los devuelve a esta página como .sav para PKHeX y como JSON. Nada se escribe en la Switch: el juego muestra un mensaje y no guarda.',
}];

function passesScript(count) {
    const passes = [];
    for (let i = 0; i < count; i++) passes.push([CLI.LOAD_TOSS_RESPONSE], [CLI.RUN_BUFFER_SCRIPT], [CLI.SEND_LOADED]);
    return clientScript([[CLI.RECV, MG_LINK.RAM_SCRIPT], ...passes, [CLI.RECV, MG_LINK.CLIENT_SCRIPT], [CLI.COPY_RECV]]);
}

export function parseHeader(bytes) {
    if (bytes.length !== HEADER_BYTES || u32(bytes, 0) !== HEADER_MAGIC) throw new MysteryGiftError('La Switch devolvió una cabecera inesperada.');
    return {
        version: u32(bytes, 4),
        sb2: u32(bytes, 8), sb1: u32(bytes, 12), storage: u32(bytes, 16), storagePtrAddress: u32(bytes, 20),
        status: u32(bytes, 24), returnAddress: u32(bytes, 28),
        poolAddresses: [u32(bytes, 32), u32(bytes, 36)],
        gameCode: String.fromCharCode(...bytes.subarray(48, 52)), revision: u32(bytes, 52),
    };
}

const STATUS_TEXT = {
    1: 'no se encontró el pool de punteros del juego',
    2: 'los punteros hallados no coinciden con los que pasó la consola',
    3: 'el puntero del almacenamiento no es fiable',
};

// Volcados cortados por el enlace, por partida: { chunks, header }. Se sigue por donde iban.
const unfinished = new Map();
const playerKey = (game) => `${game.gameCode} ${game.trainerId} ${Array.from(game.playerName).join(',')}`;

export class RamDumpServer extends WonderCardServer {
    // probe: solo la pasada de cabecera (diagnóstico de punteros, juego e idioma).
    constructor({ link, probe = false, log = () => {} }) {
        super({ link, payload: () => null, confirm: async () => false, log });
        this.probe = probe;
    }

    async run() {
        this.stage('checking');
        this.send(MG_LINK.CLIENT_SCRIPT, CLIENT_SCRIPTS.sendGameData);
        const game = parseGameData(await this.receive(MG_LINK.GAME_DATA));
        this.stage('checked', game);
        if (!game.valid) return this.end('cant-accept', CLIENT_SCRIPTS.cantAccept, game);
        if (!/^BP[RG][A-Z]$/.test(game.gameCode)) return this.end('unsupported', CLIENT_SCRIPTS.cantAccept, game);

        const key = playerKey(game);
        const kept = unfinished.get(key) ?? { chunks: new Array(PASSES_WITH_STORAGE).fill(null), header: null };
        unfinished.set(key, kept);
        const { chunks } = kept;
        let total = this.probe ? 1 : kept.header && kept.header.status !== 0 ? PASSES_WITHOUT_STORAGE : PASSES_WITH_STORAGE;
        const done = () => chunks.slice(1, total).filter(Boolean).length;
        if (this.probe) chunks[0] = null;                // la sonda siempre vuelve a leer la cabecera
        const progress = (extra = {}) => this.stage('backing-up', { done: done(), total: total - 1, ...extra });

        let at = chunks.findIndex((c, i) => i < total && !c);
        if (at < 0) at = total;
        if (at) this.log(`siguiendo el volcado desde la pasada ${at}`);
        progress();
        while (at < total) {
            // La primera tanda es solo la cabecera: decide si hay almacenamiento que pedir.
            const count = at === 0 ? 1 : Math.min(MAX_PASSES, total - at);
            const code = RAMDUMP_PAYLOAD.slice();
            new DataView(code.buffer).setUint32(FIRST_OFFSET, at, true);
            this.send(MG_LINK.CLIENT_SCRIPT, passesScript(count));
            this.send(MG_LINK.RAM_SCRIPT, code);
            for (let i = 0; i < count; i++) {
                const pass = at + i;
                const data = await this.receive(MG_LINK.RESPONSE);
                if (pass === 0) {
                    kept.header = parseHeader(data);
                    this.log(`juego: ${kept.header.gameCode} rev ${kept.header.revision}; estado ${kept.header.status}; `
                        + `SB2 ${kept.header.sb2.toString(16)} SB1 ${kept.header.sb1.toString(16)} PC ${kept.header.storage.toString(16)}`);
                    if (kept.header.gameCode !== game.gameCode) throw new MysteryGiftError('El código de juego de la cabecera no coincide con el del enlace.');
                    if (kept.header.status !== 0) {
                        this.log(`sin almacenamiento del PC: ${STATUS_TEXT[kept.header.status] ?? kept.header.status}`);
                        total = PASSES_WITHOUT_STORAGE;
                    }
                    chunks[0] = data;
                } else {
                    chunks[pass] = this.checkChunk(pass, data);
                }
                const finished = pass === total - 1 && !this.probe;
                progress(finished ? this.assemble(kept, game) : {});
            }
            at += count;
        }

        this.send(MG_LINK.CLIENT_SCRIPT, clientScript([
            [CLI.RECV, MG_LINK.DYNAMIC_MSG], [CLI.COPY_MSG], [CLI.SEND_READY_END], [CLI.RETURN, CLI_MSG_BUFFER_FAILURE],
        ]));
        this.send(MG_LINK.DYNAMIC_MSG, DUMPED_MESSAGE);
        await this.receive(MG_LINK.READY_END);
        if (this.probe) return { outcome: 'probed', game, header: kept.header };
        unfinished.delete(key);
        const result = this.assemble(kept, game);
        return result.save
            ? { outcome: 'backed-up', game, ...result }
            : { outcome: 'dumped-partial', game, ...result };
    }

    checkChunk(pass, data) {
        const region = REGIONS.find((r) => pass >= r.first && pass < r.first + r.count);
        const want = Math.min(CHUNK, region.size - (pass - region.first) * CHUNK);
        if (data.length !== want) throw new MysteryGiftError(`La pasada ${pass} devolvió ${data.length} bytes y se esperaban ${want}.`);
        return data.slice();
    }

    // Junta las regiones y reconstruye el .sav y el JSON con lo que haya.
    assemble(kept, game) {
        const blocks = {};
        for (const region of REGIONS) {
            const parts = kept.chunks.slice(region.first, region.first + region.count);
            if (parts.some((p) => !p)) continue;
            const out = new Uint8Array(region.size);
            parts.forEach((p, i) => out.set(p, i * CHUNK));
            blocks[region.key] = out;
        }
        const header = { gameCode: kept.header.gameCode, revision: kept.header.revision };
        const report = buildReport(blocks, header);
        if (!blocks.storage) return { report, header: kept.header, summary: { sound: false } };
        const save = buildSav(blocks);
        return { save, summary: describeSave(save), report, header: kept.header };
    }
}
