# Compatibilidad entre navegadores

Estado de OptimusPDF en Chromium, Safari (WebKit) y Firefox, medido en la Wave 9 («pruebas cruzadas»). Hasta entonces
toda la verificación automática era en Chromium; aquí queda qué se probó en los otros motores, qué falló, qué se corrigió y qué
sigue sin comprobarse.

> **Leyenda.** **OK** = probado con pruebas E2E en navegador real (headless) y pasa. **OK (degrada)** = funciona con una
> limitación del motor que la aplicación absorbe (detecta la función, avisa o usa otra vía). **Corregido** = el motor destapó un
> defecto de la aplicación que se arregló en esta wave. **Sin probar** = no se ejecutó en ese motor; el estado entre paréntesis
> es lo esperable por la documentación de la API, NO una comprobación. **No soportado** = el motor no lo ofrece y la aplicación
> no lo usa.

## 1. Qué se ejecutó

| Motor | Versión probada | Equivalente de usuario | Proyecto de Playwright | Resultado (subconjunto de flujos principales, build de producción) |
|---|---|---|---|---|
| Chromium | 151.0.7922.34 | Chrome / Edge 151 | `chromium`, `chromium-fake-camera` (los de siempre) | 603 pruebas del subconjunto: **599 pasan, 4 omitidas, 0 fallan**. Suite completa con la configuración de CI (`CI=1`, 2 trabajadores, 1 reintento): 832 pasan, 4 omitidas, 0 fallan, 0 repetidas. |
| WebKit | 26.5 (Playwright `webkit-2336`, macOS) | Safari 26.5 en escritorio | `webkit` | Las MISMAS 603 pruebas: **591 pasan, 12 omitidas, 0 fallan**, en 3 ejecuciones completas seguidas con el código final (16 min cada una). Las omitidas son las de CDP, un `mouse.wheel` de WebKit móvil y los atajos de escritorio (§4). |
| WebKit móvil | 26.5, iPhone 15 Pro (393 px, DPR 3, táctil, agente de iOS) | Safari en iPhone | `webkit-mobile` | 383 pruebas (subconjunto móvil, §2): **382 pasan, 1 omitida, 0 fallan** (última ejecución, 13 min). En las dos anteriores hubo un fallo cada una, por carga con 2 trabajadores: uno ya corregido (`pdf-pro-foundation`, §6 punto 6) y otro (`pdf-pro-history-memory`, esperar 5 s a que se pinte una hoja a DPR 3) que repetido 20 veces seguidas no vuelve a fallar. |
| Firefox | 153.0 (Playwright `firefox-1538`) | Firefox 153 | `firefox` | **No se pudo ejecutar en el equipo de pruebas** (ver abajo). El proyecto está configurado y las pruebas adaptadas, pero NO hay resultados. |

**Firefox no arrancó.** En el equipo de pruebas (macOS 27.2, Apple Silicon) el Firefox 153 de Playwright lanza el proceso y se queda
con el hilo principal al 99 % de CPU sin llegar a abrir el canal con Playwright (el stderr solo dice
`sandbox_extension_issue_file_to_process failed ... Operation not permitted` y `RenderCompositorSWGL failed mapping default
framebuffer`). Se probó 5 veces (lanzamiento por defecto, con la sandbox de contenido desactivada, con preferencias de gráficos y
directamente con `firefox -headless --screenshot`): ninguna produjo una página. No es un fallo de la aplicación (ni siquiera llega a
cargarla); es el navegador sobre ese sistema. Para correrlo: en otra máquina (Linux o Mac con un macOS publicado) o desde la
integración continua (ver §2). **Todo lo que esta página dice de Firefox es lectura de código y de la documentación de las API.**

### Resultados por spec (última ejecución: Chromium suite completa; WebKit, tercera ejecución seguida)

