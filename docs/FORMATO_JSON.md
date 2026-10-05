# Formato JSON `pokedump/1`

Lo genera la web (`web/js/dump/gen3.js`, `buildReport`) junto al `.sav`. Está pensado para
importarse en [Poketracker](https://github.com/afsenovilla/poketracker); este repositorio **no**
toca ese proyecto: aquí solo se define el formato y cómo se mapea.

```json
{
  "format": "pokedump/1",
  "dumpedAt": "2026-10-05T18:00:00.000Z",
  "game": { "title": "firered", "code": "BPRS", "revision": 10, "language": "es", "source": "ram" },
  "trainer": { "name": "JOSÉ", "gender": "m", "tid": 12345, "sid": 6789, "playTimeSeconds": 45296 },
  "dex": {
    "nationalUnlocked": true, "caught": 5, "seen": 8,
    "entries": { "1": "c", "2": "v", "25": "c" }
  },
  "party": [ { "slot": 1, "species": 6, "level": 50, "shiny": false, "nickname": "CHARIZARD" } ],
  "boxes": [ { "box": 1, "slot": 1, "species": 25, "level": 10, "shiny": true } ],
  "warnings": []
}
```

| Campo | Significado |
|---|---|
| `game.title` | `firered` o `leafgreen` (de los 3 primeros caracteres del código de juego). |
| `game.code` / `revision` | Código de cartucho (`BPRS`…) y revisión leídos de la ROM en ejecución. `language`: `es`, `en`, `fr`, `de`, `it`, `ja`. |
| `game.source` | `ram` (este volcado). |
| `trainer.tid` / `sid` | ID visible y secreto. `gender`: `m`/`f`. |
| `dex.entries` | Número de la **Pokédex nacional** (1–386) → `"c"` capturado o `"v"` visto. Si no aparece, no visto. `c` implica visto. |
| `dex.nationalUnlocked` | La Pokédex nacional estaba activada en la partida. |
| `party`, `boxes[]` | `species` es el número **nacional** (el índice interno de Gen 3 ya está convertido). `box` 1–14, `slot` 1–30 (equipo: 1–6). |
| `level` | Equipo: el guardado. Cajas: calculado desde la experiencia y la curva de crecimiento de la especie (las cajas no guardan nivel). |
| `shiny` | `(TID ^ SID ^ PID alto ^ PID bajo) < 8`, con el TID/SID **del Pokémon** (su entrenador original), no del jugador. |
| `egg` / `invalid` | Solo si es huevo / si la suma de comprobación del Pokémon falló (no te fíes de esa casilla). |
| `warnings` | Avisos del volcado (por ejemplo, «faltan las cajas»). |

## Cómo lo importaría Poketracker (propuesta, sin implementar)

La dex de un juego de Poketracker (`DexConfig.game` = `fr` o `lg`) guarda por casilla
`SlotState` con `c` (capturado) y `v` (visto), indexadas por el `id` de la entrada de
`public/data/pokedex.json`. Para las especies base ese `id` es el `slug` (`bulbasaur`) y la
entrada tiene `category: "base"` y `species: <número nacional>`.

Para cada `n → estado` de `dex.entries`:

1. Buscar la entrada con `category === "base"` y `species === n` → `id`.
2. `"c"` → `captures[dexId][id] = { c: 1, t: <ahora> }`; `"v"` → `{ v: 1, t: <ahora> }`.
3. No pisar casillas ya marcadas a mano salvo que el usuario lo pida (la web puede ofrecer
   «fusionar» o «reemplazar»). `game.title` decide la dex destino (`firered` → `fr`,
   `leafgreen` → `lg`).

Los equipos y las cajas no tienen casilla en una dex de juego; sirven para informar o para una
futura dex de HOME («en otro juego»).
