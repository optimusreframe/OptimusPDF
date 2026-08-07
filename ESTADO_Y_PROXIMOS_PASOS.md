# Estado y próximos pasos — OptimusPDF

**Fecha de corte**: 2026-08-07
**Repositorio**: https://github.com/optimusreframe/OptimusPDF (privado)
**Rama**: `main`
**Sincronización con origin**: al día. `git status` limpio (sin cambios staged/unstaged/untracked), `main` en `654b9b0`, con upstream `origin/main` configurado y `+0 -0` de diferencia. No hubo nada que commitear ni pushear en esta auditoría — el cierre de sesión anterior ya había dejado todo sincronizado.

Este documento se generó como parte de una auditoría completa antes de migrar de máquina. Todo lo que aparece como "comprobado" fue verificado en vivo en esta sesión (no es una copia de notas anteriores).

---

## 1. Comprobado y funcionando ahora mismo

**Código y calidad**
- `npx tsc --noEmit` — limpio, 0 errores.
- `npm run lint` (ESLint) — limpio, 0 warnings/errores.
- `npm run build` (Next.js 16, Turbopack) — build de producción limpio, 49 rutas generadas como contenido estático.

**Tests**
- `npm test` (Vitest) — 887-888 de 891 tests pasan (3 skips preexistentes sin relación). En dos corridas completas locales en esta máquina, `wordToPdf.test.ts` tuvo un timeout intermitente de un solo test (`Test timed out in 5000ms`) al correr junto con los otros 46 archivos. **No es una regresión de código**: el mismo test pasa limpio en 5.68s cuando se corre aislado, y el job "Quality" de CI (GitHub Actions, runner limpio de Ubuntu) pasa completo en cada uno de los últimos 3 pushes a `main`. Todo apunta a contención de recursos de esta máquina (sesión larga con muchos procesos concurrentes), no a un defecto real — vale la pena confirmarlo de nuevo en la máquina nueva antes de asumir que es un problema del código.

**Seguridad del repo**
- No se encontraron archivos `.env` con valores reales, ni credenciales/API keys hardcodeadas en el código fuente (`git grep` sobre patrones típicos de API key/token no encontró nada).
- El único archivo con "secret" en el nombre (`e2e/fixtures/redact-secret.pdf`) es un PDF sintético de prueba generado por `e2e/fixtures/generate-fixtures.mjs` para el test de `redact-pdf` — no contiene datos sensibles reales.
- `.gitignore` ya cubre correctamente `node_modules/`, `.next/`, `.vercel`, `/build`, `.env*`, `*.tsbuildinfo`, `next-env.d.ts`, `.evidence/`, `.local-test-assets/` y los artefactos de Playwright. No hubo que agregar nada.
- `.claude/settings.local.json` está ignorado por el gitignore global del usuario (`~/.config/git/ignore`), no por el del proyecto — normal, es config local de Claude Code, no del proyecto.

**Deploy (Vercel, vía integración de GitHub)**
- Proyecto Vercel: `optimus-pdf` (team `optimus-reframe`), framework Next.js, auto-deploy conectado a `main`.
- El último deploy de producción (`dpl_9AekPFKq3y7AJC7T4o45xNZL3iPw`, estado `READY`) corresponde exactamente al commit `654b9b0` (el HEAD actual de `main`) — se disparó solo al mergear el último PR, no hizo falta disparar nada manualmente en esta auditoría.
- URL de producción `https://optimuspdf.kpwr.dev` responde **HTTP 200**. Se probaron también `/pdf-to-word`, `/pdf-to-csv` y `/protect-pdf` (rutas nuevas de las últimas dos fases) — las tres responden 200.
- Dominios activos: `optimuspdf.kpwr.dev` (custom), `optimus-pdf.vercel.app`, `optimus-pdf-optimus-reframe.vercel.app`, `optimus-pdf-git-main-optimus-reframe.vercel.app`.

**CI (GitHub Actions)**
- Job "Quality (types, lint, unit tests, build)": **pasa** en los últimos 3 pushes a `main`.
- Job "E2E (Playwright, Chromium)": **falla** en los últimos 3 pushes a `main`, siempre en los mismos 2 tests de `e2e/specs/compress.spec.ts` (nivel de compresión "extremo" no rasteriza como se espera, y el porcentaje de reducción de tamaño da 0% en el runner de CI). Confirmado que es preexistente — ya fallaba en el push anterior a esta sesión (commit `c43cc54`), y ninguno de los cambios recientes toca `compress.ts` ni su test. No bloquea el deploy (Vercel no depende del resultado de este job). Ya hay una tarea de seguimiento flotante para esto (`task_7f3e9311`).

