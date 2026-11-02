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
