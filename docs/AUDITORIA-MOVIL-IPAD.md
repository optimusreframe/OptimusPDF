# Auditoría UX/UI móvil y iPad — PDF Pro (`/pdf-pro`) y Firmar PDF (`/sign-pdf`)

Auditoría de solo lectura (no se modificó el proyecto). Se hizo sobre una COPIA aislada (`…/scratchpad/audit/copy`, build de producción en el puerto 3976) con Playwright headless, 1 trabajador, PDF sintéticos hechos con pdf-lib (1, 3, 12 y 60 páginas; vertical y apaisado; texto, imágenes y formulario). Criterios fundamentados con la skill `ui-ux-pro-max` (búsquedas `--domain ux`: touch spacing, touch target size, gesture conflicts, sticky navigation, viewport units, horizontal scroll, truncation, text reflow; reglas de `references/quick-reference.md` §1, 2, 5, 9 y `pro-rules.md`) y con `docs/COMPATIBILIDAD-NAVEGADORES.md`.

> Nota sobre la skill: la búsqueda `overscroll --domain ux` devolvió 0 resultados (sin coincidencia en la base) y `pinch zoom` / `zoom canvas` solo devolvieron coincidencias tangenciales. Para esos temas se usó la regla estática `gesture-conflicts`, `scroll-behavior`, `fixed-element-offset` y `touch-target-size` de `quick-reference.md` y se dice explícitamente donde es criterio propio.

- Informe: `docs/AUDITORIA-MOVIL-IPAD.md` (en la copia)
- Capturas: `…/scratchpad/audit/shots/` (≈1 090 PNG, nombre `<producto>-<flujo>-<dispositivo>-<tema>-<idioma>.png`)
- Scripts de medición/gestos: `…/scratchpad/audit/scripts/` (`survey.mjs` matriz completa, `t_*.mjs` pruebas de gestos), datos crudos: `…/scratchpad/audit/results/*.json`

---

## 0. Cómo se midió

| Qué | Detalle |
|---|---|
| Dispositivos (perfiles con `hasTouch`, `pointer: coarse` confirmado en ambos motores) | iPhone SE 320×568 (WebKit), iPhone SE 375×667 (WebKit), iPhone 15 Pro 393×852 (WebKit y Chromium), iPad mini 744×1133 (WebKit y Chromium), iPad Pro 11 834×1194 vertical y 1194×834 horizontal (WebKit y Chromium), tablet Android 800×1280 (Chromium), horizontales de poco alto 852×393 y 800×360 |
| Matriz estática (`survey.mjs`) | 12 perfiles × {claro/ES, oscuro/EN, claro/EN, oscuro/ES} = 48 recorridos; en cada estado: captura, tamaños de controles, `elementFromPoint` en el centro de cada control, desbordes, texto recortado, fuentes de input < 16 px, barras fijas/sticky, contenedores con scroll |
| Gestos reales | Solo Chromium (CDP `Input.dispatchTouchEvent`, pellizco de 2 dedos, `synthesizeScrollGesture`). En WebKit headless no se puede inyectar tacto real: allí se midió layout, desplazamiento programático y se repitieron los flujos con `touchscreen`/ratón (documentado en §5) |
| Safe-area | `Emulation.setSafeAreaInsetsOverride` (top 59 / bottom 34; y 0/21/59/59 en horizontal) |
| Teclado | Simulado: se mide el campo enfocado y se reduce el viewport en 336 px (comportamiento "resize" de Android); en iOS el teclado NO reduce el viewport de diseño (no verificable aquí) |
| Rendimiento | `PerformanceObserver` longtask, fps por rAF, CPU ×4 en CDP, 60 páginas |

Convención de severidad: **BLOQUEANTE** = la tarea no se puede hacer en ese dispositivo; **MAYOR** = se puede, pero con fricción o pérdida de contexto frecuente; **MENOR** = pulido.

---

## 1. Resumen: los 10 hallazgos que más pesan para un ajustador con iPad

| # | ID | Sev. | Qué | Dónde |
|---|---|---|---|---|
| 1 | SC-01 | MAYOR | Al pasar de paso en Firmar («Continuar», «2. Documento», «Listo, es mi turno») no se reinicia el scroll: se aterriza a mitad de página, con el traspaso «Pásale el dispositivo a Ana» y su botón por encima del borde | Firmar · varios firmantes · todos los dispositivos |
| 2 | ER-01 | MAYOR | Tras «Usar esta firma» la firma se coloca sola pero queda FUERA de pantalla (y, en móvil, bajo la paleta fija): no se ve el resultado de la acción principal | Firmar · «Solo yo» · iPhone, iPad vertical y horizontal |
| 3 | GE-01 | MAYOR | Con una herramienta armada (o zoom > 1) el dedo sobre la hoja no desplaza (`touch-action: none`): trampa de scroll. En Pro Editar/Anotar la hoja solo se ve a trozos | Firmar (lienzo) y Pro Editar/Anotar · todos |
| 4 | GE-02 | MAYOR | iPad Pro vertical (834 px) usa el layout de «escritorio» (≥ 768): la hoja de Firmar mide ≈ 295-370 px de 834 y el visor de Pro ≈ 330 px | Firmar y Pro · iPad Pro vertical, Android 800 |
| 5 | GE-03 | MAYOR | Reordenar páginas: el auto-desplazamiento va por fotograma (3 100 px/s a 120 Hz) y al soltar la lista salta a la parte superior | Pro · Páginas · móvil (probado) y con toda probabilidad iPad |
| 6 | VP-01 | BLOQUEANTE | Pro Editar/Anotar/Firmar: la hoja desaparece en móvil pequeño y en horizontal (0 px en SE 320; 124 px en SE 375; 13 px en iPhone horizontal) | Pro · iPhone SE, móviles apaisados |
| 7 | SC-02 | MAYOR | Firmar en móvil: paleta fija + barra «Opciones/Procesar» + tab bar = 194-272 px de pantalla permanentes, la paleta flota sobre texto que no es el lienzo y tapa el pie de la hoja y la firma | Firmar · < 768 px (iPhone, iPad mini 744) |
| 8 | VI-01 | MAYOR | El texto «Crea tu firma para poder colocarla…» queda en una columna de una palabra por línea y los botones se le superponen | Firmar y Pro · Firmar · iPhone, iPad mini, iPad Pro vertical (4 líneas) |
| 9 | SC-03 | MAYOR | iPhone horizontal: sin `safe-area-inset-left/right` con `viewport-fit=cover` → controles a 12-29 px del borde, bajo la isla/notch | Pro y Firmar · iPhone horizontal |
| 10 | SC-04 | MAYOR (iPhone) | Inputs de 12-14 px (campo de texto del lienzo 12 px, «Ir a la página» 13 px, buscador 14 px, contraseñas 14 px) → zoom automático de Safari al enfocarlos | Firmar y Pro · iPhone (y iPad con sitio móvil) |

