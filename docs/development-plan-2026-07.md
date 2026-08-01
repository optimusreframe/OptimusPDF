# Plan de desarrollo: conversión Office↔PDF + expansión de funcionalidades (2026-07-30)

**Este archivo es el punto de partida para la próxima sesión.** Contiene una decisión ya tomada (con evidencia verificada) sobre cómo resolver las 6 herramientas de conversión Office↔PDF sin costo y sin licencias copyleft, más la categorización completa de la lista extendida de funcionalidades de BentoPDF que el usuario pidió revisar, organizada en fases de implementación listas para ejecutar con el mismo método usado en el resto de este repo (exploración → plan cerrado → agentes Sonnet 5 → revisión de Codex donde aplique → verificación en vivo).

## Estado — Fase A (2026-08-01, CERRADA)

**Las 6 herramientas de Fase A están implementadas, validadas y en producción**, construidas una por una en secuencia (a pedido explícito del usuario, no en paralelo como Fase 2) — cada una implementada, revisada y validada en verde antes de arrancar la siguiente: `protect-pdf` extendido con permisos granulares, `pdf-to-text`, `pdfs-to-zip`, `pdf-to-csv`, `pdf-to-json`, y `organize-pdf` extendido con páginas en blanco. Suite final: 888 tests (47 archivos), `tsc`/`eslint`/`build` limpios.

**Cambio de metodología de esta fase**: por instrucción explícita del usuario, se dejó de usar Codex CLI para revisión adversarial — reemplazado por agentes en modelo Opus (`ox-architect`) para los mismos roles (revisión de plan antes de implementar cambios significativos, revisión de diff después). Funcionó igual de bien o mejor: en ambos workstreams que pasaron por este gate (A1 y A6), el revisor Opus no solo leyó código — **ejecutó experimentos reales contra las librerías del proyecto** (`@cantoo/pdf-lib`) para verificar sus propias afirmaciones antes de reportarlas, encontrando hallazgos reales y reproducidos, no solo teóricos.

**A1 — Change Permissions**: la revisión de arquitectura (antes de implementar) encontró que mi diseño inicial (`permissions?: Partial<SecurityOptions["permissions"]>` con spread) tenía una trampa real: `printing` es tri-estado no booleano, y el merge shallow de `ToolShell` rompería un objeto de permisos anidado. Rediseño a campos planos opcionales resolvió ambos. La revisión de diff (después de implementar) encontró que el aviso sobre PDFs "legacy" tenía el rango de versiones mal (decía "1.3 o anterior" cuando en realidad es cualquier versión fuera de 1.4-1.7, incluido el PDF 2.0 vigente) y minimizaba la consecuencia real (cifrado RC4 de 40 bits, no solo "dos permisos ausentes") — corregido, junto con mover la detección de revisión de cifrado de una relectura post-cifrado (cara, con un `null` de fallo que se leía como "todo bien") a una predicción pre-cifrado desde la cabecera del PDF (barata, sin ese hueco de ambigüedad).

**A6 — Add/Remove Blank Pages**: el cambio más delicado de la fase (nuevo tipo unión discriminada en `organize.ts`, motor ya en producción). La revisión de arquitectura rechazó mi alternativa más simple (`page: number | null`) tras verificar que el filtro existente (`Number.isInteger`) descartaría un `null` en silencio — recomendó unión discriminada con `kind`, consistente con el patrón ya establecido en el repo (`SplitPlan`, `RedactElement`, `DocBlock`). También encontró 3 defectos de implementación antes de escribir código: `getSize()` de la librería ignora `/Rotate` (una página en blanco heredaría el tamaño equivocado junto a un escaneo apaisado), `addPage()` exige una tupla `[width,height]` no un objeto (confirmado con el `TypeError` real de la librería), y el denominador de progreso da `Infinity` en un plan todo-blancos. La revisión de diff (después de implementar) encontró un bug real de pérdida de datos no anticipado por el diseño: el contador de IDs de páginas en blanco vivía en un `useRef` que se resetea cuando `ToolShell` desmonta el tablero (al cancelar o si el motor falla) — el siguiente blanco insertado recibía un id duplicado, y borrar CUALQUIERA de los dos con ese id borraba AMBOS de un clic. Corregido derivando el id del propio plan en vez de un contador efímero. También encontró (con aritmética real de CSS, luego confirmada en navegador real a 375px) que la barra de acciones de 5 botones se recortaba contra el `overflow-hidden` de la tarjeta — corregido con una variante compacta de los mismos componentes compartidos, sin afectar a los otros 6 llamadores de `TileButton`/`PageTile` en el resto del repo.

**Patrón reutilizable de esta fase**: el límite de "2 rondas" de revisión adversarial (heredado del protocolo con Codex) es un límite al *costo de coordinación*, no una licencia para dejar un hallazgo bien entendido sin cerrar — cuando una tercera ronda de revisión externa no era necesaria porque el hallazgo ya estaba precisamente identificado con línea y causa raíz, se corrigió directamente y se revalidó, sin gastar otra ronda completa.

**Verificación Tier 3 real** (Chrome real, mismo PDF fixture reutilizado de la fase anterior): confirmado en vivo que el fix del hallazgo de la barra de 5 botones funciona (166px → 134px, dentro de los 165.5px de la tarjeta a 375px de viewport) y que el flujo completo de insertar una página en blanco + procesar + descargar funciona sin errores de consola, con el resumen honesto ("2 páginas en el documento final (1 de 1 originales, 1 en blanco)") reflejando correctamente el nuevo caso.

## Plan — Fase A (2026-08-01, pendiente de aprobación, no implementado todavía)

