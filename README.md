# PokeDump

Volcado **de solo lectura** de la partida de Pokémon Rojo Fuego / Verde Hoja de Nintendo Switch
(también Switch 2) usando la conexión local del juego, un ESP32-S3 con el firmware de
[GB-Link Switch LDN](https://github.com/GB-Link/GB-Link-Switch-LDN) y una página web (Chrome/Edge).

Produce un `.sav` de 128 KB para PKHeX y un JSON `pokedump/1` (entrenador, Pokédex vistos/capturados,
equipo y cajas) importable en [Poketracker](https://github.com/afsenovilla/poketracker).

| Carpeta | Contenido |
|---|---|
| `payload/` | `ramdump.s`: código ARM que la consola ejecuta por Mystery Gift y que lee SaveBlock1/2 y el PC de la RAM |
| `web/` | Copia de la web de GB-Link + `web/js/dump/` (servidor de volcado, reconstrucción del `.sav` y JSON) |
| `web/inicio.html`, `web/extraer.html` | Portada en español y comprobación del juego desde el NSP, todo en el navegador (sin Python) |
| `tools/extract_rom.py` | Saca la ROM de GBA de tu NSP (para conocer tu versión exacta) — [guía](docs/EXTRAER_ROM.md) |
| `tests/` | Payload en el núcleo de mGBA, extremo a extremo con la «consola» falsa, y unidades |
| `docs/` | [Guía de prueba](docs/GUIA_PRUEBA.md) · [Formato JSON](docs/FORMATO_JSON.md) · [Extraer ROM](docs/EXTRAER_ROM.md) |

Estado: probado en emulador y con una consola simulada; **pendiente de la primera prueba real** con
una Switch (la sonda de la guía es el primer paso). Créditos y licencia (AGPL-3.0): [CREDITS.md](CREDITS.md).

```
npm test            # node (unidades + extremo a extremo) y pytest (payload en mGBA, extractor de ROM)
```
Requisitos de las pruebas: Node 22, Python 3.9+, `pip install -r requirements.txt mgba`,
`apt install binutils-arm-none-eabi`.
