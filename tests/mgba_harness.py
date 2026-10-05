"""Arnés para ejecutar payloads de Mystery Gift en el núcleo de mGBA (bindings de Python).

El núcleo es el de mGBA: la CPU ARM7TDMI es la emulada de verdad. Lo que se simula es el
cliente de Mystery Gift de la consola: se restaura la imagen del payload en gDecompressionBuffer
en cada pasada (como hace CLI_RUN_BUFFER_SCRIPT), se prepara el mensaje de 4 bytes de
CLI_LOAD_TOSS_RESPONSE y se lee lo que CLI_SEND_LOADED enviaría.

Un programa mínimo en la ROM de prueba espera una «orden» en IWRAM (0x03007000), carga r0-r2 y lr
y salta al payload; el payload vuelve a una instrucción Thumb `bx r7` situada en `lr`, que lo
devuelve al programa. Así la CPU nunca se reposiciona a mano.
"""
import os
import subprocess
import tempfile

import mgba.core

HERE = os.path.dirname(os.path.abspath(__file__))
PAYLOAD_DIR = os.path.join(HERE, "..", "payload")

MAILBOX = 0x03007000          # r0,r1,r2,lr,target,go,done,ret
DECOMP = 0x0201C000
CLIENT = 0x03005000           # &client->param (campos de envío en +0x34 y +0x3C)
CALLER = 0x02010000           # «Client_RunBufferScript» falsa, con su pool de literales

STUB_ASM = """
    .arm
    .text
    .global _start
_start:
    ldr     r3, =0x03007000
wait_go:
    ldr     r0, [r3, #20]
    cmp     r0, #0
    beq     wait_go
    mov     r0, #0
    str     r0, [r3, #20]
    ldr     r7, =back
    ldmia   r3, {r0, r1, r2, lr}
    ldr     pc, [r3, #16]
back:
    ldr     r3, =0x03007000
    str     r0, [r3, #28]
    mov     r0, #1
    str     r0, [r3, #24]
    b       wait_go
    .ltorg
"""


def build_payload():
    subprocess.run([os.path.join(PAYLOAD_DIR, "build.sh")], check=True, capture_output=True)
    with open(os.path.join(PAYLOAD_DIR, "ramdump.bin"), "rb") as fh:
        return fh.read()


def build_rom(code=b"BPRS", revision=0x0A):
    with tempfile.TemporaryDirectory() as tmp:
        src, obj, elf, binf = (os.path.join(tmp, n) for n in ("s.s", "s.o", "s.elf", "s.bin"))
        with open(src, "w") as fh:
            fh.write(STUB_ASM)
        subprocess.run(["arm-none-eabi-as", "-mcpu=arm7tdmi", "-o", obj, src], check=True)
        subprocess.run(["arm-none-eabi-ld", "-Ttext=0x080000C0", "-o", elf, obj], check=True)
        subprocess.run(["arm-none-eabi-objcopy", "-O", "binary", elf, binf], check=True)
        stub = open(binf, "rb").read()
    rom = bytearray(0xC0 + len(stub) + 0x40)
    rom[0:4] = (0xEA000000 | ((0xC0 - 8) >> 2)).to_bytes(4, "little")   # b 0x080000C0
    rom[0xA0:0xAC] = b"POKEMON FIRE"
    rom[0xAC:0xB0] = code
    rom[0xB2] = 0x96
    rom[0xBC] = revision
    rom[0xBD] = (-sum(rom[0xA0:0xBD]) - 0x19) & 0xFF
    rom[0xC0:0xC0 + len(stub)] = stub
    return bytes(rom)


