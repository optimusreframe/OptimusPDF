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

---

## 11. Evidencia de documentos reales del usuario (2026-10-16) — SOLO MÉTRICAS, sin contenido ni datos de clientes

El usuario aportó 9 contratos en blanco y 3 ejemplos firmados con la herramienta (en `/Users/kong/.claude/uploads/<sesión>/`; NO se copian al repositorio ni a fixtures versionados; las pruebas con ellos son locales y opcionales vía `OPTIMUS_REAL_CONTRACTS_DIR`).

**Contratos en blanco (9)**: 3-9 páginas; carta (612×792) salvo uno de 458,9×594 pt; exportados desde Word, Acrobat, Canva y Corel; todos digitales con texto extraíble; NINGUNO tiene campos de formulario reales (6 traen un AcroForm vacío; las líneas de firma están dibujadas en el contenido). Consecuencia: la detección de campos no puede apoyarse en formularios; las PLANTILLAS son la solución. Hay tres contratos de la misma empresa con mucho texto común (remediación de moho 9 pág., mitigación 8 pág., prueba de moho 8 pág.): son el caso duro de falsos positivos de la huella (U2.1).

**Ejemplos firmados (3: Mitigación, Responsive PA, Mold Test)** — comparados contra su versión en blanco (posiciones normalizadas, 0..1):
- Todos terminan con UNA PÁGINA EXTRA respecto al original (la hoja de certificado SHA-256 que se eliminó por defecto en la Fase 0): confirma el dolor del usuario.
- **Iniciales en TODAS las páginas** del cuerpo, 2 imágenes por página (2 firmantes), en la esquina inferior derecha: x≈0,79-0,90, y≈0,80-0,91, tamaño ≈ 0,05-0,09 × 0,02-0,05. La posición varía ligeramente de una página a otra (el usuario las colocó a mano en cada una): **la plantilla debe ofrecer «mismo lugar en todas las páginas» para iniciales (con ajuste fino por página) — esto elimina la mayor parte del trabajo repetitivo.**
- **Páginas de firma** (p. ej. p4 y p8 de Mitigación y p4/p8 de Mold Test): 2-4 imágenes más (firma de cada firmante en columna izquierda x≈0,16-0,23 y otra en x≈0,40-0,55, y iniciales o fecha), a distintas alturas (y≈0,47-0,93).
- **Textos rellenados**: 4-10 campos en la primera página (datos del cliente: nombre, teléfono, dirección…) y 4-5 campos en cada página de firma (nombre bajo la firma, fecha…), columnas izquierda (x≈0,10-0,25) y derecha (x≈0,53-0,55).
Implicaciones: (1) U2.3 (modo plantilla) debe incluir «repetir iniciales en todas las páginas» y «aplicar a las páginas N..M»; (2) F3 (autollenado) tiene objetivos claros: los campos de la página 1 y los nombres/fechas bajo cada firma; (3) la pantalla «Revisar antes de descargar» debe contar iniciales por página (esperado: nº de páginas × nº de firmantes); (4) los tests de aceptación de F2 usan estas posiciones como verdad de terreno (solo estructura, local).

## 12. Decisiones del usuario (2026-10-16, tras ver los ejemplos): automapeo y disposición de iniciales

1. **Dos firmantes**: las iniciales van una al lado de la otra, primero el firmante 1 y luego el firmante 2, ambas sobre la línea que el documento dispone para las iniciales. Es la disposición por defecto de la variante de 2 firmantes (ajustable).
2. **Mapeo manual Y automapeo**: no solo plantillas guardadas por documento; la app debe ofrecer también **autoidentificar** los campos en un documento DIFERENTE (nuevo o desconocido): detectar líneas/casillas de iniciales, líneas de firma, fechas y campos de texto, proponer su colocación según el nº de firmantes y dejar que el usuario revise/acepte y guarde el resultado como plantilla. Nueva unidad **U2.8 «Automapeo»** (librería `src/lib/pdf/autoMap*.ts` + evaluación contra la verdad de terreno de los documentos reales + integración en U2.3/U2.4). Criterio: precisión primero (el antecedente «cientos de campos» de la Wave 6 no debe repetirse): alta confianza → se propone ya colocado con aviso deshacible; media → «Revisar»; baja → se ignora.

---

### U1.1 entregada: modelo de asignación «Firma A / Firma B», copias y persistencia (solo lógica pura, 2026-10-15)

**Qué es.** La capa de presentación de los bloques que pide la Fase 1 (§3) y el soporte de **copias** por documento, sin interfaz: el núcleo (`SignerBlock`, `ensureBlocks`, `setBlockScope`, `resolveBlock`) no cambia. La interfaz (`AssignmentMatrix.tsx`, U1.2), la ceremonia por grupos y «Revisar antes de descargar» (U1.3) y los textos (U1.4) se apoyan en esta API. Nada de lo nuevo se ve todavía en pantalla, salvo que un documento con `copies > 1` ya sale en un ZIP si algo lo fija.

**Modelo.** Una **tabla** documentos × firmantes (`AssignmentMatrix { docIds, signerIds, cells[fila][columna] }`). Cada celda es un **grupo** (`"A"`, `"B"`... o `null` = no firma ahí). Las letras son **locales a cada firmante** (la «A» de Ana no es la «A» de Luis) y **canónicas**: se reparten por columna en orden de aparición de arriba abajo, así que unos bloques dan siempre la misma tabla y no depende de sus ids. Un grupo = un bloque. El caso del usuario (4 documentos, un firmante, A,A,B,B) = 2 bloques `[d1,d2]` y `[d3,d4]` = 2 trazos en un único turno.

**`src/app/sign-pdf/assignment.ts`** (puro, sin textos de interfaz):
- `groupsMatrix(blocks, docs, signers?) → AssignmentMatrix` y `blocksFromMatrix(matrix, signers, { previous?, mint? }) → SignerBlock[]`. Ida y vuelta **sin pérdida**: con los bloques de antes en `previous` salen **idénticos** (mismos objetos: ids, trazos, sellos y `auto`); sin ellos, la misma forma con ids nuevos y sin trazos. `docs` acepta ids o `{ id }`; sin `signers`, las columnas salen de los bloques. Un documento reclamado por dos bloques del mismo firmante (dato corrupto) es del primero, como `resolveBlock`. Salida compatible con `ensureBlocks`/`normalizeBlocks` (sin solapes, sin bloques vacíos, documentos en el orden de la cola).
- `applyMatrix(previous, matrix, signers, mint?) → { blocks, impacts }`: lo mismo con la **lista de trazos afectados** (`StrokeImpact { signerId, blockId, types, outcome: "lost" | "needsConfirm", before, after, docsToConfirm }`) para que la interfaz confirme. Reglas (las de `docSet.ts`): (1) un grupo con **exactamente** los documentos de un bloque anterior es ese bloque, intacto; (2) si no, hereda el bloque del mismo firmante con el que **más documentos comparte** (empate: el que tiene trazos, luego el primero): conserva id y trazos y **solo los sellos de los documentos que sigue cubriendo** (los nuevos no traen sello: `blockStampsValid` es falso hasta confirmar = `needsConfirm`; encoger no avisa de nada); (3) a un heredero sin firma o iniciales se le ceden los del primer bloque descartado que los tenga (como `switchMode`), una sola vez; (4) un grupo sin documentos en común con nada es **nuevo y sin trazos** (un atajo nunca «copia» una firma a otro grupo: dos firmas distintas no pueden parecer la misma); (5) los bloques que nadie hereda se descartan y sus trazos salen como `lost` (la interfaz puede ofrecer «Deshacer» volviendo a los bloques de antes). `auto` solo queda encendido con **un** grupo que cubre todos los documentos (los nuevos se suman solos, como «Mismas»). Un firmante de `signers` que no está en la tabla conserva sus bloques; uno que ya no está en `signers` los pierde (como `ensureBlocks`).
- Atajos puros (devuelven tabla canónica; `keepEmpty` respeta los «no firma»): `allSameGroup` («Una firma para todos»), `oneGroupPerDocument`, `byGroups(matrix, [[d1,d2],[d3,d4]], { signerIds? })`. Ayudas para la tabla: `setCell(matrix, docId, signerId, group | null)`, `nextGroup`, `groupsOf`, `canonicalMatrix`, `matrixEqual`, `blockGroups(blocks, docs, signers?) → { [blockId]: "A" }`, `groupIdAt/groupIndexOf`.
- `summarize(matrix, signers, docs, copies, { lang?, groupNames? }) → AssignmentSummary`: por firmante `{ name, documentCount, groupCount, groups: [{ group, label: "Firma A" | "Signature A" | nombre propio, docIds, docNames }] }`, más `documentCount`, `fileCount` (suma de copias), `deliversZip`, `exceedsFileLimit`, `unassignedDocIds` y `copies` (documentos con más de una). Solo **datos**: la frase («Ana firma 4 documentos con 2 firmas: A (Contrato, Anexo) y B (...). Se descargarán 8 archivos») la compone la interfaz. `groupDisplayName(group, lang, groupNames?)` es la única fuente de «Firma A»/«Signature A».

**`src/app/sign-pdf/assignmentValidation.ts`**: `validateAssignment(session, { strict? }) → Issue[]` con `Issue { kind, severity: "blocking" | "warning", messageKey: "assignment.issue.<kind>", signerId?, docId?, blockId?, group?, params }` (ids, no nombres; `hasBlockingIssue`, `ISSUE_KINDS`, `messageKeyOf`). **Los textos ES/EN no están** (`strings.ts` no se ha tocado): los pone U1.4 con estas claves.

| `kind` | Severidad | Qué es |
|---|---|---|
| `slotWithoutSigner` | bloqueante | hueco de firma de un firmante sin grupo que lo cubra (= `coverageIssues`) |
| `signerWithoutSlot` | aviso (bloqueante con `strict`) | el firmante tiene grupo en un documento donde no tiene hueco (en «Mismas» ocurre siempre: por eso no bloquea por defecto) |
| `signerWithoutDocuments` | aviso | firmante sin ningún documento |
| `documentWithoutSigner` | bloqueante si el documento está vacío; aviso si tiene huecos, campos rellenos o ediciones | documento que nadie firma |
| `requiredFieldEmpty` (`params.count`) | aviso (bloqueante con `strict`) | campos de texto sin rellenar (hoy el producto no los bloquea; las sugerencias sin tocar no cuentan) |
| `groupWithoutStroke` (`params.types`, `params.docIds`) | bloqueante | grupo al que le falta la firma y/o las iniciales **vigentes** (sello válido); no se acusa a nadie mientras falte la huella de algún documento |
| `overlappingGroups` | bloqueante | dos grupos del mismo firmante reclaman un documento (dato corrupto) |
| `tooManyFiles` (`params.count`, `params.max`) | bloqueante | más de 50 archivos contando copias; también en «Solo yo» |

**Copias.** `DocState.copies?: number` (1..5; ausente = 1; se escribe **solo** si vale > 1, así un documento sin copias tiene la forma de siempre). `copiesOf(state)`, `setDocCopies(docs, docId, n)` (`docSet.ts`). Constantes y utilidades en `src/lib/pdf/signCopies.ts` (`MAX_COPIES = 5`, `MAX_OUTPUT_FILES = 50` = 10 documentos × 5, `normalizeCopies`, `isValidCopies`, `outputFileCount`; reexportadas por `signLimits.ts`). `signBatch` (`src/lib/pdf/signBatch.ts`): `document.copies` escribe el **mismo PDF firmado** N veces — `sign` se llama una vez por documento, no N —; nombres `Ana y Luis - Contrato-firmado.pdf`, `... (copia 2).pdf` (en inglés `(copy 2)`) con `copyFilename` (`signOutputNames.ts`; respeta 120 caracteres / 200 bytes recortando el cuerpo y nunca el sufijo) y `uniqueNames` (la misma unicidad sin distinguir mayúsculas que ya usaba el ZIP; `uniqueZipName` de `entryNames.ts` no se usa porque no limita longitudes); orden estable: por documento, el original y luego sus copias. Con copias el resultado es siempre ZIP (aunque sea un solo documento). Límites **antes de firmar nada**: copias fuera de 1..5 (`tooLarge` si > 5, `unknown` si 0/negativa/decimal/NaN) y `limits.maxFiles` (por defecto 100 = `MAX_ZIP_FILES`; la herramienta pasa 50) → `PdfError("tooLarge", "sign:tooManyFiles N > M")`. El nombre del ZIP sigue contando documentos (`Firmados - 4 documentos.zip` con 8 archivos). `result.report.ok` sigue siendo uno por documento; `result.files` lista todos los archivos (`{ documentId, filename, copy }`). **Registro `.json` (U0.5)**: una fila por **archivo** del ZIP (mismo hash que el original) y las copias llevan `copyOf: "<archivo original>"` (campo opcional nuevo de `SigningRecordEntry`; ausente en originales y en registros anteriores). `SignToolClient.tsx`: solo pasa `copies` y `maxFiles` a `signBatch`, exporta `copies` con la configuración y manda un documento suelto con copias por la entrega conjunta (no hay forma de fijar `copies` en pantalla hasta U1.2/U1.3).

**Persistencia.** `sessionDraft.ts`: `restoreSession` conserva `copies` (solo > 1; un valor raro se lleva a 1..5, 2.7 → 2, 0/negativo/texto → ausente) y **también en un documento cuya huella cambió** (es una elección de entrega, no contenido); `snapshotSession` ya las guarda con `docStates`. Los bloques canónicos viajan en `blocks` como siempre: la tabla se deriva (`groupsMatrix`) y no se guarda aparte. Borradores anteriores sin `copies` se restauran **igual** (`__fixtures__/sessionDraft.*.json`, generados con el código anterior). `signConfig.ts` **v3** = v2 + `documents[].copies` (obligatoria, 1..5) + `blocks[].group` (letra, `^[A-Z]{1,3}$`) y `blocks[].groupName` (≤ 60 caracteres, opcional); `isSignConfigManifestV3`, `CONFIG_VERSION_GROUPS = 3`. Se **lee** v1, v2 y v3; una v2 con la versión cambiada a 3 (sin `copies`) se rechaza, igual que una versión 4. Se **escribe v3 solo cuando hay algo que la v1/v2 no sabe decir**: alguna copia > 1 (aunque sea con un solo documento: `documentos/01.pdf`) o algún nombre de grupo (`ExportConfigSetManifest.groupNames`, por id de bloque); si no, el formato de siempre (v1 con un documento, v2 con varios), que las versiones anteriores de la herramienta siguen abriendo y que mantiene verdes los tests existentes. `importSignConfigSet` devuelve `version: 1 | 2 | 3` y `copies` solo en los documentos con más de una (v1/v2 se importan **idénticos** a antes: `__fixtures__/config.v1.zip`, `config.v2.zip` + `*.expected.json`). `configSession.ts` pasa `copies` a `DocState`. Para el futuro Package (F4): el manifiesto v3 lleva todo lo necesario (alcance por grupo, copias y nombres); los trazos nunca viajan en la configuración.

**Decisiones que conviene saber.** (1) `applyMatrix` no «copia» un trazo a un grupo nuevo aunque el original se divida (A,A,A,A → A,A,B,B deja B sin firma): es lo contrario de `switchMode` «Mismas → Distintas», a propósito, porque aquí el usuario pide una firma DISTINTA. (2) El umbral de «campo de texto vacío» y «firmante sin hueco» como bloqueantes se deja a `strict` porque hoy el producto los trata como avisos. (3) Las letras son por firmante: si la interfaz quiere un nombre común («Firma A» para todos) usa `groupDisplayName`. (4) `uniqueNames` en vez de `uniqueZipName` (ver arriba).

**Pruebas.** 7 archivos nuevos y 143 pruebas nuevas (`assignment.test.ts` 59, `assignmentValidation.test.ts` 16, `signCopies.test.ts` 10, `docSet.copies.test.ts` 7, `signBatch.copies.test.ts` 16, `sessionDraft.copies.test.ts` 11, `signConfig.v3.test.ts` 24): propiedades con generador propio de semilla fija (`mulberry32`; el proyecto no trae fast-check) con 1-10 documentos × 1-2 firmantes × grupos A..D —300 casos de tabla→bloques→tabla, 300 de bloques con trazos→tabla→bloques idénticos y 200 con bloques reales de `ensureBlocks`/`setBlockScope`/`addBlock`—, el caso del usuario con uno y con dos firmantes, trazos y sellos al cambiar el alcance, atajos, `summarize` (4 documentos × 2 copias = 8 archivos), ZIP con copias (nombres únicos, orden, una sola firma por documento, límites antes de firmar, registro con hash recalculable), migración con archivos dorados v1/v2 de borrador y de configuración (generados **antes** de tocar el código) y validaciones. Los tests de `docSet`, `blockModel`, `sessionDraft`, `signConfig` y `signBatch` existentes siguen verdes **sin cambios**. Suite completa con `F2_REAL_PDFS=1`: **458 archivos, 10 699 pruebas pasan, 3 omitidas** (antes 451 / 10 556); `tsc` y `eslint` sin errores. Mutaciones (`scratchpad/u11/work/mutate.py`, 82 sobre la lógica nueva: tabla, atajos, trazos, validaciones, ZIP con copias, límites, nombres, config v3, borradores): **82 de 82 mueren**. En la primera pasada sobrevivieron 5 de 83: cuatro (comparación de conjuntos con documentos repetidos, cesión de un mismo trazo a varios herederos, aviso de crecimiento en un bloque sin trazos, límite exacto de 50 archivos) recibieron prueba; la quinta era código redundante de `byGroups` (las etiquetas nuevas nunca chocan con las canónicas) y se eliminó. E2E (Chromium, build de producción con `CI=1`, puerto 3941): `sign-multi`, `sign-ceremony-turns`, `sign-recovery`, `sign-privacy`, `sign-record`, `recent-continue`: **119 pasan, 0 reintentos**.

**No verificado.** Nada de interfaz (no existe aún); el E2E «4 documentos, 2 firmantes, A,A,B,B, 2 copias → 8 PDF con la firma correcta» de la aceptación de la Fase 1 es de U1.3 (aquí se prueba el ZIP con PDF de prueba y el motor real de firma no se ha tocado); el tope de 500 MB de **salida** multiplicado por las copias (`outputBytes × copies`) está implementado pero no tiene prueba (haría falta generar > 500 MB); `webkit-ipad` y Safari real no se han corrido (no hay cambio de interfaz).


---

### U2.1 entregada: biblioteca de documentos (almacén en IndexedDB y huella robusta), SIN interfaz (2026-10-15)

Todo en `src/lib/docLibrary/` (sin dependencias nuevas: usa `pdfjs-dist`, `@cantoo/pdf-lib` y `fake-indexeddb`/`@napi-rs/canvas` de pruebas, que ya estaban). La interfaz (U2.3-U2.5) solo tiene que llamar a estas funciones. Imports RELATIVOS dentro de la carpeta (no `@/…`): así se empaqueta igual con Vite para la E2E.

**Archivos.** `types.ts` (tipos, `LIBRARY_LIMITS`, `MATCH_THRESHOLDS`, `LibraryError`, `FingerprintError`) · `fingerprintCore.ts` (puro: normalización, MinHash, dHash) · `match.ts` (puro: comparar y elegir) · `fingerprintEngine.ts` (pdf.js → huella; recibe el entorno por parámetro) · `fingerprint.ts` (API pública: worker con respaldo al hilo principal) · `fingerprint.worker.ts` + `fingerprintProtocol.ts` · `schema.ts` (validación estricta) · `store.ts` (IndexedDB) · `persist.ts` (datos para el Package) · `testing/` (PDF sintéticos, entorno Node; solo pruebas).

**Huella — `computeFingerprint(file | bytes | ArrayBuffer, { signal?, onProgress?(done,total), worker?: "auto"|"never"|"always", maxPages? }) → Promise<Fingerprint>`.**
```
Fingerprint { version: 1, exact: sha256(bytes) hex, pageCount, pageSizes: {width,height}[] (pt, 2 decimales, con la rotación aplicada),
              pages: { textHash: sha256(texto normalizado) | "", minhash: number[128] | [], dhash?: 16 hex }[],
              partial?: "tooManyPages" }          // más de 200 páginas: solo exact + pageCount (pages/pageSizes vacíos)
```
- Texto de cada página con pdf.js (`getTextContent`), normalizado: NFKC, minúsculas, sin invisibles, **sin fechas ni horas** (numéricas y escritas en es/en), **sin folios/códigos/importes** (todo token con cifras que no sea un número de 1 a 3 cifras: «00012345», «CLM-2026-77», «$1,500.00», «2026»), sin puntuación y con espacios colapsados. Los números cortos se CONSERVAN («30 días», «cláusula 4.2»): cambiarlos cambia el contrato. Página con menos de 16 letras/cifras útiles = «sin texto» → se compara por imagen.
- MinHash: 128 permutaciones deterministas (semillas fijas, splitmix32 + finalizador de Murmur3) de trigramas de palabras (≤ 20 000 palabras por página). Error típico del Jaccard estimado ≈ 0,03-0,04 (medido: error medio < 0,035, peor < 0,14 en 200 pares aleatorios). Valores fijados en una prueba: si cambian, hay que subir `FINGERPRINT_VERSION`.
- dHash (solo páginas sin texto): la página se rasteriza (lado mayor 128 px, fondo blanco), se reduce por áreas a 32×32 en gris y luego a 9×8; 64 bits = «el píxel es más claro que su vecino de la derecha por más de 0,5 niveles de gris» (el margen hace estables las páginas lisas).
- Dónde corre: por defecto en un **Web Worker** (`fingerprint.worker.ts`: pdf.js corre ahí dentro sin DOM, con `OffscreenCanvas`), con respaldo AUTOMÁTICO al hilo principal (cediendo el control tras cada página) si el worker no arranca. Mismos números por ambos caminos y que en Node (comprobado). `worker: "always"` falla con `unavailable` en vez de caer al hilo principal. Se cancela con `AbortSignal` (el worker se termina; rechaza `aborted`). Sin red.
- Errores (`FingerprintError.code`, mensaje en español): `empty`, `corrupt` (dañado, truncado o no es PDF), `encrypted` (pide contraseña de apertura; un PDF solo con restricciones sí se huella), `aborted`, `unavailable` (no se pudo cargar pdf.js). Una página ilegible NO tumba el cálculo: queda sin texto ni dHash y no coincide con nada.
- Ganchos: `setFingerprintWorkerFactory(f|null)` y `setFingerprintPdfjsLoader(f|null)` (la app puede pasarle su `getPdfJs` de `core.ts`).

**Comparar — `compareFingerprints(doc, template) → MatchResult`; `findBestMatch(fp, candidates: {id, fingerprint, updatedAt}[]) → MatchResult | null`.** `doc` es el documento recién cargado; todo el resultado va en páginas de la PLANTILLA.
```
MatchResult { level: "exact"|"match"|"similar"|"none", similarity: 0..1, percent: 0..100, reason?: "partial"|"empty"|"version"|"pages",
              basis?: "text"|"image"|"mixed",
              pageMatches: { templatePage, documentPage|null, similarity, level, kind: "text"|"image"|"none", identical, review }[],
              mappedPages: (number|null)[]   // por página de la plantilla: a qué página del documento se aplica
              reviewPages: number[]          // páginas de la plantilla que NO deben aplicarse solas
              candidateId?, ambiguous?, alternatives? }   // solo de findBestMatch
```
| Umbral | Valor | Efecto |
|---|---|---|
| Mismos bytes (SHA-256) | — | `exact`, 100 %, mapa identidad |
| Página «coincide» | Jaccard ≥ 0,90 (dHash ≤ 10 bits) | `review: false` |
| Página «se parece» | 0,70-0,90 (dHash 11-20 bits) | se empareja con `review: true` |
| Página sin correspondencia | < 0,70 (dHash > 20), otro tamaño (> ±1 pt en ancho o alto) o sin texto/imagen comparable | `documentPage: null`, `similarity: 0`, `review: true` |
| Documento «Coincide» (`match`) | mismo nº de páginas y TODAS ≥ 0,90, ninguna comparada por imagen | se puede aplicar sola con aviso deshacible |
| Documento «Parece» (`similar`) | media de similitudes (entre el MAYOR nº de páginas) ≥ **0,75** (`documentSimilar`); con distinto nº de páginas nunca pasa de aquí; «Parece» nunca dice 100 % (tope 99) | la interfaz pregunta («Parece la plantilla X (85 %)») |
| Documento `none` | media < 0,75, huella parcial, sin páginas o versión de algoritmo distinta | sin plantilla |

Con el mismo nº de páginas se emparejan por posición; con distinto nº, por un alineamiento que conserva el orden (una página añadida/quitada no desplaza el resto). `findBestMatch`: orden por nivel, similitud, `updatedAt` más reciente e id; `ambiguous: true` (y `alternatives`) si otro candidato del mismo nivel queda a menos de 0,02 («varias plantillas con la misma huella → la más reciente»).

**Por qué `documentSimilar` es 0,75 y no 0,70 (evidencia con contratos reales).** Con 9 contratos reales en blanco medidos SOLO en local (no están en el repositorio ni en ningún informe; ver `realContracts.test.ts`) el par más cercano entre contratos DISTINTOS de una misma empresa fue 9 págs. contra 8 págs. con **6 páginas idénticas** (cubierta, definiciones y firma): media 0,667 (67 %); los otros pares de esa familia dieron 0,62-0,63. Con 0,70 el margen era de 3 puntos; con 0,75 es de 8. A cambio, un documento de ≤ 4 páginas con UNA página cambiada del todo queda en `none` (3 págs.: 0,667; 4 págs.: justo 0,75 solo si las demás son idénticas) aunque `reviewPages` ya señala la página: es un compromiso explícito (preferir no ofrecer una plantilla a ofrecer la equivocada). Una página aislada ≥ 0,90 entre contratos distintos SÍ ocurre (aviso/firma comunes: máx. 0,96), por eso «Coincide» exige todas.

**Escaneados — límite conocido.** El dHash de 64 bits a 32×32 reconoce el MISMO escaneado con ruido y 2 px de desplazamiento (medido ≤ 7 bits; umbral 10), pero **no distingue páginas de texto parecidas**: con 20 escaneados sintéticos distintos de 3 páginas, el 85,8 % de los pares de páginas quedan a ≤ 10 bits y los 190 pares de documentos salen «Parece». Por eso una página comparada por imagen impide `match` (nunca se aplica sola), `basis` dice `image`/`mixed` y la interfaz debería tratarlo como sugerencia débil (o no sugerir) y preferir `exact`. Mejorarlo exige OCR o un descriptor mayor y escaneados reales (no medidos: no hay).