**Cambio de metodología a partir de aquí**: por instrucción explícita del usuario, se deja de usar Codex CLI para revisión adversarial. Se reemplaza por un agente en modelo Opus (`ox-architect` para revisión de arquitectura antes de implementar; un `Agent` en Opus para revisión de diff) en cada rol que antes cubría Codex. La disciplina se mantiene igual (revisión antes de cambios significativos, evaluación independiente de los hallazgos, ciclo de máximo 2 rondas) — solo cambia el ejecutor.

**Aclaración de una ambigüedad real del texto original del plan**: la fila "Extract PDF Tables / PDF to CSV" dice *"exponer como exportación a CSV/JSON además de Markdown, en una sola herramienta con selector de formato de salida"*, lo cual admite dos lecturas: (a) agregar CSV/JSON como formatos de salida dentro de la herramienta `pdf-to-markdown` ya existente, o (b) una herramienta nueva y dedicada solo a tablas, con un selector CSV/JSON. Se elige (b): una herramienta nueva "solo tablas" es más coherente (§14.1 de la skill — no fragmenta una misma herramienta en dos alcances distintos según el formato elegido) y replica exactamente el patrón ya probado de `pdf-to-excel` (filtrar bloques `type: "table"` de `extractDocumentBlocks`, solo cambia el formato de serialización). Si la intención real era (a), es fácil de corregir antes de implementar — decisión de bajo riesgo y reversible, no bloquea el plan.

### Workstream A1 — Change Permissions (extiende `protect-pdf`, no una herramienta nueva)
`src/lib/pdf/protect.ts` hoy SIEMPRE cifra con `userPassword = ownerPassword = options.password` y `permissions: FULL_PERMISSIONS` fijo — no hay forma de restringir permisos sin también exigir contraseña de apertura, ni de pasar permisos parciales (`ProtectOptions` solo tiene `{password, confirm}`, confirmado leyendo el motor). El caso de uso real de "Change Permissions" (dejar abrir el PDF libremente pero restringir impresión/copia/edición) requiere `userPassword: ""` + `ownerPassword` (requerido, para poder hacer cumplir y luego cambiar los permisos) — un modo genuinamente distinto del actual "pedir contraseña para abrir".
- Extender `ProtectOptions` con `requirePasswordToOpen: boolean` (default `true`, preserva el comportamiento actual) y `permissions?: Partial<SecurityOptions["permissions"]>` (se mezcla sobre `FULL_PERMISSIONS`, nunca reemplaza sin querer — el comentario existente en el código ya advierte por qué: permisos no especificados se ponen a cero en la librería).
- UI: agregar a `src/app/protect-pdf/` una sección de checkboxes de permisos (imprimir/copiar/modificar/anotar/rellenar formularios/ensamblar documento) y un toggle "requiere contraseña para abrir" — visible siempre, no una pantalla separada.
- Sin herramienta nueva en `tools-registry.ts` — mismo slug `protect-pdf`, evita fragmentar una sola capacidad (cifrado+permisos) en dos entradas del catálogo.
- Riesgo: BAJO-MEDIO. Toca un motor de seguridad ya en producción (categoría "security" — sensible per §12.1 de la skill) → **requiere revisión de Opus antes de implementar**, no solo revisión de diff después.

### Workstream A2 — PDF to Text (herramienta nueva, independiente)
`src/lib/pdf/pdfToText.ts` nuevo: reutiliza `buildLines` (función pura ya exportada de `pdfToMarkdown.ts`) + `extractMarkdownPages` (capa navegador ya exportada) — NO pasa por las heurísticas de título/lista/tabla/código (eso produciría Markdown, no texto plano). Solo une `line.text` con saltos de línea, página por página, con el mismo fallback de OCR (`ocrFallback`) ya disponible en `PdfToMarkdownOptions`. Salida `.txt`.
- UI/registry nuevos: `pdf-to-text`, icono candidato `FileText` (ya importado) o similar.
- Riesgo: BAJO. Sin motor nuevo real, solo composición de piezas ya probadas.

### Workstream A3 — PDFs to ZIP (herramienta nueva, independiente)
`src/lib/pdf/pdfsToZip.ts` nuevo: empaqueta N archivos PDF SIN re-parsear ni fusionar contenido (distinto de `merge-pdf`, que sí combina el contenido en un solo documento) — mismo patrón `jszip` que ya usa `pdfToImages.ts` para empaquetar imágenes.
- UI/registry nuevos: `pdfs-to-zip`, `multiple: true`, icono nuevo candidato `Archive` (confirmar que existe en `lucide-react`, si no usar `FolderArchive` o similar).
- Riesgo: BAJO. Trivial, sin parsing de PDF real.

### Workstream A4 — Extract Tables → CSV/JSON (herramienta nueva, toca `pdfToExcel.ts` de forma mínima)
`src/lib/pdf/pdfToCsv.ts` nuevo, mismo patrón que `pdfToExcel.ts` (filtrar `DocBlock` tipo `table`, mismos presupuestos `MAX_TABLE_CELLS`/`MAX_TABLES_PER_DOCUMENT`/`MAX_CELL_CHARS`) pero serializando a CSV (formato principal) con JSON como alternativa en el mismo selector. Para no duplicar la lógica de filtrado+presupuesto ya escrita y probada en `pdfToExcel.ts`, se extrae a un helper compartido (p.ej. `extractTableBlocks(blocks): string[][][]`, exportado desde `pdfToExcel.ts` o promovido a un archivo pequeño nuevo) que ambos motores llaman — consolidación mecánica, sin cambiar comportamiento de `pdf-to-excel` (gate de regresión: sus tests existentes deben seguir en verde exactamente igual).
- UI/registry nuevos: `pdf-to-csv`, reutiliza icono `Table` o `FileSpreadsheet` (ya importados).
- Riesgo: BAJO. El único punto de atención es no romper `pdf-to-excel` al extraer el helper — validable con su propia suite de tests ya existente.

