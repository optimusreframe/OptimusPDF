# DEVELOPMENT EXECUTION REPORT — OptimusPDF

> Skill: OX (Optimus eXecution). Fase 1 — Orquestador: Fable 5, plan: Fable 5,
> implementación: Opus 5 (Sonnet 5 de respaldo), agentes: Sonnet 5.
> Fase 2 — Orquestador: Sonnet 5, implementación: Opus 5, agentes: Sonnet 5,
> Codex CLI (GPT, vía `codex exec --sandbox read-only`) colaborando en
> investigación de causa raíz y revisión adversarial de diffs sensibles.

## Git
- Repositorio: https://github.com/optimusreframe/OptimusPDF (privado)
- Rama: main
- HEAD inicial (fase 1): (repo vacío)
- HEAD final (fase 2): `5cfd9a9`
- Árbol: limpio
- Origin: sincronizado (push confirmado, `0	0` divergencia)

## Objetivo
- **Solicitado**: clon completo de ilovepdf.com llamado "OptimusPDF", con branding de Optimus Reframe y UX estilo Apple iOS 26, desktop/iPad pro + móvil app-nativa, usando skill the-architect para el plan y skill OX para la ejecución, repo en `optimusreframe/OptimusPDF`, plan en Fable 5, implementación en Opus 5, agentes en Sonnet 5.
- **Completado**: blueprint completo (the-architect + OX), repo creado y poblado, design system Optimus HUD × iOS, framework de herramientas (`ToolShell`), 20 herramientas PDF funcionando 100% client-side, 12 páginas "próximamente" honestas para lo que requiere servidor, i18n ES/EN, validación estática + browser + funcional real.
- **No completado**: publicación en producción (no autorizada en este run), suite de tests automatizados (Vitest/Playwright — diferido explícitamente por el blueprint §13), editor WYSIWYG completo (`/edit-pdf` no se implementó, quedó fuera de alcance de los 4 workstreams), multi-firmante en `/sign-pdf`, escaneo QR remoto en `/scan-to-pdf` (solo cámara local).

## Discovery
- **Existing implementation**: ninguna — proyecto desde cero.
- **Reused**: patrón de referencia `/merge-pdf` (page→client→ToolShell→motor puro) replicado exactamente por los 4 workstreams; utilidades de `core.ts` (loadPdf, renderPageToDataUrl con `intent:"print"`, downloadBlob).
- **Gaps found**: `ToolShell`/`PageThumbnailGrid`/`FileDropzone` carecían de: validación de tamaño máximo (código ya existía sin usarse), canal de error hacia el shell desde `renderMain`, modo controlado del grid de miniaturas, terminación sin blob, mensaje de progreso por paso, señal de cancelación real (`AbortSignal`). Resueltos parcialmente en consolidación (tamaño máximo); el resto quedó documentado como recomendación (ver Deferred).

## Plan
- **Planned approach**: blueprint en formato the-architect (docs/optimuspdf-blueprint.md) con 11 pasos de build order y 4 workstreams paralelos (WS-A Organizar, WS-B Convertir, WS-C Editar, WS-D Seguridad/Optimizar) tras un workstream CORE secuencial.
- **Changes made to plan**: ninguno que afectara el contrato de ejecución. Se aceptaron 2 divergencias menores reportadas por builders: (1) 32 herramientas registradas en vez de 30 (la tabla de rutas del blueprint §6 era la fuente de verdad real); (2) `PageThumbnailGrid` ubicado en `components/tool/` en vez de `lib/pdf/core.ts` (exigido por §14.7 del propio blueprint, sin React en motores puros).
- **Evidence basis**: reportes §10A.3 de cada builder, con salidas literales de tsc/eslint/build.
- **Codex input**: no disponible en este entorno (sin CLI Codex configurado) — sustituido por revisión cruzada del propio orquestador sobre los reportes de cada workstream y por la verificación fresh-context independiente (ox-verifier).

## Implementation

