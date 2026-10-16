# Plan «Firma ágil» — Firmar PDF para contratos de servicio (adjuster de seguros, iPad)

Autor: planificador (Opus 5.5, solo plan e investigación). Fecha: 2026-10-14. Base: `main` @ `1008d67` (árbol limpio).
Estado: **PLAN.** U0.1 en construcción (2026-10-14); el resto sin construir. **Revisión 2 (2026-10-14): decisiones del usuario y
ampliaciones en §9, que PREVALECE sobre §3-§7 donde difieran** (nuevas unidades U0.7, U4.4-U4.8, F6 Firmas por imagen, F7
Extractor, F8 IA opcional; F5 aparcada; nuevo orden de entrega en §9.8).

> Regla del proyecto: Next.js 16 con cambios incompatibles. Antes de tocar rutas, `Link`, navegación o historial, el
> constructor lee `node_modules/next/dist/docs/` (en este plan se citan `01-app/01-getting-started/04-linking-and-navigating.md`
> §«Native History API» y `01-app/03-api-reference/02-components/link.md` §`onNavigate`). `cacheComponents` NO está activo en
> `next.config.ts`: al navegar, la página de Firmar se DESMONTA (no hay `<Activity>` que conserve su estado).

---

## 0. Pedido del usuario (resumen)

1. No perder trabajo (BACK, recarga, cierre) y poder retomarlo; aviso al salir.
2. El turno 2 de 2 no se dejaba hacer (2 documentos × 2 firmantes × firmas distintas).
3. Asignación simple: «misma firma en doc 1-2 y otra en doc 3-4», copias.
4. Plantillas de campos por tipo de documento (1 o 2 firmantes) que aparecen solas al cargar el documento.
5. «Mis documentos» en Inicio con ✓/✗ de plantilla y «Configurar plantilla».
6. Exportar/importar `.zip` de plantillas + PDF base entre navegadores.
7. Autollenado desde la póliza (nombre, teléfono, email, dirección, aseguradora, tipo de reclamo…).
8. Solicitar firma por email (firma remota).
9. Quitar la hoja final «Certificado… SHA-256».
10. (Ampliación) «Recientes → Continuar» no recupera el trabajo.

---

## 1. Auditoría del estado actual (leído en el código, no supuesto)

### 1.1 Qué existe ya

| Pieza | Dónde | Qué hace hoy |
|---|---|---|
| Modelo multi-documento | `src/app/sign-pdf/docSet.ts:67-82` (`SignerBlock`), `:237-280` (`ensureBlocks`) | Estado por `DocId`; **bloques** = (firmante, trazo de firma + iniciales, `appliesTo: DocId[]`, sello por documento). Invariante: un documento pertenece a ≤1 bloque por firmante. Modo «Mismas» = 1 bloque por firmante para todos; «Distintas» = 1 bloque por (firmante, documento). |
| Límites | `signLimits.ts:16-25` | `MAX_SIGNERS = 2`, `MAX_DOCUMENTS = 10`, 100 MB/doc, 200 MB total. |
| Ceremonia multi | `BlockCeremony.tsx` | Traspaso → captura → revisión por FIRMANTE; dentro, una fila por bloque. |
| Ceremonia 1 doc | `SigningCeremony.tsx` | Igual, sin bloques. |
| Borrador de sesión (≥2 docs) | `SessionDraftAutosave.tsx`, `sessionDraft.ts`, `signDrafts.ts:110-121` | IndexedDB `optimuspdf-sign-drafts` v2: PDFs + firmantes + campos + **bloques CON trazos** (firmas/iniciales) + paso. Debounce 350 ms; volcado en `beforeunload/pagehide/visibilitychange` (`flushOnPageHide.ts`). Tope 150 MB/sesión, 10 borradores, 300 MB. |
| Borrador de 1 doc | `SignToolClient.tsx:2153-2246` | Igual pero por `documentKey`, incluye `captures`. |
| Retomar | `DraftsSheet.tsx`, `SignToolClient.tsx:908-1013` | SOLO desde el botón fantasma «Ver borradores» (`SignToolClient.tsx:1319-1321`). |
| Plantillas | `signTemplates.ts:25-59`, `TemplatesSheet.tsx`, `SignToolClient.tsx:1087-1244` | `localStorage`, máx. 10, `{signers[{name}], fields[{signerIndex,pageIndex,type,rect}], textFields[{pageIndex,rect,label?,type?}]}`. **No están ligadas a ningún documento**: se eligen a mano y se aplican al activo o «a todos». Sin versión de documento, sin variantes 1/2 firmantes, sin origen de dato. |
| Config exportable | `signConfig.ts` (v1 un doc; v2 `documents[]` + `blocks` sin trazos) | `.zip` con PDFs + `manifest.json`, validación estricta al importar. |
| Baúl de firmas | `signVault.ts`, `signVaultFile.ts:32,59` | Firmas opt-in en IndexedDB; export `.zip` cifrado **PBKDF2-SHA256 600 000 it. → AES-GCM-256** (patrón reutilizable). |
| Autollenado actual | `src/lib/valueHistory.ts`, `useDocumentSession.ts` (`reuseMatches`) | Historial de valores por **etiqueta normalizada** (`normalizeFieldLabel`, `src/lib/pdf/sign.ts:120-127`) en `localStorage`, con aviso. Sin póliza, sin «datos del cliente». |
| Detección de campos | `src/lib/pdf/detectFields.ts:60-84`, `detectSlots.ts` | `DetectedField {pageIndex, rect, label?, type: text|checkbox|date|initials, source, confidence}`. Base útil para mapear etiqueta → dato. |
| OCR local | `src/lib/pdf/ocr.ts` (tesseract.js 7, `spa/eng/fra/por`) | Descarga núcleo y datos de `cdn.jsdelivr.net` (ya en CSP). |
| Modelos locales | `src/lib/pdf/summarize.ts:70-139` (WebLLM, Llama-3.2-1B q4 ~0,9 GB VRAM; Qwen2.5-1.5B), `translate.ts` (Transformers.js) | Requieren WebGPU (WebLLM) y descargar pesos de Hugging Face con consentimiento. |
| Certificado | `src/lib/pdf/sign.ts:182-204` (tipo), `:301-361` (`appendCertificatePage`), `:463-470` (hash del firmado + página) ; `SignToolClient.tsx:626-637`; textos `strings.ts:600-606` | Página final «Certificado de finalización» + «Hash SHA-256 del documento firmado» + fecha + firmantes + descargo. Flag `completionCertificate` **activo por defecto** (`signFeatureFlags.ts:42`), con interruptor en Ajustes (`src/lib/locales/es.ts:477-480`). |
| Navegador | `playwright.config.ts:102-108` | Proyectos opcionales `webkit`, `webkit-mobile` (iPhone 15 Pro). **No hay perfil iPad.** |
| CSP | `next.config.ts` (`connect-src` solo `self`, huggingface, githubusercontent, jsdelivr) | Cualquier backend nuevo exige ampliar `connect-src`. |
| Arquitectura | `docs/server-required-features.md:11-32` | «Ninguna funcionalidad requiere servidor»; «enviar por correo» está listado como cambio de arquitectura que requiere aprobación del dueño. |

### 1.2 ¿Por qué se «perdió» el trabajo al pulsar BACK?

El botón «Atrás» **de la app** (`SignToolClient.tsx:2763-2772`) solo cambia de paso (`setOptions({step: previousStep})`); no
borra nada. El BACK que describe el usuario es casi seguro el del **navegador** (en iPad: botón Atrás de Safari o el gesto de
deslizar desde el borde izquierdo, fácil de disparar sin querer al firmar sobre el lienzo). Esa navegación desmonta la página
(no hay `cacheComponents`). Lo que el código dice:

1. **El borrador muy probablemente SÍ se guardó** (sesión de 2 documentos en «Varios firmantes»: `SessionDraftAutosave.tsx:120-187`
   guarda 350 ms después de cada cambio, con firmas incluidas, y vuelca al desmontar `:183-187`).
2. **Pero nada lo ofrece al volver**: la única entrada es «Ver borradores» (botón fantasma pequeño, `SignToolClient.tsx:1319`).
   Al volver a subir los MISMOS PDF, Firmar **no busca** si hay borrador de esos documentos: `loadDraft`/`loadSessionDraft`
   solo se llaman desde la hoja (`SignToolClient.tsx:910, 951`). Compárese con Editar, que restaura solo al reabrir el mismo
   archivo por huella (`src/app/edit-pdf/useEditDrafts.ts:95-133`), y PDF Pro, que lo ofrece (`useProSession.ts:74-78`).
   **Causa raíz probable: descubribilidad cero del borrador + sin oferta automática + sin aviso al salir.**
3. Vías de pérdida REAL que sí existen hoy:
   - Quitar documentos de la lista hasta quedar <2 **borra el borrador de sesión** (`SessionDraftAutosave.tsx:111-119`), sin
     confirmación ni deshacer.
   - Modo «Solo yo» no guarda borrador (`SessionDraftAutosave.tsx:70-71`, `SoloFlow` comentario `:2932-2933`).
   - PDF abierto con contraseña: nunca se guarda (`:122`).
   - Cierre forzado/pestaña descartada sin evento (límite físico documentado en `flushOnPageHide.ts:6-14`).
   - Safari: navegación privada (se borra al cerrar) y la **regla de 7 días de ITP** (borra IndexedDB/localStorage de un sitio
     sin interacción durante 7 días de uso de Safari; las apps añadidas a la pantalla de inicio llevan su propio contador).
     Importa mucho para plantillas y «Mis documentos» (ver §7).
4. No hay aviso al salir: ni `beforeunload` con confirmación, ni guarda en enlaces internos, ni guarda del historial.

Hipótesis a CONFIRMAR en U0.1 con una prueba E2E (WebKit iPad + Chromium): cargar 2 PDF, 2 firmantes, colocar campos, recoger
firmas, `page.goBack()`, volver, subir los mismos PDF → hoy empieza vacío y el borrador está en «Ver borradores».

### 1.3 ¿Por qué no dejó pasar al turno 2 de 2?

Dos defectos confirmados en el código (cualquiera de los dos explica el síntoma; probablemente se combinaron):

**T1 — El turno vive en estado local y se reinicia al remontar (bug).** `BlockCeremony.tsx:104-105` guarda `turn`/`stage` en
`useState(0)`. La ceremonia vive dentro de `MultiFlow`, montado con `key={docId}` del documento activo
(`SignToolClient.tsx:1495`), y las **pestañas de documentos siguen visibles en el paso Firmar** (`DocumentSessionHost.tsx:337-365`,
`select` en `:143-165`). Tocar la pestaña del documento 2 para «verlo», pasar por «Atrás → Continuar», o cualquier remontaje
devuelve la ceremonia a `turn = 0` y `stage = "handoff"`: vuelve a pedir el **Turno 1 de 2** al firmante 1, que ya firmó
(`ceremonyQueue` incluye a los ya completos, `blockModel.ts:135-137`; la posición no salta al primer pendiente,
`BlockCeremony.tsx:141-143`). La única salida es el botón pequeño «Listo, es mi turno» en la lista de estado
(`BlockCeremony.tsx:475-484`), que no es evidente. Lo mismo en `SigningCeremony.tsx:99-100` (1 documento) al ir «Atrás».

**T2 — Con «firmas distintas por documento», el turno de un firmante incluye TODOS sus documentos, y el botón está desactivado
sin explicar qué falta (UX).** En modo «Distintas» cada firmante tiene un bloque por documento (`docSet.ts:275-277`); el turno
muestra ambos bloques y «Ver cómo queda» exige completarlos todos (`BlockCeremony.tsx:176, 392`: `disabled={!ready}` sin motivo
visible). Quien espera «turno = documento» firma el documento 1, ve el botón apagado y cree que la app no le deja seguir. En
iPad el segundo bloque queda bajo el pliegue.

Menos probable (T3): un trazo «caduca» si cambian los huecos o la huella del documento tras capturarlo
(`blockModel.ts:86-107`, sello por documento) — no ocurre en el flujo normal, pero también deja el botón apagado sin motivo.

### 1.4 Por qué «misma firma en doc 1-2, otra en doc 3-4» es complicado hoy

El modelo lo permite (dos bloques por firmante con alcances {1,2} y {3,4}), pero la UI obliga a: elegir «Distintas» (crea 4
bloques), abrir la hoja de alcance de cada bloque, marcar/desmarcar documentos (cada cambio mueve documentos entre bloques con
anuncios), o en «Mismas» añadir un bloque y reasignar. No hay una vista «qué firma va en qué documento», ni «copias», ni
plantilla que lo deje hecho. Además el concepto «bloque» es interno y no corresponde al lenguaje del usuario («firma A / firma B»).

### 1.5 «Recientes → Continuar» (ampliación)

- Qué se guarda: `src/lib/recent.ts:10-16` → `{id, slug, fileName, date}` en `localStorage` (máx. 20). **Nunca** bytes ni estado
  (regla escrita en `:6-8` y en el subtítulo `src/lib/locales/es.ts` `recent.subtitle`).
- Quién escribe: `ToolShell.tsx:573` al TERMINAR un procesado (con el nombre del archivo de SALIDA, p. ej. `X-firmado.pdf`);
  PDF Pro al abrir (`useProSession.ts:69,124,202`); otros sueltos (compare, pdfa, scan, summarizer).
- Qué hace «Continuar»: `RecentView.tsx:74-80` → `<Link href={toolHref(entry.slug)}>`: **solo abre la herramienta vacía.**
  **Defecto reproducible hoy**: la etiqueta promete continuar y no hay nada que continuar (ni puntero a borrador ni archivo).
- Lo que sí es recuperable existe en otros almacenes: Firmar (`optimuspdf-sign-drafts`), Editar (`optimuspdf-edit-drafts`,
  restaura por huella), PDF Pro (`proDrafts`, «Reabrir el último» y lista con miniaturas en `ProEmptyState.tsx:153-185`,
  `session/RecentDocuments.tsx`). Recientes no los consulta.

---

## 2. Principios de diseño (para que sea fácil, seguro y sin errores)

1. **Configurar una vez, firmar en 2 minutos.** El trabajo repetitivo (colocar campos, decidir quién firma qué) vive en la
   plantilla/kit; el día a día es: elegir kit → datos del cliente → firmas → descargar.
2. **Nada se pierde sin que el usuario lo decida.** Autoguardado + oferta de retomar automática + aviso al salir + deshacer.
3. **Nada se rellena sin confirmar.** El autollenado propone; el usuario revisa en una sola pantalla.
4. **Todo local por defecto.** Lo único que puede salir del dispositivo es la firma remota, y solo si el usuario la elige (§3 F5),
   con cifrado de extremo a extremo.
5. **Lenguaje del usuario**: «Firma A / Firma B», «Firmante 1 (Asegurado)», «Copias», «Plantilla», no «bloque/alcance».
6. **iPad primero**: objetivos ≥44 px, sin depender de hover ni de atajos, probado en WebKit con perfil iPad.

---

## 3. Fases

Convenciones: cada unidad (U) tiene archivos propios, criterios medibles, pruebas (unitarias Vitest, E2E Playwright **headless**,
mutaciones donde hay lógica crítica) y una **puerta de verificación independiente** por fase (agente distinto, contexto limpio,
modelo Sonnet: `aos-verifier-senior` **con `model: "sonnet"`**, por la política de modelos del usuario). Cada fase se despliega
sola cuando su puerta da VERIFIED (commit/deploy solo con autorización del usuario).

### Fase 0 — Urgente: no perder trabajo, turno 2, certificado, Recientes (≈ 14-18 h de agente; valor en 1-2 días)

**U0.1 Reproducción primero (test-first)** — `aos-builder`
- Archivos: `playwright.config.ts` (nuevo proyecto opcional `webkit-ipad` con `devices["iPad Pro 11"]`, `PW_BROWSERS=webkit-ipad`),
  `e2e/specs/sign-recovery.spec.ts` (nuevo), `e2e/specs/sign-ceremony-turns.spec.ts` (nuevo).
- Pruebas que DEBEN FALLAR hoy: (a) 2 docs × 2 firmantes × «Distintas»: firmar turno 1, tocar pestaña del doc 2 → hoy vuelve a
  «Turno 1 de 2» con firmante 1; (b) «Atrás» desde Firmar y «Continuar» → idem; (c) recoger firmas, `page.goBack()`, volver y
  subir los mismos PDF → hoy empieza vacío; (d) recarga a 100/400 ms tras la última firma → debe quedar en borradores (hoy pasa:
  control); (e) Recientes → Continuar tras firmar → hoy herramienta vacía.
- Aceptación: las 5 pruebas existen; (a)(b)(c)(e) fallan en `main` por la causa descrita; (d) pasa. Evidencia en
  `docs/evidence/firma-agil/`.

**U0.2 Ceremonia robusta** — `aos-builder`
- Archivos: `BlockCeremony.tsx`, `SigningCeremony.tsx`, `blockModel.ts` (función pura `firstPendingTurn`), `signSession.ts`
  (campo `ceremony?: {signerId: string; stage: "handoff"|"capture"|"review"}` en la sesión), `sessionDraft.ts` (lo guarda y
  restaura), `strings.ts` (ES/EN).
