"""Escribe un NSP sintético (sin contenido de Nintendo), su prod.keys y la ROM de prueba en un directorio.
Uso: python3 tests/make_nsp.py DIR [con_ticket]   (lo usa tests/dump/nsp.test.mjs)"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from test_extract_rom import build_nsp, fake_rom, HEADER_KEY, KAEK, TITLEKEK  # noqa: E402

out, ticket = sys.argv[1], len(sys.argv) > 2
rom = fake_rom()
open(os.path.join(out, "juego.nsp"), "wb").write(build_nsp(rom, ticket))
open(os.path.join(out, "rom.gba"), "wb").write(rom)
open(os.path.join(out, "prod.keys"), "w").write(
    f"header_key = {HEADER_KEY.hex()}\nkey_area_key_application_01 = {KAEK.hex()}\n"
    f"titlekek_01 = {TITLEKEK.hex()}\n")