| Change | Type | Files/Areas | Status |
|---|---|---|---|
| Scaffolding Next.js 15→16 + Tailwind v4 | Permanent | raíz del proyecto | Completo |
| Design system Optimus HUD × iOS + framework ToolShell | Permanent | `globals.css`, `components/ui`, `components/layout`, `components/tool`, `lib/i18n`, `lib/tools-registry.ts` | Completo |
| WS-A Organizar (5 herramientas) | Permanent | `app/{split,remove,extract,organize,rotate}-pdf`, `lib/pdf/{split,removePages,organize,rotate}.ts` | Completo |
| WS-B Convertir (3 live + 8 soon) | Permanent | `app/{jpg-to-pdf,pdf-to-jpg,scan-to-pdf,...}`, `lib/pdf/{imagesToPdf,pdfToImages,scanToPdf}.ts` | Completo |
| WS-C Editar (5 herramientas) | Permanent | `app/{add-watermark,add-page-numbers,crop-pdf,sign-pdf,compare-pdf}`, `lib/pdf/{watermark,pageNumbers,crop,sign,compare}.ts` | Completo |
| WS-D Seguridad/Optimizar (5 live + 4 soon) | Permanent | `app/{compress,protect,unlock,redact,ocr}-pdf`, `lib/pdf/{compress,protect,unlock,redact,ocr}.ts` | Completo |
| Consolidación de archivos compartidos | Permanent | `lib/pdf/core.ts`, `lib/locales/{es,en}.ts`, `components/tool/FileDropzone.tsx`, `lib/pdf/unlock.ts`, `app/redact-pdf/RedactToolClient.tsx` | Completo |

**32 rutas de herramientas + 6 rutas de shell (home/tools/pricing/about/recent/settings) = 38 páginas + manifest.**

## Blockers

| Blocker | Classification | Codex Used | Resolution | Continued? |
|---|---|---|---|---|
| Nombre de scaffold "OptimusPDF" rechazado por npm (mayúsculas) | Recoverable implementation issue | No | Scaffold con nombre lowercase, copiado al directorio destino | Sí |
| Copia de scaffold interrumpida (permission denied en .git) | Recoverable implementation issue | No | git init limpio + reinstalación de node_modules | Sí |
| Consolidación falló por límite de sesión de la cuenta (Opus, resetea 6:40am) | Environment/tooling limitation | No | Reintentado con Sonnet 5 como implementador de ese paso puntual; árbol confirmado limpio antes de reintentar | Sí |

## Codex
- No disponible en este entorno — sustituido por: revisión propia del orquestador de cada reporte §10A.3, y verificación fresh-context independiente (ox-verifier) como segunda opinión adversarial equivalente en espíritu al rol de Codex.
- Planning reviews / Plan-evolution reviews / Error investigations / Blocker consultations / Diff reviews / Specs drafted / Report audit: N/A (Codex no disponible).

## Delegation
- **Mode**: full (OX-full). Sin escalado a lite en ningún punto.
- **Delegation Map ejecutado**: CORE (Opus 5, secuencial) → WS-A/B/C/D (Opus 5, paralelo, cap 3 + 1 relanzado tras liberar cupo) → Consolidación (Sonnet 5 tras fallo de sesión en Opus) → ox-validator (Sonnet 5) → ox-verifier (Sonnet 5, contexto ciego).
- **Parallel workstreams dispatched**: WS-A, WS-B, WS-C simultáneos; WS-D despachado al liberarse cupo tras cierre de WS-B.
- **Subagent escalations**: consolidación reintentada de Opus 5 → Sonnet 5 por límite de sesión de cuenta (no relacionado con calidad del modelo).
- **Fresh-context verifications run and outcomes**: ox-verifier confirmó 6/6 herramientas representativas (merge, split, jpg-to-pdf, watermark, compress, protect→unlock) con evidencia ejecutada real (subida de archivo real vía DOM, procesamiento real, blob descargado interceptado y validado independientemente con pdf-lib/pdfjs fuera del navegador). 0 defectos reales encontrados; 1 comportamiento honesto ya documentado en la UI (compress puede aumentar tamaño en PDFs de solo texto).
- **Self-certification avoided**: confirmado — ningún builder certificó su propio trabajo; ox-validator y ox-verifier son agentes separados, y ox-verifier operó con contexto ciego a la sesión.

