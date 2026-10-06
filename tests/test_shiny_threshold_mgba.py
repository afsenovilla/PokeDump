"""Umbral de shiny de la tarjeta Shiny Hunting (parches de probabilidad fija y de «R alterna siempre shiny»), en el núcleo de mGBA.

Se ejecuta tal cual el trozo de Thumb del gancho que calcula el umbral (de `movs r2,#0` a `lsls r2,r2,#5`, ya parcheado)
con el estado del gancho en memoria y se lee r2, que es lo que luego se compara con (PID ^ ID ^ …) de 16 bits.
"""
import json
import os
import subprocess

import pytest

from mgba_harness import Machine, build_rom

HERE = os.path.dirname(os.path.abspath(__file__))
CODE_AT, STATE_AT = 0x02010100, 0x02010200
REGION_AT, REGION_LEN = 0x23c, 0x12


def region(one_in):
    js = (
        "import('./web/js/dump/shiny.js').then(m=>{const f={};for(const [,k] of m.SHINY_SLOTS)f[k]=0x08001000;"
        f"const o={json.dumps(one_in)};"
        "const {script}=m.buildShinyPayload(f,{gameCode:'BPRE',revision:10},{oneIn:o});"
        f"console.log(Buffer.from(script.slice({REGION_AT},{REGION_AT + REGION_LEN})).toString('hex'))}})"
    )
    out = subprocess.run(["node", "-e", js], cwd=os.path.join(HERE, ".."), capture_output=True, text=True, check=True).stdout
    return bytes.fromhex(out.strip())


def threshold(machine, code, chain, flag):
    arm = (0xE28FC001).to_bytes(4, "little") + (0xE12FFF1C).to_bytes(4, "little")        # add r12,pc,#1 ; bx r12 (a Thumb en CODE_AT+8)
    machine.w8(CODE_AT, arm + bytes.fromhex("0400") + code + bytes.fromhex("1000" "7047"))   # movs r4,r0 ; región ; movs r0,r2 ; bx lr
    machine.w8(CODE_AT + 0x40, (0x4738).to_bytes(2, "little"))                          # bx r7 (destino de lr)
    machine.mem.u16[STATE_AT + 2] = flag
    machine.mem.u16[STATE_AT + 4] = chain
    machine.mem.u16[STATE_AT + 6] = 0x1234
    return machine.call(STATE_AT, 0, 0, (CODE_AT + 0x40) | 1, target=CODE_AT)


@pytest.fixture(scope="module")
def machine():
    m = Machine(build_rom())
    yield m
    m.close()


@pytest.mark.parametrize("chain,expected", [(0, 64), (5, 224), (30, 1024), (99, 1024)])
def test_toggle_off_keeps_chain_odds(machine, chain, expected):
    assert threshold(machine, region("toggle"), chain, 0) == expected


@pytest.mark.parametrize("chain", [0, 7, 30, 500])
def test_toggle_on_is_always_shiny(machine, chain):
    assert threshold(machine, region("toggle"), chain, 1) >= 0x10000


@pytest.mark.parametrize("n", [64, 16, 4, 1])
def test_fixed_odds(machine, n):
    assert threshold(machine, region(n), 3, 0) == 65536 // n
