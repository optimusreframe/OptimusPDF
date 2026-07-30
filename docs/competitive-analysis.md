# Análisis competitivo: bentopdf.com, pdfzone.dev, tools.pdf24.org (2026-07-30)

Investigación en vivo (navegador real + código fuente público cuando existía) de las tres plataformas que el usuario pidió analizar. Objetivo: catalogar qué tienen que OptimusPDF no tiene, cómo resuelven lo que sí coincide, y —el punto que motivó esta investigación— confirmar de verdad si sus conversiones tipo PDF↔Word/Excel/PowerPoint corren sin servidor, como afirman en su marketing.

## Resumen ejecutivo

- **BentoPDF** es, de las tres, la más relevante como referencia: catálogo enorme (~90 herramientas), 100% cliente confirmado (código abierto en GitHub), y **sí resuelve PDF↔Word/Excel/PDF/A vía WebAssembly real** (PyMuPDF, Ghostscript, CoherentPDF compilados a WASM, cargados en runtime desde jsDelivr). Esto confirma técnicamente que el enfoque "sin servidor" para esas conversiones es viable — no es solo una promesa de marketing sin sustento.
- **PDF Zone** tiene un catálogo más chico (~34 herramientas) y **no ofrece ninguna conversión de Office** (ni Word, ni Excel, ni PowerPoint, en ningún sentido) — así que para esta pregunta específica del usuario, PDF Zone no aplica. Sí confirma el patrón general "WebAssembly, todo en el navegador" para lo que sí ofrece.
- **PDF24** es la sorpresa real: a pesar de la premisa del usuario ("dicen que no usan server"), **PDF24 declara explícitamente en sus propias páginas que el procesamiento ocurre en sus servidores** — incluso para su herramienta más simple, "Merge PDF" ("PDF files are merged in the cloud on our servers"), y lo mismo para "Word to PDF" ("The conversion of Word files is done on our servers"). PDF24 es un servicio cloud tradicional (subir → procesar en su servidor → borrar tras un tiempo), no un competidor client-side. Vale la pena documentarlo porque corrige la premisa inicial, no porque haya que imitar su arquitectura.

## BentoPDF (bentopdf.com)

**Confirmación técnica de "sin servidor" (fuente: su propio README público en GitHub, `github.com/alam00000/bentopdf`, licencia AGPL-3.0/comercial):**

> "No server-side processing is required... All processing happens in your browser."

Componentes reales que lo permiten (WASM cargados en runtime desde CDN jsDelivr, no empaquetados en el bundle):

