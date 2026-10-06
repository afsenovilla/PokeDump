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

## Qué se ha comprobado y qué no

- El buscador encuentra las 22 direcciones, sin ningún desajuste, en tres compilaciones distintas de Rojo Fuego y Verde Hoja en
  inglés (rev0 y rev1 de Rojo Fuego, rev1 de Verde Hoja), buscando en una usando los patrones de otra.
- La tarjeta generada se ejecuta en el emulador con el motor de scripts del propio juego y se comprueba que **instala su gancho
  en la interrupción de V-Blank y que el juego sigue funcionando** (`tests/shiny/`, hace falta compilar pret).
- El envío por Mystery Gift de la tarjeta adaptada se prueba con un cliente simulado (`tests/dump/shiny.test.mjs`).
- **No se ha probado con una ROM española de la Switch ni con una consola real.** Si el buscador no encuentra alguna
  dirección, la página lo dice y el informe (`informe.json`) lleva el detalle.

## Créditos

La tarjeta (código y textos originales) es del GB-Link Team, GPL-3.0. Los patrones de búsqueda salen del código de
[pret/pokefirered](https://github.com/pret/pokefirered).