**Almacén — `store.ts`** (IndexedDB `optimuspdf-doc-library` v1; almacenes `documents`, `blobs` por `documentId`, `meta`).
- Lecturas (nunca lanzan): `listDocuments() → { available, documents (más reciente primero), skipped: {id, reason:"invalid"}[] }`, `getDocument(id)`, `getDocumentBytes(id)`, `libraryStatus() → {available:true} | {available:false, reason:"noIndexedDB"|"openFailed"}`, `estimateUsage()`, `getLibraryMeta() → { schema, lastBackupAt, persistence }`. Sin IndexedDB (p. ej. Safari en modo privado antiguo) todo degrada a «vacío + `available:false`».
- Escrituras (lanzan `LibraryError.code`: `quota` | `tooBig` | `full` (`detail`: `count`|`total`) | `unavailable` | `notFound` | `conflict` | `invalid` | `failed`; el mensaje ES el código, sin PII): `putDocument(input, bytes?, { updatedAt?, now? })`, `updateDocument(id, { name?, docType?, templateIds? }, { expectedRev? })`, `renameDocument`, `replaceDocumentBytes(id, bytes, { expectedRev?, signal?, fileName? })` (calcula la huella con `computeFingerprint` ANTES de abrir la transacción y reemplaza huella, páginas y tamaños; conserva nombre, tipo y plantillas), `deleteDocument(id, { expectedRev? })`, `clearLibrary()`, `markBackup(date?)`, `requestPersistence() → { granted, supported }` (nunca lanza; llama a `navigator.storage.persist()` si existe, no la repite si ya es persistente y lo recuerda en `meta` para Ajustes).
- Cada escritura es UNA transacción (entrada + copia): si falla la copia por cuota no queda la entrada. **Concurrencia optimista**: cada entrada lleva `rev` (sube en cada escritura); `putDocument` con `expectedRev` distinto de lo guardado (o 0 sobre un id que ya existe, o ≥ 1 sobre uno borrado) → `conflict` y NO se pisa nada. Dos altas simultáneas del mismo id: una gana. Los avisos a otras pestañas van por `BroadcastChannel("optimuspdf-doc-library")` (o el evento `storage` sin él): `subscribeToLibrary(listener) → unsubscribe`.
- Límites: **50 documentos**, **100 MiB** por documento (`tooBig`, comprobado antes de abrir la base), **400 MiB** en total (`full`). Validación estricta al leer (`schema.ts`): una entrada que no cumple el esquema (campos, hashes hex, 128 valores de MinHash, páginas = tamaños, fechas ISO, nombres sin controles ni marcas bidi, ids `[A-Za-z0-9_-]{1,64}`) se ignora y se cuenta en `skipped`; la copia con longitud que no cuadra se trata como ausente.

**Datos para el Package — `persist.ts`** (sin zip; el contenedor es de U4.5): `serializeLibrary(entries) → { schemaVersion: 1, documents[] }` (sin `rev`, MinHash en base64: 684 caracteres en vez de ~1 300) y `serializeLibraryJson`; `deserializeLibrary(texto | objeto) → { ok:true, documents, warnings } | { ok:false, reason: "tooLarge"|"invalidJson"|"invalidFormat"|"newerVersion" }` (nunca lanza; ≤ 8 MiB de texto, ≤ 50 documentos, ids únicos; un documento inválido se omite con aviso y el resto sigue); `toDocumentInput(entry)` para restaurar con `putDocument(input, bytes, { updatedAt })` conservando fechas. Las copias de PDF viajan como archivos aparte del paquete (`byteLength` > 0 dice que debería haber una).

**Pruebas.**
- Vitest (Node; 6 archivos nuevos en `src/lib/docLibrary/`, 179 pruebas): `fingerprintCore.test.ts` (normalización, MinHash fijado y estimación, dHash), `match.test.ts` (cada umbral en su borde con huellas armadas a mano), `fingerprint.engine.test.ts` (pdf.js real sobre PDF sintéticos de pdf-lib), `store.test.ts` (`fake-indexeddb`: CRUD, límites reales de 50/100 MiB/400 MiB, cuota simulada con atomicidad, dos «pestañas», corrupción, sin IndexedDB, avisos), `persist.test.ts`, `realContracts.test.ts` (opcional, ver abajo). Suite completa con `F2_REAL_PDFS=1`: 457 archivos (456 pasan, 1 omitido), 10 734 pruebas pasan (antes 451 / 10 556).
- Contratos SINTÉTICOS (nada real): re-guardado, con y sin flujos de objetos, metadatos, objetos reordenados, flujos descomprimidos, otra fuente (todo «Coincide», todas las páginas con el mismo texto); otra fecha/folio/póliza («Coincide»); una página cambiada (6 págs.: «Parece», `reviewPages` = solo ella, resto emparejado); contrato distinto (`none`); mismo patrón que dos reales de 9 y 8 págs. con 6 comunes (`none`, 66 %); cláusula entera cambiada (no «Coincide»); cifrado/dañado/vacío (errores claros); 201 págs. (huella parcial) y 200 (completa); escaneados con ruido y 2 px (≤ 7 bits); página ilegible. Corpus de **20 contratos distintos: 0 de 190 pares con alguna página ≥ 0,90** (máx. 0,000) y 0 pares «Parece»; **20 re-exportaciones: 20/20 «Coincide»**, peor página 1,000. **Límite conocido** (probado a propósito): una frase suelta añadida a una página (≈ 5 % del texto) sigue siendo «Coincide» con esa página en 0,9x.
- Contratos REALES (solo medida local; `OPTIMUS_REAL_CONTRACTS_DIR=<carpeta con PDF> npx vitest run --project engines src/lib/docLibrary/realContracts.test.ts`, se salta sin la variable): 9 PDF digitales (3-9 págs., 0,17-3,48 MB, Word/Acrobat/PDFMaker/Canva/Corel, uno de 458,9×594 pt). Re-guardado, con flujos de objetos y reordenado: **27/27 «Coincide» con todas las páginas en 1,000**. Matriz 9×9 de documentos distintos: **72/72 `none`**; los únicos pares con algo en común: 9↔8 págs. (6 páginas idénticas) 67 %, 8↔8 y 9↔8 págs. 62-63 % (a lo sumo 1 página ≥ 0,90, máx. 0,96) y un par con una sola página casi igual (11 %, máx. 0,99). Cambiar ~30 % del texto de una página (cláusula): `reviewPages` = solo esa en los 9. Tiempo por documento en Node (pdf.js legacy): 14-129 ms (el primero incluye la carga de pdf.js), +1 a +46 MB de RSS (el de 3,48 MB, 109 ms y +38 MB; el de 2,66 MB, 104 ms y +20 MB).
- E2E (`e2e/specs/doc-fingerprint.spec.ts`, 14 pruebas; build de producción con `CSP_SKIP_UPGRADE_INSECURE=1`, headless): Chromium y `webkit-ipad` 14/14. Worker y hilo principal dan la MISMA huella y la misma que Node; auto→respaldo; errores; tope de 200; cancelar; guardar → recargar → reconocer el re-exportado; dos pestañas (`conflict` + aviso por `BroadcastChannel`); `tooBig`. Rendimiento (ms, máquina de desarrollo): Chromium 6 págs. 67 (worker) / 53 (principal), 100 págs. 192 / 174, 6 págs. escaneadas 143 / 97, mayor hueco del hilo principal ≤ 2 ms, 0 tareas largas; WebKit iPad 6 págs. 70 / 77, 100 págs. 324 / 332, escaneadas 279 / 259, hueco ≤ 3 ms (exigido: 6 págs. < 400 ms, 100 págs. < 5 s, sin tareas > 100 ms). Además se verificó (sin dejarlo en el repositorio) que el worker EMPAQUETADO por Next/Turbopack en la build de producción funciona en Chromium y WebKit iPad, sin errores de consola.
- Mutaciones: `scratchpad/u21/mutate.py` aplica 69 mutaciones (umbrales, normalización, MinHash, dHash, mapeo y alineamiento, ambigüedad, límites, `rev`, atomicidad, validación, base64, esquema): **68 mueren**; sobrevive 1 equivalente (quitar el relleno blanco del lienzo del dHash: la composición del alfa sobre blanco da lo mismo).

**No verificado.** Safari real de iPad (solo el WebKit de Playwright); Firefox; escaneados reales (solo sintéticos: el dHash es débil, ver arriba); PDF muy grandes (> 200 págs. solo huella parcial; 100 MiB no se probó con pdf.js real); IndexedDB con cuota real agotada (simulada); memoria máxima en un iPad (solo RSS en Node); `navigator.storage.persist()` real (solo simulado: `supported` se comprobó como booleano en el navegador); que la interfaz (U2.3-U2.5) use los umbrales como aquí se describen. Cambio fuera de la carpeta: `playwright.config.ts` (`doc-fingerprint` en `CROSS_SPECS`, para que corra en `webkit-ipad`).


---

### U2.8 entregada: Automapeo de campos en un documento desconocido (librería + evaluación, sin interfaz; 2026-10-16)

**Qué es.** `autoMapDocument(pdf, { signers: 1 | 2, locale?: "es" | "en" }, signal?)` identifica, en un PDF que la app no conoce, las líneas de **iniciales**, de **firma**, de **fecha** y los campos de **texto** con etiqueta clara, y los propone ya colocados por firmante. Sin interfaz y sin IA: cada propuesta lleva `reason` (por qué), `source` (`label` | `geometry` | `repetition`), `confidence` 0-1 y `tier` (`high` | `review` | `ignore`). La integración en U2.3/U2.4 (aviso deshacible para `high`, «Revisar» para `review`, guardar como plantilla) queda pendiente: debe llamar a `autoMapFile(file, { signers })`.

**API** (`src/lib/pdf/autoMap.ts`, tipos en `autoMapTypes.ts`):

| Pieza | Para qué |
|---|---|
| `autoMapDocument(pdf: PDFDocumentProxy, options, signal?) → AutoMapResult` | Núcleo. Corre en Node y en el navegador; recibe un documento de pdf.js ya abierto. `options`: `signers`, `locale`, `ops` (tabla `OPS`; sin ella se carga con `getPdfJs()`), `includeIgnored`, `rasterizer`, `maxPages` (200), `onProgress`, `yieldEveryMs` (30). Cancelable (`AbortError`). |
| `autoMapFile(file, { signers, … }, signal?)` (`autoMapFile.ts`) | Puerta para la interfaz: abre con pdf.js, mapea, cierra siempre; incluye el rasterizador por defecto de páginas escaneadas (render a 1000 px). Solo navegador. |
| `AutoField { id, pageIndex, rect, type: signature\|initials\|date\|text, signerIndex?: 0\|1, label?, confidence, tier, reason, source }` | `rect` normalizado 0..1 sobre la VISTA (origen arriba-izquierda, con `/Rotate` ya aplicado), igual que `SignatureField.rect`. `signerIndex` ausente = campo que no es de un firmante (firma de la otra parte, fecha o texto sin firmante claro). |
| `AutoMapResult { fields, pages: [{ pageIndex, hasInitialsLine, signatureLines, scanned? }], confidenceSummary: { high, review, ignore, byType, meanHighConfidence, maxPerPage }, warnings }` | `warnings` con `code` estable (`page-skipped`, `page-too-complex`, `scanned-page`, `page-field-cap`, `document-field-cap`, `too-many-pages`, `no-fields`) y mensaje ES/EN. Los `ignore` solo se devuelven con `includeIgnored`. |

**Archivos** (todos nuevos; `detectSlots.ts`/`detectFields.ts` NO se modificaron): `autoMapTypes.ts`, `autoMapText.ts` (diccionario ES/EN, roles, pistas de firmante), `autoMapCollect.ts` (lectura de pdf.js), `autoMapPage.ts` (análisis de una página, puro), `autoMapLayout.ts` (colocación), `autoMapRepeat.ts` (repetición entre páginas), `autoMapRaster.ts` (escaneados), `autoMap.ts` (orquestación y política), `autoMapFile.ts`; en `testing/`: `autoMapGroundTruth.ts`, `autoMapEval.ts`, `autoMapSynthetic.ts`, `autoMapFixtures.ts`, `autoMapHarness.ts`; pruebas `autoMap*.test.ts`; `e2e/specs/automap.spec.ts` (+ `e2e/helpers/automap-entry.ts`); `scripts/automap-mutate.py`. **Reutiliza** de W6: `underscoreSegments`, `mergeDashes`, `findFillSlots` (campos de texto con etiqueta, bajo el mismo tope conservador), `REFERENCE_UNIT_PT`/`SLOT_MAX_THICKNESS_PT` y `toLuminance` (raster). **No reutiliza** `collectPageGeometry` porque no aplica la matriz propia de los XObject de formulario, no separa los subtrazos de un mismo `constructPath` (Word y Acrobat dibujan varias rayas en una ruta), no recoge imágenes y no gira con la página; `autoMapCollect.ts` lo hace aparte (detalle probado).

**Señales.**
1. *Texto* (pdf.js, con posiciones): frases por fila (corte en huecos > 1,4 em y en las hileras de guiones bajos) y palabras clave ES/EN con `:`, paréntesis o subrayados: firma (`signature`, `sign here`, `firma`, `firma del cliente`…), iniciales (`initials`, `(INITIAL)`, `iniciales`, `please initial`, `init.`), fecha (`date`, `dated`, `fecha`, `date signed`), nombre (`print name`, `nombre`), teléfono, dirección, correo, reclamo, póliza, aseguradora. La prosa no cuenta: la palabra clave debe ir entre paréntesis o con puntuación, o la frase debe tener ≤ 6 palabras (≤ 14 si la etiqueta cierra la frase); `Date of Loss`/`Fecha de pérdida` son datos, no la fecha de firma. Rol (cliente: client, insured, policyholder, owner, asegurado…; la otra parte: adjuster, representative, contractor, attorney…) y pista de firmante (`(1)`, `Client 2`, `Firmante 2`, `Co-insured`) se leen solo del tramo de la propia etiqueta.
2. *Geometría vectorial*: rayas finas (trazos y rellenos ≤ 2,4 pt, ≥ 2,6 em; ≤ 62 % del ancho de página), hileras de guiones bajos/puntos (≥ 2 em), casillas vacías (2,2-12 em × 1,4-4,6 em para iniciales; 8-40 em × 2-9 em para firma). Se descartan bordes de celda (verticales en ambos extremos) y papel pautado (≥ 5 rayas iguales a paso regular).
3. *Asociación etiqueta-raya* (distancias en «em» de la propia etiqueta, asignación voraz por costo, una raya por etiqueta): etiqueta a la izquierda (hueco máx. 7 em iniciales, 14 firma/nombre, 9 el resto), leyenda DEBAJO de la raya (≤ 2,4 em), rótulo ENCIMA (≤ 3,4 em). Las iniciales reclaman primero sus rayas y marcas contiguas `(____/____)`; después firma, fecha y nombre; una raya larga con varias leyendas debajo se reparte por tramos.
4. *Repetición*: rayas cortas (3-11 em) SIN etiqueta, sin texto justo encima (subrayado) ni justo debajo (pie), agrupadas entre páginas por posición normalizada (± 2,5 % × ± 2 %, largo ± 35 %); el grupo vale si cubre ≥ 60 % de las páginas con texto (≥ 2). `high` solo con ≥ 3 páginas y fuera del 12 % superior (membrete).
5. *Escaneados* (sin texto, con imagen): solo con `rasterizer`; proyección de filas, rayas de 16-70 % del ancho, ≤ 4 por página, siempre `review` con confianza 0,42 y tipo `signature`.
6. *Firmantes*: pista explícita > columnas (izquierda = 1, derecha = 2) > apiladas (arriba = 1, abajo = 2). La firma de la otra parte no lleva `signerIndex` (`review`); una tercera firma de cliente tampoco. Fecha y nombre impreso heredan el firmante de la firma más cercana (misma fila a la izquierda, o encima).
7. *Disposición de iniciales* (decisión §12): con 2 firmantes, UNA AL LADO DE LA OTRA y firmante 1 a la izquierda: sobre una raya ≥ 2 iniciales + hueco (≈ 7,1 em) en dos mitades iguales (cada inicial 3,4-6,2 em de ancho, 2,9 em de alto); en una raya corta, dos casillas contiguas desde el inicio de la raya, desplazadas a la izquierda (sin pasar de la etiqueta) para respetar el margen (3,5 % del ancho, mín. 2 em); con marcas `(____/____)`, una por firmante en su orden; con casilla vacía, sus dos mitades. Firma: ancho de la raya (≤ 50 % de la página), 3,6 em de alto recortado por el texto de encima (mín. 1,8 em, si no `review`). El «em» de disposición es el **1,8 % del ancho de la página** (11 pt en carta): no depende de la letra del contrato.

**Política** (precisión primero). `high`: etiqueta + raya asociada (o repetición clara) y ningún aviso. Bajan a `review`: poco sitio sobre la raya, cubriría texto (> 20 % del hueco) o una imagen, firma de la otra parte, firmante sin pista, etiqueta sin raya, hueco de texto no confirmado por la etiqueta o con etiqueta de más de 5 palabras. El firmante 2 con `signers: 1` pasa a `ignore`. Un campo de texto solo se propone con etiqueta legible. Topes: **12 campos por página y 80 por documento** (se conservan primero `high`, iniciales y firmas), deduplicación por solape, avisos `page-field-cap`/`document-field-cap`.

**Métricas contra los 3 ejemplos firmados reales** (acierto = centro de la propuesta dentro del rect real ± 3 % de página y tipo correcto; las verdades salen de comparar cada firmado con su blanco, sin la hoja de certificado; solo posiciones y conteos; las iniciales de 2 firmantes además con el ORDEN izquierda → derecha). Firmantes deducidos de la verdad: Responsive PA = 1, Mold Test y Mitigación = 2. Niveles `high` + `review`:

| Documento | Págs. | Iniciales | Firmas | «Dudosas» (tamaño intermedio) | `high`: correctas / propuestas | Orden de iniciales | Error medio de posición | Campos por página (máx. / media) | Texto real dentro de un campo propuesto |
|---|---|---|---|---|---|---|---|---|---|
| Mold Test | 8 | 12 / 12 | 4 / 4 | 0 / 0 | 16 / 16 | 6 / 6 páginas | 0,019 | 10 / 5,5 | 15 / 18 |
| Mitigación | 8 | 12 / 14 | 4 / 6 | 0 / 0 | 16 / 16 | 6 / 6 páginas | 0,015 | 10 / 5,5 | sin texto añadido |
| Responsive PA | 3 | 2 / 2 | 1 / 1 | 1 / 2 | 4 / 5 | (1 firmante) | 0,020 | 12 / 9,0 | 13 / 13 |
| **Global** | 19 | **26 / 28 = 92,9 %** | **9 / 11 = 81,8 %** (10 / 13 = 76,9 % contando las dudosas) | 1 / 2 | **36 / 37 = 97,3 %** | 12 / 12 | ≈ 0,018 | 12 | 28 / 31 |

Con la verdad restringida a imágenes ANCLADAS a una raya del blanco (la base de la imagen sobre una raya fina): iniciales 20 / 20, firmas 9 / 9, dudosas 1 / 1. Objetivos: iniciales ≥ 90 % (cumple), firmas ≥ 80 % (cumple por poco: 81,8 %; 76,9 % si se cuentan las dudosas), precisión `high` ≥ 90 % (cumple), ≤ 12 campos por página (cumple; 12 es el tope y lo tocan 2 de los 9 documentos reales, con muchos campos de texto en una sola página).

**Los 6 contratos sin ejemplo firmado** (plausibilidad solo por conteos; 2 firmantes): iniciales propuestas en pág. 1-3, 5-8 (Mold remediación, 9 págs.: 14 campos), ninguna (VBPA y Home Protectors: sin línea de iniciales en el documento), 2-8 (FRC, 9 págs.: 14), 1-4 (AOB, 5 págs.: 8), 2-7 (Pioneer, 7 págs.: 12). Líneas de firma propuestas por página: Mold remediación [0,0,0,2,0,0,0,0,3]; VBPA [0,2,2]; FRC [1,0,0,0,0,0,0,3,2]; Home Protectors [0,0,0,2]; AOB [0,0,0,0,3]; Pioneer [1,0,0,0,0,0,3]. Ninguna página supera 12 campos en total (texto incluido); los máximos son 12 (FRC pág. 8, Pioneer pág. 7), 10 y 9.

**Corpus sintético versionado** (`syntheticCorpus()` + `SCALE_VARIANTS`; pdf-lib; texto de relleno inventado): 14 contratos de 3-8 páginas (los de una sola página de firmas llevan delante páginas de cuerpo; iniciales repetidas sin etiqueta, `(INITIALS) ____` en alturas distintas, ES con un firmante, firmas numeradas con el orden invertido, Insured/Co-insured, raya compartida firma-fecha, casilla de iniciales, raya de iniciales muy corta, recuadros de firma, etiquetas sin raya y 4 contratos de señuelos: subrayados decorativos, tabla de precios, papel pautado, prosa con «sign»/«initial», pie con dirección subrayada repetida, regla de pie con texto debajo, regla corta repetida en el membrete, página sin rayas) y 9 variantes de tamaño/giro (carta, A4, 458,9 × 594, A3 ×1,41, ×0,7, giro 90/180/270, letra +18 %) para 5 de ellos. Total medido: **54 documentos, 245 páginas: iniciales 285 / 285, firmas 68 / 68, `high` 353 / 353 correctas, orden 129 / 129, error medio de posición 0,006, máx. 8 campos por página, 0 `high` de iniciales o firma en las 24 páginas de señuelo**. (Es un corpus propio: mide regresiones y límites de diseño; la medida independiente son los ejemplos reales.)

**Fallos concretos y límites** (tipos de línea no detectados, solo estructura):
1. *Imágenes colocadas donde el documento no dispone nada*: 5 de los 31 elementos reales (Mitigación: 2 firmas, una al pie y otra bajo la firma preimpresa de la empresa; y 2 iniciales en el pie centrado de una página de firma; Responsive PA: 1 imagen de tamaño intermedio en una zona sin raya). No tienen raya ni etiqueta: no hay forma de proponerlas sin inventar campos; son los únicos fallos de recall.
2. *Falso `high` por página de firma*: las marcas `(____/____)` del pie de la página de firma se proponen aunque el usuario no inició ahí (1 de 37 propuestas `high`; Responsive PA pág. 3). La plantilla debe permitir quitarlas.
3. *No se detectan*: casillas dibujadas con cuatro rayas sueltas (solo rectángulos reales); recuadros de firma con la etiqueta DENTRO; guiones bajos en rachas < 5 caracteres o rayas de texto < 2 em (`__/__/____` de fechas); hileras de puntos < 8; texto convertido en curvas o imagen; etiquetas giradas respecto a la vista; idiomas distintos de ES/EN.
4. *Firmantes*: se asumen 1 o 2. Con 3 líneas de firma de cliente la tercera queda `review` sin firmante; el orden por columnas/apilado es una convención (las pistas numéricas y «Co-» la corrigen).
5. *Campos de texto*: dependen de `findFillSlots` (conservador); el rótulo se relee de las frases de la página. Una etiqueta que es el final de una frase («…my insurer, ____») sale `review` si tiene más de 5 palabras.
6. *Sobreajuste*: los umbrales se afinaron con 9 contratos de 5 empresas; los 6 sin ejemplo solo se validaron por conteos. Un contrato con otra convención (p. ej. firma encima de la etiqueta con raya a la derecha) puede quedar en `review` o sin propuesta, nunca con cientos de campos.
7. *Escaneados*: solo rayas largas por proyección (sin etiquetas, siempre `review` con confianza 0,42); solo se verificó con una imagen sintética y el rasterizador por defecto en Chromium y WebKit.

**Rendimiento** (build de producción, headless; el documento se mapea DENTRO de la página con el motor real, pdf.js y su worker; segunda corrida, ya con el worker caliente): 9 páginas sintéticas en 52 ms en Chromium y 76 ms en WebKit iPad (perfil «iPad Pro 11» de Playwright). Los 9 contratos reales, con 2 firmantes (ms, Chromium / WebKit iPad): Responsive PA 69 / 95, Mold remediación 193 / 317, VBPA 60 / 86, FRC 195 / 318, Mold Test 113 / 298, Mitigación 190 / 321, Home Protectors 52 / 94, AOB 95 / 139, Pioneer 106 / 166 (máx. 321 ms; con el equipo cargado, en una corrida anterior, el máx. fue 468 ms; límite 2 s). Tareas largas (> 50 ms, Long Tasks API) en Chromium: ninguna; WebKit no expone esa API: el mayor hueco entre latidos de 10 ms del hilo principal fue 14 ms con el sintético y 20 ms con los reales (Chromium: 13 ms). El motor cede el control entre páginas y cada 1024 operaciones cuando lleva > 30 ms seguidos.

**Pruebas.** Vitest: 9 archivos `autoMap*.test.ts` (diccionario, disposición, repetición, raster, análisis de página con datos a mano, recolección de geometría con PDFs reales de pdf-lib —subtrazos, XObject con `/Matrix` propia, rutas de 150 000 puntos, `/Rotate`—, política, tope 12/80, cancelación, página ilegible, cesión de control, escaneados con rasterizador, corpus sintético y variantes) y `autoMap.real.test.ts` (**solo con `OPTIMUS_REAL_CONTRACTS_DIR=<carpeta>`**, se salta en CI y sin la variable; empareja blanco y firmado por nombre, deduce los firmantes, imprime `AUTOMAP_REPORT_FILE` con números y exige los objetivos: `OPTIMUS_REAL_CONTRACTS_DIR=/ruta npx vitest run src/lib/pdf/autoMap.real.test.ts`). E2E `automap.spec.ts` (Chromium y `PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1 … --project=webkit-ipad`, con build de producción y `CSP_SKIP_UPGRADE_INSECURE=1`): documento de 9 páginas ≤ 2 s sin tareas largas > 100 ms con la calidad medida, variantes de papel y giro, señuelos, cancelación, página escaneada real y —opcional con la misma variable— los contratos reales. Suite completa con `F2_REAL_PDFS=1`: **460 archivos (459 pasan, 1 omitido: el real), 10 829 pruebas pasan, 4 omitidas** (antes 451 / 10 556: +9 archivos, +273 pruebas); `tsc` 0 errores, `eslint` 0 errores. Mutaciones: `python3 scripts/automap-mutate.py` aplica **59 mutaciones** (umbrales de asociación y de rayas, agrupamiento por repetición, orden de firmantes y de iniciales, disposición, límites 12/80, política de niveles, diccionario, geometría, raster) y las 59 mueren (en la primera pasada sobrevivieron 13: ahora cada una tiene su prueba, salvo una equivalente que se retiró).



---

### U2.2 entregada: plantillas de campos por documento (librería, SIN interfaz; 2026-10-16)

**Qué es.** Todo lo que hace falta para «mapear una vez por documento dónde van las iniciales y firmas de cada firmante y que aparezcan solas al cargar el mismo documento»: guardar plantillas en la biblioteca de U2.1 (CRUD, versiones, variantes de 1 y 2 firmantes), repetir iniciales «en todas las páginas», aplicar una plantilla a un documento con el mapeo de páginas de la huella, convertir lo que propone el automapeo (U2.8) en plantilla, migrar las plantillas antiguas de `localStorage` y exportarlas/importarlas. La interfaz (U2.3 modo plantilla, U2.4 aplicación automática, U2.5 «Mis documentos») solo tiene que llamar a estas funciones. Punto de entrada: `src/lib/docLibrary/templates.ts` (reexporta todo; imports RELATIVOS dentro de la carpeta, como U2.1).

**Archivos** (todos en `src/lib/docLibrary/`): `templateTypes.ts` (tipos y límites) · `templateSchema.ts` (validación estricta) · `templatesStore.ts` (IndexedDB) · `templateRepeat.ts` (iniciales) · `templateApply.ts` (aplicar y clonar) · `templateAuto.ts` (automapeo → plantilla, fusión, trazabilidad) · `templateLegacy.ts` (migración de `localStorage`) · `dataKeys.ts` (orígenes de dato) · `templates.ts` (punto de entrada) · `testing/templateSamples.ts`. Cambios en U2.1: `store.ts` (base v2, ver abajo), `persist.ts` (bloque `templates`) y 3 aserciones de `store.test.ts` (versión de la base y `meta.schema`: 1 → 2). Cambio aditivo fuera de la carpeta: `signTemplates.ts` gana `refreshSignTemplates()`.