---

## 2. Tabla índice (ordenada por impacto real en iPad)

| ID | Sev. | Prod. | Tema | Resumen | iPad | Teléfono |
|---|---|---|---|---|---|---|
| SC-01 | MAYOR | Firmar | Scroll | Cambio de paso no reinicia el scroll | alto | alto |
| ER-01 | MAYOR | Firmar | Ergonomía | La firma recién creada queda fuera de pantalla | alto | alto |
| GE-01 | MAYOR | Ambos | Gestos | Herramienta armada / zoom bloquean el scroll con el dedo | alto | alto |
| GE-02 | MAYOR | Ambos | Layout | iPad vertical con layout de escritorio: hoja pequeña | alto | n/a |
| GE-03 | MAYOR | Pro | Gestos | Reordenar páginas: auto-scroll por fotograma y salto al soltar | medio-alto | alto |
| GE-04 | MAYOR | Firmar | Layout | iPad horizontal: hoja ≈ 460 px de 1 194 | medio | n/a |
| VP-01 | BLOQUEANTE | Pro | Visual | Editar/Anotar/Firmar sin hoja en móvil pequeño/horizontal | nulo | bloqueante |
| SC-02 | MAYOR | Firmar | Scroll | 3 capas fijas en móvil (paleta + Opciones + tab bar) | solo iPad mini | alto |
| VI-01 | MAYOR | Ambos | Visual | Texto aplastado y solapado por botones | medio | alto |
| SC-03 | MAYOR | Ambos | Scroll | Sin safe-area lateral en horizontal | nulo | alto (horizontal) |
| SC-04 | MAYOR | Ambos | Scroll | Inputs < 16 px (zoom de Safari) | bajo | alto |
| ER-02 | MAYOR | Ambos | Ergonomía | Acciones primarias lejos del pulgar / al final de contenidos largos | medio | alto |
| ER-03 | MENOR | Firmar | Ergonomía | Muro de texto legal de ≈ 1 000 px la primera vez | medio | medio |
| GE-05 | MENOR | Pro | Gestos | Hoja «Páginas» en móvil: 1 fila visible, barra de acciones de 2 filas | nulo | medio |
| GE-06 | MENOR | Firmar | Gestos | Sin auto-scroll al arrastrar con zoom; pan limitado a ±400 px | bajo | bajo |
| SC-05 | MENOR | Pro | Gestos | Pellizco fuera del visor acerca TODA la página (hasta ×5) | bajo | medio |
| SC-06 | MENOR | Ambos | Gestos | Hoja de página: no se cierra deslizando desde el contenido | nulo | bajo |
| VI-02 | MENOR | Pro | Visual | «Reconocer texto (OCR)» truncado («Reco…» en 320 px) | bajo | medio |
| VI-03 | MENOR | Pro | Visual | Etiquetas del dock se tocan/solapan a 320 px | nulo | bajo |
| VI-04 | MENOR | Ambos | Visual | Paleta solapa la barra de zoom (375×667, iPad horizontal) | bajo | medio |
| VI-05 | MENOR | Ambos | Visual | Objetivos de 36-40 px y manijas de 12 px en layouts ≥ 768 (táctiles) | medio | bajo |
| VI-06 | MENOR | Ambos | Visual | Botones primarios deshabilitados a 2,0-2,6:1 («Procesar», «Aplicar») | bajo | bajo |
| VI-07 | MENOR | Ambos | Visual | Separación 0-4 px entre botones de 44 px contiguos | bajo | bajo |
| VI-08 | MENOR | Pro | Visual | Texto de ayuda de escritorio en táctil («Haz clic… Esc cancela») | bajo | bajo |

---

## 3. Hallazgos (detalle)

Cada hallazgo indica: **qué pasa**, **por qué molesta**, **regla** (ui-ux-pro-max), **causa probable** (archivo:línea de la COPIA, igual que el repo), **captura**, **repro** (número de la §6) y **arreglo**.

### 3.1 Desplazamiento (scroll)

#### SC-01 · MAYOR · Firmar · El cambio de paso no reinicia el scroll
- **Dónde / dispositivos:** Firmar «Varios firmantes», pasos 1 Firmantes → 2 Documento → 3 Firmar. Reproducido en los 8 perfiles probados (iPhone 15 Pro WebKit y Chromium, SE 375, iPad mini, iPad Pro vertical y horizontal en WebKit y Chromium, Android 800).
- **Qué pasa:** tras «Continuar» el navegador conserva la posición relativa y aterriza a 1 050-2 825 px de una página de 2 250-3 720 px (iPhone WebKit 2 654 de 3 620; SE 375 2 825 de 3 722; iPad horizontal 1 878 de 2 712) con el traspaso («Pásale el dispositivo a Ana» + «Listo, es mi turno») ENCIMA del borde: botón en y = −452 (iPhone WebKit −642, SE 375 −711, iPad horizontal −198, iPad mini −72). Lo que se ve es «Firmar y descargar» (deshabilitado), «Empezar la ronda de nuevo», «Atrás» o directamente el pie de la web. El foco va al botón del paso («3. Firmar») que queda por encima de la vista; el foco del encabezado usa `preventScroll`.
- **Por qué molesta:** el momento más delicado (pasar el iPad al cliente) parece haberse "roto". Además, el botón «Continuar» está al FINAL de un paso largo (≈ 270 px bajo la hoja; con aviso de privacidad abierto ≈ 2 200 px de scroll desde el paso).
- **Regla:** `back-stack-integrity`, `state-preservation`, `focus-on-route-change` (§9) y `fixed-element-offset` (§5).
- **Causa probable:** `src/app/sign-pdf/useCeremonyFocus.ts:26-28` (`focus({ preventScroll: true })`, "NO enfoca al montar") y ausencia de un `scrollIntoView` del contenedor del paso al cambiar en `SignToolClient.tsx` (el único `scrollIntoView` del flujo está dentro de `BlockCeremony.tsx:280` y `SigningCeremony.tsx:201`, y solo centra un bloque ya montado).
- **Capturas:** `stepscroll-after_Continuar_step_3_top_-iph15-wk.png`, `…-ipad11l-cr.png`, `…-ipad11p-cr.png`, `…-se375.png`, `…-android-tab.png`; antes: `stepscroll-before_Continuar_end_of_step_2_-iph15-wk.png`. **Repro:** R1.
- **Arreglo:** al cambiar de paso (`options.step`) y de etapa de la ceremonia, `stepRoot.scrollIntoView({ block: "start" })` con `scroll-margin-top` = alto de cabecera + barra sticky (≈ 112 px) y, solo entonces, enfocar el encabezado. Colocar «Continuar» en la barra fija inferior (sustituir «Procesar» deshabilitado en los pasos 1-2).