- Cambios: (1) el turno se **deriva** del primer firmante pendiente al montar y se guarda en la sesión (sobrevive a remontajes,
  pestañas, «Atrás», recarga); (2) al completar un turno, salta al siguiente PENDIENTE; (3) «Ver cómo queda» desactivado muestra
  **qué falta** («Falta: Iniciales · Contrato B») y un botón «Ir a lo que falta» que hace scroll/foco; (4) lista de progreso por
  bloque con ✓ (Firma A ✓, Iniciales A ✓, Firma B ○); (5) en el paso Firmar, tocar otra pestaña de documento NO remonta la
  ceremonia (la ceremonia se monta fuera del `key={docId}` o lee su estado de la sesión; elegir la opción menos invasiva tras
  leer `SignToolClient.tsx:1472-1512`).
- Aceptación: E2E (a)(b) pasan en Chromium y `webkit-ipad`; unitarias de `firstPendingTurn` (0, 1, 2 firmantes; todos firmados;
  firmante sin huecos); ≥6 mutaciones sobre `firstPendingTurn`/restauración mueren; `SigningCeremony` 1 documento cubierto;
  `pdf-pro-modes-sign.spec.ts` sigue verde (comparte componentes vía `SignEmbedded`).

**U0.3 Retomar sin buscar + aviso al salir** — `aos-builder`
- Archivos nuevos: `src/app/sign-pdf/ResumeOffer.tsx`, `src/app/sign-pdf/useLeaveGuard.ts`, `src/app/sign-pdf/draftLookup.ts`;
  toca `SignToolClient.tsx` (montaje), `SessionDraftAutosave.tsx` (quitar docs), `strings.ts`.
- Cambios:
  1. **Tarjeta «Tienes una firma sin terminar»** al entrar en `/sign-pdf` si hay borradores: documentos, firmantes, «firmas
     recogidas: Ana ✓, Luis pendiente», hace cuánto; «Retomar» (primario) / «Descartar» (con confirmación) / «Ver todos».
  2. **Oferta al subir archivos**: si la huella (`documentContentKey`) de los PDF subidos coincide con un borrador, ofrecer
     «Retomar lo que tenías» antes de empezar de cero (patrón de PDF Pro).
  3. **Sesión en la URL**: al tener progreso, `window.history.pushState(null, "", "?s=<idOpaco>")` (integrado con el router de Next
     16, ver docs citadas). Recargar con `?s=` restaura solo. **BACK del navegador** vuelve a `/sign-pdf` sin `s` (misma ruta, no
     desmonta): se muestra hoja «¿Salir de la firma? Todo está guardado en este dispositivo» con «Seguir firmando» (vuelve a
     `pushState`) / «Salir». El id es opaco (sin PII).
  4. `beforeunload` con confirmación solo mientras hay progreso no volcado o una ronda a medias (Safari iOS lo ignora: por eso 1-3).
  5. Enlaces internos de la cabecera: guarda con `Link onNavigate` + `preventDefault()` (Next 16) mostrando la misma hoja.
  6. Quitar documentos con progreso: confirmación + «Deshacer» 6 s; el borrador de sesión NO se borra hasta que expira el deshacer.
  7. «Ver borradores» pasa a botón visible de 44 px con contador.
- Aceptación: E2E (c) pasa en Chromium y `webkit-ipad`; recarga con `?s=` restaura 10/10; BACK muestra la hoja y «Seguir
  firmando» conserva todo; quitar un documento y deshacer conserva el borrador; a11y: hoja con foco atrapado y región viva.

**Estado U0.3 (construida y verificada por el constructor; pendiente de la puerta V0):**
- Piezas: `ResumeOffer.tsx` (tarjeta de entrada y oferta al subir), `draftLookup.ts` (resumen «Ana ✓, Luis pendiente» y búsqueda por
  conjunto EXACTO de huellas), `sessionUrl.ts` (`?s=<id>`: una sola entrada de historial, reutilizada si el progreso se va y vuelve,
  entrada base marcada), `useLeaveGuard.ts` (`beforeunload` condicionado, hoja del «Atrás», guarda de enlaces),
  `useSessionRestore.ts`, `LeaveSheet.tsx`, `SessionWorkSync.tsx`, `signWork.ts`, `draftActivity.ts`, `useRecoverableDrafts.ts`;
  `src/lib/navigationGuard.ts` + `src/components/layout/GuardedLink.tsx` (guarda opt-in con `Link onNavigate`: cabecera, menú,
  barra lateral, barra inferior y pie); `ToolShell` gana dos props opcionales (`renderIdle`, `onFilesChanged`).
- Convivencia con U0.6: `?resume=` manda; tras restaurar se limpia con `replaceState` y, al haber progreso, se **convierte en `?s=`**
  (por eso `recent-continue` (e7) de Firmar ahora espera `?s=` y el «Atrás» pasa por la hoja).
- Quitar documentos: el aviso «Quitaste … · Deshacer» (6 s) es la confirmación; el borrador de sesión se borra a los 6,5 s
  (`SESSION_DELETE_GRACE_MS`), no antes; deshacer devuelve archivos y sesión tal cual.
- **Decisión punto 9 («Solo yo»): NO se guarda borrador** (ni sesión ni documento). Evidencia: su estado (imagen de la firma, proporción,
  colocación) no está en el esquema de los borradores; guardarlo dejaría la firma propia en IndexedDB sin que nadie lo decida, cuando
  el baúl (`signatureVault`) existe para que eso sea opt-in; el aviso de privacidad solo promete guardar «mientras trabajas con varios
  firmantes»; rehacerlo cuesta segundos, no una ronda con varias personas; y el interruptor de U0.4 aún no existe. Por coherencia
  la guarda de salida tampoco actúa en «Solo yo» (no promete lo que no hay). Se revisa en U0.4.
- Límites conocidos: Safari de iPhone/iPad ignora `beforeunload` (por eso existen la entrada `?s=` y la hoja); un doble «Atrás» muy
  rápido sale sin hoja (la segunda pulsación ya no está en la herramienta); tras descargar, la tarjeta de entrada seguía ofreciendo el
  borrador de la ronda ya entregada: U0.4 lo resuelve con la casilla «Borrar el borrador de esta firma» (marcada por defecto).

**U0.4 Privacidad del borrador con firmas** — `aos-builder`
- Hoy las firmas recogidas se guardan en el borrador solo con un aviso (`strings.ts:860-861`). Propuesta (decisión D3): primer
  uso en el dispositivo → aviso de una línea con interruptor «Guardar también las firmas recogidas para no perderlas (solo en este
  iPad, se borran a los 7 días)», **por defecto activado**; desactivado → el borrador guarda todo menos trazos (al retomar se
  piden de nuevo). Caducidad: borradores con trazos se purgan a los 7 días; tras descargar con éxito se ofrece «Borrar el
  borrador de esta firma» (marcado por defecto).
- Archivos: `signDrafts.ts` (campo `expiresAt`, purga en `listAllDrafts`), `sessionDraft.ts`, `PrivacyNotice.tsx`, `strings.ts`,
  `SettingsView.tsx` (interruptor persistente).
- Aceptación: unitarias de purga y de «sin trazos»; E2E: con el interruptor apagado la recarga recupera campos y firmantes pero
  no firmas; textos ES/EN revisados.

**Estado U0.4 (construida y verificada por el constructor; pendiente de la puerta V0):**
- Ajuste `signaturesInDraft` (`signFeatureFlags.ts`, **encendido por defecto**, en Ajustes y en el aviso de privacidad abierto con
  la misma casilla «Guardar también las firmas recogidas para no perderlas»; el texto del aviso dice según su estado si las firmas
  viajan en el borrador o se piden de nuevo). Se lee **al escribir** el borrador (`saveSessionDraft` / `saveDraft`), no al
  agendarlo; los dos autoguardados lo pasan y lo ponen en sus dependencias, así que apagarlo con la sesión en pantalla vuelve a
  guardar al instante y quita los trazos de IndexedDB. Apagarlo NO toca a escondidas los borradores ya guardados (Ajustes lo dice).
- Apagado: los bloques salen sin firma, iniciales ni sellos (`draftPrivacy.ts`) y el borrador lleva `signaturesOmitted: true`; el
  turno guardado de la ceremonia se descarta (describía un avance que ya no existe). La tarjeta/oferta de retomar dice «Firmas: se
  volverán a pedir» en lugar de «Ana pendiente, Luis pendiente».
- Caducidad: `expiresAt = savedAt + 7 días`, **solo** en borradores con trazos y **renovada en cada guardado** (el plazo cuenta
  desde el último guardado, no desde la primera firma). `purgeExpiredDrafts` (una transacción: metadatos y todos los bytes) corre
  dentro de `listAllDrafts` (tarjeta, «Ver borradores», `?s=`, `?resume=`, Recientes) y `loadDraft`/`loadSessionDraft` rechazan lo
  caducado; las listas sueltas también lo filtran. Un borrador sin trazos no caduca.
- Casilla «Borrar el borrador de esta firma (incluye las firmas guardadas en él)», marcada por defecto, dentro de la tarjeta de
  descarga (`DownloadScreen.extras`, `ToolShell.renderDownloadExtras` + `onDownloaded`). **Borra solo al pulsar «Descargar»** (no al
  aparecer la pantalla ni al irse sin descargar), espera a que se asiente el último guardado pendiente y comprueba que el
  borrador ya no está antes de decir «Borrador borrado»; con la casilla desmarcada lo conserva. No se ofrece en «Solo yo» (no hay
  borrador), con fallos parciales (algún documento sigue sin firmar) ni en una ronda demasiado grande para guardarse.
  **Resultado de PDF Pro · Firmar: no aplica** (`persistDraft={false}`: ese modo no escribe borradores de Firmar; sus firmas se
  estampan en el documento de trabajo).
- Pendiente/fuera de alcance: exportar/importar firmas (fase posterior, decisión D3); un borrador abierto durante >7 días en una
  pestaña que nunca guarda no se renueva (solo caduca al listar/cargar).

**U0.5 Certificado SHA-256** — `aos-builder` (lógica) + `aos-builder-lite` (textos)
- Recomendación (D2): **desactivado por defecto**, no eliminado. Motivo: el usuario y su cliente lo leen como «firma
  certificada» y confunde; pero la trazabilidad tiene valor si algún día hay disputa.
- Cambios: (1) `DEFAULT_SIGN_PDF_FEATURE_FLAGS.completionCertificate = false` **más migración única**: `writeFlags`
  (`signFeatureFlags.ts:112-123`) guarda TODOS los flags, así que quien tocó cualquier ajuste tiene `true` grabado; añadir
  `optimuspdf.signPdf.featureFlags.v` y, al subir de versión, poner `completionCertificate=false` una vez. (2) Renombrar a
  «Página de registro (no es una firma certificada)» y en el texto del PDF «Registro de firmas» (no «Certificado»). (3) En su
  lugar, por defecto: metadatos del PDF (`Producer: OptimusPDF`, `ModDate`, palabra clave `optimuspdf-signed`) sin nombres.
  (4) Opcional (apagado): «Incluir registro .json aparte» en el ZIP (hash SHA-256 del firmado, fecha, firmantes, nº de páginas),
  nunca dentro del PDF.
- Archivos: `signFeatureFlags.ts`, `src/lib/pdf/sign.ts` (metadatos), `SignToolClient.tsx:626-637`, `src/lib/pdf/signBatch.ts`
  (json opcional), `strings.ts`, `src/lib/locales/{es,en}.ts`.
- Aceptación: PDF firmado con ajustes por defecto tiene exactamente las páginas del original (prueba unitaria + E2E que cuenta
  páginas); usuario con flags antiguos (`localStorage` con `completionCertificate:true`) migra a `false` una sola vez y, si luego
  lo activa, se respeta; mutación que quite la migración muere.

**U0.6 Recientes honesto y «Continuar» que continúa** — `aos-builder`
- Corrección mínima de Fase 0 (el modelo unificado completo llega en F2, §3 U2.6):
  1. `RecentView.tsx`: sección **«Sin terminar»** arriba, alimentada por los borradores reales (Firmar: `listAllDrafts`; Editar:
     `listEditDrafts`; PDF Pro: `listProDrafts`) con nombre, herramienta, fecha y (si existe) miniatura; «Continuar» navega a
     `/{herramienta}?resume=<tipo>:<id>` y la herramienta restaura (Firmar: `handleResumeEntry`; Editar: carga por id; Pro:
     `openDraft`).
  2. Si el borrador ya no existe: mensaje claro «Este trabajo ya no se puede recuperar en este navegador (se borró o caducó)» +
     «Abrir de nuevo» (dropzone).
  3. Las entradas del historial sin estado cambian «Continuar» por **«Abrir herramienta»** (no promete lo que no hace).
  4. `recent.subtitle` y metadata de `/recent` dejan de decir «nunca el documento» (los borradores SÍ guardan documentos):
     texto exacto «Los trabajos sin terminar se guardan solo en este navegador, con el documento, para poder continuarlos».
- Archivos: `RecentView.tsx`, `src/lib/recent.ts` (tipo `resume?`), nuevo `src/lib/resumeLinks.ts` (parseo seguro de
  `?resume=`: lista blanca de tipos, id con regex), `SignToolClient.tsx`, `src/app/edit-pdf/*` (punto de entrada), `src/app/pdf-pro/useProSession.ts`, locales.
- Aceptación: E2E (e) pasa en las tres herramientas (abrir → trabajar → salir → Recientes → Continuar restaura campos/firmantes/
  ediciones); con el borrador borrado, mensaje + «Abrir de nuevo»; `?resume=` con valores manipulados no rompe ni ejecuta nada.

**Puerta V0** (Sonnet, contexto limpio): las 5 E2E de U0.1 + regresión `sign-multi`, `sign-quality`, `pdf-pro-modes-sign`,
`a11y-sweep` en Chromium y `webkit-ipad`; `tsc`, `eslint`, `vitest` completos. **Se despliega Fase 0 sola.**

**F0-fix (2026-10-14, tras la verificación independiente de V0, que REFUTÓ la Fase 0 por tres defectos mayores).** Estado: construida
y verificada por el constructor; pendiente de la nueva puerta.
- **D2 · el borrador no puede decir «guardado» si no se pudo guardar.** Antes `saved = !tooBig` y `SessionDraftAutosave` ignoraba el
  `{ ok: false, reason: "unavailable" }` de `saveSessionDraft` (y `saveDraft` ni lo devolvía): con la cuota llena o el almacenamiento
  bloqueado (Safari privado: `SecurityError` al abrir) la hoja de «Atrás» decía «Todo está guardado… podrás retomarlo». Ahora
  `saveDraft`/`saveSessionDraft` informan de TODO fallo de escritura, ambos autoguardados lo cuentan (`DraftWriteReport`,
  `draftWriteReport.ts`) y `SessionWorkSync` fija `saved: false` con su razón (`unsaved: "tooBig" | "failed" | "solo"`). La hoja dice
  «No se pudo guardar tu trabajo en este dispositivo: si sales se perderá» («Seguir firmando» sigue siendo la acción primaria), el
  `beforeunload` nativo se activa y `DraftHealthNotice` muestra «Sin autoguardado: el navegador no deja guardar aquí. Descarga antes de
  salir» mientras dure; el siguiente cambio reintenta y el aviso se retira solo. «Solo yo» (no guarda borrador) con trabajo hecho
  (firma creada, valores escritos, texto editado) ahora SÍ pregunta antes de salir y la hoja dice «Este modo no guarda borrador»
  (`?s=solo`: valor reservado, no es un id válido y recargar no restaura nada).
- **D3 · «Empezar de nuevo» con el mismo PDF no pisa el borrador del primero.** El id del borrador de UN documento ya no es la
  huella del PDF sino `huella (32 hex) + nonce (32 hex)` (`draftIds.ts`: 64 hex, la misma forma, así que `?s=`, `?resume=` y Recientes
  lo siguen validando); la huella completa va aparte (`DraftMeta.fingerprint`, que es lo que busca la oferta al subir los mismos PDF).
  Cada sesión de trabajo estrena su id (`singleDraft.ts`: lo guarda `SignToolClient`, por documento vivo y huella) y retomar un borrador
  sigue sobre SU id. Con varios borradores del mismo PDF la oferta presenta el más reciente («Hay N más sin terminar», «Ver todos») y
  «Ver borradores» los distingue por fecha y firmantes. Migración: un borrador anterior (sin `fingerprint`, id = huella) se lee y se
  sigue guardando bajo su id (`draftFingerprint`). **Diagnóstico de otras herramientas:** las sesiones de VARIOS documentos ya tenían id
  propio por sesión (`newSessionId`; comprobado con la prueba `d3-multi`). Editar PDF y PDF Pro nombran su borrador con la huella del PDF
  y lo RESTAURAN al reabrir el mismo archivo (no ofrecen «empezar de nuevo» sobre él), así que no hay pisado silencioso entre trabajos;
  sí comparten el patrón «última escritura gana» entre pestañas (D1). No se tocaron.
