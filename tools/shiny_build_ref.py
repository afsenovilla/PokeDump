#!/usr/bin/env python3
"""Genera web/js/dump/shiny-ref.js: los patrones de referencia que busca el localizador del navegador.

Uso: shiny_build_ref.py PRET_DIR  (con pokefirered_rev1, pokefirered y pokeleafgreen_rev1 compilados:
     make firered_rev1 firered leafgreen_rev1 en pret/pokefirered, con agbcc instalado)
Los patrones salen de código de pret/pokefirered (dominio público: decompilación del juego).
"""
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
import shiny_symbols as S

BUILDS = ['pokefirered_rev1', 'pokefirered', 'pokeleafgreen_rev1']
out = {'funcs': {}, 'vars': {}}
for b in BUILDS:
    ref = S.build_reference(f'{sys.argv[1]}/{b}.elf', f'{sys.argv[1]}/{b}.gba')
    for name, (addr, code, mask) in ref['funcs'].items():
        v = {'code': bytes(code).hex(), 'mask': bytes(1 if m else 0 for m in mask).hex()}
        lst = out['funcs'].setdefault(name, [])
        if v not in lst: lst.append(v)
    for name, (target, anchors) in ref['vars'].items():
        lst = out['vars'].setdefault(name, [])
        for fname, faddr, code, mask, pool in anchors:
            v = {'code': bytes(code).hex(), 'mask': bytes(1 if m else 0 for m in mask).hex(), 'pool': pool}
            if v not in lst: lst.append(v)
dest = os.path.join(os.path.dirname(__file__), '..', 'web', 'js', 'dump', 'shiny-ref.js')
with open(dest, 'w') as f:
    f.write('// Patrones de referencia para localizar funciones y variables del juego (generado por tools/shiny_build_ref.py\n'
            '// a partir de pret/pokefirered; no editar a mano). `mask` marca con 1 los bytes que deben coincidir.\n'
            'export const SHINY_REF = ' + json.dumps(out, separators=(',', ':')) + ';\n')
print('escrito', dest, os.path.getsize(dest) // 1024, 'KB;', {k: len(v) for k, v in out['funcs'].items()}, {k: len(v) for k, v in out['vars'].items()})
