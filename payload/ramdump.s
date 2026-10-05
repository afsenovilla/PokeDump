@ PokeDump: volcado SOLO LECTURA de SaveBlock2, SaveBlock1 y el almacenamiento del PC de
@ Pokémon Rojo Fuego / Verde Hoja (Switch), desde la RAM.
@
@ Es un payload de CLI_RUN_BUFFER_SCRIPT (cliente de Mystery Gift), el mismo mecanismo que
@ asm/save-dump.s de pokeldn y cards/savebackup.s de GB-Link Switch LDN (AGPL-3.0, GPL-3.0):
@ la consola copia el mensaje RAM_SCRIPT a gDecompressionBuffer (0x0201C000) y lo llama como
@     u32 f(u32 *param, SaveBlock2 *r1, SaveBlock1 *r2)
@ hasta que devuelve 1. Cada pasada del guion de cliente
@     CLI_LOAD_TOSS_RESPONSE, CLI_RUN_BUFFER_SCRIPT, CLI_SEND_LOADED
@ envía hasta 1 KB. El payload solo repunta client->link.sendBuffer (+0x3C) y sendSize (+0x34)
@ hacia la RAM; la consola envía esa región con su CRC. NO escribe en ninguna dirección salvo:
@   - client->param (el índice de pasada) y los dos campos de envío de arriba,
@   - el búfer de la cabecera, en EWRAM libre de gDecompressionBuffer (HEADER),
@   - tres palabras de la propia imagen del payload (.Lscan_*), que la consola restaura cada pasada.
@ No toca la flash, ni el guardado, ni ninguna variable del juego.
@
@ Pasadas (índice p, se guarda en client->param como 0x5A << 24 | p):
@   p = 0        cabecera de 64 bytes (diagnóstico: punteros, juego, idioma, estado)
@   p = 1..4     SaveBlock2        (0xF24 bytes)
@   p = 5..20    SaveBlock1        (0x3D68 bytes)
@   p = 21..53   PokemonStorage    (0x83D0 bytes), si se localizó gPokemonStoragePtr
@   p >= 54      nada: queda el mensaje de 4 bytes que preparó CLI_LOAD_TOSS_RESPONSE
@
@ gPokemonStoragePtr: su dirección en IWRAM cambia con el idioma. El juego la guarda justo tras
@ gSaveBlock1Ptr / gSaveBlock2Ptr, y Client_RunBufferScript lleva en su pool de literales
@     gDecompressionBuffer, &gSaveBlock2Ptr, &gSaveBlock1Ptr
@ a pocos bytes de la dirección de retorno (lr). Se busca ese pool y se acepta SOLO si los dos
@ punteros contienen exactamente los valores r1 y r2 que la consola acaba de pasar; después se
@ comprueba que el puntero del almacenamiento apunte a EWRAM y que su caja actual sea < 14.
@ Si algo no cuadra, status != 0 en la cabecera y no se envía el almacenamiento.
@
@ Cabecera (palabras de 32 bits, little endian):
@   0 magic 'PKDP'   1 versión (1)   2 SaveBlock2   3 SaveBlock1   4 PokemonStorage (0 = no)
@   5 &gPokemonStoragePtr   6 status (0 ok, 1 sin pool, 2 punteros no validan, 3 storage dudoso)
@   7 lr   8 y 9: las dos direcciones IWRAM halladas en el pool (SaveBlockXPtr, en su orden)   10 tamaño SB2   11 tamaño SB1
@   12 código de juego (0x080000AC)   13 revisión (byte 0x080000BC)   14 tamaño storage
@
@ Posición independiente salvo constantes absolutas de EWRAM. Una palabra a parchear (opcional):
@ .Lfirst (offset 0x04), pasada por la que empezar si client->param no lleva la marca.

    .arm
    .text
    .global _start
    .equ MAGIC,      0x5A
    .equ HEADER,     0x0201C400          @ gDecompressionBuffer + 0x400, tras la imagen de 1 KB
    .equ SEND_SIZE,  0x34
    .equ SEND_BUF,   0x3C
    .equ SB2_SIZE,   0xF24
    .equ SB1_SIZE,   0x3D68
    .equ ST_SIZE,    0x83D0
    .equ P_SB2,      1
    .equ P_SB1,      5
    .equ P_ST,       21
    .equ P_END,      54

_start:
    b       code
.Lfirst:
    .word   0

code:
    push    {r4-r10, lr}
    mov     r4, r0                       @ &client->param
    mov     r5, r1                       @ gSaveBlock2Ptr (valor)
    mov     r6, r2                       @ gSaveBlock1Ptr (valor)
    mov     r8, lr                       @ dirección de retorno en Client_RunBufferScript

    ldr     r3, [r4]
    mov     r2, r3, lsr #24
    cmp     r2, #MAGIC
    ldrne   r3, .Lfirst                  @ primera pasada: no hay marca
    bic     r7, r3, #0xFF000000          @ r7 = p

    bl      find_storage                 @ r0 = valor de gPokemonStoragePtr o 0
    mov     r9, r0                       @ r9 = storage
    @ r10 = status, r1 = &gPokemonStoragePtr, r2 = &gSaveBlock2Ptr, r3 = &gSaveBlock1Ptr

    cmp     r7, #0
    beq     header
    cmp     r7, #P_END
    bhs     advance                      @ pasada de más: se deja el mensaje de 4 bytes

    cmp     r7, #P_ST
    bhs     storage
    cmp     r7, #P_SB1
    bhs     sb1

