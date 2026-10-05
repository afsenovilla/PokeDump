#!/usr/bin/env python3
"""Extrae la ROM de GBA (.gba) de un NSP de Pokémon Rojo Fuego / Verde Hoja de Switch.

Todo ocurre en tu ordenador: el NSP y tus prod.keys no se envían a ningún sitio.

    python tools/extract_rom.py JUEGO.nsp --keys prod.keys --out rom.gba --report informe.json

El informe (informe.json) NO contiene la ROM ni claves: solo código de juego, revisión,
tamaño y sha1. Es lo único que hace falta compartir.

Derivado de tools/switch/{xci_read,romfs_read}.py de pokeldn (AGPL-3.0,
https://github.com/Warnster/pokeldn), que sigue las estructuras de hactool.
Un NSP de juego base tiene la ROM como único fichero del RomFS de su NCA "Program".
No soporta NSZ/XCZ (comprimidos) ni tickets personalizados (RSA).
"""
import argparse
import hashlib
import json
import os
import struct
import sys

try:
    from Crypto.Cipher import AES
except ImportError:  # pragma: no cover
    sys.exit("Falta pycryptodome. Instálalo con:  pip install pycryptodome")

SECTOR = 0x10
GAMES = {"BPR": "Rojo Fuego (FireRed)", "BPG": "Verde Hoja (LeafGreen)"}
LANGS = {"J": "japonés", "E": "inglés", "F": "francés", "D": "alemán", "I": "italiano", "S": "español"}


def load_keys(path):
    keys = {}
    with open(path) as fh:
        for line in fh:
            name, sep, value = line.partition("=")
            value = value.strip()
            if sep and len(value) in (32, 64) and all(c in "0123456789abcdefABCDEF" for c in value):
                keys[name.strip()] = bytes.fromhex(value)
    return keys


def _gf_mul(t):
    n = int.from_bytes(t, "little") << 1
    if n >> 128:
        n = (n ^ 0x87) & ((1 << 128) - 1)
    return n.to_bytes(16, "little")


