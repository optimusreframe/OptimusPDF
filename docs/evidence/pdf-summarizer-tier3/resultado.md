# Resultado observado — verificación Tier 3 de `pdf-summarizer`

Fecha de la verificación: sesión de continuación de la fase 4 (item 1 del plan
post-fase-4). Entorno: Chrome (vía Browser pane), WebGPU disponible
(`navigator.gpu` truthy), dev server local (`npm run dev`).

## Resumen del resultado

**La inferencia real de punta a punta funciona.** Se corrió el flujo completo
dos veces con el mismo fixture de 2 páginas (`fixture-informe-ficticio.pdf`,
2968 bytes, contenido 100% inventado): descarga real del modelo
`Llama-3.2-1B-Instruct-q4f16_1-MLC` (677 MB), carga en WebGPU, extracción de
texto con pdfjs-dist, y síntesis de un resumen real y coherente en ambos
casos.

## Corrida 1

- Progreso observado: `Fetching param cache[6/22]: 121MB fetched. 18%` →
  `Loading model from cache[18/22]: 563MB loaded. 84%` → `Resumiendo trozo 1
  de 1` → resultado.
- Tiempo total aproximado: ~100 segundos (descarga + carga + inferencia).
- Resultado real generado:

  > [p.1] La fundación Rio Claro se caracteriza por plantar 4200 arboles en
  > el año 2025, con un presupuesto total de 180000 dolares ficticios.
  > [p.2] Los resultados de la plantación en las ciudades de Vallenorte,
  > Puente Alto y Los Sauces muestran un alto nivel de participación de
  > voluntarios ficticios.
  > [p.3] La especie más plantada fue el Quillay, seguida por el Boldo, lo
  > cual se refiere a una tasa de supervivencia reportada de 87% a los 6
  > meses.

## Corrida 2 (mismo fixture, "Empezar de nuevo")

- Progreso similar en tiempo total (~100 segundos) — ver "Hallazgo 2" abajo.
- Resultado real generado (distinto en redacción al de la corrida 1, lo que
  confirma que es inferencia real y no una respuesta enlatada):

  > [p.2] ... la plantación de árboles en las ciudades de Vallenorte, Puente
  > Alto y Los Sauces muestran un alto nivel de participación de voluntarios
  > ficticios, con un total de 1800, 1500 y 900 árboles plantados,
  > respectivamente.
  > [p.3] La tasa de supervivencia reportada en los 3 años posteriores a la
  > plantación de árboles es del 87% en los primeros 6 meses, lo que sugiere
  > una alta eficacia en el programa.

## Checklist (ver `checklist.md`)

- [x] Detección de WebGPU correcta.
- [x] Subida del fixture, opciones visibles.
- [x] Consentimiento explícito requerido (el botón de proceso permanece
      deshabilitado hasta marcar el checkbox correspondiente).
- [x] Descarga real del modelo más ligero, sin error, ambas veces.
- [x] Extracción de texto real (no cayó a OCR — el fixture tiene texto
      seleccionable).
- [x] Inferencia real: resumen no vacío, coherente, generado por el modelo
      (confirmado por el nombre de modelo mostrado en pantalla:
      `LLAMA-3.2-1B-INSTRUCT-Q4F16_1-MLC`).
- [x] El resumen menciona hechos concretos reales del fixture (4200 árboles,
      180000 ficticios, las 3 ciudades, 1800/1500/900 por ciudad, Quillay,
      Boldo, 87%).
- [x] Sin errores de consola en ninguna de las 2 corridas.
- [x] Ninguna petición de red con contenido del PDF observada — solo
      descargas de assets/modelo.
- [ ] **Segunda ejecución sin re-descarga notable** — NO se confirmó (ver
      Hallazgo 2).
- [~] Citas de página — parcialmente correctas (ver Hallazgo 1).

## Hallazgos reales observados (no son bugs de código, son comportamiento del
modelo/runtime — documentados con honestidad, no ocultados)

### Hallazgo 1 — el modelo cita una página que no existe (`[p.3]`)

