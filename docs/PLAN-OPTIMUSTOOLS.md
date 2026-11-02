# Plan · OptimusTOOLS (2026-11-02)

Decision del usuario (2026-11-02), opcion **C**: todo sigue siendo 100 % local, **salvo** una excepcion declarada y visible: «HTML a PDF» puede
consultar una direccion web desde nuestro servidor (el navegador no puede leer otras webs por CORS). El **Downloader de redes sociales NO se
construye** (necesita servidor y raspado de plataformas, rompe la promesa local y tiene riesgo legal): queda como entrada «Próximamente»
con una pagina honesta. Nada de CDN en tiempo de ejecucion: todo lo que corre en el navegador va empaquetado.

## Barra lateral objetivo (desktop; en movil el mismo orden en el menu)

```
[Buscar herramienta]
Inicio · Recientes · PDF PRO
CATEGORIAS
  OptimusPDF      Organizar · Optimizar · Convertir a PDF · Convertir desde PDF · Editar y analizar · Seguridad
  OptimusSCAN     Escanear a PDF   (scan-to-pdf: sale de «Convertir a PDF» y vive aqui)
  OptimusTOOLS
    Downloader (proximamente)   Instagram · Facebook · TikTok · X · Threads · Telegram   (entradas deshabilitadas con «Pronto»)
    Audio Studio                Extraer audio (audio-extractor) · Audio Studio (audio-studio)
    Converter                   Audio Converter · Image Converter · Video Converter
    Proximamente…
Exportar / Importar   Documentos (/documents)
Ajustes · Precios · Sobre nosotros
ES / EN      CLARO / OSCURO / SISTEMA
```

## Herramientas nuevas (slugs ya registrados en `src/lib/tools-registry.ts`, en estado `soon`, con pagina provisional)

| slug | que hace | duena |
|---|---|---|
| `image-converter` | cambia el formato de imagenes (JPG/PNG/WEBP/AVIF segun navegador; entrada tambien HEIC en Safari, GIF, BMP), calidad, tamaño, fondo al pasar a JPG | W-IMG |
| `audio-converter` | cambia el formato de audios (WAV, MP3, M4A/AAC, OGG/Opus segun navegador) | W-AUDIO |
| `audio-extractor` | extrae la pista de audio de un VIDEO que el usuario sube (local) | W-AUDIO |
| `audio-studio` | editor de audio: cortar/recortar, quitar tramos, unir, fundidos, volumen, cambiar formato; forma de onda | W-AUDIO |
| `video-converter` | cambia el formato de un video (MP4/WebM), resolucion, calidad; con WebCodecs | W-VIDEO |
| `downloader` | pagina honesta «aun no disponible» + por que + alternativas locales | W-SHELL |
| `html-to-pdf` (existente) | + escribir una URL (via servidor) y PDF carta bien distribuido | W-HTML |

## Reglas comunes (todas las duenas)

1. 100 % local salvo `/api/html-snapshot`. Los convertidores y Audio Studio no hacen **ninguna** peticion de red con el contenido del usuario; nada de
   CDN/`import()` remoto; dependencias nuevas solo con licencia permisiva (MIT/BSD/Apache/ISC; **nada GPL/LGPL con enlace estatico ni `ffmpeg.wasm`**),
   empaquetadas por el build, y se listan en el informe (nombre, version, licencia, peso en KB en el bundle de la ruta).
2. Archivos de prueba SINTETICOS (los generas tu); nunca datos reales del usuario. Nada del contenido en logs/console/nombres de archivo.
3. Estilo del repo: comentarios en espanol con la densidad del codigo vecino; textos ES y EN (cada herramienta con su propio `strings.ts` en su carpeta;
   no edites `src/lib/locales/*` salvo la entrada de tu slug si hace falta); accesibilidad (axe 0, objetivos 44 px con tacto, sin desborde a 320 px,
   tipografia ancha, claro/oscuro con los tokens); estado = texto + icono, nunca solo color; `prefers-reduced-motion`.
4. Reutiliza lo que ya existe: `ToolShell`, `FileDropzone`, `DownloadScreen`, `ErrorBanner`, `PartialFailureReport`, `OptionControls`, `ProcessingOverlay`,
   `withSuffix`/`downloadBlob` (`src/lib/pdf/core`), el guardian de entrada (`inputGuard`/`fileAdmission`), `ToolPageSoon` como modelo de pagina.
   Mira `src/app/jpg-to-pdf` y `src/app/html-to-pdf` como patron de herramienta.
5. Trabajo pesado (decodificar, codificar, mezclar) fuera del hilo principal cuando sea razonable (Worker), con progreso real, cancelacion (`AbortSignal`)
   y limites de tamaño con mensaje claro (nunca cuelgues la pestaña). Detecta capacidades (WebCodecs, AudioEncoder, OffscreenCanvas) y degrada con un
   mensaje honesto, no con un error generico.
6. Propiedad de archivos: cada duena toca SOLO sus carpetas (`src/app/<slug>/`, `src/lib/media/<audio|image|video>/`, `src/lib/htmlSnapshot/`, `e2e/specs/<slug>*.spec.ts`).
   Solo W-SHELL toca registro (estructura), Sidebar, Header, MobileTabBar, Home. Una duena de herramienta SI puede, en el registro, pasar SU slug de `soon`
   a `live` y ajustar su `accept`/`extensions` (una sola linea), y su pagina `src/app/<slug>/page.tsx` sustituye a la provisional.
7. Politica de pruebas (peticion del usuario: **no verificar tras cada paso**): escribe las pruebas unitarias de tu motor junto al codigo, pero corre
   verificacion UNA vez al final: `npx tsc --noEmit`, `npx eslint src e2e`, `npx vitest run --project engines --project components <tus rutas>`, y UNA
   corrida E2E pequena con el servidor de desarrollo (sin `CI=1`, `PW_PORT` propio 3950–3999, headless siempre) de tu spec. No ejecutes la suite
   completa ni `next build` (otras duenas trabajan a la vez y la maquina es una sola). Informa con honestidad lo que NO pudiste verificar.
8. Entrega: `unit-nodocs.patch` (diff de tu copia contra la base, sin `docs/`) y `unit-docs-section.md` en tu carpeta de entrega (seccion para este documento:
   diseño, limites, no verificado, y **la lista de pruebas manuales** que el usuario debe hacer en su Mac/iPhone/iPad para dar el visto bueno).

## Integracion (la hace el orquestador)

Aplicar parches en este orden: SHELL → IMG → AUDIO → VIDEO → HTML; reconciliar `package.json`/lock; `tsc`, `eslint`, unitarias completas, `next build`,
E2E de navegacion + specs nuevos; revision de seguridad independiente de `/api/html-snapshot`; despliegue; humo; informe con las pruebas manuales.

## W-SHELL · navegación OptimusPDF / OptimusSCAN / OptimusTOOLS

### Diseño
- **Registro** (`src/lib/tools-registry.ts`): `Tool` gana `suite` (`pdf | scan | tools`) y `group?` (`downloader | audio-studio | converter`). La
  pertenencia vive en un mapa aparte (`PLACEMENT`/`GROUP_MEMBERS`), así que las líneas de `DEFINITIONS` de cada herramienta nueva no se tocan
  (las dueñas solo cambian `status`/`accept`; sin conflictos de parche). Nuevos: `getToolsBySuite`, `getToolsByGroup` (orden de visualización
  explícito: Extraer audio · Audio Studio; Audio · Imagen · Video), `isToolLive`, `SUITE_ORDER`, `GROUP_ORDER`, `SECTION_ORDER`, `SUITE_ICON`,
  `GROUP_ICON`, `DOWNLOADER_PLATFORMS`. `getToolsByCategory` ahora solo devuelve la suite `pdf` (**cambio de comportamiento documentado**:
  `scan-to-pdf` ya no sale en «Convertir a PDF»). `getRelatedTools` empieza por la misma familia (grupo en `tools`); `scan-to-pdf` conserva su
  afinidad con «Convertir a PDF».
- **Barra lateral** (`Sidebar.tsx`, `SidebarTree.tsx`, `SidebarLink.tsx`, `ThemeToggle.tsx`): buscar · Inicio · Recientes · PDF Pro · CATEGORÍAS
  (3 suites) · Exportar/Importar → Mis documentos · Ajustes · Precios · Proyecto · pie con «100 % local», ES/EN y Claro/Oscuro/Sistema.
  Cada categoría/grupo = enlace al ancla de Inicio (`/#id`, con scroll-spy como antes) + botón `aria-expanded` que despliega sus herramientas
  (`aria-controls` solo con el panel montado). Cada herramienta se pinta según `status`: live = enlace normal; soon = enlace con «Pronto» a su
  página provisional. Las 6 plataformas del Downloader son entradas `role="link" aria-disabled="true"` sin `href` ni foco. «Próximamente…» es una
  nota de texto. Una sección se abre sola si contiene la página actual (derivado de la ruta, también en servidor: sin parpadeo); la elección
  explícita se guarda en `sessionStorage` (`optimuspdf.sidebarSections`). Plegada (riel): solo iconos-enlace a las anclas; el Downloader y
  las plataformas no aparecen.
- **Cabecera (tablet)**: el menú «Herramientas» agrupa por las tres suites (h3) con sus categorías/grupos (h4). En móvil/tablet el idioma sigue en
  la cabecera; **no existe menú/hoja móvil** y no se inventó uno (la barra de pestañas y los chips de Inicio llevan a todo).
- **Inicio** (`ToolCatalogGrid.tsx`): catálogo por suites (h2) con categorías/grupos (h3); `#scan` es la sección de OptimusSCAN; chips por
  debajo de 1024 px para las 10 secciones; el buscador indexa suite/grupo y las plataformas (en la descripción del Downloader).
- **`/downloader`** (`DownloaderView.tsx`): explica por qué no existe (necesita servidor, choca con «tus archivos no salen de tu dispositivo»),
  nombra las plataformas, no da fechas y ofrece tarjetas locales (extraer audio, 3 convertidores, escanear), las disponibles primero y con su
  estado real.
- Textos ES/EN nuevos: `suites`, `groups`, `downloaderPage`, `nav.{soonShort,moreSoon,toggleSection,backupLabel,themeLabel}`; descripción del
  Downloader reescrita (ya no dice «próximamente» a secas).

### Límites / decisiones
- El idioma ya vivía en el pie de la barra (escritorio); el tema NO vivía en la cabecera sino solo en Ajustes: se añadió al pie con el mismo
  almacén (`useTheme`) y el mismo control que Ajustes. En móvil el tema sigue solo en Ajustes (la cabecera no tiene sitio).
- PDF Pro pasa de **primero** a **tercero** en la barra (plan: Inicio · Recientes · PDF PRO); se actualizaron los dos E2E que daban por hecho
  `.first()`.
- Sin dependencias nuevas. Sin `sitemap`/`robots` en el repo: nada que actualizar.
- `Footer.tsx` (fuera de mi propiedad) incumple contraste: el separador «·» (`after:text-muted-foreground/40`) da 3,12:1 en claro en páginas
  cortas. Preexistente; el spec de navegación excluye `<footer>` de axe.

### No verificado
- WebKit/Safari, Firefox, iPad e iPhone reales; solo Chromium headless y jsdom. `next build` y la suite completa (política del plan).
- Lector de pantalla real (VoiceOver) con los desplegables y las entradas `aria-disabled`.
- Con las herramientas hermanas ya `live` (solo se probó con los 6 slugs en `soon`): las pruebas están escritas para ambos estados, pero no se ejecutaron así.
- `pdf-pro-foundation › sin desbordes … 375×812` falla en servidor de desarrollo porque el indicador `nextjs-portal` intercepta el clic del dock
  (conocido; el CI usa build de producción). No es de esta unidad.

### Pruebas manuales (Mac / iPhone / iPad)
1. **Mac, escritorio**: barra lateral → ver Buscar, Inicio, Recientes, PDF Pro, CATEGORÍAS con OptimusPDF/OptimusSCAN/OptimusTOOLS. Desplegar cada
   categoría con el chevron; recargar la pestaña y comprobar que sigue desplegada. Entrar a una herramienta y ver su sección abierta y la herramienta marcada.
2. Abrir **Downloader**: ver «Pronto» y las 6 plataformas apagadas (no se pueden pulsar ni enfocar con Tab). Pulsar «Downloader» → página honesta, sin fechas.
3. **Tab/Enter/Espacio** sobre un chevron: abre/cierra sin perder el foco. Escape limpia el buscador. Buscar «instagram», «escanear», «convertidor».
4. **Escanear a PDF** se alcanza desde la barra, desde Inicio (sección OptimusSCAN), desde el buscador y desde Recientes.
5. Pie: cambiar **ES/EN** y **Claro/Oscuro/Sistema**, recargar: persisten; Ajustes muestra la misma elección. Con «Sistema», cambiar el tema del Mac.
6. Plegar la barra (riel): solo iconos; sus anclas siguen funcionando; volver a expandir.
7. **iPhone**: Inicio muestra las tres suites; los chips (arriba) saltan a cada sección, incluida OptimusSCAN y Converter; toques de 44 px; sin desborde
   lateral; probar con letra grande del sistema (Ajustes → Pantalla → Tamaño del texto) y en horizontal.
8. **iPad vertical** (834 px): menú «Herramientas» de la cabecera con las tres suites; Escape lo cierra y devuelve el foco.
9. Claro y oscuro en cada pantalla anterior: texto legible (insignias «Pronto», «Próximamente…»).

## W-IMG · Convertidor de imágenes (`/image-converter`, ya `live`)

### Diseño
- **Motor puro** en `src/lib/media/image/` (probado en Node con un backend de mentira): `formats.ts` (formatos de salida y qué soporta cada uno), `sizing.ts` (tamaño de salida sin ampliar, límites por dispositivo), `names.ts` (`withSuffix` + nombres sin colisiones), `bmp.ts` (codificador BMP de 24 bits propio), `convert.ts` (orquestador: comprobar, planificar, convertir, empaquetar; una imagen mala no detiene a las demás). `browserBackend.ts` es lo único que toca el lienzo.
- **Entrada**: JPG, PNG, WebP, GIF (primer fotograma), BMP, AVIF y HEIC/HEIF **si el navegador los decodifica** (`createImageBitmap` con `imageOrientation: "from-image"`; respaldo `<img>.decode()`). Antes de decodificar se pasa `checkImageBytes` (vacía / no es imagen / incompleta / dañada, el mismo de «Imagen a PDF») y los límites. Lo que no abre el navegador (HEIC fuera de Safari) sale como aviso por archivo y el resto sigue.
- **Salida**: JPG, PNG, BMP siempre; **WebP y AVIF solo si `canvas.toBlob` los codifica en ese navegador** (prueba 2×2 una vez por página: detección de capacidad, no de navegador; si no, la opción se oculta y la interfaz dice cuáles faltan y por qué). Un formato que el navegador cambia por PNG sin avisar se detecta (`blob.type`) y falla con mensaje, nunca entrega un `.webp` que es PNG.
- **Opciones**: formato, calidad 1-100 (solo JPG/WebP/AVIF), tamaño (original / ancho máximo / porcentaje, proporción conservada, nunca amplía), color de fondo (blanco por defecto; solo en JPG y BMP, que no guardan transparencia). Orientación EXIF aplicada; **metadatos (EXIF/GPS/perfil) eliminados y colores en sRGB**, dicho en la interfaz. GIF animado: primer fotograma (aviso solo si hay un GIF).
- **Salida de archivos**: una imagen → el archivo directo (`foto-convertida.jpg`); varias → un ZIP `imagenes-convertidas.zip` (JSZip, sin recomprimir salvo BMP). Tamaño antes→después y dimensiones por archivo en la pantalla de descarga (`renderDownloadExtras`, un `<details>` nativo); resumen con el total.
- **Fallos parciales**: se informan en los avisos de `DownloadScreen` (`notices`, lista accesible enlazada al botón Descargar) y NO con `PartialFailureReport`, porque su texto compartido dice «N de M documentos **firmados**» / «No se pudo **firmar**» (es de Firmar PDF). Si ninguna sale: error del shell + lista por archivo bajo la zona de carga con «Quitar y continuar». Antes de convertir, el mismo aviso nombra las imágenes inservibles (reutiliza el trabajo de miniaturas de `useImageProblems`).
- **Sin Web Worker, a propósito**: `createImageBitmap` y `canvas.toBlob` ya son asíncronos y fuera del hilo principal; el único tramo síncrono grande es `getImageData` del BMP (acotado por píxeles). Se cede el hilo entre archivos y cancelar responde al instante (`AbortSignal` + carrera con la decodificación). Un worker añadiría un segundo camino de código por una ganancia no medida.

