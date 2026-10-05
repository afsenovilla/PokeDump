"""El payload ramdump.s ejecutado en la CPU ARM de mGBA contra memoria de juego sintética."""
import struct

import pytest

mgba = pytest.importorskip("mgba.core")
from mgba_harness import CLIENT, DECOMP, FakeGame, Machine, build_payload, build_rom  # noqa: E402

P_END = 54


@pytest.fixture(scope="module")
def payload():
    return build_payload()


def run_dump(payload, **kw):
    m = Machine(build_rom(code=b"BPRS"))
    g = FakeGame(m, **kw)
    sent = [g.pass_(payload)[0] for _ in range(P_END)]
    return m, g, sent


def test_payload_size(payload):
    assert len(payload) <= 1024 - 64      # cabe de sobra en un mensaje RAM_SCRIPT


@pytest.mark.parametrize("layout,order", [("english", "sb2_sb1"), ("french", "sb2_sb1"), ("english", "sb1_sb2")])
def test_full_dump(payload, layout, order):
    m, g, sent = run_dump(payload, layout=layout, pool_order=order)
    h = struct.unpack("<15I", sent[0][:60])
    assert len(sent[0]) == 64
    assert h[0] == 0x50444B50 and h[1] == 1
    assert (h[2], h[3], h[4]) == (g.SB2, g.SB1, g.STORAGE)
    assert h[6] == 0                                         # status
    assert h[12] == int.from_bytes(b"BPRS", "little") and h[13] == 0x0A
    assert h[5] == g.ptrs[2]                                 # &gPokemonStoragePtr
    out = b"".join(sent[1:])
    assert out == b"".join(g.regions)
    assert [len(s) for s in sent[1:5]] == [1024, 1024, 1024, 0xF24 - 3072]
    m.close()


def test_never_writes_game_memory(payload):
    m = Machine(build_rom())
    g = FakeGame(m)
    before = m.snapshot()
    for _ in range(P_END):
        g.pass_(payload)
    after = m.snapshot()
    allowed = [
        (DECOMP, DECOMP + 0x800),                  # imagen del payload + cabecera (gDecompressionBuffer)
        (CLIENT, CLIENT + 0x40),                   # client->param y campos de envío
        (0x03007000, 0x03008000),                  # orden del arnés y pila
        (0x02010000, 0x02010100),                  # el «Client_RunBufferScript» falso (lo escribe el arnés)
    ]
    bad = []
    for key, base in (("ewram", 0x02000000), ("iwram", 0x03000000)):
        for i, (a, b) in enumerate(zip(before[key], after[key])):
            if a != b and not any(lo <= base + i < hi for lo, hi in allowed):
                bad.append(hex(base + i))
    assert not bad, f"el payload escribió fuera de lo permitido: {bad[:10]}"
    m.close()


@pytest.mark.parametrize("sab,status", [("nopool", 1), ("pointer", 2), ("storage", 3)])
def test_validation_failures_skip_storage(payload, sab, status):
    m, g, sent = run_dump(payload, sabotage=sab)
    h = struct.unpack("<15I", sent[0][:60])
    assert h[6] == status and h[4] == 0
    assert all(len(s) == 4 for s in sent[21:])               # nada del almacenamiento
    m.close()


def test_resume_and_overrun(payload):
    m = Machine(build_rom())
    g = FakeGame(m)
    patched = bytearray(payload)
    patched[4:8] = (21).to_bytes(4, "little")                # empezar por el almacenamiento
    data, _ = g.pass_(bytes(patched))
    assert data == g.regions[2][:1024]
    # pasadas de más: se queda el mensaje de 4 bytes
    for _ in range(40):
        data, _ = g.pass_(payload)
    assert len(data) == 4
    m.close()
