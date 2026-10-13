# Herramientas de OptimusPDF y su cobertura en PDF Pro

Estado al 2026-10-13 (commit `4e28bba`). 36 herramientas sueltas en `src/lib/tools-registry.ts` (35 activas, 1 «próximamente») más PDF Pro.

Leyenda de la columna **En PDF Pro**: **Sí** = ya se puede hacer dentro de PDF Pro sobre el documento abierto; **Parcial** = existe una parte; **No** = solo existe como herramienta suelta.

## Organizar

| Herramienta | Qué hace | En PDF Pro |
|---|---|---|
| Unir PDF | Combina varios PDF en uno y decide el orden | **Sí** · Páginas → unir (otro PDF) |
| Dividir PDF | Parte por rangos, cada N páginas o secciones sueltas en un ZIP | **Sí** · Páginas → dividir |
| Eliminar páginas | Quita páginas marcándolas sobre miniaturas | **Sí** · Páginas |
| Extraer páginas | Crea un PDF nuevo solo con las páginas elegidas | **Sí** · Páginas → extraer |
| Organizar PDF | Reordena, gira y elimina en una vista de miniaturas | **Sí** · Páginas (además duplicar e insertar en blanco / otro PDF / imagen) |
| Rotar PDF | Gira páginas o el documento en múltiplos de 90° | **Sí** · Páginas y Documento |
| PDFs a ZIP | Empaqueta varios PDF en un ZIP sin fusionarlos | **No** · trabaja con varios archivos a la vez; no encaja en un editor de un solo documento |

## Optimizar

| Herramienta | Qué hace | En PDF Pro |
|---|---|---|
| Comprimir PDF | Reduce el peso reprocesando imágenes y limpiando objetos | **Sí** · Documento |
| Reparar PDF | Reconstruye la estructura de documentos dañados | **Sí** · Documento |
| OCR de PDF | Reconoce el texto de escaneados para buscarlo y copiarlo | **Sí** · Documento |

## Convertir a PDF

| Herramienta | Qué hace | En PDF Pro |
|---|---|---|
| Imagen a PDF | JPG/PNG/WEBP a PDF con tamaño, margen y orientación | **Sí** · nuevo desde imágenes e insertar imagen |
| Word a PDF | DOC/DOCX a PDF | **Sí** · insertar desde Word |
| Excel a PDF | XLS/XLSX a PDF paginado | **Sí** · insertar desde Excel |
| HTML a PDF | Página web o archivo HTML a PDF | **Sí** (archivo HTML) · insertar desde HTML |
| PowerPoint a PDF | PPT/PPTX a PDF | **No** · la herramienta suelta aún está «próximamente» |
| Escanear a PDF | Usa la cámara del móvil como escáner | **No** · cámara; sería «nuevo desde cámara» |

## Convertir desde PDF

| Herramienta | Qué hace | En PDF Pro |
|---|---|---|
| PDF a JPG | Cada página como imagen, en ZIP | **Sí** · Convertir → imágenes (JPG/PNG, rango o selección) |
| PDF a Word | DOCX editable | **Sí** · Convertir |
| PDF a PowerPoint | PPTX con una imagen por diapositiva | **Sí** · Convertir |
| PDF a Excel | Tablas a XLSX | **Sí** · Convertir |
| Extraer tablas | Tablas a CSV o JSON | **Sí** · Convertir (CSV) |
| PDF a Markdown | Texto como Markdown | **Sí** · Convertir |
| PDF a Texto | Texto plano por páginas | **Sí** · Convertir |
| PDF a JSON | PDF completo como JSON estructurado | **Sí** · Convertir |
| Verificar PDF/A | Revisa si cumple PDF/A y qué le falta (no convierte) | **No** |

## Editar y analizar

| Herramienta | Qué hace | En PDF Pro |
|---|---|---|
| Editar PDF | Edita el texto existente y añade texto, imágenes y formas | **Sí** · Editar y Anotar |
| Firmar PDF | Dibuja, escribe o sube tu firma; varios firmantes; baúl de firmas; rellenar formularios | **Parcial** · Firmar y Rellenar sobre un documento; **falta** firmar varios documentos a la vez (ZIP) |
| Numerar páginas | Numeración con posición, formato y tipografía | **Sí** · Documento |
| Marca de agua | Texto o imagen con opacidad, rotación y mosaico | **Sí** · Documento |
| Recortar PDF | Ajusta márgenes sobre la vista previa | **Sí** · Documento |
| Comparar PDF | Enfrenta dos versiones y resalta diferencias de texto | **No** |
| Resumir PDF | Resumen con puntos clave | **No** · depende de un modelo local (WebGPU) |
| Informe de traducción | Traduce el texto con un modelo local y genera un informe bilingüe | **No** · depende de un modelo local (WebGPU) |

## Seguridad

| Herramienta | Qué hace | En PDF Pro |
|---|---|---|
| Proteger PDF | Cifra con contraseña | **Sí** · Proteger |
| Desbloquear PDF | Quita la contraseña o la certificación de una firma | **Sí** · Proteger |
| Censurar PDF | Tapa datos sensibles con cajas opacas y aplana la página | **No** · el modo «redact» está reservado en el contrato de modos (`ProModeId`), pero no está construido |

## Cabecera/pie y metadatos (solo en PDF Pro, sin herramienta suelta)

PDF Pro añade además **encabezado y pie** y **metadatos** (Documento), historial de deshacer/rehacer de todo lo hecho, exportar a 8 formatos, guardar con contraseña, recientes y borradores.

## Resumen

- **Ya están (27):** unir, dividir, eliminar, extraer, organizar, rotar, comprimir, reparar, OCR, imagen a PDF, Word a PDF, Excel a PDF, HTML a PDF, los 8 «PDF a …», editar, numerar, marca de agua, recortar, proteger, desbloquear.
- **Parcial (1):** Firmar (falta firmar varios documentos a la vez).
- **Faltan (8):** Censurar, Comparar, Verificar PDF/A, Escanear a PDF, Resumir, Informe de traducción, PDFs a ZIP y PowerPoint a PDF (esta última ni siquiera está activa como herramienta suelta).

## Esfuerzo y valor estimados de lo que falta

| Falta | Valor en una suite tipo Acrobat | Esfuerzo | Notas |
|---|---|---|---|
| Censurar | Alto (privacidad, es una función estrella de Acrobat) | Medio | El modo `redact` ya está reservado; la herramienta suelta existe (canvas de cajas + aplanado). Hay que integrarla como modo con «Aplicar» y deshacer |
| Comparar | Medio | Medio | Necesita un segundo documento; encaja como panel en Documento |
| Verificar PDF/A | Bajo-medio | Bajo | Solo informa; encaja como panel en Documento |
| Escanear a PDF | Medio (móvil) | Medio | Usa la cámara; como «Nuevo desde cámara» en el estado vacío |
| Firmar varios documentos | Medio | Alto | PDF Pro trabaja con un documento a la vez; mejor dejarlo en la herramienta suelta |
| Resumir / Traducir | Bajo-medio | Alto | Modelos locales pesados (WebGPU); solo si lo pides |
| PDFs a ZIP | Bajo | — | No tiene sentido en un editor de un documento |
| PowerPoint a PDF | Medio | Alto | Primero habría que activarla como herramienta suelta |