- **D1 · dos pestañas con la misma sesión.** Cada borrador (sesión y documento suelto) lleva `rev` (contador) y `writerId` (id por
  pestaña, `draftIds.newTabId`). La escritura compara DENTRO de su transacción de IndexedDB (`isStaleWrite`): si lo guardado lo escribió
  OTRA pestaña con una `rev` mayor que la que esta cargó o escribió por última vez, NO lo pisa: aborta y reintenta escribiendo la copia
  (archivos incluidos) bajo un id nuevo (`copyOf` = el original), avisa («Otra pestaña modificó esta firma; esta copia se guardó aparte» +
  «Ver borradores») y sigue guardando sobre la copia. `BroadcastChannel` (con `storage` de `localStorage` como respaldo) avisa a la
  pestaña vieja en cuanto la otra guarda («Recarga para ver la versión más reciente; lo que cambies aquí se guardará como copia aparte»).
  Los borrados que decide el autoguardado (sin progreso, ronda de un solo documento, relevo de un documento suelto por una sesión)
  usan `unlessNewer`: una pestaña desactualizada no borra lo de otra. Una sola pestaña no cambia en nada (mismo `writerId`; una
  lectura más dentro de la misma transacción).
- **D4 · caducidad.** Un borrador con firmas guardado antes de U0.4 (sin `expiresAt`) recibe `savedAt + 7 días` y se guarda al
  listarlo (`purgeExpiredDrafts`), abrirlo o filtrarlo (`withLegacyExpiry`), sin tocar `rev` ni `writerId`; si ya pasó, caduca.
- **D5 · borrar tras «Descargar».** LÍMITE: la página no puede confirmar que el archivo LLEGÓ (un `<a download>` no avisa; en Safari de
  iPad puede quedarse en una hoja de descargas o fallar sin decirlo). Por eso el borrado se retrasa `DELIVERED_DELETE_DELAY_MS` (8 s)
  con un aviso «El borrador se borrará en unos segundos» y «Deshacer» (44 px); «Deshacer» conserva el borrador y desmarca la casilla;
  irse de la página antes del plazo no borra nada (ante la duda el borrador se queda y caduca a los 7 días). Redacción honesta: no
  dice «borrado» hasta que el borrado está comprobado.
- **D6 · prueba.** `resumeFlow.test.tsx` espera con `waitFor` la región viva en lugar de leerla de golpe.
- **D7 · firma que deja de valer.** Si se edita el texto original (F2) —o los huecos— después de que alguien firmó, su sello por
  documento deja de coincidir. `staleSigners` / `staleCaptureReason` (con `staleReason`: texto / huecos / documento) lo detectan y la
  ceremonia dice «La firma de Ana ya no es válida porque cambiaste el texto del documento: Ana debe volver a firmar», marca a Ana con ✗
  «Debe volver a firmar» en la lista de la ronda y el trazo con «ya no es válida» en la lista de progreso, y el turno vuelve a Ana
  (`resolveCeremony(..., redirectTo)`; derivado, no se guarda).

### Fase 1 — Asignación simple: firmas A/B, copias, orden (≈ 14-18 h)

**Modelo**: sin cambiar el núcleo (`SignerBlock` sigue igual), se añade una capa de presentación: un **grupo de firma** es un
bloque con nombre visible («Firma A», «Firma B»). Por documento: `signers: SignerId[]` (quién firma ese documento, derivado de los
huecos) y `group: "A"|"B"|…` por firmante. Nuevo `copies: 1..5` por documento (entrega).

**UX («¿Quién firma qué?», reemplaza «Mismas/Distintas»)**: una tabla compacta documentos × firmantes; en cada celda un chip
`A`/`B`/`—` (tocar alterna). Atajos arriba: «Una firma para todos» (todo A), «Una firma por documento», «Por grupos». Columna
«Copias» con −/+. Debajo, resumen en lenguaje natural: «Ana firma 4 documentos con 2 firmas: A (Contrato, Anexo) y B (Carta,
Autorización). Luis firma 2 con 1 firma. Se descargarán 8 archivos.» Caso del usuario: 4 documentos, chips A,A,B,B → 2 trazos por
firmante en un único turno.

**Ceremonia**: el turno de cada firmante lista «Firma A — para: Contrato, Anexo» y «Firma B — para: Carta, Autorización», con
progreso; el orden de turnos se puede reordenar (arrastrar o ↑↓) y se guarda.

**Anti-errores**: (1) pantalla **«Revisar antes de descargar»** con miniatura de cada página que lleva firma/iniciales/texto y
contador por documento; (2) validación bloqueante: firmante sin hueco en un documento que dice firmar, hueco sin firmante, campos
obligatorios vacíos; (3) «Deshacer» en cambios de la tabla.

**Copias**: el ZIP incluye N archivos idénticos `Contrato - Ana y Luis (copia 2).pdf` (vía `uniqueZipName`). Si las copias deben
firmarse por separado (originales distintos), se cargan como documentos distintos: se explica en la ayuda.

Unidades:
- U1.1 `docSet`/`blockModel`: `groupsMatrix(blocks, docs)` ↔ `blocksFromMatrix(matrix)` puras (ida y vuelta sin pérdida),
  `copies` en `DocState`; `sessionDraft`/`signConfig` v3 leen v1/v2. — `aos-builder`. Mutaciones ≥10.
- U1.2 `AssignmentMatrix.tsx` (nuevo) + integración en el paso Firmantes. — `aos-builder` (skills `frontend-ui-engineering`, `apple-design`).
- U1.3 `BlockCeremony` con grupos y orden; `ReviewBeforeDownload.tsx` (nuevo); `signBatch.ts` copias. — `aos-builder`.
- U1.4 Textos ES/EN y ayuda. — `aos-builder-lite`.
- Aceptación: E2E «4 documentos, 2 firmantes, A,A,B,B, 2 copias» → 8 PDF en el ZIP, cada uno con la firma correcta (se
  comprueba comparando el PNG empotrado por documento); el usuario lo configura en ≤6 toques desde la carga; iPad 44 px.
- **Puerta V1** y despliegue.

### Fase 2 — Plantillas por tipo de documento + «Mis documentos» + Recientes unificado (≈ 26-34 h)

**Qué guarda una plantilla (IndexedDB `optimuspdf-doc-library`, NO `localStorage`)**:
```
DocumentEntry { id, name, docType, fileName, pageCount, pageSizes[], fingerprint, pdfBlobRef?, createdAt, updatedAt,
                templateIds[] }
DocTemplate   { id, documentId, name, version, updatedAt,
                variants: { "1": Variant, "2": Variant },            // 1 o 2 firmantes
                roles: [{ key: "signer1", label: "Asegurado" }, { key: "signer2", label: "Co-asegurado" }] }
Variant       { fields:     [{ roleIndex, pageIndex, type: "signature"|"initials", rect, required: true }],
                textFields: [{ pageIndex, rect, type: text|date|checkbox|initials, label, dataKey?, required, rule?: "today" }] }
Kit           { id, name, items: [{ documentId, copies, group per role }], order }   // «Claim nuevo» = doc1..doc4
```
Posiciones normalizadas 0..1 por página (las mismas que ya usan `SignatureField.rect` y `DetectedField.rect`).

**Reconocer el documento al cargarlo (huella robusta)**, en un worker:
1. Exacta: SHA-256 de los bytes (`documentContentKey`) → coincidencia 100 %.
2. Estructural: nº de páginas + tamaños de página (±1 pt) + **por página** SHA-256 del texto normalizado (NFKC, minúsculas,
   espacios colapsados, sin dígitos de fecha/folio) + MinHash de trigramas de palabras (128 permutaciones). Jaccard ≥ 0,90 en
   todas las páginas → «Coincide» (aplica sola, con aviso deshacible); 0,70-0,90 → «Parece la plantilla X (85 %)» con «Usar /
   No»; < 0,70 → sin plantilla.
3. Escaneados sin texto: dHash 64 bits de cada página a 32×32 px; distancia de Hamming ≤ 10.
4. Página distinta (p. ej. cambió la página 3): se aplica página a página; los campos de páginas sin coincidencia se marcan
   «Revisar» y no se aplican solos.
5. Fase posterior (si hace falta): anclas de texto («Signature of Policyholder») para recolocar campos si el texto se desplazó.

**Versionado y conflictos**: editar una plantilla crea `version+1` (se conserva la anterior para deshacer); dos plantillas con la
misma huella → se elige la más reciente y se avisa. Variante 1/2 firmantes: al elegir «1 firmante», se aplica la variante `1`
(o la `2` sin los campos del firmante 2, con aviso).

**«Configurar plantilla»**: abre Firmar en «modo plantilla» (mismo `DocumentCanvas`, sin ceremonia): colocar firmas/iniciales por
rol, aceptar campos detectados, asignar a cada campo de texto su **origen de dato** (lista corta: Nombre asegurado 1, Teléfono,
Email, Dirección, Aseguradora, Nº de póliza, Nº de reclamo, Tipo de reclamo, Fecha de pérdida, Fecha de hoy…; sugerido
automáticamente desde la etiqueta detectada con el diccionario de F3). Guardar = plantilla + copia del PDF base (D6).

**«Mis documentos» en Inicio** (`HomeView.tsx`, sección nueva sobre «Más usados»; página completa `/documents`):
lista con nombre, tipo, miniatura de la página 1, **✓ «Plantilla lista (1 y 2 firmantes)» / ✗ «Sin plantilla»**, acciones
«Firmar» (abre Firmar con el PDF y la plantilla aplicada), «Configurar plantilla», menú (renombrar, reemplazar PDF, borrar). Botón
«Nuevo cliente» → elegir kit → Firmar con todos sus documentos. Móvil/iPad: tarjetas de una columna, acciones de 44 px; vacía:
«Sube tus contratos una vez y configura dónde firma cada quien».

**Recientes unificado (U2.6)**: un solo índice derivado (sin almacén nuevo de PII): Recientes = unión de borradores (Firmar,
Editar, Pro) + entradas de historial sin estado; cada fila: miniatura, documento, herramienta, «Sin terminar»/«Terminado»,
fecha. «Continuar» restaura; «Abrir de nuevo» pide el archivo si no hay copia (o usa la de «Mis documentos» si la huella
coincide). Retención: 20 entradas de historial; borradores según sus topes (10 / 300 MB por herramienta) y caducidad de
firmas (U0.4); botón «Borrar» por fila y «Borrar todo»; aviso fijo «Solo en este navegador». **Regla para todas las
herramientas**: ninguna fila de Recientes ofrece «Continuar» sin un puntero `resume` verificable (prueba unitaria que recorre el
registro de herramientas).

Unidades:
- U2.1 `src/lib/docLibrary/{store.ts,fingerprint.ts,fingerprint.worker.ts}` (IndexedDB, huellas, MinHash, dHash). — `aos-builder`. Unitarias con PDFs reexportados (pdf-lib re-guardado, `qpdf`-like reordenado de objetos) y mutaciones ≥12.
- U2.2 `src/lib/docLibrary/templates.ts` (CRUD, versiones, variantes, migración de las plantillas `localStorage` actuales a
  plantillas «sin documento»). — `aos-builder`.
- U2.3 Modo plantilla en Firmar (`TemplateEditor.tsx` nuevo + integración mínima en `SignToolClient.tsx`). — `aos-builder`.
- U2.4 Aplicación automática al cargar (aviso deshacible, «Revisar» por página). — `aos-builder`.
- U2.5 «Mis documentos» (`src/components/views/MyDocumentsView.tsx`, `src/app/documents/page.tsx`, sección en `HomeView.tsx`). — `aos-builder` (skills `diseno-de-interfaz`, `frontend-ui-engineering`).
- U2.6 Recientes unificado. — `aos-builder`.
- U2.7 Textos ES/EN, estados vacíos, ayuda. — `aos-builder-lite`.
- Aceptación: E2E «configurar plantilla de 2 firmantes una vez → subir el mismo PDF re-exportado (bytes distintos) → campos
  aparecen solos → firmar»; «Mis documentos» muestra ✓/✗ correctos; abrir desde Inicio con plantilla aplicada; persistencia tras
  recarga; `navigator.storage.persist()` pedido al guardar el primer documento (resultado mostrado en Ajustes).
- **Puerta V2** y despliegue.

### Fase 3 — Datos del cliente y autollenado desde la póliza (≈ 26-36 h + fixtures)

**Arquitectura recomendada (100 % local, sin descargas de modelos): reglas + OCR**
1. Entrada: el usuario sube la póliza (dec page) en la pantalla **«Datos del cliente»** (paso nuevo antes de las firmas, o
   desde «Nuevo cliente»). La póliza NO se guarda.
2. Texto: pdf.js `getTextContent` con posiciones (agrupar en líneas por geometría, como `textBlocks.ts`); páginas sin texto
   (`pageTextKind.ts` decide) → OCR tesseract.js (`ocr.ts`, `eng`+`spa`), solo páginas 1-3 por defecto (iPad: ~5-15 s/página,
   con progreso y cancelar).
3. Extractor por reglas (`src/lib/policyExtract/`), en worker:
   - Pares etiqueta→valor por proximidad (misma línea a la derecha, o línea inferior alineada), tablas de 2 columnas.
   - Diccionario ES/EN configurable de etiquetas: *Named Insured, Insured, Policyholder, Asegurado, Tomador; Mailing Address,
     Property/Insured Location, Location of Risk, Dirección del riesgo; Policy Number/No., Número de póliza; Company, Carrier,
     Underwritten by, Aseguradora; Claim Number, Número de reclamo; Date of Loss, Fecha de la pérdida; Type/Cause of Loss,
     Peril, Tipo de reclamo; Effective/Expiration Date; Phone, Email; Mortgagee*.
   - Validadores: email (RFC simplificado), teléfono EE. UU. (`(xxx) xxx-xxxx`, `+1`), ZIP (5/9), estados (lista de 50 + DC),
     fechas (MM/DD/YYYY, ISO, «12 de marzo de 2026»), nº de póliza (alfanumérico 6-20 con guiones), segundo asegurado («&»,
     «and», «y» en *Named Insured*).
   - Lista de aseguradoras conocidas (editable) para reconocer el encabezado.
   - **Perfiles de aseguradora**: cuando el usuario corrige un valor, se guarda la regla «en pólizas de <aseguradora/huella de
     layout>, la etiqueta X → dato Y» (sin valores). Siguiente póliza del mismo layout → más precisión.
   - Cada valor lleva confianza y su origen (página + caja) para mostrarlo resaltado.
4. **Pantalla «Datos del cliente»** (editable): campos agrupados (Asegurados, Contacto, Propiedad, Póliza/Reclamo, Fechas), cada
   uno con badge «De la póliza (alta/media/baja confianza)» y «Ver en la póliza» (miniatura resaltada). Botón único «Confirmar
   datos». **Nada se escribe en los documentos hasta confirmar.** Campos de baja confianza quedan vacíos con sugerencia.
5. Relleno: cada campo de texto de la plantilla con `dataKey` toma el valor; el mismo cliente rellena TODOS los documentos del kit
   de una vez; «Fecha de hoy» automática; el usuario sigue pudiendo editar en el lienzo.
6. Cumplimiento: los datos del cliente viven en la sesión (y en su borrador, bajo la misma caducidad de 7 días, D3); no entran
   en `valueHistory` salvo opción explícita; «Terminar y borrar datos del cliente» al descargar.

**Alternativa (ii) modelo local** (WebLLM ya está en el proyecto): Llama-3.2-1B/Qwen2.5-1.5B exigen WebGPU, descargar ~0,9-1,1 GB
la primera vez, memoria GPU que un iPad puede no tener libre, varios segundos por página y riesgo de inventar datos. Solo como
«segunda opinión» opcional y posterior para campos de baja confianza, con regla anti-alucinación: un valor propuesto por el modelo
solo se acepta si aparece literalmente (normalizado) en el texto de la póliza. Recomendación: NO en este ciclo; decidir con
métricas de F3 (D4).

**Medir la precisión sin datos reales**: `src/lib/policyExtract/__fixtures__/` generado por script con pdf-lib: 6 layouts
(dos columnas etiqueta/valor, tabla, etiqueta encima, todo mayúsculas, bilingüe, con logo/encabezado), ES y EN, nombres y
direcciones **sintéticos** de una lista fija con semilla (p. ej. «Jordan Example», «123 Sample St, Tampa, FL 33601»), teléfonos
555-01xx, emails `@example.com`; variantes escaneadas (rasterizar con `@napi-rs/canvas`, ruido, rotación ±1,5°) para OCR;
verdad en JSON. Métricas por campo: exactitud tras normalizar, precisión/recuperación. Objetivo: ≥ 90 % exacto en PDF con texto
para nombre, dirección, nº de póliza, aseguradora, email, teléfono; ≥ 75 % en escaneados; 0 valores inventados (precisión de los
campos rellenados ≥ 98 %: mejor vacío que equivocado).

Unidades: U3.1 fixtures sintéticos + script (`aos-builder-lite`, patrón pdf-lib existente) · U3.2 extractor y diccionario
(`aos-builder`, TDD contra fixtures, mutaciones ≥15) · U3.3 OCR en la ruta (`aos-builder`) · U3.4 «Datos del cliente» + mapeo
`dataKey` + relleno multi-documento (`aos-builder`) · U3.5 perfiles de aseguradora (`aos-builder`) · U3.6 textos (`aos-builder-lite`).
**Puerta V3** (incluye informe de precisión reproducible con `vitest`). Despliegue.

### Fase 4 — Exportar/Importar plantillas + documentos (.zip) (≈ 10-14 h)