**Modelo** (`DocTemplate`; rectángulos normalizados 0..1 sobre la VISTA, los mismos de `SignatureField.rect` y `DetectedField.rect`):
```
DocTemplate { schemaVersion: 1, id, documentId: string|null, name, version, createdAt, updatedAt, rev,
              roles: [{ key, label }]            // 1 o 2; por defecto «Asegurado» / «Co-asegurado»
              variants: { "1": Variant, "2": Variant },
              layout?: { initials?: { fromPage, toPage: n|"all"|n[], base: Rect, gap?, adjust: [{page,dx,dy}] } },
              origin?: { kind:"local", legacyId, savedAt } | { kind:"clone", fromTemplateId, fromDocumentId } }
Variant     { fields:     [{ id?, roleIndex, pageIndex, type: "signature"|"initials", rect, required, group?, source: "auto"|"manual", needsReview?, confidence? }],
              textFields: [{ id?, pageIndex, rect, type: "text"|"date"|"checkbox"|"initials", label, dataKey?, required, rule?: "today", source, needsReview?, confidence? }] }
```
`version` = número de versión del CONTENIDO (sube al editar); `rev` = versión del REGISTRO (sube en cada escritura, para no pisar a otra pestaña). La variante «1» solo admite `roleIndex` 0; la «2», 0 y 1. `dataKey` es solo un DATO (de dónde saldrá el valor; lo usa la Fase 3): `DATA_KEY_PATTERN` (`^[a-z][A-Za-z0-9_.]{0,39}$`) valida la forma, NO la pertenencia al registro, así que `dataKeys.ts` puede crecer (`registerDataKey`) sin invalidar plantillas guardadas ni exportadas. Lista de fábrica: `insuredName1`, `insuredName2`, `phone`, `email`, `address`, `insurer`, `policyNumber`, `claimNumber`, `claimType`, `lossDate`, `today`; `suggestDataKey(etiqueta)` propone una clave (ES/EN, las específicas antes: «co-insured» antes que «insured», «date of loss» antes que «date»). `Kit` (plan §3) NO está en esta unidad.

**Almacén.** Misma base `optimuspdf-doc-library`, ahora **v2**: `onupgradeneeded` solo CREA el almacén `templates` (clave `id`, índice `byDocument`); no reescribe nada de `documents`/`blobs`/`meta` (probado con una base v1 con datos, también con una pestaña vieja con la v1 abierta, que se aparta sola; y en Chromium y WebKit iPad headless). `LIBRARY_SCHEMA_VERSION` = 2. Cada fila guarda la plantilla + `history` (versiones anteriores, la más reciente primero). Reglas heredadas de U2.1: lecturas no lanzan (`available:false` sin IndexedDB, filas dañadas a `skipped`), escrituras lanzan `LibraryError` (`notFound`, `conflict`, `invalid`, `full` con `detail:"count"`, `quota`, `unavailable`, `failed`), UNA transacción por operación y avisos entre pestañas por `subscribeToLibrary`. Límites: 200 plantillas en total, 20 por documento, 5 versiones por plantilla (la actual + 4 anteriores), 500 campos por variante.

| Función | Qué hace |
|---|---|
| `createTemplate(draft, { now?, newId? })` | versión 1, `rev` 1. Con `documentId`, el documento debe existir (`notFound`) y se le añade el id en `templateIds` EN LA MISMA transacción (su `rev` sube; su `updatedAt` no). Varias plantillas por documento permitidas |
| `getTemplate(id)`, `listTemplates() → { available, templates, skipped }`, `getTemplatesForDocument(id)`, `getTemplateForDocument(id)` | la más reciente primero; `getTemplateForDocument` = la más reciente del documento |
| `saveTemplateVersion(template, { expectedRev?, now? })` | **editar crea `version + 1`** y guarda la anterior. Exige saber la `rev` leída (la trae el objeto leído; si no, `invalid`); otra → `conflict` y no se pisa nada. Sin cambios de contenido no escribe. `documentId` no cambia aquí. Los campos `auto` movidos pasan a `manual` (`reconcileSources`) |
| `restoreVersion(id, version, { expectedRev? })` | copia una versión anterior COMO versión nueva (deshacer se puede deshacer); `invalid` si es la actual, `notFound` si ya no se conserva |
| `getTemplateVersions(id)` | `[{ version, updatedAt, name, current, fieldCount }]` |
| `renameTemplate`, `attachTemplate(id, documentId \| null)`, `deleteTemplate(id, { expectedRev? })` | no crean versión; `attach`/`delete` mantienen `templateIds` de los documentos |
| `statusOfTemplate(t)`, `templateStatus(documentId)`, `templateStatuses()` | `{ state: "ready" \| "single" \| "none", templateId, variants: {"1","2"}, usesFallbackForOne }` + `TEMPLATE_STATUS_TEXT` (ES/EN) |
| `findDuplicateTemplates()` | grupos `sameDocument` / `sameFingerprint` (huella idéntica o «Coincide» entre documentos con plantilla), con `keepId` = la más reciente. Solo avisa |
| `findTemplateForFingerprint(fp)` | «cargué un PDF»: `{ match, document, template, duplicates }` o `null`. Con la misma huella (`exact`/`match`) en varios documentos gana la plantilla MÁS RECIENTE (`match.ambiguous`, `alternatives`) y las demás van en `duplicates`; con `similar`, la de mayor parecido |
| `cloneTemplateToDocument(templateId, targetDocumentId)` | «Usar esta plantilla en otro documento»: `compareFingerprints` → recoloca con `mappedPages`, marca `needsReview` en las páginas «parecidas», descarta las sin correspondencia; `{ ok:false, reason: "noMatch" \| "noSourceDocument" \| "noTargetDocument" \| "notFound" }` |
| `importTemplates(templates, { onConflict: "skip"\|"copy"\|"replace" })` | una sola transacción, todo o nada; las de un documento ausente quedan «sin documento» |

**Estado para «Mis documentos».** `ready` («✓ Plantilla lista (1 y 2 firmantes)») = la variante «2» tiene firmas/iniciales Y hay forma de firmar con uno (variante «1» propia o, si no, campos del firmante 1 de la «2»: `usesFallbackForOne`); `single` («Solo 1 firmante») = solo la variante «1»; `none` («Sin plantilla») = sin firmas, o una «2» sin firmante 1 y sin «1». Cuenta la plantilla más reciente del documento.

**Borrar/limpiar.** `deleteDocument` NO borra las plantillas del documento (son trabajo de la persona): quedan `documentId: null` (reasignables con `attachTemplate`). `clearLibrary` sí las borra.

**Iniciales en todas las páginas** (`templateRepeat.ts`, puro). `repeatInitials(variant, { fromPage?, toPage?: n \| "all" \| n[], pageCount?, signers: 1\|2, base, gap?, perPageAdjust?, replaceExisting?, required?, source? }) → { variant, pages, skippedPages, keptPages, layout }`. Disposición de §12: con 2 firmantes `base` (la línea de iniciales completa) se parte en DOS mitades iguales separadas por un hueco (`gap` = fracción del ancho, 0,1 por defecto; 0..0,5): firmante 1 a la IZQUIERDA, firmante 2 a la DERECHA, misma `y` y alto; con 1 firmante, `base` entera. Con la geometría observada (§11: `base` 0,79-0,91 × 0,82-0,85, ≈ 0,12 × 0,03) cada inicial queda en 0,05-0,09 × 0,02-0,05. Es idempotente (ids `ini-p<página>-r<rol>`: repetir SUSTITUYE, no duplica), no toca firmas, textos ni iniciales de otros roles/páginas, ordena por página y rol, y no pasa de 500 campos. `perPageAdjust: { [página]: { dx, dy } }` mueve las iniciales de esa página sin salirse de ella (se pega al borde, no se encoge); `applyPageAdjust(variant, adjust, { type?, roleIndex? })` hace lo mismo sobre campos ya colocados. `layout` se guarda en `template.layout.initials` para poder volver a editarlo. Parámetros inválidos lanzan `RangeError`.

**Aplicar a un documento** (`templateApply.ts`, puro). `applyTemplate(template, { signers: 1\|2, pageMapping?, reviewPages?, match?, pageCount?, roles?, mintFieldId?, mintTextFieldId? }) → { fields: SignatureField[], textFields: DetectedField[], fieldMeta, textMeta, reviewFields, skippedPages, reviewPages, variant, warnings }`.
- **Formato EXACTO de Firmar hoy** (sin tocar `SignToolClient.tsx`): `fields` = `{ id, signerId, pageIndex, type, rect }`; `textFields` = `DetectedField` con `source:"manual"`, `confidence:"high"`, `label` solo si existe y `type` solo si no es `"text"` (igual que `instantiateTemplate` de `signTemplates.ts`; una prueba compara ambos campo a campo). Ids siempre nuevos (`mintFieldId`/`mintTextFieldId`; por defecto `tpl-s-N`/`tpl-t-N`; la interfaz debe pasar los suyos); `roles[i].signerId` = el firmante real del rol `i` (sin él se usa la `key` del rol). `required`, `group`, `dataKey`, `rule` y el id de la plantilla van en `fieldMeta`/`textMeta` por id nuevo.
- **Variante.** 2 firmantes → «2» (si no tiene firmas pero la «1» sí: se usa la «1» y avisa `missingSecondSigner`). 1 firmante → «1»; si solo existe la «2»: solo los campos del firmante 1 y los textos que no son `insuredName2`, con aviso `fallbackFromTwoSigners { droppedFields }`. Sin firmas en ninguna: `noSignFields`. (La disposición del firmante 1 de una variante de 2 es «la mitad izquierda»: no se reensancha.)
- **Mapeo de páginas** (`MatchResult.mappedPages`/`reviewPages` de `compareFingerprints`, o `match: result`): página sin correspondencia (`null`, fuera de mapa o de `pageCount`) → sus campos NO se aplican; van a `reviewFields` (`reason: "noPageMatch" \| "outOfRange"`, `documentPage: null`) y la página a `skippedPages`. Página emparejada pero «parecida» (`reviewPages`) → NO se aplica sola: `reviewFields` con `reason: "pageReview"`, `documentPage` ya recolocada, y la página a `reviewPages`. Un campo con `needsReview` (propuesta de confianza media sin confirmar) tampoco se aplica solo (`reason: "needsReview"`; su página no cuenta como «de revisión»). Solo se listan páginas que TIENEN campos.
- `cloneTemplate(template, { documentId, mappedPages, reviewPages?, targetPageCount?, name? }) → { draft, kept, flagged, dropped, droppedPages }`: el borrador para `createTemplate`; `layout` solo se conserva con mapa identidad.

**Desde el automapeo** (`templateAuto.ts`). `templateFromAutoMap(result, { documentId, signers, name?, roles? }) → { draft, stats }`: entran `high` (campo normal) y `review` (`needsReview: true`); `ignore` no. Firma/iniciales con `signerIndex` → `variants[<signers>].fields` (`roleIndex = signerIndex`); la firma de la otra parte (sin firmante) y el firmante 2 con 1 firmante NO entran (`stats.noRole`); fecha → texto `date` con `rule:"today"` y `dataKey:"today"`; texto → `text` con el `dataKey` sugerido; todo con `source:"auto"`, `confidence` e id del automapeo. Solo se rellena la variante del nº de firmantes con que se automapeó; la otra queda vacía (se usa el respaldo hasta que se configure). `mergeTemplateDrafts(edited, fresh, { dismissed?, minOverlap? }) → { variants, stats }`: la edición de la persona MANDA (se conserva todo lo suyo, aunque la propuesta nueva ya no lo traiga); un campo nuevo se considera ya presente si hay uno con el mismo id o del mismo tipo/rol/página con IoU ≥ 0,3; lo demás se añade como `auto`, salvo los ids de `dismissed`. `reconcileSources(previous, next)` (la usa `saveTemplateVersion`): un campo `auto` que cambió de sitio/tipo/rol/página pasa a `manual` y pierde `confidence`/`needsReview`.

**Migración de `localStorage`** (`templateLegacy.ts`). `migrateLocalTemplates({ storage? }) → { status: "unavailable"\|"none"\|"corrupt"\|"storeUnavailable" } \| { status:"ok", created, alreadyMigrated, skipped, droppedFields, failed }`: copia cada plantilla de `optimuspdf.signTemplates` como plantilla `documentId: null` con `origin: { kind:"local", legacyId, savedAt }` (firmantes → roles, como mucho 2; con 1 firmante los huecos van a la variante «1», con 2 a la «2»; rectángulos fuera de 0..1 se recortan a la página y, si quedan sin tamaño, se descartan y cuentan). **Idempotente** (por `legacyId`, también tras reasignarla a un documento), **no borra los originales**; sin `localStorage`, con datos corruptos o con entradas dañadas no rompe (las dañadas se cuentan y se dejan). `markMigrated()` borra de `localStorage` SOLO las ya migradas (se comprueba en la biblioteca), para cuando la persona lo confirme; después la interfaz llama a `refreshSignTemplates()` (nuevo, aditivo en `signTemplates.ts`) porque el evento `storage` no llega a la misma pestaña. Una prueba comprueba que la clave es la de `signTemplates.ts` y otra (jsdom) usa el `saveTemplate` real.

**Exportar / importar** (`persist.ts`). Compatible con U2.1: el `schemaVersion` sigue siendo 1; las plantillas viajan en dos claves OPCIONALES nuevas, `templatesSchemaVersion: 1` y `templates[]`. `serializeLibrary(entries, templates?)` / `serializeLibraryJson(...)` sin plantillas produce EXACTAMENTE los mismos bytes que antes (paquete dorado `__fixtures__/library.v1.json`, generado con el código de U2.1 ANTES de tocarlo: se lee idéntico y se re-serializa idéntico) y un lector de U2.1 ignora las claves nuevas. `serializeTemplate` quita `rev` y el historial. `deserializeLibrary` devuelve ahora también `templates: DocTemplate[]` (con `rev: 1`; el almacén pone la suya al guardar con `importTemplates`) y avisos nuevos: `invalidTemplate { index }` (−1 = el bloque entero), `duplicateTemplateId`, `tooManyTemplates { kept }` (≤ 200), `newerTemplatesVersion`. Cada plantilla pasa `parseTemplate` (listas blancas que copian campo a campo, longitudes, rectángulos finitos dentro de 0..1, ≤ 500 campos por variante, ids únicos, `Object.hasOwn` en TODA lectura, sin recursión sobre la entrada); una inválida se omite y el resto sigue. `MAX_LIBRARY_JSON_BYTES` pasa de 8 a 32 MiB (las plantillas caben en el mismo JSON; el contenedor `.zip` es de U4.5).

**Decisiones.** (1) El esquema de documentos NO sube de versión (alternativa descartada: `schemaVersion: 2` rompería la lectura de U2.1 y su prueba «esquema más nuevo → rechazado»). (2) 5 versiones = la actual + 4 anteriores. (3) Restaurar crea versión nueva (no retrocede el número). (4) Borrar un documento deja sus plantillas sin documento en vez de borrarlas. (5) Los campos `needsReview` no se aplican solos al cargar. (6) La variante de 1 firmante derivada de la de 2 usa la mitad izquierda de la línea de iniciales (no se reensancha): si la persona quiere otra, configura la variante «1». (7) Una página SIN texto en el documento se compara por imagen y (decisión de U2.1) impide `match`: el documento sale `similar` y la interfaz debe preguntar; se midió con el corpus sintético (`decoys`).

**Pruebas.** 10 archivos nuevos, **268 pruebas** (`dataKeys` 36, `templateSchema` 26, `templateRepeat` 31, `templateApply` 29, `templateAuto` 19, `templatesStore` 57, `templateLegacy` 24 + `.dom` 1, `templatePersist` 21, `templates.integration` 24), datos SINTÉTICOS: CRUD con `fake-indexeddb`; migración de esquema v1 → v2 con datos previos (documento, copia, meta, pestaña vieja abierta); versiones (tope 5, restaurar, deshacer el deshacer, diseño de iniciales); concurrencia entre «pestañas» (misma `rev`, guardados simultáneos, altas con el mismo id, avisos); atomicidad (cuota a mitad de transacción deja documento y plantilla intactos); filas dañadas; sin IndexedDB; límites 20/200; `repeatInitials` (1 y 2 firmantes, rangos, listas, `pageCount`, ajustes por página y en el borde, `__proto__`); `applyTemplate` (variantes, respaldos, mapeo con `null`/`reviewPages`/fuera de rango, plantilla antigua, formato idéntico a `instantiateTemplate`); `templateFromAutoMap`/fusión/trazabilidad; migración de `localStorage` (datos corruptos, entradas dañadas, `__proto__`, idempotencia, `markMigrated`, localStorage que lanza); serialización con JSON hostil (`__proto__`/`constructor`, anidado de 20 000-50 000 niveles, nombre de 5 MB, claves duplicadas, herencia de prototipo, BOM, basura final, 32 MiB). **Integración** con el corpus sintético de U2.8 (18 contratos —14 más 4 de señuelos— + 3 variantes de papel/giro, A4, giro de 90° y ×0,7, de 2 de ellos = 24 casos): automapear → plantilla → guardarla → reexportar el PDF con pdf-lib (otros bytes) → reconocerlo por huella → aplicar con `mappedPages`: los campos aplicados son exactamente los `high` del automapeo (error < 1e-9) y caen a menos de **0,005** de lo que el automapeo de la propia reexportación propone; una página reescrita → `similar`, esa página va a «Revisar» y las demás se aplican; clonar al documento con la página distinta descarta solo esa. **Mutaciones**: `python3 scripts/templates-mutate.py` aplica **77** (disposición, orden, rangos, bordes, validación, tope de 500, `hasOwn`, versiones, `rev`, restaurar, estado, migración de esquema, `templateIds`, borrar documento, `clearLibrary`, aplicación, mapeo, clonado, migración local, fusión, exportación): **77 de 77 mueren** (en la primera pasada sobrevivieron 2: el diseño de iniciales al clonar con mapa no identidad —la prueba no tenía plantilla con diseño— y `templateIds` ante estados a medias; ahora tienen prueba). Suite completa con `F2_REAL_PDFS=1`: **483 archivos (481 pasan, 2 omitidos), 11 419 pruebas pasan, 8 omitidas**; `tsc` 0 errores; `eslint` 0 errores (1 aviso previo en `inputChecks.clients.test.tsx`). Nota: en la primera pasada completa falló una vez `resumeFlow.test.tsx` («Atrás… ¿Salir de la firma?», 10 s bajo la carga de la suite, no toca nada de esta unidad); aislada pasa 26/26 y la segunda pasada completa quedó verde. **Navegador real** (script fuera del repositorio, build Vite del mismo código, Chromium y WebKit iPad headless, 18/18): base v1 con datos → v2 sin perderlos, dos pestañas reales con la misma `rev` (una guarda, la otra `conflict`), aviso por `BroadcastChannel`, versiones 2 y 1, migración real de `localStorage` + `markMigrated`, exportar/importar.

**No verificado.** Interfaz (no existe; U2.3-U2.5 deben llamar a `applyTemplate`, `findTemplateForFingerprint`, `repeatInitials`, `templateFromAutoMap`, `statusOfTemplate`); Safari real de iPad (solo el WebKit de Playwright); Firefox; cuota real agotada (simulada con una excepción en `put`); el comportamiento con 200 plantillas de 500 campos en dispositivos pequeños (se limita el número, no se midió memoria); las plantillas con los contratos REALES (no se usaron; las posiciones de §11 se usaron solo como geometría de prueba); `Kit` (plan §3) y `Package` (U4.5: el contenedor `.zip` de plantillas, que además debe revalidar con `deserializeLibrary`); el E2E de la aceptación de F2 («configurar una vez → subir el mismo PDF reexportado → campos solos → firmar»), que es de U2.3/U2.4; ningún spec Playwright nuevo en el repositorio (la comprobación en navegador fue un script aparte).


---

### U1.2 + U1.3 entregada: tabla «¿Quién firma qué?», copias, ceremonia por grupos, orden de turnos y «Revisar antes de descargar» (2026-10-16)

**Qué ve el usuario.** Con **dos o más documentos** el paso «Firmantes» ya no muestra «Mismas / Distintas» ni la lista «Bloque 1 · Aplica a…» de cada firmante: muestra **una tabla documentos × firmantes** (`AssignmentMatrix.tsx`). Cada celda es un chip de 44 px con la letra del grupo (`A`, `B`… = «Firma A», «Firma B»; las celdas con la misma letra comparten UN trazo) o `—` (no firma ahí); tocarla pasa a la siguiente opción (grupos que ya usan las otras celdas del firmante en orden de letra → «grupo nuevo» → «no firma» → vuelta a empezar; la última celda con firma de un firmante no se puede vaciar y se dice). Arriba, los atajos **«Una firma para todos»**, **«Una firma por documento»** y **«Por grupos»** (la primera mitad de los documentos = A y el resto = B: A,A,B,B con 4), **«Deshacer cambio»** (pila de 5; solo se ofrece cuando hay algo que deshacer y mientras los bloques sean los que dejó el cambio; se pierde al salir del paso Firmantes) y **«Copias de todos» − / +**; en cada fila, la columna **Copias** con − / + (1..5; tope de 50 archivos con mensaje). Debajo, el **resumen en lenguaje natural** («Ana firma 4 documentos con 2 firmas: A (Contrato, Anexo) y B (Carta, Autorización). Luis firma 2 documentos con 1 firma. Se descargarán 8 archivos.») y, si los hay, los problemas bloqueantes (hueco sin firmante, documento que nadie firma…) con **«Ir a corregirlo»** (enfoca la celda). Si el cambio se llevaría trazos ya recogidos (`applyMatrix` → `lost` / `needsConfirm`) se abre una hoja: «Esto borrará la firma B de Ana en 2 documentos.» / «Ana tendrá que volver a confirmar la firma A: ahora cubre 1 documento más que no vio.» con Cancelar / Continuar. Con **1 documento** o **«Solo yo»** nada cambia.

- **Estrecho (< 640 px)**: la misma estructura (rejilla ARIA `role="grid"`, un solo punto de tabulación, flechas / Inicio / Fin entre celdas, Intro/Espacio activan) se pinta como **tarjetas por documento** (nombre del documento, una celda por firmante con su nombre al lado, copias), sin scroll horizontal; desde `sm`, cabecera con los firmantes y copias a la derecha.
- **Ceremonia** (`BlockCeremony.tsx`): el turno de cada firmante lista **«Firma A — para: Contrato, Anexo»** y **«Firma B — para: Carta, Autorización»** (hasta 4 nombres y «+N»), los botones de captura se llaman «Crear mi firma · Firma B» y la lista de progreso dice «Firma A ✓ / Iniciales A ✓ / Firma B ○» (con un solo grupo, «Firma» / «Iniciales» como antes). **Orden de turnos**: ↑ ↓ de 44 px por firmante (con ≥ 2 en la cola); se guarda en `SignSession.turnOrder` (y en el borrador de sesión: `SessionDraftMeta.turnOrder`, ids de firmante saneados al leer); el turno de ahora sigue al primero pendiente del orden nuevo si estaba en el traspaso. La hoja «Cambiar» (alcance) de cada grupo sigue ahí con el nombre «Firma A».
- **«Revisar antes de descargar»** (`ReviewBeforeDownload.tsx`, dentro de la tarjeta final de la ceremonia cuando ya no queda nadie por firmar): por documento, una **miniatura de cada página con firma / iniciales / texto** (huecos dibujados encima, continuos si están hechos y discontinuos si no; cola de miniaturas de `useSequenceMeta`, un documento abierto a la vez), contadores («Iniciales: 8 de 8 · Firmas: 2 de 2 · Texto: 3 de 3»; **esperado = páginas del cuerpo × firmantes** cuando un firmante repite iniciales: las páginas que solo llevan su firma no cuentan; si faltan, «7 de 8» y un **aviso** con las páginas) y los problemas de `validateAssignment`: **bloqueantes** (desactivan «Firmar y descargar», con el motivo enlazado por `aria-describedby` y «Ir a corregirlo» → tabla / paso Documento) y **avisos** (dejan continuar). Tocar una miniatura lleva a esa página del documento (paso «Documento»). Mientras quedan firmas por recoger solo se ven los problemas (no se abre ningún documento).
- **Resultado**: con copias el ZIP lleva N archivos por documento (U1.1) y la pantalla dice «8 archivos: 4 documentos con 2 copias cada uno.» (`ProcessResult.summary`, delante del resumen del texto editado de F0, que sigue funcionando).

**Modelo y migración.** La tabla se **deriva** de los bloques (`groupsMatrix`) y cada cambio los reescribe (`applyMatrix`): nada nuevo en `SignerBlock`, borradores ni `signConfig`. **El modo «Mismas/Distintas» ya no se elige**: `signMode` se deduce de la tabla (`signModeFor`: «independent» solo con un grupo por documento y sin celdas vacías; si no, «same», que es el modo en el que `ensureBlocks` no «repara» las celdas `—`) y «Deshacer» devuelve el modo exacto de antes. Los borradores y sesiones existentes se restauran sin cambios y aparecen con su tabla equivalente (probado con los tres dorados de U1.1: «mismas», «distintas» A,A,B,B del caso del usuario y el anterior a los bloques). Un documento nuevo entra solo en el grupo automático («Una firma para todos»); tras partir los grupos, queda como `—` hasta que se toque.

**Archivos.** Nuevos: `AssignmentMatrix.tsx`, `ReviewBeforeDownload.tsx`, `assignmentUi.ts` (tocar una celda, «Por grupos», modo derivado, copias con topes, impactos), `assignmentIssues.ts` (texto y destino de cada problema, compartido por la tabla y la revisión), `reviewModel.ts`, `turnOrder.ts`, `e2e/helpers/pdf-images.ts`, `e2e/specs/sign-assignment.spec.ts` y `sign-assignment-a11y.spec.ts` y sus pruebas. Tocados: `SignToolClient.tsx` (la tabla en el paso Firmantes, `applyAssignment`, `fixTarget` / `goToPage`, resumen de copias), `BlockCeremony.tsx`, `BlockScopeSheet.tsx` (título propio de grupo), `SignerManager.tsx` (`role="none"` en los `li` del `radiogroup`: axe `listitem` fallaba ya antes), `SignerBlocks.tsx` (se retira `SignModeControl`), `signSession.ts`, `sessionDraft.ts`, `SessionDraftAutosave.tsx`, `signDrafts.ts` (solo `turnOrder`), `strings.ts` (bloques `assignment` y `review`, ES/EN) y `playwright.config.ts` (`sign-assignment` en `webkit-ipad`).

**Tests existentes que cambian (y por qué).** (1) `multiBlocks.test.tsx`: los 11 tests del control «mismas/distintas» y los 7 de «bloques de cada firmante» (lista «Bloque N · Aplica a», «Añadir/Quitar bloque», hoja de alcance en el paso Firmantes) se reescriben contra la tabla: mismo comportamiento comprobado (atajos, fusión con trazos distintos pide confirmación en lugar del aviso de 6 s, «Deshacer», crear grupo al tocar, cobertura con «Ir a corregirlo»). La hoja de alcance y la lista siguen cubiertas por `SignerManager.test.tsx` y `BlockCeremony.test.tsx`. (2) `multiDocumentPanel.test.tsx`: 3 tests (aparece la tabla con ≥ 2 documentos, firmante nuevo = «Firma A», documento nuevo entra solo). (3) `BlockCeremony.test.tsx`: los nombres «Bloque N» pasan a «Firma A/B/C», «Aplica a: …» a «Firma A — para: …» y la lista de progreso a «Firma A / Iniciales A»; los 2 tests de cobertura con «Añadir bloque para X» (ya no hay ese botón en la ceremonia) pasan a uno con el problema + «Ir a corregirlo» → `onFix`. (4) E2E: `selectSignMode` / `createBlockSignature` (helpers) y 6 textos de `sign-ceremony-turns.spec.ts` usan los nombres nuevos; `sign-wide-font.spec.ts` añade la tabla con copias y la revisión. Ninguna aserción se debilita: todas se mantienen o se endurecen con el texto nuevo.