---

## 2. Pendiente bloqueado por decisión/configuración externa (no lo puedo resolver yo directamente)

- **"Web to PDF"** (Fase D del plan, `docs/development-plan-2026-07.md`): pedirle a un usuario que pegue una URL viva (no un archivo) choca con CORS para sitios de terceros arbitrarios — probablemente necesita un proxy de servidor. Hoy el proyecto es 100% client-side por decisión explícita de diseño (sin backend). Añadir infraestructura de servidor es una decisión de arquitectura que le corresponde al dueño del producto, no algo que deba decidir yo.
- **Retomar `powerpoint-to-pdf`** (dirección Office→PDF) con mejor fidelidad: el spike con librerías permisivas (MIT) no dio calidad suficiente. La única vía con mejor fidelidad conocida implica una dependencia AGPL-3.0, y el propio plan dejó esa pregunta ("¿se acepta AGPL en algún caso?") como pendiente de confirmación explícita del dueño del producto — nunca se cerró formalmente, aunque en la práctica no hizo falta para las fases ya hechas.
- No hay secrets ni API keys de terceros configurados en el proyecto hoy (confirmado en la auditoría de git), así que no hay nada bloqueado por esa vía *todavía* — pero cualquier fase futura que agregue un backend (por ejemplo, para resolver "Web to PDF") sí los va a necesitar.

## 3. Pendiente de desarrollo, abordable sin bloqueos externos

1. **Arreglar el E2E de `compress-pdf` en CI** — los 2 tests de `compress.spec.ts` que fallan en el runner de GitHub Actions (ver sección 1). Ya tiene una tarea de seguimiento creada.
2. **Investigar el timeout intermitente de `wordToPdf.test.ts`** al correr la suite completa de Vitest en local (no ocurre en CI ni en aislamiento) — probablemente ajustar `testTimeout` global o el pool de workers de Vitest si se repite en la máquina nueva.
3. **Fase 4 del plan de desarrollo — "Fase B" (esfuerzo moderado, sin dependencias nuevas)**: 9 herramientas listas para construir sobre motores ya existentes — ver/editar/quitar metadatos, gestión de adjuntos, header/footer, stamps, quitar anotaciones, redimensionar páginas, dividir páginas, combinar a una sola página larga, y **crear formularios PDF** (con sinergia directa: reutiliza `FieldPlacer.tsx`/`detectFields.ts`, ya construidos para rellenar formularios).
4. **Investigación de licencias para la Fase C del plan**: decodificadores para HEIC/PSD/TIFF (candidatos: `heic2any`/`libheif-wasm`, `ag-psd`, `utif.js`) antes de extender `jpg-to-pdf` a esos formatos — nadie ha confirmado licencia real todavía, es investigación pendiente, no una decisión de producto.
5. **Preguntas de arquitectura abiertas de la Fase D**: si `pdf-lib` puede producir un PDF linealizado (fast web view) — no investigado; y si existe un parser de `.msg` (Outlook) con licencia permisiva para "Email to PDF" (el caso `.eml`, en cambio, es texto plano fácil de parsear).

---

## 4. Recomendación

**Empezar por la Fase 4 del plan ("Fase B"), priorizando "Create PDF form".** Es la que tiene mejor relación esfuerzo/bloqueo: no necesita librerías nuevas, no depende de ninguna decisión de licencia o arquitectura pendiente, reutiliza motores que ya están en producción y probados (`FieldPlacer.tsx`/`detectFields.ts`), y sigue el mismo patrón "una herramienta a la vez, validada antes de la siguiente" que ya funcionó bien en la fase anterior.

Antes de apilar otra fase encima, vale la pena cerrar el punto 1 (el E2E de `compress-pdf` en CI) para que el pipeline vuelva a estar completamente verde — es rápido, no depende de nada externo, y evita acostumbrarse a un CI en rojo "conocido" que después puede esconder una falla real.

Los dos puntos bloqueados (Web to PDF con proxy de servidor, y AGPL para PowerPoint) no son urgentes: ninguno tiene una fase de implementación esperando detrás, así que no hace falta resolverlos antes de seguir con la Fase 4.
