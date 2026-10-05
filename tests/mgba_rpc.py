"""Puente JSON por stdin/stdout: ejecuta el payload REAL en mGBA contra memoria de juego dada.

Lo usa tests/dump/fake-client.mjs como «consola» para probar de extremo a extremo el servidor
de volcado (JS) con el código ARM de verdad. Órdenes (una por línea, JSON):
  {"cmd":"init","sb2":hex,"sb1":hex,"storage":hex,"layout":"english|french","sabotage":null|...}
  {"cmd":"pass","code":hex,"param":int}  -> {"param":int,"sent":hex,"ret":int}
"""
import json
import sys

from mgba_harness import CLIENT, DECOMP, FakeGame, Machine, build_payload, build_rom

build_payload()
machine = game = None


def init(req):
    global machine, game
    machine = Machine(build_rom(code=req.get("gameCode", "BPRS").encode(), revision=req.get("revision", 10)))
    game = FakeGame(machine, layout=req.get("layout", "english"), sabotage=req.get("sabotage"))
    for base, key in ((game.SB2, "sb2"), (game.SB1, "sb1"), (game.STORAGE, "storage")):
        machine.w8(base, bytes.fromhex(req[key]))
    return {"ok": True}


def run_pass(req):
    m = machine
    code = bytes.fromhex(req["code"])
    m.w8(DECOMP, code)
    m.w32(CLIENT, req["param"])
    m.w32(CLIENT + 0x3C, CLIENT)           # LOAD_TOSS_RESPONSE: envía &param, 4 bytes
    m.mem.u16[CLIENT + 0x34] = 4
    ret = m.call(CLIENT, game.SB2, game.SB1, game.lr | 1)
    size = m.mem.u16[CLIENT + 0x34]
    buf = m.r32(CLIENT + 0x3C)
    return {"param": m.r32(CLIENT), "sent": m.r8(buf, size).hex(), "ret": ret}


for raw in sys.stdin:
    req = json.loads(raw)
    out = init(req) if req["cmd"] == "init" else run_pass(req)
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