| Spec | Chromium (pasan / omitidas) | WebKit (pasan / omitidas) |
|---|---|---|
| a11y-sweep | 110 / 0 | 110 / 0 |
| compress | 4 / 0 | 4 / 0 |
| convert-out | 15 / 0 | 15 / 0 |
| edit-existing-text | 4 / 0 | 4 / 0 |
| edit-pdf-flow | 17 / 0 | 15 / 2 (CDP) |
| exif-orientation | 7 / 0 | 7 / 0 |
| focus-own-headers | 18 / 0 | 18 / 0 |
| image-conversion | 13 / 0 | 13 / 0 |
| merge-pdf | 10 / 0 | 10 / 0 |
| ocr-pdf | 3 / 0 | 3 / 0 |
| organize-pdf | 5 / 0 | 5 / 0 |
| pages-migration | 4 / 0 | 4 / 0 |
| pages-warnings | 16 / 0 | 16 / 0 |
| pdf-pro-create | 12 / 0 | 12 / 0 |
| pdf-pro-export | 15 / 1 | 15 / 1 (atajos de escritorio) |
| pdf-pro-export-persistent | 21 / 0 | 21 / 0 |
| pdf-pro-foundation | 18 / 0 | 18 / 0 |
| pdf-pro-history-memory | 2 / 0 | 2 / 0 |
| pdf-pro-journeys | 14 / 0 | 14 / 0 |
| pdf-pro-memory | 5 / 0 | 5 / 0 |
| pdf-pro-modes-edit | 23 / 0 | 23 / 0 |
| pdf-pro-modes-sign | 32 / 2 | 31 / 3 (+1 `mouse.wheel` en WebKit móvil) |
| pdf-pro-pages | 22 / 1 | 21 / 2 (+1 arrastre táctil por CDP) |
| pdf-pro-shared-content-edit | 1 / 0 | 1 / 0 |
| pdf-pro-tools | 9 / 0 | 9 / 0 |
| pdf-pro-unload | 3 / 0 | 3 / 0 |
| pdf-pro-viewer | 26 / 0 | 25 / 1 (pellizco por CDP) |
| pdf-pro-viewer-damaged | 4 / 0 | 4 / 0 |
| protect-unlock | 8 / 0 | 8 / 0 |
| remove-extract-pages | 8 / 0 | 8 / 0 |
| sign-edit-summary | 9 / 0 | 9 / 0 |
| sign-multi | 3 / 0 | 3 / 0 |
| sign-quality | 17 / 0 | 17 / 0 |
| signature-font | 4 / 0 | 4 / 0 |
| split-pdf | 6 / 0 | 6 / 0 |
| tool-errors | 111 / 0 | 108 / 3 (árbol de accesibilidad por CDP) |
| **Total** | **599 / 4** | **591 / 12** |

Cómo se llegó al verde en WebKit (para que se vea que no salió gratis): la primera ejecución completa dio 519 pasan / 77 fallan
(sobre todo ruido benigno de consola, CDP, el Tab de Safari y nombres de archivo en NFD, además de los defectos de §6 y de arreglos de las propias pruebas); la segunda, 569 / 19; la tercera, 587 / 4. Después, con el
código final, 591 / 0 tres veces seguidas. Dos ejecuciones intermedias tuvieron un fallo suelto cada una (un clic de Playwright
perdido en `pdf-pro-modes-sign` y la rueda del ratón sobre una zona que aún se acomodaba): se endurecieron las esperas y no han
vuelto a salir (modes-sign ×3 repeticiones en WebKit y en Chromium, sin fallos).

## 2. Cómo correr las pruebas cruzadas

Son OPCIONALES: por defecto `playwright.config.ts` solo define `chromium` y `chromium-fake-camera`, igual que antes, y la
integración continua no cambia. Los proyectos de WebKit y Firefox solo existen si se pide con `PW_BROWSERS`
(lista separada por comas: `webkit`, `webkit-mobile`, `firefox` o `all`).

```bash
npx playwright install webkit firefox          # una vez (descarga estándar de Playwright, ~180 MB)

# 1) Build de producción propia. WebKit aplica `upgrade-insecure-requests` también a http://localhost y deja la página en
#    blanco: para estas pruebas la CSP se construye sin esa directiva (Chromium y Firefox no la necesitan, pero no les afecta).
CSP_SKIP_UPGRADE_INSECURE=1 npm run build
CSP_SKIP_UPGRADE_INSECURE=1 npm run start -- -p 3780        # en otra terminal

# 2) Pruebas (máx. 2 trabajadores). PW_REUSE_SERVER=1 usa el servidor del paso 1 aunque CI=1.
CI=1 PW_REUSE_SERVER=1 PW_PORT=3780 PW_BROWSERS=all npx playwright test --project=webkit --workers=2
CI=1 PW_REUSE_SERVER=1 PW_PORT=3780 PW_BROWSERS=all npx playwright test --project=webkit-mobile --workers=2
CI=1 PW_REUSE_SERVER=1 PW_PORT=3780 PW_BROWSERS=all npx playwright test --project=firefox --workers=2
```