**Pruebas.** Vitest completo con `F2_REAL_PDFS=1`: **478 archivos, 11 275 pruebas pasan, 8 omitidas** (antes 471 / 11 151; +7 archivos). Nuevas: `assignmentUi.test.ts` (31), `turnOrder.test.ts` (8), `reviewModel.test.ts` (13), `assignmentIssues.test.ts` (10), `AssignmentMatrix.test.tsx` (29: alternar, atajos, copias con topes, deshacer con pila, confirmación de trazos, teclado, tarjetas, problemas), `ReviewBeforeDownload.test.tsx` (13), `sessionDraft.turnOrder.test.ts` (7), más 11 en `BlockCeremony.test.tsx` y 4 en `batchDelivery.test.tsx`. Mutaciones (`scratchpad/u12/work/mutate.py`, 57 sobre la lógica de UI e integración): **57 de 57 mueren** (en la primera pasada sobrevivían 7: seis recibieron prueba y la séptima era un respaldo redundante que se eliminó). E2E (build de producción, `CI=1`, puerto 3952): ver «Pruebas E2E» abajo.

**Toques del caso del usuario.** Desde la carga de los 4 PDF hasta dejar «quién firma qué» y las copias: **4 toques** (Varios firmantes · Añadir firmante · Por grupos · Copias de todos +1; escribir el nombre no es un toque). El E2E exige ≤ 6 y publica la cuenta como anotación.

**Pruebas E2E** (build de producción con `CSP_SKIP_UPGRADE_INSECURE=1`, `CI=1`, puerto 3952, headless, 2 workers).
- `sign-assignment.spec.ts` (8): el caso del usuario (4 documentos, A,A,B,B, 2 copias → 4 toques → 2 trazos en UN turno «Turno 1 de 1» → revisión → ZIP «Firmados - 4 documentos.zip» con **8 PDF**, cada uno con UNA imagen empotrada cuya máscara de transparencia coincide pixel a pixel con el trazo capturado de SU grupo y no con el del otro, incluidas las copias `(copia 2)`); 2 documentos × 2 firmantes con 4 firmas distintas (cada PDF lleva las dos de sus firmantes); orden de turnos (↑↓ de 44 px, anuncio, sobrevive a recargar y se respeta al firmar); revisión que bloquea con un hueco sin firmante, «Ir a corregirlo» enfoca la celda, la corrección pide confirmar y se descarga; miniatura → página del documento; cambio de asignación con trazos ya recogidos (Cancelar, Continuar, Deshacer cambio); recarga a mitad restaura tabla y copias; borrador anterior (modo «distintas», sin copias ni orden, reescrito en IndexedDB) restaura con su tabla A,B,C,D.
- `sign-assignment-a11y.spec.ts` (4): axe-core **0 violaciones** (contraste, ARIA, nombres, listas, orden de encabezados, `target-size`…) en claro/oscuro × ES/EN × 1280/375 px de la tabla (con copias, un problema y «Deshacer cambio»), la ceremonia con el orden de turnos y «Revisar antes de descargar»; celdas, copias, flechas y miniaturas ≥ 44 px; filas en `display:flex` (tarjetas) a 375 y en `grid` a 1280; sin scroll horizontal; sin regiones vivas dentro de la tabla ni de la revisión. Este spec destapó un fallo previo de axe (`listitem`: los `li` del `radiogroup` de `SignerManager`), corregido con `role="none"`.
- `sign-wide-font.spec.ts` suma «tabla con una firma por documento», «tabla con copias y resumen» y «Ya han firmado todos con Revisar antes de descargar» (fuente ancha, 375 y 320 px, ES/EN, claro/oscuro): sin desbordes.
- Regresión **Chromium**: `sign-*` (multi, quality, privacy, recovery, ceremony-turns, record, draft-safety, stale-signature, edit-summary, upload-a11y/backup, backup-merge, wide-font), `signature-font`, `recent-continue`, `focus-own-headers`, `tool-errors`, `pdf-pro-modes-sign`, `a11y-sweep` y los dos specs nuevos: **529 pasan, 1 intermitente, 2 omitidas** (la intermitente fue `sign-assignment` bajo carga de 2 workers: «Ya han firmado todos» tardaba más de 5 s; el plazo ahora es 20 s). Un primer pase destapó un cambio de contrato real: `sign-recovery` (c20) espera que NO haya ningún botón «Deshacer» tras quitar un documento y «Deshacer cambio» (siempre visible, apagado) lo rompía: ahora el botón solo se pinta cuando hay algo que deshacer.
- Regresión **`webkit-ipad`** (`PW_BROWSERS=webkit-ipad`, iPad Pro 11 táctil): `sign-assignment`, `sign-multi`, `sign-ceremony-turns`, `sign-recovery`, `sign-record`, `sign-privacy`, `recent-continue`, `sign-draft-safety`, `sign-stale-signature`, `sign-quality`, `signature-font`, `sign-edit-summary`, `sign-upload-*`, `sign-backup-merge`, `tool-errors`, `focus-own-headers`: **238 pasan, 2 intermitentes, 5 omitidas**; las intermitentes: `sign-recovery` (d) (recarga a 100 ms, ya intermitente en carga) y `sign-assignment` (el arrastre del hueco en el 4.º documento se perdía en WebKit: el helper ahora comprueba «En este documento: 1 hueco» y repite). Tras corregirlo, los 8 de `sign-assignment` pasan en `webkit-ipad` y los 12 de ambos specs nuevos en Chromium, sin reintentos.

**No verificado.** Safari real / iPad físico (solo WebKit de Playwright con perfil iPad); arrastrar para reordenar turnos (solo ↑↓, que es lo que pide el plan como alternativa); «Revisar antes de descargar» con documentos de cientos de páginas (las miniaturas se piden de una en una, hasta 60 en memoria); la pila de «Deshacer cambio» se pierde al salir del paso Firmantes (vive en el componente); `tooManyFiles` no se alcanza desde la interfaz (10 documentos × 5 copias = 50 es justo el tope) y solo está probado como lógica; el botón «Procesar» del panel lateral no mira los problemas de la revisión (solo `deliveryBlockers`, como antes): el bloqueo de la revisión actúa sobre «Firmar y descargar».
### U2.5 + U2.6 entregada: «Mis documentos» (Inicio y `/documents`) y Recientes unificado (2026-10-16)

**Qué ve la persona.**
- **Mis documentos** (`/documents`, enlace «Mis documentos» en la barra lateral, la cabecera de tablet y la barra móvil, que pasa de 3 a 4 pestañas): una tarjeta por contrato guardado con miniatura de la página 1 (dibujada en segundo plano con pdf.js, nunca bloquea), nombre, tipo, páginas y el estado de su plantilla: ✓ «Plantilla lista (1 y 2 firmantes)», ✓ «Plantilla de 1 firmante» (parcial) o ✗ «Sin plantilla» (icono distinto + texto: nunca solo color). Acciones «Firmar» y «Configurar plantilla» (≥ 44 px), casilla para elegir varios (hasta 10) con la barra «Firmar seleccionados (N)», y «⋯» con renombrar, reemplazar PDF y borrar (con confirmación). «Añadir contrato»: elegir PDF → nombre y tipo editables → guardar (huella en un worker; el primer documento pide `navigator.storage.persist()`).
- Debajo: **Almacenamiento** (uso real de la biblioteca sobre 400 MB y 50 documentos, estado del almacenamiento persistente con el botón «Pedir almacenamiento persistente», aviso de Safari/iPad «puede borrar tras 7 días sin usar el sitio», consejo «Añadir a la pantalla de inicio» y el hueco «Respaldar mis documentos» deshabilitado con «Próximamente»). Línea fija de privacidad: «Se guarda una copia en este navegador; usa contratos en blanco, sin datos de clientes.» Vacío: «Sube tus contratos una vez y configura dónde firma cada quien» + «Añadir contrato». Sin IndexedDB: tarjeta que lo explica (Firmar sigue funcionando subiendo el PDF) y nada más.
- **Inicio**: sección «Mis documentos» sobre «Más usadas» (hasta 4 documentos, «Ver todos»; vacía invita a añadir el primero; sin IndexedDB no pinta nada; se oculta al buscar).
- **Reemplazar PDF** recalcula la huella con `replaceDocumentBytes` y compara la huella vieja (la de la plantilla) con la nueva: mismo contenido → sin aviso; páginas distintas → «cambió en N páginas: revisa su plantilla»; otro documento → «ya no coincide con su plantilla». Un documento sin plantilla no avisa.
- **Recientes** (U2.6): un solo índice DERIVADO (`src/app/recent/recentIndex.ts`, sin almacén ni datos nuevos) = borradores reales de Firmar/Editar/PDF Pro + entradas del historial que no apuntan a un borrador vivo, ordenado por fecha. Se pinta en dos grupos con sus encabezados de siempre («Sin terminar» con «Continuar»/«Descartar»; «Historial» con «Abrir herramienta»), cada fila con miniatura (si hay), nombre, herramienta, estado «Sin terminar»/«Terminado» y fecha. Aviso fijo «Solo en este navegador». «Borrar» por fila del historial, «Borrar historial» (como antes), «Borrar todo» (confirmación: descarta todos los borradores y el historial; Mis documentos no se toca). **«Abrir de nuevo»**: en el historial de Firmar, si el puntero `resume` del trabajo lleva una huella igual a la de un documento de Mis documentos, el botón deja el traspaso con esa copia y abre Firmar; sin coincidencia se queda en «Abrir herramienta» (la herramienta pide el archivo). Un documento de la biblioteca nunca genera una fila por existir.

**Regla de «Continuar» (verificable).** `src/lib/resumeLinks.ts`: `verifiableResume(slug, puntero)` / `continueHrefFor(slug, puntero)` devuelven el puntero (nuevo, solo tipo e id) solo si el tipo está en la lista blanca, el id cumple la expresión de su tipo y el tipo PERTENECE a la herramienta de la fila. `buildRecentRows` la aplica a los borradores; las filas de historial nunca llevan «Continuar». Pruebas que recorren `TOOL_SLUGS` × `RESUME_KINDS` × punteros válidos/ajenos/mal formados (`recentIndex.test.ts`, `resumeLinks.verifiable.test.ts`).

**Traspaso a Firmar.** `useOpenInSign()` (`src/app/documents/useOpenInSign.ts`): `setSignHandoff({ documentIds, mode })` y `router.push("/sign-pdf")`; no navega si el traspaso no es válido. «Firmar seleccionados» manda los ids en el orden de la lista (más reciente primero). No toca `SignToolClient.tsx` ni `strings.ts`.

**Archivos.** Nuevos: `src/app/documents/{page.tsx, MyDocumentsHomeSection.tsx, DocumentCard.tsx, DocThumb.tsx, TemplateBadge.tsx, StoragePanel.tsx, DocumentSheets.tsx, documentActions.ts, documentsModel.ts, useDocumentLibrary.ts, useDocumentThumbnail.ts, useOpenInSign.ts, documents.testkit.ts}`, `src/components/views/MyDocumentsView.tsx`, `src/app/recent/{recentIndex.ts, HistorySection.tsx, discardDraft.ts}`. Cambiados: `HomeView.tsx` (la sección), `RecentView.tsx`, `UnfinishedSection.tsx` (recibe filas del índice), `Sidebar.tsx`, `Header.tsx`, `MobileTabBar.tsx`, `src/lib/recent.ts` (`removeRecentEntry`, `MAX_RECENT_ENTRIES`), `src/lib/resumeLinks.ts`, `src/lib/locales/{es,en}.ts` (bloque `documents.*`, `nav.documents` y claves nuevas de `recent.*`), `playwright.config.ts` (`my-documents` en `CROSS_SPECS`).

**Pruebas.** Vitest: `documentsModel.test.ts`, `recentIndex.test.ts`, `resumeLinks.verifiable.test.ts`, `recent.remove.test.tsx`, `MyDocumentsView.test.tsx` y `.en.test.tsx` (jsdom + `fake-indexeddb` sobre el almacén real; se simulan solo pdf.js, la huella y el router), `RecentView.unified.test.tsx`, `MyDocumentsHomeSection.test.tsx`. Suite completa con `F2_REAL_PDFS=1`: 499 archivos (497 pasan, 2 omitidos), 11 698 pruebas (11 690 pasan, 8 omitidas). E2E `e2e/specs/my-documents.spec.ts` (8 pruebas, build de producción con `CSP_SKIP_UPGRADE_INSECURE=1`, headless): añadir 3 contratos sintéticos → ✗ → plantillas creadas desde la prueba con `templates.ts` → ✓/✓ parcial → recargar: persisten → «Firmar» / «Configurar plantilla» / «Firmar seleccionados» (se registra lo que se escribió en `optimuspdf.signHandoff` con un espía de `setItem`, y la URL `/sign-pdf`); renombrar, reemplazar (con y sin aviso), borrar; sección de Inicio; sin IndexedDB; Recientes («Borrar», «Borrar todo», «Abrir de nuevo»); axe-core 0 violaciones en claro/oscuro × ES/EN × 1280/375 (`/documents` vacío y con documentos, Inicio, Recientes); sin desbordes a 375 y 320 px con fuente ancha forzada y objetivos de toque ≥ 44 px. Chromium y `webkit-ipad`.

**Decisiones y límites.**
- La unión «por fecha» vive en el índice; la pantalla conserva los dos grupos («Sin terminar», «Historial») para no romper `recent-continue`; dentro de cada grupo el orden es por fecha.
- «Abrir de nuevo» con la copia solo existe para Firmar (el traspaso es de Firmar). Hoy `ToolShell` no guarda puntero `resume` en el historial de Firmar, así que la coincidencia por huella aparecerá cuando alguna unidad lo registre; la lógica y la interfaz ya están probadas con punteros reales.
- Las miniaturas se guardan solo en memoria (data URL ~160 px, clave = id + huella + tamaño: reemplazar el PDF las invalida); no hay almacén nuevo.
- Los tests de componentes con `fake-indexeddb` en jsdom necesitan un `Uint8Array.[Symbol.hasInstance]` por etiqueta (`documents.testkit.ts`): el clon estructurado de IndexedDB devuelve el `Uint8Array` del dominio de Node y `instanceof` falla solo en ese entorno.
- No verificado: Safari real de iPad (solo el WebKit de Playwright); `navigator.storage.persist()` real (simulado en vitest; en el E2E solo se comprueba que el estado se muestra); biblioteca con 50 documentos y miniaturas reales; el consumidor del traspaso en Firmar (otra unidad).
### U2.3 + U2.4 entregada: modo «Configurar plantilla», aplicación automática al cargar y automapeo en Firmar (interfaz, 2026-10-16)

**Qué ve el usuario.**
- **Configurar una vez.** En la herramienta vacía hay un botón **«Configurar plantilla»** (elige un PDF en blanco y abre el editor); con un PDF ya cargado, el panel de opciones lleva **«Crear plantilla de este documento»** / **«Configurar plantilla de este documento»** (si ya tiene una). El editor es el MISMO `DocumentCanvas` de Firmar, sin ceremonia: nombre de la plantilla, los dos roles editables («Asegurado», «Co-asegurado»), interruptor de **variante** («1 firmante» / «2 firmantes», cada una se edita y se guarda por separado, con «Copiar de la variante de N firmantes»), **Deshacer / Rehacer** (botones y ⌘/Ctrl+Z; un arrastre cuenta como un solo paso), **«Detectar campos automáticamente»** (corre `autoMapFile`: lo seguro queda colocado con aviso «Deshacer» y lo dudoso aparece en «Sugerencias (M)» para aceptarlo una a una o con «Aceptar todas»), y **«Iniciales en todas las páginas»**: se coloca la línea de iniciales en una página y **«Repetir iniciales en todas las páginas»** la reparte (con 2 firmantes, UNA AL LADO DE LA OTRA, el firmante 1 a la izquierda sobre la línea), con «Repetir solo en un rango de páginas» (N a M) e **«Igualar a la página anterior»**; el ajuste fino por página es arrastrar. Un campo de texto seleccionado muestra su etiqueta, su **origen de dato** (lista corta de `dataKeys`) y, si es fecha, la regla «hoy». Guardar = PDF base + plantilla (versión nueva si ya existía) con la línea fija «Se guarda una copia de este PDF en este navegador; usa contratos en blanco, sin datos de clientes», la petición de almacenamiento persistente con su resultado («concedido / no concedido / el navegador no lo ofrece») y el mensaje **«Plantilla guardada · aplicada a N páginas»**; después, «Firmar este documento» lo abre en Firmar con la plantilla aplicada.
- **Aplicación automática al cargar** (Ajustes → «Plantillas de documento», dos interruptores, ambos activados por defecto: «Aplicar plantillas automáticamente» y «Detectar campos automáticamente»). Por cada archivo nuevo de la ronda (1 o varios) se calcula la huella en segundo plano (worker) y se busca en la biblioteca:
  - **Coincide** → se aplica la plantilla (pasa a «Varios firmantes», crea los firmantes con el nombre de su rol y pone los campos) con el aviso **«Plantilla «X» aplicada · Deshacer»**, el cambio **1 / 2 firmantes** (re-aplica la variante sin perder el trazo cuyos huecos no cambiaron: el campo que queda donde estaba conserva su id), **«Ir a firmar»** y **«Revisar campos»**. Las páginas que cambiaron (`reviewPages`) NO se aplican solas: el aviso trae **«Revisar las páginas 3 y 5 (N)»** con cada campo «Añadir» / «Ir a la página» / «Añadir todas».
  - **Parece (85 %)** → «Parece la plantilla «X» (85 %) · Usar / No» (nada se aplica hasta decir «Usar»).
  - **Sin coincidencia** → con «Varios firmantes», el automapeo corre solo y APLICA lo de confianza alta («Detectamos N campos automáticamente · Revisar / Deshacer», con firmantes 1/2) y deja el resto en **«Sugerencias (M)»**; las firmas «sin firmante claro» (p. ej. la de la otra parte) solo se añaden de una en una. En «Solo yo» un documento desconocido NO cambia el modo: espera a que se elija «Varios firmantes» (o se pulse «Detectar campos automáticamente» en el paso Documento). Tras firmar, la pantalla final ofrece **«¿Guardar «X» como plantilla para la próxima vez?»**.
  - Un archivo restaurado (borrador, sesión, configuración importada, «Deshacer» de documentos quitados) o un documento con trabajo hecho NUNCA recibe una plantilla encima.
- **Traspaso desde «Mis documentos»** (`takeSignHandoff()` al montar, una sola vez): `sign` abre los documentos guardados como si se hubieran subido y aplica la plantilla de cada uno (sin buscar por huella); `configure` abre el editor con el PDF base y su plantilla; un id que ya no existe dice «Un documento ya no está en Mis documentos y no se pudo abrir.».
- **Plantillas antiguas (`localStorage`)** siguen igual; al aplicar una a un PDF aparece «Convertir a plantilla de este documento».

**Toques** (E2E, contrato sintético de 6 páginas, 2 firmantes; un toque = un clic o un arrastre sobre la hoja; escribir y trazar la firma no cuentan): configurar la plantilla una vez con el editor: **16**; **con plantilla**: de la carga a la ceremonia **2** (subir el PDF, «Ir a firmar»); de la carga a la descarga con las firmas e iniciales de los 2 firmantes **18** (la ceremonia de dos firmantes son 14 toques + «Firmar y descargar» + «Descargar»). **Sin plantilla** (aplicación y detección apagadas): de la carga a la ceremonia **53**. Con plantilla los nombres de los firmantes son los de sus roles, así que no se pregunta el prefijo del archivo. El objetivo «≤ 8 toques hasta descargar» no se alcanza con la ceremonia por turnos (7 toques por firmante) sin cambiarla; lo que la plantilla elimina es todo lo anterior (53 → 2).

**Archivos.** Nuevos en `src/app/sign-pdf/`: `TemplateEditor.tsx`, `TemplateNotices.tsx`, `templateEditorModel.ts` (modelo puro: historial, lienzo ↔ variante, iniciales, copiar variante, detección), `templateSession.ts` (puro: documento limpio, firmantes, aplicar/re-aplicar con ids reutilizados, deshacer, aceptar), `useTemplateController.ts` (controlador por herramienta: huella → búsqueda → aplicar / preguntar / automapear), `templateLibrary.ts` (guardar PDF base + plantilla, abrir un documento guardado, sembrar desde la sesión), `templateEditorEntry.ts`, `templatePicker.ts`, `templateFileRegistry.ts`, `templatePrefs.ts`, `templateStrings.ts` (bloque `strings.template`, ES/EN) y sus pruebas. Tocados: `SignToolClient.tsx` (único archivo caliente: botones, controlador, avisos, traspaso, editor oculto/visible, «Detectar campos» en el paso Documento, prefijo del archivo), `strings.ts` (una línea `template:`), `signFeatureFlags.ts` (`autoApplyTemplates`, `autoDetectFields`, aparte de `SignPdfFeatureFlag` para no tocar los textos de Ajustes de `locales/`), `SettingsView.tsx` (bloque «Plantillas de documento»), `playwright.config.ts` (`sign-templates*` en `webkit-ipad`). Sin cambios en `docLibrary/*`, `autoMap*` ni `signHandoff.ts`.

**Decisiones.** (1) Aplicar una plantilla pasa a «Varios firmantes» (con aviso y «Deshacer» que devuelve «Solo yo»); el automapeo, que no está ligado a un documento ya configurado, no cambia el modo por su cuenta. (2) El nº de firmantes es el que ya hay; si no hay, el último usado (`localStorage`, un 1 o un 2) y, si no, 2 cuando la plantilla lo permite. (3) Los nombres de personas NUNCA entran en una plantilla: los roles son los de la plantilla (o «Asegurado / Co-asegurado»). (4) El editor es la herramienta con `hidden` (no se desmonta: no se pierde nada). (5) El selector de PDF del botón «Configurar plantilla» se crea al pulsar y se quita después: no hay un segundo `input[type=file]` de PDF fijo en la página (varios E2E antiguos usan el selector sin `.first()`). (6) Guardar valida el contenido ANTES de guardar el PDF y, si la plantilla falla después, deshace el alta del documento (sin PDF huérfano). (7) El aviso de progreso del automapeo no se pinta hasta pasados 800 ms (no mueve nada bajo el dedo). (8) La regla «hoy» y el origen de dato se GUARDAN (Fase 3 los usa); no se rellenan solos todavía.

**Pruebas.** Vitest (141 nuevas en 9 archivos + 2 omitidas opcionales con contratos reales): `templateEditorModel` 29, `templateSession` 26, `templateLibrary` 10 (IndexedDB falso, huella real: guardar, reexportar → «Coincide» y campos en su sitio, rollback, `conflict`), `useTemplateController` 22 (coincide / parece / sin plantilla, 1↔2 firmantes, no sobreescribir lo restaurado ni lo trabajado, varios documentos, traspaso), `TemplateEditor` 20, `TemplateNotices` 12, `SignToolClient.templates` 16 (la herramienta entera con IndexedDB falso: aplicar, deshacer, 2→1, traspaso `sign` / `configure` / ids inexistentes, plantilla antigua → convertir), `templatePicker` 2, `SettingsView.templates` 4. Con `F2_REAL_PDFS=1`: **501 archivos (498 pasan, 3 omitidos), 11 690 pruebas pasan, 10 omitidas** (antes 488 / 11 543). `tsc` y `eslint` sin errores. E2E (build de producción, `CSP_SKIP_UPGRADE_INSECURE=1`, `CI=1`, puerto 3961, headless): `sign-templates.spec.ts` (9: (i) configurar → recargar → reexportado → campos solos → 2 firmantes → PDF con iniciales en TODAS las páginas una al lado de la otra, firmante 1 a la izquierda, 4 trazos distintos, ninguna petición externa; (i-b) toques sin plantilla; (ii) desconocido → automapeo → sugerencias → guardar → reconocido; (iii) 2 → 1 firmante conservando el trazo; (iv) página distinta → «Parece» → «Revisar»; (v) traspaso; (vi) persistencia y versión nueva; (vii) 2 documentos con su plantilla → ZIP; (viii) sesión restaurada no se pisa), `sign-templates-a11y.spec.ts` (2: axe 0 violaciones en claro/oscuro × ES/EN × 1280/375 del editor, de «Parece», de «Plantilla aplicada» con páginas a revisar y del automapeo, y controles de 44 px) y `sign-templates-wide-font.spec.ts` (4 celdas, fuente ancha, 375 y 320 px, ES/EN, claro/oscuro): Chromium: los 3 archivos nuevos **15 pasan**; regresión completa (`sign-*`, `signature-font`, `recent-continue`, `a11y-sweep`, `tool-errors`, `focus-own-headers`, 2 trabajadores, 1 reintento) **511 pasan, 0 fallan** y, tras el último ajuste de maquetación (aviso de progreso con plazo y contenedor sin caja), `sign-assignment*`, `sign-multi`, `sign-wide-font`, `sign-templates*` y `sign-privacy` otra vez: **96 pasan**. `webkit-ipad`: los 3 archivos nuevos (11 pruebas: el editor y los avisos; la fuente ancha solo en Chromium) pasan; regresión (`sign-*`, `signature-font`, `recent-continue`, `a11y-sweep`, `tool-errors`, `focus-own-headers`): **349 pasan, 12 intermitentes, 5 omitidas** y, tras corregir su causa (ver abajo), `recent-continue`, `sign-ceremony-turns`, `sign-draft-safety`, `sign-privacy` y `sign-recovery`: **129 pasan, 4 omitidas, 1 falla** (`sign-recovery` (d) «recarga 100 ms»: ya fallaba igual en el árbol sin estos cambios, 3 de 4 veces) y el conjunto final de 212 (nuevos, `sign-assignment`, `sign-multi`, `sign-quality`, `signature-font`, `sign-upload-*`, `sign-backup-merge`, `sign-record`, `sign-edit-summary`, `sign-stale-signature`, `a11y-sweep`): **211 pasan, 1 omitida**. Mutaciones: `python3 scripts/templates-ui-mutate.py` aplica 43 mutaciones (4 equivalentes se retiraron): **39 de 39 mueren**; en la primera pasada sobrevivieron 13 (cada una recibió prueba o se retiró por equivalente). Contratos REALES (`OPTIMUS_REAL_CONTRACTS_DIR`, solo números): los 9 en blanco con el automapeo aplicado a Firmar dejan ≤ 12 campos por página (máx. 12, 10, 10, 12, 10, 10, 10, 9, 12); MOLD_TEST (8 págs.): plantilla configurada y guardada con 39 campos, su reexportación se reconoce («Coincide», 100 %) y se aplican los 39 sin páginas a revisar.

**Fallos reales que destapó (ya corregidos).** (1) `planAutoMapApplication` no retiraba el firmante creado al bajar de 2 a 1 firmante (prueba del controlador). (2) Guardar con un contenido no válido dejaba un PDF huérfano en la biblioteca (prueba de `templateLibrary`; ahora se valida antes y se deshace el alta). (3) Un `input[type=file]` extra con `accept` de PDF rompía 3 E2E antiguos de `sign-multi` (selector sin `.first()`): ahora se crea al pulsar. (4) El botón nuevo en la barra superior y un contenedor vacío en el apilado desplazaban 44 y 24 px el contenido del paso Firmantes y `sign-assignment-a11y` (axe `target-size`) dejó de pasar: el botón va ahora en la herramienta vacía y los avisos no dejan ni un contenedor vacío. (5) La fila «Detectar campos» desbordaba 16 px con fuente ancha (`sign-wide-font`): ahora se apila en estrecho. (6) En `webkit-ipad` 12 pruebas antiguas se volvían intermitentes: el aviso «Buscando campos…» aparecía y desaparecía empujando lo de debajo justo cuando la prueba tocaba «Añadir firmante»; ahora el progreso solo se pinta pasados 800 ms (casi ningún PDF llega) y el contenedor de avisos no genera caja (`display: contents`).

**No verificado.** Safari / iPad reales (solo el WebKit de Playwright con perfil iPad Pro 11); Firefox; contratos escaneados con plantilla (la huella por imagen solo se sugiere, nunca se aplica sola: U2.1); varios cientos de plantillas; el rendimiento de la huella con PDF de más de 100 páginas dentro de Firmar; el almacenamiento persistente real (solo se comprobó el mensaje cuando el navegador lo niega o no lo ofrece); la regla «hoy» y el origen de dato no se aplican (Fase 3); «Mis documentos» (U2.5, otro agente) solo está probado por el contrato `signHandoff`, no por su pantalla.
### Correcciones F2 tras verificación (defectos MAYORES y menores, 2026-10-16)

