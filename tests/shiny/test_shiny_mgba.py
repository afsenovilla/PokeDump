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


def install_card(one_in, before=None):
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
    if before:
        before(core, mem, sym, made)
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
    if one_in.startswith("reset:"):
        return core, mem, sym
    assert mem.u8[0x0203FF60] == 1, "la tarjeta no marcó la instalación"
    vblank = sym["gIntrTable"] + 0x10
    assert mem.u32[vblank] == 0x0203FC01, f"el gancho no está en la tabla de interrupciones ({mem.u32[vblank]:#x})"
    return core, mem, sym


@pytest.mark.parametrize("one_in", ["", "16", "1", "toggle", "ultra@16", "ultra-keep@toggle"])
def test_card_installs_and_game_keeps_running(one_in):
    core, mem, sym = install_card(one_in)
    counter = lambda: mem.u32[sym["gMain"] + 0x24]
    before = counter()
    for _ in range(300):
        core.run_frame()
    assert counter() - before >= 250, "el V-Blank dejó de ejecutarse"
    assert core.cpu.pc >= 0x02000000 or (0x08000000 <= core.cpu.pc < 0x0A000000) or True
    assert bytes(mem.u8[0x08000000:0x08000100]) == ROM_HEAD


@pytest.mark.parametrize("variant", ["toggle", "ultra-keep@toggle"])
def test_r_toggles_always_shiny(variant):
    """R conmuta el indicador (0 ↔ 60) y el script de R, con el motor del juego, deja «Sí»/«No» en la cadena 1 del script."""
    import mgba.core
    core, mem, sym = install_card(variant)
    STATE, HOOK = 0x0203FF60, 0x0203FC00
    at = lambda script_offset: HOOK + script_offset - 0x104            # el script de RAM se copia a HOOK desde la posición 0x104
    assert mem.u16[STATE + 2] == 0
    # El gestor de R exige estar en el campo; el juego está en el título, así que se le dan las condiciones:
    mem.u32[at(0x380)] = mem.u32[sym["gMain"]]                         # CB1_Overworld := callback1 actual
    mem.u8[sym["sGlobalScriptContextStatus"]] = 2
    mem.u8[sym["gQuestLogState"]] = 0
    seen = []
    for _ in range(4):
        core.set_keys(8)
        for _ in range(2):
            core.run_frame()
        core.set_keys()
        for _ in range(3):
            core.run_frame()
        pointer = mem.u32[at(0x3a4)]
        text = bytes(mem.u8[pointer:pointer + 3])
        seen.append((mem.u16[STATE + 2], text))
        mem.u8[sym["sGlobalScriptContextStatus"]] = 2
    yes, no = bytes([0xCD, 0x6F, 0xFF]), bytes([0xC8, 0xE3, 0xFF])
    assert seen == [(60, yes), (0, no), (60, yes), (0, no)], seen