- Sin `PW_REUSE_SERVER`, con `CI=1` Playwright construye y arranca la build él mismo (y, si se piden WebKit o `all`, le pasa
  `CSP_SKIP_UPGRADE_INSECURE=1`).
- Cada proyecto cruzado corre solo los flujos principales (`CROSS_SPECS` en `playwright.config.ts`: PDF Pro, páginas, unir/dividir/
  organizar/quitar/extraer, edición de texto existente, firmar, conversión, OCR, imágenes, accesibilidad, errores de herramienta…).
  Con `PW_CROSS_FULL=1` corren todos los specs salvo `scan-to-pdf` (necesita la cámara falsa de Chromium).
- `webkit-mobile` deja fuera los specs con bloques de escritorio por diseño (rueda del ratón, que Playwright no soporta en WebKit
  móvil, arrastres con ratón, medidas de escritorio): `compress*`, `edit-pdf-flow`, `pdf-pro-viewer`, `pdf-pro-pages`,
  `pdf-pro-modes-sign`, `pdf-pro-memory`, `tool-errors`. Sus bloques de 375 px táctil ya corren en `webkit`.
- Siempre headless (el valor por defecto de Playwright): no se abre ninguna ventana.

## 3. Inventario: funcionalidad × navegador

Versiones: Chrome/Edge 151, Safari (WebKit) 26.5. Las demás versiones no se probaron (ver §5).

