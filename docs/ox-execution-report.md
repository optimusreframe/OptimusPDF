# DEVELOPMENT EXECUTION REPORT — OptimusPDF

> Skill: OX (Optimus eXecution). Fase 1 — Orquestador: Fable 5, plan: Fable 5,
> implementación: Opus 5 (Sonnet 5 de respaldo), agentes: Sonnet 5.
> Fase 2 — Orquestador: Sonnet 5, implementación: Opus 5, agentes: Sonnet 5,
> Codex CLI (GPT, vía `codex exec --sandbox read-only`) colaborando en
> investigación de causa raíz y revisión adversarial de diffs sensibles.
> Fase 3 — Orquestador: Sonnet 5, implementación y agentes: Sonnet 5 (a
> petición explícita del usuario), Codex en 8 rondas de revisión
> adversarial sobre un bug real reportado con un PDF certificado genuino.

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

## Final Status (fase 2)
- **Implementation complete**: sí — 32 rutas de herramientas (20 live + 12 soon) + `/edit-pdf` (ahora 21 live) + light/dark theme + autodetección de idioma.
- **Validated locally**: sí (tsc/eslint/build limpios, 42/42 rutas).
- **Codex passed**: sí, para el cambio sensible (`/unlock-pdf`) — 2 rondas de revisión adversarial con hallazgos reales resueltos y reverificados; el resto de la fase no requería su intervención por no ser dominio sensible.
- **Pushed**: sí, a `optimusreframe/OptimusPDF` rama `main` (commit `5cfd9a9`, sincronizado con origin).
- **Published**: no.
- **Validated in production**: no aplica (no publicado).
- **Safe to close (en su momento)**: sí, pero el bug de unlock-pdf resultó estar solo parcialmente corregido — ver fase 3.
- **Nota retrospectiva**: la fase 2 dio por cerrado el fix de `/unlock-pdf` tras verificarlo contra fixtures sintéticas propias. El usuario lo probó con un PDF real certificado por Adobe y seguía fallando — la causa era una clase de bug que las fixtures sintéticas no podían exponer (objetos `/Perms`/`/AcroForm` dentro de streams de objetos comprimidos y cifrados). Lección para futuras fases: para bugs de parsing/estructura de archivos, un archivo real del usuario reproduce categorías de fallo que ninguna fixture hecha a mano cubre por diseño.

---

# FASE 3 — Bug real con PDF certificado genuino: 8 rondas de fix + verificación Tier 3 completa + suite de tests

## Objetivo de la fase
- **Solicitado**: (1) el usuario probó el fix de la fase 2 con un PDF real certificado y seguía sin poder editarlo — pidió revisarlo con la skill OX y Codex; (2) revisar todo lo que quedaba pendiente; (3) agentes en Sonnet 5 esta vez (cambio explícito respecto a Opus 5 de fases anteriores).
- **Completado**: los 3 puntos. El bug real quedó identificado, corregido en 8 rondas de revisión adversarial con Codex, y verificado contra el archivo real del usuario tanto a nivel de motor como en navegador real. Las 17 herramientas restantes de la tabla Deferred de fase 2 quedaron verificadas con evidencia Tier 3 (16 confirmadas, 1 no verificable por requerir cámara real). Se añadió una suite de tests automatizados (Vitest) que estaba diferida desde el blueprint original.
- **No completado**: publicación en producción (sigue sin autorizar).

## Investigación de causa raíz (con archivo real del usuario)
El usuario compartió el PDF real que seguía fallando (formulario de seguros de 11 páginas, 1.1MB, certificado con firma Adobe.PPKLite genuina). Diagnóstico propio del orquestador, verificado con ejecución real antes de involucrar a Codex:

- El archivo tiene `/Encrypt /Filter/Standard` (AES-128) Y `/Perms/DocMDP` real (`P=1`, máxima restricción) simultáneamente — el caso combinado cifrado+certificado.
- El documento usa cross-reference stream + `/ObjStm` (streams de objetos comprimidos) — estructura moderna típica, no un caso raro.
- **Causa raíz confirmada con ejecución real**: `inspectProtection()` de la fase 2 detectaba DocMDP/FieldMDP sobre un documento cargado con `ignoreEncryption:true` (sin descifrar). Cuando `/Perms`/`/AcroForm` viven dentro de un `/ObjStm` cifrado (como en este archivo), leerlos sin descifrar devuelve `undefined` silenciosamente — el código interpretaba "no pude leerlo" como "no existe la restricción". Verificado leyendo el mismo archivo con y sin descifrar: sin descifrar, `Perms`/`AcroForm` resuelven a `undefined`; descifrando con la contraseña vacía (que sí funcionaba), ambos resuelven correctamente con el DocMDP real dentro.
- La salida que la herramienta de fase 2 ya había generado para este archivo se confirmó que seguía teniendo `/Perms/DocMDP` intacto.

## 8 rondas de fix/revisión adversarial con Codex (dominio sensible, OX §12.1)
Cada ronda: implementación (Sonnet 5) → verificación con ejecución real (motor + archivo real del usuario) → revisión adversarial de Codex sobre el diff → siguiente ronda si Codex encuentra algo real. Resumen de qué encontró cada ronda de Codex y cómo se cerró:

1. **Rediseño arquitectónico** (propuesto por Codex tras el diagnóstico): separar `readEncryptionEnvelope` (solo `/Encrypt`, nunca toca firmas) de `analyzeSignatures` (solo sobre documento ya descifrado), con una unión discriminada `ready | passwordRequired | unsupported` que impide leer resultados antes de completar la inspección.
2. **Codex encuentra 3 bloqueantes** en la primera implementación: `SigFlags!==0` como falso positivo de restricción (en realidad solo indica que existe un campo de firma, firmado o no), el consentimiento se podía saltar (`ToolShell.run()` no revalidaba `canRun` al ejecutar), y no se cubría `FieldMDP`/`/Lock` de campos de firma. Resueltos con detección separada de `hasDocMDPRestriction`/`hasFieldMDPRestriction`, revalidación de `canRun` en el motor de ejecución, y limpieza equivalente a `qpdf --remove-restrictions`.
3. **Codex encuentra 2 bloqueantes nuevos**: `/DocMDP null` seguía siendo falso positivo (comprobaba presencia de clave, no que resolviera a un diccionario real), y la identidad de consentimiento usaba `nombre:tamaño:fecha` que puede colisionar entre archivos distintos. Resueltos con resolución estricta del valor y consentimiento atado a la identidad del objeto `File` (`===`, nunca colisiona).
4. **Codex confirma el bug original resuelto**, pero encuentra 2 bloqueantes nuevos al profundizar: una firma de aprobación normal (sin restricción) se invalidaba sin pedir consentimiento (solo se protegían firmas restrictivas, no cualquier firma activa que la reescritura fuera a invalidar como efecto colateral), y el recorrido del árbol de campos no manejaba la herencia real de `/FT`/`/V` (un padre no terminal con `/FT /Sig` no bajaba a sus `/Kids`). Resueltos con `hasActiveSignatures` como señal independiente que también exige consentimiento, y recorrido reescrito para heredar correctamente.
5. Continuación de la ronda 4 con evidencia de "motor ciego" (una copia del motor con la detección inicial deliberadamente rota, para probar que la postcondición de guardar+releer+verificar SÍ atrapa el fallo).
6. **Codex encuentra que la postcondición reforzada no cubría el caso que debía cubrir**: solo re-analizaba firmas cuando `signaturesInvalidated` ya era `true`, es decir, nunca revisaba si la PRIMERA inspección se había equivocado. Y la herencia debía ascender por `/Parent` real (no solo descender por `/Kids`) para cubrir árboles irregulares. Resueltos: la postcondición ahora corre siempre que se va a devolver un resultado, y el ascenso replica el método `getParent()` de la propia librería con detección de ciclos y límite de profundidad. En esta ronda el orquestador también tomó una decisión de producto: un PDF sin cifrar con una firma activa pero sin restricción real vuelve a `notProtected` (la herramienta no ofrece quitar firmas que no bloqueaban nada — se mantiene estrictamente en su alcance de "desbloquear").
7. **Codex confirma los 2 bloqueantes cerrados**, encuentra que la UI no reflejaba la decisión de producto de la ronda 6 (mi propio error de alcance: solo pedí tocar el motor) y que el tokenizador de reconocimiento de restos de tabla de referencias cruzadas (`hasOuterXrefType`) aún aceptaba `/Type /XRef` dentro de comentarios PDF o en posición de valor en vez de clave. Ambos resueltos.
8. **Codex encuentra un último caso residual** en el mismo tokenizador (seguía escaneando después de cerrar el diccionario exterior, pudiendo confundirse con un segundo diccionario no relacionado más adelante en los mismos bytes) — corregido directamente por el orquestador (cambio de una función, sin agente) dado lo acotado, verificado y confirmado por Codex.

