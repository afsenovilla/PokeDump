// Genera (con shiny.js) el script de RAM de Shiny Hunting para una ROM compilada de pret y lo imprime en hex.
// node make_payload.mjs ROM.gba CÓDIGO REVISIÓN [1/N]
import fs from 'node:fs';
import { locateSymbols, buildShinyPayload, buildLegendaryPayload, buildUltraBallPayload, ULTRA_BALL_CHOICES } from '../../web/js/dump/shiny.js';
const rom = new Uint8Array(fs.readFileSync(process.argv[2]));
const { found, problems } = locateSymbols(rom);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
const game = { gameCode: process.argv[3], revision: Number(process.argv[4]) };
const { script } = process.argv[5].replace('-keep', '') in ULTRA_BALL_CHOICES ? buildUltraBallPayload(found, game, { balls: process.argv[5].replace('-keep', ''), keep: process.argv[5].endsWith('-keep') }) : process.argv[5] === 'legendary' ? buildLegendaryPayload({ gameCode: process.argv[3], revision: Number(process.argv[4]) }) : buildShinyPayload(found, { gameCode: process.argv[3], revision: Number(process.argv[4]) }, { oneIn: process.argv[5] === 'toggle' ? 'toggle' : Number(process.argv[5]) || null });
console.log(JSON.stringify({ script: Buffer.from(script).toString('hex'), found }));