**Formato** `OptimusPDF - Plantillas - <fecha>.zip`:
```
manifest.json  { format: "optimuspdf.library", version: 1, exportedAt, appVersion,
                 documents: [{ id, name, docType, file: "documents/<id>.pdf", sha256, bytes, pageCount }],
                 templates: [{ id, documentId, file: "templates/<id>.json", sha256 }],
                 kits: [...], dataDictionary?: {...}, insurerProfiles?: [...] }
documents/<id>.pdf      (PDF base en blanco)
templates/<id>.json
```
Cifrado opcional (D5): mismo esquema que `signVaultFile.ts` (PBKDF2-SHA256 600 000 it. → AES-GCM-256), `envelope.json` +
`payload.bin`; iteraciones y algoritmos fijos (un archivo hostil no puede imponerlos). **Nunca** incluye datos de clientes,
firmas, borradores ni pólizas.

**Importación segura**: tope de archivo 250 MB; ≤ 200 entradas; leer tamaños descomprimidos del directorio central ANTES de
inflar (anti zip-bomb, relación ≤ 100:1); rutas por lista blanca (`^documents/[a-z0-9-]{1,40}\.pdf$`, `^templates/...json$`, sin
`..`, sin absolutas); JSON con validación estricta y longitudes máximas (nombres ≤ 80, etiquetas ≤ 120); SHA-256 de cada PDF
comprobado; PDF validado con la puerta de entrada existente (`inputGuard.ts`); nada se ejecuta ni se interpreta como HTML (React
escapa; prohibido `dangerouslySetInnerHTML`). **Previsualización**: lista de lo que trae con «Nuevo / Ya existe (misma huella) /
Versión distinta» y por fila «Reemplazar / Conservar ambos / Omitir»; «Importar» al final.

**iPad/Safari**: exportar con `navigator.share({files})` cuando exista (hoja Compartir → «Guardar en Archivos», AirDrop, Mail) o
descarga clásica; importar con `<input type=file accept=".zip,application/zip">` (Archivos de iOS). Recordatorio «Haz una copia»
cada 30 días o tras 5 cambios (mitiga la regla de 7 días de Safari).

Unidades: U4.1 `src/lib/docLibrary/libraryFile.ts` (export/import puros, cifrado) — `aos-builder` (skill `security-and-hardening`),
fuzzing con zips hostiles (ruta `../`, zip-bomb, JSON enorme, SHA incorrecto, PDF falso) · U4.2 UI exportar/importar/
previsualizar en «Mis documentos» — `aos-builder` · U4.3 textos — `aos-builder-lite`. **Puerta V4** (incluye revisión de
seguridad). Despliegue.

### Fase 5 — Solicitar firma por email (firma remota) — **APARCADA por decisión del usuario (D1, §9)**; en este ciclo solo la opción visual deshabilitada (U0.7). El análisis se conserva para cuando se retome.

| | (A) Enlace con backend mínimo y cifrado E2E | (B) Sin backend: «paquete de firma» | (C) Proveedor externo (DocuSign / Dropbox Sign) |
|---|---|---|---|
| Cómo | La app cifra (AES-GCM, clave aleatoria) el paquete (PDF + plantilla + datos ya confirmados) y sube SOLO el cifrado. Enlace `https://<app>/r/<id>#k=<clave>`: el fragmento `#` nunca llega al servidor. El firmante abre, descifra en su navegador, ve los documentos, da consentimiento ESIGN, firma; el resultado se cifra con la misma clave y se sube. El adjuster ve «Firmado» y descarga/descifra en su iPad. | Se genera un `.zip`/PDF con los documentos y la plantilla; el usuario lo envía con su propio correo (mailto / Compartir); el firmante entra en la app, importa, firma, descarga y responde con el PDF adjunto. | Se suben los PDF al proveedor por su API; él envía emails, recoge firmas y da auditoría. |
| Privacidad | El servidor solo ve bytes cifrados, tamaño, fechas, IP de acceso. | Total (nada pasa por nosotros), pero el PDF viaja en claro por email. | Los documentos (con PII de pólizas) salen a un tercero; rompe la promesa «100 % local». |
| Validez (EE. UU., ESIGN/UETA; **no es asesoría legal**) | Se pueden cubrir los 4 pilares: consentimiento a firmar electrónicamente (pantalla previa con divulgación y opción de copia en papel), intención (acto explícito «Firmar»), asociación firma-registro (hash del documento visto + registro de eventos), conservación y copia (el firmante descarga su copia). Registro de auditoría en servidor sin contenido. | Débil: sin registro de quién/cuándo abrió ni de consentimiento; depende del correo. | La más sólida y reconocida (auditoría certificada por el proveedor). |
| Coste | Supabase (Storage + 1 tabla + Edge Function) o Vercel (Functions + Blob): 0-25 USD/mes a este volumen; dominio actual. Email transaccional NO imprescindible en el MVP. | 0 | Dropbox Sign API ≈ 75 USD/mes (~50 solicitudes), 300 USD/mes para firma incrustada; o simplemente que el usuario use su cuenta (15-25 USD/mes) fuera de la app. |
| Esfuerzo | MVP 30-45 h | 8-12 h | 25-40 h (OAuth/claves en servidor de todos modos) |
| Riesgo | Cambio de arquitectura (`server-required-features.md`), CSP `connect-src`, operar un servicio (TTL, abuso, borrado). | Fricción alta para el cliente en móvil (descargar, importar, adjuntar): mucho error. | Dependencia comercial; datos fuera; secretos en servidor. |

**Recomendación: (A) por fases**, empezando DESPUÉS de F0-F3 y solo con aprobación explícita del dueño (cambia la regla de
arquitectura):
- **MVP A1**: sin email transaccional. El adjuster pulsa «Enviar para firmar» → hoja Compartir de iPad (Mail, Mensajes,
  WhatsApp) con el enlace (la clave va en el fragmento, así el proveedor de email del servidor nunca la ve, porque no hay). Opción
  de PIN de 6 dígitos que se dice por teléfono (se mezcla con la clave mediante HKDF: interceptar el email no basta). Caduca a los
  7 días, un solo uso para firmar, borrado del cifrado a las 72 h tras completarse, tope 25 MB. Estado por consulta periódica
  («Pendiente / Abierto / Firmado») en «Mis envíos». Pantalla de consentimiento ESIGN + registro de eventos (creado, abierto,
  consentimiento, firmado, descargado; IP truncada y user-agent) + hash SHA-256 del documento antes y después, entregado como
  `.json` aparte (coherente con D2).
- **A2**: aviso por email «X firmó» SIN contenido ni enlace con clave (Resend/Postmark), recordatorios, 2 firmantes remotos en
  orden, firma mixta (uno presente en el iPad, otro remoto).
- Lo que haría falta del usuario (no se pide ni se escribe ningún secreto en el repo): elegir proveedor (Supabase o Vercel), crear
  el proyecto en su cuenta, configurar variables de entorno en el panel (URL del proyecto y clave pública; la clave de servicio
  SOLO en la función del servidor), aprobar el cambio de CSP, y revisar con su abogado la divulgación ESIGN y los requisitos
  estatales de contratos de *public adjuster* (varios estados regulan contenido y plazo de cancelación del contrato).
- En este ciclo puede entrar: el diseño, el cifrado/descifrado y el formato del paquete como módulos puros probados (sirven
  también a B), y la pantalla de consentimiento. El servidor espera a D1.

Unidades (si D1 = A): U5.1 `src/lib/remote/{envelope.ts,crypto.ts}` puros (cifrado, HKDF con PIN, formato) — `aos-builder` ·
U5.2 servicio mínimo (Edge Function o Route Handler de Next 16 leyendo sus docs; esquema, TTL, límites, rate limit) —
`aos-builder` · U5.3 vista del firmante `/r/[id]` (consentimiento, firma, envío) — `aos-builder` · U5.4 «Mis envíos» — `aos-builder` ·
U5.5 textos legales ES/EN (borrador para revisión del abogado) — `aos-builder-lite` · **Puerta V5 con auditoría de seguridad**
(`security-auditor` con `model: "sonnet"`).

---

## 4. Seguridad, errores, accesibilidad, i18n

**Modelo de amenazas (breve)**

| Activo / entrada | Amenaza | Mitigación |
|---|---|---|
| Borradores con firmas y datos de clientes en IndexedDB | Otra persona usa el iPad; robo del dispositivo | Interruptor y caducidad 7 días (D3); «Borrar datos» ya existente amplía alcance; aviso claro; sin PII en la URL (`?s=` opaco). |
| PDF base en «Mis documentos» | Que se guarde un contrato YA relleno con datos | Aviso al guardar si el PDF tiene valores de formulario o mucho texto de usuario; recomendar PDF en blanco. |
| ZIP importado | Zip-bomb, rutas `../`, JSON gigante, PDF malicioso, XSS en nombres/etiquetas | §F4: límites previos, lista blanca de rutas, validación estricta, SHA-256, `inputGuard`, React sin HTML crudo, nombres saneados (`safeFilenamePart`). |
| `?resume=`/`?s=` | Parámetros manipulados | Lista blanca de tipos, regex de id, error amable. |
| Póliza | Que se filtre o se guarde | Nunca se guarda; texto extraído solo en memoria/sesión; OCR descarga solo el motor (no sube nada). |
| Enlace remoto (F5) | Interceptación del email, servidor curioso, reutilización | Clave en fragmento, PIN opcional, un solo uso, caducidad, cifrado AES-GCM, borrado programado. |
| Memoria (iPad) | 10 documentos + OCR + miniaturas | Worker por tarea, OCR por página con liberación, miniaturas a 200 px, topes existentes (200 MB). |

**Estrategia anti-errores**: revisión final obligatoria (miniaturas por página con cada elemento), validación «todos los
obligatorios completos» por documento, deshacer en tabla de asignación y al quitar documentos, restaurar siempre ofrecido,
autollenado nunca sin confirmar, plantillas aproximadas nunca se aplican sin preguntar.

**Accesibilidad y táctil**: objetivos ≥ 44 px (resolver los 36 px heredados de «Ver borradores»/«Importar configuración»),
regiones vivas para cambios de turno/autollenado, foco gestionado en hojas, sin depender de hover/teclado; el gesto «Atrás» de
iPad cubierto por U0.3. Proyecto `webkit-ipad` en Playwright (`devices["iPad Pro 11"]`) para todas las E2E nuevas; `a11y-sweep`
ampliado a las vistas nuevas. Ver `docs/COMPATIBILIDAD-NAVEGADORES.md` §2 para correr WebKit.

**i18n**: todo texto nuevo en `strings.ts` (Firmar) o `src/lib/locales/{es,en}.ts`; las pruebas existentes de cadenas
(`embeddedStrings.test.ts`, etc.) se amplían para exigir paridad ES/EN.

**Persistencia en Safari**: pedir `navigator.storage.persist()` al guardar el primer documento/plantilla y mostrar el estado en
Ajustes; recomendar «Añadir a pantalla de inicio» (el manifiesto ya es `standalone`, `src/app/manifest.ts`), y la copia `.zip`
(F4). No se promete persistencia que el navegador no garantiza.

---

## 5. Organización y orden de entrega

Política de modelos del usuario: constructores `aos-builder` (Sonnet 5.5) y `aos-builder-lite` (Haiku 5.5, SOLO textos,
documentación, fixtures sintéticos y tareas mecánicas con patrón existente); verificación independiente con agente distinto en
contexto limpio **en Sonnet** (`aos-verifier-senior` o `security-auditor` pasando `model: "sonnet"`); Opus solo orquesta. Pruebas
de navegador siempre headless.

**Archivo caliente**: `SignToolClient.tsx` (3038 líneas). Regla: en cada fase, SOLO una unidad de integración lo toca; las demás
construyen módulos/componentes nuevos con su propia prueba.

| Fase | Paralelo posible (sin archivos compartidos) | Secuencial | Puerta |
|---|---|---|---|
| F0 | U0.1 primero (sola). Después en paralelo: U0.2 (ceremonias, `blockModel`, `signSession`) ‖ U0.5 (flags, `sign.ts`, `signBatch`) ‖ U0.6 (Recientes, edit/pro). | U0.3 → U0.4 (ambas tocan `SignToolClient.tsx`/`signDrafts.ts`; U0.3 integra también el montaje de U0.2). | V0 |
| F1 | U1.1 ‖ U1.4 | U1.2 → U1.3 | V1 |
| F2 | U2.1 ‖ U2.2 ‖ U2.5 (vista con datos de prueba) ‖ U2.7 | U2.3 → U2.4 → U2.6 | V2 |
| F3 | U3.1 ‖ U3.6, luego U3.2 ‖ U3.3 | U3.4 → U3.5 | V3 |
| F4 | U4.1 ‖ U4.3 | U4.2 | V4 (con seguridad) |
| F5 | (tras D1) U5.1 ‖ U5.5 | U5.2 → U5.3 → U5.4 | V5 (con seguridad) |

F1 y F2 pueden solaparse parcialmente (U2.1/U2.2 no tocan Firmar). Orden de valor para el usuario: **F0 (1-2 días) → F2 (la
mayor reducción de tiempo: plantillas que aparecen solas) junto con F1 → F3 → F4 → F5.** Si el usuario prefiere, F4 puede ir
antes de F3 (es corta y protege sus plantillas de la regla de 7 días de Safari).

---

## 6. Estimaciones y riesgos

| Fase | Horas de agente (construcción + pruebas + 1 ronda de correcciones) | Riesgos principales |
|---|---|---|
| F0 | 14-18 | Integrar `pushState` con el router de Next 16 sin romper otras rutas; `beforeunload` en bfcache; remontajes ocultos de la ceremonia; migración de flags. |
| F1 | 14-18 | Ida y vuelta matriz↔bloques con borradores antiguos; claridad de la tabla en pantallas estrechas. |
| F2 | 26-34 | Umbrales de huella (falsos positivos entre contratos casi iguales); cuota y regla de 7 días en Safari; tamaño de `SignToolClient.tsx`. |
| F3 | 26-36 | Variedad real de pólizas (los fixtures sintéticos no son la realidad: recoger 3-5 layouts reales ANONIMIZADOS por el usuario si quiere); OCR lento en iPad; nombres compuestos/dos asegurados. |
| F4 | 10-14 | Compatibilidad del `.zip` y de `navigator.share` con archivos en iPadOS; zip-bomb. |
| F5 (A) | 30-45 + infraestructura | Cambio de arquitectura, operación del servicio, revisión legal, abuso del endpoint. |
| **Total F0-F4** | **≈ 90-120 h** | |

---

## 7. Decisiones para el usuario (con recomendación por defecto) — RESUELTAS el 2026-10-14, ver §9.1

1. **Firma remota por email** — (A) enlace con backend mínimo cifrado de extremo a extremo · (B) paquete sin backend · (C)
   DocuSign/Dropbox Sign. **Recomendado: A, después de F0-F3, empezando sin email transaccional (compartes el enlace con tu Mail/
   WhatsApp).** Si no decides: F5 no empieza; todo lo demás sigue.
2. **Hoja «Certificado SHA-256»** — (a) eliminarla por completo · (b) desactivada por defecto, opcional en Ajustes, renombrada
   «Registro de firmas (no es una firma certificada)», con registro `.json` aparte opcional. **Recomendado: (b).** Si no decides:
   se aplica (b).
3. **¿Guardar en el borrador las firmas ya recogidas?** — (a) siempre (como hoy) · (b) sí, con interruptor visible activado por
   defecto, solo en este dispositivo, caducan a los 7 días y se ofrece borrarlas al descargar · (c) nunca (al retomar se firma de
   nuevo). **Recomendado: (b).** Si no decides: (b).
4. **Alcance del autollenado** — (a) reglas + OCR local (sin descargas grandes) · (b) además modelo de IA local opcional (~1 GB,
   WebGPU). **Recomendado: (a) ahora; (b) solo si las métricas de F3 no llegan al objetivo.** Si no decides: (a).
5. **Contenido del `.zip` de plantillas** — (a) plantillas + PDF base, contraseña opcional (casilla marcada por defecto) · (b)
   siempre cifrado · (c) solo plantillas, sin PDF. **Recomendado: (a).** Si no decides: (a).
6. **¿«Mis documentos» guarda copia del PDF base en el navegador?** — (a) sí (IndexedDB, solo contratos en blanco, con aviso y
   copia de seguridad recomendada) · (b) no, solo la huella: hay que subir el PDF cada vez y la plantilla se aplica sola. **Recomendado:
   (a)** (es lo que permite «Firmar» con un toque desde Inicio). Si no decides: (a).

Supuesto por defecto (no requiere decisión salvo que el usuario diga otra cosa): «copias» = archivos idénticos duplicados en el
ZIP; si cada copia debe firmarse por separado, se cargan como documentos distintos.

---

## 8. Fuentes externas consultadas