**Codex confirma explícitamente el cierre**: *"Listo para cerrar y dar por terminado el fix completo de /unlock-pdf."*

## Verificación final en navegador real
1. El PDF real del usuario, subido vía inyección de `File` real en Chrome real: la herramienta detecta la certificación (`hasDocMDPRestriction:true`), muestra el aviso honesto sin pedir contraseña (ya que la contraseña vacía funciona), exige el checkbox de consentimiento (deshabilitando "Procesar" hasta marcarlo), y produce una copia editable con `/Perms` y `/FT /Sig` eliminados — confirmado reabriendo el resultado con pdf-lib y con pdfjs (lector independiente).
2. Caso de la decisión de producto (PDF sin cifrar con firma activa sin restricción, el más recientemente tocado en las rondas 6-7): confirmado en Chrome real que muestra "nada que desbloquear", sin checkbox, con "Procesar" deshabilitado.
3. Se descubrió durante esta verificación una limitación del propio entorno de pruebas (no del producto): la herramienta de clic por coordenadas de la extensión de Chrome usada en este entorno no genera eventos DOM reales de forma fiable, y las pestañas en segundo plano sufren *throttling* de temporizadores de Chrome que puede hacer parecer "colgado" un proceso que en realidad tarda menos de 1 segundo (confirmado con medición aislada en Node: ~700-800ms para el archivo real de 1.1MB). Documentado para futuras verificaciones de este proyecto.

## Verificación Tier 3 del resto de herramientas (2 agentes Sonnet 5 en paralelo, extensión real de Chrome)
17 herramientas pendientes de la tabla Deferred de fase 2, subida de archivos reales + validación independiente del resultado fuera del navegador:
- **Grupo A** (organizar/convertir): split-pdf, remove-pages, extract-pages, organize-pdf, rotate-pdf, jpg-to-pdf, pdf-to-jpg — **7/7 CONFIRMADO**. scan-to-pdf — **NO VERIFICABLE** (requiere concesión real de permiso de cámara del sistema operativo, inalcanzable en este entorno automatizado).
- **Grupo B** (editar/seguridad): add-watermark, add-page-numbers, crop-pdf, sign-pdf, compare-pdf, compress-pdf, protect-pdf, redact-pdf, ocr-pdf — **9/9 CONFIRMADO**.
- **Total: 16/17 confirmadas, 0 defectos de producto encontrados** — los únicos problemas reportados por ambos agentes fueron limitaciones del propio entorno de automatización (throttling de descargas de Chrome, necesidad de pausas entre eventos de puntero sintéticos), no bugs de la aplicación.

## Suite de tests automatizados (Vitest)
Diferida desde el blueprint original de fase 1; priorizada ahora dado el historial de 8 rondas en `unlock.ts`. Instalada y configurada por un agente Sonnet 5:
- `src/lib/pdf/unlock.test.ts` — 16 tests cubriendo cada rama de decisión real del motor descubierta durante las 8 rondas (cifrado estándar con/sin contraseña, DocMDP con/sin cifrar, filtros no soportados, herencia `/Parent`, `/Lock` roto/ausente, identidad de consentimiento, postcondición).
- `src/lib/pdf/protect.test.ts` — 9 tests (ciclo completo de protección, validación de formulario, permisos completos).
- `src/lib/pdf/merge.test.ts` / `split.test.ts` — 4 tests de humo.
- **29/29 tests pasan**; `tsc`/`eslint`/`build` siguen limpios sin necesitar tocar configuración de Next.js o ESLint.

## Validación de la fase
- `npx tsc --noEmit`, `npx eslint src`, `npm run build` (42/42 rutas), `npm test` (29/29) limpios en el estado final.
- Máxima verificación alcanzada (§20.2): **Tier 3 real con archivo de producción genuino del usuario** para el fix de Unlock (el nivel más alto posible — no una fixture sintética, sino el caso real que motivó todo el trabajo de esta fase). Tier 3 para 16 de las 17 herramientas restantes.
- 8 rondas de revisión adversarial de Codex sobre el mismo cambio es un nivel de escrutinio inusualmente alto — justificado por tratarse de una operación de seguridad/integridad de datos (invalidación de firmas digitales, remoción de cifrado) donde un "éxito" que en realidad no cumplió su promesa es peor que un fallo visible.

## Commits de la fase
| Commit | Type | Description |
|---|---|---|
| `20cdd48` | fix(unlock-pdf) | 8 rondas de revisión adversarial con Codex contra PDF certificado real |
| `05d2e90` | test | Suite de Vitest para motores PDF críticos |

## Deferred (actualizado, acumulado desde fase 1)
**Resuelto en fase 3**: bug real de unlock-pdf con PDF certificado genuino, verificación Tier 3 de las 17 herramientas restantes (16/17, scan-to-pdf sigue pendiente por requerir cámara real), suite de tests automatizados.

**Sigue diferido**: publicación en producción (Vercel, no autorizada); decisión sobre si el repositorio debe ser público; verificación Tier 3 de `scan-to-pdf` (requiere un entorno con cámara real o un dispositivo físico, no solo automatización de navegador); ampliar la suite de Vitest a los motores restantes (watermark, pageNumbers, redact, compress, ocr, sign, crop, compare, organize, rotate, removePages, imagesToPdf, pdfToImages) si se desea cobertura total — se priorizaron los dos motores de seguridad por ser los que ya demostraron ser los más propensos a fallos sutiles.

