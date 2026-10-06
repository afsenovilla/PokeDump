// Genera (con shiny.js) el script de RAM de Shiny Hunting para una ROM compilada de pret y lo imprime en hex.
// node make_payload.mjs ROM.gba CÓDIGO REVISIÓN [1/N]
import fs from 'node:fs';
import { locateSymbols, buildShinyPayload } from '../../web/js/dump/shiny.js';
const rom = new Uint8Array(fs.readFileSync(process.argv[2]));
const { found, problems } = locateSymbols(rom);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
const { script } = buildShinyPayload(found, { gameCode: process.argv[3], revision: Number(process.argv[4]) }, { oneIn: Number(process.argv[5]) || null });
console.log(JSON.stringify({ script: Buffer.from(script).toString('hex'), found }));