| Componente | Licencia | Habilita |
|---|---|---|
| PyMuPDF (WASM) | AGPL-3.0 | PDF→Texto/Markdown/SVG/**DOCX**, extraer imágenes/tablas, EPUB/MOBI/XPS, compresión, enderezar (deskew) |
| Ghostscript (WASM) | AGPL-3.0 | PDF→PDF/A, fuente a contorno |
| CoherentPDF/CPDF (WASM) | AGPL-3.0 | Fusionar, dividir por marcadores, tabla de contenidos, PDF↔JSON, adjuntos |

**Nota de licencia importante**: los tres componentes son AGPL-3.0. BentoPDF los deja fuera de su propio código fuente (solo referencia sus URLs de CDN) precisamente para no obligar a todo su proyecto a ser AGPL, y vende una licencia comercial ($79 único pago) para quien quiera evitar las obligaciones de AGPL. Si OptimusPDF adoptara directamente estos mismos WASM, heredaría la misma disyuntiva: o el proyecto entero pasa a ser AGPL (código fuente público obligatorio si se sirve por red), o se busca/paga una alternativa no-AGPL. Esto se anota también en `server-required-features.md` y en el roadmap: es un problema de licencia a resolver antes de copiar el enfoque literal, no un bloqueo técnico.

**Catálogo — lo que tiene y OptimusPDF no (agrupado, no exhaustivo herramienta por herramienta):**
- **Conversión de/a Office y formatos raros**: Word/Excel/PowerPoint↔PDF (ya lo teníamos como "próximamente"), pero además ODT/ODS/ODP, RTF, WPD (WordPerfect), WPS (WPS Office), Pages (Apple), Publisher (PUB), Visio (VSD/VSDX), Photoshop (PSD), XPS/OXPS, EPUB/MOBI/FB2 (ebooks), CBZ/CBR (cómics), Email (EML/MSG), XML, JSON, CSV↔PDF, Markdown↔PDF.
- **Firma digital criptográfica real** (no solo visual): certificados X.509 (.pfx/.p12/PEM), la clave privada nunca sale del navegador. Más: **validar firmas** de terceros (verifica certificado, integridad, detalles del firmante), y **sellado de tiempo RFC 3161** vía servidor TSA de confianza (sin certificado propio) — prueba criptográfica de "este documento existía en tal fecha."
- **"Preparar PDF para IA"**: exporta el PDF como JSON estilo LlamaIndex para pipelines RAG/LLM — herramienta pensada para quien construye agentes/IA sobre sus propios documentos, no existe en ningún otro lado que hayamos visto.
- **Constructor de flujos de trabajo PDF**: editor visual de nodos para encadenar operaciones (ej. dividir → rotar → marca de agua → comprimir en un solo pipeline reutilizable).
- **Enderezar (deskew) automático** de escaneos torcidos vía OpenCV-WASM.
- **Fuente a contorno**: convierte todas las fuentes a trazos vectoriales (renderizado idéntico en cualquier dispositivo, sin depender de qué fuentes tenga instaladas el lector).
- **Capas PDF (OCG)**: ver/alternar/agregar/eliminar capas de contenido opcional.
- **Sanear PDF**: elimina metadatos, anotaciones y scripts embebidos de un tirón (más agresivo que solo "eliminar metadatos").
- **Comparar PDFs** lado a lado (nosotros ya lo tenemos).
- **Rellenar formularios XFA** (formato de formulario más viejo/raro de Adobe, además de AcroForm normal).
- **Numeración Bates** (numeración legal secuencial across multiple files, típico en descubrimiento legal/discovery).

**Dónde coincidimos y cómo lo resuelven ellos** (referencia de implementación, no para copiar literal):
- Editor PDF con anotar/resaltar/censurar/formas/imágenes en una sola herramienta unificada — nosotros lo tenemos repartido en `edit-pdf` + `redact-pdf` por separado; su unificación es una opción de UX a considerar a futuro (no urgente).
- Multiherramienta de organización (fusionar+dividir+reordenar+eliminar+rotar en una sola pantalla) — nosotros los tenemos como herramientas separadas; válido mantenerlo así por simplicidad, pero anotar la opción "modo combinado" como posible mejora de UX futura.

## PDF Zone (pdfzone.dev)

Catálogo (~34 herramientas) centrado en organizar/editar/convertir/optimizar/seguridad, con marketing genérico de "usamos WebAssembly, tus datos nunca salen del navegador" (sin repositorio público que hayamos podido confirmar en esta pasada, a diferencia de BentoPDF).

**No ofrece ninguna conversión de Office** — ni Word, ni Excel, ni PowerPoint, en ninguna dirección. Para la pregunta específica del usuario sobre estas conversiones, PDF Zone simplemente no es un dato relevante.

**Lo que tiene y nosotros no** (menor volumen que BentoPDF, pero con ideas puntuales):
- **HTML a PDF** (nosotros ya lo tenemos), **Código a PDF** con resaltado de sintaxis (para pegar snippets de código y generar un PDF legible con colores de sintaxis — nicho pero simple de implementar, útil para devs).
- **EML a PDF** (correo con headers completos) y **ZIP a PDF** (empaqueta el contenido de un ZIP en un solo PDF).
- **PDF a XML** (estructura de datos, no solo texto plano).
- **PDF Overlay**: superponer/usar como fondo las páginas de un PDF sobre otro (distinto de fusionar: compone visualmente, no concatena páginas).
- **Grayscale PDF**: convertir a blanco y negro/escala de grises de un tirón (nosotros tenemos "invertir colores" en la idea original del blueprint pero no escala de grises específica).
- **Add Stamp**: sellos tipo "APROBADO"/"CONFIDENCIAL"/"BORRADOR" — variante más simple y dirigida que nuestra marca de agua genérica.
- **Searchable PDF**: hacer buscable un PDF escaneado vía OCR en el navegador (nosotros ya tenemos OCR PDF, functionalmente equivalente).

## PDF24 (tools.pdf24.org)

**Hallazgo principal, contrario a la premisa inicial**: PDF24 no es un competidor client-side. Confirmado con el propio texto de sus páginas de herramienta (no inferido, cita textual):

- Página de "Merge PDF": *"No installation required — You do not need to download and install any software. PDF files are merged in the cloud on our servers... Your files and results will be deleted from our server after a short period of time."*
- Página de "Word to PDF": *"No installation required — ...The conversion of Word files is done on our servers."*

Es decir: **todo** en PDF24 — desde fusionar hasta convertir Word — se procesa subiendo el archivo a su infraestructura, y se borra después de un tiempo. Esto aplica igual a las conversiones de Office (Word/PowerPoint/Excel↔PDF, más ODT/ODS/ODP/EPUB/HTML) que si hay que resolverlas client-side, PDF24 no es la referencia técnica a seguir — su enfoque es exactamente el modelo (subida a servidor) que OptimusPDF existe para evitar.

**Catálogo** (para contexto, aunque no sea client-side): tiene el conjunto completo de conversión Office↔PDF que a nosotros nos falta, más creación de PDF desde cámara, "crear solicitud de empleo en PDF", generador de factura (visual y electrónica), generador de contraseñas, generador de código QR, "ver como PDF"/preferencias de visor, aplicación de escritorio (PDF24 Creator) y una impresora PDF virtual para Windows. Ninguna de estas ideas requiere que sean server-side si se reimplementan client-side (factura/QR/contraseña son triviales sin servidor); se anotan como ideas de producto en `future-roadmap.md`, no como evidencia de que necesiten backend.

## Conclusión para el roadmap

1. El camino técnico que BentoPDF demuestra (WASM de PyMuPDF/Ghostscript/CPDF) es la evidencia concreta que el usuario pedía: las conversiones PDF↔Word/Excel/PowerPoint **sí se pueden hacer sin servidor**, con software real y maduro, no solo con heurísticas propias. La decisión pendiente es de licencia (AGPL vs. buscar/pagar alternativa), no de viabilidad técnica — se detalla la disyuntiva en `future-roadmap.md`.
2. PDF Zone no aporta nada nuevo sobre esta pregunta puntual, pero sí varias ideas de producto pequeñas y baratas de implementar (código a PDF, sellos, EML/ZIP a PDF).
3. PDF24 corrige la premisa: no todo el que "parece" tener una conversión gratis en el navegador la resuelve sin servidor. Es información honesta que vale más que asumir que todos los competidores son client-side.