### Workstream A5 — PDF to JSON (herramienta nueva, la más barata de las 6)
El plan original proponía construir esto sobre `page.getTextContent()`/`getOperatorList()` de pdf.js directamente — pero desde la fase anterior ya existe algo mejor: `extractDocumentBlocks` devuelve `DocBlock[]`, una representación estructurada del documento completo (títulos/párrafos/listas/tablas/código), ya probada y en producción. Usar eso como base de "PDF to JSON" es más simple y más útil que un volcado de bajo nivel de pdf.js sin ningún otro consumidor en el repo (evita una abstracción nueva y paralela sin justificación — §14.4). `src/lib/pdf/pdfToJson.ts` nuevo: `JSON.stringify(await extractDocumentBlocks(file, options))` con formato legible.
- Distinto en alcance de A4: A4 exporta SOLO las tablas: A5 exporta el documento COMPLETO estructurado.
- UI/registry nuevos: `pdf-to-json`, icono nuevo candidato `Braces` o `FileJson` (confirmar en `lucide-react`).
- Riesgo: MUY BAJO. Es casi un serializador directo de algo que ya existe.

### Workstream A6 — Add/Remove Blank Pages (extiende `organize.ts`, cambio significativo — gate de revisión antes de implementar)
`organize.ts` hoy modela cada entrada como `{page: number, rotation: number}` — una referencia a una página FÍSICA existente del PDF de origen. Insertar una página en blanco requiere una forma nueva de representar "esto no es una página del original, es una página nueva vacía" — ej. un tipo unión discriminado (`{kind: "existing", page, rotation} | {kind: "blank"}`), que `organizePdf` debe interpretar llamando `document.addPage([width, height])` (API que YA se usa en `crop.test.ts` pero nunca en `organize.ts`) con el tamaño heredado de una página vecina.
- Esto es el único cambio "significativo" (§14 de la skill) de esta fase: nueva forma en un tipo de datos de un motor ya compartido y probado. **Requiere revisión de arquitectura de un agente Opus ANTES de implementar** (mismo gate que tuvo el refactor de `pdfToMarkdown.ts` en la fase anterior), con foco en: ¿el tipo unión rompe algún consumidor existente de `OrganizePage`? ¿Qué pasa si se insertan blancos consecutivos, o al principio/final del documento? ¿De qué página vecina se hereda el tamaño si el blanco va primero y no hay una anterior?
- UI: extender el componente de miniaturas de páginas de `organize-pdf` (ya soporta reordenar/rotar/eliminar) con una acción "insertar página en blanco" entre dos miniaturas.
- Riesgo: MEDIO. Es el más delicado de los 6, por eso lleva gate previo.

### Independent Workstreams
A1, A2, A3, A4, A5 no comparten archivos entre sí y se pueden despachar en paralelo (A1 toca solo `protect.ts`/`protect-pdf`; A4 toca `pdfToExcel.ts` de forma mínima y aislada). A6 es independiente en archivos de las otras 5, pero bloqueado por su propio gate de revisión antes de empezar a construir.

### Delegation Map
- A1: revisión de Opus (`ox-architect`, toca seguridad) → `ox-builder` (sonnet).
- A2, A3, A5: `ox-builder` (sonnet) directo, bajo riesgo, sin gate previo.
- A4: `ox-builder` (sonnet) directo; su tocada a `pdfToExcel.ts` se valida con la suite existente de esa herramienta como gate de regresión.
- A6: revisión de Opus (`ox-architect`, cambio arquitectónico) ANTES de implementar → `ox-builder` (sonnet).
- Validación final: `ox-validator` (tsc/lint/tests/build) + revisión de diff en Opus para A1 y A6 (las dos que tocan seguridad/arquitectura) → verificación Tier 3 en navegador real con archivos reales, igual que las fases anteriores.

### Validación esperada
Cada herramienta nueva necesita al menos un test con un archivo real (reutilizar el patrón de fixtures ya establecido: generar PDFs sintéticos con los helpers de `pdfToMarkdown.test.ts`, o PDFs reales vía el pipeline `word-to-pdf` como se hizo en la verificación Tier 3 de la fase anterior). tsc/eslint/build limpios y suite completa en verde antes de marcar cualquier `status: "soon"` → `"live"` en `tools-registry.ts`.

## Estado — Fase 2 (2026-08-01)

**`pdf-to-word`, `pdf-to-excel` y `pdf-to-powerpoint` ya están implementados, corregidos tras dos rondas de revisión adversarial de Codex, y verificados en navegador real (Chrome) con un archivo `.docx` real construido con `docx` → convertido a PDF con `word-to-pdf` (ya en producción) → alimentado a las 3 herramientas nuevas.** `status: "live"` en `tools-registry.ts` para las tres.

**Decisión de arquitectura de esta fase**: `pdfToMarkdown.ts` (motor ya en producción) solo exponía Markdown ya renderizado, no un modelo de bloques reutilizable. Se refactorizó para separar la detección (heurísticas de título/lista/tabla/código, sin tocar) de la construcción del string final: nuevo tipo `DocBlock` (heading/paragraph/list/table/codeBlock/pageBreak) + `buildDocument`/`extractDocumentBlocks` (hermanas puras/navegador de `buildMarkdown`/`pdfToMarkdown`) + `renderBlockToMarkdown` como único renderer de Markdown. Verificado con un snapshot dorado byte a byte contra el `buildMarkdown` anterior al refactor — 0 regresión en el output ya en producción de `pdf-to-markdown`. `MAX_TABLE_CELLS` (antes duplicado en `excelToPdf.ts`/`wordToPdf.ts`) se consolidó en `core.ts`.