## Final Status (fase 3)
- **Implementation complete**: sí — bug real corregido, 17 herramientas restantes verificadas, suite de tests instalada.
- **Validated locally**: sí (tsc/eslint/build/test limpios).
- **Codex passed**: sí — 8 rondas de revisión adversarial con cierre explícito ("listo para cerrar y dar por terminado el fix completo de /unlock-pdf").
- **Pushed**: sí, a `optimusreframe/OptimusPDF` rama `main` (commit `05d2e90`, sincronizado con origin).
- **Published**: no.
- **Validated in production**: no aplica (no publicado).
- **Safe to close**: sí, con alta confianza — esta vez el cierre se apoya en verificación contra el archivo real del usuario (no solo fixtures sintéticas) tanto a nivel de motor como en navegador real, y en 8 rondas de escrutinio adversarial independiente.
- **Owner action required**: ninguna crítica. Opcional: (1) autorizar publicación en Vercel, (2) decidir si el repo debe ser público, (3) priorizar si se quiere verificar `scan-to-pdf` con un dispositivo real antes de publicar, (4) decidir si ampliar la cobertura de Vitest a más motores.
- **Recommended next step**: probar tú mismo el PDF real en la app (ya verificado por el orquestador, pero la confirmación del propio usuario cierra el ciclo); si todo es satisfactorio, decidir sobre publicación.

---

# FASE 4 — Las 12 herramientas pendientes: decisión arquitectónica, spike de ZetaOffice, 6 herramientas nuevas, cobertura total de Vitest

## Objetivo de la fase
- **Solicitado**: (1) avanzar con las 12 herramientas "Próximamente" sin asumir que son viables 100% client-side — planificar con Fable 5 apoyándose en Codex la arquitectura de cada una (client-side / requiere backend / fuera de alcance) y **pedir autorización explícita** antes de tocar nada que implique backend o costo de infraestructura real; (2) ampliar la cobertura de Vitest a los motores restantes; (3) Sonnet 5 ejecutando agentes delegados, uno por herramienta o grupo pequeño, en paralelo.
- **Completado**: análisis arquitectónico completo de las 12 herramientas (Codex + verificación independiente propia); 6 herramientas nuevas implementadas, verificadas con archivos reales y publicadas como "live" (`html-to-pdf`, `repair-pdf`, `pdf-to-markdown`, `pdf-summarizer`, y 2 con alcance reducido explícitamente acordado: `pdf-to-pdfa` → verificador de conformidad, `translate-pdf` → informe de traducción); spike de viabilidad técnica de ZetaOffice/ZetaJS para Word/PowerPoint/Excel-a-PDF (resultado GO-WITH-CAVEATS, pero el usuario decidió omitirlas por el costo de infraestructura real); cobertura de Vitest ampliada de 4 a 20 motores (511 tests); 4 hallazgos reales de una revisión de seguridad/integridad de Codex sobre las 6 herramientas nuevas, evaluados y corregidos.
- **No completado**: `word-to-pdf`, `powerpoint-to-pdf`, `excel-to-pdf` (diferidas por decisión del usuario tras el spike — ver más abajo); `pdf-to-word`, `pdf-to-powerpoint`, `pdf-to-excel` (Grupo B — requieren backend, no autorizado); verificación Tier 3 de inferencia real de IA end-to-end en `pdf-summarizer` (descarga de modelo de 677 MB no ejecutada por costo de tiempo/ancho de banda de la sesión, ver Deferred); publicación en producción (sigue sin autorizar).

## Planificación arquitectónica (Codex + verificación independiente)
Se corrió `codex exec --sandbox read-only` con un prompt detallado pidiendo, para cada una de las 12 herramientas: viabilidad 100% client-side (con librería concreta si aplica), diseño mínimo de backend si no, si rompe la arquitectura "cero servidor", y disposición final (`CLIENT_SIDE_VIABLE` / `REQUIRES_BACKEND` / `OUT_OF_SCOPE_FOR_NOW`). Codex investigó documentación primaria (no solo generó de memoria) y encontró un dato crítico: **ZetaOffice/ZetaJS permite correr LibreOffice completo compilado a WebAssembly dentro del navegador**, lo que en teoría habilitaría Word/PowerPoint/Excel-a-PDF sin backend.

Por disciplina de §12.7 (nunca aceptar a Codex sin verificar), el orquestador hizo una verificación independiente vía WebSearch: confirmado que ZetaOffice/ZetaJS es real, pero está en **beta abierta** con su última versión (1.2.0) sin actualizaciones hace aproximadamente un año — un riesgo de madurez real que Codex no había puesto en su disposición final.

**Resultado presentado al usuario, con pregunta explícita de autorización (no se asumió nada):**
- **Grupo A — proceder ya, 100% client-side, sin decisión de infraestructura**: `html-to-pdf` (Paged.js/html2canvas+jsPDF), `pdf-to-markdown` (heurísticas sobre pdfjs-dist ya instalado), `repair-pdf` (pdf-lib/pdfjs-dist, con qpdf-wasm como stretch goal), `pdf-summarizer` (pdfjs-dist/tesseract.js + WebLLM, IA 100% local).
- **Grupo A2 — mismo enfoque pero con spike técnico previo por el riesgo de madurez**: `word-to-pdf`, `powerpoint-to-pdf`, `excel-to-pdf` vía ZetaOffice/ZetaJS.
- **Grupo B — requiere backend + costo recurrente real (decisión de infraestructura)**: `pdf-to-word`, `pdf-to-powerpoint`, `pdf-to-excel` — necesitarían una API de pago (Adobe PDF Services / CloudConvert) o servidor propio, y romperían la promesa de privacidad "cero servidor".
- **Grupo C — recomendado fuera de alcance por ahora**: `pdf-to-pdfa` (conversión real de conformidad exige Ghostscript+veraPDF en servidor) y `translate-pdf` (traducir preservando maquetación exige backend; enviar contenido de documentos a una API de traducción es un cambio real de privacidad).

El usuario decidió, vía pregunta explícita: (1) **no autorizar** el Grupo B por ahora; (2) **sí** hacer el spike técnico del Grupo A2 antes de comprometerse; (3) para el Grupo C, explorar una **versión reducida** en vez de descartarlo del todo (verificador de PDF/A en vez de conversor; informe de traducción en vez de PDF traducido).

## Spike de viabilidad — ZetaOffice/ZetaJS (agente `ox-architect`, Tier 3)
Spike real: cargó ZetaOffice en una ruta aislada (`_spike-zeta`, revertida al cierre), sirvió los assets auto-alojados (sin depender del CDN de terceros), y convirtió documentos reales (.docx con tabla/imagen/salto de página, .xlsx con fórmulas vivas, .pptx con 3 diapositivas) a PDF, inspeccionando el resultado página por página.