- [Dropbox Sign API pricing plans (Dropbox Help)](https://help.dropbox.com/plans/how-much-does-the-dropbox-sign-api-cost) y
  [resumen de precios de terceros](https://signeasy.com/blog/business/dropbox-sign-pricing) — cifras a confirmar antes de presupuestar.
- [WebKit: Updates to Storage Policy](https://webkit.org/?p=14403) y
  [Apple Developer Forums: Safari iOS PWA data persistence beyond 7 days](https://developer.apple.com/forums/thread/710157) — regla de 7 días e inconsistencias de `persist()`.
- Next.js 16 local: `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md` (Native History API) y
  `01-app/03-api-reference/02-components/link.md` (`onNavigate`).
- ESIGN Act (15 U.S.C. §7001 y ss.) y UETA: resumidos de conocimiento general; **no es asesoría legal**, validar con abogado.

---

## 9. Decisiones del usuario y ampliaciones (revisión 2, 2026-10-14) — PREVALECE sobre §3-§7

### 9.1 Decisiones tomadas

| # | Decisión del usuario | Efecto en el plan |
|---|---|---|
| D1 | Firma por email: más adelante. Ahora SOLO una opción visual «E-sign» deshabilitada con insignia «Próximamente / Soon». | F5 aparcada. Nueva **U0.7** (sin lógica). |
| D2 | Certificado: desactivado por defecto, renombrado «Registro de firmas (no es una firma certificada)», `.json` opcional, metadatos. | U0.5 tal cual. |
| D3 | Firmas en el borrador: sí (interruptor visible, 7 días, ofrecer borrar al descargar). Además `.zip` de firmas y un `.zip` global de TODO para respaldar e importar en cualquier navegador, seguir agregando y volver a respaldar. | U0.4 tal cual. F4 se amplía a **paquetes modulares + «OptimusPDF Package»** (U4.4-U4.8). |
| D4 | Autollenado: reglas + OCR local primero; si no alcanza, **integraciones de IA** con el modelo más barato/gratis, flag apagado por defecto. | F3 tal cual + nueva **F8 IA opcional** condicionada a las métricas de F3. |
| D5/D6 | ZIP y «Mis documentos»: sí a todo, en paquetes **modulares** (Firmas/Iniciales; Plantillas+Documentos; Sistema/Configuración) y un **Package** completo, con contraseña opcional, SHA-256, versionado, importación segura y UI en Ajustes y «Mis documentos». | F4 redefinida (§9.3). «Mis documentos» guarda copia del PDF base (F2). |
| N1 | Nueva herramienta **Extractor** (Editar y analizar): firmas, iniciales, imágenes, logos, sellos, marcas de agua; galería; descarga individual/ZIP; guardar firmas/iniciales en el baúl con nombre. | Nueva **F7** (§9.5). |
| N2 | Baúl: **subir** firmas/iniciales como imagen (PNG/JPG/WEBP/SVG), recortar, limpiar fondo, color de tinta, nombre, guardar; incluidas en el `.zip` de firmas y en el Package. | Nueva **F6** (§9.4), base compartida con el Extractor. |

### 9.2 U0.7 — Opción «E-sign» deshabilitada (Fase 0) — `aos-builder-lite` (patrón existente: `Badge variant="soon"`, `ToolShell.tsx:982-984`)

- Dónde: (1) pantalla de resultado de Firmar (`renderDone`, junto a la descarga, `SignToolClient.tsx:1392-1405`) y (2) cabecera de
  modo de Firmar (junto a «Solo yo / Varios firmantes»). Componente nuevo `src/app/sign-pdf/ESignTeaser.tsx`; en
  `SignToolClient.tsx` solo dos líneas de montaje (se integran DESPUÉS de U0.3/U0.4 para no chocar en el archivo caliente).
- Aspecto: botón con estilo deshabilitado del sistema, icono de sobre, texto «E-sign · Enviar para firmar por email» + insignia
  «Próximamente» (EN: «E-sign · Send for signature by email» + «Soon»). `aria-disabled="true"`, sigue siendo enfocable y anuncia
  «Disponible próximamente»; tocarlo NO hace nada (sin red, sin lógica, sin estado).
- Aceptación: visible en ES/EN, contraste del estado deshabilitado ≥ 3:1 con su insignia legible (≥ 4,5:1), objetivo 44 px,
  `a11y-sweep` sin infracciones, prueba que verifica que el clic no navega ni llama a nada. ≈ 1-2 h.

**Estado U0.7 (construida y verificada por el constructor; pendiente de la puerta V0):** `ESignTeaser.tsx` (sin lógica) montado en
la cabecera de Firmar (bajo «¿Quién firma?») y dentro de la tarjeta de resultado, bajo «Descargar» y la casilla de U0.4. Texto
«E-sign · Pedir firma por email» + insignia «Próximamente» / «Soon» (cadenas `strings.esign`); `aria-disabled="true"` con la
descripción «Disponible próximamente», enfocable, ≥ 44 px, borde discontinuo y sin atenuar el texto con opacidad.

### 9.3 F4 redefinida — Paquetes modulares y «OptimusPDF Package» (≈ 20-28 h)

**Un solo formato contenedor para todo**; un paquete «de módulo» es el mismo formato con un único módulo. Así hay UN importador,
UNA validación y UNA migración de esquemas.

```
<nombre>.optimuspdf.zip            (extensión .zip para que iPadOS/Windows lo abran sin fricción)
├─ manifest.json
├─ signatures/
│   ├─ index.json                  [{ id, signerName, role?, origin, createdAt, lastUsedAt,
│   │                                 signature?: "signatures/<id>-signature.png", initials?: "...-initials.png" }]
│   └─ <id>-signature.png, <id>-initials.png
├─ templates/
│   ├─ <id>.json                   (DocTemplate, §3 F2)
│   ├─ kits.json
│   └─ insurer-profiles.json       (perfiles de aseguradora de F3: reglas etiqueta→dato, SIN valores)
├─ documents/
│   ├─ index.json                  [{ id, name, docType, fileName, pageCount, fingerprint }]
│   └─ <id>.pdf                    (PDF base en blanco)
└─ settings/
    ├─ settings.json               (lista blanca: tema, idioma, flags de Firmar/Editar/Pro, diseño de Pro, aviso visto)
    └─ value-history.json          (OPCIONAL, desmarcado por defecto: contiene PII)
```

`manifest.json`:
```
{ "format": "optimuspdf.package", "formatVersion": 1, "createdAt": "...", "app": { "version": "...", "build": "<sha>" },
  "modules": { "signatures": { "schemaVersion": 1, "count": 3 },
               "library":    { "schemaVersion": 1, "documents": 4, "templates": 6, "kits": 1 },
               "settings":   { "schemaVersion": 1, "includesValueHistory": false } },
  "files": [ { "path": "signatures/abc-signature.png", "sha256": "...", "bytes": 12345, "type": "image/png" }, ... ] }
```

- **Cifrado opcional** (casilla marcada por defecto si el paquete incluye firmas o historial de valores): el zip completo se cifra
  y se envuelve en `envelope.json` + `payload.bin` con el esquema del baúl (PBKDF2-SHA256 600 000 it. → AES-GCM-256,
  parámetros fijos). Se EXTRAE el cifrado de `signVaultFile.ts` a `src/lib/crypto/passwordBox.ts` (U4.4) sin cambiar el formato
  del archivo de una firma existente (sigue importándose).
- **Integridad**: SHA-256 de cada archivo en `files[]`; un archivo que no coincide invalida SOLO su elemento (se informa).
- **Evolución de esquemas**: `formatVersion` (contenedor) y `schemaVersion` por módulo. El lector acepta versiones ≤ la actual y
  migra con funciones puras encadenadas (`migrations/signatures/v1→v2.ts`…), probadas con paquetes «dorados» guardados en
  `__fixtures__/packages/` de cada versión publicada (prueba de no regresión: todo paquete dorado debe seguir importándose).
  Versión MAYOR que la soportada ⇒ ese módulo se rechaza con «Creado con una versión más nueva de OptimusPDF; actualiza la
  página», los demás se importan. Campos desconocidos se ignoran; archivos fuera de las carpetas conocidas se ignoran con aviso.
- **Qué NUNCA entra**: borradores de sesión, datos de clientes, pólizas, Recientes, claves de API de IA (F8), cachés de PDF Pro.
  (Si algún día se quieren borradores en el respaldo: módulo aparte, solo cifrado; pregunta §9.10.)
- **Importación segura**: los límites de §3 F4 (≤ 250 MB, ≤ 2 000 entradas, tamaños descomprimidos leídos del directorio central
  antes de inflar, relación ≤ 100:1, rutas en lista blanca por regex, JSON estricto con longitudes máximas, PNG validado con
  `isValidVaultImage`/`pngIhdrCrcValid` de `signVault.ts`, PDF con `inputGuard.ts`, `settings.json` SOLO claves de la lista
  blanca `src/lib/backup/settingsRegistry.ts` con su validador — nunca se escribe una clave arbitraria en `localStorage`).
- **Vista previa y fusión**: hoja «Importar paquete» que lista por módulo lo que trae: «Nuevo», «Ya lo tienes (idéntico)»,
  «Distinto» → por elemento «Reemplazar / Conservar ambos / Omitir»; ajustes «Reemplazar / Omitir». Firmas: duplicado = mismo
  `signerKey` + mismo hash de imagen. Límites del baúl (30 firmas, 20 MB) comprobados ANTES de importar, con aviso de cuántas caben.
- **Seguir agregando y volver a respaldar**: importar fusiona en los almacenes locales; «Exportar mi paquete» siempre exporta el
  estado completo actual. Ajustes muestra «Último respaldo: hace N días» y recuerda respaldar tras 30 días o 10 cambios (mitiga
  la regla de 7 días de Safari).
- **UI**: Ajustes → sección «Respaldo y traslado»: «Exportar mi paquete» (casillas por módulo + contraseña) / «Importar paquete».
  «Mis documentos»: «Exportar plantillas y documentos» / «Importar». Baúl (`SignatureVaultSheet`): «Exportar todas mis firmas» /
  «Importar firmas». iPad: `navigator.share({files})` si existe, si no descarga; importar con `<input type=file>`.

Unidades (U4.1-U4.3 se conservan con su número; su alcance se ajusta):
- **U4.1** (ajustada) núcleo del contenedor `src/lib/backup/package.ts` (escribir/leer, manifiesto, SHA-256, límites, migraciones)
  — `aos-builder` (skill `security-and-hardening`), fuzzing con zips hostiles, mutaciones ≥ 15.
- **U4.2** UI exportar/importar/previsualizar en «Mis documentos» — `aos-builder`.
- **U4.3** textos — `aos-builder-lite`.
- **U4.4** (nueva) `src/lib/crypto/passwordBox.ts` extraído de `signVaultFile.ts` + módulo Firmas (`src/lib/backup/modules/signatures.ts`)
  + «Exportar todas / Importar firmas» en `SignatureVaultSheet.tsx` — `aos-builder`. Puede entregarse ANTES que el resto de F4 (con F6).
- **U4.5** (nueva) módulo Plantillas+Documentos (`modules/library.ts`, depende de F2 U2.1/U2.2) — `aos-builder`.
- **U4.6** (nueva) módulo Sistema/Configuración (`modules/settings.ts` + `settingsRegistry.ts`) — `aos-builder`.
- **U4.7** (nueva) «OptimusPDF Package» + sección «Respaldo y traslado» en `SettingsView.tsx` + recordatorio — `aos-builder`.
- **U4.8** (nueva) paquetes dorados v1 y prueba de no regresión de formatos — `aos-builder-lite` (mecánico con patrón).
- Aceptación: E2E «exportar Package con contraseña en Chromium → importar en `webkit-ipad` → firmas, plantillas, documentos y
  ajustes presentes → añadir una firma → reexportar → importar sobre el primero: fusiona sin duplicar»; cada zip hostil del
  corpus se rechaza sin colgar la pestaña (< 2 s) ni escribir nada; paquete de un solo módulo importa por la misma vía.
- **Puerta V4** (con revisión de seguridad, `security-auditor` en Sonnet).

### 9.4 F6 (nueva) — Subir firmas/iniciales por imagen al baúl (N2) (≈ 10-14 h)

Hallazgo: el compositor YA admite subir PNG/JPG (`SignatureComposer.tsx:62, 846-872, 1154-1171`), pero solo recorta por alfa
(`trimTransparent`, `:432-470`): una foto o un JPG con fondo blanco entra con su fondo. Ese motor de «tinta» es justo lo que
necesitan el baúl y el recorte manual del Extractor: se construye UNA vez.

- **U6.1 `src/lib/image/inkExtract.ts`** (puro, `OffscreenCanvas`/`ImageData`, en worker si > 4 MP) — `aos-builder`:
  umbral automático (Otsu sobre luminancia) + deslizador; alfa suave (antialias) en función de la luminancia; corrección de
  iluminación desigual para fotos (fondo estimado con desenfoque grande y división); quitar motas (componentes < N px);
  recolorear tinta (original / negro / azul); recorte automático con margen; reducción a ≤ 4096 px y PNG ≤ 600 KB (topes de
  `signVault.ts:103-111`). Entradas: PNG, JPG, WEBP, SVG (rasterizado vía `<img>` desde blob: el SVG en `<img>` no ejecuta
  scripts; tamaño máximo de entrada 10 MB) y HEIC donde el navegador lo decodifique (Safari). Pruebas con imágenes sintéticas
  (trazo negro/azul sobre blanco, sobre papel con sombra, JPG con artefactos): ≥ 98 % de píxeles de fondo transparentes y ≥ 95 %
  de tinta conservada; mutaciones ≥ 10.
- **U6.2 `src/app/sign-pdf/SignatureImportSheet.tsx`** — `aos-builder` (skills `apple-design`, `frontend-ui-engineering`):
  elegir imagen o foto (cámara en iPad vía `capture`), recorte con asas (táctil, 44 px), deslizador «Limpiar fondo», color de
  tinta, vista previa sobre damero y sobre una línea de firma, tipo (Firma / Iniciales / ambas desde dos imágenes), nombre del
  firmante y cargo → `saveVaultEntry` con nuevo campo opcional `origin: "drawn" | "typed" | "uploaded" | "extracted"` (opcional,
  sin subir `schema`; el validador `isStoredEntry`, `signVault.ts:399`, debe aceptarlo ausente o con un valor de la lista). Entrada desde «Firmas guardadas» («Subir firma o iniciales») y
  desde el modo «Subir» del compositor (que pasa a usar `inkExtract`).
- **U6.3** textos ES/EN y ayuda («Toma una foto de la firma sobre papel blanco, con buena luz») — `aos-builder-lite`.
- Aceptación: E2E (Chromium + `webkit-ipad`) subir JPG con fondo blanco → guardada con fondo transparente → usarla en Firmar
  (Solo yo y ceremonia) → aparece en el PDF sin recuadro blanco; incluida en «Exportar todas mis firmas» (U4.4).
- **Puerta V6.**

### 9.5 F7 (nueva) — Herramienta «Extractor» (N1) (≈ 32-42 h)

**Identidad**: slug `extract-assets`, nombre «Extraer elementos» / «Extract elements», categoría `edit` («Editar y analizar»),
icono `ImageDown` (lucide). Se integra como las demás: `TOOL_SLUGS` y entrada en `src/lib/tools-registry.ts` (`accept: PDF`,
`multiple: false`), textos en `src/lib/locales/{es,en}.ts` (`tools["extract-assets"]` y nombre de archivo de salida),
`src/app/extract-assets/page.tsx` con `metadata` (title, description, `alternates.canonical`), cliente propio sobre `ToolShell`
(como `compare-pdf`), búsqueda/catálogo/«Abrir en PDF Pro» por el registro. No se confunde con «Extraer páginas» (`extract-pages`).

**Qué se puede extraer y con qué fiabilidad** (motor: pdf.js 6.1.200 en worker, ya en el proyecto; pdf-lib para bytes crudos):

| Elemento | Cómo | Fiabilidad de DETECCIÓN | Calidad de salida |
|---|---|---|---|
| Imágenes incrustadas (XObject Image, inline, DCT/Flate/JPX/JBIG2) | Recorrer `getOperatorList()` siguiendo la matriz `cm`/`save`/`restore` (misma técnica que `imageCoverage`, `pageTextKind.ts:94-121`) para `paintImageXObject`, `paintInlineImageXObject`, `paintImageMaskXObject`, dentro de Form XObjects; píxeles decodificados vía `page.objs`; JPEG sin máscara: además se ofrece el `.jpg` ORIGINAL sin recompresión leyendo el stream con pdf-lib. | **Alta** (es estructura del PDF) | Alta. Transparencia: pdf.js compone la SMask/Mask en RGBA → PNG con alfa. **Hallazgo**: `core.ts:807` no configura `wasmUrl`; sin `openjpeg.wasm`/`jbig2.wasm` (presentes en `node_modules/pdfjs-dist/wasm/`) las imágenes JPX/JBIG2 (típicas de escaneos) pueden no decodificar o ir por el respaldo lento. U7.0 los sirve y configura (mejora también el visor en todas las herramientas). |
| Deduplicación y ocurrencias | Hash de los píxeles reducidos + referencia de objeto; cada elemento lista páginas y cajas donde aparece. | Alta | — |
| Firmas/iniciales insertadas COMO IMAGEN (OptimusPDF, DocuSign, escaneo de firma) | Heurística sobre imágenes: transparencia o fondo casi blanco con tinta oscura/azul, relación de aspecto 1,5-8 (firma) o 0,6-2,5 y pequeña (iniciales), altura 1-8 % de la página, cerca (≤ 2 líneas) de texto «firma/signature/sign here/initials/iniciales/X___» (texto con posiciones de pdf.js), no repetida en cabecera/pie. | **Media-alta** (≈ 0,85 precisión objetivo) | Alta |
| Anotaciones Ink (dibujo a mano con lápiz/Apple Pencil en visores) | `page.getAnnotations()` → `inkLists` → SVG de trazos y PNG. | **Alta** | Alta (vectorial) |
| Campos de firma `/Sig` (firma digital con apariencia) | Anotación Widget `fieldType: "Sig"`: se renderiza SOLO su caja con anotaciones activas y se limpia el fondo con `inkExtract`. Se informa «firmado digitalmente» si trae `/V`; la validez criptográfica NO se verifica (fuera de alcance). | Alta (que existe) / Media (que su apariencia sea la firma: a veces es texto o está vacía) | Media |
| Sellos (anotaciones Stamp, Form XObjects tipo sello) | Stamp: render de su caja con y sin anotaciones → diferencia ⇒ píxeles del sello. Form XObject: grupo con bbox pequeña/mediana, color saturado (rojo/azul), forma circular/rectangular, o imagen con esas características. | Media (Stamp: alta) | Media |
| Logos | Imagen (o Form XObject) repetida en ≥ 2 páginas en franja superior/inferior (20 %) o en la página 1 arriba, área < 10 %. | **Alta** como «imagen repetida de cabecera/pie»; Media como «logo» | Alta |
| Marcas de agua | (a) contenido opcional (`getOptionalContentConfig`) con nombre tipo «Watermark/Marca de agua»: render solo de ese grupo; (b) anotación `/Subtype /Watermark` (leída con pdf-lib); (c) texto girado o grande y translúcido (`setGState ca < 1`) repetido en ≥ 50 % de páginas → se entrega como texto + SVG/PNG; (d) imagen grande translúcida repetida. | Media (a,b alta cuando existen; c,d heurística) | Media |
| Firmas DIBUJADAS COMO VECTORES en el contenido (`constructPath` con `DrawOPS` moveTo/lineTo/curveTo de pdf.js 6) | Agrupar trazos por cercanía; rasgos: muchas curvas cortas, trazo oscuro, sin texto dentro, bbox de proporción de firma, cerca de «Signature». Salida: SVG reconstruido de las rutas o render 4× de la región con fondo limpio. Riesgo: confundir con dibujos, gráficos, la propia línea de firma. | **Baja-media** (se marca «beta») | Media-alta |
| Firmas dentro de una página ESCANEADA (todo es una imagen) | No se separa automáticamente en esta versión: se detecta «página escaneada» y se ofrece **recortar región**. | Baja (automática) | Depende del escaneo |
| **Recortar región manual** (todo lo que no se detecta) | El usuario dibuja un rectángulo en la página; render a 300-600 ppp de esa zona y `inkExtract` (umbral, tinta, recorte) → PNG transparente. | — (manual) | Alta en documentos nítidos |

**Modelo de resultados** (`src/lib/pdf/extractAssets/types.ts`):
```
ExtractedAsset { id, kind: "image"|"signature"|"initials"|"logo"|"stamp"|"watermark"|"drawing"|"photo",
  confidence: 0..1, reasons: string[],                // «transparente», «cerca de “Signature”», «repetida en 5 páginas»
  source: "xobject"|"inline"|"mask"|"form"|"ink-annot"|"stamp-annot"|"sig-widget"|"ocg"|"text"|"vector"|"region",
  occurrences: [{ pageIndex, rect /*0..1*/ }], pixel: { width, height, hasAlpha } | null,
  formats: ("png"|"jpg-original"|"jpg"|"svg"|"txt")[], bytesEstimate, thumb: Blob /*256 px*/ }
```
Los píxeles completos NO se guardan en el resultado: se regeneran bajo demanda al descargar (memoria acotada).

**UI**: galería en cuadrícula (1 columna en iPhone, 2-3 en iPad, 4-5 en escritorio) con miniatura sobre damero, chip de tipo
(con confianza «probable»), página(s), tamaño en px y KB; filtros por tipo; selección múltiple con casillas de 44 px; «Descargar»
(individual en el formato elegido) / «Descargar seleccionados (.zip)» (nombres `p03-firma-01.png`); en firmas e iniciales
«Guardar en Firmas guardadas» → hoja con nombre, cargo, tipo y **aviso de uso responsable** («Guarda solo tus firmas o las que
tengas autorización para usar. Reutilizar la firma de otra persona sin permiso puede ser ilegal.») con casilla obligatoria
«Tengo autorización»; se guarda con `origin: "extracted"` y el nombre del documento de origen. Pestaña «Recortar región» en el
visor de página. Todo local; ninguna llamada de red (prueba que lo comprueba).

**Límites y rendimiento**: página a página en worker con `page.cleanup()`; tope 300 páginas (avisa y deja elegir rango), 500
elementos, imagen decodificada ≤ 50 MP (más grande ⇒ se ofrece el original sin procesar o se omite con aviso), miniaturas 256 px;
objetivo: PDF de 20 páginas con 30 imágenes en < 4 s en iPad (WebKit) y < 2 s en escritorio; memoria pico < 400 MB (medida con
el patrón de `pdf-pro-memory.spec.ts`). Cancelable.

**Accesibilidad**: galería como lista con nombres «Firma probable, página 3, 420 × 140 px»; selección con teclado y espacio;
región viva con el recuento; recorte de región también con teclado (flechas mueven/redimensionan).

**Pruebas y métricas**: corpus sintético `src/lib/pdf/extractAssets/__fixtures__/` generado con pdf-lib (PNG con alfa, JPEG de
logo en cabecera repetido, imagen inline, máscara 1 bit, Form XObject de sello, anotación Ink, anotación Stamp, widget `/Sig` con
apariencia, OCG «Watermark», texto diagonal repetido con `ca=0.2`, firma vectorial con curvas junto a «Signature:», página
escaneada, y PDFs firmados por el propio `signPdfMulti`) + verdad en JSON. Métricas: imágenes incrustadas recall 100 % y
duplicados agrupados 100 %; firmas como imagen precisión ≥ 0,85 / recall ≥ 0,80; Ink y Stamp ≥ 0,95; logos ≥ 0,90; marcas de agua
(a,b) ≥ 0,90 y (c,d) ≥ 0,75; firmas vectoriales recall ≥ 0,60 (beta). Más 5-10 PDF reales anonimizados si el usuario los aporta
(§9.10). Informe de métricas reproducible con `vitest`.

Unidades:
- **U7.0** `wasmUrl` de pdf.js: copiar `openjpeg.wasm`, `jbig2.wasm`, `qcms_bg.wasm` a `public/pdfjs-wasm/` en el build (como el
  worker y `standard_fonts`) y pasarlo en `core.ts:807`; prueba de render de un PDF JPX/JBIG2 — `aos-builder`. (Afecta a todas
  las herramientas: regresión completa.)
- **U7.1** motor de imágenes incrustadas + dedup + ocurrencias (`extractAssets/images.ts`) — `aos-builder`.
- **U7.2** anotaciones (Ink, Stamp, `/Sig`, Watermark) y OCG (`extractAssets/annotations.ts`) — `aos-builder`.
- **U7.3** clasificador heurístico (`extractAssets/classify.ts`) + texto cercano + marcas de agua de texto + vectores beta — `aos-builder`, mutaciones ≥ 15.
- **U7.4** herramienta: registro, ruta, metadata, cliente, galería, descargas, ZIP, recortar región (usa `inkExtract` de F6),
  «Guardar en Firmas guardadas» — `aos-builder` (skills `diseno-de-interfaz`, `frontend-ui-engineering`).
- **U7.5** corpus sintético + verdad + script de métricas — `aos-builder-lite` (patrón pdf-lib existente; la verdad la revisa `aos-builder`).
- **U7.6** textos ES/EN, SEO, ayuda — `aos-builder-lite`.
- **Puerta V7** (incluye `a11y-sweep`, `tool-errors`, WebKit iPad y memoria).

### 9.6 F8 (nueva) — Asistente de IA opcional (solo si F3 no alcanza la precisión) (≈ 4-6 h de prueba técnica + 16-24 h)

**Condición de arranque**: el informe de F3 muestra < 90 % en campos clave (texto) o < 75 % (escaneados) sobre el corpus
sintético. Si F3 llega, F8 no se construye. Todo detrás del flag **`aiAssist` apagado por defecto** y un interruptor por uso.

**Proveedores investigados (precios y cuotas a 2026-10; todas las cifras de terceros salvo donde se indica, verificar en U8.0)**:

| Proveedor | Gratis | ¿Entrena con los datos? / retención | Encaje para pólizas (PII) |
|---|---|---|---|
| **Groq** (Llama 4 Scout con visión, Llama 3.x 8B, gpt-oss) | Sí, plan Free con límites por organización (p. ej. ~1 000 peticiones/día en modelos medianos, cifras de terceros) | Documentación oficial: por defecto **no retiene** datos de inferencia; **Zero Data Retention** activable en «Data Controls»; acuerdo sin entrenamiento; datos en GCP EE. UU. | **Recomendado** para texto (gratis + sin entrenamiento). |
| **Google Gemini API** Flash / Flash-Lite | Sí (solo Flash/Flash-Lite desde abril 2026; límites en la consola) | **Plan gratuito: Google puede usar las peticiones para mejorar productos, con revisión humana** — NO apto para pólizas. Plan de pago: no se usa para entrenar. | Pago, como respaldo barato: Flash-Lite ≈ 0,10-0,30 USD por millón de tokens de entrada (una póliza ≈ 3 000 tokens ⇒ ≈ 0,001 USD). Útil para visión en escaneados. |
| **Cloudflare Workers AI** | 10 000 «neuronas»/día gratis (oficial, doc. actualizada 2026-08-24); 0,011 USD/1 000 neuronas después | Oficial: no entrena con el contenido del cliente | Exige desplegar un Worker (es un proxy/servidor): fuera del MVP. |
| **OpenRouter** `:free` | 20 peticiones/min; 50/día (1 000/día tras 10 USD de compras históricas) | Depende del proveedor que sirva; hay ajuste para excluir proveedores que entrenan; varios gratuitos retienen o entrenan | No recomendado para PII (política variable por ruta). Útil solo para pruebas sin datos. |
| **Mistral** | Plan «Experiment» gratis **exige aceptar entrenamiento** (oficial: help center); excepción: **Mistral OCR sin entrenamiento y con retención cero por defecto** | — | OCR de pago (≈ 4 USD/1 000 páginas, cifra no confirmada) como alternativa para escaneados difíciles. |

**Recomendación**: (1) **Groq gratis con la clave propia del usuario (BYOK)** para extracción desde TEXTO (el OCR sigue siendo
local); (2) respaldo **Gemini Flash-Lite de pago** solo para escaneados ilegibles (céntimos al mes), nunca el plan gratuito de
Gemini con PII; (3) OpenRouter/Mistral gratis descartados para pólizas.

**Arquitectura segura**:
- **Llamada directa desde el navegador con clave del usuario** (BYOK) — recomendada: nada pasa por un servidor nuestro, coste 0
  para el proyecto. La clave se pega en Ajustes, se guarda solo en este navegador (IndexedDB), se muestra enmascarada, «Borrar
  clave» y **nunca** entra en el Package ni en Recientes. Nadie del proyecto pide ni escribe claves; el usuario crea la suya.
- Alternativa no recomendada ahora: proxy mínimo (Route Handler de Next 16 en Vercel) con clave del servidor, límites por IP y sin
  registros: la PII pasaría por nuestra infraestructura y hay que operar secretos.
- **CSP**: añadir a `connect-src` SOLO los orígenes del proveedor elegido (`https://api.groq.com`; si se activa Gemini,
  `https://generativelanguage.googleapis.com`). U8.0 confirma que cada API admite CORS desde el navegador.
- **Consentimiento explícito por envío**: hoja que muestra EXACTAMENTE el texto que se enviará (con lo enmascarado resaltado),
  el proveedor, su política (entrenamiento, retención, región) y «Enviar» / «Cancelar»; opción «No volver a preguntar en esta
  sesión».
- **Minimización**: solo líneas de las páginas 1-2 cercanas a etiquetas conocidas (≤ 4 000 caracteres); se ENMASCARAN números
  tipo SSN, fecha de nacimiento, cuentas bancarias y tarjetas; los valores que las reglas locales ya resolvieron con alta
  confianza (email, teléfono, ZIP) se sustituyen por marcadores y no se envían; imágenes solo con permiso aparte y solo la zona
  recortada.
- **Salida controlada**: JSON con esquema estricto; un valor se acepta SOLO si aparece literalmente (normalizado) en el texto
  enviado (anti-alucinación); se marca «Sugerido por IA» en «Datos del cliente»; nada se rellena sin confirmar.
- **Sin red / 429 / tiempo agotado (15 s)**: se sigue con las reglas locales y se avisa; un reintento como máximo.
- **Otros usos que convienen** (mismo flag, interruptor propio): sugerir el «origen de dato» de cada campo al configurar una
  plantilla (solo etiquetas de un contrato en blanco: sin PII). NO se usará IA para clasificar firmas del Extractor (las firmas
  son datos biométricos): ahí solo heurística local.
- Medición: mismo corpus sintético de F3, comparando reglas vs reglas + IA; se recomienda activarlo solo si mejora ≥ 10 puntos en
  los campos de baja confianza con 0 valores inventados.

Unidades: **U8.0** prueba técnica (CORS, modelos vigentes, cuotas reales con la clave del usuario, latencia en iPad) — `aos-builder`,
sin datos reales · **U8.1** `src/lib/ai/{providers/groq.ts,providers/gemini.ts,minimize.ts,validate.ts}` puros con pruebas
(enmascarado, anti-alucinación, errores) — `aos-builder` · **U8.2** Ajustes «Asistente de IA (opcional)» (clave, proveedor,
interruptores, políticas) + hoja de consentimiento + integración en «Datos del cliente» + CSP — `aos-builder` · **U8.3** textos y
explicaciones de privacidad — `aos-builder-lite` · **Puerta V8** con `security-auditor` en Sonnet.

### 9.7 Dependencias de archivos (quién toca qué; serializar donde coinciden)

| Archivo / zona | Unidades | Regla |
|---|---|---|
| `src/app/sign-pdf/SignToolClient.tsx` (caliente) | U0.2 (montaje), U0.3, U0.4, U0.5, U0.7, U1.2/U1.3, U2.3/U2.4, U3.4 | Una sola unidad a la vez; orden U0.2 → U0.3 → U0.4 → U0.5 (línea) → U0.7. |
| `signVault.ts` | U6.2 (`origin`), U4.4 (lectura), U7.4 (guardar) | U6.2 primero. |
| `signVaultFile.ts` → `src/lib/crypto/passwordBox.ts` | U4.4 | Antes de U4.1/U4.7 (las usan). |
| `SignatureVaultSheet.tsx` | U6.2 (entrada «Subir»), U4.4 (exportar/importar todas) | U6.2 → U4.4. |
| `SignatureComposer.tsx` | U6.2 (modo «Subir» con `inkExtract`) | Solo F6. |
| `src/lib/image/inkExtract.ts` (nuevo) | U6.1 (crea), U6.2, U7.4 | F6 antes que U7.4. |
| `src/components/views/SettingsView.tsx` | U0.4, U0.5, U4.7, U8.2 | En ese orden. |
| `src/lib/tools-registry.ts`, `src/lib/locales/{es,en}.ts` | U7.4/U7.6 (herramienta), U0.6, U2.5/U2.7 (Inicio, Recientes), U4.3 | Cambios pequeños; serializar por fase; nunca dos unidades en paralelo sobre locales. |
| `src/lib/pdf/core.ts` | U7.0 (`wasmUrl`) | Sola, con regresión completa. |
| `next.config.ts` (CSP) | U7.0 (si hiciera falta servir `.wasm` con cabeceras), U8.2 | — |
| `HomeView.tsx`, `RecentView.tsx` | U0.6, U2.5, U2.6 | En ese orden. |
| `src/lib/backup/*` (nuevo) | U4.1, U4.4-U4.8 | U4.1 primero; módulos en paralelo después. |

### 9.8 Orden de entrega recomendado (con horas de agente)

| # | Entrega | Unidades | Horas | Se despliega cuando |
|---|---|---|---|---|
| 1 | **F0 en curso**: no perder trabajo, turno 2, certificado, Recientes que continúa, E-sign deshabilitado | U0.1-U0.7 | 15-20 | V0 VERIFIED |
| 2 | **Firmas por imagen + exportar/importar todas las firmas** | F6 (U6.1-U6.3) + U4.4 | 14-19 | V6 (U4.4 incluida) |
| 3 | **Asignación A/B y copias + Plantillas + Mis documentos + Recientes unificado** | F1 + F2 | 40-52 | V1 y V2 (pueden salir por separado) |
| 4 | **Package modular completo** (Plantillas+Documentos, Sistema, Package, Ajustes) | U4.1-U4.3, U4.5-U4.8 | 16-22 | V4 |
| 5 | **Autollenado por reglas + OCR** | F3 | 26-36 | V3 |
| 6 | **Extractor** | F7 (U7.0-U7.6) | 32-42 | V7 |
| 7 | **IA opcional** (solo si F3 no llega) | F8 | 20-30 | V8 |
| — | Firma remota por email | F5 | aparcada | — |

Total entregas 1-6: ≈ 143-191 h; con F8: ≈ 163-221 h.

**Paralelismo posible** (archivos disjuntos): el Extractor (U7.0-U7.3, U7.5) puede construirse EN PARALELO a la entrega 3, porque
vive en `src/lib/pdf/extractAssets/` y `src/app/extract-assets/` (solo U7.4 espera a F6 por `inkExtract` y toca registro/locales
al final). U4.1 (núcleo del Package) puede ir en paralelo a F2. U3.1/U3.2 (fixtures y extractor de pólizas) pueden empezar en
paralelo a F2 porque son módulos puros. Límite práctico: 2-3 constructores a la vez para que las puertas de verificación no se
atasquen.

**Modelos**: construcción `aos-builder` (Sonnet 5.5, esfuerzo extra alto); `aos-builder-lite` (Haiku 5.5) SOLO para U0.7, U1.4,
U2.7, U3.1, U3.6, U4.3, U4.8, U6.3, U7.5, U7.6, U8.3 (textos, fixtures, mecánico con patrón); verificación independiente en
contexto limpio con Sonnet (`aos-verifier-senior`/`security-auditor` con `model: "sonnet"`); Opus solo planifica y orquesta.
Pruebas de navegador siempre headless.

### 9.9 Riesgos nuevos

- **Package**: compatibilidad hacia atrás de formatos durante años → paquetes dorados obligatorios por versión (U4.8); un import
  parcial no debe dejar almacenes a medias (escritura por módulo en una transacción de IndexedDB; si falla, ese módulo no se aplica).
- **Extractor**: falsos positivos de «firma» en documentos con gráficos; PDFs con miles de imágenes pequeñas (mosaicos de
  escaneo) → agrupar por XObject padre y tope de elementos; JPX/JBIG2 dependen de U7.0.
- **inkExtract** en fotos con sombras fuertes o papel de color: la corrección de iluminación ayuda pero no es perfecta; siempre
  hay deslizador y vista previa.
- **IA**: cuotas y modelos gratuitos cambian sin aviso (por eso es opcional, con respaldo local); políticas de datos de terceros
  pueden cambiar → la hoja de consentimiento muestra la política vigente y enlaza a la del proveedor.

### 9.10 Preguntas abiertas para el usuario (máx. 4, con recomendación)

1. **¿Puedes aportar 3-5 pólizas y 3-5 contratos firmados ANONIMIZADOS** (datos tachados o falsos) para medir autollenado y
   Extractor con layouts reales? Recomendado: sí; si no, se mide solo con el corpus sintético (más riesgo en producción).
2. **¿Incluir borradores en curso (con datos de clientes y firmas) en el Package?** Recomendado: NO por defecto; como módulo
   aparte, desmarcado y SOLO con contraseña obligatoria.
3. **Proveedor de IA cuando toque F8**: Groq gratis con tu propia clave (sin entrenamiento) + Gemini Flash-Lite de pago como
   respaldo para escaneados. Recomendado: sí; tú creas la cuenta y pegas la clave en Ajustes (nunca la compartes con nadie).
4. **Extractor y firmas ajenas**: ¿permitir guardar en el baúl firmas extraídas de terceros con aviso + casilla «Tengo
   autorización» cada vez? Recomendado: sí, con la casilla obligatoria y la marca «extraída» visible en el baúl.

### 9.11 Fuentes de la revisión 2 (consultadas el 2026-10-14)

- Gemini: [CloudZero, precios 2026](https://www.cloudzero.com/blog/gemini-pricing/), [TokenMix](https://tokenmix.ai/blog/gemini-api-pricing),
  [Meetily, retención Gemini gratis vs pago](https://meetily.ai/llm-privacy/gemini), [CostGoat (oct 2026)](https://costgoat.com/pricing/gemini-api).
- Groq: [Groq docs «Your data»](https://console.groq.com/docs/your-data), [eesel, precios 2026](https://eesel.ai/blog/groq-pricing),
  [BenchLM free tier](https://benchlm.ai/md/free-tier/groq.md), [OpenRouter, comparativa de APIs gratuitas 2026](https://openrouter.ai/blog/tutorials/free-llm-apis-compared/).
- Cloudflare: [Workers AI pricing (oficial)](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Workers AI data usage/privacy (oficial)](https://developers.cloudflare.com/workers-ai/platform/privacy/).
- OpenRouter: [Logging y privacidad (oficial)](https://openrouter.ai/docs/guides/privacy/logging), [Provider logging (oficial)](https://openrouter.ai/docs/guides/privacy/provider-logging),
  [TrueFoundry, límites free](https://www.truefoundry.com/blog/openrouter-free-models-whats-actually-free-and-what-it-costs-you).
- Mistral: [Help center: uso de datos para entrenar](https://help.mistral.ai/en/articles/323757-do-you-use-my-user-data-to-train-your-artificial-intelligence-models),
  [Curlscape, precios 2026](https://curlscape.com/blog/mistral-api-pricing-2026), [UsagePricing, cambio de precios jul 2026](https://usagepricing.com/blueprint/activity/mistral-ai-2026-07-06-price-change).
- pdf.js local: `node_modules/pdfjs-dist/build/pdf.mjs:320-326` (`DrawOPS`), `node_modules/pdfjs-dist/wasm/` (openjpeg, jbig2, qcms).

---

## 10. Respuestas del usuario a las preguntas abiertas de la revisión 2 (2026-10-14) — mandan sobre §9

1. **Documentos reales**: sí, el usuario aportará más adelante 3-5 pólizas y 3-5 contratos firmados ANONIMIZADOS (sin nombres, teléfonos ni direcciones reales). Hasta entonces, todo se mide con PDFs sintéticos; al llegar se añaden a `e2e/fixtures/` (solo anonimizados) y se re-miden las métricas de F3 y F7.
2. **Borradores en el paquete**: **SÍ, siempre** se incluyen los borradores en curso en el OptimusPDF Package (decisión del usuario). Condiciones de implementación que no cambian esa decisión: (a) el Package muestra antes de exportar un resumen de lo que lleva, incluidos «N borradores con datos de clientes y firmas»; (b) se ofrece cifrar con contraseña (casilla visible, recomendada), pero NO es obligatoria; (c) el importador valida y limita igual que el resto; (d) los módulos individuales siguen siendo independientes (firmas, plantillas+documentos, sistema, borradores).
3. **Proveedor de IA (F8)**: decidir cuando llegue; no se construye integración concreta ahora (F8 sigue condicionada a las métricas de F3).
4. **Extractor y firmas ajenas**: el usuario quiere extraer **cualquier** firma, **sin marca ni casilla de autorización**: resultado = firma limpia (PNG con transparencia), lista para guardar en el baúl o usar. Se elimina del diseño la casilla «Tengo autorización» y la marca «extraída». Se conserva únicamente una nota estática de una línea («Úsalo solo con firmas propias o con autorización de su titular») en la pantalla del Extractor, sin ninguna interacción obligatoria; el usuario puede pedir quitarla.

### U4.4-lib entregada: API, formato y límites (2026-10-15)

Parte de LIBRERÍA de U4.4 (sin interfaz: «Exportar todas mis firmas / Importar firmas» en `SignatureVaultSheet.tsx` es U4.4-UI). Todo está en `src/lib/crypto/*`, `src/lib/backup/*` más dos cambios aditivos en `src/app/sign-pdf/` (abajo).

**Cifrado reutilizable — `src/lib/crypto/passwordBox.ts`.** PBKDF2-SHA256 600 000 it. → AES-GCM-256, parámetros fijos, contraseña normalizada NFKC. Una caja = `{ header, payload }`: `header` es el JSON UTF-8 `{version, kind, kdf:{name,hash,iterations,salt}, iv}` y sus bytes EXACTOS son el AAD del GCM; `payload` = cifrado + etiqueta de 16 B.
- `encryptWithPassword(bytes, password, {kind?, version?})`, `decryptWithPassword(box, password, expect?)`, `assertPasswordBoxShape`, `passwordBoxAvailable`.
- Errores `PasswordBoxError.code`: `corrupt` (forma inválida: cabecera ilegible/KDF distinto de los parámetros fijos/sal o IV de longitud mala/payload < 16 B/`kind`·`version` no esperados; se detecta ANTES de derivar la clave), `unavailable` (sin `crypto.subtle`), `needsPassword`, `wrongPassword` (fallo de autenticación; contraseña mala y datos manipulados son indistinguibles A PROPÓSITO), `invalidPassword` (al cifrar con contraseña vacía). Mensaje = código; nunca lleva contraseña ni bytes. Orden de comprobación: `corrupt → unavailable → needsPassword → wrongPassword`.
- `signVaultFile.ts` ahora usa `passwordBox.ts` SIN cambiar el formato: `manifest.json` exterior = `header`, `vault.enc` = `payload`. Prueba de no regresión con archivos «dorados» generados con el código ANTERIOR (`src/lib/crypto/__fixtures__/vault-plain-v1.zip`, `vault-encrypted-v1.zip`, `vaultGolden.test.ts`; no regenerar) y los 59 tests existentes de `signVaultFile.test.ts` intactos. `sha256.ts` aporta SHA-256 con respaldo puro cuando no hay `crypto.subtle` (http en la red local).

**Contenedor — `src/lib/backup/package.ts`** (`types.ts`, `zipDirectory.ts`, `strictJson.ts`, `registry.ts`, `migrations/`).
```
<nombre>.optimuspdf.zip
├─ manifest.json   { format:"optimuspdf.package", formatVersion:1, createdAt, app:{version,build},
│                    modules:{ <nombre>:{ schemaVersion, ...meta escalar } },
│                    files:[ { path, sha256, bytes, type } ] }
└─ <carpeta>/…     archivos del módulo (signatures/…)
cifrado opcional (zip completo):  envelope.json (header de passwordBox, kind "optimuspdf.package-encrypted", version 1) + payload.bin
```
- `buildPackage({modules, password?, app?, registry?, now?}): Promise<Blob>`; `readPackage(file, password?, {registry?}): Promise<PackageReadResult>` (NO escribe nada: devuelve por módulo `{name, declaredSchemaVersion, status:"ok"|"newerVersion", message?, meta, files: Map<ruta, {bytes|null, sha256, type, status}>}` más `warnings` y `encrypted`); `PackageError.code`: `badZip, tooLarge, tooManyEntries, bomb, unsafePath, duplicateEntry, invalidManifest, invalidJson, newerFormat, needsPassword, wrongPassword, corrupt, unavailable, invalidModule` (mensajes fijos en español; `newerFormat` = «Creado con una versión más nueva de OptimusPDF; actualiza la página.»).
- Qué invalida TODO el paquete (lanza): zip ilegible, límites, rutas inseguras, duplicados, manifiesto inválido, contenedor más nuevo, cifrado. Qué invalida SOLO un elemento (no lanza): por archivo `status` = `sha256Mismatch | sizeMismatch | missing | tooLarge | unreadable`; un módulo de esquema mayor → `newerVersion` (no se infla nada de él; los demás módulos se leen); módulos/carpetas desconocidos y archivos sin listar → aviso (`unknownModule | ignoredFile | unlistedFile`).
- Cada módulo se declara con un `PackageModuleSpec` (`name, schemaVersion, folders, maxFileBytes, maxJsonBytes`) en `registry.ts`; hoy solo `signatures`. U4.5-U4.7 añaden los suyos ahí.

| Límite (importación) | Valor | Dónde se comprueba |
|---|---|---|
| Archivo recibido / descifrado | ≤ 250 MiB | antes de leerlo |
| Entradas del zip | ≤ 2 000 | EOCD, antes del directorio central |
| Suma de tamaños descomprimidos declarados | ≤ 250 MiB | directorio central, antes de inflar |
| Relación descomprimido:comprimido | ≤ 100:1 por entrada y global (se exige por encima de 1 MiB) | directorio central |
| Comprimido vs. descomprimido declarado (deflate) | comprimido ≤ descomprimido + 0,4 % + 64 B | directorio central |
| Bytes REALMENTE inflados por lectura | ≤ 250 MiB (presupuesto global; cuenta también lo que JSZip emite tras cortar) | lectura |
| Lectura de una entrada | se corta al pasar de lo declarado; el total leído debe igualar lo declarado | lectura |
| `manifest.json` / `envelope.json` / JSON de módulo | ≤ 1 MiB / 4 KiB / `maxJsonBytes` del módulo (firmas: 1 MiB); profundidad ≤ 16 | antes de inflar / `strictJson.ts` |
| Rutas | seguras (sin `..`, `.`, vacías, absolutas, `\`, unidad `C:`, control, bidi; ≤ 200) o se rechaza todo; las conocidas además `^<carpeta>/<archivo>$` ASCII; duplicados (sin distinguir mayúsculas) rechazan | directorio central |
| Método de compresión | solo 0 y 8; sin cifrado de zip ni ZIP64 | directorio central |
Además el directorio central propio se CONTRASTA con el de JSZip (nombres y tamaños): cualquier discrepancia (p. ej. campo «Unicode path», EOCD que miente) rechaza el paquete. `JSZip.loadAsync` se usa SIN `checkCRC32` (esa opción infla todo al cargar); la integridad la da el SHA-256.

**Módulo Firmas — `src/lib/backup/modules/signatures.ts`.** Formato: `signatures/index.json` = `[{ id, signerName, role?, origin?, createdAt, lastUsedAt, signature?:"signatures/<id>-signature.png", initials?:"signatures/<id>-initials.png" }]` + los PNG. NO viajan `signerKey` (se recalcula), `sourceDocument` (nombre de documentos del cliente: privacidad) ni `schema`. `origin` se conserva en el paquete si la entrada ya lo trae, pero la importación NO lo escribe (aún no existe en el baúl).
- `exportSignatures(): Promise<PackageModuleInput>` (lee `listVault`; sin IndexedDB lanza `PackageError("unavailable")`) y `signaturesModuleFromEntries(entries)` (puro).
- `planSignaturesImport(readResult, vaultEntries): Promise<ImportPlan>` → `state: "ok"|"absent"|"newerVersion"|"damaged"`, `items[]` con `status: "new"|"identical"|"different"|"invalid"` (+`reason`: `integrity|tooLarge|invalidImage|invalidEntry|duplicateId`), `conflictWith`, `supersedes`, `counts`, `limits`. «Idéntico» = mismo `signerKey` + cada imagen del elemento presente con el mismo SHA-256 en una entrada del baúl (el baúl puede tener más). «Distinto» = hay entrada con el mismo id o del mismo firmante con otras imágenes; el destino de «Reemplazar» es: la del mismo id → la que comparte hash de imagen → la más reciente del firmante (un destino solo se sustituye una vez).
- `defaultSignatureDecisions(plan)` (sugerida para la UI: nuevo → importar; distinto → reemplazar si el elemento trae TODAS las imágenes de la entrada, si no conservar ambos; idéntico/inválido → omitir), `checkSignaturesLimits(plan, decisions)` → `{wanted, fits, ok, entriesAfter, bytesAfter}` (cuántas CABEN en 30 firmas / 20 MiB antes de importar), `applySignaturesImport(plan, decisions)` → `{ok:true, written, replaced, skipped}` | `{ok:false, reason:"limit"|"unavailable"|"invalid"|"blocked", fits?, wanted?}`. Decisiones: `import` (solo «nuevo»), `replace`/`keepBoth` (solo «distinto»), `omit`; lo que no esté aprobado explícitamente NO se escribe. Si no caben todos los aprobados no se escribe NINGUNO.
- Seguridad: cada PNG pasa `parsePng` (≤ 600 KB, `readPngSize`, IEND, `pngIhdrCrcValid`, `isValidVaultImage` → ≤ 4096 px); la ruta de la imagen se deriva del id y debe coincidir con la del índice; campos desconocidos se ignoran; nombre/cargo sin marcas bidi ni controles y ≤ 200; fechas ISO válidas; ≤ 200 elementos en el índice; el plan se REVALIDA al aplicar (la UI no puede colar entradas).
- Migraciones puras encadenadas: `migrations/chain.ts` (`runMigrationChain`) y `migrations/signatures/` (esquema actual 1; `v1.ts` = identidad v1→v1; añadir `v1-to-v2.ts` y registrarlo en `index.ts` cuando exista el 2). Un módulo con `schemaVersion` > actual se rechaza («Creado con una versión más nueva…») y el resto del paquete sigue.
- Paquetes dorados: `src/lib/backup/__fixtures__/packages/signatures-v1.optimuspdf.zip` y `signatures-v1-encrypted.optimuspdf.zip` (contraseña `dorada-2026`), `goldenPackages.test.ts` itera TODOS los `*.optimuspdf.zip` de esa carpeta: cuando exista el esquema 2 se AÑADE su dorado junto al v1, nunca lo reemplaza.

**Cambios aditivos fuera de `lib/`:** `signVault.ts` exporta `isStoredEntry` y añade `commitVaultImport({puts, deleteIds})` (UNA transacción: relee, comprueba 30 entradas / 20 MiB sobre el resultado final, omite lo ya cubierto por el mismo firmante, reasigna ids ocupados, borra destinos y escribe; un fallo de cuota o cualquier excepción aborta la transacción → el baúl queda como estaba; esquema y validadores intactos). `signVaultFile.ts` exporta `hasPngEnd`.

**Para U4.4-UI (orden de llamadas):** `exportSignatures()` → `buildPackage({modules:[m], password?})` → descarga/`navigator.share`. Importar: `readPackage(file, password?)` (capturar `PackageError`: `needsPassword` pide la contraseña y reintenta) → `listVault()` → `planSignaturesImport` → mostrar `items` con `defaultSignatureDecisions` y `checkSignaturesLimits` → `applySignaturesImport`. Nombre de archivo sugerido: `OptimusPDF-firmas.optimuspdf.zip` (la UI lo elige; nada dentro del zip depende de él).

**Pruebas:** vitest (node + jsdom) en `src/lib/crypto/*.test.ts` y `src/lib/backup/**/*.test.ts(x)`; corpus de zips hostiles generados en la prueba con `__fixtures__/zipForge.ts` (zip-bomb por relación, total declarado > 250 MiB, 5 000 / 2 001 entradas, EOCD que miente, rutas `../` `/etc/x` `\` `C:` controles y bidi, duplicados exactos y por mayúsculas, directorio central que miente al alza y a la baja, miles de entradas que mienten (presupuesto de inflado), registros con cifrado/método 9/ZIP64, «Unicode path», manifiesto sin `files`/SHA malo/JSON profundo o enorme, PNG corrupto/enorme, envoltura cifrada truncada/KDF ajeno/caja anidada), cada uno < 2 s y sin abrir IndexedDB.

---

### U6.1 entregada: API y límites (motor `inkExtract`, 2026-10-15)

**Qué es.** `src/lib/image/inkExtract.ts` (puerta de entrada única) convierte una imagen de firma/iniciales (foto sobre papel, JPG con fondo blanco, PNG, WEBP, SVG; HEIC solo donde el navegador lo abra) en un PNG de «tinta» con fondo transparente, listo para el baúl (`signVault.ts`: ≤ 4096 px y ≤ 600 KB) y para estamparse sin recuadro blanco. Sin UI (U6.2) y sin dependencias nuevas: todo en el navegador, sin red. Piezas: `inkCore.ts` (algoritmos puros, sin DOM), `inkDecode.ts`, `inkPng.ts`, `inkExtract.worker.ts`.

**API pública** (todo se exporta desde `inkExtract.ts`):

| Función | Para qué |
|---|---|
| `decodeImageFile(file, {rasterizer?})` → `DecodedInkImage` (`ImageData`-compatible + `format`, `originalWidth/Height`, `downscaled`) | Lee el archivo. Formato por los PRIMEROS BYTES (no por nombre ni `type`). Rechaza vacío, > 10 MB y > 100 MP según la CABECERA (sin decodificar). Decodifica ya reducida a ≤ 16 MP. SVG: `<img src=blob:>` (no ejecuta scripts ni carga recursos), rasterizado a 2000 px de lado mayor. |
| `extractInk(image, options)` → `ExtractResult` | Núcleo síncrono y puro. |
| `extractInkAsync(image, options, {signal?, worker?, budgetMs?})` | Igual, sin bloquear la interfaz: > 4 MP → Web Worker (respaldo al hilo principal si no arranca); ≤ 4 MP → hilo principal CEDIENDO el control cada 30 ms. Mismos bytes por ambos caminos. Cancelable con `AbortSignal`. La imagen de entrada no se toca (se copia al worker): se puede reutilizar al mover un deslizador. |
| `extractInkFromFile(file, options, run, decode)` | `decodeImageFile` + `extractInkAsync`. |
| `encodePng(result)` → `Blob` · `encodeInkPng(image, {maxBytes, maxDimension})` → `{bytes, width, height, scale, quantization}` | PNG propio y determinista (RGBA 8 bits, sin metadatos) dentro de los topes. Escalera: sin pérdida → color a 5 bits → 3 bits → color plano (el alfa, que es el antialias, NO se toca) → reducir tamaño (0,85×, 0,7×, …). `InkError("encode-failed")` solo con topes absurdos. Sin `CompressionStream` cae al PNG del canvas. |
| Utilidades para el Extractor (F7/U7.4): `estimateBackground`, `otsuThreshold`, `removeSpecks`, `trimToInk`, `resizeArea`, `fitDimensions`, `copyRect`, `sniffImageFormat`, `readImageSize`, `planRasterSize`, `yieldToMain` | Reutilizables para el recorte manual de regiones (`crop: {x,y,width,height}` analiza SOLO esa región: su fondo y su umbral no dependen del resto de la página). |

**Opciones de `extractInk`**: `threshold` (`"auto"` = Otsu sobre la luminancia, o 1-254: luminancia donde la tinta queda al 50 %), `softness` 0-1 (0,5), `ink` (`"original"` por defecto, `"black"` = #0b0b0c, `"blue"` = #12327d —los tonos de `SIGNATURE_INKS`—, o `{r,g,b}`), `cleanSpecks` (`"auto"`, 0 = desactivado, o px mínimos de un trazo 8-conectado), `evenLighting` (`true`), `crop` (`"auto"` al contenido, `"none"`, o rectángulo con `exact`), `margin` (`"auto"` ≈ 5 % entre 2 y 48 px, o px), `maxDimension` (4096). El resultado trae `threshold`, `inkBounds` y `outputRect` (en coordenadas de la imagen de ENTRADA), `inkPixels`, `removedSpecks`, `scale`.

**Algoritmo.** Luminancia (Rec. 601, lo transparente se compone sobre blanco) → fondo del papel por celdas (percentil 85, repara celdas con tinta con la mediana de las vecinas, interpolación bilineal con extrapolación) y división (corrige sombras y degradados) → Otsu → alfa suave simétrica en el umbral (rampa proporcional a la distancia tinta-papel) → color «original» recuperado quitando el papel de los bordes y la ganancia de iluminación → motas (componentes < N px) → recorte con margen → reducción por áreas con alfa premultiplicado.

**Errores** (`InkError`, `.code` estable, `.message` en español): `empty-file`, `file-too-large`, `unsupported-format`, `decode-failed`, `too-many-pixels`, `invalid-image`, `no-ink` («No se encontró tinta…», también para blanco liso, sin contraste o < 4 px de tinta), `too-dark` (mediana de luminancia < 64), `encode-failed`, `aborted`. La UI (U6.2) debe mapear el código a su texto ES/EN.

**Límites.** Entrada ≤ 10 MB; ≤ 100 MP según cabecera; se trabaja a ≤ 16 MP (más se decodifica reducido) y `extractInk` rechaza > 50 MP; memoria de trabajo ≈ 13 B/px (16 MP ≈ 200 MB: vigilar en iPad). Solo tinta OSCURA sobre fondo claro (no tinta blanca ni fondos negros). Las motas se eliminan por tamaño: un punto legítimo menor que el mínimo automático (6 px a ≤ 800 px de lado; 26 px a 1600; 160 px a 4000) se pierde: la UI debe ofrecer `cleanSpecks: 0`. Una sombra de borde duro (salto del 27 %, sin penumbra) deja algo de fondo junto al borde (medido 98,7 % de fondo limpio; saltos mayores empeoran). HEIC: solo si el navegador lo decodifica (Safari); no verificado en un Safari real. La orientación EXIF la aplica el navegador (comprobado en Chromium y WebKit de Playwright).

**Medido** (sintético, `crop: "none"`; fondo = píxeles sin cobertura a ≥ 2 px del trazo con alfa 0; tinta = cobertura ≥ 0,5 con alfa ≥ 128): peor caso 98,13 % de fondo transparente y 98,93 % de tinta conservada en 11 casos (negro/azul, sombra, JPEG q35-q70, 1 px, 120×50). Rendimiento: ≈ 23-26 ms/MP en Node, ≈ 27-43 ms/MP en Chromium (4 MP en hilo principal ≈ 110-170 ms, sin tareas largas > 50 ms). Pruebas: `src/lib/image/*.test.ts` (Vitest/Node con `@napi-rs/canvas`, 68 mutaciones, todas detectadas) y `e2e/specs/ink-extract.spec.ts` (navegador real headless; empaqueta el motor con Vite y lo inyecta en `/privacy`; no hay página de pruebas en el producto; en WebKit: `PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1 … --project=webkit-ipad`).

---

### U6.2 + U4.4-UI entregada: subir firmas/iniciales como imagen y exportar/importar todas las firmas (2026-10-15)

**Qué ve el usuario.** En «Firmas guardadas» hay ahora tres botones de ancho completo: **«Subir firma o iniciales»**, **«Exportar todas mis firmas»** e **«Importar firmas»** (el icono discreto de importar el archivo de UNA firma sigue ahí y «Importar firmas» también lo acepta: si el `.zip` no es un paquete lo recibe el importador de siempre). El modo «Subir» del compositor ya no recorta solo por alfa: abre la misma hoja de subida en modo «borrador» (sin nombre ni tipo ni baúl) y devuelve el PNG limpio al compositor.

1. **Subir** (`SignatureImportSheet.tsx`, hoja con foco atrapado y devuelto, Escape, UNA región viva `role=status`): *Elegir* (botón «Elegir imagen», arrastrar y soltar, pegar; «Tomar una foto» con `capture="environment"` solo con puntero táctil) → *Ajustar* (vista previa en vivo sobre damero y sobre una línea de firma; «Recortar a mano» con 4 asas de 44 px, también con flechas del teclado (Mayús = saltos grandes); deslizador «Limpiar fondo» 0-100 con «Automático»; interruptores «Igualar iluminación (fotos)» y «Quitar motas» (apagado = `cleanSpecks: 0`); tinta Original / Negro / Azul; Firma / Iniciales) → *Resumen* (firma e iniciales pueden venir de DOS imágenes en dos pasos y se guardan en UNA entrada; nombre del firmante obligatorio, cargo opcional) → `saveVaultEntry` con `origin: "uploaded"` y `sourceDocument: ""`. La vista previa usa `extractInkAsync` con `AbortSignal` (cada cambio cancela el cálculo anterior; debounce de 180 ms; > 4 MP en Web Worker). La imagen original vive solo en memoria mientras la hoja está abierta y se suelta al aceptar; solo el PNG de tinta llega al baúl y nada sale a ninguna red. Errores del motor (`InkError`) mapeados a mensajes ES/EN sin salir de la hoja, con «Pide la foto en JPG o PNG» para HEIC que el navegador no abre; ayuda fija «Toma una foto de la firma sobre papel blanco, con buena luz».
2. **Exportar** (`SignatureBackupSheet.tsx`): «Proteger con contraseña» marcada por defecto (contraseña + confirmación, mínimo 8 caracteres, medidor `role=meter` de 4 niveles; si se desmarca, aviso de que las firmas quedan sin cifrar; sin WebCrypto —http— la casilla queda desmarcada y deshabilitada con su explicación). Archivo `firmas-optimuspdf-AAAA-MM-DD.optimuspdf.zip` (fecha local). Con puntero táctil y `navigator.share({files})` + `canShare` la hoja primero deja «Archivo listo» y comparte en un SEGUNDO toque (Safari exige gesto reciente y el cifrado ya tardó): «Compartir o guardar en Archivos» / «Descargar»; cerrar la hoja de compartir sin elegir NO cuenta como exportado; si compartir falla cae a la descarga. En escritorio descarga directo. Confirma «N firmas exportadas (cifradas con contraseña / sin cifrar)».
3. **Importar**: elegir o soltar el `.zip` → contraseña si está cifrado (la incorrecta dice «La contraseña no es correcta, o el archivo está dañado» y deja reintentar) → hoja «Revisa antes de importar» con `planSignaturesImport`: cada elemento «Nuevo», «Ya lo tienes (idéntico)», «Distinto» (Reemplazar / Conservar ambos / Omitir; sugerida por `defaultSignatureDecisions`; aviso si reemplazar pierde una imagen) o «No se puede importar» con su motivo; «Después de importar tendrás N de 30 firmas» o «Solo caben X de las Y elegidas…» (botón bloqueado); botón «Importar N firmas» (atómico, `applySignaturesImport`) y resultado «N importadas, M omitidas». Cada `PackageError` tiene su mensaje (archivo no válido, demasiado grande, no seguro de abrir, dañado, versión más nueva «actualiza la página», sin cifrado disponible, sin firmas).

**Código.** Lógica pura aparte de la interfaz: `inkImportModel.ts` (ajustes → opciones del motor, recorte en fracciones y su geometría, deslizador ↔ umbral, mapa de errores, `buildUploadEntry`), `backupFlow.ts` (contraseña y medidor, nombre de archivo, exportar, compartir, leer y aplicar), `backupModel.ts` (opciones por estado y mensajes), `inkImportEngine.ts` (carga perezosa del motor: el worker solo se baja al subir una imagen; copia reducida cooperativa para mostrar). Interfaz: `SignatureImportSheet.tsx`, `InkCropper.tsx`, `SignatureBackupSheet.tsx` (+ integración en `SignatureVaultSheet.tsx` y `SignatureComposer.tsx`). Textos ES/EN en dos bloques propios de `strings.ts`: `inkImport` y `vaultBackup`. **Campo `origin`**: `VaultEntry.origin?: "drawn" | "typed" | "uploaded" | "extracted"` (`VAULT_ORIGINS`, `isVaultOrigin`), SIN subir `schema`: `isStoredEntry` lo acepta ausente o de la lista (un registro con otro valor ya no se lista); `saveVaultEntry` rechaza un valor ajeno como `invalid`, lo conserva en duplicados y al ampliar manda el nuevo (si no trae, el anterior); `modules/signatures.ts` ahora ESCRIBE el `origin` validado al importar (antes solo lo mostraba). Los guardados del compositor (dibujar/escribir) no lo llevan (ausente = válido).

**Cambios en pruebas existentes (explicados).** Solo dos aserciones de `src/lib/backup/modules/signatures.test.ts`, que fijaban el comportamiento anterior «la importación NO escribe `origin`»: el caso «`origin` válido se muestra pero NO se escribe» pasa a «se muestra Y se escribe» (`expect(entry.origin).toBe("extracted")`); la del ida-y-vuelta se queda en «sin `origin` en origen, sin `origin` en destino» (comentario ajustado) y un cast de tipo pasa por `unknown`. Ninguna prueba de `SignatureComposer`/baúl tuvo que cambiar (el modo «Subir» no tenía pruebas de decodificación: jsdom no decodifica imágenes). `playwright.config.ts`: los dos specs nuevos entran en `CROSS_SPECS` (corren en `webkit-ipad`).

**Pruebas.**
- Vitest (jsdom + `fake-indexeddb`): 153 pruebas nuevas en 7 archivos: `inkImportModel.test.ts` (33), `backupModel.test.ts`, `backupFlow.test.ts` (26: contraseña, nombre de archivo, exportar, compartir, ida y vuelta con y sin contraseña, fusión, límites atómicos, `PackageError` → mensaje, corpus hostil), `signVault.origin.test.ts` (12: `isStoredEntry`/migración con y sin `origin`), `SignatureImportSheet.test.tsx` (34), `SignatureBackupSheet.test.tsx` (37, incluye el corpus de zips hostiles `__fixtures__/hostileCorpus.ts`), `SignatureUploadIntegration.test.tsx` (7). Suite completa con `F2_REAL_PDFS=1`: **449 archivos, 10 479 pruebas pasan, 3 omitidas** (antes 442 / 10 326), `tsc` y `eslint` 0 errores.
- Mutaciones: `scratchpad/u62/work/mutate.py` aplica 31 mutaciones a la lógica nueva (origen, límites, decisiones, contraseña, atomicidad, cancelación, nombre obligatorio…); **31 de 31 mueren** (dos sobrevivieron al primer intento: un chequeo de 4096 px redundante con `isValidVaultImage`, que se quitó, y el color del aviso de límites, que ahora se comprueba).
- E2E headless, build de producción con `CSP_SKIP_UPGRADE_INSECURE=1` (`sign-upload-backup.spec.ts`, `sign-upload-a11y.spec.ts`, bloque nuevo en `sign-wide-font.spec.ts`): imágenes sintéticas generadas en el test (`e2e/helpers/ink-images.ts`: JPG con fondo blanco y con sombra, PNG, SVG, hoja en blanco, 5 MP, > 10 MB). Chromium: 29 pasan; `webkit-ipad`: 28 pasan y 1 omitida (la de foco por teclado de Chromium). Cubren: subir → fondo transparente (≥ 70 % de píxeles transparentes, esquinas vacías, tinta azul conservada, `origin: "uploaded"`, ≤ 600 KB / ≤ 4096 px); usarla en «Solo yo» y en la ceremonia de 2 firmantes y, en el PDF descargado (hoja amarilla), ≤ 2 teselas blancas (frente a cientos con un recuadro) y tinta nueva (sin recuadro blanco); exportar con contraseña → borrar el baúl → importar = idénticas por hash; sin contraseña; fusión (1 nueva + 2 idénticas); paquetes dorados v1 (en claro y cifrado con `dorada-2026`); 10 zips hostiles del corpus (rechazo < 8 s, sin escribir); versión más nueva; `navigator.share` simulado con puntero táctil; errores (hoja en blanco, formato, > 10 MB); recorte a mano (asas ≥ 44 px, arrastre y teclado); foto de 5 MP sin tareas largas (Chromium: 0 ms de tarea larga, ≤ 85 ms entre fotogramas; WebKit: ≤ 41 ms entre fotogramas); axe-core (contraste, ARIA, etiquetas, nombres, roles, controles anidados…) con 0 violaciones en cada estado de las tres hojas × claro/oscuro × ES/EN × 1280/375; objetivos táctiles ≥ 44 px a 375 px; sin desbordes a 375/320 px con fuente ancha en las hojas nuevas.

**No verificado.** Safari real de iPad (solo el WebKit de Playwright con el perfil «iPad Pro 11»): la hoja de compartir del sistema, la cámara (`capture`), los HEIC reales y los gestos táctiles reales de las asas se probaron simulados o por código; Firefox (no arranca en este equipo); lectores de pantalla reales (solo el árbol de accesibilidad y axe); `Opción+Tab` de Safari de escritorio.