La verificación independiente de U2.3 + U2.4 y U2.5 + U2.6 destapó tres defectos MAYORES en los que la persona perdía trabajo sin enterarse, y cinco menores. Cada uno se reprodujo ANTES con una prueba que fallaba (unitaria y E2E; el E2E se corrió contra la build del árbol sin los cambios: A1, A2 y A3c fallaban, los controles «nada que perder» pasaban) y luego se corrigió.

**Qué cambia para el usuario.**
- **Cambiar el nº de firmantes (1 / 2 firmantes del aviso «Plantilla … aplicada») ya no descarta trabajo en silencio (MAYOR 1).** Si el cambio quitaría a un firmante que ya tiene la firma o las iniciales recogidas, un nombre real escrito (distinto del que le dio la plantilla) o valores escritos en campos que la otra variante no tiene, NO se toca nada y se abre una hoja de confirmación: «¿Cambiar a 1 firmante?» · «Cambiar a 1 firmante quitará la firma de Marta Ruiz. ¿Continuar?» · «Quitar y cambiar» (rojo) / «Cancelar», ES/EN, botones de 44 px, foco atrapado en la hoja y devuelto al segmento al cerrar. **Cancelar** deja todo igual (firmantes, nombres, campos y trazos; el aviso sigue en «2 firmantes»). **Quitar y cambiar** quita SOLO lo anunciado (el firmante 2 y su firma): los trazos del firmante 1 se conservan. Si no hay nada que perder (nombres genéricos, sin trazos del firmante que se va; los trazos del que se queda no cuentan) el cambio sigue siendo inmediato y sin diálogo; subir de 1 a 2 firmantes nunca pregunta. Lo mismo vale para el automapeo y para «guardar y aplicar» desde el editor.
- **«Deshacer» ya no borra el trabajo hecho (MAYOR 2).** Decisión (la más segura): el botón «Deshacer» del aviso SOLO se ofrece mientras no haya trabajo de la persona que pudiera arrastrar (firmante creado por la plantilla con trazos o con un nombre escrito, o valores escritos en los campos de la plantilla); con trabajo hecho el aviso queda informativo («Ir a firmar», «Revisar campos», 1 / 2 firmantes). Además `planUndo` es seguro por sí mismo: nunca retira un firmante con trabajo, no cambia el modo si queda alguno y conserva los valores escritos (solo borra los vacíos); y `undo()` se niega (con un anuncio) si se llega a él de todos modos. Sin trabajo hecho «Deshacer» funciona como siempre (retira campos, firmantes creados y vuelve a «Solo yo»).
- **«Reemplazar PDF» en «Mis documentos» deja la plantilla «desactualizada» (MAYOR 3).** Si el PDF nuevo no es el mismo contrato (mismo contenido o «Coincide» sin páginas por revisar), la tarjeta pasa de «✓ Plantilla lista» a **⚠ «Plantilla desactualizada»** (icono + texto, nunca solo color) con la frase «Cambiaste el PDF y ya no coincide…», **«Reconfigurar»** (en lugar de «Configurar plantilla») y **«Esta plantilla sigue valiendo»**; el aviso persiste (se guarda en IndexedDB) hasta que la persona reconfigure (guardar la plantilla en el editor) o confirme que sigue valiendo. Pasa igual en Inicio y en `/documents`, con plantilla de 1 firmante o de 2; un documento sin plantilla (✗) nunca queda desactualizado; reemplazar por el mismo contrato reexportado no la desactualiza. **«Firmar»** (traspaso por id) ya no asume «exacto 100 % + mapa identidad»: calcula la huella del PDF REAL y la compara (`findBestMatch`) con la del PDF sobre el que se configuró la plantilla; si coincide («Coincide») se aplica con su mapa de páginas, si «Parece» pregunta y si no coincide NO se aplica nada, se avisa («La plantilla de «X» está desactualizada… Reconfigúrala en Mis documentos.») y, con «Varios firmantes», sigue el automapeo. Subir a mano el contrato ANTERIOR sigue reconociéndose con esa plantilla; subir el de reemplazo ya no.
- **m1 · oferta final honesta.** «¿Guardar «X» como plantilla?»: «Se guardará una copia de este PDF en este navegador, con las posiciones de las firmas y de los campos (nunca las firmas que trazaste). Si este PDF contiene datos de un cliente, no lo guardes.» y el botón «No guardar» (antes «Ahora no»). Ya no promete una «copia en blanco».
- **m2 · guardar como plantilla no borra la otra variante.** Guardar desde Firmar con 1 firmante (o con 2) un PDF que ya tiene plantilla sustituye solo esa variante; la otra, el nombre, los roles y el diseño de iniciales se conservan (no se hace con una plantilla desactualizada: su otra variante describe el PDF de antes). El editor sigue pudiendo dejar una variante vacía a propósito.
- **m3 · el tope de 80 campos se ve.** Si el automapeo llega al tope por documento (`document-field-cap`), el aviso dice «Se colocaron N campos, el máximo por documento; K páginas quedan sin iniciales. Revisa esas páginas y añade lo que falte.» con «Páginas sin cubrir (K)» → «Ir a la página N» (y el editor, al «Detectar campos», lo avisa también).
- **m5 · el editor no pierde lo editado si el documento se borró en otra pestaña.** Ante un conflicto de guardado el mensaje explica qué pasó («Otra pestaña modificó o borró este documento o su plantilla… Tus cambios siguen en pantalla») y aparece **«Guardar como documento nuevo»**, que guarda lo editado como documento y plantilla nuevos (sin reutilizar el documento de antes ni tocar la plantilla huérfana).
- **m4 · limitación documentada (sin interfaz nueva).** Al borrar un documento sus plantillas NO se borran: quedan «sin documento» (`documentId: null`, a propósito, son trabajo de la persona). Ninguna pantalla las lista, reasigna ni borra (el almacén sí tiene `attachTemplate` y `deleteTemplate`) y no cuentan para el reconocimiento por huella ni para el estado de «Mis documentos»: son invisibles hasta que una unidad futura ofrezca «Plantillas sin documento». Ocupan cupo (200 en total).

**Cómo (archivos).** `templateSession.ts` (`WorkLoss`, `signerWork`, `lossOf`, `Plan.loss`, `undoWork`, `planUndo` seguro, `AppliedRecord.createdNames`), `useTemplateController.ts` (`PendingChange`, `confirmChange` / `cancelChange`, `ApplyOutcome`, guarda de `undo`, traspaso con plantilla desactualizada, `cap`, `onStaleSkipped`), `TemplateNotices.tsx` (`ChangeConfirm`, `CapPanel`, «Deshacer» condicionado a la sesión), `templateStrings.ts` (ES/EN), `SignToolClient.tsx` (unas pocas líneas: pasa `session` a los avisos y `onStaleSkipped` al controlador); biblioteca: `types.ts` (`TemplateStale`, campo ADITIVO `DocumentEntry.templateStale`), `schema.ts` (`parseTemplateStale`: un valor mal formado se lee como «al día», nunca invalida el documento), `templateStale.ts` (`staleVerdict`), `store.ts` (`replaceDocumentBytes` marca/limpia el aviso, `markTemplatesCurrent`, `putDocument` lo conserva), `templatesStore.ts` (el reconocimiento por huella usa la huella BASE; quitar la última plantilla limpia el aviso), `persist.ts` (el aviso viaja en exportar/importar/restaurar); `templateLibrary.ts` (`keepOtherVariant`, `asNewDocument`, reconfigurar limpia el aviso), `TemplateEditor.tsx`; «Mis documentos»: `documentsModel.ts` (`badgeKind(status, stale)`, `isTemplateStale`), `TemplateBadge.tsx`, `DocumentCard.tsx`, `documentActions.ts` (`keepTemplate`), `MyDocumentsView.tsx`, `MyDocumentsHomeSection.tsx`, `locales/{es,en}.ts` (claves `documents.statusStale`, `staleHint`, `reconfigure*`, `keepTemplate*`, `announceKept`, y los avisos de reemplazo).

**Esquema y migración.** Sin cambios de IndexedDB (sigue en v2: mismos almacenes e índices). `DocumentEntry.templateStale?: { since, level, percent, base: Fingerprint }` es un campo aditivo: las entradas de la v2 ya publicada no lo traen y se leen igual (prueba que siembra una base v2 «tal como la escribía la versión publicada», comprueba que no se migra nada y que reemplazar el PDF escribe el campo nuevo). `base` es la huella del PDF sobre el que se configuró la plantilla (pegajosa: A→B→C se compara siempre con A; volver a poner un PDF que coincide con A deja la plantilla al día). Una app anterior que lea una entrada con `templateStale` la ignora (el campo no se valida allí).

**Pruebas.** Vitest (suite completa con `F2_REAL_PDFS=1`): **510 archivos (507 pasan, 3 omitidos), 11 939 pruebas (11 929 pasan, 10 omitidas), 0 fallos** (antes 506 / 11 833); ≈ 106 pruebas nuevas: `templateSession.test.ts` (pérdida de trabajo en todas las ramas: nada que perder → `NO_LOSS`, trazos del que se va, nombre real, valores huérfanos, subir de 1 a 2, automapeo; `undoWork` / `planUndo` seguro), `useTemplateController.test.tsx` (confirmar / cancelar / confirmar quita solo lo anunciado, nombre real, valores, sin nada que perder → sin pregunta, segmento bloqueado con la pregunta abierta, automapeo, Deshacer con trazos / nombre / valores, traspaso con plantilla desactualizada con `findBestMatch` REAL —otro contrato, mismo contrato reexportado, «Parece», plantilla al día, automapeo apagado—, tope de campos, guardar conserva la otra variante), `TemplateNotices.test.tsx` (hoja ES/EN, «Deshacer» condicionado, panel del tope, oferta honesta), `templateStale.test.ts` (`staleVerdict`; `replaceDocumentBytes` + estado desactualizado pegajoso; **migración**: base v2 «tal como la escribía la versión publicada» se lee igual y sin migrar; campo mal formado = al día; `markTemplatesCurrent`; borrar la última plantilla; reconocimiento por huella BASE; exportar → importar → restaurar), `templateLibrary.test.ts` (m2 en 5 casos, m5), `MyDocumentsView.test.tsx` / `.en.test.tsx` / `MyDocumentsHomeSection.test.tsx` / `documentsModel.test.ts` (tarjeta ✗ / ✓ / ✓ de 1 firmante / ⚠ desactualizada con icono + texto, «Reconfigurar», «sigue valiendo», «Firmar» deja el traspaso, volver a poner el contrato original la deja al día), `TemplateEditor.test.tsx` (m3, m5). `tsc` 0 errores; `eslint` 0 errores (1 aviso previo en `inputChecks.clients.test.tsx`).

E2E (build de producción con `CSP_SKIP_UPGRADE_INSECURE=1`, `CI=1`, puerto 3963, headless, 2 trabajadores). Archivos nuevos: `sign-templates-no-loss.spec.ts` (4: **A1** con firma e iniciales de los 2 firmantes y un nombre real para el 2, «1 firmante» → hoja → Cancelar conserva todo → Quitar y cambiar quita solo al firmante 2 y el 1 sigue firmado → volver a 2 sin diálogo; **A1-b** sin nada que perder es inmediato; **A2** «Deshacer» desaparece con un nombre escrito o con firmas y nada se borra; **A2-b** sin trabajo sigue funcionando), `sign-templates-stale.spec.ts` (4: **A3c** replace por otro contrato → tarjeta ⚠ → «Firmar» no aplica la plantilla vieja, avisa y ofrece el automapeo; «sigue valiendo» → se aplica; «Reconfigurar» + guardar → al día; mismo contrato reexportado no la desactualiza) y `sign-templates-no-loss-a11y.spec.ts` (2: axe-core **0 violaciones** de la hoja, del aviso y de la tarjeta desactualizada en claro/oscuro × ES/EN × 1280/375; botones ≥ 44 px, sin desbordes). Contra la build SIN estos cambios: A1, A2, A3c, A3c-b y A3c-c **fallaban** (5 de 8) y los controles A1-b, A2-b y A3c-d pasaban. Regresión **Chromium** (`sign-templates*`, `sign-assignment*`, `my-documents`, `sign-ceremony-turns`, `sign-multi`, `sign-recovery`, `recent-continue`, `a11y-sweep`, `sign-wide-font`): **247 pasan, 0 fallan, 0 intermitentes**. **`webkit-ipad`** (los mismos que corren allí): **210 pasan, 3 omitidas, 0 fallan**; los 10 E2E nuevos pasan también ahí. Mutaciones: `python3 scripts/templates-f2fix-mutate.py` aplica 39 (perdida de trabajo, `planUndo`, confirmación, traspaso con plantilla desactualizada, tope, almacén, esquema, biblioteca, interfaz): en la primera pasada sobrevivieron 5 (`F07`, `C10`, `L03`, `U05`, `U06`; cada una recibió su prueba); **39 de 39 mueren**. Pruebas existentes ajustadas (exigían el texto erróneo): el texto y el botón de la oferta final («Ahora no» → «No guardar», sin «copia en blanco») en `TemplateNotices.test.tsx` y `sign-templates.spec.ts` (ii), y los constructores de avisos de `TemplateNotices.test.tsx` (campos nuevos `createdNames`, `confirm`, `cap`).

**Hallazgos de paso.** `e2e/specs/sign-templates-a11y.spec.ts` está VACÍO (0 bytes) en el árbol principal: la unidad U2.3 + U2.4 declara 2 pruebas de axe en ese archivo que no existen (no se ha tocado; las nuevas de esta unidad están en `sign-templates-no-loss-a11y.spec.ts`).

**No verificado.** Safari / iPad reales (solo el WebKit de Playwright con perfil iPad Pro 11); el foco devuelto al cerrar la hoja se comprueba solo en Chromium (el enfoque al hacer clic difiere entre motores); copias de seguridad reales de la biblioteca con avisos (solo el ciclo serializar → deserializar → restaurar en una prueba; la interfaz de respaldo sigue «Próximamente»); varias pestañas editando a la vez el mismo documento más allá del conflicto de `rev`.
### Correcciones F2 (2ª ronda): residuales de la 2ª verificación independiente (2026-10-16)

La segunda verificación independiente encontró dos defectos MAYORES, uno MENOR, un hueco de cobertura y dos observaciones. Cada uno se reprodujo ANTES con una prueba que fallaba y luego se corrigió. Los sondeos del verificador (Z6, Z9, Z10, Z11, Z12 y V1) son ahora pruebas definitivas, sin el prefijo `zz`.

**Qué cambia para el usuario.**
- **F1 (MAYOR) · cambiar de variante ya no invalida la firma del firmante que SE QUEDA.** Con una plantilla cuya variante de 1 firmante tiene huecos de iniciales distintos de los de la de 2 (p. ej. a ancho completo, x 0,74 · w 0,13, frente a una al lado de la otra, ~6 % del ancho), «Quitar y cambiar» (2 → 1), el cambio 1 → 2 con la firma del 1 ya recogida y el automapeo dejaban al firmante que se queda en «Debe volver a firmar · cambiaron los huecos de firma», sin que la hoja lo dijera. Ahora su firma y sus iniciales siguen valiendo sobre los huecos nuevos (el PDF las reescala a la caja del hueco) y la hoja solo nombra a quien de verdad se pierde. Nada se invalida en silencio: 1 → 2 no necesita diálogo porque no se pierde nada, y 2 → 1 sigue preguntando solo por el firmante que se va.
- **F2 (MAYOR) · «Crear / Configurar plantilla de este documento» → Guardar → «Firmar este documento» ya no duplica los campos ni invalida las firmas**, tampoco sin aviso previo (borrador restaurado, firmados los 2: antes 14 → 28 campos y firmas caducadas). Los campos que ya estaban se reconocen y se reemplazan por los de la plantilla guardada (mismo id si no cambiaron; un hueco movido en el editor conserva su id y su firma; lo que se quitó en el editor se quita). Si el reemplazo quitara valores escritos, se pide confirmación como siempre y, al confirmar, tampoco se duplica.
- **F3 (MENOR) · bajar un documento a 1 firmante no retira al firmante 2 si otro documento de la sesión tiene campos suyos** (antes quedaban huérfanos sin hoja). Se queda en la sesión, sin campos en ese documento, y el aviso lo dice («Co-asegurado se queda como firmante de la sesión porque otro documento tiene campos suyos…», ES/EN, también en la región viva). No cuenta como pérdida aunque tenga trazos.
- **OBS · la hoja «¿Cambiar a 1 firmante?» aísla de verdad el fondo**: mientras está abierta, el resto de la página queda `inert` (sin foco, sin clic, fuera del árbol de accesibilidad); Tab no sale, Escape cancela y el foco vuelve al segmento. Con hojas apiladas el fondo no se destapa hasta cerrar la última. Es opcional en `Sheet` / `ConfirmSheet` (`inertBackground`, por defecto apagado: el resto de hojas de la aplicación no cambia).
- **OBS · con varios archivos con la plantilla desactualizada, el aviso nombra TODOS** (antes ganaba el último). Se acumulan sin repetir nombres; al llegar un aviso nuevo se descartan los de archivos que ya no están cargados.

**Consistencia con el registro de firmas y la ceremonia por turnos (F1).** El trazo vive en el bloque del firmante (`SignerBlock`), no en el hueco; lo que lo ata a un estado del documento es su sello por documento, `stamps[docId]` = `huella~hueco~hueco…` (`captureStamp`: id, página, tipo y rect de los huecos del firmante). La ceremonia (`isBlockComplete`, `staleSigners`) y el PDF final solo dan por buena una firma cuyo sello coincide con el de ahora. `restampKeptSigners` (en `templateSession.ts`, dentro del parche que escribe `planTemplateApplication` / `planAutoMapApplication`) recalcula el sello del firmante que se queda sobre los huecos nuevos SOLO si el sello valía antes del cambio (se comprueba contra los huecos de antes, con la huella con que se hizo) y conserva esa misma huella: una firma ya caducada (otro archivo, texto editado, huecos movidos a mano) no se revalida, y los sellos de los demás documentos del bloque no se tocan. La asociación firmante ↔ trazo no cambia. El registro de firmas (`signRecord.ts`) se calcula al descargar a partir del PDF entregado (hash, firmantes, páginas) y no guarda ids de hueco ni sellos: no necesita cambios. Además, la identidad de un hueco es ahora «firmante + página + tipo» (`reuseFieldIdsByRole`, segunda pasada tras `reuseFieldIds`): cambiar de variante o mover un hueco cambia su tamaño o su sitio, no su id.

**Marca de origen (F2).** No se añadió ningún campo persistido a los huecos: la identidad que ya usan el sello y `AppliedRecord.spots` (firmante, página, tipo y rect) basta para reconocer lo que ya estaba, no cambia el formato de los borradores (los borradores sin marca siguen leyéndose igual) y no hace falta migrar nada. Al aplicar lo guardado (`planTemplateApplication({ replaceDocument: true })`, solo desde `applySaved`, porque el editor se abre con los campos de ese mismo documento) todos los huecos de los firmantes de rol y los campos de texto a mano pasan a considerarse «de la plantilla»; los huecos de otros firmantes y los de la detección automática (AcroForm) no se tocan. El `AppliedRecord` resultante marca el origen para «Deshacer» y las siguientes re-aplicaciones.

**Cómo (archivos).** `templateSession.ts` (`restampKeptSigners`, `reuseFieldIdsByRole`, `retainSigners`, `signerUsedElsewhere`, `replaceDocument`, `AppliedRecord.keptSigners`), `useTemplateController.ts` (`applySaved` reemplaza; `PendingChange.replaceDocument`; anuncio del firmante que se queda), `TemplateNotices.tsx` (nota `data-template-kept`; la hoja pide `inertBackground`), `templateStrings.ts` (ES/EN), `components/ui/Sheet.tsx` y `ConfirmSheet.tsx` (`inertBackground`, con cuenta de peticiones para hojas apiladas y sin destapar lo que ya era `inert`), `SignToolClient.tsx` (archivos desactualizados acumulados), `playwright.config.ts` (`sign-templates-variants` en `webkit-ipad`). F4: el mutante «`strokes` solo cuenta `signature`, no `initials`» ahora muere (`signerWork` con solo iniciales y con solo firma).

**Pruebas.** Vitest (suite completa con `F2_REAL_PDFS=1`): **510 archivos (507 pasan, 3 omitidos), 11 980 pruebas (11 970 pasan, 10 omitidas), 0 fallos** (antes 510 / 11 939); +41 pruebas: `templateSession.test.ts` (sellos del que se queda en 2 → 1, 1 → 2, automapeo, varios documentos, huella con ediciones de texto, firma ya caducada que no se revalida, solo iniciales; ids por rol; reemplazo del documento con valores, huecos movidos, otros firmantes y AcroForm; firmante compartido; F4), `useTemplateController.test.tsx` (con el predicado REAL de la ceremonia `isSignerDone`: 2 → 1, 1 → 2, automapeo, borrador restaurado + `applySaved`, valores que piden confirmar y no duplican al confirmar, V1 de dos documentos), `TemplateNotices.test.tsx` (fondo `inert`, Escape y foco, nota del firmante que se queda ES/EN), `Sheet.test.tsx` (opción apagada por defecto, restauración, hojas apiladas, `inert` previo, foco devuelto sobre algo ya no inerte) y `SignToolClient.templates.test.tsx` (todos los archivos desactualizados, sin repetir). `tsc` 0 errores; `eslint` 0 errores (1 aviso previo en `inputChecks.clients.test.tsx`).

E2E (build de producción con `CSP_SKIP_UPGRADE_INSECURE=1`, `CI=1`, puerto 3965, headless, 2 trabajadores, sin reintentos). Archivo nuevo `sign-templates-variants.spec.ts` (6, con una plantilla de DOS variantes de huecos distintos y comprobando el PDF final: trazos del firmante que se queda, sin duplicados, en los huecos de la variante que toca): **F1-a** (Z11: 2 → 1 con los dos firmados; la hoja nombra solo al 2; Cancelar conserva; Quitar y cambiar deja firmado al 1), **F1-b** (Z12: 1 → 2 sin diálogo; el 1 sigue firmado; el 2 firma; 4 trazos distintos), **F1-c** (Z10: automapeo), **F2-a** (Z9: borrador restaurado sin aviso, 14 campos antes y después), **F2-b** (Z6: con aviso) y **OBS** (fondo `inert`, Tab, Escape, foco y toque en el fondo). Contra la build SIN estos cambios fallaban F1-a, F1-b, F1-c, F2-a (28 campos en vez de 14) y OBS; F2-b (el caso con aviso, ya corregido en la ronda anterior) pasaba. Con los cambios: Chromium (`sign-templates*`, `sign-assignment*`, `my-documents`, `sign-ceremony-turns`, `sign-multi`, `sign-recovery`, `recent-continue`, `a11y-sweep`, `sign-wide-font`): **255 pasan, 0 fallan, 0 reintentos**; `webkit-ipad` (los mismos que corren allí): **218 pasan, 3 omitidas, 0 fallan**. axe-core 0 violaciones de la hoja de confirmación y del aviso (`sign-templates-no-loss-a11y`, claro/oscuro × ES/EN × 1280/375, ya con el fondo `inert`).

**Mutaciones.** `python3 scripts/templates-f2fix2-mutate.py` aplica 32 mutaciones (sellos, ids por rol, reemplazo del documento, firmante compartido, trabajo con solo iniciales/firma, fondo `inert`, archivos desactualizados): **32 de 32 mueren**. En la primera pasada de las 30 que había entonces sobrevivieron 4 (el sello rehecho tocaba los de otros documentos, el fondo no se destapaba al cerrar solo porque jsdom no impide enfocar un elemento inerte, el mismo archivo anotado dos veces y un patrón mal apuntado del automapeo); cada una recibió su prueba y se añadieron 2 mutaciones más (confirmar tras guardar desde el editor).

**Límites / no verificado.** Safari / iPad reales (solo el WebKit de Playwright con perfil iPad Pro 11); la prueba de Tab dentro de la hoja solo corre en Chromium (WebKit no recorre botones con Tab por defecto) y el foco devuelto al segmento también. El reemplazo de «Firmar este documento» reconoce lo que ya estaba por su sitio exacto o por firmante + página + tipo; un campo de texto movido en el editor recibe un id nuevo (su valor escrito se pregunta antes de perderlo, no se conserva solo). Otras hojas de la aplicación siguen sin `inertBackground` (queda como mejora de accesibilidad opt-in). F3 solo se probó con pruebas unitarias y de integración (no hay E2E con dos documentos de firmantes compartidos).

### Cierre de la 3.ª verificación (orquestador)

- Residual MAYOR (AcroForm duplicado en cada ciclo «editor → guardar → Firmar este documento»): `planTemplateApplication` ya no añade un campo de la plantilla que cae sobre un AcroForm del propio PDF (misma página y tipo, solape > 50 %); el AcroForm adopta su `dataKey`/regla (`overlapRatio`, `templateSession.ts`). Prueba de 3 ciclos que falla sin el cambio.
- Menor: al aplicar lo guardado desde el editor (sin cambiar el nº de firmantes) la hoja ya no dice «¿Cambiar a N firmantes?», sino «¿Aplicar la plantilla guardada?» (`replaceTitle`/`replaceBody`).
- Pendientes menores conocidos: firmante huérfano y aviso `keptSigners` viejo tras quitar el otro documento que lo usaba (no bloquea); mover un hueco tras firmar renueva el sello (diseño).
### U4.6 entregada: módulos «Ajustes» y «Borradores» del paquete (librería, SIN interfaz; 2026-10-20)

Parte de LIBRERÍA de U4.6 (la hoja «Respaldo y traslado» de `SettingsView.tsx` es U4.7). Mismo contenedor y mismas garantías que U4.4-lib (`readPackage`/`buildPackage`, JSON estricto, SHA-256 por archivo, límites de §9.3); aquí solo hay dos módulos más con su `PackageModuleSpec` en `registry.ts` (bloque `>>> U4.6`, solo constantes: `modules/moduleSpecs.ts`, para que cargar el registro no arrastre los almacenes de borradores).

#### Ajustes — `src/lib/backup/settingsRegistry.ts` + `modules/settings.ts` + `migrations/settings/` (esquema 1)

