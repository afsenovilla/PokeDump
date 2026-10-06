# Tarjeta Shiny Hunting en español

La tarjeta **Shiny Hunting** del [GB-Link Team](https://github.com/GB-Link/gblink-wondercards) sube mucho la probabilidad de
Pokémon shiny salvajes (1/1024 en lugar de 1/8192, con una cadena por especie que la sube hasta 1/64). Solo estaba hecha para
el juego **en inglés**. PokeDump la adapta a **tu** versión del juego (probada pensando en Rojo Fuego y Verde Hoja en español,
pero la adaptación es la misma para el resto de idiomas occidentales).

> **Esto no es de solo lectura.** A diferencia del volcado, la tarjeta cambia el comportamiento del juego **en la memoria**
> mientras esté abierto. No escribe en la ROM ni en el guardado por sí misma, y todo desaparece al cerrar o reiniciar el
> juego. Aun así, un fallo en una dirección puede colgar el juego, y si guardas justo después, el estado raro podría llegar al
> guardado. **Haz antes una copia** (el volcado de la web te da un `.sav`) y pruébala primero con un usuario de prueba.

## Cómo funciona la adaptación

La tarjeta es código que llama a unas 8 funciones y 13 variables del juego **por dirección fija**, y esas direcciones cambian
con el idioma. En vez de tablas fijas, PokeDump las **busca en tu propia ROM**:

1. En la página [«Comprobar mi juego»](https://afsenovilla.github.io/PokeDump/extraer.html) pasas tu NSP y tu `prod.keys`
   (se procesan en tu navegador; nada se sube). Además de extraer la ROM, busca el código de cada función y lee las variables
   de las funciones que las usan. Los patrones salen del código fuente del juego (`pret/pokefirered`, ver
   `tools/shiny_build_ref.py`).
2. Si encuentra las 22 direcciones, las guarda **en tu navegador** y lo dice («✓ 22 direcciones encontradas»).
3. En la página principal aparece activa la opción **Tarjeta Shiny Hunting**. Al enviarla, la página rellena la tarjeta con
   tus direcciones, ajusta la comprobación de versión (`BPG`/`BPR` + idioma + revisión 10) y traduce los textos.

## Uso

1. Pasa tu NSP por «Comprobar mi juego» (una sola vez por versión de juego y navegador).
2. En la página principal conecta la placa, elige **Tarjeta Shiny Hunting** y pulsa **Empezar**.
3. En la Switch: **MYSTERY GIFT → WONDER CARDS → FRIEND → GBLINK** y acepta la tarjeta.
4. Cuando la guarde, habla con el **repartidor** (el de verde) en la planta de arriba de un Centro Pokémon. El efecto dura
   hasta cerrar o reiniciar el juego: tras reiniciar, vuelve a hablar con él. **R** en el campo muestra tu cadena.

## Probabilidad a elegir

La web permite cambiar la probabilidad antes de enviar la tarjeta (se parchea el cálculo del umbral en el gancho):

| Opción | Efecto |
|---|---|
| Original | `(min(cadena, 30) + 2) × 32 / 65536`: de 1/1024 con cadena 0 a 1/64 con cadena 30 |
| Fija 1/64 … 1/2 | umbral fijo `65536 / N`, sin cadena |
| Siempre shiny | umbral 65536: todo salvaje sale shiny |
| **R activa/desactiva «siempre shiny»** | la tecla **R** en el campo conmuta un indicador. Apagado = probabilidad original con cadena; encendido = siempre shiny. El mensaje de R dice `Siempre shiny: Sí` o `Siempre shiny: No` |

En el modo R, para hacer sitio en el código, la cadena cuenta para cualquier especie (en el original solo si coincide con la del encuentro anterior)
y R ya no comprueba el bloqueo del campo ni muestra la especie. Empieza **apagado**.

## Tarjeta «Ultra Ball = Master Ball»

Reutiliza el instalador y el gancho de V-Blank, pero con una sola función. En cada V-Blank:

1. Si hay una bola convertida pendiente y la bola registrada en `gEnemyParty[0]` es la Master Ball (1) —la escribe el propio juego al capturar,
   con `gLastUsedItem`—, la devuelve a la bola original con `SetMonData`: el Pokémon queda registrado en la Ultra Ball (o la elegida).
2. Si `gLastUsedItem` es una de las bolas elegidas (Ultra 2, Super 3, Poké 4), anota cuál era y la cambia por Master Ball (1) antes de
   que el combate calcule la captura (`Cmd_handleballthrow`). La mochila ya descontó la bola que elegiste (usa `gSpecialVar_ItemId`).

Opción «No gastar la bola»: al convertirla, el gancho llama a `AddBagItem(bola, 1)` y la mochila recupera la bola que acaba de gastar
(el juego la descuenta al elegirla en la mochila, antes de lanzarla; hay que tener al menos una). Se probó con `AddBagItem`/`RemoveBagItem`
reales. No se mete la bola en «Objetos clave» porque la mochila de combate no muestra ese bolsillo: no se podría lanzar desde ahí.
Contra Pokémon de entrenador el juego bloquea la bola como siempre. Efectos secundarios: el mensaje y la animación del lanzamiento pueden
mostrar la Master Ball; y si tras un lanzamiento fallido usas una Master Ball de verdad en el mismo combate, quedaría anotada como la bola
anterior. Necesita más direcciones (`gLastUsedItem`), así que hay que repetir «Comprobar mi juego» una vez. Probado en el emulador con las
funciones reales del juego (conversión, registro y restauración de la bola); no se ha simulado un lanzamiento completo.

### Bolas + shiny en la misma tarjeta

La tarjeta de bolas puede llevar además Shiny Hunting con probabilidad fija (1/64 … siempre shiny) o con el modo «R alterna». Para hacer
sitio, la función de las bolas ocupa el hueco de la función de la cadena (que con probabilidad fija no hace falta); en el modo R la cadena
queda a 0, así que apagado = 1/1024. No se puede combinar con el modo original de cadena. En la variante combinada la bola pendiente se anota
en +20 del estado del gancho (en la sola, en +8) y usa huecos libres del pool de literales. Probado en el emulador: instalación, conversión,
restauración de la bola, reembolso y la tecla R en las variantes combinadas.

## Tarjeta «Regalos shiny» (equipo y cajas)

Los regalos del juego (`givemon`/`giveegg`: iniciales, fósiles, Hitmon, Eevee, Lapras, Magikarp, huevos) se crean fuera de los combates, así
que el gancho normal no los toca. Esta tarjeta es Shiny Hunting con probabilidad fija (1/64 … siempre) más una función nueva, en el hueco de
la función de la cadena y del gestor de R (aquí no hacen falta, así que no lleva la tecla R ni la bola), que cada V-Blank vigila:

- **Equipo:** si `gPlayerPartyCount` sube, el Pokémon nuevo es `gPlayerParty + (n−1)·100`.
- **Cajas:** guarda la primera casilla libre de la caja actual (`gPokemonStoragePtr`, bit `hasSpecies` del byte 0x13 de cada `BoxPokemon`);
  si pasa de *i* a *j > i* en la misma caja, el Pokémon nuevo está en la casilla *i*. Se copia a un `struct Pokemon` temporal (el cálculo de
  estadísticas necesita 100 bytes y las cajas guardan 80), se aplica y se copia de vuelta.

Para cada candidato se llama a la función de shiny de siempre (con el puntero en +24 del estado y como si fuera nuevo), que solo actúa si el
juego está en el campo (`CB2_Overworld`) y el Pokémon es tuyo (mismo ID): los intercambios y lo que entra desde el PC o un menú no se tocan,
y los capturados ya salieron shiny en el combate. El primer Pokémon que entra con el equipo vacío no se toca (no hay instantánea previa).
Probado en el emulador con `ScriptGiveMon`: regalos al equipo, a la caja con el equipo lleno y a la segunda casilla, sin falsos positivos
fuera del campo, y los salvajes siguen funcionando. Necesita tres direcciones más (`gPlayerPartyCount`, `gPlayerParty`,
`gPokemonStoragePtr`): hay que repetir «Comprobar mi juego» una vez. Un fallo encontrado y corregido en las pruebas: el búfer temporal debe
acabar antes del final de la EWRAM (0x0203FFFC); si se pasa, la escritura da la vuelta y corrompe el montón del juego.

## Tarjeta «Reiniciar eventos»

Otra tarjeta, solo de script del juego (sin código nativo ni calibración): borra con `clearflag` las marcas de eventos de un solo uso, a
elegir. Al volver a cargar el mapa, el propio juego los vuelve a mostrar. Habla con el repartidor y luego sal del mapa y vuelve a entrar.
Las marcas se guardan con tu partida si guardas. Grupos (banderas de `pret/pokefirered`):

| Grupo | Banderas |
|---|---|
| Legendarios | `FLAG_FOUGHT_MEWTWO/MOLTRES/ARTICUNO/ZAPDOS` (0x2BC–0x2BF); al cargar el mapa se vuelven a mostrar (`call_if_unset FLAG_FOUGHT_X → clearflag FLAG_HIDE_X`) |
| Fósiles | `FLAG_GOT_FOSSIL_FROM_MT_MOON` y `FLAG_GOT_DOME/HELIX_FOSSIL` (el Monte Luna vuelve a mostrar los dos), `FLAG_GOT_OLD_AMBER` + `FLAG_HIDE_OLD_AMBER`, y `FLAG_REVIVED_*` del laboratorio |
| Hitmons | `FLAG_GOT_HITMON_FROM_DOJO` y `FLAG_HIDE_DOJO_HITMONLEE/CHAN_BALL` |
| Eevee | `FLAG_GOT_EEVEE` y `FLAG_HIDE_EEVEE_BALL` |
| Lapras | `FLAG_GOT_LAPRAS_FROM_SILPH` |
| Magikarp | `FLAG_BOUGHT_MAGIKARP` (se paga otra vez) |
| Islas de eventos | da `ITEM_MYSTIC_TICKET` y `ITEM_AURORA_TICKET` (`additem`), pone `FLAG_ENABLE_SHIP_NAVEL_ROCK/BIRTH_ISLAND` (banderas de sistema 0x84A/0x84B) y `FLAG_RECEIVED_*_TICKET`, y borra `FLAG_FOUGHT_/…_FLEW_AWAY` de LUGIA, HO-OH y DEOXYS. El barco de Ciudad Carmín solo ofrece estas islas con el Pase Arcoíris (final del juego) |
| Snorlax | `FLAG_HIDE_ROUTE_12/16_SNORLAX` y `FLAG_WOKE_UP_ROUTE_12_SNORLAX`: reaparece dormido bloqueando el camino; hace falta la Flauta Poké |

Para los fósiles necesitas el fósil en la mochila para revivirlo, y volver a elegir te da otro. Se probó con el motor de scripts del juego
(`tests/shiny/`): con todos los grupos borra solo esas marcas y ninguna vecina, y con un juego de otra versión la comprobación corta el script.

## Qué se ha comprobado y qué no

- El buscador encuentra las 22 direcciones, sin ningún desajuste, en tres compilaciones distintas de Rojo Fuego y Verde Hoja en
  inglés (rev0 y rev1 de Rojo Fuego, rev1 de Verde Hoja), buscando en una usando los patrones de otra.
- La tarjeta generada se ejecuta en el emulador con el motor de scripts del propio juego y se comprueba que **instala su gancho
  en la interrupción de V-Blank y que el juego sigue funcionando** (`tests/shiny/`, hace falta compilar pret).
- Los parches de probabilidad se ejecutan en el emulador (`tests/test_shiny_threshold_mgba.py`: umbral exacto en cada modo) y la tecla R
  conmuta el indicador y su variable con el gancho instalado en un pret (`tests/shiny/`).
- El envío por Mystery Gift de la tarjeta adaptada se prueba con un cliente simulado (`tests/dump/shiny.test.mjs`).
- **No se ha probado con una ROM española de la Switch ni con una consola real.** Si el buscador no encuentra alguna
  dirección, la página lo dice y el informe (`informe.json`) lleva el detalle.

## Créditos

La tarjeta (código y textos originales) es del GB-Link Team, GPL-3.0. Los patrones de búsqueda salen del código de
[pret/pokefirered](https://github.com/pret/pokefirered).


## Regalos shiny + reiniciar un evento

La tarjeta de Regalos shiny puede, además, reiniciar **un** evento (fósiles, Hitmons, Eevee, Lapras, Magikarp, legendarios o Snorlax): se elige en el panel «Reiniciar un evento a la vez». Solo uno porque el script de la tarjeta no tiene más hueco (los `clearflag` van donde estaba el gestor de R); las islas (pases) no caben, y para varios eventos o las islas hay que usar la tarjeta Reiniciar eventos aparte.
