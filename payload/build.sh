#!/bin/sh
# Ensambla ramdump.s -> ramdump.bin (ARM, sin enlazar a ninguna dirección) y muestra su tamaño.
set -e
cd "$(dirname "$0")"
arm-none-eabi-as -mcpu=arm7tdmi -o /tmp/ramdump.o ramdump.s
arm-none-eabi-ld -Ttext=0 -o /tmp/ramdump.elf /tmp/ramdump.o
arm-none-eabi-objcopy -O binary /tmp/ramdump.elf ramdump.bin
arm-none-eabi-nm /tmp/ramdump.elf | sort > ramdump.sym
ls -l ramdump.bin
