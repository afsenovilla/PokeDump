# Créditos y licencias

PokeDump es **AGPL-3.0** (ver `LICENSE`) porque reutiliza código AGPL/GPL de:

- **GB-Link Switch LDN** — <https://github.com/GB-Link/GB-Link-Switch-LDN> (AGPL-3.0; las tarjetas y el
  código de Mystery Gift de `web/js/gift/`, GPL-3.0, vienen de
  [gblink-wondercards](https://github.com/GB-Link/gblink-wondercards)). `web/` parte de su
  sitio (commit `0d90534`), recortado a lo que necesita PokeDump (conexión con la placa, instalación del
  firmware, enlace de Mystery Gift) y con una página nueva en español (`index.html`, `js/pokedump.js`,
  adaptada de su `app.js`). Se han eliminado los intercambios, Celio, GBA, tarjetas y la restauración de
  partidas. Incluye el firmware precompilado del ESP32 sin cambios. El código LDN del firmware es GPL-3.0 (`licenses/`).
  El firmware parte de [easyworld/frlg-ldn-trade-esp32](https://github.com/easyworld/frlg-ldn-trade-esp32)
  y [tornadus/frlg-ldn-trade](https://github.com/tornadus/frlg-ldn-trade).
- **pokeldn** (Warnster / Decryptu) — <https://github.com/Warnster/pokeldn> (AGPL-3.0): la idea y la
  mecánica de `CLI_RUN_BUFFER_SCRIPT` (`asm/save-dump.s`, `asm/memory-dump-multi.s`), el
  descifrado de Pokémon (`pokeldn/frlg/save/mon.py`), `BASE_STATS` y las herramientas de lectura de
  NSP (`tools/switch/xci_read.py`, `romfs_read.py`) de las que deriva `tools/extract_rom.py`.
- **pret/pokefirered** — <https://github.com/pret/pokefirered>: estructuras y direcciones (tablas de
  experiencia, diseño del guardado). **mgba_LDN** (Gr3nSkyDragon, MPL-2.0) y **mGBA**
  (MPL-2.0) para las pruebas del núcleo. esptool-js (Apache-2.0) y picoflash (MIT) vienen con `web/`.

No está afiliado a Nintendo ni a The Pokémon Company. No se incluye ninguna ROM, NSP ni clave.