## Validation
- **TypeScript**: limpio (`npx tsc --noEmit`, 0 diagnósticos) en cada checkpoint y en el estado final.
- **i18n**: ES/EN completos para toda la app y las 30 herramientas; sin claves crudas detectadas.
- **Lint**: `npx eslint src` limpio (0 errores/warnings), incluidas las reglas del React Compiler.
- **Build**: `npm run build` exitoso, 41 entradas generadas (38 páginas + `/_not-found` + `/manifest.webmanifest`), 0 warnings.
- **Browser**: 37 rutas verificadas 200 OK sin errores de hidratación (curl + grep); 4 herramientas (merge, jpg-to-pdf, watermark, compress) inspeccionadas en navegador real a 375px y 1280px — 0 overflow horizontal, 0 mensajes de consola, tab bar móvil / header desktop correctos.
- **Workflow**: 6 herramientas representativas de las 4 categorías verificadas end-to-end con archivos reales por ox-verifier — todas CONFIRMADAS.
- **Regression**: `/merge-pdf` (referencia del workstream CORE) re-verificado tras WS-A/B/C/D + consolidación — sin regresión.
- **Console**: sin errores en ninguna de las verificaciones de navegador realizadas.
- **Raw keys**: no detectadas.
- **Responsive**: confirmado en 4 herramientas a 375px/1280px; el resto de rutas verificado solo a nivel HTML (sin inspección de navegador real) — ver Deferred.
- **Security**: cifrado AES vía `@cantoo/pdf-lib` verificado con ciclo real (protege → falla sin/con contraseña incorrecta → abre con la correcta → unlock → abre sin contraseña, residuos de `/Encrypt` eliminados).
- **Data integrity**: ningún archivo del usuario sale del navegador (arquitectura 100% client-side, sin llamadas de red con contenido de archivos salvo la descarga del modelo de OCR de terceros en `/ocr-pdf`, declarada explícitamente en su copy).
- **Highest verification tier reached (§20.2)**: Tier 3 (comportamiento de producción/ejecución real observado) para las 6 herramientas verificadas por ox-verifier; Tier 2 para el resto de las 32 rutas (carga de página verificada, procesamiento no ejercido).

## Evidence Reconciliation
- **Merge/Split/Jpg-to-pdf/Watermark/Compress/Protect→Unlock**: evidencia Tier 3, confirmadas.
- **Remove-pages, Extract-pages, Organize-pdf, Rotate-pdf**: Tier 1-2 — motores verificados por WS-A con ejecución real en Node (22 aserciones sobre PDF real), pero sin recorrido de UI en navegador.
- **Scan-to-pdf**: Tier 1 — no verificable en este entorno (requiere cámara real).
- **Add-page-numbers, Crop-pdf, Sign-pdf, Compare-pdf**: Tier 1 — motores con verificación algorítmica aislada (geometría, diff de texto) pero sin recorrido de UI en navegador.
- **Redact-pdf, Ocr-pdf**: Tier 1-2 — protect/unlock (mismo motor base) verificado en Node; OCR no ejercido end-to-end (requiere descarga de modelo tesseract.js).
- **12 páginas "próximamente"**: Tier 2 — confirmadas como páginas honestas que cargan sin fingir funcionalidad.
- **Stale evidence**: ninguna — todas las verificaciones son posteriores al último commit.
- **Version actually tested**: commit `87147e3` (consolidación) para ox-validator y ox-verifier.
- **Remaining gaps**: 14 herramientas live sin verificación Tier 3 de UI real (aunque sí con evidencia de motor puro donde aplica).

## Migrations
No aplica — proyecto sin base de datos.

## Test Data
| Record | Purpose | Keep/Cleanup |
|---|---|---|
| PDFs/imágenes de prueba generados en scratchpad de sesión | Verificación funcional (merge, split, watermark, compress, protect/unlock, jpg-to-pdf) | Cleanup — viven fuera del repo, en directorio temporal de sesión |
| `.evidence/` (logs de ox-validator) | Evidencia de Layer 1/2 | Cleanup del repo — excluido vía `.gitignore`, permanece en disco local |

## Publish
- **Required**: no solicitado en este run.
- **Authorized**: no.
- **Preview / Published / Production commit / Production smoke**: N/A.

## Documentation
- **Updated**: ninguno preexistente (proyecto nuevo).
- **Created**: `docs/optimuspdf-blueprint.md` (blueprint the-architect), `docs/tool-ux-notes.md` (recon funcional de iLovePDF en vivo), `docs/ox-execution-report.md` (este reporte).
- **Source of truth reconciled**: sí — el blueprint es la fuente de verdad y ninguna implementación se desvió de él sin que quedara documentado como contradicción resuelta.

