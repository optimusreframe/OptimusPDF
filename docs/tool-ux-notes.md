# Notas funcionales de herramientas (recon en vivo, 2026-07-27)

Observado navegando ilovepdf.com con un PDF de prueba de 6 páginas. Estas notas
describen la ESTRUCTURA funcional de opciones (qué opciones existen, valores y
defaults) para que OptimusPDF implemente equivalentes. Todo el copy visible de
OptimusPDF debe ser original (regla §14 del blueprint).

## Split PDF
- Dos grandes modos en tabs verticales: **Split** y (implícito) **Extract**.
- Sub-modos de Split: **Range** (default), **Pages**, **Size** (este último premium en la referencia; en OptimusPDF puede ser gratis o diferirse).
- Range mode: `Custom` (default) | `Fixed` | `Smart` (premium en referencia).
  - Custom: lista de rangos; cada rango tiene `from page` / `to` (defaults 1..N); botón para añadir otro rango; checkbox "fusionar todos los rangos en un solo PDF" (default off → un PDF por rango, salida ZIP).
  - Fixed: dividir cada X páginas.
- Sidebar derecha con las opciones; preview de miniaturas con el rango resaltado a la izquierda.

## Compress PDF
- Una sola opción: nivel de compresión, 3 tarjetas radio verticales:
  1. Compresión extrema (menos calidad)
  2. **Compresión recomendada (default, preseleccionada)**
  3. Baja compresión (más calidad)
- CTA inferior fijo. Muestra lista de archivos con posibilidad de añadir más.

## Add Watermark
- Tab superior: **Texto** | **Imagen**.
- Texto: input de texto, formato (familia de fuente ej. Arial dropdown, tamaño, negrita/cursiva/subrayado, color).
- **Posición**: grid 3×3 de anclas (default centro) + toggle **Mosaico** (repite en toda la página, deshabilita el grid).
- **Transparencia**: Sin transparencia (default) | 75% | 50% | 25%.
- **Rotación**: 0 (default) | 45° | 90° | 180° | 270°.
- **Páginas**: rango from/to (default todas).
- **Capa**: sobre el contenido (default) | debajo del contenido.

## Add Page Numbers
- **Modo de página**: Página única (default) | Páginas enfrentadas (facing).
- **Posición**: grid 3×3 de anclas (default abajo-centro o abajo-derecha).
- **Margen**: Pequeño | Recomendado (default) | Grande.
- **Primer número**: input numérico (default 1).
- **Qué páginas numerar**: from/to (default todas).
- **Formato de texto**: Solo el número (default, recomendado) | "Página {n}" | "Página {n} de {p}" | Personalizado (placeholders {n} y {p}).
- **Tipografía**: dropdown (Arial default), tamaño, color.

## Protect PDF
- Modo simple: contraseña + repetir contraseña, medidor de fortaleza. CTA directo.
- Modo avanzado (premium en referencia): restricciones de permisos (imprimir, copiar, editar). En OptimusPDF: cifrado AES con @cantoo/pdf-lib, permisos si la lib lo soporta.

## Merge PDF
- Multi-archivo; miniaturas de portada de cada PDF en grid central, drag para reordenar, botón rotar por archivo, ordenar A-Z/Z-A. Sidebar solo confirma orden. CTA "Unir".

## Rotate / Organize (no se pudo inyectar el workspace; patrón conocido)
- Rotate: miniaturas de todas las páginas/archivos, botones 90° izquierda/derecha aplicables a todo o por página, reset.
- Organize: grid de miniaturas de páginas, drag para reordenar, hover con acciones por página (rotar, eliminar), botón añadir otro PDF (inserta sus páginas).

## Flujo compartido observado
1. Landing de herramienta: título + subtítulo + botón grande "Seleccionar archivo(s)" + drop zone en toda la página + fuentes cloud.
2. Workspace: preview central (miniaturas) + sidebar derecha de opciones con título de la herramienta + CTA fijo abajo de la sidebar.
3. Barra flotante para añadir más archivos.
4. Procesando: overlay con spinner/progreso y mensaje de acción en gerundio.
5. Descarga: botón grande primario, opciones secundarias (volver a empezar), sugerencias de herramientas relacionadas ("continúa con…").
6. En móvil la sidebar de opciones se convierte en panel/paso posterior — en OptimusPDF será bottom sheet iOS.

## Mapa para workstreams
- WS-A (organizar): merge (patrón ya hecho en CORE), split (modos arriba), remove/extract (variantes de selección de páginas sobre PageThumbnailGrid), organize (grid drag), rotate.
- WS-B (convertir): jpg→pdf (orientación vertical/horizontal, margen none/small/big, tamaño página A4/carta/ajustar a imagen, checkbox combinar en un PDF), pdf→jpg (elegir página/todas, calidad, ZIP si varias), scan (getUserMedia).
- WS-C (editar): watermark y page numbers (arriba), crop (arrastrar selección sobre preview, aplicar a todas o una), sign (canvas dibujo/teclear con fuentes cursivas/subir PNG, arrastrar al preview, redimensionar), compare (dos uploads lado a lado, diff textual resaltado).
- WS-D (seguridad/optimizar): compress (arriba), protect (arriba), unlock (pedir contraseña actual), redact (dibujar cajas negras + aplanar), ocr (idiomas, lazy tesseract).