```
settings/settings.json        { "settings": { "<clave de localStorage de la lista blanca>": <valor ya parseado> } }
settings/value-history.json   OPCIONAL, desmarcado por defecto (PII): { "version": 1, "entries": { "<etiqueta>": [{ value, lastUsedAt }] } }
manifest.modules.settings     { schemaVersion: 1, count: <n>, includesValueHistory: <bool> }
```
- **Lista blanca (`SETTINGS_REGISTRY`)**: tema, idioma, barra lateral plegada, interruptores de Firmar (13, incluidos «Aplicar plantillas automáticamente» `autoApplyTemplates` y «Detectar campos automáticamente» `autoDetectFields`), firmantes recordados por las plantillas, interruptores de Editar y de PDF Pro, diseño de PDF Pro y los dos avisos «ya visto». Cada entrada trae `validate` (tipo, enumerado, rango entero, tope de claves), `fromStorage`, `toStorage` y valor por defecto. Los ajustes de Firmar escriben además `optimuspdf.signPdf.featureFlags.v` (clave acompañante FIJA): sin ella la migración única de la versión 1 volvería a apagar `completionCertificate` en la siguiente carga. **Nunca viajan**: `optimuspdf.lastBackup` (fecha del respaldo de CADA dispositivo), `optimuspdf.recent`, `optimuspdf.valueHistory` (solo en su archivo opcional), `optimuspdf.signTemplates` (lo lleva la biblioteca), `pro.historyHotBytes`/`pro.viewerRangeMinBytes` (diagnóstico), señales entre pestañas y `sessionStorage` (`SETTINGS_NEVER_EXPORTED_KEYS`). `settingsRegistry.test.ts` recorre el código y falla si aparece una clave `optimuspdf.*` de `localStorage` sin clasificar o si tema/idioma de su dueño dejan de coincidir.
- API: `exportSettings({ storage?, includeValueHistory? }): Promise<PackageModuleInput>` (solo claves de la lista que estén guardadas y sean válidas; sin almacenamiento, `PackageError("unavailable")`), `settingsModuleFromValues` (puro), `summarizeSettings`, `planSettingsImport(read, { storage? })` → `{ state: "ok"|"absent"|"newerVersion"|"damaged", items[{ key, status: "new"|"identical"|"different"|"invalid", value, local, localRaw }], ignoredKeys, valueHistory, counts }`, `defaultSettingsDecisions(plan)` (`{ settings: "replace"|"omit", valueHistory: "omit" }`), `applySettingsImport(plan, decisions, { storage? })` → `{ ok: true, written, skipped, valueHistory, reloadRequired }` | `{ ok: false, reason: "blocked"|"invalid"|"changed"|"unavailable" }`.
- **Importar = «Reemplazar / Omitir» y atómico en efecto**: se revalida CADA valor con el validador de su clave al aplicar (un plan manipulado por la interfaz no cuela claves ni valores), se comprueba que `localStorage` sigue como en la vista previa (`changed`) y, si una escritura falla (cuota), se restauran los valores anteriores. Claves ajenas del paquete (`__proto__`, `apiKey`, `lastBackup`…) solo se CUENTAN (`ignoredKeys`): su nombre no se muestra ni se toca. Un valor inválido aísla solo ese ajuste. `settings.json` > 64 KiB o con profundidad > 16 → módulo dañado. **Los almacenes en memoria de la app (tema, idioma, interruptores) leen `localStorage` una sola vez: tras importar, la interfaz debe RECARGAR la página** (`reloadRequired`).
- **`value-history.json`**: el historial de valores YA existe en la app (`src/lib/valueHistory.ts`), así que el campo está implementado, no solo previsto: `includeValueHistory: true` para exportarlo, mismos topes que el almacén (200 etiquetas, 5 valores por etiqueta, valores ≤ 500 caracteres; etiquetas `__proto__`/`constructor`/`prototype`, controles y marcas bidi se descartan), se escribe con SU formato y se avisa a su caché con un `StorageEvent`; importarlo exige una decisión propia (`valueHistory: "replace"`; la sugerida es `"omit"`). No hay «fusionar»: Reemplazar sustituye el historial local.

#### Borradores — `modules/drafts.ts` (+ `draftsSchema.ts`, `draftsPng.ts`) + `migrations/drafts/` (esquema 1)

```
drafts/index.json                 { sign: { documents: [..], sessions: [..] }, edit: [..], pro: [..] }
drafts/d<n>.pdf · drafts/s<n>-<i>.pdf · drafts/e<n>.pdf · drafts/p<n>.pdf     PDF del borrador (sesión: uno por documento, en orden)
drafts/<ref>-k<n>.png             trazos de firma / iniciales (en la base son data: URL; en el paquete, archivos PNG)
drafts/e<n>-session.json          sesión de Editar (items; las imágenes aparte) · drafts/e<n>-a<n>.png|jpg  imágenes añadidas
manifest.modules.drafts           { schemaVersion: 1, signDocuments, signSessions, editDrafts, proDrafts, includesStrokes }
```
La ruta de cada archivo se DERIVA del `ref` (`^[dsep][0-9]{1,3}$`) y del orden, y debe coincidir con la que cita el índice: ningún nombre ni tipo MIME del zip se cree. `fileSize`, `fileName`, `documentCount`, `pendingCount`, `steps`, `totalBytes`, `rev` y `writerId` NO viajan: se recalculan.
- **Qué entra**: Firmar (documentos sueltos y sesiones), Editar y PDF Pro. Editar lleva el PDF original + la sesión de edición + las imágenes (su formato ya era serializable con el PDF dentro). **PDF Pro lleva el snapshot ACTUAL y las etiquetas del historial** (como ya guarda la app: el historial de bytes no se guarda en ningún sitio, así que el «PDF original» no existe en su borrador). No se ha dejado nada fuera por inviable.
- **Resumen previo** `summarizeDrafts()` → `{ ok, sign:{documents,sessions,count,bytes}, edit:{count,bytes}, pro:{count,bytes}, total, withSignatureStrokes, includesSignatureStrokes, strokesHeldBack, expiredSkipped, containsClientData, encryptionRecommended, fitsInPackage }`. Solo lee metadatos. Los borradores SIEMPRE se incluyen si se piden (decisión del usuario, §10.2); `encryptionRecommended` es la casilla visible y recomendada, no obligatoria.
- **Exportar** `exportDraftsDetailed({ kinds?, includeStrokes?, now? })` → `{ module, report }` (`exportDrafts` devuelve solo el módulo). Lee SIN efectos (`peekDocumentDraft`/`peekSessionDraft`/`listDraftsForBackup`: no anotan versiones en esta pestaña —no debilitan la protección D1 entre pestañas—, no purgan, no restauran; Editar y PDF Pro usan sus `load*` de siempre, que pueden limpiar una fila corrupta). **No exporta borradores caducados** (trazos guardados hace > 7 días). **Respeta `signaturesInDraft`**: con el ajuste apagado los trazos NO viajan (el borrador sale como se guardaría hoy: `signaturesOmitted`, sin `expiresAt` ni turno guardado) aunque el borrador local aún los tenga; `includeStrokes: false` los quita aunque el ajuste esté encendido, `true` nunca los fuerza. Un borrador con un trazo que no sea un PNG canónico de ≤ 1 MiB, o al que le falte un documento, se queda fuera y se cuenta en `report.skipped`. Más de ~246 MiB → `PackageError("tooLarge")` (la interfaz debe dejar elegir `kinds`).
- **Importar** `planDraftsImport(read, { validatePdf?, validateImage?, keepStrokes?, now? })` → `{ state, items[…], counts, local, keepStrokes, includesStrokes }`. Cada borrador queda «Nuevo», «Ya lo tienes (idéntico)» (mismo CONTENIDO bajo cualquier id local, p. ej. un «conservar ambos» anterior: no duplica) o «Distinto» (mismo id, otro contenido; `conflictWith` trae fecha y versión del local y `newer`), o `invalid` con su motivo (`integrity|invalidEntry|duplicateId|invalidPdf|invalidImage|fingerprint|expired|tooLarge|tooMany`). `defaultDraftDecisions(plan)`: nuevo → importar; idéntico/inválido → omitir; distinto → reemplazar solo si el del paquete es más nuevo; si el local es igual de nuevo o más, **conservar ambos** (Firmar) u **omitir** (Editar y PDF Pro). `checkDraftsLimits(plan, decisions)` (10 borradores y 300 MiB **por almacén**, 150 MiB por sesión) y `applyDraftsImport(plan, decisions, { keepStrokes?, now? })` → `{ ok: true, written, replaced, keptBoth, skipped, strokesDropped, saved:[{kind,id}] }` | `{ ok: false, reason: "blocked"|"invalid"|"limit"|"changed"|"unavailable", limits?, partial? }`. Decisiones: `import` (solo nuevo), `replace`/`keepBoth` (solo distinto; `keepBoth` solo Firmar), `omit`; lo no aprobado explícitamente NO se escribe. Ids de `saved` → `?resume=` de Recientes: `sign-document` = `sign:<id>`, `sign-session` = `session:<id>`, `edit:<id>`, `pro:<id>`.
- **Garantías de la escritura**: NUNCA se expulsa un borrador local para hacer sitio (si no caben, `limit` sin escribir nada, comprobado antes con el plan y otra vez DENTRO de la transacción); cada almacén se escribe en UNA transacción (`commitDraftImport`, `commitEditDraftImport`, `commitProDraftImport`: miran que lo que sustituyen sigue siendo lo visto en la vista previa —fecha y `rev`—, que ningún id ocupado queda sin declarar y que cabe) y, si un almacén posterior falla, los anteriores se DESHACEN (`undo`: borra lo creado y devuelve lo sustituido byte a byte; PDF Pro conserva los trozos de un borrador troceado hasta `finalize`). **Versionado (D1)**: un borrador nuevo entra con `rev` 1; el que sustituye a otro, con `max(rev local, rev conocida) + 1`; todos con el `writerId` de esta pestaña y `announceChange({ id, rev })`, de modo que otra pestaña con esa sesión abierta recibe el aviso y guarda aparte en vez de pisarla. Se conservan `savedAt` y `expiresAt` del paquete (la caducidad NO se renueva); «conservar ambos» crea un id nuevo con nonce (`newDocumentDraftId(huella)` / `newSessionCopyId()`) y `copyOf`. Con trazos y sin caducidad en el paquete se calcula `savedAt + 7 días`; un borrador con trazos ya caducado se rechaza (`expired`). **La política de trazos se relee al aplicar**: con «guardar las firmas» apagado en ESTE navegador, los trazos del paquete se descartan (`signaturesOmitted`).
- **Seguridad de la importación**: cada valor se reconstruye campo a campo con tipo, enumerado, rango y cantidad acotados (≤ 20 firmantes, ≤ 10 documentos, ≤ 100 bloques, ≤ 200 huecos, ≤ 500 campos de texto, ≤ 500 valores de ≤ 5 000 caracteres…; una sesión con 10 000 bloques se rechaza SIN recorrerla); campos desconocidos y claves `__proto__`/`constructor`/`prototype` no llegan a lo guardado; ids con regex (64 hex / `s-…`); texto sin controles ni bidi; nombres de archivo sin rutas; fechas ISO y las del futuro recortadas a ahora. PDF: cabecera `%PDF-`, ≤ 100 MiB, `validatePdf` (la interfaz pasa `inputGuardPdfValidator()`: `inputGuard.ts`, que abre el documento con pdf.js; solo `ok` pasa) y, para Firmar y Editar, la **huella SHA-256 del PDF tiene que ser la declarada** (no se puede colar otro PDF bajo la huella de uno). Trazos: PNG de ≤ 1 MiB, ≤ 4096 px, CRC y IEND, proporción coherente con el PNG, un archivo por trazo (no compartido), y `validateImage` (la interfaz pasa `validatePngForImport`: APNG, texto enorme, bombas de píxeles). Editar: las imágenes salen de archivos verificados (un `data` incrustado en el JSON no se lee) y la sesión pasa por `editSessionFromJSON` (los elementos inválidos se descartan y se cuentan en `discarded`).
- **Límites conocidos**: (1) Editar y PDF Pro se llaman como la huella del PDF (uno por documento): no hay «conservar ambos», solo reemplazar u omitir. (2) El paquete no puede pasar de 250 MiB aunque los almacenes admitan 300 MiB. (3) La atomicidad entre los tres almacenes es por compensación (`undo`), no una transacción única (IndexedDB no abre transacciones sobre varias bases). (4) Un borrador importado entra con la `savedAt` del paquete: si es más viejo que otros, aparece más abajo en Recientes.

**Orden de llamadas para U4.7 (UI):** exportar → `summarizeDrafts()` y `summarizeSettings()` para el resumen; `exportSettings({ includeValueHistory })` + `exportDraftsDetailed({ kinds, includeStrokes })` → `buildPackage({ modules: [...], password? })` (cifrado recomendado, no obligatorio). Importar → `readPackage(file, password?)` (capturar `PackageError`) → `planSettingsImport(read)` + `await planDraftsImport(read, { validatePdf: inputGuardPdfValidator(), validateImage: async (png) => (await validatePngForImport(png)).ok })` → mostrar `items` con `defaultSettingsDecisions`/`defaultDraftDecisions` y `checkDraftsLimits` → `applySettingsImport` + `applyDraftsImport` → si `reloadRequired`, recargar.

**Cambios aditivos fuera de `lib/backup/`** (nada existente cambia de comportamiento): `signDrafts.ts` (+`isDocumentDraftMeta`, `peekDocumentDraft`, `peekSessionDraft`, `listDraftsForBackup`, `commitDraftImport`), `editDrafts.ts` (+`commitEditDraftImport`), `proDrafts.ts` (+`commitProDraftImport`), `playwright.config.ts` (el spec nuevo entra en `CROSS_SPECS`) y `goldenPackages.test.ts` (la aserción «hay exactamente los dorados de firmas» pasa a filtrar por familia `signatures-` y se añade la prueba genérica «todo dorado se abre sin avisos»; ninguna aserción se debilita).

**Pruebas.**
- Vitest (node + jsdom + `fake-indexeddb`): **196 pruebas nuevas en 8 archivos** + 6 en `goldenPackages.test.ts` (ahora genérica): `settingsRegistry.test.ts` (16: validadores, coincidencia con tema/idioma/claves de sus dueños y **inventario del código**: toda clave `optimuspdf.*` de `localStorage` está clasificada), `modules/settings.test.ts` (30: solo la lista blanca viaja, `lastBackup`/ajenas/recientes/historial no, Reemplazar/Omitir, `changed`, cuota con restauración, plan manipulado, historial opcional, claves `__proto__`, valores enormes y profundos, JSON roto), `modules/settings.dom.test.tsx` (3: con el `localStorage` real, un interruptor de Firmar activado a propósito sobrevive a recargar por la clave de versión —con control negativo— y el historial importado refresca su caché), `modules/drafts.test.ts` (40: resumen, exportar sin efectos, caducidad, `signaturesInDraft`, **ida y vuelta exportar → borrar → importar → Recientes → restaurar sesión → generar el PDF con los trazos**, nuevo/idéntico/distinto/conservar ambos, límites, atomicidad entre almacenes con deshacer, rev y pestañas), `modules/drafts.hostile.test.ts` (86), `modules/drafts.dom.test.tsx` (2: ajuste real de Firmar), `commitDraftImport.test.ts` (10: las tres escrituras por separado, `undo`, PDF Pro troceado) y `goldenPackages.settingsDrafts.test.ts` (9). Suite completa con `F2_REAL_PDFS=1`: **515 archivos, 12 174 pruebas pasan, 10 omitidas (3 archivos, ya existentes)** (antes 507 / 11 972); `tsc` 0 errores; `eslint src e2e` 0 errores (1 aviso anterior ajeno).
- Corpus hostil (`drafts.hostile.test.ts` + `settings.test.ts`), cada caso < 2 s y sin escribir nada de lo malo: `__proto__`/`constructor`/claves ajenas/`lastBackup`, tipos cambiados (36 variantes en Firmar), valores de hasta 100 000 caracteres, JSON de 10 000 niveles de profundidad, 100 000 firmantes / 5 000 campos / 50 000 valores, sesión con **10 000 bloques**, ids repetidos (borrador, firmante, bloque, documento, campo), trazos fuera de rango (PNG corrupto, 100 000 px, 2 MB, sin IEND, ratio imposible, archivo compartido, ruta de otro borrador o carpeta), PDF falsos (texto, vacío, PNG disfrazado, cabecera lejana, otro PDF bajo la huella), caducidad en el año 2999 (se recorta a 7 días), fechas del futuro, campos desconocidos y los 10 zips hostiles del contenedor.
- Paquetes dorados nuevos (contraseña `dorada-2026`; NO se regeneran): `settings-v1.optimuspdf.zip` (con `value-history.json`), `settings-v1-encrypted…`, `drafts-v1…` (documento, sesión con turno, Editar con imagen, PDF Pro; trazos reales) y `drafts-v1-encrypted…`. `goldenPackages.test.ts` itera TODOS los dorados y `goldenPackages.settingsDrafts.test.ts` comprueba su contenido; los de borradores se juzgan con `now = 2026-10-15` (los trazos caducan a la semana).
- Mutaciones: `scripts/backup-settings-drafts-mutate.py` aplica **71 mutaciones** (lista blanca y validadores, versión de Firmar, caducidad, política de trazos, huella del PDF, identidad por contenido, límites, versionado, `changed`, `undo` de los tres almacenes…); **71 de 71 mueren** (en la primera pasada sobrevivieron 5: se añadieron pruebas del turno guardado, de la huella con un PDF del mismo tamaño, de la fecha y la fila de bytes de PDF Pro; una mutación EQUIVALENTE —el pre-chequeo de límites de `applyDraftsImport`, cuyo resultado la propia transacción repite igual— se retiró de la lista).
- E2E headless (`e2e/specs/backup-drafts-settings.spec.ts` + `e2e/helpers/backup-entry.ts` —el arnés, sin interfaz—, `drafts-packages.ts`; build de producción con `CSP_SKIP_UPGRADE_INSECURE=1`, puerto 3968): **4 pruebas en Chromium y 4 en `webkit-ipad`, todas pasan**: (1) trabajo REAL en Firmar (2 documentos × 2 firmantes, 4 firmas), Editar y PDF Pro → resumen → exportar con contraseña (sobre cifrado sin texto legible) → borrar los tres almacenes y los ajustes → importar (sin contraseña y con una mala se rechaza sin tocar nada) → ajustes de la lista blanca presentes y `lastBackup`/`apiKey` ausentes → reimportar no duplica → Recientes lista los tres y «Continuar» restaura cada uno → «Firmar y descargar» da un ZIP cuyos PDF llevan las MISMAS firmas capturadas; (2) ajustes de un navegador a otro limpio (historial de valores solo si se pide); (3) los dorados con los validadores reales (pdf.js abre cada PDF, `validatePngForImport` decodifica cada trazo); (4) hostiles (PDF falso, PDF truncado, bomba de píxeles 4096², 10 000 bloques, id repetido, ajustes con `__proto__`): < 2 s y 0 filas escritas. Regresión con la misma build: `sign-recovery`, `sign-draft-safety`, `recent-continue`, `sign-templates*` → Chromium **116 pasan**; `webkit-ipad` **109 pasan, 3 omitidas** (las omite el propio spec según el motor: `test.skip` por `browserName`).
- **No verificado**: Safari real de iPad (solo el WebKit de Playwright con el perfil «iPad Pro 11»: la hoja de compartir y los límites reales de cuota de IndexedDB/`localStorage` en Safari no se probaron); paquetes con borradores cercanos al tope (el E2E usa PDF de pocas páginas; el tope de ~246 MiB del paquete se prueba con un tope bajo inyectado `__setDraftsPackageBudgetForTests`, sin reservar 250 MB); la compensación entre almacenes ante un fallo REAL de cuota a mitad (se prueba inyectando el fallo con `beforeCommit` y deshaciendo, no llenando el disco); Firefox (no se ejecutó).

### U4.5 + U4.2 entregada: exportar e importar «Plantillas y documentos» (módulo `library` del paquete + interfaz en «Mis documentos»; 2026-10-20)

**Qué ve el usuario.** En «Mis documentos» ➜ **Almacenamiento**, el hueco deshabilitado «Respaldar mis documentos — Próximamente» se sustituyó por la sección **«Respaldo»** con dos botones de 44 px, **«Exportar plantillas y documentos»** e **«Importar»**, y una línea «Último respaldo: hoy / ayer / hace N días» (o «Aún no has hecho un respaldo»; clave de `localStorage` **`optimuspdf.lastBackup`**, ISO 8601, nueva: no existía en esta base; helper compartido `src/lib/backup/lastBackup.ts`: `readLastBackup`, `markLastBackup`, `LAST_BACKUP_KEY`).
1. **Exportar** (hoja `ExportBackupSheet`): resumen previo «Se exportará: 3 documentos, 2 plantillas, 39,8 KB» (sin leer los PDF), aviso «Solo van contratos en blanco y las posiciones de las plantillas: nunca firmas, borradores ni datos de clientes», casilla **«Proteger con contraseña (recomendado)»** marcada por defecto (contraseña + confirmación, mínimo 8, medidor `role=meter`; sin WebCrypto —http— queda desmarcada y deshabilitada con su explicación; desmarcada avisa «sin contraseña, cualquiera que tenga el archivo…»). Archivo **`OptimusPDF-documentos.optimuspdf.zip`**. Con puntero táctil y `navigator.share({files})`+`canShare`: primero «Archivo listo» y compartir en un SEGUNDO toque (Safari exige gesto reciente); cerrar la hoja de compartir NO cuenta como exportado; si compartir falla cae a la descarga. En escritorio descarga directo. Tras entregar el archivo anota «Último respaldo». Más de 250 MB de PDF → «no caben en un solo respaldo» ANTES de leer los PDF.
2. **Importar** (hoja `ImportBackupSheet`): elegir/soltar el `.zip` → contraseña si está cifrado (la incorrecta dice «La contraseña no es correcta, o el archivo está dañado» y deja reintentar) → hoja **«Revisa antes de importar»**: una tarjeta por contrato (con sus plantillas) o por plantilla suelta, con estado **Nuevo / Ya lo tienes / Distinto / No se puede importar** (icono-texto, nunca solo color), sus plantillas («igual a la tuya», «distinta», «nueva»), el motivo si no se puede importar, y la decisión por elemento (`role=radiogroup`, ≥ 44 px): **Importar / Reemplazar / Conservar ambos / Omitir** («Añadir plantillas» cuando el PDF ya está y solo faltan plantillas); progreso «Revisando PDF 1 de 2…»; límites comprobados antes («Después de importar tendrás N de 50 documentos y M de 200 plantillas» o «Solo caben 2 de los 5 elementos elegidos: el máximo es de 50 documentos…», botón bloqueado); botón «Importar N elementos» (atómico); resultado «Importación terminada: 3 documentos, 2 plantillas.» + reemplazados/omitidos/ids cambiados + lista de lo que no se pudo importar con su motivo. Región viva única, foco al encabezado en cada fase y devuelto al botón al cerrar, Escape cierra. Cada `PackageError` y cada fallo de aplicar tiene su mensaje (ES/EN, bloque propio **`documents.backup.*`** en `src/lib/locales/{es,en}.ts`; las claves `documents.backup`/`backupSoon` de texto pasan a ser el bloque anidado).

**Formato del módulo `library` (esquema 1)** — registrado en `registry.ts` en un bloque delimitado (`// >>> U4.5` … `// <<< U4.5`) con su especificación en `modules/libraryModuleSpec.ts` (solo constantes, como `moduleSpecs.ts` de U4.6, para que el registro no arrastre los almacenes):
```
documents/index.json     [{ id, name, docType, fileName, pageCount, pageSizes, fingerprint (MinHash en base64), createdAt, updatedAt,
                            byteLength, templateStale?, file: "documents/<archivo>.pdf" }]      (SIN rev ni templateIds)
documents/<archivo>.pdf  el PDF base
templates/index.json     [{ id, file: "templates/<archivo>.json" }]
templates/<archivo>.json una plantilla (`serializeTemplate`: sin rev ni historial; `documentId` = documento del paquete o null)
```
Spec: `folders ["documents","templates"]`, `maxFileBytes` 100 MiB, `maxJsonBytes` 16 MiB. Nombres de archivo derivados del id con prefijo seguro y únicos sin distinguir mayúsculas; `index.json`, `kits.json` e `insurer-profiles.json` son reservados en `templates/` (kits y perfiles son de otras unidades). Nunca viajan firmas, borradores, valores de clientes, `rev` ni historial. `templateIds` se RECONSTRUYE al importar desde `documentId`.

**API (`src/lib/backup/modules/library.ts` + `libraryCommit.ts` + `migrations/library/`).**
- Exportar: `exportLibrary(): Promise<PackageModuleInput>`, `exportLibraryWithReport()` (+ `{documents, templates, bytes, skippedDocuments}`), `summarizeLibraryExport()` (sin leer PDF). Un documento sin copia, o cuya copia no corresponde a su huella, NO se exporta (se cuenta); una plantilla de un documento que no viaja queda `documentId: null`. Sin IndexedDB lanza `LibraryError("unavailable")`.
- Planificar (no escribe): `loadLibraryExisting()` → `planLibraryImport(readResult, existing, { validatePdf? })` → `LibraryPlan { state: ok|absent|newerVersion|damaged, items[], counts, limits }`. Elemento = documento con sus plantillas (`kind: "document"`) o plantilla suelta (`"template"`): **Nuevo / Idéntico** (mismo SHA-256 del PDF —aunque tenga otro id— y las mismas plantillas por contenido) **/ Distinto** (`difference: "pdf"` = mismo id con otro PDF; `"templates"` = mismo PDF con plantillas nuevas o cambiadas, `changesTemplates`) **/ Inválido** con `reason` (`integrity, tooLarge, invalidEntry, invalidPdf, fingerprint, duplicateId, noPdf, noDocument, documentInvalid`). La puerta del PDF (`validatePdf`; la interfaz pasa `browserInputGuard`: `ok` o «solo restricciones») NO se ejecuta sobre lo idéntico. La huella del documento debe declarar el SHA-256 del PDF. Una plantilla que apunta a un documento ausente (`noDocument`) o inválido no se guarda huérfana. El plan se **congela** (`Object.freeze` profundo) y solo `applyLibraryImport` acepta planes emitidos por el planificador (`WeakSet`).
- Decisiones: `libraryDecisionOptions(item)`, `defaultLibraryDecisions(plan)` (nuevo → importar; otro PDF → conservar ambos; plantillas nuevas → añadir; plantillas cambiadas → omitir; idéntico/inválido → omitir: nunca se pierde nada por defecto), `checkLibraryLimits(plan, decisions)` → `{wanted, fits, ok, documentsAfter, bytesAfter, templatesAfter, blockedBy: documents|bytes|templates|perDocument|quota}` (50 documentos, 400 MiB, 200 plantillas, 20 por documento y el espacio libre de `navigator.storage.estimate`, ANTES de escribir).
- Aplicar: `applyLibraryImport(plan, decisions)` → `{ok:true, documents, documentsReplaced, templates, templatesReplaced, skipped, reassigned}` | `{ok:false, reason: limit|quota|unavailable|invalid|blocked|changed|failed}`. REVALIDA (esquema con `deserializeLibrary`/`parseTemplate`, SHA-256 del PDF contra la huella, tamaño, `%PDF-`) y escribe con `commitLibraryImport` en **UNA transacción** sobre `documents`+`blobs`+`templates` (todo o nada; fallo de cuota a mitad = nada escrito): comprueba las `rev` de lo que reemplaza (`changed`), no duplica un PDF que apareció desde la vista previa, reasigna ids ocupados (de documento y de plantilla; las plantillas siguen a su documento), «Reemplazar» una plantilla = versión nueva con la anterior en el historial, reconstruye `templateIds` y **recalcula `templateStale`** con `staleVerdict` (al reemplazar el PDF de un documento que conserva plantillas propias se marcan desactualizadas contra su PDF base; el aviso que trae el paquete se recalcula contra el PDF que queda y se descarta si no hay plantillas o ya valen). Límites finales también al escribir.
- Migraciones puras encadenadas: `migrations/library/` (`CURRENT_LIBRARY_SCHEMA = 1`, `LibraryRaw`, `migrateLibrary`; `v1.ts` = identidad). Paquetes dorados `__fixtures__/packages/library-v1.optimuspdf.zip` y `library-v1-encrypted.optimuspdf.zip` (contraseña `dorada-2026`; 3 contratos sintéticos REALES de pdf-lib con huella de pdf.js y 2 plantillas; generados con el código de esta unidad, NO regenerar; se pueden importar también en la interfaz). `goldenPackages.test.ts` (de U4.6) ya recorre TODOS los dorados con su comprobación genérica y `goldenLibraryPackages.test.ts` comprueba el contenido exacto de los de `library-*`.