| Funcionalidad | Chrome / Edge | Safari | Firefox | Notas |
|---|---|---|---|---|
| Abrir y ver PDF (pdf.js, worker de módulo `pdf.worker.min.mjs`) | OK | OK | Sin probar (OK: pdf.js es de Mozilla) | Visor continuo con 500 páginas mixtas y de ~40 MB: virtualiza y abre dentro de presupuesto en Safari. |
| Visor por rangos (`PDFDataRangeTransport`, PDF ≥ 16 MB) | OK | OK | Sin probar | Se comprobó que las páginas salen idénticas a la apertura entera (40 MB). |
| Historial en disco y borradores (IndexedDB, trozos por contenido) | OK | OK (degrada) → **Corregido** | Sin probar | Safari con sesión efímera o modo privado rechaza guardar `Blob` en IndexedDB (la transacción falla sin error): el historial se quedaba solo en memoria. Ahora se reintenta con bytes y funciona. Las filas de bytes (borradores, trozos) nunca tuvieron el problema. |
| Web Locks (purga de bases de sesiones muertas) | OK | OK (degrada) | Sin probar (OK, Firefox 96+) | Se detecta `navigator.locks`; sin él no se borra nada (sin riesgo para otra pestaña). |
| Aviso al cerrar con cambios (`beforeunload`) y volcado del borrador | OK | OK → **Corregido** | Sin probar | El aviso real del navegador sale en Safari. El volcado del borrador desde `beforeunload` (recargar justo después de aplicar un cambio, antes de los 0,6 s del autoguardado) se perdía ~1 de cada 5 veces en WebKit (3 de 16): la transacción de IndexedDB se confirmaba al quedar ocioso el bucle y la recarga se llevaba la orden. Ahora se confirma en la misma tarea (`IDBTransaction.commit()`): 0 de 30 en WebKit de escritorio, 0 de 30 en iPhone y 0 de 30 en Chromium. Las escrituras grandes (> ~64 KB) siguen sin sobrevivir a una recarga en ningún motor: manda el autoguardado. El WebKit de Playwright no completa `page.close({ runBeforeUnload })` en una página con manejadores (limitación del arnés, ver §4). |
| Descarga de resultados (`<a download>` con `Blob`) | OK | OK | Sin probar | No se usa `showSaveFilePicker` (solo Chromium): nunca hubo nada que degradar. En macOS, Safari propone el nombre en NFD (la «ñ» llega como «n» + tilde): mismo texto, otros bytes. |
| Arrastrar y soltar archivos | OK | OK (sintético) | Sin probar | Se probó con un `DataTransfer` sintético; el arrastre real del sistema no se probó. |
| Canvas: `toBlob` PNG/JPEG, `createImageBitmap`, orientación EXIF | OK | OK | Sin probar (OK, Firefox 93+) | Las 4 orientaciones EXIF salen derechas en Safari (imagen a PDF y «Nuevo desde imágenes»). |
| `OffscreenCanvas` | OK | Sin probar | Sin probar (OK, 105+) | Solo lo usa el análisis de fotogramas de «Escanear» (tipo `HTMLCanvasElement \| OffscreenCanvas`); `scan-to-pdf` no se ejecuta fuera de Chromium. |
| `requestIdleCallback` | OK | No soportado (degrada) | Sin probar (OK) | Safari no lo tiene: el código lo detecta y usa `setTimeout` (comprobado: 3 sitios con detección). |
| Fuentes: `document.fonts` y Caveat (firma escrita) | OK | **Corregido** | Sin probar | Safari devuelve `true` en `document.fonts.check()` mientras la fuente baja y llama «error» a una cara `font-display: swap` que sigue descargándose: la firma se exportaba con la fuente de respaldo, distinta de la vista previa y sin aviso. Ahora también se mira cada cara de la familia que cubre el texto. |
| Firmar: dibujar, escribir, subir; varios firmantes; firmas guardadas | OK | OK | Sin probar | Nitidez de la hoja igual al render nativo de pdf.js a DPR 1 y 2. |
| Rellenar formularios (`<select>`, casillas, radios) | OK | **Corregido** | Sin probar | El `<select>` de Rellenar medía 23 px en Safari (Safari ignora `min-height` en el menú nativo; el objetivo táctil es de 44 px). Ahora lleva `h-11`. |
| Editar texto existente (F2), añadir texto/imagen/formas | OK | OK | Sin probar | La barra flotante: ver §4 (un clic de Playwright desplazaba la página en WebKit; no es un defecto de la aplicación). |
| HTML → PDF e «Insertar desde HTML» (html2canvas en un iframe aislado) | OK | **Corregido** (se colgaba) | Sin probar | Safari no ejecuta NINGÚN manejador de eventos sobre los elementos de un documento sin scripts (`sandbox` sin `allow-scripts`); html2canvas espera `iframe.onload` del iframe de clonado que crea ahí dentro: la conversión se quedaba en el 11 % para siempre. Ahora ese `onload` lo dispara la página (sondeo de `readyState`), sin dar scripts al contenido. |
| Páginas del HTML → PDF en pantallas de DPR ≥ 2 (Retina, iPhone) | **Corregido** | **Corregido** | Sin probar | Un documento corto se pasaba de la página por el redondeo del alto medido (1027 px frente a 1026,52) y a escala 2 salía una página extra casi en blanco. También afectaba a Chrome en un Mac. |
| OCR (tesseract.js, WASM, worker desde `blob:`) | OK | OK | Sin probar | Sin red: error claro y se puede reintentar (el mismo mensaje que en Chrome). |
| Conversión (Word, Excel, PowerPoint, imágenes en ZIP; motores de carga diferida) | OK | OK | Sin probar | Los 8 formatos de exportación de PDF Pro y los de «Convertir desde PDF». |
| Comprimir, proteger/desproteger, unir, dividir, organizar, quitar/extraer | OK | OK | Sin probar | |
| Zoom táctil (`useZoomGestures`: eventos de puntero, no `gesture*`) | OK (emulado con CDP) | Sin probar | Sin probar | El pellizco solo se emula con CDP (Chromium). En Safari de iPhone depende de `touch-action: pan-x pan-y` y de los eventos de puntero (iOS 13+): no se probó con dedos. |
| CSS: `oklch`, `color-mix`, `@layer`, `:has`, `dvh`, `backdrop-filter`, `scroll-padding`, subgrid, contenedores | OK | OK | Sin probar (OK por versión, ver §5) | `CSS.supports` verdadero para todo en WebKit 26.5. Capturas a 1280×800 y 375×812, claro y oscuro (Inicio, PDF Pro vacío y con documento, Firmar, Editar, Comprimir): sin desbordes ni textos rotos. |
| Contraste y accesibilidad (axe: contraste, `aria-valid-attr-value`, etiquetas) | OK | OK | Sin probar | 7 rutas × claro/oscuro × ES/EN × 1280/375 px, también con archivo cargado y con la hoja «Opciones». |
| Teclado: saltar al contenido y Tab sin pasar por `<body>` | OK | OK (con Opción+Tab) | Sin probar | Safari de macOS, por defecto, solo lleva el Tab a campos y menús: botones, casillas y enlaces se alcanzan con **Opción+Tab** (o activando «Pulsar Tab para resaltar cada elemento» y el acceso total con teclado). No es del sitio; las pruebas lo tienen en cuenta. |
| Foco tras pulsar un botón | OK | OK (degrada) | Sin probar | Safari no da el foco a un botón al hacer clic: el foco queda en el contenedor enfocable más cercano (`<main>`, el diálogo). Nunca cae en `<body>`. Con teclado o lector de pantalla (Enter / Espacio) el foco se reparte como en Chrome. |
| Cámara (Escanear a PDF) | OK (cámara falsa) | OK (dispositivo simulado de WebKit) | Sin probar | Solo se probó el reparto del foco con dispositivos simulados; una cámara real no. `scan-to-pdf.spec.ts` no corre fuera de Chromium. |
| Resumen con IA local (WebGPU, WebLLM) | OK (Chrome/Edge con WebGPU) | Sin probar | Sin probar (WebGPU solo en algunas plataformas) | Fuera del subconjunto probado. La herramienta ya avisa si no hay WebGPU con `shader-f16`. |
| Métricas de rendimiento (`PerformanceObserver` `longtask`, `performance.memory`, CDP) | Solo en pruebas | No soportado | No soportado | Solo las usan las pruebas de rendimiento de Chromium; la aplicación no las necesita. |
| Contraste alto de Windows (`forced-colors`) | OK (emulado) | Sin probar | Sin probar | Se emula con `emulateMedia({ forcedColors })`; el Windows real con contraste alto no se probó. |
| Pantalla táctil real, lector de pantalla real (VoiceOver, NVDA, TalkBack) | Sin probar | Sin probar | Sin probar | Solo hay emulación táctil (`hasTouch`, `isMobile`) y árbol de accesibilidad por CDP (Chromium). |

