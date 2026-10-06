# PokeDump

Volcado **de solo lectura** de la partida de Pokémon Rojo Fuego / Verde Hoja de Nintendo Switch
(también Switch 2) usando la conexión local del juego, un ESP32-S3 con el firmware de
[GB-Link Switch LDN](https://github.com/GB-Link/GB-Link-Switch-LDN) y una página web (Chrome/Edge).

Produce un `.sav` de 128 KB para PKHeX y un JSON `pokedump/1` (entrenador, Pokédex vistos/capturados,
equipo y cajas) importable en [Poketracker](https://github.com/afsenovilla/poketracker).

| Carpeta | Contenido |
|---|---|
| `payload/` | `ramdump.s`: código ARM que la consola ejecuta por Mystery Gift y que lee SaveBlock1/2 y el PC de la RAM |
| `web/` | La página en español (`index.html`): placa ESP32, volcado y descargas. Usa módulos de GB-Link (`esp.js`, `gift/`…) recortados a lo necesario; `web/js/dump/` es el servidor de volcado, la reconstrucción del `.sav` y el JSON |
| `web/extraer.html` | Comprobación del juego desde el NSP, todo en el navegador (sin Python) |
| `tools/extract_rom.py` | Saca la ROM de GBA de tu NSP (para conocer tu versión exacta) — [guía](docs/EXTRAER_ROM.md) |
| `tests/` | Payload en el núcleo de mGBA, extremo a extremo con la «consola» falsa, y unidades |
| `docs/` | [Guía de prueba](docs/GUIA_PRUEBA.md) · [Formato JSON](docs/FORMATO_JSON.md) · [Extraer ROM](docs/EXTRAER_ROM.md) · [Intercambio desde una portátil Android](docs/INTERCAMBIO_PORTATIL.md) |

## Compatibilidad
- **Rojo Fuego y Verde Hoja**, en **inglés, francés, alemán, italiano y español** (códigos `BPR?`/`BPG?` con `E F D I S`):
  el payload no usa direcciones fijas por idioma (localiza los punteros en la propia ROM y los valida), y el
  formato del guardado es el mismo. Probado en el emulador con todos esos códigos y con la disposición de IWRAM
  inglesa y francesa; con una ROM real solo se ha comprobado **Verde Hoja español** (`BPGS`).
- **Japonés y coreano:** el volcado funciona, pero los nombres usan otro juego de caracteres y salen con «?»
  (el JSON lo avisa en `warnings`). Sin probar con ROM real.
- Cualquier versión nueva se puede comprobar con `extraer.html` (busca el pool de punteros en su ROM).

Estado: probado en emulador y con una consola simulada; **pendiente de la primera prueba real** con
una Switch (la sonda de la guía es el primer paso). Créditos y licencia (AGPL-3.0): [CREDITS.md](CREDITS.md).

```
npm test            # (la interfaz se prueba aparte: node tests/ui.mjs con Playwright)
npm test            # node (unidades + extremo a extremo) y pytest (payload en mGBA, extractor de ROM)
```
Requisitos de las pruebas: Node 22, Python 3.9+, `pip install -r requirements.txt mgba`,
`apt install binutils-arm-none-eabi`.
