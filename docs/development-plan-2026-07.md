# Plan de desarrollo: conversión Office↔PDF + expansión de funcionalidades (2026-07-30)

**Este archivo es el punto de partida para la próxima sesión.** Contiene una decisión ya tomada (con evidencia verificada) sobre cómo resolver las 6 herramientas de conversión Office↔PDF sin costo y sin licencias copyleft, más la categorización completa de la lista extendida de funcionalidades de BentoPDF que el usuario pidió revisar, organizada en fases de implementación listas para ejecutar con el mismo método usado en el resto de este repo (exploración → plan cerrado → agentes Sonnet 5 → revisión de Codex donde aplique → verificación en vivo).

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