## 4. Diferencias de motor que las pruebas conocen

Fallos que NO son de la aplicación, sino del motor o de Playwright, y cómo se tratan (`e2e/helpers/engine.ts`):

| Diferencia | Dónde se nota | Qué hace la prueba |
|---|---|---|
| **CDP** (`newCDPSession`, `Emulation.setCPUThrottlingRate`, `Accessibility.getFullAXTree`, `Input.dispatchTouchEvent`, `Performance.getMetrics`) existe solo en Chromium | arrastres táctiles (`pdf-pro-pages`, `edit-pdf-flow`), pellizco, árbol de accesibilidad, memoria de heap | `test.skip(browserName !== "chromium", motivo)` en cada prueba afectada; en las de rendimiento del visor solo se omite el presupuesto de heap (`heapMB` devuelve `null`), no la virtualización ni los tiempos. |
| Safari: Tab solo recorre campos y menús | barridos de Tab (`a11y-sweep`, `pdf-pro-foundation`, `pdf-pro-viewer`, `edit-pdf-flow`) | `tabKey(page)`: Opción+Tab en el WebKit de macOS; Tab en el resto. |
| Safari: un clic no enfoca el botón | pruebas de foco tras una acción | `activate(boton)`: foco + Enter en el WebKit de macOS (la ruta de teclado y de lector de pantalla); clic en el resto. |
| WebKit entrega las URL `blob:` a `route()` (Chromium no) | pruebas «sin red» de OCR y conversión | El corte de red solo afecta a `http(s)` fuera de `localhost` (`isExternalNetworkUrl`); antes abortaba también el `blob:` del worker de tesseract. |
| Ruido benigno de WebKit como excepción de página: `ResizeObserver loop completed with undelivered notifications`, precargas cancelables (`?_rsc=… due to access control checks`, `pdf.worker.min.mjs?v=… due to access control checks`) | los guardianes de consola | `isBenignEngineNoise` los ignora SOLO con ese texto exacto; cualquier otro error de consola sigue fallando. |
| WebKit propone el nombre de descarga en NFD | pruebas con «ñ» en el nombre | `downloadFile` normaliza a NFC antes de comparar. |
| `fetch(blob:)` está bloqueado por `connect-src 'self'` en WebKit | `sign-quality` lee el bitmap de la hoja | Se lee el mismo bitmap por un canvas (la aplicación nunca hace `fetch` de un `blob:`). |
| `mouse.wheel` no existe en WebKit móvil | un bloque de `pdf-pro-modes-sign` en 375 px | `test.skip` con motivo. |
| `page.close({ runBeforeUnload: true })` no termina en el WebKit de Playwright si la página tiene manejadores de `beforeunload` y un borrador guardado | `pdf-pro-unload` | Se omite solo ese último cierre; el aviso (evento sintético y diálogo real con cambios sin guardar) sí se prueba. |
| En WebKit, `navigator.mediaDevices.getUserMedia = …` y `indexedDB.open = …` asignados a la instancia no se conservan | simulaciones en `focus-own-headers` y `pdf-pro-history-memory` | Se reemplazan en el prototipo (`MediaDevices.prototype`, `IDBFactory.prototype`). Antes la prueba «IndexedDB falla» solo pasaba porque el WebKit efímero rechazaba el `Blob`. |
| `locator.click()` desplaza la página en WebKit al encadenar clics sobre la barra flotante de Editar | `edit-existing-text` | `pointerClick`: clic de ratón real (`page.mouse`) tras esperar a que el control esté quieto. El mismo recorrido con ratón no mueve la página. |
| El resaltado de `pdf-pro-modes-edit` se detectaba solo por los píxeles antialias del borde (color (255, 250, 225)); según la fracción de punto del borde salían 85 o 0 coincidencias | `pdf-pro-modes-edit` | Ahora cuenta el color del INTERIOR del resaltado (255, 249, 200). |
| Un clic justo después de subir un PDF puede perderse en WebKit (el documento aún se monta) | `signature-font`, `pdf-pro-modes-sign`, `sign-multi` | Esperas de «hoja pintada / caja quieta» y reintento hasta que se abre la hoja. |
| `permissions: ["camera"]` lanza «Unknown permission» en Firefox; los argumentos `--use-fake-device…` son de Chromium | `focus-own-headers` | Permisos y cámara falsa por motor (Chromium: argumentos; WebKit: dispositivos simulados; Firefox: `media.navigator.streams.fake`, sin verificar). |