### Límites (mensaje claro, nunca se cuelga la pestaña)
| | Escritorio | iPhone/iPad |
|---|---|---|
| peso por archivo | 64 MB | 32 MB |
| píxeles de entrada | 100 Mpx | 48 Mpx |
| lienzo de salida | 64 Mpx / 16 384 px de lado | 16 Mpx / 4096 px de lado (topes de `prepareForPdf`) |
| salidas de una tanda (el ZIP va en memoria) | 800 MB | 300 MB |
BMP: lienzo máximo 24 Mpx. Si el lienzo obliga a reducir más de lo pedido, el resultado lo avisa («se redujo a W × H px…»). Lo que no cabe en la tanda queda fuera con su motivo.

### Verificado (Chromium headless, servidor de desarrollo, imágenes sintéticas)
`tsc` limpio, `eslint src e2e` sin errores, 62 pruebas unitarias/componentes (motor, BMP, tamaños, nombres, aviso, herramienta entera con backend falso), **22 pruebas E2E** (`e2e/specs/image-converter.spec.ts`): PNG con transparencia→JPG (blanco y rojo, comprobado por píxel), PNG→PNG con alfa, JPG→WebP (RIFF/WEBP), BMP válido, GIF y BMP de entrada, EXIF girado y sin EXIF en la salida, ancho máximo/porcentaje sin ampliar, lote→ZIP con nombres repetidos, archivos malos (aviso previo, quitar, omitir, ninguna), HEIC no abierto en Chromium, formatos ofrecidos = formatos codificados, ninguna petición fuera del origen ni con cuerpo, axe WCAG 2 A/AA a 1280/375/320 px (tipografía ancha ×2 anchos, claro/oscuro, ES/EN) en vacío/con archivos/opciones/descarga, objetivos de 44 px con tacto, sin desborde horizontal, y textos EN.

### No verificado
Safari/iPhone/iPad (WebKit) y Firefox: ni HEIC real, ni AVIF, ni WebP en Safari, ni los topes de iOS. AVIF no se probó de extremo a extremo (Chromium no lo codifica). Rendimiento con fotos de 24-48 Mpx y tandas de 50+ archivos; memoria real; peso del bundle de la ruta (no se corrió `next build`). El control del color de fondo es el selector nativo del sistema (solo se probó rellenando su valor). La comprobación de 44 px mide el hueco tocable del contenedor.

### Dependencias nuevas
Ninguna (`jszip`, `@napi-rs/canvas`, `axe-core` ya estaban).

### Para la integración
- `src/components/views/HomeView.featured.test.tsx` fija el recuento de disponibles en **37**: con `image-converter` en `live` pasa a 38 (más lo que sumen las demás duenas). No lo toqué (no es de mi carpeta). En la base ya fallan, sin mi parche, 2 pruebas de `src/lib/tools-registry.pro.test.ts` («solo powerpoint-to-pdf esta en camino» y el orden) por los 6 slugs nuevos.
- Un solo cambio en el registro: `status: "soon"` → `"live"` de `image-converter` (`accept`/`extensions` ya eran los correctos).

### Pruebas manuales para el visto bueno (Mac / iPhone / iPad)
1. **Mac, Chrome**: subir 3 fotos (una PNG con transparencia) → JPG: la zona transparente sale blanca; cambiar el fondo a otro color y repetir. Probar WebP: abrir el `.webp` en el navegador/Vista Previa. Descargar el ZIP y comprobar nombres y que abren.
2. **Mac, Safari**: ¿aparecen WebP/AVIF en «Formato de salida»? (si no, debe decirlo la nota). Subir un `.heic` de iPhone → debe convertirlo a JPG/PNG; comparar orientación con la foto original.
3. **iPhone Safari**: elegir fotos de la fototeca (HEIC y JPG), convertir a JPG con «Ancho máx.» 1920, ver tamaño antes→después, guardar el ZIP/archivo en Archivos. Probar una foto muy grande (panorámica de 48 Mpx): debe avisar o reducirla con aviso, **no** quedarse en blanco ni cerrarse la pestaña.
4. **iPad**: igual que iPhone con la tableta en horizontal y vertical.
5. **Archivos malos**: un `.jpg` cortado (cortarlo a la mitad con un editor hexadecimal o descargarlo a medias) y un `.txt` renombrado a `.png` → aviso por archivo; el resto se convierte.
6. **Cancelar** a mitad de un lote de ~30 fotos grandes: debe parar en el acto.
7. **Privacidad**: con la pestaña de Red de las herramientas del navegador abierta, convertir y comprobar que no sale ninguna petición con las imágenes.
8. **Metadatos**: una foto con GPS → convertida; comprobar con Información/«Ver detalles» que no conserva ubicación ni cámara.

## Video Converter (`/video-converter`, slug `video-converter`, ahora `live`) · W-VIDEO

Convierte un video a **MP4 (H.264 + AAC)** o **WebM (VP9 o VP8 + Opus)** en el propio navegador, con WebCodecs. Sin ffmpeg.wasm, sin CDN, sin
cabeceras COOP/COEP, sin ninguna peticion con el contenido del usuario (la prueba E2E lo comprueba: solo `localhost`, ni un POST).

### Diseño

- **Motor puro** (`src/lib/media/video/`, sin DOM ni red): `formats` (formatos y codecs), `resolution` (lado corto 1080/720/480/360 p, sin ampliar,
  lados pares), `fps` (tope), `profiles` (bitrate por bits/pixel/fotograma; «Conservar», «Alta», «Equilibrada», «Pequeña»; el bitrate nunca supera lo
  que tenia el original ajustado por codec), `capabilities` (pregunta a `VideoEncoder`/`AudioEncoder.isConfigSupported`; ofrece solo lo posible y dice
  por que no), `limits` (umbrales por clase de dispositivo), `plan` (**decide copiar o recodificar cada pista**, medidas, bitrate, peso estimado y avisos:
  la pagina lo recalcula en cada cambio y es lo mismo que se ejecuta), `names`, `errors` (codigos → texto propio, nunca el de la libreria), `display`.
- **Ejecucion**: `convertCore.ts` (unico archivo que importa la libreria) corre en `video.worker.ts`; `videoEngine.ts` lo gobierna: worker por demanda,
  **cancelar termina el worker** (libera codificador, decodificador y memoria de golpe), y si no se puede crear un worker (o no carga) la misma ejecucion
  corre en el hilo principal. El original se lee a trozos (`BlobSource`, cache de 8 MiB), nunca entero; la libreria decodifica, reescala y cierra cada
  `VideoFrame`/`AudioData` con contrapresion. El resultado se arma en un `ArrayBuffer` (MP4 con `fastStart: 'in-memory'`) y se entrega como `Blob`.
- **Copiar vs recodificar**: con «Conservar», sin cambio de resolucion/fps y con un codec que ya es el del formato (H.264→MP4, VP8/VP9→WebM) el video
  pasa **sin recodificar** (rapido y sin perdida; 559 MB en 1,8 s). Un MOV de iPhone en HEVC → MP4 se recodifica a H.264 (el «MP4» prometido es H.264).
  El audio igual (AAC→MP4, Opus/Vorbis→WebM se copian). WebM no guarda la rotacion de movil: se gira la imagen de verdad (y se avisa); MP4 la conserva como dato.
- **Pagina** (`src/app/video-converter/`): composicion propia con `FileDropzone`, `OptionsPanel`, `ProcessingOverlay`, `DownloadScreen`, `ErrorBanner`
  (no `ToolShell`: ver «Decisiones»). Estados: reposo → leyendo → opciones (tarjeta del archivo, avisos, peso estimado) → progreso real con «Cancelar» →
  resultado. Navegador sin WebCodecs o pagina sin conexion segura → **pagina informativa** (con el motivo), no un error.
- Entrada: MP4/M4V, MOV, WebM, MKV (solo esos lectores en el bundle). Una sola pista de video y de audio (las principales).

### Dependencias nuevas

| paquete | version | licencia | peso |
|---|---|---|---|
| `mediabunny` | 1.65.0 | **MPL-2.0** (el encargo decia MIT; no lo es) | worker `video.worker.ts`: **464 KB minificado / 116 KB gzip** (con solo MP4+MOV+WebM+MKV de entrada; con `ALL_FORMATS` eran 593 / 148). **No entra en el JS inicial de la ruta**: el worker es un chunk aparte y el respaldo en hilo principal es un `import()` |
| `@types/dom-webcodecs`, `@types/dom-mediacapture-transform` | 0.1.13 / 0.1.12 | MIT | solo tipos (0 KB de ejecucion) |

