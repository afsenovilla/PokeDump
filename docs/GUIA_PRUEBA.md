# Guía de prueba paso a paso (Switch 2, ESP32-S3 y Chrome)

Todo el volcado es de **solo lectura**: el payload no escribe en la flash ni en el guardado, y la
Switch acaba con un mensaje que **no guarda**. Aun así, se prueba primero con una partida de prueba.

## 0. Antes de empezar
- Ordenador con **Chrome o Edge** (no móvil, no Safari) y un cable USB **de datos**.
- Tu `prod.keys` (el de tu Switch 1).
- Mantén la pestaña **visible** durante el volcado y la Switch **cerca** del ESP32: si no, el juego
  corta el enlace.

## 1. Abrir la web
Elige una de las dos:
- **Con la web publicada** (la forma sin instalar nada): el repositorio publica `web/` en GitHub
  Pages cuando activas *Settings → Pages → Source: GitHub Actions*. La dirección será
  `https://<tu-usuario>.github.io/PokeDump/`.
- **En tu ordenador:** en la carpeta del repositorio, `python3 -m http.server -d web 8000` y abre
  <http://localhost:8000/#gift> en Chrome.

## 2. Preparar el ESP32-S3 (paso 1 de la web)
1. Conéctalo por USB y pulsa **Connect**; elige la placa en la ventana de Chrome.
   Si no aparece: mantén **BOOT**, pulsa y suelta **RESET** (o conéctala con BOOT pulsado) y reintenta.
2. Si dice que le falta el firmware, pulsa **Install firmware** y espera a que termine.
3. Arrastra tu `prod.keys` al recuadro. Las claves solo van del ordenador a la placa.
4. Debe quedar con el punto en verde y firmware **2.1.0 o superior**.

## 3. Partida de prueba en la Switch (recomendado)
Una partida nueva en **otro usuario** de la Switch no toca tu partida buena:
1. *Ajustes → Usuarios → Añadir usuario* (puedes borrarlo luego).
2. Abre el juego con ese usuario, empieza una partida nueva, elige inicial y **guarda**.
3. Para que aparezca **MYSTERY GIFT** en el menú principal hay que activarlo en el juego (en GB-Link
   lo describen como responder el cuestionario de la Tienda Pokémon con *LINK TOGETHER WITH ALL*;
   en español será la opción equivalente) y **guardar**. Si ves MYSTERY GIFT en el menú principal,
   ya está.

## 4. Prueba 1 — la sonda (una sola pasada)
1. En la web, paso *Mystery Gift*, elige **«PokeDump: sonda…»** y pulsa **Start**.
2. En la Switch, desde el menú principal del juego: **MYSTERY GIFT → WONDER CARDS → FRIEND →
   GBLINK**.
3. La web debe mostrar algo como *«Sonda: Rojo Fuego (Spanish), revisión 10. Punteros correctos.»*
   y una línea con direcciones. La Switch vuelve sola al menú con un mensaje de error de
   comunicación o de «copiado»: es normal, no se guardó nada.
4. **Dime** el texto exacto (o una captura) y, si algo falla, el *registro* de la página.
   Si dice «Punteros NO fiables», paramos aquí y lo analizamos antes de seguir.

## 5. Prueba 2 — el volcado completo
1. Elige **«PokeDump: volcar la partida desde la RAM»** y **Start**; repite el camino en la Switch.
2. La web irá mostrando *«Volcando la partida: x de 53 KB»* (unos pocos minutos; no cierres la
   pestaña). La Switch muestra «Comunicando…».
3. Al terminar, la Switch enseña **«Datos copiados a la web. No se ha guardado nada.»** — pulsa A y
   vuelve al menú. **No** guardes nada desde ahí.
4. En la web aparecen dos descargas: el `.sav` (128 KB) y el `.json`.

## 6. Comprobar el resultado
- Abre el `.sav` en **PKHeX**: debe cargar sin avisos de suma de comprobación; revisa nombre,
  TID/SID, equipo y cajas. (Hall de la Fama y Torre Entrenador estarán vacíos: no están en la RAM.)
- Abre el `.json`: `trainer`, `dex.entries` (c/v por número nacional), `party` y `boxes`.
- Comparación opcional: con el evento original de GB-Link *«Back up the save (.sav file)»* se copia
  la flash; en español no está soportado todavía.

## 7. Con la partida buena
Repite 4 y 5 con tu usuario normal. La partida de prueba te habrá confirmado que todo funciona; el
volcado no escribe nada, pero tenla guardada (copia en la nube de Switch Online si la tienes).

## Si algo falla
Cuéntame: el mensaje exacto de la web, el *registro* (se puede copiar de la propia página), qué
mostró la Switch y en qué paso pasó. Casos habituales:
- **«unsupported»/«cant-accept»:** el juego no es FireRed/LeafGreen o aún no tiene MYSTERY GIFT.
- **Se cae el enlace a medias:** vuelve a entrar por FRIEND → GBLINK sin cerrar la pestaña; el volcado
  sigue por donde iba.
- **«volcado parcial»:** no se localizó el PC; recibirás el JSON sin cajas. Pásame la línea de la sonda.