**Codex encontró hallazgos reales y reproducidos en 2 rondas de revisión** (patrón ya establecido en este repo: nunca aceptar "funciona" solo porque compila):
- Ronda 1 (6 hallazgos, veredicto NECESITA CAMBIOS): PowerPoint podía devolver un `.pptx` "exitoso" con diapositivas en blanco (canvas que excede el tamaño máximo del navegador → `toDataURL()` degenerado, sin validar); ningún motor tenía presupuesto real de memoria más allá de celdas de tabla; Word podía meter caracteres inválidos para XML 1.0 crudos en el documento; Excel truncaba celdas largas sin señal agregada; `noTablesFound` nunca se disparaba para el caso de PDF escaneado (`extractDocumentBlocks` lanzaba `"empty"` primero); filas de más de 16.384 columnas rompían `exceljs` con un error genérico.
- Ronda 2 (tras corregir los 6): confirmó 3 cerrados de verdad, pero encontró que el presupuesto de Excel seguía siendo insuficiente en el caso patológico, que `U+FFFE`/`U+FFFF` no se filtraban en Word, y **2 regresiones nuevas introducidas por los propios fixes de la ronda 1** (Word borraba `U+007F` DEL, que XML 1.0 sí permite; el truncado de Excel podía partir un par subrogado UTF-16 a la mitad, produciendo `U+FFFD` corrupto). Corregidos directamente (ronda 3, sin volver a consultar a Codex por ser fixes mecánicos ya verificados línea por línea contra la especificación XML 1.0 y el comportamiento real de `exceljs`) — patrón: el límite de 2 rondas de Codex no es licencia para dejar un hallazgo conocido y bien entendido sin cerrar, es un límite al *costo de coordinación adversarial*, no a la disciplina de cierre.

**Verificación Tier 3 real** (Chrome real vía `claude-in-chrome`, no solo Vitest): las 3 herramientas confirmadas funcionando de punta a punta con un PDF real generado por el propio pipeline `word-to-pdf` del repo. Hallazgos honestos, verificados en vivo, NO son regresiones de esta fase (comportamiento heredado sin cambios de `pdfToMarkdown.ts`, confirmado por el snapshot dorado):
- La negrita a nivel de párrafo en `pdf-to-word` solo se marca si TODAS las líneas que forman ese párrafo son bold — un párrafo con un fragmento en negrita rodeado de texto normal no se marca bold (mismo límite de granularidad que ya tenía `pdfToMarkdown.ts`, documentado en su propio comentario "LIMITE HONESTO").
- La detección de tablas de `pdf-to-excel` puede fusionar columnas angostas (números de pocos dígitos) y/o perder la fila de encabezado si su alineación de columnas no calza exactamente con las filas de datos — comportamiento de "mejor esfuerzo" ya documentado en `pdfToMarkdown.ts`, observado en vivo con una tabla real generada por `pdfmake` (columnas re-dimensionadas respecto al DOCX original).
- El PPTX de PowerPoint SÍ contiene la imagen real embebida (`<p:pic>` confirmado inspeccionando el XML del slide) — evidencia directa de que el fix del hallazgo de diapositivas en blanco de Codex funciona en un navegador real, no solo en el test mockeado.

Suite final: 825 tests pasando (43 archivos, 3 skips pre-existentes sin relación), `tsc`/`eslint`/`build` limpios.

`powerpoint-to-pdf` (la otra dirección) se queda en `"soon"` — no se tocó, ya se investigó en Fase 1 y la fidelidad no alcanzó.

## Estado — Fase 1 (2026-07-31)

**`word-to-pdf` y `excel-to-pdf` ya están implementados, corregidos tras una revisión adversarial dura, y verificados en navegador real con archivos reales.** `status: "live"` en `tools-registry.ts`. `powerpoint-to-pdf` se queda en `"soon"`: el spike acotado (con `@jvmr/pptx-to-html` y `pptxviewjs`, ambas MIT) mostró fidelidad insuficiente — pérdida de negrita/cursiva por-run y, en el caso de `pptxviewjs`, una diapositiva completa quedó en blanco por una imagen de fondo descartada en silencio.

Decisiones del dueño del producto que reabren el análisis de licencias de la Parte 1 de este documento: **AGPL no se descarta del todo** — se acepta una pila híbrida (permisiva ahora, investigar AGPL en paralelo solo donde la fidelidad permisiva resulte insuficiente, ej. `pdf-to-word`/`pdf-to-powerpoint` en Fase 2). Esto no cambió el alcance de Fase 1 (ya era permisiva), pero aplica a partir de Fase 2.

**Hallazgo importante para cualquier fase futura que use `pdfmake`** (primera vez que esta librería entra al repo): una revisión adversarial encontró y se corrigieron varios defectos de pérdida silenciosa de datos, no cosméticos — probados vacíos por los tests iniciales porque solo comprobaban "blob no vacío, pdf-lib puede releerlo":
- Roboto (única fuente que trae pdfmake) no dibuja CJK/árabe/hebreo/tailandés/la mayoría de emoji — sin comprobación, el texto desaparece sin error. Ahora se rechaza con `PdfError("unsupportedScript")` (`findUnsupportedGlyph` en `core.ts`).
- `headerRows: 1` en una tabla de pdfmake puede descartar la fila completa en silencio si es alta. Se dejó de usar ese flag.
- Una celda con un token largo sin espacios (ej. una URL, un hash) hace que pdfmake descarte todas las columnas salvo la primera en toda la hoja — se corrigió con `wordBreak: "break-all"` por celda.
- Un XLSX disperso (una celda perdida en la fila 1,048,576) agotaba la memoria del navegador porque el motor iteraba `1..rowCount` con `getRow` en vez de `eachRow`. Corregido, más un presupuesto `MAX_TABLE_CELLS`.
- Una bomba de descompresión ZIP podía inflar cientos de MB antes de llegar a `mammoth`/`exceljs`. Ahora se estima el tamaño descomprimido por el directorio central del ZIP (`estimateZipUncompressedBytes` en `core.ts`) antes de parsear.
- Un `.docx`/`.xlsx` cifrado con contraseña también cumple la firma OLE2 de los formatos legado — se distingue con `looksLikeEncryptedOoxml` para no decirle al usuario "usa el formato moderno" cuando el problema real es la contraseña.

