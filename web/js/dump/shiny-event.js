// El evento «Shiny Hunting» de la página principal: usa las direcciones que la página de extracción
// encontró en la ROM del usuario (se guardan en el navegador) para adaptar la tarjeta a su juego.

import { SHINY_SLOTS, ULTRA_REQUIRED, buildLegendaryPayload, buildShinyPayload, buildUltraBallPayload } from './shiny.js';

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
export const legendaryEvent = {
    id: LEGENDARY_EVENT_ID,
    kind: 'card',
    label: 'Legendarios: reaparecer MEWTWO y las aves',
    build(game) {
        if (!/^BP[RG][A-Z]$/.test(game.gameCode)) return null;
        return buildLegendaryPayload(game);
    },
};

export const ULTRA_EVENT_ID = 'ultra-master';

// ¿Tiene la calibración guardada todo lo que necesita la tarjeta de bolas? (las calibraciones anteriores no tenían gLastUsedItem)
export const supportsUltra = (calibration) => Boolean(calibration) && ULTRA_REQUIRED.every((k) => Number.isInteger(calibration.found?.[k]));

export function ultraEvent(calibration, { balls = 'ultra' } = {}) {
    return {
        id: ULTRA_EVENT_ID,
        kind: 'card',
        label: 'Ultra Ball = Master Ball',
        build(game) {
            if (game.gameCode !== calibration.gameCode || game.revision !== calibration.revision) return null;
            return buildUltraBallPayload(calibration.found, { gameCode: game.gameCode, revision: game.revision }, { balls });
        },
    };
}