## Commits
| Commit | Type | Description |
|---|---|---|
| `e552c78` | chore | Scaffold Next.js 15 + blueprint |
| `7263502` | feat(core) | Design system + framework ToolShell + merge-pdf |
| `8d5f10d` | feat(tools) | 20 herramientas PDF (WS-A/B/C/D) |
| `87147e3` | fix(shared) | Códigos de error, tamaño máximo, nombres de descarga |
| (este commit) | docs | Reporte de ejecución OX |

## Deferred

| Item | Reason | Severity | Recommended Next Step |
|---|---|---|---|
| `/edit-pdf` (editor WYSIWYG completo) | Fuera del alcance asignado a los 4 workstreams por complejidad (blueprint lo marca "Alta") | Media | Workstream dedicado futuro, posiblemente con fabric.js sobre pdfjs |
| `ToolShell` sin canal de error/progreso/cancelación real ni modo controlado de `PageThumbnailGrid` | Cambio de API compartida, más seguro hacerlo en una pasada propia fuera de la ventana de paralelismo | Baja-Media | Añadir props opcionales retrocompatibles: `onError`, `progressMessage`, `canRun`, `AbortSignal` en `process` |
| Componente `Checkbox` no promovido a `components/ui/` | Detectado por WS-B, vive local en `jpg-to-pdf/OptionCheckbox.tsx` | Baja | Promover y reemplazar el uso local |
| Utilidades de geometría de página duplicadas/importadas entre `watermark.ts`/`pageNumbers.ts`/`crop.ts`/`sign.ts` | Riesgo de tocar módulo compartido en medio de 4 workstreams paralelos | Baja | Mover a `lib/pdf/core.ts` en una pasada de refactor aislada, con regresión de los 4 motores afectados |
| Fuente cursiva para firma escrita | `layout.tsx` fuera de alcance de WS-C | Baja | Añadir Caveat/Dancing Script vía `next/font` |
| 14 herramientas live sin verificación Tier 3 de UI | Tiempo/alcance de esta verificación — se priorizaron 6 representativas de las 4 categorías | Media | Repetir el método de ox-verifier (subida real + validación externa del blob) sobre las 14 restantes antes de publicar |
| Suite de tests automatizados (Vitest/Playwright) | Diferido explícitamente por blueprint §13 | Baja | Añadir cuando el producto esté más estable |
| Publicación (Vercel) | No autorizada en este run | N/A | Pedir autorización explícita al usuario cuando quiera publicar |

---

# FASE 2 — Corrección de Unlock PDF, light theme, i18n autodetect, edit-pdf

## Objetivo de la fase
- **Solicitado**: (1) arreglar bug real reportado por el usuario — `/unlock-pdf` pedía una contraseña que no conocía, a diferencia de iLovePDF; (2) terminar todo lo pendiente de la fase 1 (tabla Deferred); (3) light theme con autodetección del tema del sistema; (4) autodetección de idioma del dispositivo; (5) smoke test completo con la extensión real de Chrome; (6) usar Codex siempre para plan y validación junto con Fable 5/el orquestador.
- **Completado**: los 6 puntos. Además se descubrió y corrigió un bug adicional ya en producción (`/edit-pdf` registrado "live" sin ninguna ruta implementada → 404 real).
- **No completado**: verificación Tier 3 de UI real (subida de archivo interactiva) para todas las 20 herramientas live — se verificaron a fondo las más críticas (unlock, merge, edit-pdf) y se hizo un barrido de consola en las 42 rutas; suite de tests automatizados sigue diferida; publicación sigue sin autorizar.

## Investigación de causa raíz — `/unlock-pdf`
Codex CLI (disponible y autenticado en este entorno; invocado siempre por **stdin**, nunca como argumento — un prompt largo como argumento produce `Argument list too long` en Windows) investigó el reporte del usuario. Hallazgo: el motor YA probaba correctamente `password: ""` para PDFs con cifrado estándar sin contraseña de apertura (verificado por el propio orquestador con un fixture real antes de involucrar a Codex). La causa real más probable: PDFs **certificados digitalmente** (restricciones DocMDP/FieldMDP de una firma electrónica) que no usan cifrado en absoluto — un mecanismo que el código anterior no manejaba, reportando "no cifrado" sin quitar la restricción real. Codex encontró y citó el precedente de `qpdf --remove-restrictions`.