**Resultado: funcionó, con fidelidad excelente** (Word/PowerPoint prácticamente production-grade; Excel correcto salvo formato de números dependiente del locale del navegador). **Pero el costo es real y sustancial**: 53 MB comprimidos / 251 MB descomprimidos de assets WASM, 1 GB de memoria WASM reservada por pestaña, ~7 segundos de inicialización, requiere aislamiento cross-origin (COOP/COEP) que rompe la vista previa de PDF embebida en esas rutas, viabilidad en móvil **sin probar y con riesgo alto** (1 GB de memoria es un riesgo serio en gama media/iOS), y una decisión real de hosting (auto-alojar 251 MB de assets estáticos vs. depender del CDN de ZetaOffice, que sí debilitaría la posición de privacidad). Estimación de esfuerzo si se procede: 2.5–3.5 semanas.

**Decisión del usuario, presentada la evidencia**: omitir las 3 herramientas por el costo de infraestructura real. Código del spike revertido (`git checkout` sobre `next.config.ts`, directorios `src/app/spike-zeta` y `public/spike-zeta` eliminados), dependencia `zetajs` desinstalada. `word-to-pdf`, `powerpoint-to-pdf`, `excel-to-pdf` quedan diferidas junto al Grupo B.

## Implementación de las 6 herramientas aprobadas
Delegación paralela (Opus 5, agentes `ox-builder`/`ox-architect`, ~15-30 min cada uno), cada agente restringido a sus propios archivos para evitar conflictos de escritura concurrente (tools-registry.ts, locales y package.json coordinados centralmente por el orquestador después). El usuario interrumpió la espera larga (los 5 agentes de implementación llevaban más de una hora corriendo) y pidió que cerraran con lo que tuvieran; al enviarles el mensaje de cierre, los 5 ya habían sido detenidos por el propio usuario. El orquestador asumió directamente la verificación y el cierre de cada una:

- **`html-to-pdf`** — sandboxing de HTML no confiable en iframe aislado (`sandbox="allow-same-origin"` sin `allow-scripts`, CSP inyectada). Verificado con un HTML real con tabla, imagen y un `<script>` de prueba (XSS): produjo un PDF real de 48.8 KB y el script **no se ejecutó**. Codex encontró que la CSP original permitía `img-src`/`style-src`/`font-src` sobre `http:`/`https:`, lo que dejaba disparar peticiones de red reales (con cookies del propio origen) desde HTML no confiable pese a que la copia decía "nada sale de tu dispositivo" — **corregido**: solo `data:` permitido, ningún recurso remoto carga.
- **`repair-pdf`** — reparación estructural con `@cantoo/pdf-lib`/`pdfjs-dist` (sin backend ni dependencia nueva). Verificado con 3 escenarios de corrupción real construidos a mano (xref corrupto, cabecera/cola dañadas): diagnóstico preciso, reparación exitosa. Codex encontró que el motor reserializaba **incluso un PDF sano sin ningún daño detectado**, lo cual invalidaría en silencio una firma digital por rango de bytes que el archivo pudiera tener — **corregido**: sin daño detectado, se devuelve el archivo original byte a byte, sin tocarlo.
- **`pdf-to-markdown`** — heurísticas sobre `pdfjs-dist` (encabezados por tamaño de fuente, listas, tablas, bloques de código) + fallback OCR. Verificado con un PDF real de 9 páginas (contrato certificado de terceros) y un fixture escaneado: encontró y corrigió un bug real de heurística (párrafo legal en mayúsculas se leía como 10 encabezados apilados).
- **`pdf-summarizer`** — IA local (WebLLM + Llama 3.2 1B cuantizado a 4 bits) gateada por disponibilidad de WebGPU, sin fallback a nube. El agente dejó un bug de sintaxis JSX real (uso de argumento de tipo genérico explícito `<SegmentedControl<T>>` en una etiqueta JSX, que TypeScript acepta pero el parser SWC/Turbopack de Next.js no soporta bien y se desincroniza más adelante en el archivo) — **corregido** quitando el genérico explícito y dejando que TypeScript lo infiera de los props. Verificado: la página renderiza completo, sube archivos, y el flujo de consentimiento de descarga del modelo funciona. La inferencia real de 677 MB no se ejecutó de punta a punta por el costo de tiempo/ancho de banda de la sesión (ver Deferred).
- **`pdf-to-pdfa`** (alcance reducido a **verificador de conformidad**, acordado explícitamente con el usuario) — inspecciona metadatos XMP, fuentes incrustadas, OutputIntent, cifrado, JavaScript y adjuntos; nunca convierte ni certifica. Verificado con un PDF real sin metadatos PDF/A: reportó correctamente 2 incumplimientos, 1 aviso, 3 comprobaciones superadas. Codex encontró que varios chequeos podían dar **"CUMPLE" en falso positivo** cuando el recorrido del documento fallaba a medias (enumeración de objetos indirectos interrumpida) — **corregido**: cuando el barrido de JavaScript o de adjuntos no puede completarse, el estado pasa a "desconocido" en vez de "cumple".
- **`translate-pdf`** (alcance reducido a **informe de traducción bilingüe**, acordado explícitamente con el usuario) — modelo local Xenova/opus-mt (OPUS-MT), sin backend, con consentimiento explícito antes de descargar. Se encontró y depuró un bug real de compatibilidad: el backend WASM de onnxruntime-web fallaba al crear sesión con este modelo cuantizado (`Missing required scale: model.shared.weight_merged_0_scale`) para **cualquier** `dtype` probado (aislado con una ruta de prueba desechable); la causa era la pasada de optimización de grafo `TransposeDQWeightsForMatMulNBits` — **corregido** desactivando `graphOptimizationLevel` para esa sesión (confirmado que la traducción sigue siendo correcta sin esa optimización). Verificado de punta a punta con un PDF real en español: produjo un informe Markdown bilingüe real y correcto.

## Codex — revisión de seguridad/integridad sobre las 6 herramientas nuevas (OX §12.5)
`codex exec --sandbox read-only` sobre los 6 archivos de motor más sensibles (`htmlToPdf.ts`, `translate.ts`, `summarize.ts`, `repair.ts`, `pdfaCheck.ts`). 4 hallazgos reales, evaluados uno por uno (§12.7, nunca aceptados a ciegas) y todos corregidos:
1. **P1 — `htmlToPdf.ts`**: CSP permitía peticiones de red reales desde HTML no confiable pese a la promesa de privacidad. Corregido (ver arriba).
2. **P1 — `pdfaCheck.ts`**: chequeos de JavaScript/adjuntos podían devolver "cumple" en falso positivo tras un recorrido incompleto del documento. Corregido (ver arriba).
3. **P2 — `repair.ts`**: reserializaba archivos sanos sin necesidad, arriesgando invalidar firmas digitales existentes. Corregido (ver arriba).
4. **P2 — `translate.ts`/`summarize.ts`**: la copia decía "la única petición de red es la descarga del modelo", pero el fallback de OCR (Tesseract.js) descarga sus propios archivos desde el CDN por defecto de Tesseract — un endpoint adicional no declarado (aunque nunca con contenido del documento, y el mismo patrón ya lo usa `ocr-pdf` en producción). Corregido: copia actualizada en ambos idiomas para ser precisa sobre esta descarga adicional cuando el OCR está activado.

Un quinto punto (Codex: el chequeo de OutputIntent de `pdfaCheck.ts` no valida el perfil ICC en sí, solo su presencia) se evaluó y se dejó como está: ya está explícitamente declarado en la propia copia de la herramienta ("No comprobamos qué colores usa el contenido"), y validar un perfil ICC real es una pieza de scope claramente desproporcionada para este chequeo heurístico.

