// El evento «Shiny Hunting» de la página principal: usa las direcciones que la página de extracción
// encontró en la ROM del usuario (se guardan en el navegador) para adaptar la tarjeta a su juego.

import { GIFT_REQUIRED, SHINY_SLOTS, ULTRA_REQUIRED, buildGiftShinyPayload, buildResetPayload, buildShinyPayload, buildUltraBallPayload } from './shiny.js';

const KEY = 'pokedump-shiny';
const REQUIRED = [...new Set(SHINY_SLOTS.map((s) => s[1]))];

// result: { found, problems } de locateSymbols; info: { game_code, revision } de la cabecera de la ROM.
export function calibrationFrom(result, info) {
    const missing = REQUIRED.filter((k) => result.found[k] === undefined);
    return {
        ok: missing.length === 0 && result.problems.length === 0 && /^BP[RG][A-Z]$/.test(info.game_code),
        missing, problems: result.problems, warnings: result.warnings ?? [],
        data: { gameCode: info.game_code, revision: info.revision, found: result.found, savedAt: new Date().toISOString() },
    };
}

export function saveCalibration(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; } catch { return false; }
}

// Calibraciones ya conocidas: no hace falta pasar el NSP por «Comprobar mi juego» si el juego es uno de estos (misma ROM, mismas direcciones).
// BPGS rev. 10 = Verde Hoja en español de la Switch (sha1 0d2a0026898375895dfd7ea139ceae90324add8f), del informe de «Comprobar mi juego».
export const KNOWN_CALIBRATIONS = [{
    gameCode: 'BPGS', revision: 10, builtin: true, source: 'LeafGreen (Spanish), Switch',
    found: {
        Random: 134514373, GetMonData: 134492921, SetMonData: 134494861, CalculateMonStats: 134486925, ScriptContext_SetupScript: 134665193,
        CB1_Overworld: 134585949, CB2_Overworld: 134586077, SetActionsAndBattlersTurnOrder: 134318129, DismissMapNamePopup: 134855925,
        AddBagItem: 134863449, gMain: 50340560, gIntrTable: 50341664, gBattleMainFunc: 50348452, gEnemyParty: 33701928,
        gBattleTypeFlags: 33696584, gBattleOutcome: 33701510, gChosenActionByBattler: 33701240, gQuestLogState: 33795574,
        gSpecialVar_0x8004: 33779900, sLockFieldControls: 50335900, sGlobalScriptContextStatus: 50335656, sGlobalScriptContext: 50335664,
        gSaveBlock2Ptr: 50348588, gLastUsedItem: 33701220, gPlayerPartyCount: 33701925, gPlayerParty: 33702528, gPokemonStoragePtr: 50348592,
    },
}];

// La calibración que sirve para este juego: la guardada si es de la misma versión, o una conocida.
export function calibrationFor(saved, game) {
    const same = (c) => c && c.gameCode === game.gameCode && c.revision === game.revision;
    return same(saved) ? saved : KNOWN_CALIBRATIONS.find(same) ?? null;
}

export function loadCalibration() {
    try {
        const data = JSON.parse(localStorage.getItem(KEY) ?? 'null');
        return data && REQUIRED.every((k) => Number.isInteger(data.found?.[k])) ? data : KNOWN_CALIBRATIONS[0];
    } catch { return KNOWN_CALIBRATIONS[0]; }
}

export function clearCalibration() {
    try { localStorage.removeItem(KEY); } catch {}
}

export const SHINY_EVENT_ID = 'shiny-hunting';

// El evento para el WonderCardServer: build(game) devuelve { card, script }, o null si la ROM calibrada no es la de la Switch.
export function shinyEvent(calibration, { oneIn = null } = {}) {
    return {
        id: SHINY_EVENT_ID,
        kind: 'card',
        label: oneIn === 'toggle' ? 'Shiny Hunting (R alterna siempre shiny)' : oneIn ? `Shiny Hunting (1/${oneIn})` : 'Shiny Hunting (probabilidad aumentada)',
        build(game) {
            const cal = calibrationFor(calibration, game);
            if (!cal) return null;
            const { card, script } = buildShinyPayload(cal.found, { gameCode: game.gameCode, revision: game.revision }, { oneIn });
            return { card, script };
        },
    };
}

export const LEGENDARY_EVENT_ID = 'legendary-reset';