class Machine:
    def __init__(self, rom_bytes):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".gba", delete=False)
        self.tmp.write(rom_bytes)
        self.tmp.close()
        self.core = mgba.core.load_path(self.tmp.name)
        self.core.reset()
        self.mem = self.core.memory
        for _ in range(2):
            self.core.run_frame()

    def close(self):
        os.unlink(self.tmp.name)

    # --- memoria ---
    def w8(self, addr, data):
        for i, b in enumerate(data):
            self.mem.u8[addr + i] = b

    def r8(self, addr, size):
        return bytes(self.mem.u8[addr:addr + size])

    def w32(self, addr, value):
        self.mem.u32[addr] = value & 0xFFFFFFFF

    def r32(self, addr):
        return self.mem.u32[addr]

    def snapshot(self):
        return {"ewram": self.r8(0x02000000, 0x40000), "iwram": self.r8(0x03000000, 0x8000)}

    # --- una llamada al payload ---
    def call(self, r0, r1, r2, lr, target=DECOMP, frames=60):
        self.w32(MAILBOX + 0, r0)
        self.w32(MAILBOX + 4, r1)
        self.w32(MAILBOX + 8, r2)
        self.w32(MAILBOX + 12, lr)
        self.w32(MAILBOX + 16, target)
        self.w32(MAILBOX + 24, 0)
        self.w32(MAILBOX + 20, 1)
        for _ in range(frames):
            self.core.run_frame()
            if self.r32(MAILBOX + 24):
                return self.r32(MAILBOX + 28)
        raise TimeoutError("el payload no devolvió el control")


class FakeGame:
    """Memoria de juego sintética: SaveBlock1/2, almacenamiento del PC y los punteros en IWRAM."""

    SB2, SB1, STORAGE = 0x02025504, 0x02029A60, 0x02033000
    SIZES = (0xF24, 0x3D68, 0x83D0)

    def __init__(self, machine, layout="english", pool_order="sb2_sb1", sabotage=None):
        self.m = machine
        rng = 0x12345678
        self.regions = []
        for base, size in zip((self.SB2, self.SB1, self.STORAGE), self.SIZES):
            buf = bytearray()
            for _ in range(size):
                rng = (rng * 1103515245 + 12345) & 0xFFFFFFFF
                buf.append((rng >> 16) & 0xFF)
            self.regions.append(bytes(buf))
        # PokemonStorage.currentBox (primer byte) debe ser < 14
        st = bytearray(self.regions[2])
        st[0] = 5
        self.regions[2] = bytes(st)
        for base, data in zip((self.SB2, self.SB1, self.STORAGE), self.regions):
            machine.w8(base, data)
        # inglés: SB1 0x42D8, SB2 0x42DC, storage 0x42E0; francés: 0x4228 / 0x422C / 0x4230
        sb1p, sb2p, stp = (0x030042D8, 0x030042DC, 0x030042E0) if layout == "english" \
            else (0x03004228, 0x0300422C, 0x03004230)
        machine.w32(sb1p, self.SB1)
        machine.w32(sb2p, self.SB2)
        machine.w32(stp, self.STORAGE if sabotage != "storage" else 0x03001234)
        if sabotage == "pointer":
            machine.w32(sb1p, self.SB1 + 4)          # el pool apunta a un puntero que no coincide
        self.ptrs = (sb1p, sb2p, stp)
        # «Client_RunBufferScript»: en `lr` hay un `bx r7` Thumb; el pool queda 0x14 bytes después
        self.lr = CALLER + 0x20
        machine.w8(self.lr & ~1, (0x4738).to_bytes(2, "little"))      # bx r7
        pool = [DECOMP, sb2p, sb1p] if pool_order == "sb2_sb1" else [DECOMP, sb1p, sb2p]
        if sabotage == "nopool":
            pool = [0, 0, 0]
        for i, w in enumerate(pool):
            machine.w32(CALLER + 0x20 + 0x14 + 4 * i, w)
        machine.w32(CLIENT, 0)          # param, tal como lo deja la consola al principio
        self.snap = None

    def pass_(self, payload, with_marker=True):
        """Una pasada completa del cliente: devuelve (lo enviado, retorno del payload)."""
        m = self.m
        m.w8(DECOMP, payload)                            # memcpy de recvBuffer sobre gDecompressionBuffer
        m.w32(CLIENT + 0x3C, CLIENT)                     # LOAD_TOSS_RESPONSE: envía &param, 4 bytes
        m.mem.u16[CLIENT + 0x34] = 4
        ret = m.call(CLIENT, self.SB2, self.SB1, self.lr | 1)
        size = m.mem.u16[CLIENT + 0x34]
        buf = m.r32(CLIENT + 0x3C)
        return m.r8(buf, size), ret
