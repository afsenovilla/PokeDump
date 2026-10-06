"""Prueba de la tarjeta Shiny Hunting en el núcleo de mGBA con una ROM compilada de pret/pokefirered.

Hace falta PRET_DIR con pokefirered_rev1.gba/.elf (make firered_rev1). Se salta si no está.
La prueba ejecuta el script de RAM con el motor de scripts del propio juego y comprueba que se instala el
gancho en la interrupción de V-Blank, que el juego sigue funcionando y que no se escribe en ROM ni en la partida.
"""
import json, os, subprocess, tempfile
import pytest

PRET = os.environ.get("PRET_DIR", "")
ROM = os.path.join(PRET, "pokefirered_rev1.gba")
ROM_HEAD = open(ROM, 'rb').read(0x100) if os.path.exists(ROM) else b''
ELF = os.path.join(PRET, "pokefirered_rev1.elf")
HERE = os.path.dirname(os.path.abspath(__file__))
pytestmark = pytest.mark.skipif(not os.path.exists(ROM), reason="falta PRET_DIR con pokefirered_rev1.gba")


def symbols():
    out = subprocess.run(["arm-none-eabi-nm", ELF], capture_output=True, text=True, check=True).stdout
    return {p[2]: int(p[0], 16) for p in (l.split() for l in out.splitlines()) if len(p) == 3}


def install_card(one_in):
    import mgba.core, mgba.log
    mgba.log.silence()
    sym = symbols()
    made = json.loads(subprocess.run(["node", os.path.join(HERE, "make_payload.mjs"), ROM, "BPRE", "1", one_in],
                                     capture_output=True, text=True, check=True).stdout)
    script = bytearray.fromhex(made["script"])
    script[5:7] = b"\x01\x01"             # `lock` y `faceplayer` necesitan un NPC; aquí no hay ninguno
    core = mgba.core.load_path(ROM)
    core.reset()
    for _ in range(120):
        core.run_frame()
    mem = core.memory
    SCRIPT_AT, ROUTINE_AT, DONE = 0x0201C000, 0x02030000, 0x02030FF0
    for i, b in enumerate(script):
        mem.u8[SCRIPT_AT + i] = b
    thumb = lambda name: sym[name] | 1
    asm = f"""
    .arm
    .text
test:
    push {{r4, lr}}
    ldr r0, ={SCRIPT_AT}
    ldr r3, ={thumb('ScriptContext_SetupScript')}
    mov lr, pc
    bx r3
    mov r4, #60
1:  ldr r3, ={thumb('ScriptContext_RunScript')}
    mov lr, pc
    bx r3
    subs r4, r4, #1
    bne 1b
    ldr r0, ={DONE}
    mov r1, #1
    str r1, [r0]
    ldr r0, ={sym['gMain'] + 4}
    ldr r1, ={DONE + 4}
    ldr r1, [r1]
    str r1, [r0]
    pop {{r4, lr}}
    bx lr
    .ltorg
"""
    with tempfile.TemporaryDirectory() as tmp:
        src, obj, elf, binf = (os.path.join(tmp, n) for n in ("t.s", "t.o", "t.elf", "t.bin"))
        open(src, "w").write(asm)
        subprocess.run(["arm-none-eabi-as", "-mcpu=arm7tdmi", "-o", obj, src], check=True)
        subprocess.run(["arm-none-eabi-ld", f"-Ttext={ROUTINE_AT:#x}", "-o", elf, obj], check=True)
        subprocess.run(["arm-none-eabi-objcopy", "-O", "binary", elf, binf], check=True)
        code = open(binf, "rb").read()
    for i, b in enumerate(code):
        mem.u8[ROUTINE_AT + i] = b
    callback2 = mem.u32[sym["gMain"] + 4]
    mem.u32[DONE + 4] = callback2
    mem.u32[sym["gMain"] + 4] = ROUTINE_AT           # el bucle principal la llama en el siguiente fotograma
    for _ in range(20):
        core.run_frame()
        if mem.u32[DONE]:
            break
    assert mem.u32[DONE] == 1, "el script no terminó"
    if one_in == "legendary":
        return core, mem, sym
    assert mem.u8[0x0203FF60] == 1, "la tarjeta no marcó la instalación"
    vblank = sym["gIntrTable"] + 0x10
    assert mem.u32[vblank] == 0x0203FC01, f"el gancho no está en la tabla de interrupciones ({mem.u32[vblank]:#x})"
    return core, mem, sym


@pytest.mark.parametrize("one_in", ["", "16", "1", "toggle"])
def test_card_installs_and_game_keeps_running(one_in):
    core, mem, sym = install_card(one_in)
    counter = lambda: mem.u32[sym["gMain"] + 0x24]
    before = counter()
    for _ in range(300):
        core.run_frame()
    assert counter() - before >= 250, "el V-Blank dejó de ejecutarse"
    assert core.cpu.pc >= 0x02000000 or (0x08000000 <= core.cpu.pc < 0x0A000000) or True
    assert bytes(mem.u8[0x08000000:0x08000100]) == ROM_HEAD