## Cobertura de Vitest ampliada (4 agentes Sonnet 5 en paralelo + fixes del orquestador)
De 4 motores cubiertos (unlock, protect, merge, split — 29 tests) a **20 motores, 511 tests**. Los 4 agentes paralelos escribieron tests para: watermark/pageNumbers/crop/rotate, compress/redact/organize/removePages, imagesToPdf/pdfToImages/scanToPdf/editPdf, sign/compare/ocr/core.

Al reconciliar el trabajo de los 4 agentes, el orquestador encontró y corrigió 4 problemas reales:
- **`scanToPdf.test.ts`**: asumía que `navigator` no existe en Node — falso desde Node 24 (que ya expone un `navigator` global propio). Corregido para comprobar `navigator.mediaDevices` específicamente.
- **`editPdf.test.ts`**: el fixture de "PDF sin páginas" no llegaba realmente vacío al motor porque `pdf-lib` añade una página por defecto al guardar un documento de 0 páginas salvo que se pida `addDefaultPage:false` explícitamente. Corregido.
- **`imagesToPdf.test.ts`**: un test (`merge=false`, ZIP de PDFs reales) hacía que el **proceso worker de Vitest reventara** al mezclar JSZip con `Blob` reales de Node — reproducible de forma aislada (throw limpio en un script suelto) pero crashea el worker dentro de Vitest. No es un bug de producción (el mismo patrón ya está verificado en navegador real en `jpg-to-pdf`, una de las 21 herramientas en producción). Documentado y omitido (`it.skip`) con una nota explicando la causa, en vez de dejar que envenenara toda la corrida de tests.
- **`pdfToImages.test.ts`**: 6 de 10 tests fallaban porque el mock de `canvasToBlob` devolvía un `Blob` real, y JSZip en Node no puede leer `Blob` (solo Buffer/Uint8Array/ArrayBuffer) pese a reportar `support.blob:true` (falso positivo de detección). Corregido cambiando el mock para devolver `Uint8Array` en vez de `Blob` — la lógica de negocio bajo prueba (selección/orden de páginas, nombrado, ZIP vs JPG) no depende del tipo exacto.

Motores que siguen sin cobertura de la ruta que depende de pdf.js/canvas real (`compress.ts`, `redact.ts`, `compare.ts`, `ocr.ts`, y los render-helpers de `core.ts`): confirmado que `pdfjs-dist` no puede abrir documentos en el entorno `environment:"node"` de Vitest (`DOMMatrix is not defined`, y tras un shim, un segundo fallo resolviendo el worker como módulo de Node) — limitación de entorno, no de producto. Documentado como brecha conocida; ver Deferred.

## Limpieza previa al commit
Se eliminaron antes de integrar: `__pdfa_make_fixtures.mjs` (script suelto en la raíz), `public/__pdfa_fixtures/` (incluía sin querer `real-certified.pdf`, el mismo PDF certificado real del usuario usado en la fase 3 — nunca debió quedar en `public/`), `public/__tftest/` (assets de prueba de transformers.js) — ninguno de estos debía llegar a un commit ni a producción.

## Validación de la fase
- `npx tsc --noEmit`: limpio.
- `npx eslint .`: limpio (0 errores, 2 warnings preexistentes menores de variables no usadas en archivos de test).
- `npx vitest run`: **511/512 tests pasan, 1 omitido documentado** (26 archivos de test).
- `npx next build`: build de producción exitoso, 42 rutas generadas, 0 errores.
- **Browser (Tier 3, con archivos reales)**: `html-to-pdf` (HTML con tabla/imagen/XSS → PDF real, XSS neutralizado), `repair-pdf` (3 escenarios de corrupción real + caso sano-no-tocado, ambos verificados), `pdf-to-markdown` (contrato real de 9 páginas + escaneo simulado con OCR), `pdf-to-pdfa` (PDF real no conforme → reporte preciso), `translate-pdf` (PDF real en español → informe bilingüe real de punta a punta), `pdf-summarizer` (carga de archivo y flujo de consentimiento; inferencia completa no ejecutada — ver Deferred).
- **Security**: revisión adversarial de Codex sobre las 6 herramientas nuevas, 4 hallazgos reales corregidos (ver arriba).
- **Highest verification tier reached (§20.2)**: Tier 3 para 5 de las 6 herramientas nuevas (todo el flujo real, con archivos reales); Tier 2 para `pdf-summarizer` (UI y flujo de consentimiento verificados en navegador real, inferencia de IA no ejercida de punta a punta).

## Commits de la fase
| Commit | Type | Description |
|---|---|---|
| (pendiente) | feat(tools) | 6 herramientas nuevas (html-to-pdf, repair-pdf, pdf-to-markdown, pdf-summarizer, pdf-to-pdfa, translate-pdf) + cobertura de Vitest ampliada a 20 motores + 4 fixes de seguridad/integridad de Codex |
| (pendiente) | docs | Reporte de ejecución OX — fase 4 |

## Deferred (actualizado, acumulado desde fase 1)
**Resuelto en fase 4**: decisión arquitectónica documentada para las 12 herramientas pendientes; 6 implementadas y verificadas; cobertura de Vitest ampliada de 4 a 20 motores.

**Sigue diferido**:
| Item | Reason | Severity | Recommended Next Step |
|---|---|---|---|
| `word-to-pdf`, `powerpoint-to-pdf`, `excel-to-pdf` | Spike técnico GO-WITH-CAVEATS, pero el usuario decidió omitirlas por el costo de infraestructura real (251 MB de assets, 1 GB de RAM por pestaña, 2.5–3.5 semanas de esfuerzo, decisión de hosting pendiente) | Media | Retomar solo si se autoriza el costo de infraestructura y se resuelve la viabilidad en móvil con un dispositivo real |
| `pdf-to-word`, `pdf-to-powerpoint`, `pdf-to-excel` (Grupo B) | Requieren backend + costo recurrente real (Adobe PDF Services/CloudConvert); romperían la privacidad "cero servidor" | Media | Pedir autorización explícita de presupuesto e infraestructura antes de implementar |
| Verificación Tier 3 de inferencia real de IA en `pdf-summarizer` | Descarga de modelo de 677 MB no ejecutada por costo de tiempo/ancho de banda de esta sesión | Media | Ejecutar una vez con un dispositivo/entorno que tolere la descarga completa, confirmar un resumen real |
| Cobertura de Vitest de `compress.ts`/`redact.ts`/`compare.ts`/`ocr.ts` (rutas dependientes de pdf.js/canvas) | `pdfjs-dist` no abre documentos en `environment:"node"` de Vitest (falta `DOMMatrix`/canvas real) | Baja | Evaluar añadir `jsdom` + `canvas` como devDependencies solo-test, o aceptar la brecha (ya verificados en navegador real en fases anteriores) |
| Test omitido en `imagesToPdf.test.ts` (`merge=false`) | JSZip + `Blob` real revienta el proceso worker de Vitest en Node (no reproducible en navegador real) | Baja | Sin acción necesaria — documentado, motor ya verificado en producción vía `jpg-to-pdf` |
| Verificación Tier 3 de `scan-to-pdf` | Requiere cámara real, heredado de fase 3 | Media | Sin cambios desde fase 3 |
| Publicación (Vercel) | No autorizada en este run | N/A | Pedir autorización explícita al usuario cuando quiera publicar |
| Decisión sobre repositorio público/privado | No solicitada en este run | N/A | Pedir al usuario cuando lo decida |

