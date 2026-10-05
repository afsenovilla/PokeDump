"""Prueba de tools/extract_rom.py con un NSP sintético (sin ningún contenido de Nintendo)."""
import hashlib
import os
import struct
import sys

import pytest
from Crypto.Cipher import AES

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import extract_rom as ex  # noqa: E402

HEADER_KEY = bytes(range(32))
KAEK = bytes(range(100, 116))
TITLEKEK = bytes(range(200, 216))
BODY_KEY = bytes(range(50, 66))


def fake_rom(code=b"BPRS"):
    rom = bytearray(0x2000)
    rom[0xA0:0xAC] = b"POKEMON FIRE"
    rom[0xAC:0xB0] = code
    rom[0xBC] = 0x0A
    rom[0xBD] = (-sum(rom[0xA0:0xBD]) - 0x19) & 0xFF
    return bytes(rom)


def romfs(name, data):
    nm = name.encode()
    root = struct.pack("<6I", 0, 0xFFFFFFFF, 0xFFFFFFFF, 0, 0xFFFFFFFF, 0)
    fent = struct.pack("<2I2Q2I", 0, 0xFFFFFFFF, 0, len(data), 0xFFFFFFFF, len(nm)) + nm
    fent += bytes(-len(fent) % 4)
    hdr_len = 0x50
    dmeta, fmeta = hdr_len, hdr_len + len(root)
    data_off = (fmeta + len(fent) + 0xF) & ~0xF
    hdr = struct.pack("<10Q", 0x50, 0, 0, dmeta, len(root), 0, 0, fmeta, len(fent), data_off)
    blob = bytearray(hdr + root + fent)
    blob += bytes(data_off - len(blob)) + data
    return bytes(blob)


def build_nsp(rom, with_ticket):
    ctr_high = bytes([1, 2, 3, 4, 5, 6, 7, 8])
    level5 = 0x4000
    section = bytearray(level5) + romfs("rom.gba", rom)
    section += bytes(-len(section) % 0x200)
    # cifrado CTR de la sección (NCA = 0xC00 de cabecera + sección)
    ct = bytearray()
    for pos in range(0, len(section), 0x10):
        nca_off = 0xC00 + pos
        ctr = ctr_high + struct.pack(">Q", nca_off >> 4)
        ct += AES.new(BODY_KEY, AES.MODE_CTR, nonce=b"", initial_value=ctr).encrypt(bytes(section[pos:pos + 16]))

    hdr = bytearray(0xC00)
    hdr[0x200:0x204] = b"NCA3"
    hdr[0x205] = 0
    hdr[0x206] = 2                      # generación 2 -> keygen 1 (clave _01)
    hdr[0x207] = 0
    rights = bytes([0xAA] * 15 + [1]) if with_ticket else bytes(16)
    hdr[0x230:0x240] = rights
    struct.pack_into("<II", hdr, 0x240, 6, 6 + len(section) // 0x200)
    keyarea = bytearray(0x40)
    keyarea[0x20:0x30] = BODY_KEY
    hdr[0x300:0x340] = AES.new(KAEK, AES.MODE_ECB).encrypt(bytes(keyarea))
    fs = bytearray(0x200)
    fs[2], fs[3], fs[4] = 0, 3, 3
    fs[0x8:0xC] = b"IVFC"
    struct.pack_into("<I", fs, 0x8 + 0xC, 6)  # num_levels en superbloque+0xC
    struct.pack_into("<QQII", fs, 0x8 + 0x10 + 5 * 0x18, level5, len(section) - level5, 0, 0)
    fs[0x140:0x148] = ctr_high[::-1]
    hdr[0x400:0x600] = fs
    nca = ex.xts_crypt(HEADER_KEY, bytes(hdr), decrypt=False) + bytes(ct)

    files = [("0123.nca", nca)]
    if with_ticket:
        tik = bytearray(0x2C0)
        tik[0x180:0x190] = AES.new(TITLEKEK, AES.MODE_ECB).encrypt(BODY_KEY)
        files.append((rights.hex() + ".tik", bytes(tik)))
    strings = b"".join(n.encode() + b"\0" for n, _ in files)
    table, off, name_off = b"", 0, 0
    for n, d in files:
        table += struct.pack("<QQII", off, len(d), name_off, 0)
        off += len(d)
        name_off += len(n) + 1
    head = b"PFS0" + struct.pack("<II", len(files), len(strings)) + bytes(4) + table + strings
    return head + b"".join(d for _, d in files)


def keys_file(tmp_path):
    p = tmp_path / "prod.keys"
    p.write_text(
        f"header_key = {HEADER_KEY.hex()}\n"
        f"key_area_key_application_01 = {KAEK.hex()}\n"
        f"titlekek_01 = {TITLEKEK.hex()}\n"
        "linea_basura = 123\n")
    return str(p)


@pytest.mark.parametrize("with_ticket", [False, True])
def test_extract_roundtrip(tmp_path, with_ticket):
    rom = fake_rom()
    nsp = tmp_path / "juego.nsp"
    nsp.write_bytes(build_nsp(rom, with_ticket))
    out, rep = tmp_path / "rom.gba", tmp_path / "informe.json"
    code = ex.main([str(nsp), "--keys", keys_file(tmp_path), "--out", str(out), "--report", str(rep)])
    assert code == 0
    assert out.read_bytes() == rom
    assert hashlib.sha1(rom).hexdigest() in rep.read_text()
    assert '"game_code": "BPRS"' in rep.read_text()


def test_wrong_header_key(tmp_path):
    nsp = tmp_path / "juego.nsp"
    nsp.write_bytes(build_nsp(fake_rom(), False))
    bad = tmp_path / "bad.keys"
    bad.write_text("header_key = " + "00" * 32 + "\n")
    with pytest.raises(SystemExit):
        ex.extract(str(nsp), ex.load_keys(str(bad)))