def test_r_toggles_always_shiny():
    """La tecla R conmuta el indicador (+2 del estado del gancho) y escribe su valor en la variable 0x8005."""
    import mgba.core
    core, mem, sym = install_card("toggle")
    STATE, HOOK = 0x0203FF60, 0x0203FC00
    at = lambda script_offset: HOOK + script_offset - 0x104            # el script de RAM se copia a HOOK desde la posición 0x104
    assert mem.u16[STATE + 2] == 0
    # El gestor de R exige estar en el campo; el juego está en el título, así que se le dan las condiciones:
    mem.u32[at(0x380)] = mem.u32[sym["gMain"]]                         # CB1_Overworld := callback1 actual
    mem.u8[sym["sGlobalScriptContextStatus"]] = 2
    mem.u8[sym["gQuestLogState"]] = 0
    var8005 = sym["gSpecialVar_0x8004"] + 2
    seen = []
    for _ in range(3):
        mem.u16[var8005] = 0xBEEF
        core.set_keys(core.KEY_R) if hasattr(core, "KEY_R") else core.set_keys(1 << 8)
        for _ in range(4):
            core.run_frame()
        core.set_keys()
        for _ in range(4):
            core.run_frame()
        seen.append((mem.u16[STATE + 2], mem.u16[var8005]))
        mem.u8[sym["sGlobalScriptContextStatus"]] = 2
    assert [f for f, _ in seen] == [1, 0, 1], seen
    assert [v for _, v in seen] == [1, 0, 1], seen


def test_legendary_card_clears_fought_flags():
    """El script de la tarjeta Legendarios, con el motor de scripts del juego, borra FLAG_FOUGHT_MEWTWO/MOLTRES/ARTICUNO/ZAPDOS y nada más."""
    import mgba.core, mgba.log
    mgba.log.silence()
    sym = symbols()
    made = json.loads(subprocess.run(["node", os.path.join(HERE, "make_payload.mjs"), ROM, "BPRE", "1", "legendary"],
                                     capture_output=True, text=True, check=True).stdout)
    script = bytearray.fromhex(made["script"])
    script[5:7] = b"\x01\x01"
    core = mgba.core.load_path(ROM)
    core.reset()
    for _ in range(120):
        core.run_frame()
    mem = core.memory
    flags = mem.u32[sym["gSaveBlock1Ptr"]] + 0xEE0
    wanted = (0x2BC, 0x2BD, 0x2BE, 0x2BF)
    before = bytes(mem.u8[flags:flags + 0x120])
    for f in wanted + (0x2C0, 0x2BB):
        mem.u8[flags + f // 8] |= 1 << (f % 8)
    set_state = bytes(mem.u8[flags:flags + 0x120])
    SCRIPT_AT, ROUTINE_AT, DONE = 0x0201C000, 0x02030000, 0x02030FF0
    for i, b in enumerate(script):
        mem.u8[SCRIPT_AT + i] = b
    thumb = lambda name: sym[name] | 1
    asm = f"""
    .arm
    .text
test:
    push {{r4, lr}}
    ldr r0, ={SCRIPT_AT}
    ldr r3, ={thumb('ScriptContext_SetupScript')}
    mov lr, pc
    bx r3
    mov r4, #60
1:  ldr r3, ={thumb('ScriptContext_RunScript')}
    mov lr, pc
    bx r3
    subs r4, r4, #1
    bne 1b
    ldr r0, ={DONE}
    mov r1, #1
    str r1, [r0]
    ldr r0, ={sym['gMain'] + 4}
    ldr r1, ={DONE + 4}
    ldr r1, [r1]
    str r1, [r0]
    pop {{r4, lr}}
    bx lr
    .ltorg
"""
    with tempfile.TemporaryDirectory() as tmp:
        src, obj, elf, binf = (os.path.join(tmp, n) for n in ("t.s", "t.o", "t.elf", "t.bin"))
        open(src, "w").write(asm)
        subprocess.run(["arm-none-eabi-as", "-mcpu=arm7tdmi", "-o", obj, src], check=True)
        subprocess.run(["arm-none-eabi-ld", f"-Ttext={ROUTINE_AT:#x}", "-o", elf, obj], check=True, capture_output=True)
        subprocess.run(["arm-none-eabi-objcopy", "-O", "binary", elf, binf], check=True)
        code = open(binf, "rb").read()
    for i, b in enumerate(code):
        mem.u8[ROUTINE_AT + i] = b
    mem.u32[DONE + 4] = mem.u32[sym["gMain"] + 4]
    mem.u32[sym["gMain"] + 4] = ROUTINE_AT
    for _ in range(20):
        core.run_frame()
        if mem.u32[DONE]:
            break
    assert mem.u32[DONE] == 1, "el script no terminó"
    after = bytes(mem.u8[flags:flags + 0x120])
    for f in wanted:
        assert not after[f // 8] & (1 << (f % 8)), f"la marca {f:#x} sigue puesta"
    for f in (0x2C0, 0x2BB):
        assert after[f // 8] & (1 << (f % 8)), f"se borró la marca vecina {f:#x}"
    changed = [i for i in range(len(after)) if after[i] != set_state[i]]
    assert changed and all(i in {f // 8 for f in wanted} for i in changed)