## 5. Versiones mínimas (realistas, NO verificadas)

Solo se probaron las versiones actuales de cada motor. Lo siguiente sale de las dependencias y de la compatibilidad documentada de
cada API; antes de prometerlo hay que probarlo.

| Pieza | Exige | Chrome / Edge | Safari | Firefox |
|---|---|---|---|---|
| Tailwind CSS v4 (referencia de la hoja de estilos: `oklch`, `color-mix`, `@layer`, propiedades registradas) | navegadores modernos | 111 | 16.4 | 128 |
| pdf.js 6.1 (compilación moderna: `Promise.withResolvers` y otras funciones recientes, sin rellenos) | `Promise.withResolvers`, workers de módulo | 119 | 17.4 | 121 |
| `:has`, `dvh`, `scrollbar-gutter`, `backdrop-filter` sin prefijo | | 105 / 108 / 94 / 76 | 15.4 / 15.4 / 18.2 / 18 | 121 / 101 / 97 / 103 |
| `createImageBitmap` con `imageOrientation: "from-image"`, `OffscreenCanvas` 2D | | 81 | 16.4 / 17 | 93 / 105 |
| `navigator.locks` (opcional: se detecta) | | 69 | 15.4 | 96 |

Mínimo práctico de lo que arranca todo: **Chrome/Edge 119, Safari 17.4, Firefox 128**. Por debajo, la hoja de estilos o pdf.js
fallan antes de llegar a cualquier detección de funciones de la aplicación. No hay navegador «antiguo soportado»: no existe una
compilación `legacy` de pdf.js en uso.

## 6. Defectos reales que las pruebas cruzadas destaparon (corregidos)

1. **HTML → PDF y «Insertar desde HTML» se colgaban en Safari** (al 11 %). Causa: WebKit no ejecuta manejadores de eventos
   sobre los elementos de un documento sin scripts. `src/lib/pdf/htmlToPdf.ts` (`installPolledOnload`,
   `makeNestedFramesLoadObservable`). Prueba: `htmlToPdf.frameLoad.test.ts` y `pdf-pro-create.spec.ts` (WebKit).