def xts_crypt(key, data, decrypt=True, sector=0, sector_size=0x200):
    """AES-128-XTS de Nintendo: el tweak es el número de sector en big-endian."""
    data_ecb = AES.new(key[:16], AES.MODE_ECB)
    tweak_ecb = AES.new(key[16:], AES.MODE_ECB)
    out = bytearray()
    for i in range(0, len(data), sector_size):
        tweak = tweak_ecb.encrypt(struct.pack(">QQ", 0, sector + i // sector_size))
        for j in range(i, min(i + sector_size, len(data)), 16):
            block = bytes(a ^ b for a, b in zip(data[j:j + 16], tweak))
            block = data_ecb.decrypt(block) if decrypt else data_ecb.encrypt(block)
            out += bytes(a ^ b for a, b in zip(block, tweak))
            tweak = _gf_mul(tweak)
    return bytes(out)


class Pfs0:
    """Contenedor NSP (PFS0): lista de ficheros con desplazamientos absolutos."""

    def __init__(self, path):
        self.fh = open(path, "rb")
        head = self.read(0, 0x10)
        if head[:4] != b"PFS0":
            sys.exit(f"{path}: no es un NSP (falta la cabecera PFS0). "
                     "Si es .nsz/.xci, descomprímelo o conviértelo a NSP primero.")
        count, str_size = struct.unpack_from("<II", head, 4)
        table = self.read(0x10, count * 0x18)
        strings = self.read(0x10 + count * 0x18, str_size)
        data = 0x10 + count * 0x18 + str_size
        self.files = []
        for i in range(count):
            off, size, name_off = struct.unpack_from("<QQI", table, i * 0x18)
            name = strings[name_off:strings.index(b"\0", name_off)].decode()
            self.files.append((name, data + off, size))

    def read(self, off, size):
        self.fh.seek(off)
        return self.fh.read(size)


class CtrSection:
    """Ventana de lectura sobre una sección NCA AES-128-CTR (se descifra al leer)."""

    def __init__(self, container, nca_offset, section, key):
        self.c, self.nca_offset, self.section, self.key = container, nca_offset, section, key

    def read(self, offset, size):
        """`offset` relativo a la sección; el contador es relativo al NCA."""
        if size <= 0:
            return b""
        nca_off = self.section["offset"] + offset
        pad = nca_off % SECTOR
        aligned = nca_off - pad
        raw = self.c.read(self.nca_offset + aligned, pad + size)
        if len(raw) < pad + size:
            raise EOFError("el NSP está incompleto o truncado")
        ctr = self.section["ctr"] + struct.pack(">Q", aligned >> 4)
        clear = AES.new(self.key, AES.MODE_CTR, nonce=b"", initial_value=ctr).decrypt(raw)
        return clear[pad:pad + size]


def parse_fs_header(fs):
    s = {"fs_type": fs[2], "hash_type": fs[3], "crypt": fs[4],
         "ctr": fs[0x140:0x148][::-1], "data_offset": None}
    sb = fs[0x8:0x140]
    if s["hash_type"] == 3 and sb[:4] == b"IVFC":
        levels = struct.unpack_from("<I", sb, 0xC)[0]
        for i in range(min(levels, 6)):
            off, size, _blk, _r = struct.unpack_from("<QQII", sb, 0x10 + i * 0x18)
            if size:
                s["data_offset"] = off
    return s


def nca_header(container, off, header_key):
    clear = xts_crypt(header_key, container.read(off, 0xC00))
    if clear[0x200:0x203] != b"NCA":
        return None
    h = {"content_type": clear[0x205], "rights_id": clear[0x230:0x240],
         "key_area": clear[0x300:0x340], "sections": []}
    gen = max(clear[0x206], clear[0x220])
    h["keygen"] = gen - 1 if gen else 0
    for i in range(4):
        start, end = struct.unpack_from("<II", clear, 0x240 + i * 0x10)
        if end:
            s = parse_fs_header(clear[0x400 + i * 0x200:0x600 + i * 0x200])
            s["offset"] = start * 0x200
            h["sections"].append(s)
    return h


def section_key(h, keys, tickets):
    """Clave del cuerpo: área de claves (sin ticket) o clave de título del ticket."""
    if h["rights_id"] != bytes(16):
        name = f"titlekek_{h['keygen']:02x}"
        tik = tickets.get(h["rights_id"].hex())
        if name not in keys:
            raise SystemExit(f"Tu prod.keys no tiene {name}. Genera uno nuevo con Lockpick_RCM "
                             "desde una consola con firmware igual o más reciente que el del juego.")
        if tik is None:
            raise SystemExit(f"El NSP no trae el ticket {h['rights_id'].hex()}.tik.")
        return AES.new(keys[name], AES.MODE_ECB).decrypt(tik[0x180:0x190])
    name = f"key_area_key_application_{h['keygen']:02x}"
    if name not in keys:
        raise SystemExit(f"Tu prod.keys no tiene {name}. Genera uno nuevo con Lockpick_RCM.")
    return AES.new(keys[name], AES.MODE_ECB).decrypt(h["key_area"])[0x20:0x30]


class RomFs:
    def __init__(self, reader, romfs_offset):
        self.reader, self.base = reader, romfs_offset
        head = struct.unpack("<10Q", reader.read(romfs_offset, 0x50))
        if head[0] != 0x50:
            raise ValueError("RomFS ilegible: clave o contador incorrectos")
        (_, _, _, dir_off, dir_size, _, _, file_off, file_size, self.data_off) = head
        self.dirs = reader.read(romfs_offset + dir_off, dir_size)
        self.files = reader.read(romfs_offset + file_off, file_size)

    def walk(self):
        stack = [(0, "")]
        while stack:
            d, prefix = stack.pop()
            _p, _s, child_dir, child_file, _h, _n = struct.unpack_from("<6I", self.dirs, d)
            off = child_file
            while off != 0xFFFFFFFF:
                _p, sibling, data_off, size = struct.unpack_from("<2I2Q", self.files, off)
                name_len = struct.unpack_from("<I", self.files, off + 28)[0]
                name = self.files[off + 32:off + 32 + name_len].decode("utf-8", "replace")
                yield prefix + "/" + name, data_off, size
                off = sibling
            off = child_dir
            while off != 0xFFFFFFFF:
                _p, sibling, _cd, _cf, _h, name_len = struct.unpack_from("<6I", self.dirs, off)
                stack.append((off, prefix + "/" + self.dirs[off + 24:off + 24 + name_len].decode()))
                off = sibling

    def read_file(self, data_off, size):
        return self.reader.read(self.base + self.data_off + data_off, size)


def check_gba_header(rom):
    """Valida la cabecera GBA (suma de comprobación en 0xBD) y devuelve sus datos."""
    if len(rom) < 0xC0:
        raise ValueError("fichero demasiado pequeño para ser una ROM de GBA")
    chk = (-sum(rom[0xA0:0xBD]) - 0x19) & 0xFF
    return {"title": rom[0xA0:0xAC].decode("ascii", "replace").rstrip("\0"),
            "game_code": rom[0xAC:0xB0].decode("ascii", "replace"),
            "revision": rom[0xBC], "header_checksum_ok": chk == rom[0xBD]}


def extract(nsp_path, keys, want_ext=".gba"):
    if "header_key" not in keys:
        raise SystemExit("Tu prod.keys no contiene header_key.")
    c = Pfs0(nsp_path)
    tickets = {n[:-4]: c.read(o, s) for n, o, s in c.files if n.endswith(".tik")}
    seen = []
    for name, off, _size in c.files:
        if not name.endswith(".nca") or name.endswith(".cnmt.nca"):
            continue
        h = nca_header(c, off, keys["header_key"])
        if h is None:
            raise SystemExit(f"{name}: la cabecera no descifra. ¿Es tu header_key correcta?")
        if h["content_type"] != 0:           # solo "Program"
            continue
        key = section_key(h, keys, tickets)
        for s in h["sections"]:
            if s["fs_type"] != 0 or s["crypt"] != 3 or s["data_offset"] is None:
                continue
            fs = RomFs(CtrSection(c, off, s, key), s["data_offset"])
            for path, doff, size in fs.walk():
                seen.append(path)
                if path.lower().endswith(want_ext):
                    return path, fs.read_file(doff, size)
    raise SystemExit("No encontré ninguna ROM .gba en el NSP. Ficheros vistos en el RomFS: "
                     + (", ".join(seen) or "ninguno"))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("nsp", help="el NSP de Rojo Fuego o Verde Hoja")
    ap.add_argument("--keys", default=os.path.expanduser("~/.switch/prod.keys"), help="ruta de prod.keys")
    ap.add_argument("--out", default="rom.gba", help="dónde guardar la ROM")
    ap.add_argument("--report", default="informe.json", help="informe sin contenido protegido")
    args = ap.parse_args(argv)

    path, rom = extract(args.nsp, load_keys(args.keys))
    info = check_gba_header(rom)
    with open(args.out, "wb") as fh:
        fh.write(rom)
    report = {"romfs_path": path, "size": len(rom), "sha1": hashlib.sha1(rom).hexdigest(), **info}
    with open(args.report, "w") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    code = info["game_code"]
    print(f"ROM: {path}  ({len(rom):,} bytes)  -> {args.out}")
    print(f"Juego: {GAMES.get(code[:3], '¿?')}, idioma {LANGS.get(code[3:], '¿?')}, "
          f"código {code}, revisión {info['revision']:#04x}")
    print(f"Cabecera GBA válida: {'sí' if info['header_checksum_ok'] else 'NO (¡algo falló!)'}")
    print(f"sha1: {report['sha1']}\nInforme (compartible): {args.report}")
    return 0 if info["header_checksum_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