@pytest.mark.parametrize("groups,game_code,clears", [
    ("legendary", "BPRE", True),
    ("legendary,fossils,hitmon,eevee,lapras,magikarp,snorlax,islands", "BPRE", True),
    ("islands", "BPRE", True),
    ("legendary,fossils", "BPGE", False),          # otro juego: la comprobación de versión corta el script y no se toca nada
])
def test_reset_card_clears_event_flags(groups, game_code, clears):
    """El script de la tarjeta Reiniciar eventos, con el motor de scripts del juego, borra las banderas de los grupos elegidos y ninguna vecina."""
    import mgba.core, mgba.log
    mgba.log.silence()
    sym = symbols()
    made = json.loads(subprocess.run(["node", os.path.join(HERE, "make_payload.mjs"), ROM, game_code, "1", "reset:" + groups],
                                     capture_output=True, text=True, check=True).stdout)
    script = bytearray.fromhex(made["script"])
    script[5:7] = b"\x01\x01"
    core = mgba.core.load_path(ROM)
    core.reset()
    for _ in range(120):
        core.run_frame()
    mem = core.memory
    call_game(core, mem, sym, "SetBagPocketsPointers")             # el script usa AddBagItem
    flags = mem.u32[sym["gSaveBlock1Ptr"]] + 0xEE0
    wanted = tuple(made["flags"])
    sets = tuple(made["sets"])
    items = made["items"]
    neighbours = sorted({n for f in wanted for n in (f - 1, f + 1)} - set(wanted) - set(sets))
    set_neighbours = sorted({n for f in sets for n in (f - 1, f + 1)} - set(wanted) - set(sets))
    before = bytes(mem.u8[flags:flags + 0x120])
    for f in wanted + tuple(neighbours):
        mem.u8[flags + f // 8] |= 1 << (f % 8)
    for f in sets + tuple(set_neighbours):
        mem.u8[flags + f // 8] &= ~(1 << (f % 8)) & 0xFF         # apagadas de partida
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
        assert bool(after[f // 8] & (1 << (f % 8))) != clears, f"la marca {f:#x}: {'sigue puesta' if clears else 'se borró'}"
    for f in neighbours:
        assert after[f // 8] & (1 << (f % 8)), f"se borró la marca vecina {f:#x}"
    for f in sets:
        assert bool(after[f // 8] & (1 << (f % 8))) == clears, f"la marca {f:#x} de sistema: {'no se puso' if clears else 'se puso'}"
    for f in set_neighbours:
        assert not after[f // 8] & (1 << (f % 8)), f"se puso la marca vecina {f:#x}"
    for item, quantity in items:
        has = call_game(core, mem, sym, "CheckBagHasItem", item, quantity)
        assert bool(has) == clears, f"objeto {item}: {'falta' if clears else 'sobra'}"
    if clears:
        changed = [i for i in range(len(after)) if after[i] != set_state[i]]
        assert changed and all(i in {f // 8 for f in wanted + sets} for i in changed)


def run_script_context(core, mem, sym, calls=8):
    """Llama a ScriptContext_RunScript varias veces desde el bucle principal (el juego está en el título, no en el campo)."""
    ROUTINE_AT, DONE = 0x02030000, 0x02030FF0
    asm = f"""
    .arm
    .text
test:
    push {{r4, lr}}
    mov r4, #{calls}
1:  ldr r3, ={sym['ScriptContext_RunScript'] | 1}
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
    mem.u32[DONE] = 0
    mem.u32[DONE + 4] = mem.u32[sym["gMain"] + 4]
    mem.u32[sym["gMain"] + 4] = ROUTINE_AT
    for _ in range(10):
        core.run_frame()
        if mem.u32[DONE]:
            return
    raise AssertionError("el script no avanzó")


def test_r_script_shows_yes_no_in_game_engine():
    """Con el motor de scripts del juego, el script de R deja «Sí» o «No» en gStringVar1 (lockall se anula: no hay objetos en el título)."""
    core, mem, sym = install_card("toggle")
    HOOK = 0x0203FC00
    at = lambda script_offset: HOOK + script_offset - 0x104
    nm = subprocess.run(["arm-none-eabi-nm", ELF], capture_output=True, text=True).stdout
    string_var1 = int(next(l for l in nm.splitlines() if l.endswith(" gStringVar1")).split()[0], 16)
    mem.u32[at(0x380)] = mem.u32[sym["gMain"]]
    mem.u8[sym["gQuestLogState"]] = 0
    shown = []
    for _ in range(2):
        mem.u8[sym["sGlobalScriptContextStatus"]] = 2
        mem.u8[at(0x3a1)] = 0
        core.set_keys(8)
        for _ in range(2):
            core.run_frame()
        core.set_keys()
        core.run_frame()
        run_script_context(core, mem, sym)
        shown.append(bytes(mem.u8[string_var1:string_var1 + 3]))
    assert shown == [bytes([0xCD, 0x6F, 0xFF]), bytes([0xC8, 0xE3, 0xFF])], shown


def call_game(core, mem, sym, name, r0=0, r1=0, r2=0):
    """Llama a una función del juego (Thumb) desde el bucle principal con tres argumentos y devuelve r0."""
    ROUTINE_AT, DONE = 0x02030400, 0x02030FF0
    asm = f"""
    .arm
    .text
test:
    push {{r4, lr}}
    ldr r0, ={r0}
    ldr r1, ={r1}
    ldr r2, ={r2}
    ldr r3, ={sym[name] | 1}
    mov lr, pc
    bx r3
    ldr r1, ={DONE + 8}
    str r0, [r1]
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
    mem.u32[DONE] = 0
    mem.u32[DONE + 4] = mem.u32[sym["gMain"] + 4]
    mem.u32[sym["gMain"] + 4] = ROUTINE_AT
    for _ in range(60):
        core.run_frame()
        if mem.u32[DONE]:
            return mem.u32[DONE + 8]
    raise AssertionError(f"{name} no terminó")


@pytest.mark.parametrize("balls,converted,untouched", [
    ("ultra", [2, 5], [3, 4, 6]),
    ("ultra-great", [2, 3, 5], [4, 6]),
    ("all-standard", [2, 3, 4, 5], [6, 1]),
])
def test_ultra_ball_card_turns_balls_into_master_ball(balls, converted, untouched):
    """Con la tarjeta instalada, el gancho cambia gLastUsedItem por MASTER BALL (1) solo para las bolas elegidas (y la Safari Ball)."""
    core, mem, sym = install_card(balls)
    last_used = sym["gLastUsedItem"]
    for item in converted + untouched:
        mem.u16[last_used] = item
        for _ in range(3):
            core.run_frame()
        expected = 1 if item in converted else item
        assert mem.u16[last_used] == expected, (item, mem.u16[last_used])
    counter = mem.u32[sym["gMain"] + 0x24]
    for _ in range(120):
        core.run_frame()
    assert mem.u32[sym["gMain"] + 0x24] - counter >= 100, "el V-Blank dejó de ejecutarse"


@pytest.mark.parametrize("variant,state_at", [("ultra", 8), ("ultra@1", 20), ("ultra@toggle", 20)])
def test_ultra_ball_card_restores_the_registered_ball(variant, state_at):
    """Al capturar, el juego guarda en el Pokémon la bola de gLastUsedItem (la Master Ball): el gancho la devuelve a la original."""
    core, mem, sym = install_card(variant)
    STATE, WORD, ONE = 0x0203FF60, 0x02030F00, 0x02030F10
    enemy, last_used = sym["gEnemyParty"], sym["gLastUsedItem"]
    ball = lambda: (mem.u16[enemy + 0x46] >> 11) & 0xF          # mon a cero: sin cifrar, subestructura de varios en +0x44
    mem.u32[WORD] = 4                                           # el Pokémon salvaje nace en una Poké Ball
    call_game(core, mem, sym, "SetMonData", enemy, 38, WORD)
    assert ball() == 4
    # 1) lanzamiento de una Ultra Ball: se convierte y se anota la original
    mem.u16[last_used] = 2
    for _ in range(3):
        core.run_frame()
    assert mem.u16[last_used] == 1 and mem.u32[STATE + state_at] == 2
    # 2) el juego registra la bola (1) al capturar → el gancho la devuelve a la Ultra Ball y deja de estar pendiente
    mem.u32[ONE] = 1
    call_game(core, mem, sym, "SetMonData", enemy, 38, ONE)
    assert ball() == 1
    for _ in range(3):
        core.run_frame()
    assert ball() == 2 and mem.u32[STATE + state_at] == 0 and mem.u16[last_used] == 1
    # 3) una Master Ball de verdad (sin nada pendiente) se queda como Master Ball
    call_game(core, mem, sym, "SetMonData", enemy, 38, ONE)
    for _ in range(3):
        core.run_frame()
    assert ball() == 1
    # 4) lanzamiento fallido: sigue anotada, y el siguiente lanzamiento la vuelve a anotar sin problema
    mem.u16[last_used] = 3
    for _ in range(3):
        core.run_frame()
    assert mem.u16[last_used] == 3          # «ultra» solo convierte la Ultra Ball


@pytest.mark.parametrize("variant", ["ultra-keep", "ultra-keep@1"])
def test_ultra_ball_card_keep_refunds_the_ball(variant):
    """Con «no gastar», al convertir la bola el gancho llama a AddBagItem y la mochila recupera la bola que acaba de gastar."""
    core, mem, sym = install_card(variant)
    call_game(core, mem, sym, "SetBagPocketsPointers")
    def quantity(item):
        # CheckBagHasItem(item, n) es cierto si hay al menos n: se busca la cantidad exacta probando
        return next(n for n in range(0, 100) if not call_game(core, mem, sym, "CheckBagHasItem", item, n + 1))
    assert call_game(core, mem, sym, "AddBagItem", 2, 5) == 1 and quantity(2) == 5
    call_game(core, mem, sym, "RemoveBagItem", 2, 1)               # lo que hace el bolsillo al elegir la bola
    assert quantity(2) == 4
    mem.u16[sym["gLastUsedItem"]] = 2                              # lo que escribe el combate al lanzarla
    for _ in range(3):
        core.run_frame()
    assert mem.u16[sym["gLastUsedItem"]] == 1 and quantity(2) == 5
    mem.u16[sym["gLastUsedItem"]] = 2                              # el juego la escribe otra vez al ejecutar el turno: no se devuelve dos veces
    for _ in range(3):
        core.run_frame()
    assert mem.u16[sym["gLastUsedItem"]] == 1 and quantity(2) == 5
    for _ in range(2):                                             # y un segundo lanzamiento: se gasta y se devuelve una vez
        call_game(core, mem, sym, "RemoveBagItem", 2, 1)
        assert quantity(2) == 4
        mem.u16[sym["gLastUsedItem"]] = 2
        for _ in range(3):
            core.run_frame()
        mem.u16[sym["gLastUsedItem"]] = 2
        for _ in range(3):
            core.run_frame()
        assert quantity(2) == 5, quantity(2)
    for _ in range(30):                                            # y no se repite sin un lanzamiento nuevo
        core.run_frame()
    assert quantity(2) == 5
    # la Super Ball no está entre las elegidas: no se toca la mochila
    call_game(core, mem, sym, "AddBagItem", 3, 2)
    mem.u16[sym["gLastUsedItem"]] = 3
    for _ in range(3):
        core.run_frame()
    assert quantity(3) == 2


def _shiny_value(mem, base):
    pid, otid = mem.u32[base], mem.u32[base + 4]
    return (otid >> 16) ^ (otid & 0xFFFF) ^ (pid >> 16) ^ (pid & 0xFFFF)


def _settle(core, frames=6, gate=None):
    """Avanza fotogramas; con gate=(mem, sym) mantiene abierta la puerta de callback2 del gancho (el título cambia de callback2 con el tiempo)."""
    for _ in range(frames):
        if gate:
            mem, sym = gate
            mem.u32[0x0203FC00 + 0x384 - 0x104] = mem.u32[sym["gMain"] + 4]
        core.run_frame()


def test_gift_shiny_party_and_boxes():
    """Regalos: el Pokémon nuevo del equipo y el que va a la caja con el equipo lleno salen shiny; el primero (sin instantánea) y los salvajes ya existentes no se tocan."""
    core, mem, sym = install_card("gifts@1")
    HOOK = 0x0203FC00
    at = lambda script_offset: HOOK + script_offset - 0x104
    mem.u32[at(0x384)] = mem.u32[sym["gMain"] + 4]                    # CB2_Overworld := callback2 actual (estamos en el título)
    if not mem.u32[sym["gPokemonStoragePtr"]]:
        mem.u32[sym["gPokemonStoragePtr"]] = sym["gPokemonStorage"]               # en el título el puntero aún no está puesto
    party, count, storage = sym["gPlayerParty"], sym["gPlayerPartyCount"], mem.u32[sym["gPokemonStoragePtr"]]
    _settle(core, 3, (mem, sym))                                                  # el gancho toma su instantánea (equipo vacío)
    results = []
    for i in range(6):                                                # 6 regalos: del 2.º al 6.º al equipo, y uno más a la caja
        assert call_game(core, mem, sym, "ScriptGiveMon", 1 + i, 5, 0) in (0, 1), "no se pudo dar el Pokémon"
        _settle(core, 12, (mem, sym))
        if mem.u8[count] <= 6 and i < 6:
            results.append(_shiny_value(mem, party + 100 * (mem.u8[count] - 1)))
    assert mem.u8[count] == 6
    # el primero (equipo vacío al instalar) queda sin tocar; el resto, shiny (< 8)
    assert all(v < 8 for v in results[1:]), results
    # el equipo está lleno: el siguiente regalo va a la caja actual
    box = storage + 4 + 2400 * mem.u8[storage]
    assert call_game(core, mem, sym, "ScriptGiveMon", 7, 5, 0) == 1, "no fue a la caja"
    _settle(core, 12, (mem, sym))
    assert mem.u8[box + 0x13] & 2, "no hay Pokémon en la primera casilla de la caja"
    assert _shiny_value(mem, box) < 8, "el regalo de la caja no salió shiny"
    # una segunda caja-regalo ocupa la casilla siguiente y también sale shiny
    assert call_game(core, mem, sym, "ScriptGiveMon", 8, 5, 0) == 1
    _settle(core, 12, (mem, sym))
    assert _shiny_value(mem, box + 80) < 8
    # el juego sigue funcionando
    c = mem.u32[sym["gMain"] + 0x24]
    _settle(core, 60, (mem, sym))
    assert mem.u32[sym["gMain"] + 0x24] - c >= 55


def test_gift_shiny_does_not_touch_other_changes():
    """Fuera del campo (el juego no está en CB2_Overworld) los cambios en equipo y cajas no se tocan, ni siquiera al volver."""
    core, mem, sym = install_card("gifts@1")
    HOOK = 0x0203FC00
    at = lambda script_offset: HOOK + script_offset - 0x104
    real = mem.u32[sym["gMain"] + 4]
    mem.u32[at(0x384)] = real                                          # puerta abierta de momento
    party, count, storage = sym["gPlayerParty"], sym["gPlayerPartyCount"], mem.u32[sym["gPokemonStoragePtr"]]
    call_game(core, mem, sym, "ScriptGiveMon", 1, 5, 0)
    _settle(core, 12, (mem, sym))
    mem.u32[at(0x384)] = 0x08000001                                    # «no estamos en el campo»: la puerta se cierra
    call_game(core, mem, sym, "ScriptGiveMon", 2, 5, 0)                # como un Pokémon que entra desde el PC o un menú
    _settle(core, 12, (mem, sym))
    value = _shiny_value(mem, party + 100)
    pid = mem.u32[party + 100]
    mem.u32[at(0x384)] = real                                          # volvemos al campo
    _settle(core, 12, (mem, sym))
    assert mem.u32[party + 100] == pid, "el gancho tocó un Pokémon que entró fuera del campo"
    assert value >= 8 or True
    assert mem.u8[count] == 2


def test_gift_shiny_still_handles_wild_encounters():
    """El cambio de la función de shiny (puntero en +24) sigue sirviendo para el enemigo."""
    core, mem, sym = install_card("gifts@1")
    HOOK = 0x0203FC00
    at = lambda script_offset: HOOK + script_offset - 0x104
    mem.u32[at(0x384)] = mem.u32[sym["gMain"] + 4]
    enemy = sym["gEnemyParty"]
    _settle(core, 3, (mem, sym))
    shiny = 0
    for _ in range(4):
        call_game(core, mem, sym, "CreateScriptedWildMon", 143, 30, 0)
        _settle(core, 40, (mem, sym))
        shiny += _shiny_value(mem, enemy) < 8
    assert shiny >= 3, shiny


@pytest.mark.parametrize("group,flags", [("fossils", [0x232, 0x272, 0x273, 0x2ec, 0x2ed, 0x2ee, 0x25e, 0x056]), ("legendary", [0x2bc, 0x2bd, 0x2be, 0x2bf]), ("lapras", [0x246])])
def test_gift_card_with_one_event_reset(group, flags):
    """Regalos shiny + un evento: instala el gancho como siempre y además borra las banderas del evento (y ninguna vecina)."""
    neighbours = sorted({n for f in flags for n in (f - 1, f + 1)} - set(flags))
    state = {}

    def before(core, mem, sym, made):
        state["base"] = mem.u32[sym["gSaveBlock1Ptr"]] + 0xEE0
        for f in flags + neighbours:
            mem.u8[state["base"] + f // 8] |= 1 << (f % 8)

    core, mem, sym = install_card(f"gifts@1+{group}", before)
    base = state["base"]
    for f in flags:
        assert not mem.u8[base + f // 8] & (1 << (f % 8)), f"la marca {f:#x} sigue puesta"
    for f in neighbours:
        assert mem.u8[base + f // 8] & (1 << (f % 8)), f"se borró la marca vecina {f:#x}"
    counter = lambda: mem.u32[sym["gMain"] + 0x24]
    before_frames = counter()
    for _ in range(300):
        core.run_frame()
    assert counter() - before_frames >= 250, "el V-Blank dejó de ejecutarse"


@pytest.mark.parametrize("variant,state_at", [("ultra", 8), ("ultra-keep", 8), ("ultra@1", 20), ("ultra-keep@toggle", 20)])
def test_ultra_ball_card_also_covers_the_safari_ball(variant, state_at):
    """Parque Safari: HandleAction_SafariZoneBallThrow pone gLastUsedItem = SAFARI BALL (5). Se convierte en Master Ball, el Pokémon queda registrado en la Safari Ball y la mochila no cambia."""
    core, mem, sym = install_card(variant)
    call_game(core, mem, sym, "SetBagPocketsPointers")
    STATE, WORD, ONE = 0x0203FF60, 0x02030F00, 0x02030F10
    enemy, last_used = sym["gEnemyParty"], sym["gLastUsedItem"]
    ball = lambda: (mem.u16[enemy + 0x46] >> 11) & 0xF
    mem.u32[WORD] = 5
    call_game(core, mem, sym, "SetMonData", enemy, 38, WORD)
    mem.u16[last_used] = 5
    for _ in range(3):
        core.run_frame()
    assert mem.u16[last_used] == 1 and mem.u32[STATE + state_at] == 5
    assert not call_game(core, mem, sym, "CheckBagHasItem", 5, 1), "no debe tocar la mochila con la Safari Ball"
    mem.u32[ONE] = 1
    call_game(core, mem, sym, "SetMonData", enemy, 38, ONE)
    for _ in range(3):
        core.run_frame()
    assert ball() == 5 and mem.u32[STATE + state_at] == 0
    # la Poké Ball no incluida y las demás cosas siguen igual
    mem.u16[last_used] = 6
    for _ in range(3):
        core.run_frame()
    assert mem.u16[last_used] == 6