2. **Una página extra casi en blanco al convertir HTML corto en pantallas de DPR ≥ 2** (también Chrome en un Mac). Causa: el alto
   del documento se mide en px enteros y a escala 2 el resto de 1 px era una banda. `planPageSlices(…, tailTolerance)`. Prueba:
   `htmlToPdf.test.ts` (3 casos) y el mismo E2E en WebKit (DPR 2).
3. **La firma escrita podía exportarse con la fuente de respaldo, en silencio, en Safari.** Causa: `document.fonts.check()` miente
   mientras la fuente baja. `src/app/sign-pdf/SignatureComposer.tsx` (`signatureFontReady`, `unicodeRangeCovers`). Prueba:
   `SignatureComposer.fontReady.test.tsx` y `signature-font.spec.ts` (WebKit).
4. **El historial de PDF Pro no se volcaba a disco en Safari con sesión efímera o modo privado** (rechazo de `Blob` en
   IndexedDB). `src/app/pdf-pro/proHistoryStore.ts` reintenta con bytes y deja de probar `Blob` en esa sesión. Prueba:
   `proHistoryStore.test.ts` (2 casos) y `pdf-pro-history-memory.spec.ts` (WebKit).
5. **El desplegable de «Rellenar» medía 23 px en Safari** (`min-h-11` no basta en un `<select>`). `FillEmbedded.tsx`. Prueba:
   `pdf-pro-modes-sign.spec.ts` («objetivos de toque ≥ 44 px», WebKit).
6. **El volcado del borrador al recargar justo después de un cambio fallaba ~1 de cada 5 veces en Safari.** Causa: la transacción
   de IndexedDB no se confirmaba dentro de la tarea de `beforeunload`. `src/app/pdf-pro/proDrafts.ts` (`writeDraftTx` llama a
   `tx.commit()` si existe). Prueba: `proDrafts.test.ts` (2 casos) y `pdf-pro-foundation.spec.ts` «recargar justo después de
   aplicar» (repetida 16 veces: 3 fallos antes, 0 de 30 después, en WebKit de escritorio, iPhone y Chromium).
7. **`upgrade-insecure-requests` dejaba la aplicación en blanco sobre `http://localhost` en Safari** (reescribe los
   subrecursos a `https://localhost`). `next.config.ts` omite la directiva en `next dev` y con `CSP_SKIP_UPGRADE_INSECURE=1` al
   construir; un despliegue normal (HTTPS, sin la variable) emite exactamente la misma CSP de siempre.

## 7. Lo que NO se verificó

- **Firefox, en ejecución** (ver §1). Los proyectos y las adaptaciones (según el código de Playwright 1.62, `isMobile` no lanza error en Firefox;
  el permiso `camera` y las banderas de Chromium ya no se piden en Firefox) están sin ejecutar.
- Safari real (macOS, iOS, iPadOS): solo el WebKit de Playwright 26.5. Diferencias de la interfaz de Safari (barra de pestañas,
  modo privado real, Intelligent Tracking Prevention, límites de memoria de iOS, teclado en pantalla) no se ven.
- Táctil real, lector de pantalla real, Windows con contraste alto, impresión, impresoras.
- Versiones anteriores a las probadas (§5 es una estimación).
- Arrastrar y soltar archivos desde el sistema (se probó con `DataTransfer` sintético).
- `scan-to-pdf` fuera de Chromium (cámara falsa específica) y las herramientas fuera del subconjunto (`pdf-pro-offline`,
  `pdf-pro-perf`, `pdf-pro-errors`, `pdf-pro-a11y`, `pdf-pro-bundle`, `redact`, `compare`, `stamp`, `rotate`, `crop`, `repair`,
  `edit-elements`, `download-description`, `core`, `settings-edit-pdf-flags`, `pdf-pro-focus-frames`, `pages-form-leak`).
- Observación visual sin corregir: en 375×812 la barra de herramientas de «Editar» (2 filas) deja la segunda fila casi tapada por
  el panel de «Procesar» (más en WebKit que en Chromium; en ambos la fila queda recortada).
