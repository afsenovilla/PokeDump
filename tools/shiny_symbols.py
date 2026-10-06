#!/usr/bin/env python3
"""Localizador de símbolos para la tarjeta Shiny Hunting.

Referencia: una compilación de pret/pokefirered (ELF + .gba). Para cada función que necesita
la tarjeta se saca su patrón de bytes (con las direcciones y los `bl` enmascarados) y se busca
en otra ROM. Las variables se leen del pool de literales de una función que las usa.

Uso de prueba:  shiny_symbols.py REF.elf REF.gba TARGET.gba [TARGET.elf]
"""
import struct, subprocess, sys

# nombre -> símbolo de pret
FUNCS = {
    'Random': 'Random', 'GetMonData': 'GetMonData3', 'SetMonData': 'SetMonData',
    'CalculateMonStats': 'CalculateMonStats', 'ScriptContext_SetupScript': 'ScriptContext_SetupScript',
    'CB1_Overworld': 'CB1_Overworld', 'CB2_Overworld': 'CB2_Overworld',
    'SetActionsAndBattlersTurnOrder': 'SetActionsAndBattlersTurnOrder', 'DismissMapNamePopup': 'DismissMapNamePopup',
    'AddBagItem': 'AddBagItem',
}
VARS = {   # nombre -> símbolo de pret (dirección que se busca en la ROM destino)
    'gMain': 'gMain', 'gIntrTable': 'gIntrTable', 'gBattleMainFunc': 'gBattleMainFunc',
    'gEnemyParty': 'gEnemyParty', 'gBattleTypeFlags': 'gBattleTypeFlags', 'gBattleOutcome': 'gBattleOutcome',
    'gChosenActionByBattler': 'gChosenActionByBattler', 'gQuestLogState': 'gQuestLogState',
    'gSpecialVar_0x8004': 'gSpecialVar_0x8004', 'sLockFieldControls': 'sLockFieldControls',
    'sGlobalScriptContextStatus': 'sGlobalScriptContextStatus', 'sGlobalScriptContext': 'sGlobalScriptContext',
    'gSaveBlock2Ptr': 'gSaveBlock2Ptr', 'gLastUsedItem': 'gLastUsedItem',
    'gPlayerPartyCount': 'gPlayerPartyCount', 'gPlayerParty': 'gPlayerParty', 'gPokemonStoragePtr': 'gPokemonStoragePtr',
}
ROM_BASE = 0x08000000
MAX_ANCHORS = 3


def read_syms(elf):
    out = subprocess.run(['arm-none-eabi-nm', '-S', '-n', elf], capture_output=True, text=True, check=True).stdout
    syms = {}
    for line in out.splitlines():
        p = line.split()
        if len(p) == 4:
            syms[p[3]] = (int(p[0], 16), int(p[1], 16), p[2])
        elif len(p) == 3:
            syms[p[2]] = (int(p[0], 16), 0, p[1])
    return syms


def thumb_mask(code, addr):
    """-> (máscara bool por byte, lista de (offset_instr, offset_pool)) para un trozo Thumb."""
    n = len(code)
    mask = [True] * n
    loads = []
    i = 0
    while i + 1 < n:
        hw = struct.unpack_from('<H', code, i)[0]
        if 0xF000 <= hw < 0xF800 and i + 3 < n and 0xF800 <= struct.unpack_from('<H', code, i + 2)[0] < 0x10000:
            for k in range(4): mask[i + k] = False
            i += 4
            continue
        if 0x4800 <= hw < 0x5000:
            pool = ((addr + i + 4) & ~3) + (hw & 0xFF) * 4 - addr
            if 0 <= pool + 3 < n:
                for k in range(4): mask[pool + k] = False
                loads.append((i, pool))
        i += 2
    # palabras alineadas con aspecto de dirección (tablas de salto, punteros): cambian entre compilaciones
    base = (-addr) % 4
    for k in range(base, n - 3, 4):
        w = struct.unpack_from('<I', code, k)[0]
        hi = w >> 24
        if (hi == 8 and (w & 0xFFFFFF) < 0x2000000) or (hi == 2 and (w & 0xFFFFFF) < 0x40000) or (hi == 3 and (w & 0xFFFFFF) < 0x8000):
            for j in range(4): mask[k + j] = False
    return mask, loads