#### SC-02 · MAYOR · Firmar · Tres capas fijas en móvil
- **Dispositivos:** < 768 px (iPhone SE/15 Pro, iPad mini 744, mismo componente en Pro · Firmar). 
- **Qué pasa:** `ToolPalette` es `fixed` a `9.25rem` del borde inferior SIEMPRE (aunque el lienzo no esté en pantalla), encima de la barra «Opciones/Procesar» y de la tab bar global: 54 px (98 px con dos filas) + 68 px + 72 px (+34 px con home indicator) = 194-272 px; en 568 px de alto es el 34-48 %. Con la cabecera (56) y la barra de zoom sticky (54) quedan 304 px de cromo arriba+abajo: la hoja ve 548 px en 852 y solo 264 px en 568. La paleta flota sobre el texto de configuración ("Prepara el documento", teaser E-sign, tarjeta de privacidad) y cubre el pie de la hoja: la firma auto-colocada y su tirador de tamaño caen justo bajo la paleta.
- **Por qué molesta:** controles que no pertenecen a lo que se ve, texto ilegible por detrás, y la zona de la firma (pie de página) es la más tapada. Con la paleta de dos filas (varios firmantes) la fila 2 solo trae «siguiente campo».
- **Regla:** `fixed-element-offset`, `scroll-behavior`, «Scroll and fixed element coexistence» (pro-rules), `touch-density`.
- **Causa probable:** `src/app/sign-pdf/DocumentCanvas.tsx:2672` (`max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(9.25rem+env(safe-area-inset-bottom,0px))]`); barra «Opciones/Procesar» en `components/tool/ToolShell.tsx:1241-1244` (`fixed … md:hidden`, `bottom: calc(4.5rem + safe)`; puede crecer porque el motivo de «Procesar» deshabilitado se pinta dentro) y `components/layout/MobileTabBar.tsx:34-44`.
- **Capturas:** `sign-onedoc-top-iph15-cr-light-es.png`, `probe-sign-montage.png`, `sign-canvas-view-iph15-cr.png` (paleta sobre la firma), `sign-twodocs-iph15-cr-light-es.png`, `sign-multitab-se320-light-es.png`. **Repro:** R6, R7.
- **Arreglo:** hacer la paleta `sticky` dentro del contenedor del lienzo (como ya hace en md) o mostrarla solo con `IntersectionObserver` cuando el lienzo está a la vista; ocultar la tab bar global dentro de Firmar (la barra «Opciones/Procesar» ya es la navegación del flujo); reservar `padding-bottom` igual a la altura de las capas fijas.

#### SC-03 · MAYOR · Ambos · Sin safe-area lateral (iPhone horizontal)
- **Qué pasa:** `layout.tsx` declara `viewportFit: "cover"` pero en todo `src/` no hay ningún `safe-area-inset-left/right`. Con el override (left/right 59 px) los primeros controles quedan a 12-29 px: «Inicio» (Pro) en x = 12, paleta de Firmar en x = 26, «OptimusPDF» en x = 24, «Cerrar documento» en x = 792-836 de 852 (dentro de los 59 px del lado derecho).
- **Por qué molesta:** la isla/notch y las esquinas redondeadas tapan botones; un iPad no está afectado, un iPhone horizontal sí.
- **Regla:** `safe-area-awareness`, «Safe-area compliance» (pro-rules).
- **Causa:** ausencia total de `padding-inline: max(…, env(safe-area-inset-left/right))` en cabecera, `ProSuite` y `ProMobileDock`.
- **Captura:** `landinset-pro-iph15-land-cr.png`, `landinset-sign-iph15-land-cr.png` (la captura no pinta la isla; los números están en la salida de R12). **Repro:** R12. *No verificado en dispositivo real.*
- **Arreglo:** utilidad `px-[max(0.75rem,env(safe-area-inset-left))]` en `<header>`, raíz de `ProSuite`, dock y paletas.

#### SC-04 · MAYOR (iPhone) · Ambos · Inputs de menos de 16 px
- **Qué pasa:** campo de texto colocado sobre la hoja de Firmar: `font-size 12px` y 90×15 px; «Ir a la página» (Pro, 13 px); «Buscar herramienta…» (14 px, barra lateral iPad horizontal); campos de contraseña del panel Proteger (14 px); «Fuente»/«Tamaño en puntos» del editor (14 px).
- **Por qué molesta:** Safari de iPhone hace zoom a la página al enfocar un input < 16 px y no lo devuelve; en pleno flujo de firma rompe el encuadre. El campo de la hoja es además diminuto (15 px de alto).
- **Regla:** `readable-font-size` (min 16 px, evita el auto-zoom de iOS), `viewport-meta`.
- **Causa:** `DocumentCanvas.tsx:3614` (`text-xs`), `viewer/ViewerToolbar.tsx:141` (input `pro-page-input`), buscador de la barra lateral.
- **Captura:** `keyboard-sign-text-iph15-cr.png`. **Repro:** R11, R7 (`smallFont` en `survey-*.json`).
- **Arreglo:** 16 px mínimo en inputs reales (`text-base`); en el lienzo, escalar con `transform: scale()` un input de 16 px para que visualmente coincida con el tamaño del PDF.

#### SC-05 · MENOR · Pro · Pellizco fuera del visor acerca toda la página
- **Qué pasa:** dentro del visor el pellizco va a `setZoom` (visualViewport.scale se queda en 1: OK). Fuera (cabecera, barra de herramientas, dock) el navegador acerca toda la página hasta ×5; la barra y el dock se van fuera de pantalla.
- **Por qué molesta:** al fallar un pellizco por 20 px la interfaz desaparece; no hay botón de reset.
- **Regla:** `gesture-conflicts`, `standard-gestures`; contrapeso: accesibilidad (no deshabilitar zoom).
- **Causa:** `useViewerGestures.ts` solo gobierna el visor (`touch-action: pan-x pan-y` en `ProViewer.tsx:483`).
- **Captura:** `pro-pagepinch-iph15-cr.png`. **Repro:** R10 (Chromium; podría diferir en Safari real, donde el comportamiento de zoom de página es propio).
- **Arreglo:** `touch-action: pan-x pan-y` en la cabecera y el dock de la suite (no en el contenido) o un botón «Restablecer zoom» al detectar `visualViewport.scale > 1.05`.