sb2:
    sub     r0, r7, #P_SB2
    mov     r1, r5
    ldr     r2, =SB2_SIZE
    b       chunk
sb1:
    sub     r0, r7, #P_SB1
    mov     r1, r6
    ldr     r2, =SB1_SIZE
    b       chunk
storage:
    cmp     r9, #0
    beq     advance                      @ sin puntero fiable no se envía nada
    sub     r0, r7, #P_ST
    mov     r1, r9
    ldr     r2, =ST_SIZE

@ r0 = índice del trozo, r1 = base, r2 = tamaño total de la región
chunk:
    mov     r3, r0, lsl #10              @ desplazamiento = índice * 1024
    add     r1, r1, r3
    sub     r2, r2, r3                   @ lo que queda de la región
    cmp     r2, #0x400
    movhi   r2, #0x400
    str     r1, [r4, #SEND_BUF]
    strh    r2, [r4, #SEND_SIZE]
    b       advance

header:
    ldr     r0, =HEADER
    ldr     r1, =0x50444B50              @ 'PKDP'
    str     r1, [r0, #0]
    mov     r1, #1
    str     r1, [r0, #4]
    str     r5, [r0, #8]
    str     r6, [r0, #12]
    str     r9, [r0, #16]
    ldr     r1, .Lscan_storage
    str     r1, [r0, #20]
    str     r10, [r0, #24]
    str     r8, [r0, #28]
    ldr     r1, .Lscan_sb2
    str     r1, [r0, #32]
    ldr     r1, .Lscan_sb1
    str     r1, [r0, #36]
    ldr     r1, =SB2_SIZE
    str     r1, [r0, #40]
    ldr     r1, =SB1_SIZE
    str     r1, [r0, #44]
    mov     r1, #0x08000000
    ldr     r2, [r1, #0xAC]              @ código de juego, p. ej. 'BPRS'
    str     r2, [r0, #48]
    ldrb    r2, [r1, #0xBC]              @ revisión
    str     r2, [r0, #52]
    ldr     r1, =ST_SIZE
    str     r1, [r0, #56]
    mov     r1, #0
    str     r1, [r0, #60]
    str     r0, [r4, #SEND_BUF]
    mov     r1, #64
    strh    r1, [r4, #SEND_SIZE]

advance:
    add     r7, r7, #1
    orr     r7, r7, #MAGIC << 24
    str     r7, [r4]
    mov     r0, #1                       @ hecho: la consola envía y sigue
    pop     {r4-r10, lr}
    bx      lr

@ Busca gPokemonStoragePtr. Entrada: r8 = lr, r5 = SB2, r6 = SB1.
@ Salida: r0 = valor del puntero (0 si falla), r10 = status. Guarda las direcciones halladas en
@ las variables de pool (.Lscan_*), que viven en la imagen del payload (se restaura cada pasada).
find_storage:
    push    {r4, lr}
    adr     r4, .Lscan_storage
    mov     r2, #0
    str     r2, [r4]
    str     r2, [r4, #4]
    str     r2, [r4, #8]
    bic     r0, r8, #1
    mov     r1, #0x40                    @ palabras a explorar tras lr
    mov     r2, #0x02000000
    add     r2, r2, #0x1C000             @ gDecompressionBuffer
1:  ldr     r3, [r0], #4
    cmp     r3, r2
    beq     found
    subs    r1, r1, #1
    bne     1b
    mov     r10, #1                      @ sin pool
    mov     r0, #0
    pop     {r4, pc}

found:
    ldr     r1, [r0]                     @ pa
    ldr     r2, [r0, #4]                 @ pb
    mov     r3, r1, lsr #15
    cmp     r3, #0x600                   @ ¿IWRAM (0x0300_0000..0x0300_7FFF)?
    movne   r10, #2
    bne     fail
    mov     r3, r2, lsr #15
    cmp     r3, #0x600
    movne   r10, #2
    bne     fail
    sub     r3, r1, r2
    cmp     r3, #4
    cmpne   r3, #-4
    movne   r10, #2                      @ no son contiguos
    bne     fail
    ldr     r3, [r1]
    ldr     ip, [r2]
    cmp     r3, r5
    cmpeq   ip, r6
    beq     matched                      @ (pa = &SB2, pb = &SB1)
    cmp     r3, r6
    cmpeq   ip, r5
    movne   r10, #2                      @ los punteros no valen lo que pasó la consola
    bne     fail
matched:
    cmp     r1, r2
    movhi   r3, r1                       @ r3 = la dirección más alta
    movls   r3, r2
    add     r3, r3, #4                   @ &gPokemonStoragePtr
    ldr     r0, [r3]
    str     r3, [r4]
    str     r1, [r4, #4]                 @ dirección de un puntero (la del pool, primero)
    str     r2, [r4, #8]                 @ dirección del otro
    mov     ip, r0, lsr #18
    cmp     ip, #0x80                    @ ¿EWRAM (0x0200_0000..0x0203_FFFF)?
    movne   r10, #3
    bne     fail
    tst     r0, #3
    movne   r10, #3
    bne     fail
    ldrb    ip, [r0]                     @ PokemonStorage.currentBox < 14
    cmp     ip, #14
    movhs   r10, #3
    bhs     fail
    mov     r10, #0
    pop     {r4, pc}
fail:
    mov     r0, #0
    pop     {r4, pc}

    .ltorg
@ Variables en la imagen (se restauran en cada pasada; solo las usa la propia pasada):
.Lscan_storage:
    .word   0
.Lscan_sb2:
    .word   0
.Lscan_sb1:
    .word   0
