# Funcionalidades que sí requieren servidor (lista viva)

Este archivo existe para no perder de vista, en el futuro, qué funcionalidades genuinamente necesitarían que OptimusPDF deje de ser 100% client-side (o llame a un backend propio) — a diferencia de cosas que *parecen* necesitar servidor pero no lo necesitan. Se actualiza cada vez que una investigación (como la de `docs/competitive-analysis.md`, 2026-07-30) confirma o descarta un caso.

## Corrección importante de esta investigación (2026-07-30)

Antes de esta investigación, las 6 herramientas de conversión Office↔PDF (`word-to-pdf`, `excel-to-pdf`, `powerpoint-to-pdf`, `pdf-to-word`, `pdf-to-excel`, `pdf-to-powerpoint`, todas `status: "soon"` en `src/lib/tools-registry.ts`) estaban en un limbo de "no implementadas todavía" sin que quedara explícito si necesitaban servidor. **Investigación de competidores reales confirma que NO lo necesitan**: BentoPDF (bentopdf.com, código abierto) las resuelve 100% client-side compilando PyMuPDF a WebAssembly. Ver el detalle completo, incluyendo la disyuntiva de licencia (AGPL) que eso trae, en `docs/future-roadmap.md` Tier 1.

**Estas 6 herramientas se retiran de esta lista** — no requieren servidor, requieren una decisión de licencia de software (documentada en el roadmap), que es un problema distinto.

## Confirmado: SÍ requiere un servidor propio (o de un tercero)

Ninguna funcionalidad de OptimusPDF cae hoy en esta categoría. Se deja la tabla vacía a propósito, con la estructura lista para cuando aparezca una:

| Funcionalidad | Por qué necesita servidor | Es servidor propio o de terceros | Estado |
|---|---|---|---|

## Zona gris: llama a un servicio de un tercero, pero no requiere que OptimusPDF construya/mantenga backend propio

Esto es distinto de "necesita servidor" en el sentido que le preocupa a la regla de arquitectura del proyecto (nunca subir los archivos del usuario a un servidor nuestro) — aquí el archivo del usuario nunca sale del navegador, pero una funcionalidad puntual sí depende de un servicio externo que no operamos:

- **Sellado de tiempo RFC 3161** (idea de Tier 2 del roadmap): para sellar criptográficamente que un documento existía en cierta fecha, hay que consultar un servidor TSA (Time Stamp Authority) de un tercero de confianza — no hay forma de hacer esto sin una consulta de red a alguien, por diseño del estándar. El archivo del usuario no viaja (solo un hash), pero sí hay una llamada de red saliente que no existía antes. Documentar claramente en la UI qué dato específico sale (el hash, no el documento) si se implementa.
- **Descarga de modelos de IA/OCR desde un CDN externo** (ya existente hoy, no es nuevo): `pdf-summarizer` descarga los pesos del modelo desde huggingface.co/raw.githubusercontent.com; `pdf-to-markdown` descarga los assets de tesseract.js desde cdn.jsdelivr.net. Esto NO es "nuestro servidor" — es descarga de software/modelos públicos, exactamente igual que cargar un `<script src>` de una CDN. El documento del usuario nunca se envía a ningún lado en ninguno de los dos casos. Se mantiene aquí solo para que quede constancia de que sí hay tráfico de red saliente, aunque no sea el problema de privacidad que esta regla busca evitar.

## Si en el futuro se considera esto, requiere cambiar la regla de arquitectura del proyecto primero (no es una decisión técnica de una fase cualquiera)

Estas ideas SÍ requerirían backend/cuenta/base de datos real si algún día se piden — se anotan aquí precisamente para que quede claro que son un cambio de arquitectura fundamental (afecta la promesa central "tus archivos nunca salen del navegador"), no una funcionalidad más:

- Sincronizar plantillas o datos guardados entre dispositivos de un mismo usuario (hoy la idea de "vault" local del roadmap vive solo en el dispositivo, a propósito).
- Colaboración en tiempo real entre varios usuarios sobre el mismo documento (requiere un servidor de sincronización).
- Funcionalidades de equipo/empresa (plantillas compartidas entre una organización, historial de auditoría centralizado).
- Enviar un documento firmado por correo directamente desde la app (requiere un backend de envío de correo o una API key de un servicio de terceros gestionada por nosotros).

## Cómo usar este archivo

Cuando una nueva funcionalidad candidata aparezca (en una fase de plan, en una investigación de competidores, o en un pedido del usuario), clasificarla explícitamente en una de las tres secciones de arriba antes de asumir que necesita servidor. La lista de "confirmado, sí necesita servidor" debe permanecer vacía el mayor tiempo posible — cada entrada ahí es una desviación real de la arquitectura 100% client-side del proyecto y debería requerir aprobación explícita del dueño del producto antes de implementarse.