#### SC-06 · MENOR · Ambos · La hoja (bottom sheet) no se cierra deslizando desde el contenido
- **Qué pasa:** arrastrar hacia abajo 300 px desde el contenido con `scrollTop = 0` no cierra; sí cierra desde el título o el asa. El scroll interno no encadena (`overscroll-behavior: contain` y `touch-action: pan-y` correctos) y los golpes de dedo rápidos no cierran por accidente.
- **Regla:** `modal-escape` (swipe-down to dismiss).
- **Causa:** `components/ui/Sheet.tsx:532` (`touch-action: pan-y` cuando hay scroll interno).
- **Repro:** R14. **Arreglo:** permitir el cierre por arrastre desde el contenido cuando `scrollTop === 0` y el gesto inicia hacia abajo.

### 3.2 Gestos (mover/editar con el dedo)

#### GE-01 · MAYOR · Ambos · Trampa de scroll con herramienta armada o zoom
- **Qué pasa (medido con arrastre táctil real, Chromium):**
  - Firmar, 1× y «Seleccionar»: arrastrar sobre la hoja desplaza la página (313 px: OK).
  - Con «Texto» o «Firma» armadas, o con zoom 1,5× o más: 0 px; solo desplaza una franja de 16 px a cada lado de la hoja (≈ 16 px; en iPad el margen lateral es mayor).
  - Pro Editar/Anotar, hoja de 497 px en una zona de 309 px (iPhone 15 Pro): con cualquier herramienta distinta de «Seleccionar» (texto, imagen, rectángulo, línea, resaltado) deslizar sobre la hoja = 0 px. En iPad vertical: hoja 1 030 px en zona de 814 px, mismo resultado.
- **Por qué molesta:** para ver la parte baja de la hoja (donde firman) hay que desarmar la herramienta, desplazar y volver a armarla (2 toques extra por desplazamiento). La herramienta armada no se desarma tras colocar un elemento.
- **Regla:** `gesture-conflicts`, `gesture-alternative`, `scroll-behavior`, «Gesture conflict prevention» (pro-rules).
- **Causa:** `DocumentCanvas.tsx:2698` (`effectiveTool === "select" && zoom === 1 ? "touch-pan-y" : "touch-none"`); `src/app/edit-pdf/EditWorkspace.tsx:1998-2001` (`armed ? touch-none`).
- **Capturas:** `sign-tool-armed-iph15-cr.png`, `sign-zoom2-iph15-cr.png`. **Repro:** R3, R5.
- **Arreglo:** desplazamiento con dos dedos siempre activo (dejar `touch-action: pan-y` y decidir en JS: 1 dedo dibuja solo con herramienta armada y con `touch-action` temporal tras long-press), botón «mano» persistente, y volver a «Seleccionar» tras colocar un elemento (con «mantener herramienta» por doble toque).

#### GE-02 · MAYOR · Ambos · iPad Pro vertical usa el layout de escritorio
- **Qué pasa:** `PRO_DESKTOP_QUERY = (min-width: 768px)`. A 834 px Pro muestra 3 columnas (miniaturas 176 + visor ≈ 330 + panel ≈ 330): la hoja se ve a ≈ 300 px y la pestaña «Páginas» muestra dos veces las mismas miniaturas (tira + cuadrícula). En Firmar la hoja mide ≈ 295-370 px de 834 (columna principal ≈ 430 + panel «Opciones» ≈ 320), con el texto del contrato ilegible y los huecos de firma de ≈ 120×35 px.
- **Por qué molesta:** el ajustador firma contratos con el iPad en vertical; se desaprovecha el 55-65 % del ancho justo en la tarea de precisión.
- **Regla:** `adaptive-navigation`, `container-width`, «Adaptive gutters by breakpoint».
- **Causa:** `src/app/pdf-pro/shell/useIsDesktop.ts:6` (768) y `proLayout.ts` (`MIN_VIEWER_WIDTH = 320`); en Firmar el panel «Opciones» `md:` a la derecha.
- **Capturas:** `pro-tab-pages-ipad11p-cr-light-es.png`, `sign-canvas-ipad11p-light-es.png`, `sign-multi-4-placed-luis-ipad11p-cr-light-es.png`. **Repro:** R7, R15.
- **Arreglo:** usar el layout "móvil" (hojas + dock) hasta ≈ 1 024 px en vertical, o plegar miniaturas/panel por defecto cuando el visor < 480 px; en Firmar mover «Opciones» a una hoja bajo `lg`.

#### GE-03 · MAYOR · Pro · Reordenar páginas: auto-scroll por fotograma y salto al soltar
- **Qué pasa (Chromium táctil, 60 páginas, arrastre desde el asa de 44 px):**
  - Auto-scroll: 3 100 px/s con el dedo a 8 px del borde y 1 450 px/s a 40 px (fotogramas a 120 Hz); una fila mide 262 px. En un iPad (ProMotion 120 Hz) es el doble que en 60 Hz.
  - Al soltar tras haberse desplazado (4/4 repeticiones) el listado vuelve a `scrollTop = 0`: la página movida (p. ej. a la posición 13 o 53) queda fuera de vista y el usuario pierde su sitio. Sin auto-scroll (movimiento corto) el scroll se conserva.
  - Soltar fuera del listado (sobre la cabecera) cancela y deja el orden como estaba (correcto; solo cambia la selección).
  - Lo que SÍ funciona: tocar selecciona/deselecciona, arrastre 1→2 correcto (resultado `[2,1,3,…]`), arrastrar desde el cuerpo de la tarjeta desplaza en vez de arrastrar, y las acciones del toolbar (girar/duplicar/mover/eliminar) conservan el scroll (±118 px de "reveal").
- **Por qué molesta:** mover una página a una posición lejana en un expediente de 60 hojas es impreciso (se pasa) y desorienta (se vuelve arriba).
- **Regla:** `drag-threshold`, `gesture-alternative` (hay botones «Mover antes/después», bien), `state-preservation`.
- **Causa:** `src/app/pdf-pro/pages/PageGrid.tsx:185-187` (`delta = Math.min(26, 4 + …)` por `requestAnimationFrame`, no por tiempo); el salto a 0 tras `onDrop` no tiene `revealIndex` posterior (`PageGrid.tsx:373-380`); la causa exacta del reinicio no se localizó con certeza (hipótesis: re-montado de la lista tras el plan escalonado).
- **Capturas:** `pages-autoscroll-edge8-iph15-cr.png`, `pages-drag-result-iph15-cr.png`. **Repro:** R4.
- **Arreglo:** velocidad en px/s (p. ej. rampa 0 → 700 px/s, independiente de los Hz) y, tras soltar, `revealIndex(destino)` + anuncio «Página movida a la posición N».