// No necesita calibración: es solo script del juego. Vale para Rojo Fuego y Verde Hoja en cualquier idioma y revisión.
// groups: claves de RESET_GROUPS (por defecto, solo los legendarios).
export function resetEvent(groups = ['legendary']) {
    return {
        id: LEGENDARY_EVENT_ID,
        kind: 'card',
        label: 'Reiniciar eventos de un solo uso',
        build(game) {
            if (!/^BP[RG][A-Z]$/.test(game.gameCode)) return null;
            return buildResetPayload(game, groups);
        },
    };
}
export const legendaryEvent = resetEvent();

export const ULTRA_EVENT_ID = 'ultra-master';

// ¿Tiene la calibración guardada todo lo que necesita la tarjeta de bolas? (las calibraciones anteriores no tenían gLastUsedItem)
export const supportsUltra = (calibration) => Boolean(calibration) && ULTRA_REQUIRED.every((k) => Number.isInteger(calibration.found?.[k]));

export const supportsKeep = (calibration) => supportsUltra(calibration) && Number.isInteger(calibration.found?.AddBagItem);

export function ultraEvent(calibration, { balls = 'ultra', keep = false, shiny = null } = {}) {
    return {
        id: ULTRA_EVENT_ID,
        kind: 'card',
        label: `Ultra Ball = Master Ball${keep ? ' (no se gasta)' : ''}${shiny ? ' + shiny' : ''}`,
        build(game) {
            const cal = calibrationFor(calibration, game);
            if (!cal) return null;
            return buildUltraBallPayload(cal.found, { gameCode: game.gameCode, revision: game.revision }, { balls, keep, shiny });
        },
    };
}

export const GIFT_EVENT_ID = 'gift-shiny';

// ¿Tiene la calibración las direcciones del equipo y de las cajas? (las calibraciones anteriores no las tenían)
export const supportsGifts = (calibration) => Boolean(calibration) && [...GIFT_REQUIRED, ...SHINY_SLOTS.map((s) => s[1])].every((k) => Number.isInteger(calibration.found?.[k]));

// Shiny Hunting con probabilidad fija (1/N de SHINY_FIXED_ODDS; 1 = siempre) que además actúa sobre los regalos del equipo y de las cajas.
export function giftEvent(calibration, { oneIn = 1 } = {}) {
    return {
        id: GIFT_EVENT_ID,
        kind: 'card',
        label: `Regalos shiny (${oneIn === 1 ? 'siempre' : `1/${oneIn}`})`,
        build(game) {
            const cal = calibrationFor(calibration, game);
            if (!cal) return null;
            return buildGiftShinyPayload(cal.found, { gameCode: game.gameCode, revision: game.revision }, { oneIn });
        },
    };
}

// Calibración a partir del texto del informe de «Comprobar mi juego» (informe.json) o de una calibración ya guardada. Sirve para llevar la
// calibración de una ventana a otra (la ventana privada no comparte el almacenamiento con la normal).
export function parseCalibrationReport(text) {
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, error: 'no es un JSON válido' }; }
    if (json?.found && json.gameCode) {                                  // ya es una calibración
        const missing = REQUIRED.filter((k) => !Number.isInteger(json.found[k]));
        return missing.length ? { ok: false, error: `faltan direcciones: ${missing.join(', ')}` } : { ok: true, data: { gameCode: json.gameCode, revision: json.revision, found: json.found, savedAt: new Date().toISOString() } };
    }
    const shiny = json?.rom_facts?.shiny;
    if (!shiny?.found) return { ok: false, error: 'no parece el informe de «Comprobar mi juego» (falta rom_facts.shiny)' };
    const cal = calibrationFrom({ found: shiny.found, problems: shiny.problems ?? [], warnings: shiny.warnings ?? [] }, { game_code: json.game_code, revision: json.revision });
    if (!cal.ok) return { ok: false, error: cal.missing.length ? `faltan direcciones: ${cal.missing.join(', ')}` : cal.problems.length ? cal.problems.join('; ') : 'el juego no es Rojo Fuego ni Verde Hoja' };
    return { ok: true, data: cal.data };
}

// Qué tarjetas admite una calibración (para explicárselo al usuario).
export function calibrationSummary(calibration) {
    if (!calibration) return null;
    const have = (keys) => keys.every((k) => Number.isInteger(calibration.found?.[k]));
    return {
        shiny: true,
        balls: supportsUltra(calibration),
        keep: supportsKeep(calibration),
        gifts: supportsGifts(calibration),
        count: Object.keys(calibration.found ?? {}).length,
        missingForAll: ['gLastUsedItem', 'AddBagItem', ...GIFT_REQUIRED].filter((k) => !have([k])),
    };
}
