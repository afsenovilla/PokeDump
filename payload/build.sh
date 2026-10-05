#!/bin/sh
# Ensambla ramdump.s -> ramdump.bin y escribe web/js/dump/ramdump-payload.js (base64 para la web).
# Necesita binutils para ARM (arm-none-eabi-as/ld/objcopy/nm): apt install binutils-arm-none-eabi
set -e
cd "$(dirname "$0")"
T=$(mktemp -d)
arm-none-eabi-as -mcpu=arm7tdmi -o "$T/ramdump.o" ramdump.s
arm-none-eabi-ld -Ttext=0 -o "$T/ramdump.elf" "$T/ramdump.o"
arm-none-eabi-objcopy -O binary "$T/ramdump.elf" ramdump.bin
arm-none-eabi-nm "$T/ramdump.elf" | sort > ramdump.sym
python3 - <<'PY'
import base64, textwrap
b = open('ramdump.bin', 'rb').read()
assert len(b) <= 1024, 'el payload no cabe en un mensaje RAM_SCRIPT'
txt = textwrap.fill(base64.b64encode(b).decode(), 76)
open('../web/js/dump/ramdump-payload.js', 'w').write(
    '// Escrito por payload/build.sh a partir de payload/ramdump.s. No editar a mano.\n'
    '// %d bytes de código ARM; la palabra de offset 4 (.Lfirst) es la pasada inicial a parchear.\n'
    "export const RAMDUMP_PAYLOAD_BASE64 = `%s`;\n" % (len(b), txt))
PY
rm -rf "$T"
ls -l ramdump.bin