def find(rom, code, mask, limit=3):
    anchors = [k for k in range(len(code) - 4) if mask[k] and mask[k + 1] and mask[k + 2] and mask[k + 3]]
    a0 = anchors[0]
    seed = bytes(code[a0:a0 + 4])
    hits = []
    pos = rom.find(seed)
    while pos >= 0 and len(hits) <= limit:
        start = pos - a0
        if start >= 0 and start + len(code) <= len(rom) and start % 2 == 0:
            if all((not mask[k]) or rom[start + k] == code[k] for k in range(len(code))):
                hits.append(start)
        pos = rom.find(seed, pos + 1)
    return hits


def build_reference(elf, gba):
    syms = read_syms(elf)
    rom = open(gba, 'rb').read()
    ref = {'funcs': {}, 'vars': {}}
    for name, sym in FUNCS.items():
        addr, size, _ = syms[sym]
        off = addr - ROM_BASE
        code = rom[off:off + size]
        mask, _ = thumb_mask(code, addr & ~1)
        ref['funcs'][name] = (addr, code, mask)
    # variables: función de referencia (la más corta con patrón único) que carga la dirección
    LINKY = ('rfu', 'link', 'serial', 'multiboot', 'cable', 'wireless', 'mystery', 'mevent', 'mg_', 'union', 'mevent', 'trade', 'cmd_endlink', 'recordmix', 'berrycrush', 'minigame', 'pokemoncenter_link', 'battletower', 'initrfu', 'rfu')
    funcs = [(s, v) for s, v in syms.items() if v[2] in 'Tt' and v[1] >= 8 and ROM_BASE <= v[0] < ROM_BASE + len(rom)
             and not any(x in s.lower() for x in LINKY)]
    for name, sym in VARS.items():
        target = syms[sym][0]
        found = []
        for extra in (0, 16, 32, 64):          # bytes de más a cada lado (funciones contiguas)
            for fname, (faddr, fsize, _) in sorted(funcs, key=lambda kv: kv[1][1]):
                a = (faddr & ~1) - ROM_BASE
                lo, hi = max(0, a - extra), a + fsize + extra
                code = rom[lo:hi]
                mask, loads = thumb_mask(code, ROM_BASE + lo)
                hit = [(i, p) for i, p in loads if struct.unpack_from('<I', code, p)[0] == target and lo + i >= a and lo + i < a + fsize]
                if not hit: continue
                if sum(mask) < 24: continue
                if len(find(rom, code, mask)) != 1: continue
                if any(f[0] == fname for f in found): continue
                found.append((fname, faddr, code, mask, hit[0][1]))
                if len(found) == MAX_ANCHORS: break
            if len(found) == MAX_ANCHORS: break
        ref['vars'][name] = (target, found)
    return ref


def locate(ref, rom):
    res = {'funcs': {}, 'vars': {}, 'problems': []}
    for name, (addr, code, mask) in ref['funcs'].items():
        hits = find(rom, code, mask)
        if len(hits) == 1: res['funcs'][name] = ROM_BASE + hits[0] + (addr & 1)
        elif name == 'Random' and len(hits) == 2: res['funcs'][name] = ROM_BASE + hits[0] + (addr & 1)   # Random y Random2 son idénticas; la primera
        else: res['problems'].append(f'{name}: {len(hits)} coincidencias')
    for name, (target, anchors) in ref['vars'].items():
        if not anchors: res['problems'].append(f'{name}: sin función de referencia'); continue
        values = []
        for fname, faddr, code, mask, pool in anchors:
            hits = find(rom, code, mask)
            if len(hits) == 1: values.append((fname, struct.unpack_from('<I', rom, hits[0] + pool)[0]))
        if not values: res['problems'].append(f'{name}: ninguna ancla encontrada'); continue
        counts = {}
        for _, v in values: counts[v] = counts.get(v, 0) + 1
        best = max(counts, key=counts.get)
        if len(counts) > 1: res['problems'].append(f'{name}: las anclas no coinciden {values}')
        res['vars'][name] = best
    return res


if __name__ == '__main__':
    ref = build_reference(sys.argv[1], sys.argv[2])
    rom = open(sys.argv[3], 'rb').read()
    res = locate(ref, rom)
    expect = None
    if len(sys.argv) > 4:
        s = read_syms(sys.argv[4])
        expect = {**{n: s[FUNCS[n]][0] for n in FUNCS}, **{n: s[VARS[n]][0] for n in VARS}}
    for k, v in {**res['funcs'], **res['vars']}.items():
        mark = '' if expect is None else ('  OK' if expect[k] == v else f'  ✗ esperado {expect[k]:08x}')
        print(f'{k:34s} {v:08x}{mark}')
    for p in res['problems']: print('PROBLEMA', p)
    print('anclas:', {n: [a[0] for a in b] for n, (t, b) in ref['vars'].items()})
