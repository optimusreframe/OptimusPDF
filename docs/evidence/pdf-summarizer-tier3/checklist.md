# pdf-summarizer — verificación Tier 3 (inferencia real end-to-end)

Cierra la brecha señalada por la auditoría de Codex de la fase 4: `pdf-summarizer`
estaba marcada `live` pero su componente diferenciador (la inferencia real de
WebLLM) nunca se había ejecutado de punta a punta — solo se verificó la UI y el
flujo de consentimiento.

## Fixture

`fixture-informe-ficticio.pdf` — 2 páginas, contenido 100% inventado (ninguna
persona, organización o dato real), con hechos concretos y verificables para
poder juzgar si el resumen generado realmente refleja el documento:

- Página 1: fundación ficticia "Río Claro", 4200 árboles en 2025, presupuesto
  180000 (ficticio), 3 ciudades ficticias (Vallenorte, Puente Alto, Los Sauces),
  director ficticio Andrés Molina.
- Página 2: desglose por ciudad (1800/1500/900 árboles), especies ficticias
  (Quillay, Boldo), tasa de supervivencia ficticia 87%.

## Qué se verifica

- [ ] Detección de WebGPU y aviso correcto si no está disponible.
- [ ] Subida del fixture, opciones visibles (modelo, longitud, idioma, OCR).
- [ ] Consentimiento explícito requerido antes de descargar el modelo (no
      descarga silenciosa).
- [ ] Descarga real del modelo más ligero (Llama 3.2 1B Instruct q4, ~677 MB)
      completa sin error.
- [ ] Extracción de texto real del PDF (pdfjs-dist), sin caer a OCR (el fixture
      tiene texto seleccionable, no es un escaneo).
- [ ] Inferencia real: se genera un resumen no vacío, no un placeholder.
- [ ] El resumen menciona al menos algunos de los hechos concretos del fixture
      (no se exige perfección — es un modelo de 1B parámetros — pero debe
      reflejar el documento, no alucinar contenido no relacionado).
- [ ] Las citas de página (si el resumen tiene más de un tramo) referencian
      páginas reales del documento (1-2).
- [ ] Segunda ejecución (mismo modelo ya en caché del navegador) no vuelve a
      descargar el modelo completo.
- [ ] Sin errores de consola atribuibles al motor (`summarize.ts`) durante el
      proceso.
- [ ] Ninguna petición de red contiene el texto extraído del PDF — solo la
      descarga de pesos del modelo hacia el origen declarado.

## Resultado

Ver `resultado.md` en este mismo directorio para el resultado real observado,
capturado el día de la verificación.

## Nota de alcance

No se commitea el modelo (677 MB) ni ninguna cookie/caché del navegador — solo
el fixture (2968 bytes) y el resultado de texto observado. Esta verificación es
manual/puntual (no se ejecuta en cada PR): el CI gratuito (ítem 4 del plan)
puede referenciar este directorio para una futura prueba Playwright etiquetada
`@large-model`, no obligatoria por defecto.