**Código de la interfaz.** `src/app/documents/`: `backupFlow.ts` (exportar/leer/aplicar; reutiliza contraseña, compartir y mapa de errores de `sign-pdf/backupFlow.ts`), `backupModel.ts` (opciones, rótulos, explicaciones, «último respaldo»; puro), `ExportBackupSheet.tsx`, `ImportBackupSheet.tsx`; cambian `StoragePanel.tsx` (nueva sección «Respaldo») y `components/views/MyDocumentsView.tsx`. Cambios en pruebas existentes (explicados): `MyDocumentsView.test.tsx` (el caso «hueco deshabilitado con Próximamente» pasa a «Exportar/Importar habilitados y sin Próximamente»), `MyDocumentsView.en.test.tsx` (la comparación de marcadores admite el bloque anidado `backup`; sus claves se comparan en `BackupSheets.test.tsx`). `playwright.config.ts`: `documents-backup` entra en `CROSS_SPECS` (corre en `webkit-ipad`).

**Pruebas.**
- Vitest (jsdom y node + `fake-indexeddb`, 133 pruebas nuevas en 11 archivos): `library.test.ts` (40: exportar —omisiones, rutas, reservados—, ida y vuelta con y sin contraseña, idempotencia «Ya lo tienes», cada «Distinto» y decisión, ids ocupados, `changed`, `templateStale`, límites, atomicidad por cuota simulada, plan inmutable/falsificado, migraciones), `library.hostile.test.ts` (20), `libraryCommit.test.ts` (7), `library.dom.test.tsx` (3), `goldenLibraryPackages.test.ts` (4), `lastBackup.test.tsx` (5), `backupFlow.test.ts` (12), `backupModel.test.ts` (9), `BackupSheets.test.tsx` (27: exportar/importar/contraseña/compartir/hostiles/límites/decisiones/`changed`/progreso/XSS y claves ES/EN), `MyDocumentsView.backup.test.tsx` (5) y `.en.test.tsx` (1). **Corpus hostil del módulo** (< 2 s cada caso, `countWrites` = 0 escrituras de lo malo): PDF falso (con y sin `%PDF-`), PDF > 100 MiB, huella con SHA de otro PDF / mal formada / minhash, páginas, nombres con bidi o controles, plantilla con campos fuera de rango / 501 campos / tipo desconocido / roles de más / versión rara, JSON de 20 000 niveles (plantilla: inválida; índice: dañado), referencias a documentos inexistentes, ids repetidos, archivos reservados / compartidos / rutas `../`, `__proto__`, SHA del manifiesto malo, archivo ausente, índice ausente o que no es lista, esquema más nuevo, 500 documentos (dañado) y 200 válidos (no caben), más el corpus del contenedor y rutas `../` de `documents/`.
- Suite completa con `F2_REAL_PDFS=1`: **529 archivos (526 pasan, 3 omitidos), 12 309 pruebas pasan, 10 omitidas, 0 fallos** sobre el árbol con U4.6 ya integrado (la línea base de esta unidad era 507 / 11 972, sin U4.6); `npx tsc --noEmit` 0 errores; `npx eslint src e2e` 0 errores (1 aviso previo en `inputChecks.clients.test.tsx`).
- E2E headless, build de producción con `CSP_SKIP_UPGRADE_INSECURE=1`, PW_PORT 3967 (`e2e/specs/documents-backup.spec.ts`, 15 pruebas; contratos sintéticos de `makeContractPdf`; ayudante `e2e/helpers/library-packages.ts`): **Chromium 15/15 y `webkit-ipad` 15/15** (también con `my-documents`: 23/23 en cada motor sobre la build final). Cubre: añadir 3 contratos con 2 plantillas → exportar sin y con contraseña (se lee el zip descargado en Node) → borrar todo → importar (3 «Nuevo» → «Importación terminada: 3 documentos, 2 plantillas», tarjetas ✓/✓ parcial/✗, MISMO SHA-256 de cada PDF, persisten al recargar) → reexportar e importar encima («Ya lo tienes» ×3, botón «No hay nada que importar» deshabilitado, sin duplicados) → archivo cifrado con contraseña mala y buena; «Distinto» (Conservar ambos / Reemplazar / Añadir plantillas); corpus hostil del contenedor y paquete con PDF falso, huella que miente y plantilla fuera de rango (lo malo se aísla; solo entra lo bueno); táctil con `navigator.share` simulado; axe-core (incluida `target-size`) con 0 violaciones en CADA estado de las hojas (exportar: formulario, error, sin contraseña, hecho; importar: elegir, contraseña, contraseña mala, vista previa con los cuatro estados, decisión, resultado) × claro/oscuro × ES/EN × 1280/375, objetivos ≥ 44 px, y sin desbordes ni fallos `target-size` a 375/320 px con DejaVu Sans y espaciado ancho. Regresión: `my-documents`, `recent-continue`, `a11y-sweep`, `sign-templates*`, `sign-assignment*`, `sign-privacy`, `sign-recovery`: Chromium **261/261**; `webkit-ipad` 247 pasan, 4 omitidas y 2 que fallaron SOLO con la máquina saturada (`my-documents` por un `pageerror` de una navegación abortada a /sign-pdf y `sign-recovery (d)`, recarga a 100 ms); repetidas en solitario pasan (35 pasan, 1 omitida).
- Mutaciones: `python3 scripts/library-backup-mutate.py` aplica **55** (comparar y planificar, decisiones, límites, cuota, revalidación, reservados, migración, registro, atomicidad y `rev`, ids, historial, `templateStale`, límites al escribir, flujo, modelo, `lastBackup`, hojas): **55 de 55 mueren**.

**Decisiones y límites.** (1) «Idéntico» compara contenido de plantilla (no id, fechas ni versión) y el PDF por SHA-256 aunque el id cambie. (2) Una plantilla huérfana (documento ausente o inválido) NO se importa; las plantillas «sin documento» (`documentId: null`) sí viajan y se fusionan, pero ninguna pantalla las lista aún (limitación m4 de F2). (3) «Reemplazar» un documento no borra plantillas tuyas que el archivo no trae: las deja, marcadas «desactualizadas» si su PDF base ya no coincide. (4) Más de 250 MB de PDF no cabe en UN paquete (tope del contenedor): se dice antes de leer los PDF; no hay exportación por partes. (5) La página de un PDF importado no se recuenta: `pageCount` y huella son los del archivo (atados al PDF por su SHA-256, pero no recalculados con pdf.js). (6) El recordatorio «Haz una copia cada 30 días» NO está (es de U4.7/Ajustes); `optimuspdf.lastBackup` queda listo para él. **No verificado:** Safari real de iPad (solo el WebKit de Playwright; la hoja de compartir del sistema se simuló); Firefox; PDF reales de usuario (no se usaron); biblioteca con 50 contratos reales de decenas de MB en un iPad (memoria); `navigator.storage.estimate` real con cuota casi agotada (simulada); lectores de pantalla reales.
### U4.7 + U4.8 entregada: «OptimusPDF Package» global, sección «Respaldo y traslado» en Ajustes, recordatorio de respaldo y dorados del Package (2026-10-20)

**Qué ve el usuario.** En **Ajustes** hay una tarjeta nueva, **«Respaldo y traslado»** (tercera, tras Apariencia e Idioma): una línea que explica el motivo («Safari puede borrar los datos de un sitio web después de 7 días sin usarlo…»), la recomendación de **«Añadir a la pantalla de inicio»** en iPad/iPhone, dos botones de 44 px —**«Exportar mi paquete»** e **«Importar paquete»**— y **«Último respaldo: hoy / ayer / hace N días»** (o «Aún no has hecho un respaldo»; clave `optimuspdf.lastBackup`, la misma de «Mis documentos»).
1. **Exportar mi paquete** (`ExportPackageSheet`): una casilla por módulo con su recuento —*Firmas guardadas (2 firmas)*, *Plantillas y documentos (2 documentos, 2 plantillas)*, *Borradores en curso (1 borrador)*, *Ajustes (10 ajustes)*—; las vacías o ilegibles quedan desmarcadas y deshabilitadas con su explicación. **«Incluir el historial de valores»** (datos de clientes) aparece solo si existe y viene **desmarcado**. Si los borradores llevan trazos de firma, un aviso dice **«Estos borradores contienen tu firma»** y una subcasilla permite quitarlos del paquete. Resumen previo: «Se exportará: 2 firmas, 2 documentos, 2 plantillas, 1 borrador (firmas dibujadas en los de Firmar: sí), ajustes. Tamaño aproximado: 16,6 KB.» **Contraseña recomendada, no obligatoria**: marcada por defecto si hay firmas, borradores o historial (mínimo 8, medidor `role=meter`, confirmación); se puede desmarcar y entonces el aviso es más fuerte si hay firmas o datos de clientes («cualquiera que tenga el archivo podrá ver tus firmas y los datos de tus clientes»). Archivo **`OptimusPDF-paquete-AAAA-MM-DD.optimuspdf.zip`**. En escritorio descarga; con puntero táctil y `navigator.share({files})`: primero «Archivo listo» y compartir en un SEGUNDO toque (cerrar la hoja de compartir sin elegir NO cuenta como exportado; si falla cae a la descarga). Tras entregar el archivo anota «Último respaldo» y reinicia el recordatorio. Un módulo vacío se omite y se dice («No se incluirá Firmas: no hay nada que respaldar»).
2. **Importar paquete** (`ImportPackageSheet`): elegir/soltar el `.zip` → contraseña si está cifrado (la mala dice «La contraseña no es correcta, o el archivo está dañado» y deja reintentar, sin escribir nada) → **vista previa POR MÓDULO** (Firmas, Plantillas y documentos, Borradores, Ajustes; cada uno con «3 nuevos · 1 ya los tienes · …») con el estado de cada elemento (**Nuevo / Ya lo tienes / Distinto / No se puede importar**, siempre en texto) y su decisión (`role=radiogroup`, ≥ 44 px). Las tarjetas de firmas y de documentos son las de sus propias hojas (`SignatureBackupSheet.ItemCard`, `ImportBackupSheet.ItemCard`); las de borradores y ajustes son nuevas (`PackageItemCards.tsx`: tipo y fecha, «Contiene tu firma», aviso si los trazos se descartarán por el ajuste «Guardar las firmas recogidas en el borrador», copia local más nueva/antigua; ajustes con «Reemplazar / Omitir» y el historial de valores aparte, **por defecto «Omitir»**). Límites comprobados ANTES por módulo («Después de importar tendrás 3 de 30 firmas», …); si un módulo no cabe, el botón queda bloqueado hasta omitir algo. Progreso («Revisando PDF 1 de 2…», «Importando Borradores…»), botón «Importar N elementos» y **resultado por módulo** («Firmas: 2 importadas.», «Plantillas y documentos: 2 documentos, 2 plantillas.», «Borradores: 1 importados.», «Ajustes: 9 aplicados.»). Si un módulo falla se dice con su motivo y «Lo que ya se había importado de las demás partes se conserva». Si se aplicaron ajustes: **«Recarga para aplicar los ajustes»** con el botón «Recargar ahora». Un paquete de UN solo módulo (el de firmas, el de documentos…) entra por esta misma hoja.
3. **Recordatorio de respaldo**: una tarjeta discreta («Conviene hacer un respaldo» + «Has hecho 14 cambios…» / «Han pasado 31 días desde tu último respaldo») con **«Respaldar ahora»** (abre «Exportar mi paquete») y **«Recordármelo luego»** (calla 7 días y lo anuncia). Aparece en Ajustes (dentro de la sección) y en **«Mis documentos»**, nunca en pantallas de trabajo (Firmar, Editar, PDF Pro, resto de herramientas). Solo avisa si de verdad hay algo que respaldar (firmas, documentos, plantillas o borradores; los ajustes solos no cuentan).

**Código.** Librería `src/lib/backup/globalPackage.ts` (orquestación PURA sobre los módulos existentes; no tiene formato propio ni lógica de fusión) y `backupReminder.ts`; interfaz en `src/app/settings/`: `BackupSection.tsx`, `ExportPackageSheet.tsx`, `ImportPackageSheet.tsx`, `PackageItemCards.tsx`, `BackupReminder.tsx` + `useBackupReminder.ts`, `packageModel.ts` (puro), `focusFallback.ts`, `pageReload.ts`. Textos ES/EN: bloque **`settings.backup.*`** en `src/lib/locales/{es,en}.ts`.

**API de `globalPackage.ts`** (orden de llamadas para la UI).
- `PACKAGE_MODULES = ["signatures","library","drafts","settings"]` (orden de exportación, de vista previa y de aplicación).
- `describeExport({ modules, includeValueHistory?, includeStrokes?, draftKinds? })` → resumen previo SIN leer PDF: recuentos por módulo, `willInclude`/`willOmitEmpty`/`unavailable`, `estimatedBytes`, `containsSignatureStrokes`, `containsSignatures`, `containsClientData`, `encryptionRecommended`, `tooLarge`, `nothingToExport`. Nunca lanza.
- `exportEverything({ modules, password?, includeValueHistory?, includeStrokes?, draftKinds?, now? })` → `{ ok:true, blob, filename, encrypted, included, omitted:[{module, reason:"empty"|"unavailable"}], counts }` | `{ ok:false, reason: nothingSelected|empty|unavailable|encryptionUnavailable|tooLarge|failed }`. El historial de valores solo va con `includeValueHistory: true`; los trazos de los borradores van salvo `includeStrokes: false` o ajuste «guardar las firmas» apagado (lo decide el módulo de borradores). `packageFilename(date)`.
- `readAndPlanEverything(file, password?, { onProgress?, validatePdf?, validateImage?, now? })` → `readPackage` + plan de cada módulo contra lo que hay hoy, **SIN escribir nada**: `{ ok:true, encrypted, plans, modules:[{module, state:"ok"|"absent"|"newerVersion"|"damaged"|"unavailable", message?, counts:{new,identical,different,invalid}, importable}], warnings }` | `{ ok:false, reason, code? }` (`needsPassword`, `wrongPassword`, `unsafe`, `tooLarge`, `noModules`…). Las puertas de producción son las mismas que usan las hojas de cada módulo (`browserInputGuard` para cada PDF, `validatePngForImport` para cada trazo/firma). Un módulo ausente, de versión más nueva o dañado se queda en su estado y NO impide leer los demás.
- `defaultEverythingDecisions(plans)`, `checkEverythingLimits(plans, decisions)` → `{ wanted, wantedBy, ok, blocked }` (límites de cada almacén ANTES de escribir).
- `applyEverything(plans, decisions, { onModule?, now? })` → `{ outcomes:[{module, status:"applied"|"nothing"|"failed"|"skipped", …recuentos | reason | why}], applied, failed, reloadRequired }`. Aplica **módulo a módulo** en el orden firmas → biblioteca → borradores → ajustes (borradores ANTES que los ajustes para que la política de trazos que se aplica sea la que enseñó la vista previa); cada módulo es atómico en sí (lo garantiza su `apply…Import`); **si uno falla, los que ya se aplicaron bien NO se deshacen** y se informa por módulo; un módulo sin nada aprobado no se toca. Nunca lanza. `hasBackupWorthyData()`.

**Recordatorio — `backupReminder.ts`.** Una clave nueva de `localStorage`, **`optimuspdf.backupReminder`** (JSON `{ changes, since?, snoozeUntil? }`: un número y dos fechas, **sin PII**), clasificada en `settingsRegistry.ts` como **NO exportable** (`SETTINGS_NEVER_EXPORTED_KEYS`; la constante vive en `lastBackup.ts`, junto a `LAST_BACKUP_KEY`). Reglas: avisa a los **30 días** del último respaldo (o, si nunca hubo, desde el primer cambio contado; quien ya tenía datos recibe un ancla «desde hoy» la primera vez que se mira) **o a los 10 cambios**, salvo «Recordármelo luego» (7 días). «Cambio relevante» = alta, edición o borrado de una firma, un documento o una plantilla: un gancho de una línea en `signVault.ts` (`saveVaultEntry` con firma nueva —no el duplicado—, `updateVaultEntry`, `commitVaultImport`) y en `announceChange()` de `docLibrary/store.ts` (que cubre documentos y plantillas); usar una firma ya guardada (`touchVaultEntry`) no cuenta. `markLastBackup()` (la usan las dos exportaciones) borra el contador y el aplazamiento y avisa a la pestaña (evento `optimuspdf:backup-state`).

**Cambios en código existente (aditivos).** `signVault.ts` (3 ganchos del contador), `docLibrary/store.ts` (1 gancho), `lastBackup.ts` (clave del recordatorio, evento, `markLastBackup` lo reinicia), `settingsRegistry.ts` (una clave más en la lista de no exportables), `SignatureBackupSheet.tsx` y `documents/ImportBackupSheet.tsx` (`ItemCard` exportada; en la segunda, la línea de límites pasa a un componente exportado `LibraryLimitLine` con el mismo marcado), `SettingsView.tsx` (la sección), `MyDocumentsView.tsx` (el aviso y la hoja «Exportar mi paquete» para «Respaldar ahora»), `locales/{es,en}.ts`, `playwright.config.ts` (`settings-package` entra en `CROSS_SPECS`). **Cambio en una prueba existente (explicado):** `src/lib/docLibrary/store.test.ts`, caso «sin BroadcastChannel usa el evento storage»: fijaba que la única clave escrita en `localStorage` era la señal; ahora cada cambio también suma al contador del recordatorio, así que la aserción filtra esa clave (`optimuspdf.backupReminder`) y comprueba además que el contador vale 1. Ninguna otra prueba existente cambió ni se debilitó.

**U4.8 — dorados del Package.** `__fixtures__/packages/package-all-v1.optimuspdf.zip` y `package-all-v1-encrypted.optimuspdf.zip` (contraseña `dorada-2026`): los **CUATRO módulos** (3 firmas con PNG reales, 3 contratos con PDF reales de pdf-lib y 2 plantillas, 4 borradores —documento y sesión con trazos y turno guardado, Editar con imagen, PDF Pro—, 10 ajustes; el cifrado además lleva `value-history.json`). Generados con código determinista (`__fixtures__/goldenAll.ts`: PDF sin fechas, PNG de semilla fija, fechas e ids fijos; el zip en claro sale idéntico byte a byte en cada ejecución —comprobado con SHA-256 dos veces—; el cifrado usa sal e IV aleatorios) y **NO se regeneran**. `goldenAll.generate.test.tsx` es el generador, apagado salvo con `GEN_GOLDEN_ALL=1`. `goldenPackages.test.ts` (que ya itera `*.optimuspdf.zip`) añade la familia `package-all`; `goldenPackages.packageAll.test.tsx` comprueba el contenido exacto de cada almacén tras importar por la vía global (ids, nombres, hash de cada PNG y de cada PDF, plantillas vinculadas, borradores con trazos, ajustes de la lista blanca, historial solo si se pide), «Ya lo tienes» al repetir con 0 escrituras, contraseña mala/ausente, y la **no regresión de formatos**: cada dorado de módulo suelto anterior (`signatures-v1`, `library-v1`, `drafts-v1`, `settings-v1`, en claro y cifrados) se lee, se planifica y se importa por `readAndPlanEverything`/`applyEverything`.

**Pruebas.**
- Vitest (jsdom + `fake-indexeddb` sobre los almacenes REALES; solo se simulan la descarga, la recarga y las puertas de pdf.js/decodificación de PNG, que corren en el E2E): **127 pruebas nuevas en 8 archivos** (+1 omitida, el generador): `globalPackage.dom.test.tsx` (28: resumen, exportar, ida y vuelta con contraseña, fusión sin duplicar, historial opcional, módulo suelto, **un módulo que falla no deshace los demás** —almacén de Firmar lleno—, versión más nueva, corpus hostil < 2 s sin escribir, plan manipulado), `backupReminder.test.tsx` (19), `packageModel.test.ts` (14), `PackageSheets.test.tsx` (28: ambas hojas, XSS, límites, share, ES/EN con claves y marcadores iguales), `BackupSection.test.tsx` (13: sección, recordatorio, posponer, «Respaldar ahora», integración en Ajustes y Mis documentos), `focusFallback.test.ts` (5), `goldenPackages.packageAll.test.tsx` (19) y una prueba más en `goldenPackages.test.ts`. Suite completa con `F2_REAL_PDFS=1`: **537 archivos (533 pasan, 4 omitidos), 12 438 pruebas pasan, 11 omitidas, 0 fallos** (antes 529 / 12 309); en una primera pasada falló una vez `EditInlineTool.resume.test.tsx` (tiempo de espera con la máquina saturada; pasa 3 de 3 en solitario y en la segunda pasada completa). `npx tsc --noEmit` 0 errores; `npx eslint src e2e` 0 errores (1 aviso anterior ajeno).
- Mutaciones: `python3 scripts/global-package-mutate.py` aplica **45 mutaciones** (orden y nombre del paquete, tope de tamaño, historial opcional, trazos, límites, reinicio y recarga, las reglas de 30 días / 10 cambios / 7 días, contador de cambios y sus ganchos, clasificación de la clave, modelo de pantalla, hojas, aviso, foco…): **45 de 45 mueren**. En la primera pasada sobrevivieron 4 que son **EQUIVALENTES** y se retiraron de la lista (documentadas en el script: quitar el rechazo temprano por tamaño, el aviso temprano de cifrado no disponible, y dos guardas «nada aprobado» cuyo resultado la propia llamada repite igual) y una se clasificó mal (`R12`: el marcador «SyntaxError» salía del `JSON.parse` de una prueba que fallaba de verdad; ya no es marcador y muere por 3 pruebas).
- E2E headless (build de producción con `CSP_SKIP_UPGRADE_INSECURE=1`, `PW_PORT=3969`; `e2e/specs/settings-package.spec.ts` + `e2e/helpers/package-entry.ts`, que SOLO prepara y lee estado —firmas con PNG pintados en un canvas, contratos sintéticos, recuentos—: exportar e importar se hacen SIEMPRE con la interfaz): **Chromium 21/21 y `webkit-ipad` 20/20 (+1 omitida a propósito: la prueba que lanza los dos motores corre una vez)**. Cubre: preparar firmas + 2 contratos con plantilla + un borrador de Firmar con trazos (ronda real de 2 documentos × 2 firmantes) + ajustes (tema oscuro, inglés) → «Exportar mi paquete» con contraseña (casillas con recuentos, historial desmarcado, aviso de firma, sobre cifrado sin texto legible) → borrar TODO → «Importar paquete» (contraseña mala rechazada sin escribir; vista previa por módulo; resultado por módulo; «Recargar ahora») → firmas idénticas por hash, plantillas, documentos y ajustes tras recargar (tema oscuro, inglés; sin historial, sin `lastBackup`) → **Recientes → Continuar y el PDF final lleva las firmas capturadas** → añadir una firma → reexportar → importar sobre lo existente: **fusiona sin duplicar** (2 «Ya lo tienes» + 1 «Nuevo»; repetir deja «No hay nada que importar») → sin peticiones a servidores ajenos; **Chromium → WebKit iPad y WebKit → Chromium** con el mismo hash de cada firma; paquete de solo firmas por la misma hoja y el dorado antiguo de módulo suelto leído; los dos dorados `package-all` con los validadores reales (reloj fijado en su fecha); corpus hostil < 2 s sin escribir ni tocar `localStorage`; recordatorio (9 cambios no, 10 sí; ausente en 5 pantallas de trabajo; «Recordármelo luego» y vuelta a los 8 días; **reloj simulado a +29 y +31 días**; «Respaldar ahora» y el aviso desaparece sin perder el foco; sin datos no avisa ni a los 400 días); `navigator.share` simulado (primero «Archivo listo», cancelar no cuenta, segundo toque comparte, el archivo compartido se importa); **axe-core 0 violaciones** (rutas de color, ARIA, etiquetas, nombres, `target-size`…) en claro/oscuro × ES/EN × 1280/375 sobre la sección, el recordatorio y cada estado de ambas hojas (elegir, contraseña, contraseña mala, vista previa todo nuevo, decisiones, resultado y recarga, exportar formulario/error/sin contraseña/hecho, vista previa mezclada), con una prueba de **control negativo** (axe sí detecta botones diminutos pegados) y objetivos ≥ 44 px; fuente ancha (DejaVu Sans + espaciado) sin desbordes a 375 y 320 px ES/EN con nombres larguísimos. Regresión (build de producción; el último retoque —quitar de la tarjeta del recordatorio de Ajustes la línea del motivo, que ya está justo encima— se hizo después y se re-verificó con el spec nuevo en ambos motores y con `my-documents`, `settings-edit-pdf-flags` y `documents-backup` en `webkit-ipad`, 49 pasan): `documents-backup`, `backup-drafts-settings`, `my-documents`, `settings*`, `a11y-sweep`, `sign-recovery`, `sign-privacy`, `recent-continue`, `sign-templates*` y el spec nuevo → Chromium **292 pasan**; `webkit-ipad` **280 pasan, 5 omitidas** (las omiten los propios specs según el motor).

**Decisiones y límites.** (1) Los borradores siempre pueden ir (decisión del usuario, §10.2); la interfaz no ofrece elegir por tipo (`draftKinds` existe en la librería): si no caben (> ~246 MiB) dice «Quita los borradores o borra documentos que no uses». (2) Importar NO anota «Último respaldo» (la fecha es de cada dispositivo) pero sí suma al contador de cambios (un alta importada es un cambio local). (3) «Borrar datos locales» no reinicia el recordatorio. (4) El recordatorio del contador usa solo los cambios hechos desde esta versión; quien ya tenía datos y nunca respaldó recibe el aviso a los 30 días de la primera visita a Ajustes o Mis documentos. (5) `Ajustes: 9 aplicados` y no 10 en el E2E de los dorados: uno de los diez (aviso de privacidad ya visto) ya era igual en ese navegador. **No verificado:** Safari real de iPad (solo el WebKit de Playwright con el perfil «iPad Pro 11»; la hoja de compartir del sistema y la cuota real de IndexedDB/`localStorage` se simularon); Firefox; lectores de pantalla reales; paquetes cercanos al tope de 250 MiB (el tope se prueba con un presupuesto bajo inyectado); la regla de 7 días de Safari en sí (solo se avisa de ella).
### Correcciones F4 tras verificación independiente de «Respaldo y traslado» (H1-H9; 2026-10-20)

La verificación independiente de U4.4-U4.8 (V4) encontró nueve hallazgos. Esta unidad los corrige sin aflojar ningún tope de seguridad. Cada uno tiene su prueba, que **falla sobre el código anterior y pasa ahora** (los de H9, cuyo código ya era correcto, se prueban por mutación: ver abajo).

**Qué cambia para la persona.**
- **H1 · paquetes grandes.** Un paquete cifrado de más de ~125 MB ya se puede volver a importar. El límite de exportar es el de importar: si lo elegido no cabe en un solo paquete, la hoja lo dice ANTES de exportar («Lo elegido pesa 297 MB y no cabe en un solo paquete: el máximo es 242 MB y sobran 55 MB…») y deshabilita «Crear paquete»; «Mis documentos» dice también cuánto sobra.
- **H2 · respaldos parciales.** Exportar solo una parte (p. ej. Ajustes) ya no marca «Último respaldo» ni reinicia el recordatorio: la línea dice «Último respaldo parcial (Ajustes): hoy. Aún no has hecho un respaldo completo.» y el aviso de «Conviene hacer un respaldo» sigue mientras lo importante (firmas, plantillas y documentos, borradores) no esté respaldado.
- **H3.** Borrar una firma cuenta como cambio para el recordatorio (igual que ya hacían borrar un documento o una plantilla).
- **H4.** Al importar un paquete que no traía todos los módulos, el resultado dice «El paquete no incluye: Plantillas y documentos, Borradores, Ajustes.» en vez de «no se importó» (ES/EN).
- **H5.** Los documentos de la biblioteca cuya copia del PDF falta se avisan antes («1 documento no se incluirá porque falta su copia del PDF.») y después de exportar («…no se incluyó…»), en Ajustes y en «Mis documentos»; el resumen previo ya no los cuenta.
- **H6.** Un paquete con el mismo PDF bajo dos ids ya no hace fallar todo el módulo «Plantillas y documentos» con un «tus datos cambiaron» engañoso: el repetido sale como «Repetido en el paquete», se importa una vez y sus plantillas se vinculan a ese.
- **H7.** Con la cuota del navegador llena, baúl, borradores, biblioteca y ajustes dicen lo mismo y con precisión («No hay espacio suficiente en este navegador; libera espacio o exporta y borra algo»), no «No caben…» ni «unavailable»; cada módulo sigue siendo atómico.
- **H8.** La vista previa de Ajustes lista QUÉ cambiaría, ajuste a ajuste («Firmar PDF · Firmas guardadas — Ahora: Activado → Paquete: Desactivado»), marca lo que afecta a la privacidad (guardar firmas, trazos en el borrador, avisos de privacidad «ya visto») y lo deja en «Omitir» por defecto; se decide por ajuste o con «Reemplazar todos / Omitir todos».
- **Cerrar mientras se importa.** Escape, clic fuera, la X o arrastrar ya no cierran la hoja de importar mientras se escribe (la X lleva `aria-disabled` y la región de estado dice «Se está importando: espera a que termine antes de cerrar.»): el resultado no se pierde. Vale para las tres hojas de importar (paquete, documentos y firmas).