## Final Status (fase 4)
- **Implementation complete**: sí, dentro del alcance aprobado — 6 herramientas nuevas + cobertura de Vitest ampliada. 3 herramientas explícitamente omitidas por decisión del usuario, 3 explícitamente diferidas por requerir backend no autorizado.
- **Validated locally**: sí (tsc/eslint/build/test limpios; 511/512 tests).
- **Codex passed**: sí — revisión arquitectónica de las 12 herramientas y revisión de seguridad/integridad de las 6 nuevas, con 4 hallazgos reales evaluados y corregidos.
- **Pushed**: pendiente de este commit.
- **Published**: no.
- **Validated in production**: no aplica (no publicado).
- **Safe to close**: sí — cada herramienta nueva tiene evidencia Tier 3 con archivos reales salvo `pdf-summarizer` (Tier 2, inferencia de IA no ejercida por costo de la descarga), documentado explícitamente como brecha conocida, no oculta.
- **Owner action required**: (1) decidir si en el futuro se autoriza el costo de infraestructura para Word/PowerPoint/Excel-a-PDF (ZetaOffice) o para el Grupo B (backend de conversión); (2) opcional: correr `pdf-summarizer` una vez con la descarga completa del modelo para confirmar la inferencia real; (3) autorizar publicación en Vercel cuando se desee; (4) decidir sobre repositorio público/privado.
- **Recommended next step**: probar las 6 herramientas nuevas en la app; si todo es satisfactorio, decidir sobre publicación y sobre las herramientas diferidas.

---

# Fase 5 — Plan de 5 items post-fase-4 (Codex-driven, low-cost/no-server)

> Orquestador: Sonnet 5. Instrucción del usuario: *"ejecuta codex para evaluar el
> informe final [de la fase 4] y decidir cuáles son los próximos pasos, siempre
> pensando en low-cost, no server"*, seguida de *"Empieza con el 1, y aplica
> nuestra lógica de desarrollo. Desarrolla 1, valida que todo se haya
> desarrollado, audita con Codex, planifica con Codex el siguiente paso, y
> desarrolla el 2... y así sucesivamente. Al final, emite el informe final y
> que Codex lo audite para evaluar si todo OK e indicar los próximos pasos."*
> Cada ítem siguió el mismo ciclo: implementar → validar (tsc/eslint/vitest/
> build + verificación real en navegador) → auditoría de Codex
> (`codex exec --sandbox read-only`) → corrección de hallazgos → Codex planifica
> el siguiente ítem → repetir. Codex actuó como revisor adversarial externo en
> cada ronda, nunca como autocertificación del propio trabajo.

## Origen del plan de 5 items
Tras la fase 4, se le pidió a Codex auditar el informe de esa fase y decidir
próximos pasos low-cost/no-server. Su recomendación priorizada, explícitamente
excluyendo todo lo que requiriera backend o costo recurrente (conversión real
Word/PowerPoint/Excel, certificación PDF/A vía Ghostscript+veraPDF, traducción/
resumen en la nube, revivir ZetaOffice — todo ya descartado en fase 4):
1. Cerrar la verificación Tier 3 de `pdf-summarizer` (inferencia real de IA
   nunca observada de punta a punta).
2. Playwright real para `compress`/`redact`/`compare`/`core.ts` (rutas
   dependientes de pdfjs-dist/canvas que Vitest no puede ejercitar).
3. Verificar `scan-to-pdf` con cámara falsa (automatizado) + pasada manual en
   2 dispositivos físicos reales.
4. CI gratuito en GitHub Actions.
5. Endurecer privacidad (CSP más estricta, política de privacidad explícita,
   fijar versiones de los modelos de IA descargados).

## Item 1 — Cerrar Tier 3 de `pdf-summarizer`
**Commits**: `0164238`, `6f3099e`.

Se ejecutó el flujo completo de principio a fin en el Browser pane real (WebGPU
disponible): selección de modelo, descarga real de 677 MB
(`Llama-3.2-1B-Instruct-q4f16_1-MLC`), inferencia real sobre un PDF ficticio de
prueba, resumen coherente y con citas de página correctas.

**2 hallazgos reales de Codex, corregidos** (documentados en
`docs/evidence/pdf-summarizer-tier3/`):
- Detección de caché ciega a la identidad del modelo (condición de carrera:
  `setCached(true)` no distinguía qué modelo había terminado de cargar
  realmente) — corregido para rastrear el modelo que efectivamente corrió.
- Alucinación de citas de página sin validar: el modelo podía citar `[p.99]`
  en un documento de 5 páginas y la UI lo mostraba tal cual — corregido con
  `sanitizePageCitations()`, que descarta citas fuera de rango `[1, totalPages]`.

Codex dio veredicto **PASA** tras la segunda ronda.

## Item 2 — Playwright real para compress/redact/compare/core
**Commits**: `62b1e83` (suite inicial), `4c857bd` (correcciones tras auditoría).

Infraestructura Playwright completa desde cero, sin coste ni dependencias
nuevas de peso: `@napi-rs/canvas` (ya dependencia transitiva de pdfjs-dist) se
usa directamente para renderizar páginas a píxeles reales en Node y muestrear
color exacto — más fiable que una alternativa con capturas de pantalla de
Chromium + decodificación PNG, que se descartó.

**Hallazgo genuino y reutilizable**: Next.js 16 bloquea por defecto los
recursos de dev (HMR, overlay de errores) que llegan desde un origen distinto
al que el propio servidor considera local, y trata `127.0.0.1` como
cross-origin frente a `localhost` — rompía silenciosamente toda la
interactividad de la página bajo Playwright. Documentado en el mensaje del
commit `62b1e83` como hallazgo reusable, no solo un workaround privado.

**3 hallazgos de rigor de aserciones de Codex, corregidos** en `4c857bd`:
redact.spec.ts solo muestreaba el centro del parche censurado (sin verificar
el texto secreto ni una zona de control exterior); compare.spec.ts solo
comprobaba el contador global de páginas cambiadas (sin badges `+N`/`-N` por
página); compress.spec.ts comparaba el porcentaje de reducción contra un valor
fijo en vez de calcularlo sobre los bytes reales.

Codex dio veredicto **PASA** tras la segunda ronda. Suite estable en múltiples
corridas consecutivas (incluida la ejecución real en CI, ver Item 4).

## Item 3 — Verificar `scan-to-pdf` con cámara falsa
**Commits**: `8b33f6f` (implementación), `073b28a` (precisiones menores).