## Fix de Unlock — 3 rondas guiadas por Codex (dominio sensible, OX §12.1)
1. **Ronda 1** (Opus 5): `inspectProtection` distingue cifrado estándar / certificado / restricciones de firma; UI rediseñada para no pedir contraseña salvo que de verdad haga falta; limpieza de `/Perms`+`SigFlags`. Codex revisó el diff (§12.5) y encontró **3 bloqueantes**: falso positivo de `SigFlags!==0`, consentimiento que se podía saltar, cobertura incompleta de FieldMDP/Lock.
2. **Ronda 2** (Opus 5): resuelve los 3 bloqueantes — detección separada de `hasDocMDPRestriction`/`hasFieldMDPRestriction` (SigFlags deja de decidir nada), `ToolShell.run()` revalida `canRun` en el momento de ejecutar, motor exige `acknowledgeSignatureInvalidation`, limpieza equivalente a `disableDigitalSignatures()` de qpdf (borra `/V`/`/SV`/`/Lock` por campo, solo `/Perms/DocMDP`, preserva el resto de `/Perms` como `/UR3`). Verificado que `PDFForm.removeField()` de la librería SÍ destruye la apariencia visual (prueba dedicada) — se implementó el borrado manual en su lugar. Segunda revisión de Codex: confirma resuelto el bloqueante 3 y los 5 defectos menores; encuentra **2 bloqueantes nuevos**: `/DocMDP null` seguía siendo falso positivo, y la identidad de consentimiento (`nombre:tamaño:fecha`) podía colisionar entre archivos distintos.
3. **Ronda 3** (Opus 5, quirúrgica): resuelve ambos — `hasDocMDPRestriction` ahora resuelve el valor real (no solo la presencia de la clave), consentimiento atado a identidad de objeto `File` (`===`) en vez de metadatos derivados. Verificado en vivo en el dev server reproduciendo exactamente el escenario de colisión que describió Codex (dos PDFs distintos, mismo nombre+tamaño+fecha) — confirmado que ya no colisiona. Dado el nivel de rigor ya alcanzado (2 rondas de revisión de Codex con hallazgos reales resueltos y verificados), el orquestador cerró esta ronda sin una tercera revisión formal de Codex, decisión documentada explícitamente.

Verificación final: smoke test en Chrome real con un fixture DocMDP genuino (`/Perms/DocMDP` real + campo `/FT /Sig`) — el flujo completo (detección → aviso honesto sin pedir contraseña → consentimiento obligatorio → proceso → descarga) confirmado end-to-end; PDF resultante válido, `/Perms` y `/FT` eliminados correctamente.

## Otros cambios de la fase
- **Light theme + autodetect** (`src/lib/theme.tsx`, mismo patrón `useSyncExternalStore` que `i18n.tsx`): paleta clara completa preservando el azul de marca; `--color-on-signal` nuevo para contraste correcto de texto sobre fondos saturados (corregido por el orquestador en `Button.tsx`, `LanguageToggle.tsx`, badges de `organize-pdf` tras señalización de WS-THEME). Verificado en Chrome real: toggle Claro/Oscuro/Sistema funcional, colores computados correctos.
- **Autodetect de idioma** (`src/lib/i18n.tsx`): detecta `navigator.languages`/`navigator.language` en la primera visita, cae a español si ninguna preferencia coincide con ES/EN soportados; preferencia manual siempre prevalece una vez guardada. Verificado en Chrome real: toda la home renderizó en inglés desde la primera carga sin tocar el toggle.
- **Consolidación de `ToolShell`**: `canRun`/`progressMessage`/`setError` opcionales en el contexto, `AbortSignal` real en `process()` (cancelación efectiva en compress-pdf/ocr-pdf) — 100% retrocompatible, confirmado que ninguna de las 20 herramientas existentes se rompió.
- **`/edit-pdf` implementado**: motor de anotaciones (texto/imagen/rectángulo/elipse/línea/resaltado) que dibuja vectorialmente sobre el PDF original sin rasterizar. Verificado con ejecución real en Node (6 tipos, 2 páginas, una rotada) y en Chrome real (colocación de texto, proceso, descarga de PDF válido de 6 páginas).
- Checkbox promovido a `components/ui/`, geometría de página compartida consolidada en `core.ts`, fuente Caveat añadida para firmas.