#### GE-04 · MAYOR · Firmar · iPad horizontal: hoja ≈ 460 px de 1 194
- **Qué pasa:** barra lateral global (≈ 262) + columna del documento (≈ 560, hoja ≈ 460) + panel «Opciones» (≈ 330). En Pro: barra lateral + miniaturas + visor ≈ 400 px + panel.
- **Regla/Causa:** igual que GE-02; la barra lateral global (`Sidebar.tsx:163`) y `proLayout.ts` no se pliegan al entrar en un documento.
- **Captura:** `sign-canvas-ipad11l-cr-light-es.png`, `pro-tab-home-ipad11l-cr-light-es.png`. **Arreglo:** colapsar la barra lateral global por defecto dentro de Pro/Firmar y ampliar el máximo de hoja (`max-w-[640px]` en `DocumentCanvas.tsx:2694`).

#### GE-05 · MENOR · Pro · Hoja «Páginas» en móvil
- Cuadrícula de 2 columnas con tarjetas de 157×250: solo una fila visible (299 px de 852: la hoja es de 634 px y se come 178 px arriba y 150 px abajo; «Aplicar cambios» en la parte alta, barra de acciones en 2 filas con «Más» sola). El asa de arrastre (círculo oscuro de 28 px con zona de 44) se pinta sobre el contenido de la miniatura. No se ve el destino de un arrastre en un documento largo.
- **Regla:** «Scroll and fixed element coexistence», `touch-density`. **Causa:** `ProSuite.tsx:798-815`, `pages/PagesTab.tsx:772`, `PageGrid.tsx:748`. **Captura:** `probe-pages60-iph15-cr.png`. **Arreglo:** 3 columnas con miniaturas de ≈ 100 px en móvil, «Aplicar cambios» en la barra inferior, asa en la esquina fuera de la hoja.

#### GE-06 · MENOR · Firmar · Zoom del lienzo
- Pellizco (1×–3×) y pan con un dedo funcionan y son suaves (Chromium táctil; pellizco 100 %→300 %→100 % correcto, sin zoom de página dentro de la hoja). Mover y redimensionar firmas es exacto 1:1 (Δ= −40/−50 px pedido, −40/−50 obtenido; tirador con zona de 44 px: `elementFromPoint` devuelve el tirador a 16 px del centro). Pendiente: no hay auto-scroll al arrastrar un elemento hacia el borde (probado, scroll = 0) y el pan está limitado a ±400 px (`PAN_LIMIT_PX`, `DocumentCanvas.tsx:215`).
- **Repro:** R3, R9.

### 3.3 Visual

#### VP-01 · BLOQUEANTE · Pro · Editar/Anotar/Firmar sin hoja en móvil pequeño y apaisado
- **Medido (altura de la zona "Zona de desplazamiento de la página" en Editar; en Firmar, píxeles de hoja visibles):**

| Dispositivo | Editar/Anotar | Firmar (hoja visible) |
|---|---|---|
| iPhone SE 320×568 | **0 px** (0 %) | **0 px** |
| iPhone SE 375×667 | 124 px (19 %) | 0 px |
| iPhone 15 Pro 393×852 | 309 px (36 %) | 51 px (6 %) |
| iPad mini 744×1133 | 643 px (57 %) | 650 px |
| iPad Pro vertical 834×1194 | 814 px (68 %) | 837 px |
| iPad Pro horizontal 1194×834 | 522 px (63 %) | 545 px |
| iPhone horizontal 852×393 | **13 px** (3 %) | 36 px |
| Móvil apaisado 800×360 (Chromium) | **0 px** | 3 px |

- **Qué pasa:** cabecera global (56) + cabecera del documento con tres filas (≈ 70) + barra «Editando/Descartar/Aplicar» (≈ 50) + barra del visor (≈ 60) + «Aplanar página»/aviso (≈ 40-60) + paleta de herramientas de 2 filas (≈ 100) + «Privacidad/Borrar datos» (≈ 44) + dock (57) dejan 0-309 px. En Firmar, además, el selector «Firmar documento/Rellenar formulario», «Solo yo/Varios firmantes», «Qué debes saber», la tarjeta de firma y la barra de zoom van ANTES de la hoja.
- **Por qué molesta:** en un iPhone SE no se puede editar ni firmar en Pro; en horizontal (≥ 768 px de ancho se aplica el layout de escritorio con 3 filas de pestañas) tampoco. Es la queja "es incómoda la movilización y edición" en su forma extrema.
- **Regla:** `scroll-behavior`/«Scroll and fixed element coexistence», `orientation-support`, `content-priority`.
- **Causa:** `ProSuite.tsx:531` (alto fijo `calc(100dvh − 3.75rem − safe)` con 6 bandas apiladas, ninguna plegable), `modes/ProEditorMode.tsx` + `edit-pdf/EditWorkspace.tsx` (paleta en 2 filas), `useIsDesktop.ts:6` (un móvil apaisado de 852 px ya es "escritorio").
- **Capturas:** `pro-tab-edit-se320-light-es.png`, `pro-tab-edit-se375-light-es.png`, `pro-tab-edit-iph15-land-wk-light-es.png`, `pro-tab-edit-land800x360-light-es.png`, `pro-tab-sign-iph15-cr-light-es.png`, `pro-tab-sign-se375-light-es.png`. **Repro:** R6.
- **Arreglo:** en < 480 px de ancho o < 520 px de alto: ocultar la cabecera global dentro de Pro (hoy ocupa 56 px por encima de un encabezado propio), una sola barra con título + Deshacer/Rehacer + Aplicar, paleta de una fila con scroll horizontal, mover «Privacidad/Borrar datos» al menú «Más», avisos plegados; el modo Firmar debe empezar por la hoja (opciones en hoja).

#### VI-01 · MAYOR · Ambos · Texto aplastado y solapado por botones
- **Qué pasa:** «Crea tu firma para poder colocarla sobre el documento.» se renderiza en una columna de ≈ 40 px (una palabra por línea, 9 líneas) y los botones «Crear firma» / «Firmas guardadas» se le superponen. Iguales píxeles en Firmar (iPhone, SE) y en Pro · Firmar (iPhone). iPad mini: una línea correcta; iPad Pro vertical: 4 líneas junto a los botones.
- **Por qué molesta:** estado vacío ilegible justo cuando falta crear la firma.
- **Regla:** `compact-label-overflow`, «Text Reflow and Spacing» (Critical).
- **Causa:** `DocumentCanvas.tsx:2263-2287`: `<p class="min-w-0 flex-1">` dentro de un contenedor `flex-wrap`; `flex-1` (`flex-basis: 0`) hace que el párrafo nunca pase a otra línea y se comprime hasta 0.
- **Capturas:** `probe-sign-montage.png`, `pro-tab-sign-iph15-cr-light-es.png`, `sign-canvas-ipad11p-light-es.png`. **Repro:** R7.
- **Arreglo:** `basis-full sm:basis-56` en el párrafo (o `w-full` en móvil) y `flex-col` bajo 480 px.