Todo esto vive ahora como utilidades compartidas en `src/lib/pdf/core.ts` (`loadPdfMake`, `looksLikeEncryptedOoxml`, `estimateZipUncompressedBytes`, `findUnsupportedGlyph`) — cualquier fase futura que use pdfmake (`powerpoint-to-pdf` cuando se retome) debe reutilizarlas, no reinventarlas.

**Actualización (2026-08-01) — Codex real ya corrió.** La cuota se liberó antes de lo previsto y Codex hizo una segunda pasada adversarial real sobre `wordToPdf.ts`/`excelToPdf.ts`/`core.ts` (dos intentos previos fallaron: uno por cuota, otro porque el filtro de moderación de OpenAI cortó el turno a mitad de camino por lenguaje "cybersecurity risk" — se resolvió reformulando el prompt en tono de QA de rutina en vez de "bomba"/"bypass", mismo contenido). Veredicto de Codex: **"Needs more work before shipping"**, con 10 hallazgos reales:

- **Nuevos**: expansión sin límite de `colspan`/`gridSpan` en tablas DOCX (una tabla maliciosamente pequeña podía forzar decenas de miles de celdas); una hoja de Excel con formato pero sin datos reales abortaba la conversión entera (perdiendo también las demás hojas); celdas combinadas duplicaban su valor en vez de aparecer una sola vez; una tabla de Word con ~125,000+ filas revienta `Math.max(...array)` por límite de argumentos de función.
- **Gaps en los 9 fixes de la ronda anterior**: el presupuesto `MAX_TABLE_CELLS` era por-hoja, no por-libro completo (varias hojas cada una bajo el límite podían sumar muy por encima); fórmulas con resultado `0`/`false` ahora renderizaban en blanco en vez de "[object Object]" (mejor, pero seguía siendo incorrecto — exceljs expone el valor real vía `cell.result`, no `cell.value.result`); la lista de alfabetos no soportados por Roboto le faltaban armenio, bengalí, tamil, tibetano, georgiano y varios más; el estimador de tamaño ZIP se podía burlar forjando `totalEntries: 0` en el EOCD; `loadPdfMake()` cacheaba una promesa rechazada para siempre tras un fallo transitorio.

Todo esto se corrigió en una tercera ronda (misma disciplina: agentes en paralelo por archivo, re-verificación en contexto fresco, verificación en navegador real). Suite final: 682 tests pasando (32 archivos), `tsc`/`eslint` limpios. El estimador de ZIP ahora ignora `totalEntries` como límite del bucle y camina el directorio central por firma real; el presupuesto de celdas se comparte entre todas las hojas de una misma conversión; las fórmulas falsy usan `cell.result` de exceljs; las celdas combinadas se blanquean en las posiciones esclavas; las tablas tienen un tope de tamaño (`MAX_TABLE_CELLS`/`MAX_TABLE_ROW_CELLS`) antes de llegar a pdfmake.

**Limitaciones conocidas, documentadas y aceptadas conscientemente (no bloquean el envío, pero quedan anotadas para quien retome `powerpoint-to-pdf` u otra fase con pdfmake):**
- La lista de alfabetos no soportados en `findUnsupportedGlyph` sigue siendo una lista de rangos Unicode mantenida a mano, no una verificación contra el mapa de glifos real de las fuentes Roboto embebidas — es inherentemente frágil ante cambios futuros de fuente. Lo correcto a largo plazo es derivar la cobertura del propio archivo de fuente.
- Una imagen corrupta declarada con MIME `image/png`/`image/jpeg` (sniffing solo por MIME, no validación real del payload) sigue pudiendo abortar la conversión completa si pdfmake la rechaza.
- El estimador de ZIP no puede verificar nada cuando el archivo usa ZIP64 o el EOCD no es parseable (devuelve `null` y el código sigue adelante sin ese presupuesto).
- La detección de OOXML cifrado (`looksLikeEncryptedOoxml`) es una búsqueda de substring UTF-16LE dentro de los primeros 8 MB, no un parser CFB real — puede tener falsos positivos/negativos en archivos OLE2 fuera de lo común.
- La cancelación (`AbortSignal`) no puede interrumpir una llamada síncrona ya en curso a `mammoth`/`exceljs`/`pdfmake` (solo se comprueba entre pasos) — requeriría mover el trabajo a un Web Worker, cambio de arquitectura fuera de alcance de esta fase.

Referencias previas: `docs/competitive-analysis.md` (investigación original), `docs/future-roadmap.md` (roadmap Tier 1-3 original, con su Tier 1 ya corregido para apuntar aquí), `docs/server-required-features.md` (lista viva de qué sí necesita servidor).

---

## Parte 1 — Decisión: conversión Word/Excel/PowerPoint ↔ PDF

### Cómo se tomó esta decisión
Codex y un agente en Opus 5 investigaron esto **de forma independiente y en paralelo** (no uno revisando al otro), cada uno verificando licencias contra fuentes primarias (npm registry API, README/LICENSE reales, no memoria de entrenamiento). Ambos llegaron a la misma conclusión sin haberla coordinado entre sí.