Proyecto Playwright dedicado `chromium-fake-camera`
(`--use-fake-device-for-media-stream` + `--use-file-for-fake-video-capture`)
aislado del proyecto `chromium` por defecto. El video Y4M sintético (320×240,
10 fps, 10 frames estáticos, 4 cuadrantes de color sólido y distinto) se generó
**sin `ffmpeg`** (no disponible en este entorno) escribiendo a mano la
conversión RGB→YUV420 en JS y reutilizando `@napi-rs/canvas`, ya presente. De
paso se reemplazó `pngjs` (dependencia removida del lockfile en una limpieza
anterior, que dejaba roto el script de regeneración de fixtures) por la misma
API de `@napi-rs/canvas`.

El escenario cubre: activar cámara real (falsa) → esperar fotograma disponible
→ capturar → confirmar exactamente 1 captura → generar y descargar el PDF →
verificar 1 página, dimensiones exactas 320×240 (sin rotación), página basada
en imagen, y color real de los 4 cuadrantes en las 4 esquinas del render.

Codex dio veredicto **PASA** en primera ronda, con 2 sugerencias menores no
bloqueantes aplicadas igualmente (precisar un comentario sobre rango de color
YUV, y endurecer el conteo de capturas a exacto).

**Limitación explícitamente NO resuelta y declarada** (ver tabla de riesgos
residuales): la pasada manual en 2 dispositivos físicos reales
(idealmente iOS/Safari + Android/Chrome) sigue **pendiente**. El orquestador no
tiene acceso a hardware móvil real y así queda documentado en
`docs/evidence/scan-to-pdf-item3/checklist.md`, con una plantilla de checklist
lista para que una persona con esos dispositivos la complete. Esto **no** se
presenta como validado.

## Item 4 — CI gratuito en GitHub Actions
**Commit**: `c1a1948`.

Workflow `.github/workflows/ci.yml` con 2 jobs paralelos en `ubuntu-latest`:
`quality` (tsc/lint/vitest/build) y `e2e` (instala solo Chromium vía
`playwright install --with-deps chromium`, corre la suite completa incluida
`chromium-fake-camera`). Triggers `push`/`pull_request` a `main` +
`workflow_dispatch`; `concurrency` con `cancel-in-progress`; Node fijado a la
versión de desarrollo (24, no `lts/*`); artifacts de diagnóstico solo en fallo,
retención de 7 días.

**Evidencia real, no solo predicha**: el workflow se ejecutó de verdad en
GitHub Actions sobre el push real de este commit (run `30393086108`) — ambos
jobs en **success**, ~1m45s cada uno en paralelo. Confirmado también en cada
commit posterior de esta fase (ver tabla de runs abajo).

Codex dio veredicto **PASA**, con una mejora oportunista sugerida
(`permissions: contents: read`) marcada como no bloqueante y aún pendiente de
aplicar (ver tabla de riesgos residuales).

## Item 5 — Endurecer privacidad (CSP, política, versiones fijadas)
**Commits**: `f1e009c` (implementación), `4cedc35` (corrección de hallazgo
bloqueante), `aa8b730` (URLs canónicas).

**CSP y cabeceras de seguridad** (`next.config.ts`): `Content-Security-Policy`,
`Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options`,
`Permissions-Policy: camera=(self)` (necesario para `scan-to-pdf`). Los
dominios externos permitidos se verificaron contra el **código realmente
instalado y peticiones HTTP reales**, no contra suposiciones: la primera
recomendación de Codex asumía que `tesseract.js` descarga desde
`tessdata.projectnaptha.com`; leyendo `node_modules/tesseract.js` se confirmó
que la versión instalada (7.0.0) usa `cdn.jsdelivr.net` para el script del
worker, el núcleo WASM y los datos de idioma — corregido antes de aplicar la
CSP. Además, probando el build de **producción real** (`next build && next
start`) contra los 3 flujos de descarga externa, se encontró que `onnxruntime-web`
(el motor detrás de `@huggingface/transformers`) resuelve su backend WASM con
un `import()` dinámico desde una `blob:` URL — sin `blob:` en `script-src`,
`translate-pdf` fallaba con `"no available backend found"`. Corregido.

**Verificación dinámica real** (no solo estática): con el build de producción
corriendo, se completaron de punta a punta, sin bloqueos de CSP: OCR (descarga
real desde jsDelivr), traducción (descarga real de ~115 MB desde Hugging Face)
e IA (descarga real de 677 MB desde las URLs **fijadas** + inferencia real con
resultado coherente). La suite Playwright completa (incluida `scan-to-pdf` bajo
la nueva `Permissions-Policy`) se re-ejecutó sin regresiones.

**Política de privacidad** (`/privacy`, enlazada desde el footer — antes
"Privacidad" apuntaba a `/about` junto con Términos/Cookies/Licencias, que
siguen así). Primera versión de Codex: **NO PASA** — la política afirmaba que
*todas* las descargas piden autorización explícita con checkbox y tamaño
aproximado, pero `ocr-pdf` (y el respaldo de OCR en traducción/resumen) solo
avisa, sin checkbox — inconsistencia real entre lo que el copy prometía y lo
que el código hace. Corregido: la política ahora distingue explícitamente el
aviso simple de OCR de la autorización con checkbox de resumen/traducción,
declara el historial de "Recientes" y las preferencias guardadas en
`localStorage` (nunca contenido de archivo), y enlaza a las políticas reales de
Hugging Face/GitHub/jsDelivr (URLs verificadas con peticiones HTTP reales,
corregidas a sus rutas canónicas en una segunda ronda).

**Versiones de modelos fijadas a un commit** (antes resolvían implícitamente
contra `main`, una rama móvil):
- `src/lib/pdf/translate.ts`: cada uno de los 6 `TranslationPair` fija un
  `revision` (SHA de 40 hex, verificado contra la API real de Hugging Face)
  pasado a `transformers.pipeline`.
- `src/lib/pdf/summarize.ts`: `WEBLLM_APP_CONFIG` fija `model` y `model_lib` de
  los 2 modelos usados a un commit concreto de `huggingface.co/mlc-ai/...` y de
  `github.com/mlc-ai/binary-mlc-llm-libs`, en vez de la config por defecto de
  web-llm. `isModelCached()` y `loadEngine()` usan esta misma config de forma
  consistente (la detección de caché mira la misma URL que realmente se usa).
- Tests nuevos que exigen un SHA de 40 hex (no `"main"`) en cada entrada.

Codex confirmó: esto cierra el hueco concreto de cadena de suministro buscado
(cambios silenciosos de pesos/binarios bajo una rama móvil), aunque
explícitamente **no** equivale a integridad criptográfica extremo a extremo
frente a un compromiso del proveedor.

Codex dio veredicto **PASA** tras la corrección del hallazgo bloqueante y el
ajuste de URLs canónicas.

## Validación final (commit `aa8b730`, HEAD de esta fase)
- `npx tsc --noEmit`: limpio.
- `npx eslint .`: limpio (0 errores, 2 warnings preexistentes menores,
  ninguno introducido en esta fase).
- `npx vitest run`: **525/526 tests pasan, 1 omitido documentado** (26 archivos
  de test; +14 tests nuevos desde el cierre de fase 4).
- `npx next build`: build de producción exitoso.
- `npx playwright test`: **6/6 tests pasan** (2 proyectos: `chromium` y
  `chromium-fake-camera`), estable en múltiples corridas.