**Código.**
- `package.ts` (H1): la capa EXTERNA (`envelope.json` + `payload.bin`) tiene su propio presupuesto de inflado (≤ 250 MiB) y la INTERIOR el suyo (≤ 250 MiB): antes compartían uno y `payload.bin` gastaba la mitad. Los topes de la importación no cambian (archivo y descifrado ≤ 250 MiB, suma de tamaños declarados ≤ 250 MiB por zip, ratio 100:1, 2 000 entradas, presupuesto de inflado real, corte al pasar de lo declarado). Del lado de exportar, `buildPackage` cuenta también `manifest.json` en el tope (la importación lo cuenta) y comprueba que el archivo generado cabe en lo que se aceptaría recibir (`tooLarge`): nunca genera un archivo que luego no se pueda abrir. `readPackage` abre las capas en una función aparte para que el zip exterior y el `payload.bin` queden fuera de alcance antes de inflar el interior.
- `globalPackage.ts`: `describeExport` añade `limitBytes` y `overBy`; `exportEverything` añade `libraryWithoutCopy`; `EverythingPlans.absent` (módulos que el paquete no traía) y `skipWhy(plans, name)` distinguen `absent` de `unavailable`; `recordBackup(traveled)`; `checkEverythingLimits` cuenta lo decidido con `countSettingWrites`.
- `lastBackup.ts` (H2): `markLastBackup(at?, { traveled, empty? })`. Sin segundo argumento es un respaldo completo (compatibilidad). Con él: anota la fecha de cada parte que viajó (`optimuspdf.lastBackupParts`, clave nueva, **no exportable**, clasificada en `settingsRegistry.ts`) y la de las partes vacías (cuentan como respaldadas), descuenta del recordatorio SOLO los cambios de esas partes y solo escribe `lastBackup` si quedan cubiertas las partes que protegen trabajo (firmas, plantillas y documentos, borradores: `REMINDER_PARTS`; los ajustes no condicionan lo «completo», igual que no cuentan para el recordatorio). `backupCoverageDate()` es el ancla de los 30 días: la parte vigilada respaldada hace MÁS tiempo (un respaldo solo de Ajustes no la mueve). El estado del recordatorio añade `by` (cambios por parte: firmas, biblioteca) sin cambiar su formato anterior (un contador antiguo se lee igual).
- `backupReminder.ts` / `signVault.ts` / `docLibrary/store.ts` (H3): `noteBackupRelevantChange(now?, parte?)`; `deleteVaultEntry` suma si la firma existía (borrar un id inexistente o vaciar el baúl no cuentan). `docLibrary/store.ts` añade `listBlobIds()` (solo claves) para que el resumen no cuente documentos cuya copia se perdió.
- `modules/library.ts` (H5, H6): `summarizeLibraryExport` no cuenta los documentos sin copia real; `LibraryImportItem.duplicateOf` marca el PDF repetido (mismo SHA-256, otro id) como «idéntico», pasa sus plantillas al primero y no suma a los recuentos; si el PDF no pasa la puerta de entrada, sus copias tampoco.
- Cuota (H7): `commitVaultImport`, `commitDraftImport`, `commitEditDraftImport`, `commitProDraftImport` y `applySettingsImport` devuelven `quota` (antes `limit`/`unavailable`); la biblioteca ya lo hacía.
- `modules/settings.ts` + `settingsRegistry.ts` (H8): `settingsRows(plan)` (una fila por ajuste que cambia; los interruptores de Firmar/Editar/PDF Pro, uno a uno), `SettingsDecisions.rows` (decisión por fila), `defaultSettingsDecisions` (lo sensible en «omit»), `countSettingWrites`. Aplicar deriva las filas de los `items` (nunca de una lista aparte) y revalida cada valor; con una elección parcial de interruptores FUSIONA con lo de ahora (no pisa los demás). Sensibles: `signaturesInDraft`, `signatureVault` y los dos avisos de privacidad.
- Interfaz: `PackageItemCards.tsx` (`SettingsCards`), `packageModel.ts`, `ExportPackageSheet.tsx`, `ImportPackageSheet.tsx`, `documents/ExportBackupSheet.tsx`, `documents/ImportBackupSheet.tsx`, `SignatureBackupSheet.tsx`, `BackupSection.tsx`, `StoragePanel.tsx`, `BackupReminder.tsx` y `Sheet.tsx` (props opt-in `closeLocked` y `onCloseBlocked`: ninguna otra hoja cambia). Textos ES/EN en `settings.backup.*`, `documents.backup.*` y `vaultBackup`.

**Cambios en pruebas existentes (explicados; ninguna se debilita).** (1) `settings.test.ts`, `globalPackage.dom.test.tsx`, `goldenPackages.packageAll.test.tsx` y `backup-drafts-settings.spec.ts` importaban Ajustes con las decisiones SUGERIDAS y esperaban los 10 ajustes: ahora los dos avisos de privacidad «ya visto» se omiten por defecto (H8), así que piden «Reemplazar todos» de forma explícita donde comprueban el viaje completo y una prueba nueva fija las sugeridas (8 de 10). (2) `signatures.test.ts` y `settings.test.ts` esperaban `limit`/`unavailable` ante la cuota llena: ahora `quota`. (3) `library.test.ts` «dos elementos que reclaman el mismo documento tuyo» usaba dos documentos del archivo con el MISMO PDF (el caso de H6): se reescribe con un destino reclamado por id y por contenido, que es la guarda que probaba. (4) `packageModel.test.ts`: lo que el paquete no traía ya tiene su línea («El paquete no incluye: …»). (5) `backupFlow.test.ts`: `tooLarge` trae `overBy`. (6) Los tres `scripts/*-mutate.py` anteriores se actualizan en 12 anclajes (`R06, R08, R11, R12, U03, U09, F01, M05, U02, B05, B06, B10`) cuyo texto cambió.

**Pruebas.**
- Vitest (node + jsdom + `fake-indexeddb` sobre los almacenes REALES): **110 pruebas nuevas en 11 archivos** — `package.large.test.ts` (17: 120/126/132/140 MiB de PDF cifrados y sin cifrar, 240 MiB cifrado cerca del tope, el tope de exportación, y los hostiles sobre una caja cifrada: zip-bomb por ratio, > 250 MiB declarados, entradas que mienten), `globalPackage.large.test.tsx` (2: 130 MiB por la vía real `exportEverything → readAndPlanEverything → applyEverything`, con y sin cifrar: el caso que daba `unsafe/bomb`), `globalPackage.quota.test.tsx` (7: cuota llena en baúl, biblioteca, borradores de Firmar/Editar/PDF Pro y ajustes, atómico, y los textos ES/EN), `globalPackage.absent.test.tsx` (5), `lastBackup.parts.test.tsx` (23: H2 y H3), `modules/library.duplicate.test.tsx` (5), `modules/libraryCommit.rev.test.tsx` (4), `modules/signatures.tamper.test.ts` (9), `modules/settings.rows.test.ts` (16), `PackageSheets.f4fix.test.tsx` (17: lo visible de H1, H2, H4, H5, H6, H8 y el cierre durante la importación, ES/EN) y `Sheet.closeLocked.test.tsx` (4). Suite completa con `F2_REAL_PDFS=1`: **548 archivos (544 pasan, 4 omitidos), 12 548 pruebas pasan, 11 omitidas, 0 fallos** (antes 537 / 12 438); `npx tsc --noEmit` 0 errores; `npx eslint src e2e` 0 errores (1 aviso anterior ajeno).
- Rojo antes del arreglo (contra el código anterior): `package.large` 6 de 17 fallan (`bomb` con 126/132/140 MiB y 240 MiB cifrados y el tope de exportación), `globalPackage.large` 1 de 2 (`unsafe/bomb` en el cifrado), `quota` y `absent` fallan todas, `lastBackup.parts` 18 de 22, `library.duplicate` 4 de 5, `settings.rows` 10 de 16, `PackageSheets.f4fix` 15 de 16, `Sheet.closeLocked` 3 de 4. Las de H9 (`signatures.tamper`, `libraryCommit.rev`) PASAN sobre el código anterior porque este ya era correcto: el hallazgo era que ninguna prueba lo vigilaba; se comprueban por mutación (abajo).
- Mutaciones: `python3 scripts/f4fix-mutate.py` aplica **45 mutaciones** (presupuestos y tope de exportación, respaldo parcial y contadores, borrar firmas, `absent`, documentos sin copia, PDF repetido, cuota de cada almacén, filas/decisiones/sensibles de Ajustes, `revalidate` de firmas, `rev` de plantillas y documentos, bloqueo del cierre): **45 de 45 mueren** (en la primera pasada sobrevivió `H203`, «una parte vacía cuenta como respaldada»: se añadió la prueba; `H103` y `H104` —el tope de exportación con `manifest.json` y el presupuesto de la capa externa— se retiraron por EQUIVALENTES: `assertImportable` y el corte de cada lectura en lo declarado ya los cubren; son defensa en profundidad). Los tres scripts anteriores (`global-package`, `library-backup`, `backup-settings-drafts`) se reanclaron en 12 mutaciones y esas 12 mueren.
- E2E headless (build de producción con `CSP_SKIP_UPGRADE_INSECURE=1`, puerto 3970; `e2e/specs/settings-package-fix.spec.ts`, 18 pruebas): **Chromium 18/18 y `webkit-ipad` 18/18** — H2 (solo Ajustes → «Último respaldo parcial (Ajustes)…», contador intacto, el aviso sigue; luego las firmas lo completan), H4 (ES y EN), H5 (Ajustes y «Mis documentos», antes y después), H8 (ES y EN: filas con nombres legibles, lo sensible en «Omitir», «Reemplazar todos»/«Omitir todos», por ajuste, y las sugeridas no escriben lo sensible), Escape, clic fuera y X durante la importación (retiene el resultado, con un SHA-256 frenado 9 s), **axe-core 0 violaciones** en claro/oscuro × ES/EN × 1280/375 sobre exportar con aviso, resultado con nota, sección con respaldo parcial, vista previa de Ajustes con filas y resultado con «no incluye» (objetivos ≥ 44 px y ≥ 24 px), y fuente ancha (DejaVu Sans + espaciado) sin desbordes a 375 y 320 px en ES/EN. Regresión con la misma build (`documents-backup`, `backup-drafts-settings`, `settings-package`, `my-documents`, `settings*`, `a11y-sweep`, `sign-recovery`, `sign-privacy`, `recent-continue` + el spec nuevo): Chromium **278 pasan, 1 omitida** (la de los dos motores corre solo con `PW_BROWSERS=webkit*`); `webkit-ipad` **270 pasan, 5 omitidas, 1 intermitente** (`my-documents` «añadir 3 contratos…»: errores «access control checks» de WebKit al pasar a Firmar; falla 1 de 3 y 3 de 8 veces TAMBIÉN sobre una build del código anterior, así que no es de esta unidad). Cinco pruebas existentes de E2E se ajustaron (explicado arriba): dos en `backup-drafts-settings`, tres en `settings-package` (8 ajustes aplicados en vez de 9 en el dorado; `by` en el contador).

**Decisiones y límites.** (a) Los borradores NO suman al contador del recordatorio (ni al crearse, ni al editarse, ni al borrarse): se guardan solos y cada pulsación dispararía el aviso; solo cuentan firmas, documentos y plantillas. (b) Lo «completo» no exige Ajustes (ver arriba). (c) Dos respaldos parciales seguidos que juntos cubren todo calman el aviso (el ancla es la parte más antigua) pero «Último respaldo» sigue diciendo «parcial» hasta que haya uno completo. (d) El tope de exportación sigue calculando con un margen de 8 MiB para los JSON; lo exacto lo decide `buildPackage`. (e) El presupuesto de inflado de cada capa es de 250 MiB (antes el interior solo disponía de lo que dejara el `payload.bin`): la memoria punta de abrir un paquete cifrado de ~250 MiB (archivo + `payload.bin` + descifrado, antes de inflar el interior) es de unos 750 MB y no se midió en un iPad real.
## Correcciones móvil/iPad: lienzo compartido, safe-area y UI base (M3)

Hallazgos de `docs/AUDITORIA-MOVIL-IPAD.md` que comparten Firmar y PDF Pro. Código en `src/app/sign-pdf/DocumentCanvas*.tsx`,
`src/components/ui/**`, `src/components/layout/**`, `src/app/globals.css` y la carpeta nueva `src/lib/touch/**` (con su `README.md`).

### Qué cambia para la persona (por hallazgo)

| ID | Antes | Ahora |
|---|---|---|
| GE-01 | Con una herramienta armada o con zoom, un dedo sobre la hoja no desplazaba nada (`touch-action: none`). | `touch-action: pan-x pan-y` por defecto. Con herramienta armada: un toque coloca, deslizar desplaza la página, mantener ~260 ms y arrastrar dibuja; interruptor visible «Dibujar con el dedo» (dedo = lápiz, sin retardo). Con zoom: el dedo mueve la hoja y, al llegar a su borde, sigue con la página. Pellizco propio con foco en el punto central de los dedos, sin zoom de página (`touchmove` nativo no pasivo con dos dedos). |
| GE-06 | Sin auto-scroll al arrastrar; pan por pellizco limitado a ±400 px. | Auto-desplazamiento por **tiempo** (rampa 0 → 640 px/s en 56 px de borde, igual a 60 y 120 Hz) al arrastrar/redimensionar/dibujar; el pan llega a toda la hoja (`ancho·(zoom−1)/2`). |
| VI-01 | «Crea tu firma…» a una palabra por línea bajo los botones. | `grow basis-56` en el párrafo: ocupa su propia línea si no cabe. |
| VI-04 | La paleta quedaba bajo la barra de zoom (y la firma seleccionada pisaba la paleta). | Paleta `z-[35]`; la barra de zoom empieza donde la hoja (`md:ml-[3.75rem]`) y la paleta que sale por arriba ya no pasa bajo sus botones. |
| VI-05 | Botones `sm` de 36 px (+ pseudo-elemento de 44), enlaces de cabecera/barra lateral de 36-40 px, tirador fuera de caja de 38 px. | `Button sm` mide 44 px con puntero grueso (`pointer-coarse:h-11`, también con `wrap`); cabecera, menú «Herramientas» y barra lateral `pointer-coarse:h-11`; tirador fuera de caja con zona de 44 px. |
| VI-06 | Primario deshabilitado a 2,0-2,6:1. | Pastilla gris `foreground/10` + texto `muted-foreground` (≥ 4,5:1 claro y oscuro), también con `aria-disabled` (regla en `globals.css` por `data-variant`); resto de variantes al 60 %. |
| VI-07 | Botones de 44 px a 0-4 px. | Nuevo `ButtonGroup` (4 px ratón / 8 px dedo); barra de zoom y de páginas del lienzo ya lo usan. |
| SC-03 | Sin safe-area lateral con `viewport-fit=cover`. | `main#content`, cabecera, pie, tab bar, hojas (`Sheet`), paleta y barras `fixed inset-x-0` respetan `env(safe-area-inset-*)`; utilidades `pad-safe-x`, `pl-safe`, `pr-safe`, `pb-safe`, `safe-inset-x`. |
| SC-04 | Entradas de 12-14 px (zoom de Safari). | `@media (pointer: coarse)` ⇒ inputs/selects/textareas ≥ 16 px; el campo sobre la hoja mide 16 px y se escala al 75 % para verse a 12 px. Con ratón no cambia nada. |
| SC-06 | La hoja no se cerraba arrastrando desde el contenido. | `touchmove` nativo: con el contenido arriba del todo, un dedo que baja cierra; uno que sube sigue desplazando. |
| GE-02/04 | Sin contrato de anchos; barra lateral de 17 rem en el iPad horizontal. | `useViewportTier()` (`phone` < 768, `tablet` 768-1023, `desktop` ≥ 1024; `compact` = dedo y < 1280). Barra lateral global plegada por defecto dentro de Firmar y Pro con dedo (la hoja de Firmar pasa de ~460 a ≥ 560 px a 1194). |

### Contrato para M1 (Firmar) y M2 (PDF Pro)

- **Aditivo**: `DocumentCanvasProps` no cambia. Nuevos opcionales: `apiRef?: Ref<DocumentCanvasApi>` y `gestureMode?: "auto" | "scroll" | "draw"`.
- `DocumentCanvasApi.scrollIntoViewRect(rect, { pageIndex?, block?, margin?, behavior?, highlightId? })`: «ver este hueco» en la zona libre (entre barra de zoom y barras fijas), con zoom también mueve la hoja; cambia de página si hace falta. Sin `ref`: `window.dispatchEvent(new CustomEvent(CANVAS_REVEAL_EVENT, { detail: { rect, options } }))`. `getFreeRegion()` y `getGestureMode()`.
- Variable CSS `--canvas-palette-bottom` (paleta fija de móvil, por defecto `calc(9.25rem + safe-bottom)`).
- `@/lib/touch/edgeAutoScroll` (`createEdgeAutoScroller`) sirve al reordenar de Pro (GE-03); `@/lib/touch/viewportTier` (`useViewportTier`) para pasar a layout «tablet» a 834 px; `@/lib/touch/scrollRegion` (`freeRegion`) para «ver este hueco» en regiones propias.

### Pruebas

- E2E: `e2e/specs/mobile-canvas-gestures.spec.ts`, `mobile-shared-ui.spec.ts`, `mobile-safe-area-sheet.spec.ts` (helpers `e2e/helpers/touch-gestures.ts`, `touch-measure.ts`). Gestos reales por CDP `Input.dispatchTouchEvent` en Chromium con perfil iOS; WebKit corre los de layout.
- Vitest: `src/lib/touch/*.test.ts(x)`, `DocumentCanvasApi.test.tsx`, ampliaciones de `Controls.test.tsx`; ajustados (comportamiento erróneo anterior) `DocumentCanvas.test.tsx` (touch-action) y `touchTargets.test.tsx` (`sm` ahora 44 px).

### Límites

Safe-area emulada por CDP, no un iPhone real. Safari/iPad reales sin verificar (rebote, barra de direcciones, auto-zoom real de inputs, Apple Pencil, `touchmove` no pasivo en iOS).

### Cifras de verificación (copia aislada, build de producción, PW_PORT=3979)

- `npx tsc --noEmit` 0; `npx eslint src e2e` 0 errores (2 avisos previos, no míos); vitest completo con `F2_REAL_PDFS=1`: 549 archivos + 4 omitidos, 12 592 tests, 0 fallos.
- E2E nuevos (Chromium): 48 (gestos 14, UI base 20, safe-area/hoja/barra lateral 8, axe 4 × 6 anchos × claro/oscuro × ES/EN); WebKit-iPad: 24 pasan y 23 se omiten (los de tacto CDP).
- Regresión: E2E completo en Chromium 1 246 pasan; los 2 únicos fallos (`pdf-pro-modes-sign` «Aplicar» apagado, opacidad < 1) se corrigieron (`aria-disabled` al 90 %) y pasan; WebKit-iPad (Firmar, Pro, paleta, a11y) 96 pasan.
- Los E2E nuevos fallan sobre el código base (20 + 4 de 52 en una pasada con `git stash` de `src`) y pasan con el arreglo.
## Correcciones móvil/iPad: PDF Pro (M2)

Corrige los hallazgos de PDF Pro de `docs/AUDITORIA-MOVIL-IPAD.md`. Todo vive en `src/app/pdf-pro/**` (más sus specs). Cada hallazgo tiene una prueba E2E que FALLA sin el arreglo (`e2e/specs/mobile-pro-*.spec.ts`, helper `e2e/helpers/mobile-pro.ts`) y pruebas unitarias.

| ID | Qué cambia para el usuario | Dónde |
|---|---|---|
| VP-01 (BLOQUEANTE) | Editar y Anotar dejan una hoja útil en todas las pantallas del informe (px de hoja visible, medidos): SE 320: 0 → 204; SE 375: 124 → 352; iPhone 15 Pro: 309 → 324-336; iPhone horizontal: 13 → 172; móvil 800×360: 0 → 136; iPad mini/Pro: sin cambio (≥ 450). La barra del modo («Editando · Descartar · Aplicar») pasa abajo, la cabecera del documento es de una sola fila, el dock pasa a raíl lateral en horizontal y un botón de 44 px («Ocultar/Mostrar herramientas») pliega paleta, aviso de privacidad y «Aplanar»; el dock queda siempre a un toque. En un alto < 720 px arrancan plegadas. Firmar (parte del lienzo de M1/M3) sigue sin hoja visible en móvil vertical: ver peticiones. | `ProSuite.tsx`, `ProTopBar.tsx`, `modes/ProModeHost.tsx`, `shell/ProMobileDock.tsx`, `shell/useIsDesktop.ts` |
| GE-03 | El auto-desplazamiento al reordenar va en px/s (90–720 px/s según la cercanía al borde, con tope, igual a 60 o 120 Hz); al soltar la lista ya no vuelve al inicio: la página movida queda a la vista (la causa era `focusItem` con el índice viejo) y seleccionada; el marcador de destino es más grueso con el dedo. | `pages/PageGrid.tsx` |
| GE-05 | Hoja «Páginas» en móvil: 3 columnas, ≥ 2 filas completas, asa de arrastre fuera de la miniatura, estado en una fila y «Aplicar»/«Descartar» abajo (texto corto, nombre accesible completo). | `pages/PagesTab.tsx`, `pages/PagesToolbar.tsx`, `pages/PageGrid.tsx` |
| SC-05 | `touch-action: pan-x pan-y` en la suite: pellizcar fuera de la hoja ya no acerca toda la página (medido: ×5 antes, ×1 ahora). El zoom de la hoja sigue con pellizco y con los botones +/−. | `ProSuite.tsx` |
| VI-02 | «Reconocer texto (OCR)» envuelve y la etiqueta «Requiere conexión» baja bajo el título. | `tabs/DocumentTab.tsx` |
| VI-03 | Dock con celdas de 56 px mínimo: a 320 px se desplaza en vez de tocar las etiquetas. | `shell/ProMobileDock.tsx` |
| VI-08 | Con puntero táctil las ayudas de Editar/Anotar hablan de «tocar» y «arrastrar», sin «Haz clic» ni «Esc». | `modes/ProEditorMode.tsx`, `modes/modeStrings.ts` |
| GE-02 (Pro) | iPad vertical (834 px): el visor mide ≈ 680 px (antes 332 px): con un dedo (`pointer: coarse`) el visor no baja de 448 px (`TOUCH_MIN_VIEWER_WIDTH`), el panel de herramientas se pliega solo y las pestañas lo reabren; con ratón el reparto no cambia (320 px). Un móvil horizontal (> 768 px de ancho pero < 480 px de alto) usa el reparto móvil. | `shell/proLayout.ts`, `shell/useIsDesktop.ts` |
| ER-02 (Pro) | «Aplicar» y «Descartar» de los modos y «Aplicar cambios» de Páginas están en la mitad inferior de la pantalla. | `modes/ProModeHost.tsx`, `pages/PagesToolbar.tsx` |
| VI-07 (Pro) | ≥ 8 px entre botones contiguos con puntero táctil en la barra del visor, la cabecera, la barra del modo y la barra de Páginas. | `viewer/ViewerToolbar.tsx`, `pages/PagesToolbar.tsx` |
| SC-04 (Pro) | «Ir a la página», la paleta de comandos y los campos de los paneles de herramienta miden 16 px con puntero táctil. | `viewer/ViewerToolbar.tsx`, `shell/coarseInputs.ts`, `shell/CommandPalette.tsx`, `tabs/panels/*` |
| GE-01 (Pro) | Con puntero táctil, Editar y Anotar traen un interruptor «Desplazar» (44 px, `role="switch"`): activado, un dedo sobre la hoja la desplaza aunque haya una herramienta armada y un toque corto sigue colocando el elemento. | `modes/ProModeHost.tsx` |
| SC-03 (extra) | Zona segura lateral en cabecera, barra del visor, barra del modo y raíl. | idem |

### Diseño

- **Un solo estado de plegado** (`foldPref ?? alto < 720`) en `ProSuite`; el host de modos pinta la barra (arriba en escritorio, abajo en móvil, dentro de la cabecera en móvil horizontal) y marca `data-chrome="collapsed"`. El dock no se pliega. Lo que se pliega se apoya en los marcadores del propio editor (`data-tool-palette`, `data-edit-privacy`, `data-page-actions`) y en `data-pro-fold`, sin tocar `edit-pdf`.
- **Interruptor «Desplazar»**: anula el `touch-none` que `EditWorkspace` pone a la hoja con una herramienta armada mediante `data-pan` + `touch-pan-y!` en el host; el editor no cambia.
- **Escritorio no cambia**: la barra del modo sigue arriba y sin botón de plegar; todos los textos de escritorio se conservan para puntero fino.

### Pruebas que cambian (y por qué)

- `edit-palette-reach.spec.ts` (Pro · modo Editar, 360×640): con alto < 720 px las barras arrancan plegadas, así que la prueba pulsa «Mostrar herramientas» antes de medir; la comprobación (≥ 44 px, dentro de la ventana, nada encima) es la misma.

### Peticiones a otros dueños

- **M3 (lienzo compartido `DocumentCanvas*.tsx`)**: GE-01 en Firmar (`touch-none` con herramienta armada o zoom > 1); en el modo Firmar de Pro la hoja sigue empezando bajo la configuración (0–16 px visibles en móvil vertical): con `useProModeHost()` ≠ null conviene ordenar la hoja primero, plegar «Solo yo/Varios», «Qué debes saber» y la tarjeta de firma, y anclar la paleta al contenedor (hoy es `fixed` y flota sobre la barra de Pro). Pro expone `[data-pro-mode-host][data-chrome="collapsed"]` por si quieren compactar más.
- **Dueño de `edit-pdf`**: el campo «Ir a la página» y «Fuente/Tamaño» del editor siguen en 13–14 px; las ayudas de escritorio (`toolHints`) se sustituyen desde Pro por `modeStrings.touchHints` y podrían vivir allí.
- **M3 (layout)**: opcional, ocultar la cabecera global en horizontal bajo 480 px de alto cuando `<html data-pro-suite>` (Pro ya fija la altura con `dvh`, pero la cabecera de 56 px sigue siendo el 14 % de 393 px).
- **Config de Playwright**: añadir `mobile-pro-(sheet-space|pages|touch|a11y)` a `CROSS_SPECS` si se quiere que corran por defecto en `webkit-ipad`.

### No verificado

Safari/iPad reales (rebote, barra de direcciones dinámica y `dvh`, zoom automático por campos < 16 px, `touch-action` en iOS, isla/notch), VoiceOver, Apple Pencil, 120 Hz real (la velocidad del auto-desplazamiento se midió en Chromium a la tasa de fotogramas del emulador y se prueba como función pura en px/s) y PDF reales grandes.
