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

export function loadCalibration() {
    try {
        const data = JSON.parse(localStorage.getItem(KEY) ?? 'null');
        return data && REQUIRED.every((k) => Number.isInteger(data.found?.[k])) ? data : null;
    } catch { return null; }
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
            if (game.gameCode !== calibration.gameCode || game.revision !== calibration.revision) return null;
            const { card, script } = buildShinyPayload(calibration.found, { gameCode: game.gameCode, revision: game.revision }, { oneIn });
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
            if (game.gameCode !== calibration.gameCode || game.revision !== calibration.revision) return null;
            return buildUltraBallPayload(calibration.found, { gameCode: game.gameCode, revision: game.revision }, { balls, keep, shiny });
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
            if (game.gameCode !== calibration.gameCode || game.revision !== calibration.revision) return null;
            return buildGiftShinyPayload(calibration.found, { gameCode: game.gameCode, revision: game.revision }, { oneIn });
        },
    };
}