MPL-2.0 es copyleft **por archivo**, no GPL/LGPL: usada sin modificar y empaquetada, no obliga a abrir el codigo de OptimusPDF; si obliga a conservar el aviso
de licencia y a poder facilitar el codigo de la libreria (es publico en npm). **Decision que dejo al orquestador**: si MPL-2.0 no vale para la regla «solo
permisivas», la alternativa es `mp4box` (BSD-3, demux MP4/MOV) + `mp4-muxer`/`webm-muxer` (MIT) + un lector EBML propio para WebM/MKV: bastante mas codigo
y sin las conversiones de rotacion/medidas/ritmo ya resueltas. Todo el uso esta en `convertCore.ts`, asi que cambiarla es acotado. Añadir mediabunny a la
pagina de Licencias. Auditado: el bundle del worker no contiene `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `eval` ni `new Function`.

### Limites (en `limits.ts`; los de movil NO estan medidos)

| | escritorio | iPhone/iPad/Android/≤4 GB |
|---|---|---|
| aviso por peso del original | 500 MB | 200 MB |
| rechazo por peso del original | 4 GB | 1 GB |
| rechazo por peso **estimado del resultado** | 1 GB | 250 MB |
| aviso / rechazo por duracion | 30 min / 2 h | 10 min / 30 min |

Medido en Chromium de escritorio (Mac, codificador por hardware): 1080p30 de contenido sencillo → ~5× tiempo real (30 s en 5,5 s; a 720p 3,5 s); peor caso
(ruido puro, ~110 Mbps) → 1,6–2,1×; copiar → segundos. Memoria: el pico es ~**2,4× el peso del resultado** (559 MB de salida subieron ~1,3 GB), y en
recodificar 40 s de 1080p a 720p el sobrecoste fue ~0,4 GB: **no se observo acumulacion de fotogramas**. De ahi: tope sobre el resultado estimado (no solo el
original) y 1 GB en escritorio. Un codificador por hardware puede ignorar el bitrate pedido con contenido patologico (ruido: pidio ~5 Mbps y salieron 112): el
peso estimado es orientativo y el desbordamiento acaba en el aviso «Se agotó la memoria», no en un cuelgue silencioso.

### Pruebas

- Unitarias (`src/lib/media/video/*.test.ts`, `src/app/video-converter/*.test.ts(x)`): 109 pruebas — escalado y lados pares, fps, perfiles/bitrate (topes por el original y
  por codec), capacidades con `VideoEncoder`/`AudioEncoder` **simulados** (Chrome, sin H.264, Safari sin codificador de audio, http no seguro, codec que lanza), plan
  (copiar/recodificar, rotacion, medidas impares, audio 5.1/mono/sin codificador/indecodificable, limites escritorio vs movil, HDR, estimaciones), limites y deteccion de
  dispositivo, nombres, errores, motor con worker simulado (progreso, cancelar = terminar worker, respaldo sin worker), paridad ES/EN de textos y el cliente completo con
  motor simulado (leer, opciones, plan enviado, cancelar, errores, bloqueos).
- E2E `e2e/specs/video-converter.spec.ts` (14 pruebas, Chromium headless): los videos se **generan dentro de la prueba** (`video-converter.fixture-entry.ts`, empaquetado con
  Vite, codifica con WebCodecs; ritmo constante, rotacion, medidas impares, audio, ruido) y los resultados se abren en un `<video>` real (medidas, duracion, fotograma no negro).
  Cubre MP4↔WebM con resolucion y calidad, copia sin recodificar, rotacion de movil (MP4 la conserva; WebM la hornea; ambos salen 360×640), medidas impares → pares,
  60→30 fps y quitar audio (releido con la propia herramienta), worker usado y cero peticiones fuera de localhost, **cancelar a medias** (progreso real > 0, worker terminado,
  foco, y luego convierte), archivo roto / solo audio / no es video, navegador sin WebCodecs, sin workers (hilo principal), aviso en iPhone (UA), y axe 0 + sin desbordes +
  objetivos ≥ 44 px a 320/375/1280 px, ES/EN, claro/oscuro, tipografia ancha, con hoja de opciones, error, progreso y resultado.
  Si un Chromium no codifica H.264/AAC (Linux sin codecs propietarios) las partes de MP4 se omiten y se anota. **Tambien paso 14/14 en el WebKit de Playwright (Safari 26.5
  en macOS)**, ejecutado a mano con una configuracion temporal (el spec no esta en `CROSS_SPECS`).

### No verificado (lo hace una persona)

Safari/iPhone/iPad **reales** (memoria, codificador por hardware de iOS, segundo plano), HEVC/HDR de iPhone reales, VFR de moviles reales, Firefox, `next build` (el patron del worker es el de los demas del repo y funciona en
dev), tiempos en Windows/Linux, y los limites de movil.

### Pruebas manuales para el visto bueno

1. **Mac · Safari**: MOV de iPhone (HEVC) de ~30 s → MP4. Debe abrirse en QuickTime, con audio y orientacion correctos; el peso real debe parecerse al estimado.
2. **Mac · Chrome**: el mismo MOV → MP4 y → WebM; MP4 H.264 de movil con «Conservar» (debe tardar segundos y decir «Sin recodificar»).
3. **iPhone · Safari**: video **vertical** de 20–40 s grabado con la camara → MP4 («Equilibrada», 720p). Comprobar orientacion, audio, que la pantalla no se apaga y el tiempo.
   Cambiar de app y volver a mitad: ¿sigue o se pierde? Probar «Cancelar» (la pagina debe quedar fluida) y reintentar.
4. **iPhone · Safari**: un video de ~250 MB (debe avisar), uno de ~1,2 GB (debe rechazarlo con el mensaje), y uno de 5–8 min a 1080p: ¿termina o la pestaña se recarga por memoria? Con eso se calibran los limites de «poca memoria».
5. **iPad · Safari**: lo mismo que 3 con un video apaisado; mirar el diseño con la hoja de opciones y a letra grande (Ajustes → Tamaño del texto).
6. **iPhone/iPad · WebM**: ¿se ofrece WebM? Si Safari no codifica VP9 debe decirlo bajo el selector («WebM no está disponible…»), no fallar.
7. **Safari anterior a 26 (sin AudioEncoder)**, si hay alguno: un MOV con audio AAC debe conservar el audio (se copia); uno con audio no-AAC debe avisar que saldrá sin sonido.
8. Un video **HDR** de iPhone: debe avisar; con «Conservar» y MOV→MP4 H.264 sin cambios no hay recodificacion (HEVC → se recodifica y sale SDR).
9. **Windows · Chrome/Edge** con un MOV HEVC sin extension HEVC: debe decir «No sabemos leer el códec de este video» (no un error generico).
10. Un MP4 truncado y un `.mp3` renombrado a `.mp4`: «No se puede leer este video». Un `.m4a` (solo audio) renombrado: «Este archivo no tiene imagen» con enlace al Convertidor de audio.
11. ES/EN y claro/oscuro en el telefono; descargar el resultado y compartirlo (Archivos / WhatsApp / Fotos) y reproducirlo.

### Decisiones

- **Sin `ToolShell`**: su zona de carga y su banner hablan de PDF (aviso «supera los 100 MB… divide con Dividir PDF», errores «PDF dañado»), y un convertidor de video necesita
  sus propios limites y mensajes. Se compone con las piezas compartidas (`FileDropzone`, `OptionsPanel`, `ProcessingOverlay`, `DownloadScreen`, `ErrorBanner`) y se ignora el
  `tooLarge` de la zona de carga (los limites son los de `limits.ts`).
- **MPL-2.0 aceptada** para la libreria de contenedores (ver arriba), aislada en `convertCore.ts`.
- **Worker terminado al cancelar** en vez de cancelacion cooperativa: mas simple y libera todo.
- **Resultado en memoria** (`Blob`), sin File System Access (opcional en el encargo): el tope por peso estimado es el control de seguridad.
- «Conservar» es el valor por defecto: lo mas rapido y sin perdida cuando se puede.

### Para el orquestador (fuera de mi alcance)

- `FileDropzone` muestra fijo «Acepta … · hasta 100 MB» (`MAX_SAFE_FILE_SIZE`); en video es falso (se avisa a 500 MB y se acepta hasta 4 GB). Conviene una propiedad opcional para ocultarlo o cambiarlo.
- `DownloadScreen` dice «Tu documento está preparado para descargar» (`t.tool.doneSubtitle`) tambien para un video.
- `src/lib/tools-registry.pro.test.ts` ya falla en la base (espera `redact-pdf` como ultimo slug y solo `powerpoint-to-pdf` en «soon»); al pasar `video-converter` a `live`
  su lista de «soon» debe ser la de las herramientas aun no hechas.

## W-AUDIO · Convertidor de audio, Extraer audio y Audio Studio

Slugs `audio-converter`, `audio-extractor`, `audio-studio`: pasan de `soon` a `live` (una línea cada uno en el registro) y sus páginas sustituyen a las provisionales. 100 % locales: ninguna petición de red con el contenido; no se guarda nada (ni borradores). **Dependencias nuevas: ninguna** (ni `mediabunny` ni codificadores de MP3).

### Diseño

Motor común en `src/lib/media/audio/` (sin `src/lib/media/video/`):

| Pieza | Qué hace |
|---|---|
| `wav.ts` | Codificador WAV 16 bits y lector WAV propio (PCM 8/16/24/32 y flotante): conserva la frecuencia original, no depende del navegador. |
| `probe.ts`, `mp4.ts`, `webm.ts`, `blobReader.ts` | Sonda barata (tipo, frecuencia, canales, duración, ¿hay pista de audio?) y lectores propios de MP4/MOV/M4A y WebM/Matroska que leen **solo la pista de audio por trozos** (también grabaciones de `MediaRecorder` con clusters de tamaño desconocido). Un MP4 fragmentado (`moof`) se detecta y se declara. |
| `decode.ts` | Tres vías, de más fiel a más general: lector WAV propio → `decodeAudioData` (contexto a la frecuencia sondeada, sin remuestrear) → lector de contenedor propio + `AudioDecoder` (WebCodecs; sirve para videos grandes y para lo que `decodeAudioData` no abre). Avisa **antes** de decodificar si no cabe en memoria. |
| `encode.ts`, `m4a.ts`, `ogg.ts`, `capabilities.ts` | WAV propio; M4A (AAC-LC) y Opus con `AudioEncoder` + empaquetado propio (MP4 con `moov` al principio; Ogg Opus con CRC y recorte del relleno). Se pregunta al navegador con `isConfigSupported`. |
| `resample.ts`, `pcm.ts` | Remuestreo sinc/Kaiser por bloques, mezcla de canales, orígenes de muestras **peresosos** (`PcmSource`): nada se copia entero en cada paso. |
| `convert.ts`, `names.ts` | Lote secuencial (un solo audio decodificado a la vez), ZIP con `jszip` (ya en el proyecto), informe de fallos parciales, nombres únicos. |
| `edit.ts`, `player.ts` | Modelo del estudio: pista = secuencia de **segmentos** que apuntan a audios inmutables con ganancia y rampas lineales. Cortar/quitar/dividir/unir/reordenar no copian muestras; deshacer/rehacer son gratis (estados inmutables que comparten buffers). Vista previa con Web Audio en trozos de 0,5 s con 1,5 s de margen (no mezcla la pista entera). |

Interfaz: `src/lib/media/audio/ui/` (marco común de convertidor y extractor, zona de carga con el tope real, opciones de salida, textos compartidos) y `src/app/audio-*/` (cada herramienta con su `strings.ts` ES/EN). No usan `ToolShell`: su texto de errores, sus pistas («Reparar PDF») y el tope de 100 MB son de PDF y engañarían con audio. Sí reutilizan `OptionsPanel`, `ErrorBanner`, `ProcessingOverlay`, `DownloadScreen`, `useFocusTarget`, `Button`, `Slider`, `ChoiceGroup` y `addRecentEntry` (solo guarda el nombre, como el resto).

Audio Studio: onda en `canvas` (decorativa) con un `slider` accesible (valor = cursor; `aria-valuetext` = duración y selección); flechas (0,1 s; Ctrl 1 s; Re/Av Pág 5 s; Inicio/Fin), Mayús para seleccionar, Espacio reproduce, Esc quita la selección, Ctrl+Z / Ctrl+Mayús+Z; campos numéricos de inicio y fin; botones para marcar inicio/fin en el cursor; recortar, quitar, dividir, fundidos (sobre la selección o los N primeros/últimos segundos), volumen en dB, normalizar a −1 dBFS, lista de clips con subir/bajar/quitar, exportar con las mismas opciones que el convertidor. Cada acción se anuncia en una región viva.

### Decisiones que hay que conocer

1. **MP3 como salida: no existe.** Los navegadores no traen codificador y todos los codificadores de MP3 en JS/WASM son LAME (LGPL; `lamejs`, `@breezystack/lamejs`, `@toots/shine.js`; `@rocket.chat/mp3-encoder` y `wasm-media-encoders` declaran MIT pero empaquetan LAME) o `@mediabunny/mp3-encoder` (MPL-2.0 sobre LAME). Por regla del plan no se empaquetan. En la interfaz MP3 aparece **desactivado con el motivo escrito**, y se ofrece M4A (se abre en todo) o WAV. MP3 sigue siendo **entrada** soportada (lo decodifica el navegador). Si el usuario aceptara LGPL cargada como archivo separado y sustituible (`public/`, en un Worker), el cambio es aditivo; no se ha hecho.
2. **`mediabunny` no es MIT: es MPL-2.0** (versión 1.65.0, 11 MB desempaquetado). No se ha usado. En su lugar hay lectores propios de MP4/WebM (~600 líneas con pruebas). Si W-VIDEO lo añade, la licencia es decisión del orquestador/usuario; este motor no depende de él.
3. **Opus en Ogg (`.opus`)**, no WebM. No se ha escrito el empaquetador WebM de audio.
4. **No se usan Workers**: la decodificación (`decodeAudioData`, `AudioDecoder`) y la codificación (`AudioEncoder`) ya van fuera del hilo; el resto (remuestreo, mezcla, WAV) corre por bloques cediendo el hilo con `MessageChannel` (no `requestAnimationFrame`, que se pausa en una pestaña en segundo plano). 60 s estéreo: WAV 154 ms, WAV 22,05 kHz mono (con remuestreo) 341 ms, Opus 96 kbps 407 ms en Chromium headless de un Mac.
5. Los formatos con perdida se crean a la frecuencia pedida (M4A) o a 48 kHz (Opus); no hay conversión «sin pérdida» a M4A/Opus.

### Límites (con mensaje claro en la interfaz)

- Archivo de audio ≤ 300 MB; video ≤ 2 GB (solo se lee la pista de audio por trozos); entregar el archivo entero a `decodeAudioData` solo hasta 200 MB de video. Lote ≤ 50 archivos, ≤ 800 MB de salida acumulada; Studio ≤ 40 clips.
- Memoria: el audio decodificado ocupa `s × Hz × canales × 4` bytes. Tope 1 GiB (≈ 50 min de estéreo 44,1 kHz) o 384 MiB (≈ 19 min) en iPhone/iPad/Android o `deviceMemory ≤ 4`. Si la duración se conoce por la sonda, se avisa antes de decodificar con los minutos que caben.
- WAV ≤ ~4 GiB (límite del formato). MP4 fragmentado: la estructura se ve, los paquetes no se extraen (queda `decodeAudioData`).
- Audio Studio: sin zoom (la precisión fina va por los campos numéricos y el teclado); fundidos lineales; no hay borradores ni recuperación tras recargar (decisión de privacidad).

### Pruebas

- Unitarias: `src/lib/media/audio/*.test.ts` (WAV, PCM, remuestreo, edición/historial, contenedores MP4/WebM/Ogg/M4A construidos a mano, sonda, decodificación con Web Audio y WebCodecs simulados, codificación con `AudioEncoder` simulado, lote/ZIP, nombres/formatos/límites, reproductor con contexto falso) y de componentes (opciones de salida, onda, lista de clips, estudio de punta a punta con exportación WAV real, convertidor y extractor). 165 pruebas.
- E2E (Chromium headless, códecs reales): `audio-converter.spec.ts`, `audio-extractor.spec.ts`, `audio-studio.spec.ts` (axe 0 de WCAG 2.0/2.1 A y AA, sin desborde a 1280/375/320 px, tipografía ancha, claro/oscuro, ES/EN, objetivos de 44 px, teclado, sin red) y `audio-converter-engine.spec.ts` (motor en el navegador con `AudioEncoder`/`AudioDecoder` reales y un WebM real de `MediaRecorder`, también por la vía de nuestro lector + `AudioDecoder`).

### No verificado

Safari y Firefox (macOS/iOS/iPadOS), M4A reproducido por un reproductor real, un MP4/MOV real de cámara o móvil, videos o audios de cientos de MB, el límite de memoria en un iPhone real, `next build`/bundle de rutas (no se ejecutó: peso por ruta sin medir; no hay dependencias nuevas), la suite completa. Tests ajenos que dependen del recuento de herramientas disponibles (`HomeView.featured.test.tsx`: 37 → 40) y del estado `soon` (`tools-registry.pro.test.ts`) ya no coinciden con el registro tras pasar los tres slugs a `live`: actualizarlos en la integración.

### Pruebas manuales para el visto bueno (Mac, iPhone, iPad)

1. **Convertidor** (Mac Safari y Chrome): subir un MP3, un M4A de Notas de Voz, un OGG y un FLAC → WAV; comprobar que suenan igual y que el tamaño «antes → después» es coherente. Elegir varios a la vez → ZIP; añadir uno roto → debe salir el informe de fallo parcial.
2. **Formatos**: en cada navegador mirar qué sale activado (WAV siempre; M4A y Opus según el navegador) y que el motivo del desactivado se entiende. Descargar un `.m4a` y un `.opus` y abrirlos en Música/VLC/WhatsApp. Confirmar que MP3 sale desactivado con su explicación.
3. **Extraer audio**: un video real de iPhone (`.mov`), uno de Android/cámara (`.mp4`), uno `.mkv` y uno `.webm`; a WAV y a M4A. Un video sin sonido → mensaje «no tiene pista de audio». Un video grande (≥ 500 MB) en el Mac: debe avisar o extraer sin colgar la pestaña; en iPhone, que avise de límites con claridad.
4. **Audio Studio** (iPhone, iPad con teclado, Mac): unir 3 audios y reordenarlos; seleccionar arrastrando con el dedo; recortar, quitar un tramo, dividir, fundidos, volumen, normalizar, deshacer/rehacer; reproducir y pausar con el cursor; exportar a WAV y M4A y escucharlo. Con teclado (Mac/iPad): flechas, Mayús, Espacio, Esc, ⌘Z.
5. **Móvil**: a 320 y 375 px (iPhone SE y 15 Pro) y con tipografía grande del sistema: nada desborda, el editor se maneja con una mano, la barra «Opciones/Procesar» no tapa contenido.
6. **Memoria**: en iPhone, abrir un audio de ~40–60 min; debe avisar con los minutos que caben en lugar de cerrarse la pestaña. En un Mac, uno de ~1 h.
7. **Accesibilidad**: VoiceOver en el Studio (la onda se anuncia como control deslizante con duración y selección; cada acción se anuncia) y en el convertidor (errores y resultado).
8. **Privacidad**: con las herramientas de red del navegador abiertas, convertir y editar: no debe verse ninguna petición con el audio; tras recargar no queda ningún audio.

## W-HTML · HTML a PDF con dirección web y PDF Carta bien repartido

### Qué es

`/html-to-pdf` tiene ahora dos modos accesibles (pestañas «Dirección web» y «Archivo HTML»). En «Dirección web» la persona escribe la dirección y **nuestro servidor** la consulta (`POST /api/html-snapshot`, el navegador no puede por CORS) y devuelve **una sola página autocontenida y ya saneada**. Todo lo demás (montar, maquetar, rasterizar y crear el PDF) sigue en el navegador, con el mismo motor de siempre (`htmlToPdf`), que además se reescribió en la parte de distribución en la hoja. El aviso de transparencia se ve **siempre antes de consultar**: «Para leer esta dirección, nuestro servidor la consulta y te devuelve la página; no se guarda nada. El PDF se crea en tu dispositivo.»

### Ruta de servidor `POST /api/html-snapshot` (`src/app/api/html-snapshot/route.ts` + `src/lib/htmlSnapshot/`)

Runtime Node, `dynamic = "force-dynamic"`, `maxDuration = 20` (plazo interno de 10 s). Entrada `{ url }`; salida `{ html, finalUrl, title, notes[] }`. Las `notes` son **objetos con código** (`{ code, count? }`), no frases, para que la interfaz las escriba en ES/EN.

Defensas (cada una tiene prueba sin red):

| Capa | Qué hace | Dónde |
|---|---|---|
| Solo la propia web | `Sec-Fetch-Site: same-origin` o `Origin` con el mismo host; si no, `forbidden` (403). Es una barrera contra uso desde otras páginas, **no** autenticación (un cliente que no sea navegador pone las cabeceras que quiera). | `handler.ts` |
| Forma de la petición | `Content-Type: application/json`; cuerpo ≤ 4 KB leído con tope (no se fía de `Content-Length`); URL ≤ 2048. | `handler.ts` |
| Abuso | Limitador por IP **en memoria** (10/min; de mejor esfuerzo: cada instancia sin servidor tiene su memoria, se reinicia en frío, no se comparte) y tope de **4 consultas simultáneas por instancia**. | `rateLimit.ts`, `handler.ts` |
| URL | Solo `http:`/`https:`, puertos 80/443, sin usuario/contraseña, sin `localhost`, `*.local`, `*.internal`, `*.localhost`, `*.lan`…, sin nombres de una etiqueta, sin IP literal privada. Las formas camufladas (`2130706433`, `0x7f.1`, `127.1`, octales) las normaliza el analizador WHATWG y se valida el resultado. | `urlGuard.ts` |
| Anti-SSRF | DNS A+AAAA a la vez; si **alguna** dirección es loopback, privada, enlace local (incl. 169.254.169.254), CGNAT, multicast, reservada, IPv6 ULA/enlace local, `::ffff:` mapeada, NAT64, 6to4, Teredo o documentación, se rechaza **todo** el nombre. IPv6: solo se admite unicast global `2000::/3` menos esas excepciones. Una IP que no se pueda analizar se considera bloqueada (falla cerrado). | `ipGuard.ts`, `guardedFetch.ts` |
| Anti DNS-rebinding | La conexión va **a la IP ya validada** (`lookup` propio que devuelve siempre esa IP; SNI, certificado y `Host` siguen con el nombre) y al conectar se comprueba que `socket.remoteAddress` es la validada. La resolución se memoiza por petición. | `nodeTransport.ts`, `dnsResolver.ts` |
| Redirecciones | A mano, máximo 5; **toda** la validación (URL, DNS, IP) se repite en cada salto y en cada sub-recurso. | `guardedFetch.ts` |
| Límites | 10 s totales (una señal de plazo para página y recursos); HTML ≤ 5 MB **descomprimido** (se cuentan los bytes tras gunzip/inflate/brotli y se corta la lectura; bomba de gzip de 100 MB probada contra un servidor local real); tipos admitidos: `text/html`/`application/xhtml+xml` (página), `text/css`, `image/*`. | `guardedFetch.ts`, `nodeTransport.ts` |
| Salida | Sin cookies ni cabeceras de la persona; `User-Agent: OptimusPDF-Snapshot/1.0`; `Cache-Control: no-store`; nunca se registra la URL ni el contenido (ni `console.*`, con prueba); errores genéricos y tipados (`invalid-url`, `blocked-address`, `unreachable`, `too-large`, `unsupported-type`, `timeout`, `rate-limited`, `forbidden`) sin detalles internos. | `handler.ts` |

**Saneado y autocontención** (`buildSnapshot.ts`, con `parse5`, el analizador HTML5 conforme a la especificación; no se sanea con regex): se eliminan `script`, `noscript`, `iframe/frame/object/embed/applet`, `audio/video`, `base`, `meta`, `template`, MathML, animaciones SVG, `foreignObject`, todos los `link` que no sean hojas de estilo; los `form` se desenvuelven (sin formulario no hay envío); se quitan `on*`, `srcdoc`, `action`, `formaction`, `target`, `ping`, `javascript:` y toda URL que no sea http(s)/ancla (enlaces) o `data:` de imagen validado. Se incrustan hojas de estilo (`<link>`, `<style>`, `@import` con medios, máx. 10) e imágenes (`<img>`, `srcset` → una, carga perezosa `data-src`, `background-image` y demás `url()`, máx. 30 distintas, ≤ 2,5 MB c/u) como `<style>`/data URI; lo que no cabe o falla se omite y se anota. Las tipografías propias (`@font-face`) no se incluyen. La respuesta se topa en **3,5 MB** omitiendo primero las imágenes más grandes. Al final se vuelve a analizar el resultado (`assertClean`) y, si algo peligroso sobreviviera, falla cerrado. Las imágenes se validan por firma de bytes (un «PNG» que es HTML se descarta) y los SVG con scripts/`foreignObject`/entidades se descartan.

Capas independientes que siguen existiendo en el navegador: `sanitizeHtml` vuelve a sanear, el iframe es `sandbox="allow-same-origin"` sin scripts y su CSP solo admite `data:`.

### Interfaz (`src/app/html-to-pdf/`)

- `HtmlToPdfToolClient.tsx`: `SegmentedControl` (tablist) «Dirección web» / «Archivo HTML», sobre el mismo `ToolShell`. La consulta carga un `File` HTML sintético (`ejemplo.com-articulo.html`) con `loadRef`, así que opciones, procesado, descarga, foco y errores del motor son los de siempre. Tras consultar, un resumen («Página leída»: título, dirección final, avisos) y textos de seguridad/fidelidad **distintos** según el origen (en modo URL ya no dice «nada sale de tu dispositivo»).
- `UrlSourcePanel.tsx`: campo con validación en vivo (icono + texto, nunca solo color; los mismos `validateSnapshotUrl`/`normalizeTypedAddress` que la ruta), aviso de transparencia, estado de carga con **cancelación** (aborta el `fetch`), errores por tipo con acciones («Reintentar», «Archivo HTML»), nota plegable de límites.
- **Único cambio fuera de mis carpetas**: `ToolShell` gana la prop opcional `hideDropzone` (7 líneas, aditiva: sin ella nada cambia) para no pintar la zona de carga en el modo URL. Si W-SHELL toca `ToolShell`, el choque sería trivial.
- Tamaño por defecto **Carta** (A4 sigue en opciones); en la lista de opciones Carta va primero.

### PDF Carta bien repartido (`htmlToPdf.ts`, `htmlToPdfLayout.ts`, `htmlToPdfPagination.ts`)

- **Maquetación** con el ancho de la hoja (816 px en Carta, 794 en A4) y el contenido se escala al área útil (margen por defecto 0,5 in); si el contenido es más ancho (tabla de 1400 px) se vuelve a maquetar con ese ancho (hasta 1800 px) y la página se **reduce** en vez de recortarse.
- **Hoja base** inyectada en el documento inerte: imágenes/SVG/canvas `max-width:100%`, imágenes ≤ una página de alto, `html/body` que crecen con el contenido, sin animaciones (estado final). `@media print` de la página **se aplica** (`print` → `all`); `vh/dvh/svh/lvh` pasan a px (un hero `100vh` ocupa una página, no todo el documento).
- **Elementos fijos**: `sticky` pasa al flujo; las barras `fixed` de ancho completo (cabecera, menú, pie) pasan al flujo y salen **una vez**; avisos de cookies, modales y botones flotantes se ocultan; una capa fija a pantalla completa con mucho texto (app) se conserva.
- **Cortes**: se miden líneas de texto, imágenes, filas de tabla, bloques `break-inside:avoid`, encabezados (se quedan con la línea siguiente) y viudas/huérfanas, y `planPages` busca los cortes **más cercanos permitidos** en vez de cortar cada `H` px (con relajación gradual de reglas y contador de cortes a ciegas). Después, **ajuste fino sobre los pixeles**: html2canvas pinta el texto ~9 px más abajo de donde lo mide el DOM (medido en Chromium, ocurre también sin nuestro CSS; es un defecto de html2canvas 1.4.1), así que cada corte se mueve (±24 px) al centro de la franja realmente sin texto del lienzo; por eso se planifica con 48 px menos de página.
- **Nitidez**: escala 2 (1632 px de ancho en Carta); en iOS/iPadOS el lienzo se limita a 8 M de píxeles (12 M en el resto, siempre ≤ 8192 de lado).
- **Sin páginas vacías**: una banda totalmente blanca no se emite (si todo el documento es blanco queda una hoja).
- `htmlToPdf(file, options, onProgress, signal, onLayout?)`: el 5.º parámetro opcional devuelve `{ pages, blankPagesSkipped, forcedBreaks, snappedCuts, layoutWidthPx, documentHeightPx, scale }` para diagnóstico/pruebas. `planCaptureChunks`/`planPageSlices` siguen exportados y probados pero el motor ya no los usa.

### Dependencias

| Paquete | Versión | Licencia | Peso | Dónde |
|---|---|---|---|---|
| `parse5` | 8.0.1 (ya estaba en el árbol por `jsdom`; ahora dependencia directa) | MIT (su dep. `entities` 8.0.0: BSD-2-Clause) | 351 KB desempaquetado | **Solo servidor** (ruta `/api/html-snapshot`); **0 KB** en los bundles del navegador |

`package.json` + `package-lock.json` (a mano: `parse5` y `entities` pasan de `dev` a prod, para no arrastrar ruido de `npm install`). Sin dependencias de runtime para la red (se usa `node:http/https/dns/zlib`).

### Pruebas

- Unitarias (sin red): `src/lib/htmlSnapshot/*.test.ts` (corpus hostil completo del encargo), `htmlToPdfPagination.test.ts`, `htmlToPdfLayout.test.tsx` (jsdom), `htmlToPdf.test.ts` (el valor por defecto pasa a Carta; el resto igual).
- E2E: `e2e/specs/html-to-pdf-url.spec.ts` (`page.route` intercepta la ruta; cubre flujo completo y descarga de PDF Carta, validación en vivo, 8 errores por tipo, sin conexión, cancelar, modo archivo, axe, 375/320 px con tipografía ancha, claro/oscuro, ES/EN y la **ruta real** solo con direcciones que rechaza antes de conectar) y `e2e/specs/html-to-pdf-layout.spec.ts` (motor real en Chromium sobre páginas sintéticas; analiza el PDF resultante: hojas 612×792, sin hojas en blanco, sin tinta pegada a ningún corte, cabecera fija una vez, `@media print`, página ancha, hero 100vh, A4 y horizontal). Ninguna prueba sale a Internet.

### Qué NO está verificado

- **`next build` y el despliegue en Vercel** (política: no se corre). Se probó la ruta con `next dev` (Turbopack). Falta confirmar que la build de producción empaqueta bien `parse5` (ESM) en la función y que `maxDuration = 20` es aceptado por el plan.
- **Safari/WebKit, iPhone e iPad**: no se corrió E2E cruzado. Lo específico de iOS (tope de lienzo 8 M, `isIosLike`) está escrito pero sin probar en dispositivo. Firefox tampoco.
- **Red real**: la conexión TLS real (`https.request` con `lookup` fijo, SNI/certificado) no se probó contra un sitio real (prohibido); el transporte se probó contra un servidor HTTP local en 127.0.0.1 (cabeceras, gzip, bomba, redirección, plazo, puerto cerrado) y toda la lógica de decisión con transporte/DNS falsos.
- **Páginas reales**: solo páginas sintéticas. Sitios con diseños complejos, fuentes propias, SPAs, muros de cookies reales, etc. pueden comportarse distinto.
- Límite de memoria con documentos muy largos (> 100 páginas) y rendimiento en móviles lentos.
- La revisión de seguridad independiente de la ruta queda para el orquestador (plan §Integración).

### Decisiones y límites honestos

- Las `notes` viajan como códigos (la interfaz las traduce); el encargo decía `notes[]` sin fijar el tipo.
- La ruta **no ejecuta JavaScript**: las páginas que se arman en el navegador salen incompletas (se avisa con `scripts-ignored` / `little-content`); las que piden iniciar sesión no se pueden leer. Tipografías propias no incluidas (sustituidas por las del sistema).
- El limitador por IP y el tope de concurrencia son por instancia y en memoria (best effort).
- `@media print` se aplica y los estilos de `screen` se dejan (más seguro que quedarse sin estilos); una página que oculte todo al imprimir saldría vacía.
- Las capas fijas/flotantes se reconocen por tamaño y por nombre de clase/id (cookie, consent, modal, chat…): puede ocultar algo legítimo o dejar pasar un aviso con otro nombre.
- Una interfaz tipo aplicación (`height:100vh` con scroll interno) se recorta a una página.

### Pruebas manuales para el visto bueno (Mac, iPhone, iPad)

1. **Mac (Chrome y Safari)**, `/html-to-pdf`: ver que «Dirección web» es la pestaña inicial y el aviso de transparencia se lee **antes** de pulsar nada. Pegar `https://es.wikipedia.org/wiki/Portable_Document_Format`, «Consultar», revisar el resumen y los avisos, «Procesar», abrir el PDF: hoja Carta, texto legible a buen tamaño, tablas e imágenes sin partir, sin hojas en blanco, sin franja de menú repetida.
2. Probar 3–4 sitios reales distintos (un artículo con muchas imágenes, un blog con banner de cookies, una página con cabecera fija, una documentación con tablas anchas): cabecera fija una sola vez, sin banner tapando texto, nada recortado a la derecha.
3. Errores: `localhost:3000`, `http://192.168.1.1`, `ftp://x.com`, una dirección inexistente (`https://no-existe-123456.example.org`), un PDF (`https://…/archivo.pdf`) → mensajes claros; **«Cancelar consulta»** a mitad de una página lenta; sin conexión (modo avión) → «Sin conexión con el servidor» y «Reintentar».
4. Una página que se arma con JavaScript (una SPA) → sale con el aviso y casi vacía, sin error.
5. Cambiar a «Archivo HTML», subir un `.html` guardado → convierte igual que antes, ahora en Carta.
6. **iPhone y iPad (Safari)**: lo mismo, sobre todo: teclado con el campo (que no haga zoom), consulta, «Procesar» con un artículo largo (¿se queda en un porcentaje? ¿memoria?), descargar y abrir el PDF; rotar el iPad.
7. Claro/oscuro, ES/EN, tipografía grande del sistema: sin desbordes.
8. En producción, con DevTools → Red: la única petición con tu dirección es `POST /api/html-snapshot`; el PDF no genera ninguna petición.

## Operacion de `/api/html-snapshot` (2026-11-02)
- Tres revisiones de seguridad independientes; los hallazgos de las tres se corrigieron (SSRF/DNS-rebinding sin hallazgos; DoS por parse5 cortado desde dentro con un `treeAdapter` + filtro previo; CSS con escapes y `\f`; presupuesto de peticiones; tamaño de respuesta).
- Residual conocido: sin Worker, una sola llamada larga a parse5 no se interrumpe; el coste se acota con topes (1,5 MB, 100 000 elementos, 1000 de profundidad, 256 atributos, 3 MB de CSS). Una pagina legitima por encima se rechaza con `too-large`.
- El limitador por IP es de memoria por instancia (best effort). La proteccion real es una **regla de limite de tasa en el firewall de Vercel** para `POST /api/html-snapshot` (pendiente de que el propietario la active). Si el dominio pasa por un proxy (p. ej. Cloudflare), la IP que ve la ruta seria la del proxy.


---

# Wave 2 (2026-11-02): menu movil, MP3, Licencias y responsive Apple Design

Pedido del usuario: menu movil = barra lateral; regla de limite de tasa (activa: 10/min por IP en `POST /api/html-snapshot`, publicada con `vercel firewall`); licencia MPL-2.0 aceptada; MP3 como salida (LAME, LGPL, en WASM, con aviso en `/licenses`); todas las herramientas responsive en todos los dispositivos.


<!-- W-nav -->
## W-NAV2 · Menú móvil y de tablet con la misma estructura que la barra lateral

### Qué se hizo

Una **hoja de menú** (`MobileMenuSheet`) con el MISMO contenido y orden que la barra lateral de escritorio: buscador, Inicio, Recientes, PDF Pro, las tres suites con sus acordeones (OptimusPDF con seis categorías, OptimusSCAN, OptimusTOOLS con Downloader / Audio Studio / Converter / «Próximamente…»), Exportar / Importar → Documentos, Ajustes, Precios, Proyecto, **Licencias** (`/licenses`) y, al pie, idioma ES/EN y tema Claro/Oscuro/Sistema.

- **Teléfono (<768 px):** quinta pestaña «Menú» en `MobileTabBar` (el máximo de iOS). Es un botón (`aria-expanded`, `aria-haspopup="dialog"`, `aria-controls` solo con la hoja abierta), no una página. La hoja sube casi a pantalla completa (`100dvh` menos la zona segura de arriba y 0,75 rem, para que el borde de la página asome bajo el velo).
- **Tablet (768–1023 px):** botón «Menú» (icono + etiqueta) en `Header`, que abre **la misma hoja** como hoja de formulario centrada (máx. 32 rem, alto fijo `min(46rem, 100dvh − 4rem)` para que desplegar una sección no mueva el marco). **Sustituye** al popover «Herramientas».
- **Escritorio (≥1024 px):** no cambia, salvo que su pie lleva el enlace a **Licencias** (tercer enlace tras Precios y Proyecto). Si la ventana pasa de 1024 px con la hoja abierta, la hoja se cierra sola.

Archivos (todos en `src/components/layout/` salvo los locales y los E2E):

| archivo | papel |
|---|---|
| `SidebarNavBody.tsx` (nuevo) | El cuerpo de navegación (arriba / árbol / Exportar-Importar / Precios-Proyecto-Licencias), extraído de `Sidebar.tsx`. Lo usan la barra lateral Y la hoja: el orden no puede separarse. Acepta `onNavigate` (la hoja se cierra al pulsar un enlace). |
| `MobileMenuSheet.tsx` (nuevo) | La hoja. Usa `Sheet` de `src/components/ui` (no hay un segundo sistema de hojas). |
| `mobileMenu.ts` (nuevo) | Store externo mínimo (mismo patrón que `activeSection.ts`): abierto/cerrado, disparador que abrió, `useMenuTrigger()` con los atributos ARIA. Una sola hoja montada en `Header` sirve a los dos disparadores y sobrevive a un giro del aparato. |
| `navSearch.ts` (nuevo) | `fold` + `searchTools`: la misma búsqueda (sin tildes ni mayúsculas) para la barra y la hoja. |
| `Sidebar.tsx`, `SidebarTree.tsx` | `Sidebar` usa `SidebarNavBody` (misma salida + Licencias); `SidebarTree` acepta `onNavigate` (opcional, sin cambio por defecto). |
| `Header.tsx`, `MobileTabBar.tsx` | Botón «Menú» de tablet; quinta pestaña. |
| `src/lib/locales/{es,en}.ts` | Bloque `nav`, 4 claves nuevas contiguas: `menu`, `closeMenu`, `licenses`, `searchResults`. |

### Decisiones (Apple HIG)

1. **¿Popover o hoja en tablet? Hoja.** El popover era un desplegable de 640 px con solo el catálogo (sin buscador, Recientes, Documentos, Ajustes, idioma ni tema), de alto no acotado a la ventana y con dos columnas que con la fuente al 150 % no cabían. Mostrar «lo mismo que la barra» en él lo habría convertido en una caja con scroll bajo la cabecera. La hoja de formulario centrada es la forma de iPadOS para una lista modal, y deja un solo sistema de foco, scroll y cierre para teléfono y tablet. No se hizo un cajón lateral desde el borde porque `Sheet` anima en vertical y habría sido un segundo sistema.
2. **Reutilizar `Sheet`**: arrastre 1:1 con velocidad y proyección (cierra con un gesto rápido; un arrastre lento y corto vuelve), velo ligado al desplazamiento, Escape, foco atrapado y devuelto, bloqueo del scroll del fondo, `overscroll-behavior: contain`, zona segura, reduced motion. Se añade: `inertBackground` (todo lo demás `inert`), foco devuelto al disparador **visible** (Safari no da foco a un botón al pulsarlo; si un giro ocultó la pestaña, vuelve al botón de la cabecera), cierre al navegar y al pasar a ≥1024 px.
3. **Un solo detente** (grande). iOS tiene también el «medio», pero para una lista de navegación de ~25 filas no aporta: `Sheet` tiene un detente y no se ha ampliado (archivo ajeno).
4. **Historial: no se toca.** El repo no tiene un patrón de historial para hojas (solo las guardas de salida de Firmar/Escáner) y el brief decía no inventarlo. Consecuencia honesta: con la hoja abierta, **Atrás navega hacia atrás como siempre** y la hoja se cierra al cambiar la ruta; no «sale de la página» para cerrar la hoja y quedarse. Si se quiere el comportamiento iOS (Atrás cierra la hoja), hay que añadir un patrón de historial común a TODAS las hojas, no solo a esta.
5. **Buscador** dentro de la hoja: al escribir, los resultados **sustituyen** al árbol (no un desplegable que se recorta dentro del área desplazable), con un estado `role="status"` («31 resultados» / «Sin resultados»); Escape con texto lo borra y NO cierra la hoja, con el campo vacío cierra. En pantallas táctiles el campo mide ≥16 px (regla global `pointer: coarse`), así que Safari no acerca la página al enfocarlo. Al abrir, el foco va al propio diálogo (no al campo) para no abrir el teclado del teléfono.
6. **Pie (idioma y tema) pegado abajo** solo con 41 rem de alto o más; en un iPhone SE (568 px) o un teléfono horizontal ocuparía un cuarto de la pantalla y pasa al final de la lista. Fondo opaco (la lista pasa por debajo). Lleva compensaciones de `Sheet` (su padding) con márgenes negativos y `bottom` negativo (Chromium y WebKit pegan lo `sticky` al borde del contenido, no del área desplazable): medido, queda a ras de la hoja y no salta al llegar al final.
7. **Pestañas**: con cinco, cada una mide 64–75 px en 320–375 px y «Mis documentos» no cabe en una línea: la etiqueta pasa a dos líneas (máx. dos, `line-clamp`), con el icono anclado arriba para que no cambie de altura. Por debajo de 360 px la etiqueta baja a 10 px (el tamaño de iOS) y «documentos» cabe entera en 64 px. El nombre accesible no cambia (`MyDocumentsHomeSection.test` sigue pidiendo tres enlaces «Mis documentos»).
8. **Acordeones**: las mismas filas, el mismo `aria-expanded` y la misma persistencia (`optimuspdf.sidebarSections`, sessionStorage) que la barra; un solo orden de tabulación; plataformas del Downloader y «Próximamente…» no enfocables. El indicador activo comparte `layoutId` con la barra (que sigue montada, oculta): la hoja lo aísla con `LayoutGroup`.
9. **Foco**: `Sheet` atrapa el foco con el primer y último control *del DOM*, pero el selector de tema (tabindex itinerante) termina con una opción que NO recibe Tab: desde la última tabulable el foco se escapaba a la barra del navegador. La hoja calcula el primero y el último tabulables de verdad y cicla (`wrapTab`). Esto es un defecto latente de `Sheet` (ver «Para la integración»).

### Pruebas (en esta copia; Chromium y WebKit headless, servidor de desarrollo, sin datos reales)

- `tsc --noEmit` sin errores; `eslint src e2e` 0 errores (1 aviso previo en `inputChecks.clients.test.tsx`, ajeno).
- Vitest (`engines` + `components`, `src/components/layout`, `MyDocumentsHomeSection`, `settingsRegistry`, `src/components/ui`, `tools-registry`): 19 archivos, 287 pruebas verdes. Nuevas: `MobileMenuSheet.test.tsx` (30: pestañas/botón, ARIA, orden idéntico al de la barra lateral, desplegables, Downloader, buscador, idioma/tema, Escape/X/velo, foco —también sin foco previo, como Safari—, cierre al navegar sin tocar `history.length`, `inert`, bloqueo del scroll, foco atrapado). Reescritas por el cambio de popover a hoja: `Header.test.tsx`, el bloque de cabecera de `FeaturedNav.test.tsx`. Ajustadas: `SidebarTree.test.tsx` (+ `/licenses`). Comprobado con mutaciones que las pruebas fallan sin `inertBackground`, sin el cierre al pulsar un enlace, sin el cierre al cambiar de ruta y sin el foco al disparador.
- E2E `e2e/specs/nav-mobile-menu.spec.ts` (nuevo, 36 pruebas): Chromium 36/36; WebKit (`PW_BROWSERS=webkit PW_CROSS_FULL=1 … --project=webkit`) 35/36 y la que fallaba (la rueda no existe en el WebKit móvil de Playwright) se hizo consciente del motor y pasa en los dos. Cubre iPhone 375, 320 y 320×568 (tacto), iPad 834 vertical y 1194 horizontal, teléfono horizontal 812×375, claro y oscuro, ES y EN, teclado y foco (70 Tab y 70 Mayús+Tab sin salir), axe (las reglas de `nav-optimustools` + diálogo, campo y región desplazable) cerrada, abierta, todo desplegado y buscando, objetivos ≥44 px (más de 60 controles), sin desborde a 320 y 375 con DejaVu Sans + 6 % de espaciado y a 768/834 con la fuente al 150 %, cierre por Escape/velo/X/enlace/arrastre/Atrás, foco de vuelta, fondo `inert` y sin scroll, persistencia de secciones, idioma y tema (también en Ajustes), cambio de ancho con la hoja abierta y movimiento reducido.
- `nav-optimustools.spec.ts` actualizado (la barra lateral lleva `/licenses`; la prueba de tablet pasa del popover a la hoja): 35/35.

### Límites y no verificado

- **No verificado en un iPhone/iPad reales** ni en Safari de verdad: el WebKit de Playwright reproduce el motor pero no la barra de direcciones que se encoge, el teclado de pantalla, el rebote del scroll ni `backdrop-filter` (en headless el desenfoque del material no se ve; por eso el pie lleva fondo opaco). El bloqueo del scroll del fondo se apoya en `overflow: hidden` del `<body>` (iOS ≥16) más `overscroll-behavior: contain`.
- **`/licenses`**: solo se comprueba el enlace (`href="/licenses"`); la página la crea otra unidad y no existe en esta copia (la prueba unitaria de «ningún enlace roto» de `SidebarTree.test.tsx` la añade a las páginas conocidas; los E2E no la visitan).
- **Atrás** cierra la hoja *al navegar* (ver la decisión 4); no existe un «Atrás cierra la hoja y se queda».
- Con la fuente forzada a DejaVu Sans muy ancha a 320 px, «documentos» de la pestaña se corta con puntos suspensivos (el nombre accesible es completo) y el selector de tema pasa a dos filas.
- La barra lateral plegada (riel de iconos) no muestra Precios/Proyecto/Licencias (igual que antes con Precios y Proyecto).
- El pie de página (`Footer.tsx`, ajeno) desborda 51 px a 768 px con la fuente al 150 % + tipografía ancha («Proyecto de Optimus Reframe»): las pruebas de tablet lo ocultan para medir cabecera y hoja.
- Intermitencia **previa** (no causada por este cambio): `nav-optimustools.spec.ts › axe … en Inicio y en /downloader` se cuelga hasta el plazo (2 min) o mide un contraste a mitad de una transición de color en ~3 de cada 10 ejecuciones con la máquina cargada; reproducido con los cambios de esta unidad retirados (3 fallos de 10). En la corrida final pasó 35/35.

### Para la integración (fuera de mi alcance)

- `src/components/ui/Sheet.tsx`: (a) `trapFocus` usa el primer/último control del DOM y no el primer/último *tabulable*: una hoja que termina en un `SegmentedControl` deja escapar el foco (aquí se compensa con `wrapTab`); (b) `max-h-[88vh]` usa `vh`, no `dvh` (aquí se sustituye con `!`).
- `src/app/licenses/`: debe existir para que el enlace de Licencias no sea un 404.
- Si se quiere «Atrás cierra la hoja»: un patrón de historial común a todas las hojas.

### Pruebas manuales (Mac / iPhone / iPad)

**iPhone (Safari), vertical, 375–430 px**
1. Abre Inicio: la barra inferior tiene cinco pestañas (Inicio, Mis documentos, Recientes, Ajustes, Menú). «Mis documentos» puede ocupar dos líneas; ninguna se sale de la pantalla.
2. Toca «Menú»: sube una hoja casi a pantalla completa, con la agarradera arriba, «Menú» y una X (≥44 px). Mira que el contenido y el orden son los de la barra de escritorio: buscador → Inicio · Recientes · PDF Pro → OptimusPDF (seis categorías con flecha) → OptimusSCAN (Escanear a PDF) → OptimusTOOLS (Downloader «Pronto», Audio Studio, Converter, «Próximamente…») → Exportar / Importar (Mis documentos, Ajustes) → Precios, Proyecto, Licencias → «100 % local» → idioma y tema siempre a la vista abajo (con la isla/indicador de inicio no tapando nada).
3. Desplaza la lista con el dedo: la página de debajo NO se mueve, ni al llegar al final ni al seguir tirando (rebote contenido). Cierra y comprueba que la página sigue donde estaba.
4. Cierra de cuatro formas: toca la X, toca el velo (franja de arriba), arrastra la hoja hacia abajo con un gesto rápido (se va) y con uno lento y corto (vuelve). Tras cada una, la pestaña «Menú» recupera el foco (con un teclado externo, el anillo de foco se ve).
5. Despliega «Seguridad»: aparece Proteger/Desbloquear/… Cierra y reabre la hoja: sigue desplegada. Recarga: también.
6. Toca el buscador, escribe «escanear»: salen los resultados en lugar del árbol, sin que Safari acerque la página; toca «Escanear a PDF»: abre la herramienta y la hoja se va.
7. Toca «EN» y «Oscuro» desde la hoja: la hoja y la página cambian al instante y se recuerdan al recargar.
8. Con la hoja abierta pulsa **Atrás** del navegador: navega hacia atrás y la hoja no se queda abierta (no sale ninguna hoja huérfana).
9. Gira el teléfono a horizontal con la hoja abierta: sigue abierta (ahora a pantalla completa, sin teclas tapadas por la muesca) y el pie va al final de la lista.
10. Ajustes del iPhone → Accesibilidad → Pantalla y tamaño de texto → «Texto más grande» al máximo: nada se sale por los lados.

**iPad (Safari), 834 px vertical**
1. Arriba a la izquierda, junto al logotipo, hay un botón «Menú» (icono y texto); ya no hay «Herramientas». Tócalo: hoja centrada de ~512 px con el mismo contenido. Toca fuera de la tarjeta: se cierra.
2. Con teclado: Tab recorre la hoja sin salir de ella, Escape la cierra y el foco vuelve al botón «Menú».
3. Gira a horizontal (1194 px): ya manda la barra lateral de escritorio (con «Licencias» al final, ≥44 px con el dedo) y, si la hoja estaba abierta, se cierra.

**Mac (Safari y Chrome)**
1. Ventana ≥1024 px: la barra lateral es igual que antes y termina en Precios · Proyecto · Licencias.
2. Estrecha la ventana por debajo de 1024 px: aparece el botón «Menú» (y por debajo de 768 px, la barra inferior con cinco pestañas). Abre la hoja; ensancha la ventana a más de 1024 px: la hoja se cierra y manda la barra.
3. Prueba Tab / Mayús+Tab y Escape; con «Reducir movimiento» activado la hoja aparece con fundido, sin deslizar.


<!-- W-mp3 -->
## W-MP3 · Salida MP3, pagina de Licencias y barra del reproductor / responsive de audio

Decision del usuario (2026-11-02): «MP3 como salida deberia haber» y «activa la licencia MPL-2.0». La regla «nada LGPL» queda levantada
SOLO para esto. Entrega: `unit-nodocs.patch` (37 archivos, +3276/-97; aplica limpio con `git apply --check` sobre el repo real).

### Que se hizo

**1. Salida MP3 en `/audio-converter`, `/audio-extractor` y `/audio-studio`** (las tres comparten `OutputOptions` y `encodeAudio`; el audio del
`/video-converter` no cambia).
- Dependencia nueva: `@mediabunny/mp3-encoder` **1.65.0 exacta** (MPL-2.0; LAME 3.100 compilado a WebAssembly con SIMD, dentro del paquete). Peer
  `mediabunny ^1.0.0`; ya estaba 1.65.0. Solo `package.json` y `package-lock.json` (+14 lineas, sin otros paquetes). Paquete minificado:
  473 KB, **118 KB gzip** (coincide con los ~130 kB que declara el paquete).
- `src/lib/media/audio/mp3.ts` (nuevo, UNICO archivo de audio que importa `mediabunny` y el codificador): `Output` + `Mp3OutputFormat` +
  `BufferTarget` + `AudioSampleSource`; trozos de 0,5 s con contrapresion (se espera a cada `add`), progreso real (hasta 95 % por trozos, 100 % al
  cerrar), cancelacion con `AbortSignal` que **no depende del Worker** (se abandona la espera y se llama a `output.cancel()`, que lo termina) y
  vigilante de arranque de 45 s (Worker o WASM bloqueados que nunca contestan -> `encoderUnavailable`, no una pantalla de progreso eterna). Cierra
  cada `AudioSample` (mediabunny avisa en consola si no).
- **Carga perezosa**: `encode.ts` solo hace `await import("@/lib/media/audio/mp3")` al elegir MP3. Comprobado en navegador: ninguna ruta
  (`/`, tres de audio, `/video-converter`, `/licenses`, `/image-converter`) trae el codificador al abrirse, ni al convertir a WAV, ni con MP3 elegido
  sin procesar; al procesar se descarga **un** trozo (`audio-mp3.spec.ts`, «carga perezosa»).
- `mp3Params.ts` (aritmetica pura, sin LAME): frecuencias validas de MP3 (48/44,1/32/24/22,05/16/12/11,025/8 kHz) con ajuste a la mas cercana
  (un original de 96 kHz sale a 48 kHz) y tasa maxima por version MPEG (320 / 160 / 64 kbps) para que LAME no elija otra en silencio.
- Interfaz: MP3 es un formato mas de `OutputOptions` (radio, mismo patron). **Tasas 128/192/256/320 kbps (192 por defecto), frecuencias 48/44,1/32 kHz o
  «la del original», mono/estereo.** Al elegir MP3 se ve el credito «Codificacion MP3 por LAME» (enlace a lame.sourceforge.io, como pide LAME) y
  «Licencias y codigo fuente» (`/licenses#mp3`); ambos abren otra pestana (no se pierde el trabajo en curso) y lo dicen para lectores de pantalla.
- Deteccion de capacidades (`capabilities.ts`): WebAssembly **con SIMD** (`WebAssembly.validate` de un modulo con `v128`, sin descargar nada) y `Worker`.
  Sin ellos, MP3 sale desactivado con motivo propio (`noWasm`: «necesita WebAssembly con SIMD (Safari 16.4…)», `noWorker`) y accesible
  (`aria-disabled` + `aria-describedby`). Si falla al codificar (CSP, extension, modo de bloqueo) se declara `encoderUnavailable` con una pista
  concreta sobre MP3; nunca «Algo ha fallado». `capabilities.ts` ya no tiene la razon `license`; los textos de «por que no hay MP3» desaparecieron.
- Metadatos: **no se escribe ninguna etiqueta** (no se llama a `setMetadataTags`): sin ID3, sin titulo/artista ni datos del original. Lo unico que
  mediabunny anade por defecto es la trama inicial **Xing/Info** (numero de tramas, indice de busqueda y retraso del codificador, con la cadena
  «LAME» sin version). Un test comprueba que el archivo no empieza por `ID3`.
- Limites: tope de `MAX_MP3_BYTES` = 1 GiB de salida (~7 h a 320 kbps) con `tooLarge` ANTES de leer una muestra; el resto lo marcan los limites ya
  existentes (archivo 300 MB, audio decodificado 1 GiB / 384 MiB en movil -> `tooLong` con «caben ~N minutos», lote 50 archivos / 800 MB).
  LAME es de tasa **constante**: el codificador empaquetado no expone VBR, asi que «VBR calidad» NO se ofrece (declarado, no ocultado).
- Nombres: `cancion.mp3` -> `cancion-convertido.mp3`; ZIP con `.mp3` dentro; estudio: `<primer clip>-editado.mp3`.
- **CSP: no se ha tocado `next.config.ts`.** La politica ya trae `worker-src 'self' blob:` y `'wasm-unsafe-eval'` en `script-src` (y el Worker
  hereda la CSP del documento). Comprobado con la politica de produccion (la de desarrollo menos `'unsafe-eval'`, que React solo pide en desarrollo):
  Worker en blob y WASM funcionan sin violaciones; y recortando `worker-src blob:` o `'wasm-unsafe-eval'` el error sale como `encoderUnavailable`
  en < 1 s, sin colgarse.
- Correccion de un defecto previo en `AudioStudioClient`: tras exportar, el foco se pedia con un unico `requestAnimationFrame` y perdia la carrera con la
  salida de la pantalla de progreso (inerte hasta salir): el foco acababa en `<body>` (visto con MP3). Ahora usa `useFocusTarget`, que reintenta.

**2. Pagina `/licenses`** (`src/app/licenses/`: `page.tsx`, `LicensesView.tsx`, `strings.ts` ES/EN, `packages.ts`, `licenseTexts.ts`, `lame.ts`).
- Tarjetas apiladas (no tabla: a 320 px una tabla de 4 columnas obliga a desplazar de lado), mismo marco que `/about` y `/privacy`, claro/oscuro, ES/EN.
- Seccion **Salida MP3**: aviso «MP3 encoding by LAME» (en ingles, `lang="en"`, enlace a https://lame.sourceforge.io/), mediabunny 1.65.0 (MPL-2.0),
  @mediabunny/mp3-encoder 1.65.0 (MPL-2.0) y LAME 3.100 (LGPL, version 2 o posterior); cumplimiento (archivos **sin modificar**; MPL a nivel de
  archivo; LAME sin cambios); codigo fuente por **version exacta** (repo en la etiqueta `v1.65.0`, paquete npm `/v/1.65.0`, `.tgz` exacto, sitio de LAME,
  carpeta 3.100 de SourceForge); textos de licencia por enlace canonico (MPL-2.0, LGPL-2.0 y 2.1; no se pega ninguno); y «Como sustituir LAME»: explica
  que el WASM va incrustado en el paquete, que el paquete es de codigo abierto y su compilacion reproducible (Emscripten 4.0.21, README del paquete), y
  dice sin rodeos que **hoy no hay mecanismo para cambiarlo desde el navegador**.
- **24 componentes** = las dependencias de ejecucion de `package.json` (version y licencia copiadas de `node_modules/<pkg>/package.json`), con para-que-se-usa,
  repositorio, paquete en npm y texto de la licencia; `jszip` (MIT OR GPL-3.0-or-later) declara «se usa bajo MIT»; `parse5` lleva la etiqueta «En el servidor»
  (corre en `/api/html-snapshot`, no en el navegador). Aparte, fuentes y decodificadores incluidos que no son paquetes npm (Liberation, fuentes de pdf.js,
  OpenJPEG/JBIG2/QCMS, Caveat, JetBrains Mono) y una nota de lo que NO se incluye (los modelos de IA, que se descargan al usarlos).
- Enlaces: pie de pagina (`Footer.tsx`: la entrada «Licencias» apuntaba a `/about`; ahora a `/licenses`) y tarjeta en `/about` (`about/page.tsx` renderiza
  `AboutLicensesCard` debajo de `AboutView`; `AboutView` vive en `components/views/`, fuera de mi alcance, asi que no se edita). No existen `sitemap` ni `robots`.
- Los datos no pueden desactualizarse en silencio: `licenses.test.ts` compara `packages.ts` con `package.json` y `node_modules` (version, licencia, repo),
  comprueba que no se listan dependencias de desarrollo, que cada licencia tiene enlace canonico y que los hashes de `lame.ts` (tar.gz de LAME 3.100, WASM,
  Emscripten) coinciden con el README del paquete. **Ademas decodifica el WASM del propio Worker y comprueba su SHA-256** (`a680e507…446a6` = el que
  declara el README): lo que la pagina afirma («hemos comprobado que…») es cierto y se vuelve a comprobar.

**3. Barra del reproductor de Audio Studio (peticion posterior del coordinador)** — `AudioStudioClient.tsx`:
- Reproducir: boton primario de 44 px. Deshacer/Rehacer: botones de **icono 44 x 44** con `aria-label` y `title`, separados 8 px. Tiempos en **una
  sola linea** (`whitespace-nowrap` + `tabular-nums`). Movil (< 640 px): fila 1 = Reproducir + iconos a la derecha, fila 2 = tiempos; desde 640 px todo en una
  fila; con letra grande `flex-wrap` baja lo que no quepa en vez de desbordar. (Un `px-0` no ganaba al `px-5` del boton base porque `cn` no fusiona
  clases de Tailwind: los iconos salian de 4 px; se usa `px-0!`.)
- Revisados a 320/390/430/834/1194/1280/1920 px, claro/oscuro, ES/EN, texto al 150 % y tipografia ancha: **`AudioWorkFrame`** (barra de acciones del movil:
  «Procesar» se salia de la pantalla con letra grande -> `flex-wrap`) y **`ClipList`** (los botones Subir/Bajar/Quitar se salian -> fila que envuelve).

### Cifras verificadas (Chromium headless contra el servidor de desarrollo, y Node)

- Unitarias: `vitest --project engines --project components` sobre `src/lib/media`, `audio-*`, `licenses`, `layout` y reglas de app: **45 archivos, 482 pruebas, todo verde**
  (MP3 real con LAME en worker de Node: 14 + 9 de fallos con mediabunny simulado + 4 de auditoria del paquete + 51 de licencias; ver abajo).
- Round trip WAV -> MP3: duracion que oye un decodificador (tramas menos cabecera y retraso del codificador) dentro de **5-20 ms** del original (limite 50 ms);
  Chromium decodifica con `decodeAudioData`: duracion +-50 ms, tonos 440/880 Hz por canal, 44,1/48 kHz, mono/estereo, 128/192/256/320 kbps; cabecera MPEG-1 Capa III
  recorrida trama a trama sin bytes sobrantes; sin ID3. Velocidad en Node: 60 s estereo 44,1 kHz en **435 ms a 128 kbps (138x tiempo real)** y 504 ms a 320 kbps.
- E2E headless Chromium (**68 pruebas** de `audio-mp3`, `audio-converter`, `audio-converter-engine`, `audio-extractor`, `audio-studio`, `licenses`; + **14** de `audio-responsive`):
  descarga de MP3 desde converter, studio y extractor; Worker creado desde blob y **0 workers vivos** al terminar o cancelar; ninguna peticion fuera del origen ni con
  cuerpo; **0 errores/avisos de consola**; 0 violaciones de CSP; MP3 con CSP de produccion; cancelar un archivo de 30 min vuelve a la lista con el aviso;
  sin SIMD / sin Worker / Worker que se niega a crearse -> desactivado o error explicado; axe 0 y sin desborde 320-1920 px, claro/oscuro, ES/EN.
- **WebKit (Playwright 1.62, escritorio, headless)**: converter (192 kbps y 320/mono/48 kHz), tonos L/R y studio exportando MP3 -> **4 de 4 verdes**.
- Auditoria `responsive-audit.mjs` (7 viewports x 3 rutas, vacia y cargada): **0 hallazgos reales** en ambas (antes: 0 reales tras descartar los falsos positivos conocidos; la
  heuristica no veia el envoltorio de la barra del reproductor, que esta pasada mide ya con asercion propia).
- `audio-responsive.spec.ts` (14 pruebas = 7 viewports x {oscuro/ES/texto 150 %, claro/EN/tipografia ancha}; cada una recorre las 3 herramientas x {vacia, cargada, hoja de
  opciones, procesando (Worker mudo + cancelar), resultado}): sin desborde de lo de la herramienta, sin texto cortado, objetivos >= 44 px y >= 8 px entre hermanos con tacto,
  lo ultimo de la pagina por encima de las barras fijas, hojas y pantalla de progreso dentro de la ventana con su accion a la vista, axe 0 y la barra del reproductor
  (tamanos, aria-label, una linea de tiempos, filas ordenadas). Mientras se escribia detecto y corrigio 3 defectos reales (barra de acciones, lista de clips, iconos de 4 px).

### Decisiones y limites

- La nota del brief decia «LGPL-2.1+»; el texto que acompana a LAME en el paquete es la **LGPL version 2 (Library GPL) «o cualquier version posterior»**, y el README dice «LGPL v2 or later».
  La pagina dice «LGPL, version 2 o posterior» y enlaza el texto de la 2.0 y el de la 2.1.
- `mediabunny` esta en `package.json` como `^1.65.0` (lo puso W-VIDEO); el codificador va exacto. El lock fija 1.65.0 para ambos y la prueba exige que coincidan (major.minor).
- `parse5` se lista aunque corre en el servidor (el brief lo pedia como «empaquetado en el cliente»): se etiqueta «En el servidor» en vez de esconderlo.
- La pagina no promete mas de lo cierto: el WASM no se puede sustituir desde el navegador; hay que reconstruir paquete y aplicacion. No afirma nada sobre publicar el codigo de OptimusPDF.
- `AudioError`/textos: `encoderUnavailable` ahora tambien cubre MP3 (misma frase, pista ampliada ES/EN).
- Sin ID3 por decision de privacidad; si algun dia se quisieran etiquetas, `Output.setMetadataTags` lo permite, pero entonces habria que pedirlas al usuario.

### NO verificado

- **Safari/iOS reales y Firefox.** WebKit de Playwright pasa; **Firefox no arranca en este sandbox** (timeout de lanzamiento de 180 s), asi que no hay ninguna ejecucion en Firefox. WebAssembly SIMD
  en iOS 16.4+ se detecta con el modulo estandar de `wasm-feature-detect`, pero no se ha probado en un iPhone/iPad fisico.
- **Compilacion de produccion** (`next build`, prohibida en esta pasada): el aislamiento del codificador en su propio trozo esta medido con el servidor de desarrollo (Turbopack); el peso por ruta
  de la build real no se ha medido. La CSP de produccion se emulo quitando `'unsafe-eval'` de la cabecera de desarrollo; no se sirvio la build real.
- Memoria y tiempo en moviles reales con audios largos (el tope de 1 GiB / 384 MiB decodificado es heuristico; lo mas largo probado: 30 min mono 22,05 kHz, cancelado a mitad).
- Descarga del `.mp3` en iOS Safari: usa el `saveBlob` de siempre (enlace `<a download>`), sin hoja de compartir como plan B (no se ha cambiado; RESP-COMMON lo pide para iOS).
- Revision juridica del texto de `/licenses` (es una descripcion honesta de lo que se incluye, no asesoria legal).
- No se ha verificado a mano el contraste en modo «Aumentar contraste» ni `forced-colors` de la pagina de licencias (se reutilizan los tokens y las clases `forced-colors:` de los componentes).

### Hallazgos AJENOS que esta pasada no puede tocar (componentes compartidos / otra duena)

1. `DownloadScreen.tsx`: el boton primario «Descargar» (`size lg`, sin `wrap`) mide 336 px a 320 px con texto al 150 % (sale por ambos lados, `-8..328`). Arreglo: `wrap` en ese boton. `audio-responsive.spec.ts` lo **anota** (`shared-defect`)
   en lugar de contarlo; quitar el filtro `sharedDownload` al arreglarlo.
2. A 320 px con texto al 150 %, la **barra de pestanas movil** (`MobileTabBar`, «Ajustes» llega a x=386) y la **cabecera** ensanchan el documento (322-343 px) en TODAS las paginas (tambien `/privacy`); el movil amplia la ventana y las barras fijas se estiran.
   El spec lo anota (`chrome-overflow`) y mide el contenido de la herramienta contra esa ventana ampliada.
3. Los textos de las herramientas en `src/lib/locales/{es,en}.ts` (lineas ~197/209 y ~186/198) siguen diciendo «(WAV, M4A, Opus)» / «WAV, M4A or Opus»: anadir MP3 (la cabecera de cada herramienta los muestra).
   Tampoco son mios (`locales`), por eso no los toque. Ademas `footer.licenses` en EN dice «Licences» (el brief pedia «Licenses»).

### Correcciones pendientes en `docs/PLAN-OPTIMUSTOOLS.md` (este patch no toca `docs/`)

- L41-42 (regla «nada GPL/LGPL»): anadir «excepcion aprobada por el usuario el 2026-11-02: `@mediabunny/mp3-encoder` (MPL-2.0) con LAME (LGPL) empaquetado en WASM, con aviso y enlace en `/licenses`».
- L199-203 (mediabunny/MPL-2.0 «Decision que dejo al orquestador»): resuelta, MPL-2.0 aceptada; «Añadir mediabunny a la pagina de Licencias» -> hecho en `/licenses`.
- L275 («Dependencias nuevas: ninguna (ni mediabunny ni codificadores de MP3)») y L297-298 (MP3 «no existe», «desactivado con el motivo»; mediabunny «no se ha usado»): sustituir por «MP3 existe como salida desde W-MP3; mediabunny ya lo usa el convertidor de video».
- L322 («Confirmar que MP3 sale desactivado con su explicacion») -> ver las pruebas manuales de abajo. L377 (tabla de paquetes): anadir `@mediabunny/mp3-encoder 1.65.0 · MPL-2.0 · 118 KB gzip (trozo perezoso) · /audio-*`.

### Pruebas manuales para el usuario (Mac, iPhone, iPad)

1. **Mac · Safari y Chrome**: `/audio-converter`, subir un WAV y un M4A de Notas de voz -> elegir MP3 (192 kbps) -> Procesar -> descargar `.mp3` y abrirlo en Musica/QuickTime y en VLC. Probar 128 y 320 kbps y «Mono». Con `Opciones > Formato`, ver bajo el selector «Codificacion MP3 por LAME» y pulsar «Licencias y codigo fuente» (se abre `/licenses#mp3`).
2. **Mac · Firefox** (no se pudo probar aqui): lo mismo; si MP3 sale desactivado, debe decir por que.
3. **iPhone (SE y 15/Max) · Safari**: elegir un audio de Archivos, abrir «Opciones», elegir MP3, Procesar y **Cancelar** a mitad con un audio de varios minutos (la pantalla debe volver sin colgarse). Descargar el `.mp3` y comprobar que se abre desde Archivos/Mensajes. Con «Modo de bloqueo» activado (si aplica) MP3 debe fallar con el aviso explicativo, no con «Algo ha fallado».
4. **iPad vertical/horizontal · Safari**: `/audio-studio` con 2 clips (de «Notas de voz» y de Archivos): reproducir, deshacer/rehacer con los iconos, exportar a MP3 y a M4A; la fila del reproductor debe verse con tiempos en una linea.
5. **Texto grande** (Ajustes > Pantalla > Tamano del texto al maximo) en iPhone SE: `/audio-converter`, `/audio-extractor`, `/audio-studio` en cada fase (vacia, con archivo, procesando, resultado): sin desplazamiento horizontal; «Procesar» a la vista; botones Subir/Bajar/Quitar de la lista de clips alcanzables. (El boton «Descargar» puede salirse a 320 px: ver hallazgo 1.)

Nota del helper: `e2e/helpers/audio-flow.ts` gana `frequencyRight` en `makeWav` (un tono distinto en el canal derecho) para comprobar que el estereo sobrevive al MP3.
6. **Modo claro/oscuro y ES/EN** en `/licenses`: leer el aviso de LAME, abrir los enlaces de codigo fuente de mediabunny/encoder/LAME y los textos MPL-2.0/LGPL; en iPhone comprobar que todos los enlaces son faciles de tocar y que `/licenses#mp3` deja el titulo visible bajo la cabecera.
7. Desde el pie de pagina («Licencias») y desde «El proyecto» (tarjeta «Licencias y codigo abierto») llegar a `/licenses`.
8. **Sin red**: abrir `/audio-converter`, cargar la pagina, ponerse en modo avion y elegir MP3 por primera vez: si el trozo del codificador no estaba en cache debe salir el aviso «Tu navegador no puede crear el formato elegido…», y WAV debe seguir funcionando.


<!-- W-resp-a -->
## W-RESP-A · Responsive Apple Design de las herramientas PDF (carpetas por herramienta)

Alcance: las 35 herramientas de `src/app/<slug>/` de la lista de W-RESP-A + `sign-pdf` y `pdf-pro` (solo medidas, sin tocarlas) en estado vacío, con archivo cargado, con la hoja «Opciones» abierta (móvil), en la pantalla de resultado y en recorridos concretos. Objetivo del usuario: «todas las tools deben funcionar en todos los dispositivos y ser responsive 100 % Apple Design siguiendo ui-ux-pro-max». La pasada se hizo sobre una copia de `main` y la «medición después» se tomó con la última foto de los cambios COMPARTIDOS de W-RESP-B integrada (sin B, las filas «Compartido B» de las tablas siguen como estaban antes).

### Instrumento de medición
`responsive-audit.mjs` (el de la medición en producción) ampliado en una copia (`audit-a.mjs`, no se entrega: vive en el directorio de trabajo) con su mismo `probe` más: archivos Office sintéticos (docx/xlsx por zip) y PDF/PNG propios; modos `empty | loaded | options | result | special` (recorridos: Censurar con una caja dibujada y el efecto «Color», Organizar con una página girada, Quitar páginas con rango, Proteger con contraseña, Comparar / Extraer elementos / PDF a PDF/A / PDF a CSV / Excel); tema y idioma; tipografía ancha (DejaVu + 6 %) y fuente al 150 %; zonas de seguridad emuladas con `Emulation.setSafeAreaInsetsOverride` (iPhone con isla en vertical, muesca 59 px + indicador 21 px en apaisado); axe; WebKit; y tres hallazgos nuevos: `tight-gap` (objetivos vecinos a < 8 px), `ios-zoom-input` (campos de texto < 16 px: Safari amplía la página al enfocarlos) y `safe-area`. Una casilla/radio pequeño cuya **etiqueta** cubre una caja de 44 × 44 px, y un control con un **pseudo-elemento** absoluto de ≥ 44 × 44 (patrón `HIT_44` del repo), cuentan como objetivo de 44 px efectivo: se anotan aparte (`[hit44]`). La heurística del script original ya no da el falso positivo de «INPUT 22 × 22» de las casillas con etiqueta.

### Cifras antes / después (7 viewports: 320, 390, 430, iPad 834, iPad 1194, 1280, 1920 × 37 rutas = 259 pantallas por estado; claro, ES)
| Estado (pantallas) | Hallazgo | Antes | Después |
|---|---|---|---|
| **Vacío** (259) | cualquiera (desborde, objetivos, vecinos, texto cortado) | 0 | 0 |
| **Con archivo** (259) | desborde horizontal (`main-overflow`) | 1 | 0 |
| | objetivos < 44 px reales | 4 | 2 |
| | objetivos de 44 px solo «efectivos» (`::before`) | 67 | 0 |
| | vecinos a < 8 px | 141 | 25 |
| **Hoja «Opciones»** (111; 320, 390, 430) | desborde | 1 | 0 |
| | objetivos < 44 px reales / «efectivos» | 5 / 48 | 2 / 0 |
| | vecinos a < 8 px | 26 | 11 |
| **Resultado** (259; 140 llegan a «Descargar», 28 muestran el resultado en la propia página o un error esperado, 91 piden un paso previo) | objetivos < 44 px reales / «efectivos» | 38 / 35 | 32 / 0 |
| | vecinos a < 8 px | 82 | 23 |
| **Recorridos** (91) | objetivos < 44 px reales / «efectivos» | 3 / 49 | 0 / 2 |
| | vecinos a < 8 px | 30 | 0 |
| **Tipografía ancha** DejaVu + 6 % (111; 320, 390, 834) | desborde (el «1 texto cortado» de `edit-pdf` en antes y después es un `sr-only` con `min-w-10`: falso positivo) | 0 | 0 |
| | vecinos a < 8 px / «efectivos» | 82 / 37 | 17 / 0 |
| **Fuente al 150 %** (111; 320, 390, 834) | desborde en 834 (OCR y PDF a Markdown: «Portugués» se salía 8 px) | 2 | 0 |
| | desborde en 390 (solo `sign-pdf`, preexistente) | 1 | 1 |
| | desborde en 320 | 37 rutas | 37 rutas (ver «Límites») |

Lo que queda en «con archivo» (25 vecinos < 8 px + 2 objetivos): `pdf-pro` 12 (sin rehacer), `edit-pdf` 5 y los 2 objetivos (bloques de texto del PDF de 39 × 66 px: zonas de edición del tamaño del contenido, no controles) , Escáner 6 (a 320 px las tarjetas miden 138 px y sus tres botones de 44 px quedan a 3 px; a partir de 340 px ya hay 8) y 2 falsos positivos (contenido que pasa bajo la barra de «Procesar» pegajosa del iPad horizontal). Los «Cancelar 102 × 43» del estado «resultado» (~30 de los 32) son el botón del panel de progreso medido a mitad de su animación de salida (44 px en reposo).

Axe (`color-contrast`, nombres, roles/atributos, regiones con scroll sin teclado, `list`, `nested-interactive`…) sobre las 36 rutas con archivo cargado, **oscuro + EN**, a 320 / 834 / 1280 px (111 pantallas, con la integración de B): **0 violaciones**. El spec añade claro/oscuro × ES/EN a 393 px en las pantallas tocadas, también con la hoja «Opciones» abierta. (No se midió axe «antes» con este instrumento.)

WebKit (Playwright; `webkit` en iPhone 390 y iPad 834 / 1194, 13 rutas clave con archivo: Marca de agua, Comprimir, Unir, Organizar, Dividir, Censurar, Recortar, Imagen a PDF, Rotar, Comparar, PDF a Markdown, Escáner, Quitar páginas; 39 pantallas, con la integración de B): **0 hallazgos** (desborde, objetivos, vecinos, campos < 16 px).

### Pruebas
- **Spec E2E nuevo** `e2e/specs/responsive-resp-a.spec.ts` (+ helper `e2e/helpers/responsive-measure.ts`): 24 pruebas, headless, archivos sintéticos. Estado vacío de las 37 rutas a 320 / 393 / 834 / 1280 (desborde, texto cortado, objetivos); con archivo a 320 y 834 con tacto (objetivos ≥ 44 px, campos ≥ 16 px) y 1280; hoja «Opciones» a 393; tipografía ancha a 320 y fuente al 150 % a 393 y 834; las correcciones concretas (Dividir, lista de páginas, Censurar, Comparar, Markdown, separación de miniaturas); axe claro/oscuro × ES/EN a 393 en 9 pantallas (con la hoja «Opciones»); y APIs ausentes (`navigator.mediaDevices` en Escáner → mensaje y «Elegir fotos»; `navigator.gpu` en Resumir PDF → motivo explicado; `OffscreenCanvas` en Imagen a PDF / PDF a JPG / Extraer elementos sin error de página). Resultado con la foto de B integrada y servidor de desarrollo: **24 / 24** (17,4 min; una prueba se repitió tras corregir dos falsos positivos de la propia medición: `sr-only` con `min-w-10` y la barra de pestañas del Escáner con tipografía ancha). Los chequeos de color, casillas, segmentados y rejilla de posición **presuponen los cambios compartidos de W-RESP-B**.
- **Unitarias nuevas** (11): `organize-pdf/pageToolkit.fields.test.tsx` (teclado de texto, 16 px con el dedo), `compare-pdf/DiffColumn.test.tsx` (subrayado / tachado), `crop-pdf/cropMargins.test.ts` y `CropMarginFields.test.tsx` (márgenes sin arrastrar, ES/EN). Las de las carpetas tocadas y de `src/components` pasan con mi trabajo + la foto de B: 94 archivos / 1093 pruebas. `npx tsc --noEmit` y `npx eslint src e2e` sin errores (1 aviso preexistente de `inputChecks.clients.test.tsx`).

### Qué se corrigió (carpetas propias, en `unit-nodocs.patch`)
1. **Lista de páginas** (`organize-pdf/pageToolkit.tsx`, la usan Dividir / Quitar páginas / Extraer páginas): el campo era `inputmode="numeric"`, cuyo teclado de iOS **solo trae cifras, sin «-» ni «,»**: no se podía escribir «1-3, 5». Ahora `inputmode="text"` + sin autocorrección ni mayúsculas. Además los campos `NumberField`/`TextField` y la contraseña de Proteger PDF suben a **16 px con el dedo** (`pointer-coarse:text-base`): Safari ya no amplía la página al enfocarlos (con ratón siguen en 14 px).
2. **Miniaturas giradas** (`PageTile` de Rotar / Organizar / Dividir / Extraer / Quitar páginas y tarjetas del Escáner): una página girada 90°/270° se salía de su caja y se veía **cortada por los lados** (el giro no escalaba). Ahora cabe entera (la caja es contenedor de tamaño y la imagen sin girar se limita a `100cqh × 100cqw`); un navegador sin unidades de contenedor deja el estilo de siempre. La transición respeta `prefers-reduced-motion`.
3. **Acciones de miniatura con el dedo**: Organizar (girar / mover / insertar / quitar) a 8 px entre botones de 44 px (antes 2 px; en 165 px pasan a 2 + 2 + 1 filas); flechas de orden de Imagen a PDF a 8 px (antes 2); Escáner: 8 px entre la tarjeta y su fila de acciones, entre las fichas de calidad apiladas y entre Deshacer / Rehacer / Seleccionar (antes 4–5 px); Editar PDF: «Privacidad» / «Borrar datos» a 8 px entre zonas.
4. **Dividir PDF**: «Quitar este tramo» de 24 → 44 px con el dedo (24 px con ratón).
5. **Censurar PDF**: «Quitar esta zona» (cajas y trazos) con zona de toque de 44 px sin cambiar el dibujo; sin el menú de «Guardar imagen» de iOS al mantener pulsado sobre el lienzo (`-webkit-touch-callout: none`, también en Recortar).
6. **Recortar PDF**: alternativa **sin arrastrar** a los tiradores (WCAG 2.5.7, antes solo se podía arrastrar): cuatro campos de margen (% arriba / abajo / izquierda / derecha) en «Opciones» que mueven el mismo rectángulo, con teclado numérico, ES/EN y la pista bajo la vista previa.
7. **Comparar PDF**: lo insertado además va **subrayado** y lo eliminado **tachado** (antes lo insertado se distinguía solo por el color) y la leyenda muestra la muestra del estilo, no solo un punto de color.
8. **PDF a Markdown / Resumir PDF**: las regiones con scroll propio (vista previa del Markdown, detalle técnico del error) se alcanzan con Tab (`tabindex="0"`, `role="region"`, nombre) con foco visible; la vista previa nunca pasa de ~60 % de la pantalla (`dvh`).
9. **Nombres largos**: el nombre del archivo del resumen de Comprimir y del informe PDF/A, la vista previa de la numeración y el nombre de la imagen de marca de agua se **ajustan** (`overflow-wrap: anywhere`) en lugar de truncarse con puntos suspensivos.
10. **OCR de PDF / PDF a Markdown**: el selector de idioma pasa a otra fila (`wrap`) con letra grande: a 834 px con la fuente al 150 % «Portugués» se salía de la pantalla.

### Decisiones
- Lo que es de **patrón compartido** no se tocó en las carpetas propias: muestras de color y casillas ≥ 44 px, `SegmentedControl` de 44 px, `Sheet` en `dvh`, tarjeta de descarga y barras de `ToolShell` son de W-RESP-B (su foto, integrada, es la que explica `67 → 0` «efectivos» y gran parte de los vecinos).
- Objetivo de 44 px: cuando el dibujo debe ser menor (asas del recorte, quitar caja del censurado) se usa el `::before` transparente (`HIT_44_PSEUDO`, ya existente); cuando el control no tiene dibujo propio (quitar tramo, flechas de orden, acciones de miniatura) el **propio elemento** mide 44 px con `pointer-coarse:`, para que se mida y se toque lo mismo.
- 8 px entre vecinos solo con puntero grueso (`pointer-coarse:`): con ratón no cambia nada. Los segmentos de un mismo `tablist` cuentan como UN control (pista continua, patrón iOS) y no se exige separación entre ellos.
- Recortar: los márgenes viven en un componente nuevo (`CropMarginFields`) pintado SOLO por la herramienta suelta; `CropScopePanel` (que reutiliza PDF Pro) no cambia. Los márgenes que se leen son enteros; escribir uno solo mueve ese borde y conserva el contrario (≥ 5 % de página).
- No se añadió ninguna dependencia ni ninguna cadena fuera de `crop-pdf/strings.ts` (ES/EN).

### Cambios en compartidos (propuestas; NO están en `unit-nodocs.patch`, van en `shared-changes.patch`; aplicadas solo en mi copia para medir; no chocan con la foto de B: se aplicó con `git apply --3way`)
- `tool/PageThumbnailGrid.tsx` (rejilla de páginas de «Unir PDF»): acciones de 44 px separadas **8 px** entre sí y de la miniatura con el dedo (antes **0 px** entre ellas y 6 px con la miniatura: 45 hallazgos en 5 viewports) y la misma **corrección del giro** de las miniaturas (`100cqh × 100cqw`).
- `tool/OptionControls.tsx`: `NumberField` y `TextField` a **16 px con el dedo** (iOS ampliaba la página al enfocarlos) y `ChoiceGroup` (selector de fuente de la marca de agua) a 8 px entre opciones.
- `tool/PositionGrid.tsx`: 8 px entre celdas con el dedo (antes 6 px).
- **Hallazgos para W-RESP-B / W-NAV2 que NO se implementaron** (medidos en esta pasada): (1) a **320 px con la fuente al 150 %** todas las rutas desbordan 29 px: la fila «Archivos + Abrir en PDF Pro» de `ToolShell` no parte (`flex-wrap` en la fila y `wrap` en el enlace, `buttonClasses("ghost","sm","ml-auto", true)`), el botón «Opciones» de la barra fija mide 301 px en una fila de 288, el conmutador ES/EN de la cabecera y la barra de pestañas (`layout/*`) pasan de 320. (2) La barra «Procesar» **pegajosa** del panel de opciones (iPad / iPhone horizontal) no suma `env(safe-area-inset-bottom)` a su `padding-bottom` (iPhone apaisado: indicador de 21 px). (3) Los enlaces del pie, tras el cambio de B, empiezan 4 px antes del borde seguro en apaisado (zona de toque 55 px < 59 px de muesca). (4) Tarjeta de descarga (`DownloadScreen`) en un iPhone SE (320 × 568): el icono de 128 px, «Listo» y el texto ocupan toda la pantalla y **«Descargar» queda bajo el pliegue, detrás de la barra de pestañas**, aun con la foto de B; a 390 × 844 sí cabe. Propuesta: icono de ~80 px y menos margen con `max-height: 700px`, o «Descargar» fijo sobre la barra de pestañas como «Procesar».

### Límites
- **Censurar PDF** no tiene alternativa sin arrastre (la caja se dibuja arrastrando; el lápiz y la goma también) y su lienzo usa `touch-action: none`: un dedo sobre la vista previa no desplaza la página (se desplaza por los márgenes o con la barra de «Opciones»). Una vía por números/teclado (como la de Recortar) es el siguiente paso natural y no se hizo.
- **Editar PDF**: la barra de navegación (zoom / página) queda a 4 px entre grupos a 320–390 px y los bloques de texto del PDF miden 39–43 px de alto (zona de edición del contenido). Tiene specs móviles propios que ya fijaron este compromiso; no se tocó.
- **Escáner** a 320 px: las tarjetas miden 138 px (mínimo de 2 columnas) y sus tres botones de 44 px quedan a 3 px.
- Resumir PDF y Traducir PDF necesitan WebGPU / descargar un modelo: en Chromium headless Resumir muestra su mensaje honesto («no encuentra ninguna tarjeta gráfica») y Traducir no se pudo ejecutar; sus pantallas de resultado no se midieron.
- Edición con teclado virtual, anillo de foco con tecnología de apoyo y comportamiento real de safe-area solo se pueden emular (ver abajo).

### No verificado
- **iPhone / iPad reales**: WebKit se midió en la versión de Playwright (layout, sin códecs); Safari de iOS real (zoom al enfocar campos, teclado numérico/de texto, hoja de compartir, menú de mantener pulsado, `100dvh` con la barra de Safari, muesca / isla / indicador de inicio) y Firefox no se probaron en dispositivo. Las zonas de seguridad se emularon con CDP (muesca 59 px, indicador 21 px): no son las de un iPhone real.
- Teclado virtual sin tapar el campo activo (no se puede simular en headless); VoiceOver / TalkBack; fuente del sistema de iOS (Dynamic Type) y de Android: se simuló con `font-size: 150 %` y con la tipografía ancha (DejaVu).
- Resumir PDF y Traducir PDF con resultado; Desbloquear PDF con un PDF cifrado (hoja de contraseña); Editar PDF y Firmar PDF a fondo (tienen sus specs).
- La suite E2E completa y `next build` (política del plan): solo el spec propio con servidor de desarrollo.
- `pdf-pro` y `sign-pdf`: solo medidos (sin regresión visible: desborde 0 salvo `sign-pdf` a 390 px con la fuente al 150 %, que ya ocurría antes).

### Pruebas manuales (Mac / iPhone / iPad)
1. **iPhone SE (320), 15 (393) y Max (430), Safari y Chrome**: Dividir PDF → «Rangos» → añadir dos tramos y quitar uno con el dedo (la X debe tocarse sin fallar). **Quitar páginas → campo «Páginas a eliminar»**: el teclado trae «-» y «,» (poder escribir «1-3, 5»), y **al enfocar el campo la página no se amplía**; repetir en Proteger PDF (contraseña) y en las opciones de Numerar páginas / Marca de agua.
2. **Rotar PDF → 90° / 270°**: cada miniatura se ve entera (apaisada), no cortada. Organizar PDF: girar una página y comprobar que los botones de la miniatura no se tocan unos a otros (separados 8 px).
3. **Censurar PDF**: dibujar una caja con el dedo, pulsar su X (se quita la zona); mantener el dedo sobre la vista previa **no** abre «Guardar imagen». **Recortar PDF**: arrastrar los tiradores con el dedo y, sin arrastrar, escribir los márgenes en «Opciones» (el rectángulo de la vista previa sigue los números).
4. **Comparar PDF** con dos versiones: lo nuevo aparece subrayado y lo eliminado tachado; en modo claro, oscuro y con «Aumentar contraste».
5. **PDF a Markdown → «Generar vista previa»**: con teclado Bluetooth (Tab) se llega al cuadro de texto y se desplaza con las flechas; no ocupa más del 60 % de la pantalla en horizontal.
6. **Escáner**: tarjetas de página con 3–4 fotos en iPhone (320 y 393): rotar / borrar / más acciones separadas; mantener pulsada una tarjeta para reordenar.
7. **iPad vertical (834) y horizontal (1194)**: las mismas pantallas con la barra lateral; OCR y PDF a Markdown con letra grande (Ajustes → Pantalla y brillo → Tamaño del texto al máximo): el selector de idioma baja a una segunda fila.
8. **iPhone en horizontal (con muesca)**: una herramienta con archivo (p. ej. Marca de agua): ningún control debajo de la muesca ni del indicador de inicio; «Procesar» alcanzable al desplazar.
9. **Mac Safari / Chrome / Firefox**: ventana estrecha (~320 px) y ancha (1920 px); Tab recorre todo sin perder el foco; con **«Reducir movimiento»** activado, girar una miniatura no anima.
10. **Texto grande en iPhone**: el 150 % a 320 px (iPhone SE de 1.ª gen.) todavía desborda por la cabecera, la barra de pestañas y las barras de `ToolShell` (hallazgo para W-RESP-B / W-NAV2); a 393 px y en iPad cabe.


<!-- W-resp-b -->
## W-RESP-B · Responsive Apple Design: páginas, OptimusTOOLS y componentes compartidos

Pasada de auditoría y corrección de `/`, `/pricing`, `/settings`, `/documents`, `/recent`, `/about`, `/privacy`, `/downloader`, `/html-to-pdf`, `/image-converter`, `/video-converter` y de los componentes compartidos (`src/components/ui/*`, `src/components/tool/*`, `src/components/views/*`, `globals.css`, `Footer`). Criterio: HIG + `ui-ux-pro-max` (contraste 4,5:1, objetivos de 44 px con tacto y 8 px entre vecinos, safe-area, sin desborde de 320 a 1920 px, `rem` y no px fijos, `prefers-reduced-motion`, claro/oscuro, estado = texto + icono, foco visible, `dvh`).

### Medición (instrumento `responsive-audit.mjs`, Chromium headless, servidor de desarrollo, 11 rutas × 7 viewports = 77 combinaciones por pasada)

| Pasada (código base → corregido) | Hallazgos reales (77 combinaciones) | Desglose |
|---|---|---|
| Estado vacío (Chromium) | **9 → 0** | antes: texto cortado 1 (etiqueta del icono «Extraer audio de un video»), desborde horizontal 1 (`/pricing` a 320 px: 342 > 320), control fuera de pantalla 1 (consecuencia del anterior), desborde en `main` 1, objetivo < 44 px 5 (casilla de Ajustes de 22 × 22 con tacto, en los 5 viewports táctiles) |
| Con archivo (PDF/PNG/WEBM sintéticos; Chromium) | **9 → 0** | los mismos: ningún estado con archivo añadía otros que el instrumento vea |
| WebKit (motor de Playwright, 4 viewports táctiles; vacío 44 + con archivo 8) | **0** | solo diseño (en WebKit no hay códecs de video) |

«Hallazgos reales» = lo que queda tras quitar los falsos positivos ya conocidos del instrumento («Saltar al contenido», entradas `file` ocultas, insignias «Próximamente» solo para lector de pantalla, carruseles horizontales a propósito). Los datos crudos están en la carpeta de entrega (`audit-before-*.json`, `audit-after-*.json`, `audit-webkit-*.json`). El estado con archivo de `/html-to-pdf` (la pestaña «Archivo HTML») y los del resto no los alcanza el instrumento: los cubre la matriz E2E nueva.

La heurística del instrumento no ve todo: el resto salió de revisar capturas (ver «Qué se corrigió») y de la matriz E2E nueva.

### Qué se corrigió (patrón compartido primero, una vez)

| Dónde | Problema medido o visto | Corrección |
|---|---|---|
| `ui/Checkbox` | el `input` medía 22 × 22 (el área tocable era un `::after` que ninguna medición ve; 11 rutas) | la fila entera es ahora una `<label>` que envuelve caja y texto: el `input` vive dentro de una fila de ≥ 44 px, sin pseudo-elementos |
| `tool/OptionControls` · `ColorSwatches` | muestras de 36 × 36 con zona de 44 px solo por `::before`; 12 px de hueco con tacto | el propio botón mide 44 × 44 con tacto (el círculo de 36 px va dentro), hueco de 8 px entre cajas; el aro de forced-colors va en el `radio` elegido |
| `ui/SegmentedControl` `sm` | pista de 36 px (`redact-pdf`: Herramienta/Efecto) | `pointer-coarse:min-h-11`: los segmentos llenan la pista, 44 px reales |
| `tool/ToolIconTile` + `ToolCatalogGrid` | `line-clamp-2` escondía «video» de «Extraer audio de un video» e «imágenes» de «Convertidor de imágenes» a 320 px; `grid-cols-4` fijo (columnas de 66 px, «Convertidor» de 70 px) | etiqueta sin recorte (`text-balance`, sin guiones automáticos); columnas por ancho mínimo en `rem` (`auto-fill` con ancho mínimo de 4,75 rem: 3 a 320 px, 4 desde 360, menos con letra grande); icono con tope de 5 rem |
| chips de categoría (Inicio) | 4 px entre chips | 8 px |
| `views/PricingView` | desborde de 342 px a 320 (el botón «Todavía no está disponible» no parte y ensanchaba la rejilla); «Aún sin precio» + «no disponible» apretados | `wrap` en los botones, `min-w-0` en las tarjetas, precio con `flex-wrap` |
| `layout/Footer` | a 768 y 834 px y con la barra lateral (1194) los enlaces se partían con un «·» colgando y los derechos se partían; el separador «·» daba 3,12:1; desbordaba 51 px a 768 px con letra al 150 % + tipografía ancha (aviso de W-NAV2; ya no desborda, lo fija una prueba) | marca y derechos en la primera fila y enlaces en la segunda desde `md`; en móvil cuadrícula 3 + 3 por ancho mínimo en `rem`; sin separador de texto (los separa el espacio, 8 px); alto de 44 px |
| `ui/Sheet` | `max-h-[88vh]`; la trampa de foco tomaba el primer/último del DOM (una hoja que acaba en un `SegmentedControl` dejaba escapar el foco con Tab) | `max-h-[88vh] supports-[height:1dvh]:max-h-[88dvh]`; la trampa usa solo controles **tabulables** (`tabIndex ≥ 0`, no `disabled`, visibles, fuera de `inert`/`aria-hidden`, un tope por grupo de radios) y resuelve el salto también desde un control no tabulable. API pública intacta |
| `tool/FileDropzone` | «hasta 100 MB» fijo (imágenes: 64 MB, 32 MB en iPhone/iPad; video: 4 GB, 1 GB en móvil); el botón grande no partía («Seleccionar archivos» salía de la pantalla con letra al 150 %) | prop `maxBytes` (número redondo con espacio duro, `null` lo quita) y `dropzoneMaxBytes` en `ToolShell`; botón con `wrap` |
| `tool/DownloadScreen` | «Tu documento está preparado» también para un video o imágenes; solo `<a download>` | prop `subtitle` (y `ProcessResult.subtitle`); plan B móvil: «Compartir o guardar…» con `navigator.share({ files })` si hay puntero grueso y el navegador puede compartir ese archivo (cancelar no descarga; si el sistema la rechaza se descarga y se explica); botones con `wrap` y ancho mínimo acotado a la tarjeta |
| `tool/ToolHeader` (nuevo) | el título «Convertidor de imágenes» llegaba a 343 px a 320 con letra al 150 % | cabecera con `flex-wrap` y bloque de texto de base 12 rem: con letra grande el título baja bajo el icono; la usan `ToolShell` y el convertidor de video (A y MP3 pueden adoptarla: sus cabeceras tienen el mismo patrón) |
| `tool/ToolShell` y barra del convertidor de video | «Opciones» + «Procesar» no cabían a 320 px con letra al 150 % | `flex-wrap` y `wrap`: el segundo baja a su fila |
| `tool/ErrorBanner` | acciones sin `wrap` | `wrap` |
| `tool/FileList`, Recientes | nombre de archivo en una línea con «…» (se perdía la extensión) | hasta 2 líneas (`line-clamp-2`/`[overflow-wrap:anywhere]`) con `title`; en Recientes el nombre se parte y la insignia baja |
| `video-converter` | zona de carga con «hasta 100 MB»; tope «4,0 GB» que se partía en «4,0 / GB»; ficha del archivo en una columna aun a 390 px | `formatLimit` («4 GB» con espacio duro), 2 columnas por ancho mínimo, `subtitle` propio |
| `privacy` | enlaces de terceros de 20 px de alto en lista con viñeta «dentro» | renglones de 44 px, viñeta fuera |
| `globals.css` | sin `touch-action` en controles (doble toque = zoom) | `touch-action: manipulation` en la capa base (se puede seguir ampliando con pellizco) |

### Pruebas

- **Unitarias** (`vitest --project components`): `Sheet.focusTrap` (segmentado al final, no tabulables, dvh), `DownloadScreen.share` (con tacto/sin tacto, cancelar, rechazo, ES/EN, `subtitle`), `FileDropzone.maxBytes`, `formatLimit`; actualizadas las de `Checkbox`, `ColorSwatches`, `SegmentedControl sm` y forced-colors.
- **E2E** `e2e/specs/responsive-resp-b.spec.ts` (Chromium headless, sin red; `/api/html-snapshot` interceptado):
  matriz de 11 rutas × 7 viewports (claro/ES) y × 4 (oscuro/EN) con desborde, texto cortado, controles fuera de pantalla y objetivos ≥ 44 px con tacto; tipografía ancha (DejaVu + 6 %) y fuente al 150 %; estados de las tres herramientas (reposo, error, leída, lote, hoja de opciones, resultado, archivo malo) a 320/390/834/1194; axe WCAG 2 A/AA claro/oscuro ES/EN en las 11 rutas (pie incluido) y en los estados con archivo; patrones compartidos medidos en `/add-watermark`, `/add-page-numbers`, `/redact-pdf` y `/settings`; capacidades ausentes (`VideoEncoder`, `VideoDecoder`, `AudioEncoder`, `createImageBitmap`, `OffscreenCanvas`; HTML a PDF sin WebCodecs convierte); plan B de compartir; topes de la zona de carga; foco en hojas; `prefers-reduced-motion`; separación entre controles.
  Son 67 pruebas. Se comprobó que **fallan en la base**: contra el código sin cambios 36 están en rojo y 31 en verde (las verdes son los estados que ya estaban bien); con la corrección pasan las 67.

### Verificado (Chromium headless, servidor de desarrollo, datos sintéticos, sin red)

- `npx tsc --noEmit` limpio. `npx eslint src e2e`: 0 errores (un aviso anterior y ajeno en `inputChecks.clients.test.tsx`).
- `vitest --project components` (toda la suite de componentes): 319 archivos, 5518 pruebas verdes. `--project engines` sobre `src/components`, `src/lib/media` y las carpetas de las tres herramientas, Recientes y Privacidad: 354 verdes.
- `e2e/specs/responsive-resp-b.spec.ts`: 67 verdes. Las pruebas existentes de las tres herramientas (`image-converter`, `html-to-pdf-url`, `video-converter`): 53 verdes con los cambios compartidos.
- Con los cambios sin confirmar de W-NAV2 superpuestos en una copia aparte: `src/components/layout` + `src/components/ui` 236 verdes **con** `nav-test-followup.patch` (sin él falla 1: ver «Decisiones»); `e2e/specs/nav-mobile-menu.spec.ts` 36 verdes y `e2e/specs/nav-optimustools.spec.ts` 70 de 71 (el que falla es un `axe` de «todo desplegado» que agota los 120 s; agota igual **sin** este parche, es una flaqueza de ese entorno).
- `unit-nodocs.patch` aplica limpio sobre el árbol principal con los cambios sin confirmar de W-NAV2 y W-MP3 (`Footer.tsx` también lo toca W-MP3, una línea: el enlace «Licencias»; sin conflicto).
- Instrumento `responsive-audit.mjs` completo (tabla de arriba) en Chromium y, para diseño, en WebKit.

### Decisiones y límites

- El área tocable pasa a ser el elemento (no un pseudo-elemento) donde el instrumento la mide; `HIT_44` sigue existiendo para controles estrechos de otras pantallas.
- Se eliminó el separador «·» del pie en vez de subirle el contraste: un separador de texto se queda colgando al partirse la fila.
- Los ajustes de otras unidades que se detectaron y **no** se tocaron: la cabecera (conmutador ES/EN) y la barra de pestañas desbordan 2 px a 320 px con la letra al 150 % (52 y 79 px con tipografía ancha encima) y el alto de la barra de pestañas + la barra de acción de las herramientas en móvil horizontal bajo (667 × 375) ocupa ~ 36 % de la pantalla; ambos son de `src/components/layout/*`.
- `interactive-widget=resizes-content` en el `viewport` de `layout.tsx` (Chrome Android: que el teclado redimensione el contenido y las hojas no queden bajo él) queda como propuesta: `layout.tsx` no es de esta unidad.
- `MobileMenuSheet.test.tsx` (W-NAV2) fijaba el comportamiento antiguo de la trampa de foco; con la corrección Mayus+Tab desde el primero cae en el último control tabulable (la opción de tema elegida) y no en la opción con `tabindex="-1"`. Parche aparte `nav-test-followup.patch`.
- El resto de cabeceras `mb-8 flex items-start gap-4` (`compare-pdf`, `pdf-to-pdfa`, `pdf-pro`, `pdf-summarizer`, `audio-studio`, `AudioWorkFrame`) tiene el mismo problema con letra grande; basta cambiarlas por `ToolHeader`.

### NO verificado (lo hace una persona)

- Safari/WebKit de iPhone, iPad y Mac con el hardware real: solo Chromium (y el motor WebKit de Playwright para el diseño, ver abajo). Ni la hoja de compartir real de iOS, ni la web instalada en la pantalla de inicio, ni la muesca/isla dinámica/indicador de inicio reales, ni el teclado virtual (campo activo con una hoja abierta), ni VoiceOver.
- Firefox.
- La tipografía del sistema de iOS (Dynamic Type) y Android (tamaño de fuente): se simuló con `font-size: 150 %` en `html` y con la tipografía ancha.
- Rendimiento en un teléfono real de la rejilla de iconos y de las animaciones.
- `next build`, la suite completa.

### Pruebas manuales para el visto bueno (Mac, iPhone, iPad)

1. **iPhone SE / 15 / 15 Pro Max, vertical y horizontal**: Inicio, Precios, Ajustes, Recientes, Sobre nosotros, Privacidad, Downloader, HTML a PDF, Convertidor de imágenes y de video. Sin desplazamiento lateral, ningún texto cortado; los iconos de Inicio con sus nombres completos («Extraer audio de un video», «Convertidor de imágenes»); el pie con 3 + 3 enlaces.
2. **Letra grande**: Ajustes → Pantalla y brillo → Tamaño del texto al máximo (y «Texto en negrita»), y en Safari «aA → 150 %»: repetir 1 en Inicio, una herramienta con archivo, su resultado y un error. La cabecera de la herramienta debe bajar el título bajo el icono, los botones largos partirse en líneas, y las columnas de iconos bajar de 3 a 2.
3. **Dedo**: tocar el texto de una casilla de Ajustes (alterna), cada muestra de color de Marca de agua / Numerar páginas (sin tocar la de al lado), los segmentos de Tachar; todos de 44 px, sin fallos de dedo.
4. **Resultado de una conversión en iPhone** (imagen y video): «Descargar» guarda el archivo; «Compartir o guardar…» abre la hoja de compartir del sistema (Guardar en Archivos, AirDrop); cerrarla sin elegir no descarga nada. Repetir desde la web **añadida a la pantalla de inicio**: ahí es donde la descarga directa puede no funcionar y la hoja sí.
5. **Zona de carga**: «hasta 64 MB» (32 MB en iPhone/iPad) en Imágenes y «hasta 4 GB» (1 GB en iPhone/iPad) en Video; elegir un `.heic` y un `.mov`/`.m4a` desde la fototeca.
6. **iPad vertical (834) y horizontal (1194) y con Stage Manager/ventana estrecha**: Inicio, pie (marca + derechos arriba, enlaces debajo), hoja de opciones de una herramienta (Escape cierra y devuelve el foco), rejilla de Precios.
7. **Teclado virtual**: en HTML a PDF escribir una dirección larga y en Ajustes → Exportar la contraseña: el campo activo y su ayuda no quedan tapados por el teclado (con y sin la barra de pestañas).
8. **Tab con teclado externo** en una hoja que acaba en un segmentado (Ajustes → Exportar/Importar, opciones de HTML a PDF): el foco da la vuelta y no sale de la hoja.
9. **Claro y oscuro** en cada pantalla anterior; **Movimiento reducido** (Ajustes → Accesibilidad): los botones y la hoja solo funden.
10. **Safari, Chrome y Firefox de escritorio** en ventana de 320 px de ancho (Herramientas de desarrollo → modo responsive) y al 200 % de zoom del navegador.

