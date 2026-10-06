# PokeDump para Android (APK)

La app es la web de `web/` dentro de un WebView, sin servidor: el APK lleva la página y la abre sobre `https://appassets.androidplatform.net`
(contexto seguro, módulos ES y almacenamiento como en un navegador). Lo que Chrome de escritorio da y el WebView de Android no, lo aporta la app:

| Navegador | En la app |
|---|---|
| `navigator.serial` (Web Serial) | `android/app/src/main/assets/android/po-serial.js` + `SerialBridge.java`, sobre [usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android) (CDC-ACM de las placas con USB nativo —ESP32-S3/C3/C6—, y CP210x, CH340/CH9102, FTDI) |
| Elegir un puerto | Cuadro de elección de Android y permiso USB del sistema |
| Descargar archivos (`<a download href="blob:…">`) | Se guardan en `Descargas/PokeDump` |
| Elegir archivos (NSP, `prod.keys`) | El selector de documentos de Android |
| Pantalla encendida mientras se usa | `FLAG_KEEP_SCREEN_ON` |

Las señales DTR y RTS (reinicio y modo de arranque de las placas) se pasan tal cual al controlador USB, como lo hace el navegador.

## Compilar

El APK se compila en GitHub Actions (workflow **Android**: *Actions → Android → Run workflow*, con la versión) y se publica como release. En local hace falta
el SDK de Android y Gradle ≥ 8.7:

```
cd android && gradle assembleRelease    # salida: app/build/outputs/apk/release/app-release.apk
```

La web del repositorio (`../web`) se empaqueta tal cual; el shim de USB y su prueba (`tests/android/`, simula el puente nativo) están en este repositorio.

## Firma

El APK va firmado con `android/keystore/pokedump.jks` (contraseña `pokedump`, pública a propósito): garantiza que las versiones nuevas se instalen encima de las
anteriores, no que el APK sea de confianza. Si quieres una firma tuya, cambia la llave y vuelve a compilar.

## Qué no está probado

El código de la app (Java) y el shim se probaron con el puente simulado, pero **no en un dispositivo real**: la primera vez que se conecta la placa en Android puede
hacer falta ajustar el reconocimiento USB de tu placa concreta. Cuéntalo con el registro de la página («Copiar el registro»).