### Hallazgo que corrige el roadmap anterior
`future-roadmap.md` decía que la licencia comercial de $79 que vende BentoPDF era una forma de evitar la obligación AGPL. **Esto es incorrecto y hay que descartarlo**: esa licencia cubre el código propio de BentoPDF, no los tres componentes de terceros que hacen la conversión real (PyMuPDF/Ghostscript son de Artifex Software; CoherentPDF es de Coherent Graphics). Comprarla no da ningún derecho sobre esos componentes AGPL-3.0.

### La pregunta legal de fondo (no resuelta, y no se puede resolver aquí)
BentoPDF no empaqueta esos WASM en su propio repositorio — los referencia por URL desde un CDN en tiempo de ejecución, y presenta esto como la forma de que su propio código no quede bajo AGPL. Tanto Codex como el agente Opus coinciden en que **esto no es un blindaje legal sólido**: la obligación de AGPL-3.0 depende de si el conjunto forma una "obra combinada"/derivada (comunicación de datos íntima, control de flujo, integración con propósito), no de dónde vive físicamente el binario ni de cómo se transporta. Es una zona gris real — no hay jurisprudencia específica sobre WASM-vía-CDN — y ninguno de los dos modelos se sintió cómodo tratando la decisión de negocio de BentoPDF como precedente aplicable a OptimusPDF.

### Decisión recomendada (pendiente de confirmación del dueño del producto — ver "Preguntas para el dueño" abajo)
**Evitar por completo cualquier dependencia AGPL-3.0**, dado que OptimusPDF es un repositorio privado/propietario y el objetivo es "non-cost" (sin pagar licencias ni asumir el riesgo de una obligación de código abierto forzado). En su lugar: **una pila 100% de librerías con licencia permisiva (MIT/BSD/Apache-2.0)**, con alcance reducido y honesto en las direcciones donde ninguna librería permisiva da fidelidad completa — en vez de fingir una calidad que no existe.

Se investigó también la alternativa de LibreOffice compilado a WASM (licencia MPL-2.0, compatible con código propietario): existe como proyecto real (**ZetaOffice**, de allotropia, envoltorio MIT), pero es **técnicamente inviable hoy** para este producto: ~250 MB de payload (`soffice.wasm` ~154 MB + `soffice.data` ~95 MB), requiere `SharedArrayBuffer` y cabeceras COOP/COEP en todo el sitio (chocaría con el resto de la app), en la práctica solo funciona bien en Chromium, y el proyecto sigue en beta abierta. **Descartado por ahora — solo monitorear, no construir sobre esto.**

### Pila recomendada, herramienta por herramienta

**Dirección fácil — Office → PDF (implementar primero):**

| Herramienta | Librería de lectura | Librería de salida | Licencias | Notas |
|---|---|---|---|---|
| `word-to-pdf` | `mammoth` (DOCX→HTML) | `html-to-pdfmake` + `pdfmake` | BSD-2-Clause / MIT / MIT | **No reutilizar** el pipeline existente de `htmlToPdf.ts` — ese es un pipeline de rasterizado (`html2canvas`→`jsPDF.addImage`, ver `src/lib/pdf/htmlToPdf.ts:697-748`) y produciría un Word-a-PDF sin texto seleccionable/buscable, una regresión de calidad real. `pdfmake` genera PDF con texto nativo. |
| `excel-to-pdf` | `exceljs` (lee XLSX) | `pdfmake` (tabla nativa) | MIT / MIT | La más limpia de las tres — `exceljs` ya lee y escribe XLSX. |
| `powerpoint-to-pdf` | `@jvmr/pptx-to-html` o `pptxviewjs` | render a imagen por diapositiva → PDF | MIT / MIT | **Menor confianza de las 6.** Librerías jóvenes, poco probadas. Recomendado: un spike acotado en tiempo contra presentaciones reales antes de comprometerse a esta ruta — la fidelidad de diapositivas es donde estas librerías jóvenes van a fallar, si van a fallar. |

**Dirección difícil — PDF → Office (reducir alcance, reutilizar lo que ya existe):**

| Herramienta | Enfoque | Reutiliza | Librería de salida | Alcance |
|---|---|---|---|---|
| `pdf-to-word` | Reconstruir estructura ya extraída | El modelo de bloques que **ya existe** en `src/lib/pdf/pdfToMarkdown.ts` (títulos, listas, tablas, negrita/cursiva/monoespaciado ya reconstruidos — no hace falta motor nuevo) | `docx` (MIT) | Honesto: ni PyMuPDF logra una fidelidad de layout perfecta en esta dirección, así que esto no es una concesión de calidad respecto a BentoPDF — es la misma clase de resultado. |
| `pdf-to-excel` | Extraer tablas | El detector de tablas **ya existente** en `pdfToMarkdown.ts` | `exceljs` (MIT) | Alcance: "extraer tablas a una hoja de cálculo", que es la necesidad real del usuario, no "reconstruir un Excel con fórmulas". |
| `pdf-to-powerpoint` | Una imagen de página por diapositiva | `pdfToImages.ts` **ya existente** | `pptxgenjs` (MIT) | Reduce el alcance a "genera un .pptx navegable con una imagen por diapositiva" — no diapositivas editables. Barato de construir; solo engañoso si no se etiqueta con claridad. |

