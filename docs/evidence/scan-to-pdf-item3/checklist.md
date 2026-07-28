# Item 3 — Verificación de scan-to-pdf

Plan acordado: cámara falsa (automatizada) + pasada manual en 2 dispositivos
físicos reales. Este documento separa ambos estados con honestidad: lo que
sí se ejecutó queda descrito con evidencia; lo que no se pudo ejecutar queda
marcado como pendiente, no como hecho.

## 1. Automatización con cámara falsa — EJECUTADO

- Spec: [e2e/specs/scan-to-pdf.spec.ts](../../../e2e/specs/scan-to-pdf.spec.ts)
- Proyecto Playwright dedicado `chromium-fake-camera`
  ([playwright.config.ts](../../../playwright.config.ts)), con
  `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream` y
  `--use-file-for-fake-video-capture=e2e/fixtures/fake-camera.y4m`.
- Fixture Y4M sintético (320×240, 10 fps, 10 frames estáticos, `C420jpeg`),
  generado sin `ffmpeg` (no disponible en este entorno) reutilizando
  `@napi-rs/canvas`, ya presente como devDependency — ver
  `buildFakeCameraY4m()` en
  [e2e/fixtures/generate-fixtures.mjs](../../../e2e/fixtures/generate-fixtures.mjs).
  Contenido: 4 cuadrantes de color sólido y distinto entre sí (rojo,
  verde, azul, amarillo), sin movimiento — evita que el instante exacto de
  captura vuelva flaky la prueba.
- Escenario cubierto: abrir `/scan-to-pdf` → activar cámara real (falsa) →
  esperar `videoWidth/videoHeight/readyState` reales → sin error de cámara
  → seleccionar tamaño de página "Ajustar" → capturar página → confirmar
  exactamente 1 captura en la tira → generar PDF → descargar → inspeccionar
  la salida: 1 página, dimensiones exactas 320×240, página basada en
  imagen (cero operaciones de texto), y verificación por muestreo de
  píxeles de los 4 cuadrantes en las 4 esquinas de la página renderizada
  (prueba que llegó el fotograma correcto de la cámara y que no se rotó).
- Resultado: estable en 3 corridas consecutivas aisladas y en la suite
  completa (6/6 tests, sin duplicar ejecución entre proyectos). `tsc`,
  `eslint`, `vitest` (521 tests) y `next build` limpios tras el cambio.

### Qué prueba y qué NO prueba este enfoque

Prueba: llamada real a `getUserMedia`, conexión del `MediaStream` al
`<video>`, espera hasta tener dimensiones reales, captura vía canvas a
JPEG, composición y descarga del PDF, orientación y preservación
aproximada del fotograma.

No prueba: selección real cámara frontal/trasera, autofocus/exposición/
balance de blancos, resolución negociada por hardware real, prompts de
permisos específicos de Safari/iOS o Chrome/Android, rotación de sensor y
metadatos de orientación del dispositivo, comportamiento ante suspensión/
cambio de app/bloqueo de pantalla, rendimiento térmico o de memoria, ni la
calidad real fotografiando papel físico.

## 2. Pasada manual en 2 dispositivos físicos — PENDIENTE (no ejecutado)

Esta parte del plan requiere hardware móvil real (idealmente un iOS/Safari
y un Android/Chrome), al que este orquestador no tiene acceso. Queda
documentada aquí como limitación aceptada, no como paso completado. Se
deja la plantilla de checklist para que una persona con esos dispositivos
la ejecute y complete antes de considerar el Item 3 100% cerrado:

| Campo | Dispositivo 1 | Dispositivo 2 |
|---|---|---|
| Modelo | _pendiente_ | _pendiente_ |
| SO / versión | _pendiente_ | _pendiente_ |
| Navegador / versión | _pendiente_ | _pendiente_ |
| Permiso de cámara concedido sin fricción | _pendiente_ | _pendiente_ |
| Captura real de un documento en papel | _pendiente_ | _pendiente_ |
| PDF resultante se abre y se ve correctamente | _pendiente_ | _pendiente_ |
| Orientación correcta (sin rotación inesperada) | _pendiente_ | _pendiente_ |
| El indicador de cámara del sistema se apaga al salir de la herramienta | _pendiente_ | _pendiente_ |
| Observaciones | _pendiente_ | _pendiente_ |

Hasta que esta tabla se complete con evidencia real, el Item 3 se
considera cerrado únicamente en su alcance automatizable (low-cost,
sin servidor, ejecutable en CI), consistente con el resto del plan de 5
items.