#### VI-02 · MENOR · Pro · «Reconocer texto (OCR)» truncado
- En «Inicio» de Pro el título lleva `truncate` y comparte fila con la etiqueta «Requiere conexión»: «Reconocer texto …» en 393 px y «Reco…» en 320 px; la descripción baja a una palabra por línea. `pdf-pro/tabs/DocumentTab.tsx:95`. Capturas: `ocr-trunc-iph15-cr.png`, `ocr-trunc-se320.png`. Repro: R9. Arreglo: la etiqueta pasa debajo del título (`flex-wrap`) o a un icono.

#### VI-03 · MENOR · Pro · Etiquetas del dock
- A 320 px: «Proteger» 48 px y «Convertir» 52 px en celdas de 45 px (EN: «Annotate» 51 px); sin margen entre etiquetas. A 375/393 caben justas (52/52). `ProMobileDock.tsx:70` (`text-caption-2`, `px-0.5`). Captura `dock-se320-es.png`. Repro: R8. Arreglo: dock con scroll horizontal explícito + fundido, o 5 elementos + «Más».

#### VI-04 · MENOR · Ambos · La paleta se solapa con la barra de zoom
- Pro · Firmar a 375×667 y Firmar con iPad horizontal desplazado al final: el botón «Texto»/«Seleccionar» queda bajo la barra «Zoom del documento» (`elementFromPoint` devuelve la barra). Capturas: `pro-tab-sign-se375-light-es.png`, `sign-bottom-ipad11l-cr-light-es.png`. Causa: dos capas `sticky/fixed` con `z-20`/`z-30` sin reserva (`DocumentCanvas.tsx:2538`, `:2672`). Arreglo: unificar en una sola barra superior.

#### VI-05 · MENOR · Ambos · Objetivos táctiles en layouts ≥ 768
- Con `pointer: coarse` y ≥ 768 px (iPad, Android 800): enlaces de la cabecera «Herramientas / Mis documentos / Precios / Proyecto» a 36 px de alto; elementos de la barra lateral global a 40 px (237-247 px de ancho); botones de la barra de «Páginas» en iPad mini a 36 px (Girar, Duplicar, Eliminar, Mover, Pares/Impares, Extraer…, 18 controles); «Importar configuración» 36 px, «Abrir en PDF Pro» 36 px, «Plantillas» 36 px, «Crear plantilla» 38 px (todos los móviles). Asas de redimensionado de paneles de Pro: 12 px de ancho y 1 025 px de alto (iPad), sin zona ampliada (`shell/ResizeHandle.tsx:99`, `touch-none … md:block`). Ninguno baja de 24 px salvo las asas de 12 px (WCAG 2.5.8 las exige ≥ 24 salvo alternativa: existe teclado/doble clic de reinicio).
- **Regla:** `touch-target-size` (44), `web-target-size` (24). **Arreglo:** `pointer-coarse:min-h-11` en cabecera, barra lateral y barra de «Páginas», y zona de toque ampliada (`before:-inset-x-3`) en las asas. Las cajas de verificación miden 22×22 pero su `<label>` (fila completa) es el objetivo: aceptable.

#### VI-06 · MENOR · Contraste en botones deshabilitados
- Barrido de contraste (texto vs primer fondo opaco, convertido a sRGB con canvas; 280 estados = iPhone SE 375 (WebKit), iPhone 15 Pro, iPad Pro vertical y horizontal × claro/oscuro × ES/EN; texto grande con umbral 3:1): 0 fallos en texto activo (≥ 4,5:1). No se midió contraste de iconos ni de bordes (no texto) ni texto sobre imágenes/degradados (se omiten). Solo fallan elementos deshabilitados (idénticos en EN): «Procesar» 2,55:1, «Aplicar»/«Aplicar cambios» 2,55:1, pestaña «3. Firmar» 1,83-2,0:1, «Quitar todo de esta página»/«Borrar todo el documento» ≈ 3,45:1. Los deshabilitados están exentos de WCAG 1.4.3, pero «Procesar»/«Aplicar» son la acción principal y se leen "lavados" (y por qué están deshabilitados se explica aparte). Regla: «Disabled state clarity». Arreglo: texto deshabilitado ≥ 3:1 y mensaje de qué falta junto al botón.

#### VI-07 · MENOR · Separación entre botones táctiles
- Botones de 44 px contiguos con 0-4 px de hueco: «Acercar / Ajustar al ancho» (0), «Página siguiente / Miniaturas» (0), «Alejar / Restablecer zoom / Acercar» (2), «Deshacer / Rehacer» (4), «Subir / Bajar» (0). Regla `touch-spacing` (8 px). Es MENOR porque cada objetivo cumple 44 px.

#### VI-08 · MENOR · Pro · Texto de ayuda de escritorio en táctil
- En Editar: «Haz clic o arrastra en la página para añadir un cuadro de texto. Esc cancela.» en un iPhone/iPad sin teclado. Y una tarjeta de 2 líneas que consume 60 px del poco espacio de la hoja. Captura `proedit-text-created-iph15-cr.png`.

### 3.4 Ergonomía y flujo

#### ER-01 · MAYOR · Firmar · La firma recién creada no se ve
- Tras «Usar esta firma» (modo «Solo yo») la firma se coloca sola (anuncio por región viva) pero la vista no se mueve: medido, la firma queda en y = 915-972 (iPhone, alto 852), 1 395-1 441 (iPad vertical, alto 1 194) y 1 388-1 402 (iPad horizontal, alto 834). En iPhone el composer es de pantalla completa y al cerrarse deja la página en la zona de configuración, con la hoja asomando 40 px.
- **Regla:** `state-preservation`, feedback inmediato (Forms & Feedback). **Causa:** `SignToolClient.tsx` (cierre del composer) sin `scrollIntoView` de la firma colocada (`soloSignaturePlaced` solo anuncia). **Capturas:** `sign-after-composer-iph15-cr.png`. **Repro:** R2.
- **Arreglo:** al cerrar el composer, desplazar la hoja con la firma al centro de la zona libre (entre barra sticky y paleta) y resaltarla 1 s.

#### ER-02 · MAYOR · Ambos · Acciones primarias lejos del pulgar o al final de contenidos largos
- «Continuar» (Firmar) está al final del paso (≈ 250-270 px debajo de la hoja y 1 200-2 200 px de scroll desde el selector de pasos, según si el aviso de privacidad está abierto); «Aplicar» y «Descartar» (Pro modos) y «Aplicar cambios» (Pro · Páginas) están ARRIBA de la pantalla; «Descargar» (Pro) está arriba a la derecha. «Procesar» (barra inferior) está deshabilitado y la acción real (Continuar) vive en el contenido. Pulgar: inferior = tab bar, Opciones/Procesar, paleta; superior = lo importante.
- **Regla:** alcance del pulgar (`touch-density`, `content-priority`). **Arreglo:** barra inferior contextual por paso (Atrás | Continuar), «Aplicar/Descartar» en la barra inferior en móvil.