**Confirmado, sin AGPL, sin costo, en cualquier dirección**: `docx` 9.7.1 (MIT), `exceljs` 4.4.0 (MIT), `pptxgenjs` 4.0.1 (MIT), `pdfmake` 0.3.11 + `html-to-pdfmake` 2.5.33 (MIT), `mammoth` 1.12.0 (BSD-2-Clause). Evitar el paquete `xlsx` de SheetJS en npm — quedó congelado en 0.18.5 tras una disputa de SheetJS con npm Inc., y las versiones nuevas solo viven en su propio CDN (una rareza de distribución que no vale la pena para lo que ya resuelve `exceljs`).

### Política de formatos legacy (`.doc`, `.xls`, `.ppt`)
Ninguna librería permisiva lee estos formatos binarios antiguos (solo los modernos OOXML: `.docx`/`.xlsx`/`.pptx`). Decisión pendiente del dueño del producto: quitarlos de `accept`/`extensions` en `tools-registry.ts`, o aceptarlos en el selector de archivo pero mostrar un mensaje honesto de rechazo ("solo soportamos el formato moderno .docx, no el .doc antiguo") en vez de fallar en silencio o con un error genérico.

### Preguntas para el dueño del producto (bloquean el inicio de esta fase, no son técnicas)
1. **Confirmar la lectura de "non-cost"**: ambos modelos asumieron que también significa "sin obligación de abrir el código fuente propietario de OptimusPDF" (dado que el repo es privado). Si esa lectura es incorrecta y abrir el código fuente sí sería aceptable, la opción AGPL se reabre y cambia todo este análisis.
2. **Confirmar el rechazo de la ruta AGPL** (recomendada por ambos modelos) antes de que cualquier fase de implementación toque este tema.
3. **Alcance de `pdf-to-powerpoint`**: ¿enviarlo como imagen-por-diapositiva bien etiquetado, o dejarlo en `"soon"` hasta encontrar algo mejor?
4. **Formatos legacy**: ¿quitar `.doc`/`.xls`/`.ppt` del selector, o aceptarlos con un mensaje de rechazo honesto?

---

## Parte 2 — Categorización completa de la lista de funcionalidades de BentoPDF

Cruzado contra `src/lib/tools-registry.ts` (32 herramientas hoy: 26 `live` + 6 `soon`) y contra `docs/future-roadmap.md` (para no duplicar lo que ya estaba priorizado ahí). Cada fila indica si ya lo tenemos, y si no, en qué fase de este plan entra.

### Ya lo tenemos — sin acción
| Funcionalidad pedida | Ya existe como |
|---|---|
| PDF editor | `edit-pdf` (live) |
| PDF to markdown | `pdf-to-markdown` (live, recién endurecido en la fase anterior) |
| Compare PDFs | `compare-pdf` (live) |
| Images to ZIP | ya lo hace automático `pdf-to-jpg` cuando hay más de una página (`src/lib/pdf/pdfToImages.ts:130-135`, usa `jszip` ya presente) |
| Digital Signature PDF / Validate PDF Signature / Timestamp PDF | ya priorizadas en `future-roadmap.md` Tier 2, puntos 1-3 — no se repiten aquí |
| Sanitize PDF | ya priorizada en `future-roadmap.md` Tier 2, punto 4 |