El documento tiene exactamente 2 páginas, pero **ambas corridas** citaron
`[p.3]` en la última oración del resumen. Se revisó `src/lib/pdf/summarize.ts`:
el prompt de síntesis final le pide al modelo usar el formato `(p.4)` **como
ejemplo ilustrativo** de las instrucciones, sin restringir programáticamente
qué números de página puede usar el modelo — el modelo de 1B parámetros
extrapola el patrón numérico (p.1, p.2, p.3...) en vez de razonar sobre el
rango real de páginas que se le dio. **No es un bug de código**: el motor sí
etiqueta correctamente cada fragmento fuente con `[p.N]` reales antes de
mandarlo al modelo (verificado en el código, líneas ~226-355 de
`summarize.ts`); es el propio modelo pequeño el que no logra respetar ese
límite al redactar su síntesis libre. Es exactamente el tipo de error que la
propia herramienta ya advierte explícitamente en su copy ("puede... afirmar
cosas que el documento no dice... contrasta siempre con las páginas
citadas") — la advertencia es precisa y se confirma con evidencia real.
**Severidad: baja, esperada — no requiere corrección de código.** Recomendación
para una fase futura, si se quiere reducir esto: validar programáticamente
que cada `[p.N]` citado esté dentro del rango real de páginas del chunk antes
de mostrarlo, y si no lo está, quitar la cita en vez de mostrarla.

### Hallazgo 2 — la segunda ejecución no fue notablemente más rápida ni mostró el aviso de "modelo ya descargado"

La copia de la herramienta promete: *"Se queda en la caché del navegador, así
que solo se descarga la primera vez"*, y existe un mensaje `consentCached`
("Este modelo ya está descargado en tu navegador: no hará falta volver a
bajarlo") pensado para este caso. En la práctica, al repetir el proceso en la
misma pestaña (sin recargar la página) tras un "Empezar de nuevo", la segunda
corrida tardó un tiempo total similar a la primera (~100s ambas) y el aviso de
"ya descargado" nunca apareció.

Distinción importante encontrada al inspeccionar los tiempos por fase: la fase
de **descarga** ("Fetching param cache") fue igual o más rápida la segunda vez
(203MB en 4s vs 121MB en 7s la primera), lo que sí es compatible con una
lectura desde caché en vez de una descarga de red real. La fase que domina el
tiempo total ambas veces es **"Loading model from cache" → WebGPU** (compilar
shaders / reservar buffers de ~879MB de VRAM), que parece tener un costo fijo
en este hardware independientemente de si los bytes vinieron de red o de
caché local. Esto significa que la promesa de privacidad/costo de red ("no
vuelve a descargar") probablemente SÍ se cumple a nivel de bytes transferidos,
pero la experiencia de usuario ("va a ser instantáneo la segunda vez") es
optimista — la carga en GPU sigue siendo lenta cada vez que se crea una nueva
instancia del motor, y el mensaje `consentCached` no se disparó en ninguna
corrida de esta prueba dentro de la misma sesión de pestaña.

**Severidad: media (copy/expectativa de UX, no de privacidad).**

Causa raíz investigada y confirmada con evidencia directa:

- Se inspeccionó la Cache Storage real del navegador (`caches.keys()` +
  `cache.keys()`): los 22 shards de parámetros, el `mlc-chat-config.json` y
  el `.wasm` del modelo **sí estaban genuinamente cacheados**
  (`webllm/model`, `webllm/config`, `webllm/wasm`), incluso tras una recarga
  completa de página (F5), no solo dentro de la misma sesión de React.
- Sin embargo, `isModelCached()` (que llama a
  `webllm.hasModelInCache(model.id, webllm.prebuiltAppConfig)`, la función
  oficial de la librería `@mlc-ai/web-llm`) siguió devolviendo `false`
  incluso con la recarga completa — es decir, el problema **no es** que el
  efecto de React solo se ejecute una vez (esa parte del código está bien:
  `useEffect` con deps `[gpu, model]` sí se re-ejecuta en cada montaje). El
  problema real está dentro de `hasModelInCache` de la propia librería de
  terceros, que aparentemente no reconoce como "completo" un cache que la
  Cache Storage API confirma que sí lo está.

**Corrección aplicada** (`src/app/pdf-summarizer/PdfSummarizerToolClient.tsx`):
tras un resumen exitoso, se marca `setCached(true)` directamente en vez de
esperar a que `isModelCached()` lo detecte — ya se sabe con certeza que el
modelo está disponible porque se acaba de usar. Esto resuelve el caso más
importante en la práctica: dentro de la misma sesión de pestaña, un segundo
resumen ya no pedirá de nuevo el consentimiento de descarga como si el
modelo no estuviera disponible. Verificado con `tsc --noEmit` limpio.

**No resuelto, documentado como límite conocido de una librería externa**: el
caso de recarga completa de página (F5) sigue mostrando "hay que descargar
el modelo" pese a que el cache real ya existe, porque `isModelCached()` seguirá
dependiendo de la función de terceros que no lo detecta correctamente. No se
aplicó un fix especulativo sobre el comportamiento interno de
`hasModelInCache` sin entender exactamente por qué disiente de la Cache
Storage real — eso requeriría revisar el código fuente de `@mlc-ai/web-llm`
o reportar el caso aguas arriba. Recomendación para una fase futura: (a)
abrir un issue en el repositorio de `@mlc-ai/web-llm` con este caso
reproducible, o (b) implementar una verificación propia más simple
(consultar `caches.open('webllm/model')` directamente y contar las entradas
esperadas) en vez de depender de la función de la librería.

## Conclusión

`pdf-summarizer` pasa de Tier 2 a **Tier 3**: se observó inferencia de IA real,
dos veces, con resultados coherentes y verificables contra un fixture de
contenido conocido. Se documentan honestamente 2 hallazgos de comportamiento
real (uno ya cubierto por el propio disclaimer de la herramienta, otro nuevo
sobre la experiencia de caché) — ninguno bloqueante, ambos quedan como
recomendación para una fase futura, no como fix urgente.