#### ER-03 · MENOR · Firmar · Muro de texto la primera vez
- El aviso de privacidad se abre solo la primera vez (`PrivacyNotice.tsx:58`, `useState(() => !hasSeenNotice())`) y mide ≈ 1 000 px en el paso 2 en iPhone: el lienzo queda en 2 227 px absolutos (1 418 con el aviso cerrado). Captura `sign-fullpage-step2-iph15-cr.png`. Arreglo: abrirlo plegado en el primer uso y enlazarlo con una línea («Todo se queda en tu dispositivo · Más»).

#### ER-04 · Toques para tareas típicas (medidos con los scripts; "toque" = toque o gesto de arrastre)

| Tarea | Toques | Medido en |
|---|---|---|
| Firmar 1 PDF, «Solo yo», firma nueva | 5: subir (1) · «Crear firma» (1) · trazar (1) · «Usar esta firma» (1) · «Procesar» (1) + scroll para ver dónde quedó | R2 |
| Firmar 1 PDF, «Solo yo», firma guardada | ≈ 4: subir · «Firmas guardadas» · elegir · «Procesar» | por lectura de flujo |
| 1 PDF, 2 firmantes, sin plantilla, hasta la revisión del 1.º | 19 (subir, pestaña, 2× añadir, 2 nombres, «2. Documento», 2×(firmante+herramienta+arrastre), «Continuar», «Listo», «Crear», trazar, «Usar», «Ver cómo queda») | R15 |
| 2 PDF, 2 firmantes, sin plantilla, hasta la revisión del 1.º | 26 | R15 |
| Resto del 2.º firmante + descarga | ≈ +7 (Pasar, Listo, Crear, trazar, Usar, Ver cómo queda, Firmar y descargar) | estimado |
| Reordenar una página en Pro (móvil) | 4: «Páginas» (dock) · tocar tarjeta · «Mover después» ×N · «Aplicar cambios»; o 3 con arrastre + «Aplicar cambios» | R4 |
| Eliminar una página | 4: dock · tarjeta · «Eliminar» · «Aplicar cambios» | R4 |
| Editar un texto existente (Pro, móvil) | 5: dock «Editar» · tocar el texto · teclear · «Aplicar» · «Descargar» | R17 |
| Deshacer | 1 toque a 44 px en 2 sitios a la vez (cabecera y paleta): accesible, pero duplicado | R17 |

#### ER-05 · «Me quedé atascado» (resumen)
(1) Firmar, tras «Continuar», pantalla "vacía" (SC-01). (2) Herramienta armada y la hoja no desplaza (GE-01). (3) iPhone SE en Pro · Editar: no hay hoja (VP-01). (4) Soltar una página en la posición 53 y la lista vuelve al inicio (GE-03).

---

## 4. Lo que SÍ está bien (verificado)

- **Rendimiento con 60 páginas** (sintéticas de texto): primera imagen de página en 0,2-0,4 s incluso con CPU ×4; 118-120 fps (p95 10 ms) en scroll con gestos y en pellizco; cuadrícula de «Páginas» 108 fps; tareas largas: 3 al abrir (máx. 165 ms con CPU ×4), 0 durante el scroll; memoria JS ≈ 23 MB; el visor virtualiza (3-4 `<img>` vivas). Tras un salto de 6 000 px las páginas visibles ya tienen imagen a los 100 ms. (R13; una página escaneada pesada no se probó.)
- **Aislamiento del scroll:** sin scroll encadenado ni doble barra: el visor y las hojas usan `overscroll-behavior: contain`; el documento no se desplaza en Pro (altura `dvh`). 15 barridos largos seguidos en el visor (12 + 3 sobre el final) no mueven el documento ni encadenan (R10). `100dvh` en Pro (no `100vh`).
- **Safe-area superior/inferior:** con el override (59/34 px) la cabecera crece, el dock y la tab bar suman `env(safe-area-inset-bottom)` y la paleta de Firmar se desplaza (R12).
- **Sin desborde horizontal del documento** a 320-1 194 px en ninguno de los 48 recorridos (hay un `scrollX = 10` en WebKit 375 que parece artefacto del scrollbar clásico del navegador de pruebas; R19).
- **Pellizco y pan de la hoja de Firmar:** 1×–3× fluido, anclado al punto del pellizco, y mover/redimensionar firmas 1:1 con zona de toque de 44 px (aunque la bola visible es de 24 px). El visor de Pro también hace zoom con pellizco sin zoom de página dentro de la hoja.
- **Hojas (bottom sheets):** diseño correcto, cierre con X de 44 px, scroll interno sin encadenar, contenido con `padding-bottom` de safe-area; composer de firma a pantalla completa en móvil con «Usar esta firma» a 56 px (R14).
- **Controles de Pro en móvil:** dock de 7 botones de 55×56 px con icono + texto y teclas de flecha; toda la barra de herramientas, Deshacer/Rehacer, zoom y «Descartar/Aplicar» a 44 px.
- **Contraste** (texto activo ≥ 4,5:1) en claro/oscuro/ES/EN en los estados medidos; solo los deshabilitados quedan por debajo (VI-06). Sin recortes de texto en inglés salvo VI-02.
- **Teclado y accesibilidad de reordenar:** botones «Mover antes/después» además del arrastre; selección por toque sin modificadores.
- **Estado de carga/errores:** progreso y avisos con regiones vivas; la información legal es honesta («firma visual»).

---

## 5. Lo NO verificado (límites de esta auditoría)

- **Safari/iOS real:** rebote (rubber-band), barra de direcciones dinámica y su efecto en `dvh`, gestos nativos (swipe-back de borde, App Switcher, Control Center), comportamiento real del auto-zoom por input < 16 px, mantenimiento del foco al abrir el teclado, `visualViewport` con teclado real, Dynamic Island y safe-area horizontales reales (solo emulados con override CDP).
- **Gestos táctiles reales en WebKit:** Playwright no puede inyectar `Input.dispatchTouchEvent` en WebKit; los arrastres/pellizcos/auto-scroll se midieron en Chromium con perfil iOS. El layout y el scroll programático se verificaron también en WebKit (iPhone SE/15 Pro, iPad mini/Pro). Los hallazgos de gestos (GE-01, GE-03, SC-05) podrían variar en Safari.
- **Apple Pencil, 120 Hz real (ProMotion), memoria real de un iPad, térmica; teclado real con la barra predictiva; VoiceOver; multitarea de iPad (Split View/Slide Over, que cambian el ancho entre los umbrales de 768/1 024).**
- **Translucidez (`backdrop-filter`)**: en capturas de WebKit headless el contenido se ve nítido a través de las barras `material-thick` (alfa 0,88) y de las hojas; en Chromium se ve difuminado. Puede ser artefacto del renderizador sin GPU; en Safari real debería difuminarse.
- **PDF reales grandes/escaneados** (los de prueba son sintéticos y ligeros), plantillas de documento (se probó el flujo sin plantilla), Mis documentos con muchos elementos, exportación grande.
- **Firefox** (no soportado por el equipo de pruebas según `COMPATIBILIDAD-NAVEGADORES.md`).