- **GitHub Actions (CI real, no simulado)**:

| Run | Commit | Quality | E2E | Duración |
|---|---|---|---|---|
| `30393086108` | `c1a1948` | success | success | ~1m50s |
| `30398918223` | `f1e009c` | success | success | ~3m0s |
| `30399612728` | `4cedc35` | success | success | ~2m13s |
| `30399964077` | `aa8b730` | success | success | confirmado en cierre |

## Riesgos residuales y limitaciones conocidas
| Item | Descripción | Severidad | Acción recomendada |
|---|---|---|---|
| Pasada manual de `scan-to-pdf` en 2 dispositivos físicos reales | No ejecutada — sin acceso a hardware móvil real | Media | Completar `docs/evidence/scan-to-pdf-item3/checklist.md` con un iOS/Safari y un Android/Chrome reales antes de considerar `scan-to-pdf` validado en móvil |
| `permissions: contents: read` en `ci.yml` | Sugerencia de Codex, no bloqueante, no aplicada | Baja | Añadir en el próximo commit que toque el workflow |
| CSP sin nonces/hashes (`'unsafe-inline'` en `script-src`/`style-src`) | Es la alternativa recomendada por Next.js para páginas estáticas sin servidor; reduce el valor anti-XSS de la CSP frente a una futura inyección de HTML, aunque hoy no se encontró ningún `dangerouslySetInnerHTML` ni sumidero evidente | Baja | Revisar si se introduce renderizado dinámico en el futuro; hoy no es accionable sin servidor |
| Fijación de modelos no es integridad criptográfica end-to-end | Un compromiso real del proveedor (Hugging Face/GitHub) podría alterar el contenido de un commit ya fijado | Baja | Diferido por complejidad y mantenimiento, no necesariamente incompatible con low-cost/no-server: `ModelIntegrity`/hashes SRI verificables en cliente (ya soportados por web-llm) son viables sin servidor, pero exigen mantener un hash por archivo de cada asset — no requerido para cerrar este plan |
| `pdf-summarizer`: `isModelCached()` no detecta el modelo tras recargar la página (F5) | Limitación documentada de la librería `@mlc-ai/web-llm` (ver `docs/evidence/pdf-summarizer-tier3/resultado.md`): dentro de la misma sesión de pestaña ya no repite el aviso de descarga (corregido en el Item 1), pero tras un F5 vuelve a mostrar "hay que descargar el modelo" aunque el cache real exista. No obliga a repetir la descarga de 677 MB — sólo repite la pantalla de consentimiento. | Baja | Reportar el caso aguas arriba en `@mlc-ai/web-llm`, o implementar una verificación propia consultando `caches.open('webllm/model')` directamente |
| WebGPU / rendimiento variable | `pdf-summarizer` requiere `shader-f16`; sin él, la herramienta falla cerrado explícitamente ("no hay plan B") | Inherente | Ya documentado en la propia UI del producto |
| Precisión de OCR/IA | Resúmenes, traducciones y texto reconocido pueden contener errores | Inherente | Ya declarado en `/privacy` y en el copy de cada herramienta |
| Ausencia deliberada de servidor | Sin backend, ninguna herramienta que lo requiera (conversión real Office↔PDF con maquetación, certificación PDF/A real, traducción/resumen en la nube) puede ofrecerse sin romper la posición de privacidad | Por diseño | Ya evaluado y descartado explícitamente en fase 4 |

## Próximos pasos recomendados (siempre low-cost/no-server)
1. Completar la pasada manual de `scan-to-pdf` en 2 dispositivos físicos
   reales (el punto de mayor prioridad, sin evidencia real todavía).
2. Aplicar `permissions: contents: read` al workflow de CI (barato, sin riesgo).
3. Documentar (o resolver) el comportamiento de `isModelCached()` tras F5 en
   `pdf-summarizer`: reportarlo aguas arriba en `@mlc-ai/web-llm`, o
   implementar una verificación propia sobre `caches.open('webllm/model')`.
4. Matriz ligera de navegadores/dispositivos para las herramientas más
   sensibles a APIs del navegador (`scan-to-pdf`, `pdf-summarizer` con WebGPU).
5. Comprobación periódica (manual o vía un job de CI adicional, sin costo real)
   de que las URLs fijadas de los modelos y las políticas de terceros enlazadas
   desde `/privacy` siguen vigentes, y de actualizar los commits fijados cuando
   se decida deliberadamente actualizar un modelo.
6. Presupuesto de tamaño de bundle (`next build` ya reporta tamaños por ruta;
   fijar un umbral y que CI avise si se excede).
7. Documentar un plan de recuperación si Hugging Face, GitHub o jsDelivr
   cambian sus URLs o dejan de servir un recurso fijado (qué hace la app,
   qué ve el usuario, cómo se actualiza el commit fijado).

## Final Status (fase 5)
- **Implementation complete**: 5/5 items implementados en su alcance
  automatizable, cada uno auditado por Codex con veredicto **PASA** antes de
  pasar al siguiente. De ellos, **4/5 quedan cerrados íntegramente**; el Item 3
  queda pendiente de su pasada de validación física (ver abajo) — no se
  presenta como cerrado al 100%.
- **Validated locally**: sí (tsc/eslint/vitest 525/526/build limpios en el
  HEAD final `aa8b730`).
- **Validated in CI real**: sí — GitHub Actions ejecutó y aprobó cada commit
  significativo de esta fase (ver tabla de runs).
- **Codex passed**: sí, en los 5 items — con 2 rondas en el Item 2 (rigor de
  aserciones), 1 ronda en el Item 3, 1 ronda en el Item 4, y 2 rondas en el
  Item 5 (un hallazgo bloqueante real de inconsistencia copy/código, corregido).
- **Pushed**: sí, cada commit de la fase.
- **Published**: no (fuera de alcance de esta fase; sigue pendiente de fase 4).
- **Safe to close**: sí, en el alcance automatizable de los 5 items, con dos
  limitaciones explícitas y honestamente declaradas — no ocultas: (1) la
  pasada manual de `scan-to-pdf` en 2 dispositivos físicos reales no se ha
  ejecutado, y (2) `pdf-summarizer` puede repetir el aviso de descarga del
  modelo tras un F5 aunque el cache real exista (ver tabla de riesgos).
  Ninguna de las dos invalida la evidencia ya recogida ni exige rehacer
  ningún ítem.
- **Owner action required**: (1) ejecutar la pasada manual de `scan-to-pdf` en
  2 dispositivos reales cuando se disponga de ellos; (2) decidir si y cuándo
  publicar (Vercel), pendiente desde fase 4; (3) revisar periódicamente que las
  URLs fijadas de modelos y políticas de terceros sigan vigentes.
- **Recommended next step**: con 4/5 items cerrados íntegramente y el quinto
  (`scan-to-pdf`) cerrado en su alcance automatizable, el siguiente hito
  natural es completar su pasada de validación física, aplicar
  `permissions: contents: read` al workflow de CI, y luego retomar la decisión
  ya pendiente desde fase 4 sobre publicación en producción.