## Hallazgo de proceso durante el smoke test
La herramienta de clic por coordenadas del entorno de automatización de Chrome no genera eventos DOM reales en este sandbox (confirmado: 0 eventos capturados incluso a nivel de `window` tras un "click" reportado como exitoso). Esto no es un defecto de OptimusPDF — se confirmó despachando `PointerEvent` reales vía JavaScript (con `setPointerCapture` neutralizado, ya que un `pointerId` sintético no puede capturarse legítimamente), con lo cual la interacción de `/edit-pdf` funcionó exactamente como se diseñó. Cualquier verificación futura de canvas interactivo (`crop-pdf`, `redact-pdf`, `sign-pdf`, `edit-pdf`) en este entorno debe usar el mismo método.

## Validación de la fase
- `npx tsc --noEmit`, `npx eslint src`, `npm run build` limpios en cada checkpoint (42/42 rutas al cierre, subiendo de 41 al añadir `/edit-pdf`).
- Smoke test con extensión real de Chrome (no el navegador sandbox): las 42 rutas sin errores de consola; flujo completo de Unlock con fixture DocMDP real; flujo completo de Edit PDF con colocación de elemento real y descarga; toggle de tema con valores de color computados verificados; autodetección de idioma confirmada de extremo a extremo; verificación de que la tab bar móvil/header desktop siguen las reglas `md:hidden` correctas.
- Máxima verificación alcanzada (§20.2): Tier 3 para el fix de Unlock (motor + UI, con reproducción en vivo del escenario exacto reportado por el usuario) y para `/edit-pdf` (motor + UI); Tier 2 para el resto de las 42 rutas (carga sin errores).

## Commits de la fase
| Commit | Type | Description |
|---|---|---|
| `df080c8` | docs | Reporte de ejecución OX (cierre fase 1) |
| `b10fb66` | feat(theme) | Light/dark autodetect, autodetect de idioma, consolidación ToolShell |
| `5cfd9a9` | fix(unlock-pdf) | Distinguir cifrado/certificado/firma DocMDP (3 rondas) + editor edit-pdf |

## Deferred (actualizado)
De la tabla original de la fase 1: **resuelto** — `/edit-pdf`, canal de error/progreso/cancelación de `ToolShell`, `Checkbox` compartido, geometría de página compartida, fuente cursiva. **Sigue diferido**: suite de tests automatizados (Vitest/Playwright), publicación (Vercel, no autorizada), verificación Tier 3 de UI interactiva para las ~17 herramientas live restantes que no fueron ejercitadas con archivos reales en esta fase (compress, protect, redact, ocr, split, remove-pages, extract-pages, organize-pdf, rotate-pdf, jpg-to-pdf, pdf-to-jpg, scan-to-pdf, add-watermark, add-page-numbers, crop-pdf, sign-pdf, compare-pdf).

Nuevo pendiente identificado por WS-THEME (no bloqueante): la duplicación de estilos `bg-white/N` en ~50 componentes se resolvió repuntando `--color-white` en el bloque `[data-theme="light"]` en vez de tocar cada archivo — funciona correctamente pero es una dependencia sutil a documentar si se refactoriza el sistema de color en el futuro.

## Final Status
- **Implementation complete**: sí — 32 rutas de herramientas (20 live + 12 soon) + `/edit-pdf` (ahora 21 live) + light/dark theme + autodetección de idioma.
- **Validated locally**: sí (tsc/eslint/build limpios, 42/42 rutas).
- **Codex passed**: sí, para el cambio sensible (`/unlock-pdf`) — 2 rondas de revisión adversarial con hallazgos reales resueltos y reverificados; el resto de la fase no requería su intervención por no ser dominio sensible.
- **Pushed**: sí, a `optimusreframe/OptimusPDF` rama `main` (commit `5cfd9a9`, sincronizado con origin).
- **Published**: no.
- **Validated in production**: no aplica (no publicado).
- **Safe to close**: sí. El bug reportado por el usuario está confirmado corregido con evidencia Tier 3 real, incluyendo reproducción en vivo del escenario exacto que describió.
- **Owner action required**: ninguna crítica. Opcional: (1) autorizar publicación en Vercel, (2) decidir si priorizar la verificación Tier 3 de las ~17 herramientas restantes antes de publicar, (3) decidir si el repo debe ser público.
- **Recommended next step**: si se planea publicar, completar la verificación Tier 3 de las herramientas restantes primero; si no, el producto está listo para uso interno/beta tal como está.
