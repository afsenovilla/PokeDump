# Intercambiar Pokémon entre una portátil Android y la Switch (mgba_LDN)

Esta guía es para **intercambiar Pokémon en directo** entre tu portátil de emulación (Retroid o Anbernic **con Android**)
y Rojo Fuego / Verde Hoja de la Switch, **sin sacar la partida a ningún ordenador**. La partida se queda en la portátil.

No lo hace PokeDump: lo hace **[mgba_LDN](https://github.com/Gr3nSkyDragon/mgba_LDN)**, un mGBA modificado que se conecta a la
Switch por la placa ESP32. PokeDump solo sirve aquí para **preparar la placa** (firmware y claves), que es el paso 1 de su web.

> **Antes de empezar, lo que no está comprobado.** mgba_LDN es un fork **no oficial**, y su autor dice que su función nueva está
> hecha con código generado por IA. Esta guía sigue su documentación; **no la he probado con una portátil real**. Si algo no
> coincide con lo que ves, manda lo que dice su página de releases.

## Qué hace falta

- Una **ESP32-S3** (la misma que usas con PokeDump) con el firmware GB-Link Switch LDN y tus **claves** (`prod.keys`) guardadas.
- Una portátil **con Android**: Retroid con Android, o Anbernic con Android. Los Anbernic con Linux (ArkOS, muOS, Knulli…) **no valen**:
  no hay versión del emulador para ellos.
- Un cable **USB-C a USB-C** para unir la ESP32 a la portátil.
- Rojo Fuego o Verde Hoja **en español** en la Switch y la ROM del mismo juego e idioma en la portátil.
- La Switch con el juego, y tú en la planta de arriba del Centro Pokémon.

## 1. Preparar la placa (una sola vez, en el ordenador)

1. Abre <https://afsenovilla.github.io/PokeDump/> en Chrome o Edge.
2. En el paso 1: **Conectar**, **Instalar firmware** y suelta tu `prod.keys`. Las claves se guardan en la placa y no se suben a ningún sitio.
3. Desconecta la placa del ordenador.

> **Ojo con el firmware.** Las últimas versiones de mgba_LDN mencionan un "Compact Firmware Flasher" y funciones nuevas dentro
> del firmware de la ESP32. Lee su README antes de seguir. Si pide su firmware propio, instala ese en lugar del de PokeDump
> y vuelve a guardar las claves. Con el firmware de GB-Link la documentación dice que funciona, y una ESP32-S3 es la placa que usa su autor.

## 2. Instalar el emulador en la portátil

1. Descarga la APK desde [las releases de mgba_LDN](https://github.com/Gr3nSkyDragon/mgba_LDN/releases) e instálala.
2. Copia la ROM de Rojo Fuego (o Verde Hoja) y **tu partida** a la portátil, como harías con cualquier emulador. Haz **copia del `.sav`**
   antes de intercambiar nada.

## 3. Conectar la placa a la portátil

1. Une la ESP32 a la portátil con el cable USB-C a USB-C.
2. Abre el juego en mgba_LDN. Menú **☰** (arriba a la derecha) → **Wireless Adapter** → **ESP32**.
3. Si Android pregunta si la app puede usar el dispositivo USB, acepta.

## 4. Intercambiar

1. **Switch:** en el Centro Pokémon, subir a la planta de arriba. **Usa la ventana de la derecha**, la del intercambio. **No uses la de la
   izquierda** (Sala Inalámbrica). Hazte **líder** del grupo: la Switch hospeda siempre y el emulador solo puede unirse.
2. **Portátil:** en el juego, ve también a la planta de arriba y habla con la encargada de la ventana de la derecha, igual que en una consola real.
   Se unirá al grupo de la Switch.
3. Acepta que se una el otro jugador y siéntate en la **mesa de intercambio** en los dos lados.
4. Elegid los Pokémon y confirmad. El intercambio es el normal del juego.
5. Al terminar, **guarda** en los dos juegos.

**No uses el avance rápido (turbo) del emulador ni durante la preparación ni en el intercambio:** según el autor, se rompe.

## Si algo falla

- El juego da un **error de comunicación** y vuelve al último guardado. No debería estropear la partida, pero por eso conviene la copia previa.
  Reintenta desde el principio: cierra la sala en la Switch, vuelve a entrar y repite.
- Si la placa no aparece en el emulador, desconecta y vuelve a conectar el cable, y prueba el otro puerto USB-C de la portátil si tiene dos.
- Si la Switch no ve a la portátil, comprueba que las claves de la placa son de **tu** consola (paso 1 de PokeDump).
- Mantén la ESP32 cerca de la Switch, a unos 40-60 cm, y sin objetos en medio.

## Qué se modifica

- **El intercambio escribe las dos partidas**, la de la Switch y la de la portátil, porque el juego guarda lo recibido. Es un intercambio legítimo dentro
  del juego, pero ya no es solo lectura. El volcado de PokeDump (guía de prueba) sí lo es.
- Tienes de la Switch el `.sav` que sacó el volcado de PokeDump, que sirve de copia de seguridad para comparar o restaurar con PKHeX.

## Créditos

- [mgba_LDN](https://github.com/Gr3nSkyDragon/mgba_LDN) (MPL-2.0) y [mGBA](https://mgba.io) (MPL-2.0).
- [GB-Link Switch LDN](https://github.com/GB-Link/GB-Link-Switch-LDN) (AGPL-3.0), de donde viene el firmware de la placa.