### Fase A — Ganancias rápidas (construyen directo sobre motores que ya existen)
| Funcionalidad | Enfoque | Base existente |
|---|---|---|
| **Change Permissions** | Exponer en UI lo que el motor ya soporta | `src/lib/pdf/protect.ts` ya tiene `SecurityOptions.permissions` granular (línea 38, `FULL_PERMISSIONS` es solo el default hoy) — no hace falta motor nuevo, solo una pantalla de opciones y una llamada con permisos parciales |
| **PDF to Text** | Envolver extracción de texto ya existente en una herramienta propia | La extracción de texto posicional ya vive en `pdfToMarkdown.ts`/`unlock.ts`/`summarize.ts` — falta solo la herramienta dedicada con salida `.txt` plana |
| **PDFs to ZIP** | Empaquetar sin procesar | `jszip` ya es dependencia del proyecto (usado en `pdfToImages.ts`) — trivial |
| **Extract PDF Tables / PDF to CSV** (mismo pedido, dos nombres) | Reusar detector de tablas | `pdfToMarkdown.ts` ya detecta tablas regulares — exponer como exportación a CSV/JSON además de Markdown, en una sola herramienta con selector de formato de salida |
| **PDF to JSON** | Volcado estructurado | Construir sobre `page.getTextContent()`/`getOperatorList()` de pdf.js, ya integrado en el proyecto |
| **Add/Remove Blank pages** | Extensión de `organize-pdf` | Insertar una página vacía (`pdf-lib`'s `addPage()` sin contenido) en cualquier posición — el motor de reordenar ya existe en `src/lib/pdf/organize.ts` |

### Fase B — Esfuerzo moderado, sin dependencias externas nuevas
| Funcionalidad | Enfoque |
|---|---|
| **View/Edit/Remove Metadata** | Herramienta dedicada sobre la API de metadatos de pdf-lib (autor/título/asunto/palabras clave) — hoy no existe una pantalla propia para esto |
| **Add/Edit/Extract/Remove attachments** | Gestión de archivos incrustados vía la API de adjuntos de pdf-lib |
| **Header and Footer** | Distinto de marca de agua/números de página existentes: bloques de texto repetidos arriba/abajo de cada página |
| **Add Stamps** | Variante simple de marca de agua: sellos preestablecidos (APROBADO/CONFIDENCIAL/BORRADOR), posición única, sin mosaico |
| **Remove Annotations** | Subconjunto de lo que hará Sanitize PDF — puede compartir motor con un toggle más angosto, o ser su propia herramienta simple |
| **Resize PDF pages** | Estandarizar tamaño de página (A4/Carta/Legal/personalizado) reescalando contenido vía pdf-lib |
| **Divide Pages** | Cortar cada página en mitades/cuartos (distinto del split por rango que ya existe) — recalcular el recorte de contenido por sub-página generada |
| **Combine to single page** | Fusión en desplazamiento continuo: una sola página larga con todas las páginas originales en secuencia vertical |
| **Create PDF form** | Construir un AcroForm nuevo desde cero con campos de texto arrastrables — **sinergia directa**: `FieldPlacer.tsx` y `detectFields.ts` (recién construidos en la fase anterior para *rellenar* campos) son la base natural para *crear* campos nuevos en vez de solo detectarlos — no es una herramienta aislada, es una extensión lógica de lo que ya existe |

### Fase C — Requieren un decodificador/parser externo (investigar licencia antes de adoptar)
| Funcionalidad | Qué falta | Nota |
|---|---|---|
| **Image to PDF (cualquier formato)** | Expandir `jpg-to-pdf` más allá de jpg/png/webp | HEIC necesita decodificador (investigar licencia de `heic2any`/`libheif-wasm`); PSD necesita parser (`ag-psd` parece MIT, verificar al adoptar); TIFF necesita decodificador (`utif.js` o similar, verificar licencia); BMP es simple (bitmap crudo, ya soportado bien por canvas nativo) |
| **PSD to PDF** | Se resuelve como parte de lo anterior, no como herramienta aparte |
| **Pages (Apple) a PDF** | Formato de paquete propietario (ZIP de XML + recursos) sin librería madura conocida | **Prioridad baja / difícil** — evaluar si el volumen de usuarios justifica el esfuerzo antes de comprometerse; marcarlo explícitamente como "probablemente no vale la pena" en vez de omitirlo en silencio |
| **ODG to PDF** | OpenDocument Graphics — formato de nicho | Prioridad baja, mismo criterio que Pages |

### Fase D — Necesitan investigación de arquitectura antes de comprometerse a un enfoque (no asumir nada todavía)
| Funcionalidad | La pregunta abierta |
|---|---|
| **Web to PDF** (dar una URL viva, no un archivo .html subido) | Fetch de una URL arbitraria de un tercero desde JS del navegador choca con CORS si el sitio destino no lo permite — esto podría genuinamente necesitar un proxy de servidor para el caso general (candidato real para `server-required-features.md` si se decide perseguir esto), o acotar el alcance a "pega tu propio HTML" (que es lo que `html-to-pdf` ya hace), o investigar si abrir la URL en un iframe oculto + usar el mecanismo nativo de impresión del navegador funciona solo para sitios públicos sin restricciones. **No implementar sin resolver esta pregunta primero.** |
| **Email to PDF** | EML es texto plano RFC822, fácil de parsear client-side. MSG es un formato OLE propietario de Microsoft, más difícil — investigar si existe un parser con licencia permisiva antes de comprometerse a soportarlo; se puede lanzar solo EML primero y evaluar MSG después |
| **Linearize PDF** | pdf-lib probablemente no soporta la reordenación de objetos que pide el estándar de PDF linealizado (fast web view) — no se investigó en esta sesión si existe una librería JS/WASM que lo haga. **Genuina incertidumbre, no asumir que es fácil ni que es imposible sin investigarlo primero.** |

---

## Fases de implementación sugeridas (para ejecutar con el método de este repo)

1. **Fase 0 (antes de tocar código)**: el dueño del producto responde las 4 preguntas de la Parte 1. Sin esto, no arrancar la conversión Office↔PDF.
2. **Fase 1**: conversión Office→PDF (word-to-pdf, excel-to-pdf; powerpoint-to-pdf solo tras el spike acotado recomendado). Instalar `mammoth`, `exceljs`, `pdfmake`, `html-to-pdfmake` (todas MIT/BSD, sin costo). Actualizar `tools-registry.ts` (`status: "soon"` → `"live"` según vaya completándose cada una).
3. **Fase 2**: conversión PDF→Office (pdf-to-word, pdf-to-excel reutilizando el modelo de bloques/tablas de `pdfToMarkdown.ts`; pdf-to-powerpoint como imagen-por-diapositiva). Instalar `docx`, `pptxgenjs` (además de `exceljs` ya instalado en Fase 1).
4. **Fase 3**: Fase A completa (ganancias rápidas) — la más barata de todo este plan, buen candidato para hacerse antes incluso que la conversión Office si se quiere mostrar progreso rápido.
5. **Fase 4**: Fase B (esfuerzo moderado) — priorizar "Create PDF form" por la sinergia directa con el trabajo de fill-form ya hecho.
6. **Fase 5**: Fase C, solo tras confirmar licencias reales de cada decodificador candidato.
7. **Fase 6**: Fase D, solo tras resolver cada pregunta de arquitectura abierta — probablemente la última fase, no la primera.

Cada fase debe seguir el mismo patrón que las fases anteriores de este repo: exploración → plan cerrado → implementación en agentes Sonnet 5 → revisión de Codex para lo que toque integridad de datos o el árbol de objetos del PDF → verificación en navegador real con archivos reales, no solo `vitest`.

## Verificación esperada
- Cada nueva herramienta necesita al menos un test que use un archivo real construido con la librería de igual dirección (ej. un `.docx` real generado con `docx` para probar `word-to-pdf`, no solo un mock).
- Las conversiones PDF→Office deben verificarse abriendo el resultado con la librería de lectura correspondiente (ej. `mammoth` puede releer el `.docx` que generamos, o al menos `exceljs` puede releer el `.xlsx` generado) para confirmar que el archivo de salida es válido, no solo que no lanzó una excepción.
- Actualizar `docs/server-required-features.md` si "Web to PDF" termina necesitando un proxy — no dejarlo en el limbo si Fase D lo resuelve.
