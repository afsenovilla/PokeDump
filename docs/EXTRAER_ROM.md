# Extraer la ROM de tu NSP (Rojo Fuego / Verde Hoja)

Sirve para saber con exactitud qué versión tienes (código, idioma, revisión) y calcular las
direcciones de memoria de **tu** ROM. Todo se ejecuta en tu ordenador. **No envíes el NSP, la ROM
ni `prod.keys` a nadie**: solo hace falta compartir `informe.json`.

## Qué necesitas
- Python 3.9 o superior (https://www.python.org/downloads/; en Windows marca *Add Python to PATH*).
- Tu NSP del juego y tu `prod.keys` (el de tu Switch 1, con `header_key`, `key_area_key_application_*`
  y, si el NSP lleva ticket, `titlekek_*`).

## Pasos
1. Descarga este repositorio (botón verde *Code → Download ZIP*) y descomprímelo.
2. Abre una terminal dentro de la carpeta y ejecuta:
   ```
   pip install pycryptodome
   python tools/extract_rom.py RUTA/AL/JUEGO.nsp --keys RUTA/A/prod.keys
   ```
   Si no pones `--keys`, busca `~/.switch/prod.keys`.
3. Debe imprimir algo como:
   ```
   Juego: Rojo Fuego (FireRed), idioma español, código BPRS, revisión 0x0a
   Cabecera GBA válida: sí
   ```
4. Pásame el **contenido de `informe.json`** (texto pequeño, sin claves ni ROM). `rom.gba` se queda
   en tu equipo.

## Si algo falla
| Mensaje | Qué significa |
|---|---|
| `no tiene key_area_key_application_XX` / `titlekek_XX` | Tu `prod.keys` es anterior al firmware del juego. Vuelve a generarlo con Lockpick_RCM. |
| `la cabecera no descifra` | `header_key` incorrecta o fichero que no es del juego. |
| `no es un NSP` | Es .nsz/.xci. Conviértelo a .nsp (p. ej. con NSZ). |
| `No encontré ninguna ROM .gba` | El NSP es solo una actualización/DLC: usa el del juego base. |
| `Cabecera GBA válida: NO` | Extracción incorrecta; copia el mensaje completo y dímelo. |

Si el NSP usa un ticket personalizado (RSA), la herramienta no lo soporta aún; avísame.

La herramienta se prueba con un NSP sintético: `python -m pytest tests`.

Créditos: deriva de `tools/switch/xci_read.py` y `romfs_read.py` de
[pokeldn](https://github.com/Warnster/pokeldn) (AGPL-3.0).