---

## 6. Reproducción (scripts en `…/scratchpad/audit/scripts/`, servidor `CSP_SKIP_UPGRADE_INSECURE=1 npx next start -p 3976`)

Todos usan `lib.mjs` (perfiles y medición), `gestures.mjs` (CDP táctil) y PDF de `…/audit/fixtures/`. «Repetido N/N» = veces que el hallazgo se reprodujo.

| Nº | Script (perfil) | Qué comprueba | Repetido |
|---|---|---|---|
| R1 | `t_stepscroll.mjs <perfil>` y `t_stepscroll_seen.mjs` (iph15-cr, iph15-wk, se375, ipadmini-cr, ipad11p-cr, ipad11p, ipad11l-cr, android-tab) | scroll tras «2. Documento», «Continuar», «Listo, es mi turno»; con el aviso de privacidad cerrado y abierto | 10/10 |
| R2 | `t_placed.mjs` (iph15-cr, ipad11p-cr, ipad11l-cr), `t_sign1.mjs` | posición de la firma auto-colocada vs viewport | 3/3 |
| R3 | `t_sign6.mjs`, `t_sign4.mjs`, `t_sign7.mjs` (iph15-cr) | desplazar con herramienta armada/zoom; zoom, pellizco, pan; arrastre/redimensionado | 3/3 |
| R4 | `t_pages2.mjs`, `t_pages3.mjs`, `t_pages4.mjs`, `t_pages5.mjs`, `t_pages6.mjs` (iph15-cr) | selección táctil, arrastre por asa, auto-scroll (3 100/1 450 px/s), salto a 0, acciones con scroll conservado | 4/4 el salto, 2/2 la velocidad |
| R5 | `t_proscroll.mjs` (iph15-cr, ipad11p-cr) | scroll de la hoja de Editar por herramienta | 2/2 |
| R6 | `t_modespace.mjs`, `t_modespace2.mjs` (8 perfiles) | alto de la zona de hoja en Editar/Anotar/Firmar | 2/2 |
| R7 | `survey.mjs <perfil> <tema> <idioma>` + `runsurvey.sh` | matriz de 48 recorridos; `analyze.py tiny|small|overflow|clipped|smallFont|contrast|covered` | 48 |
| R8 | `t_dock.mjs` | etiquetas del dock vs celda (320/375/393, ES/EN) | 5 perfiles |
| R9 | `t_ocr.mjs` (iph15-cr, se320) | truncado de «Reconocer texto (OCR)» | 2/2 |
| R10 | `t_pro_viewer.mjs` (iph15-cr) | scroll del visor, pellizco dentro/fuera, aislamiento | 1 (+ coherente con R3) |
| R11 | `t_keyboard.mjs` (iph15-cr) | tamaño de fuente del campo del lienzo, pila de barras con "teclado" de 336 px | 1 |
| R12 | `t_safearea.mjs`, `t_landinset.mjs` | override de safe-area vertical y horizontal | 2 |
| R13 | `t_perf.mjs`, `t_perf2.mjs` (iph15-cr, CPU ×1 y ×4; iph15-wk) | fps, longtasks, tiempo a primera imagen | 3 |
| R14 | `t_sheet.mjs`, `t_sheet2.mjs`, `t_signsheets.mjs` | scroll y cierre de hojas | 2 |
| R15 | `t_multi.mjs <perfil> <1|2>` (iph15-cr, ipad11p-cr, ipad11p, ipad11l-cr, ipadmini-cr, android-tab, se375, iph15-wk) | flujo completo con 2 firmantes hasta la revisión; capturas por paso | 9 |
| R16 | `t_media.mjs` | `pointer: coarse`/`hover` por perfil | 5 |
| R17 | `t_proedit.mjs`, `t_proedit2.mjs` (iph15-cr, ipad11p-cr) | edición de texto, rectángulo, manijas (zona 44 px, punto de 10 px), mover, redimensionar | 3 |
| R18 | `t_home.mjs` | Inicio, Mis documentos, Recientes, Ajustes en 5 perfiles (sin desbordes; Ajustes con cajas de 22×22 dentro de etiquetas) | 20 páginas |
| R19 | `t_hscroll.mjs` (se375, se320) | `scrollX = 10` en WebKit 375 tras activar «Varios firmantes» (posible artefacto) | 2 |

### Posibles artefactos de la simulación
- `scrollX = 10` en WebKit 375×667 (R19): `visualViewport.width = 365` por el scrollbar clásico del WebKit de pruebas; no aparece en 320 ni 393.
- Texto visible a través de las barras `material-thick` en WebKit headless (ver §5).
- La velocidad de auto-scroll (3 100 px/s) se midió con rAF a 120 Hz en Chromium headless; el valor por fotograma (26 px) es el del código, así que a 60 Hz serán 1 560 px/s.
- Las alturas de Pro Editar se midieron con la hoja del PDF sintético (A4); un PDF muy apaisado deja más hueco.

---

## 7. Apéndice: criterios de ui-ux-pro-max usados

`touch-target-size`, `touch-spacing`, `gesture-conflicts`, `gesture-alternative`, `drag-threshold`, `safe-area-awareness`, `fixed-element-offset`, `scroll-behavior`, `viewport-units`, `readable-font-size`, `horizontal-scroll`, `orientation-support`, `compact-label-overflow`, `state-preservation`, `back-stack-integrity`, `focus-on-route-change`, `modal-escape`, `adaptive-navigation`, `web-target-size` (24 px WCAG 2.5.8), `color-contrast`; «Safe-area compliance», «Scroll and fixed element coexistence», «Gesture conflict prevention» y «Disabled state clarity» de `pro-rules.md`. Búsquedas ejecutadas: `touch target spacing`, `scroll nested container`, `bottom bar safe area` (1 resultado, off-topic: Focus Appearance → se usó la regla estática), `drag gesture conflict scroll`, `keyboard overlay viewport`, `pinch zoom` (tangencial), `overscroll` (0 resultados), `sticky header content clipped`, `scroll chaining`, `drag handle resize target`, `zoom canvas`.
