// Equipo de seis huecos que se ofrece a la Switch. Se guarda en localStorage del navegador.

import { fromHex, toHex } from './bytes.js';
import { Pk3, parse } from './pk3.js';

const STORE = 'pokedump-party';

export class Party {
    constructor() {
        this.slots = [null, null, null, null, null, null];
        this.selected = 0;
    }

    get occupied() { return this.slots.filter(Boolean).length; }
    get canTrade() { return this.occupied >= 2 && Boolean(this.slots[this.selected]); }

    read(record) {
        const entries = record.slots;
        if (!Array.isArray(entries) || entries.length !== 6) throw new Error('Un equipo guardado necesita seis huecos.');
        this.slots = entries.map((entry) => (entry ? parse(fromHex(entry.toLowerCase())) : null));
        this.selected = Number(record.selected) || 0;
        if (!this.slots[this.selected]) this.selected = this.slots.findIndex(Boolean);
        if (this.selected < 0) this.selected = 0;
    }

    // Carga el equipo guardado, si lo hay.
    load() {
        let saved = null;
        try { saved = localStorage.getItem(STORE); } catch {}
        if (!saved) return 'empty';
        try { this.read(JSON.parse(saved)); return 'saved'; }
        catch { try { localStorage.removeItem(STORE); } catch {} return 'empty'; }
    }

    save() {
        try { localStorage.setItem(STORE, JSON.stringify(this.record())); } catch {}
    }

    record() {
        return { selected: this.selected, slots: this.slots.map((pk) => (pk ? toHex(pk.export()) : null)) };
    }

    export() { return this.slots.map((pk) => (pk ? pk.export() : null)); }

    set(index, pk) {
        this.slots[index] = pk;
        if (!this.slots[this.selected]) this.selected = this.slots.findIndex(Boolean);
        if (this.selected < 0) this.selected = 0;
        this.save();
    }

    select(index) {
        if (!this.slots[index]) return false;
        this.selected = index;
        this.save();
        return true;
    }

    // Guarda el Pokémon recibido en el hueco del que salió.
    receive(index, bytes) {
        this.slots[index] = parse(bytes);
        this.save();
    }
}

export function describe(pk) {
    const kind = pk.isEgg ? 'Huevo' : pk.speciesName;
    const gender = pk.gender === 0 ? '♂' : pk.gender === 1 ? '♀' : '';
    return { name: pk.isEgg ? 'Huevo' : pk.nickname || kind, kind, level: pk.isEgg ? '' : `Lv. ${pk.level}`, gender, shiny: pk.isShiny && !pk.isEgg };
}

export { Pk3 };
