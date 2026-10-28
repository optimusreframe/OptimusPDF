#!/usr/bin/env python3
"""
Mutaciones del motor del Escaner (`src/lib/scan/*`) y de su integracion con Recientes: aplica de una en una cambios pequenos
(umbrales, signos, prioridades de la guia, estabilidad, orientacion, blanco, repetidas, filtros, EXIF/giro, sesion
persistente, expiracion, conflicto entre pestanas, guardado incremental, PDF...) y comprueba que las pruebas fallan. Una
mutacion que NO hace fallar ninguna prueba «sobrevive» e indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/scan-engine-mutate.py              # todas
    python3 scripts/scan-engine-mutate.py S03 S07      # solo esas
    python3 scripts/scan-engine-mutate.py --check      # solo comprueba que el texto original existe
    python3 scripts/scan-engine-mutate.py --fast       # solo pruebas unitarias rapidas (sin el informe de metricas del corpus)

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
D = "src/lib/scan"
LIVE = f"{D}/liveFrame.ts"
LDET = f"{D}/liveDetect.ts"
QUAL = f"{D}/quality.ts"
FILT = f"{D}/filters.ts"
ORI = f"{D}/orientation.ts"
SIM = f"{D}/similarity.ts"
NAME = f"{D}/naming.ts"
CORE = f"{D}/renderCore.ts"
STORE = f"{D}/sessionStore.ts"
DETECT = f"{D}/documentDetection.ts"
TEXT = f"{D}/textLayer.ts"
BUILD = f"{D}/buildPdf.ts"
SPINE = f"{D}/spine.ts"
RES = "src/lib/resumeLinks.ts"
UNF = "src/app/recent/unfinishedWork.ts"
DISC = "src/app/recent/discardDraft.ts"
GATE = f"{D}/cropGate.ts"
OCR = f"{D}/ocr.ts"
FIND = f"{D}/findCorners.ts"
TASKS = f"{D}/renderTasks.ts"
QUEUE = f"{D}/renderBrowser.ts"
WORKER = f"{D}/renderWorker.ts"
REAL = f"{D}/realEngine.ts"
RBR = f"{D}/renderBrowser.ts"
ENG = f"{D}/engine.ts"
EST = f"{D}/estimate.ts"
CREF = f"{D}/cropRefine.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    ("S01", LIVE, "export const AUTO_CAPTURE_STABLE_MS = 700;", "export const AUTO_CAPTURE_STABLE_MS = 0;", "captura automatica sin esperar la quietud"),
    ("S02", LIVE, "if (reading.dark) return \"too_dark\";\n  if (reading.glare) return \"glare\";", "if (reading.glare) return \"glare\";\n  if (reading.dark) return \"too_dark\";", "guia: brillo antes que poca luz"),
    ("S03", LIVE, "if (!reading.quad) return \"no_document\";", "if (!reading.quad) return \"unknown\";", "guia: sin documento ya no avisa"),
    ("S04", LIVE, "const shouldAutoCapture =\n    found && hint === \"ok\" && stableMs >= AUTO_CAPTURE_STABLE_MS && !reading.blurry && !reading.glare && !reading.dark;", "const shouldAutoCapture = found && stableMs >= AUTO_CAPTURE_STABLE_MS;", "captura automatica sin comprobar enfoque, brillo ni luz"),
    ("S05", LIVE, "still = shift <= STABLE_CORNER_SHIFT && motion <= STABLE_MOTION;", "still = shift <= STABLE_CORNER_SHIFT || motion <= STABLE_MOTION;", "quietud: basta con una de las dos medidas"),
    ("S06", LIVE, "if (sinceLast > 1500) {", "if (sinceLast > 1500000) {", "una pausa larga ya no reinicia la quietud"),
    ("S07", LDET, "if (share < MIN_AREA || share > MAX_REGION_SHARE) return null;", "if (share < MIN_AREA) return null;", "un fotograma liso se toma por documento"),
    ("S08", QUAL, "export const BLANK_MAX_CELLS = 48;", "export const BLANK_MAX_CELLS = 5;", "hoja en blanco: un sello pequeno ya no cuenta"),
    ("S09", QUAL, "blurry: !blank && !sparse && (", "blurry: (", "una hoja en blanco se marca borrosa"),
    ("S10", QUAL, "dark: paperLevel < DARK_PAPER_THRESHOLD && brightLevel", "dark: paperLevel > DARK_PAPER_THRESHOLD && brightLevel", "oscuridad: comparacion invertida"),
    ("S11", FILT, "const document = median >= 55 &&", "const document = median >= 255 &&", "auto: un documento con poca luz se trata como foto"),
    ("S12", FILT, "if (mode === \"photo\") return \"original\";", "if (mode === \"photo\") return filter === \"auto\" ? \"color\" : filter;", "modo foto: se filtra aunque se pida sin tocar"),
    ("S13", ORI, "const upright = evidence.score > 0;", "const upright = evidence.score < 0;", "orientacion: derecho y cabeza abajo intercambiados"),
    ("S14", ORI, "if (evidence.lines < 3 || Math.abs(evidence.score) < MIN_FLIP_SCORE) return null;", "if (evidence.lines < 3) return null;", "orientacion: gira aunque la evidencia sea debil"),
    ("S15", SIM, "similarity.fraction >= DUPLICATE_MIN_BLOCKS &&\n    similarity.explained >= DUPLICATE_MIN_EXPLAINED", "true", "repetidas: sin los dos criterios de parecido el mismo formulario con otros datos se marca (cada uno solo es redundante a proposito)"),
    ("S16", NAME, "if (line.confidence < 55) return false;", "", "titulo: una linea de lectura dudosa puede ser titulo"),
    ("S17", CORE, "current = { topLeft: current.bottomLeft, topRight: current.topLeft, bottomRight: current.topRight, bottomLeft: current.bottomRight };", "current = { topLeft: current.topRight, topRight: current.bottomRight, bottomRight: current.bottomLeft, bottomLeft: current.topLeft };", "el giro de la pagina va en sentido contrario"),
    ("S18", CORE, "if (Math.abs(long / short - ID_CARD_RATIO) / ID_CARD_RATIO < 0.18) {", "if (false) {", "tarjeta: no se ajusta a la proporcion de carnet"),
    ("S19", NAME, "const limit = ocr.height * 0.45;", "const limit = ocr.height * 1.0;", "titulo: cuenta una linea del pie de pagina"),
    ("S20", NAME, "const earliest = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());", "const earliest = new Date(1990, 0, 1);", "fecha del documento: se fia de fechas viejas"),
    ("S21", STORE, "row.expiresAt <= now)", "row.expiresAt < 0)", "expiracion: no se borra nada caducado"),
    ("S22", STORE, "if (stored && stored.writerId !== tab.id && stored.rev > (tab.knownRevs.get(targetId) ?? 0)) {", "if (false) {", "pestanas: la copia de otra pestana se pisa"),
    ("S23", STORE, "if (dirtyPages.length === 0 && !metaChanged) return { ok: true, rev: base?.rev };", "if (false) return { ok: true, rev: base?.rev };", "guardado: sin cambios igualmente reescribe"),
    ("S24", STORE, "!== blobId(page.original));\n    const dirtyOriginals", "!== \"never\");\n    const dirtyOriginals", "guardado: se reescriben todas las paginas siempre"),
    ("S25", STORE, "if (bytes > limits.maxSessionBytes) return { ok: false, reason: \"tooBig\" };", "", "limites: una sesion enorme se guarda"),
    ("S26", STORE, "if (isQuotaError(error)) return { ok: false, reason: \"quota\" };\n    if (storageMode === \"blob\") {", "if (storageMode === \"blob\") {", "cuota: un error de cuota se reintenta con bytes"),
    ("S27", STORE, "if (blob && blob.size > 0) originalsById.set(row.pid, blob);", "if (blob) originalsById.set(row.pid, blob);", "integridad: un original vacio se da por bueno"),
    ("S28", RES, "scan: SCAN_SESSION_ID,", "scan: /^.*$/,", "Recientes: cualquier texto vale como id de sesion de escaneo"),
    ("S29", UNF, "if (!isValidResumeId(\"scan\", session.id) || session.pageCount <= 0) continue;", "if (!isValidResumeId(\"scan\", session.id)) continue;", "Recientes: una sesion vacia promete «Continuar»"),
    ("S30", DISC, "await scanSessionStore.remove(item.target.id);", "await Promise.resolve();", "Recientes: «Descartar» no borra la sesion"),
    ("S31", TEXT, "renderMode: TextRenderingMode.Invisible", "renderMode: TextRenderingMode.Fill", "PDF: el texto buscable se ve encima de la imagen"),
    ("S32", BUILD, "const steps = searchable ? 3 : 2;", "const steps = 2;", "PDF: el progreso no cuenta el paso del OCR"),
    ("S33", DETECT, "if (quadIoU(a, b) >= 0.85) return a;", "if (quadIoU(a, b) >= 0.85) return b;", "deteccion: con acuerdo se prefiere el ligero al preciso"),
    ("S34", SPINE, "const confidence = interior ? Math.max(0, Math.min(1, contrast / 0.25)) : 0;", "const confidence = Math.max(0, Math.min(1, contrast / 0.25));", "lomo: una sombra en el borde de la ventana cuenta"),
    # --- Correcciones tras la verificacion independiente (P1-1 recorte, P1-2/P1-3 OCR, P1-4 sin conexion, P2-7 avisos, P2-8 presets, P2-10 volcado)
    ("P01", GATE, "if (area < limits.minArea || area > 0.9) return { accept: false, reason: \"area\", features };", "if (area > 0.9) return { accept: false, reason: \"area\", features };", "recorte: una mota de hoja se recorta"),
    ("P02", GATE, "if (!aspectIn(aspect, limits.aspect)) return { accept: false, reason: \"aspect\", features };", "", "recorte: una franja de proporcion imposible se recorta (el rectangulo rojo interior)"),
    ("P03", GATE, "export const MIN_EDGE_SUPPORT = 0.9;", "export const MIN_EDGE_SUPPORT = 0;", "recorte: no hace falta que los lados sean bordes reales"),
    ("P04", GATE, "if (limits.paper && !(features.paperShare", "if (false && !(features.paperShare", "recorte: el interior no tiene que parecer papel (un objeto de color se recorta)"),
    ("P05", GATE, "if (features.lumaGap < MIN_LUMA_GAP && features.colorGap < MIN_COLOR_GAP) return", "if (false) return", "recorte: se recorta aunque el exterior sea igual que el interior (la foto ya es toda documento)"),
    ("P06", GATE, "if (mode === \"photo\") return { candidate: null, verdict: null };", "", "recorte: el modo foto tambien recorta"),
    ("P07", QUAL, "  return sharpness < BLUR_ACUTANCE_THRESHOLD && reblur < BLUR_REBLUR_THRESHOLD;", "  return sharpness < BLUR_ACUTANCE_THRESHOLD;", "avisos: borrosa solo por acutancia (falsos «Borrosa» en fotos reales nitidas)"),
    ("P08", QUAL, "blob.box / (width * height) <= GLARE_MAX_BOX", "true", "avisos: el blanco de una hoja con texto cuenta como reflejo"),
    ("P09", QUAL, "const surrounded = total > 0 && paper >= total * 0.15 && reference <= GLARE_PAPER_MAX;", "const surrounded = true;", "avisos: una escena oscura con una luz o una pared blanca cuentan como reflejo"),
    ("P10", BUILD, "      if (!gate.ok) {", "      if (false) {", "PDF buscable: sin modelo en local se intenta igualmente el OCR (y falla o descarga sin permiso)"),
    ("P11", BUILD, "warn(code === \"ocrNetworkFailure\" ? \"network\" : \"engine\", withText);", "warn(\"engine\", withText);", "PDF buscable: el aviso no distingue un fallo de red"),
    ("P12", BUILD, "          // El OCR no se pudo hacer (sin red para el modelo, motor roto): se entrega el PDF sin el texto que falte.\n", "          throw error;\n", "PDF buscable: un fallo del OCR rompe el PDF en vez de degradar"),
    ("P13", OCR, "      return present.every(Boolean);", "      return present.some(Boolean);", "OCR: con solo un idioma en la cache se da el modelo por disponible"),
    ("P14", OCR, "    if (!known.some((db) => db.name === TESSERACT_CACHE_DB)) return false;", "", "OCR: se abre la base de tesseract.js aunque no exista (la dejaria rota)"),
    ("P15", OCR, "if (typeof navigator !== \"undefined\" && navigator.onLine === false) return { ok: false, reason: \"offline\" };", "", "OCR: se intenta descargar el modelo sin conexion"),
    ("P16", RBR, "const WORKER_RETRY_MS = 15_000;", "const WORKER_RETRY_MS = 1_000_000_000_000;", "sin conexion: el worker que fallo una vez no se vuelve a probar nunca"),
    ("P17", RBR, "if (!isBroken() && workerSupported()) {", "if (workerSupported()) {", "sin conexion: cada tarea vuelve a pagar un worker roto"),
    ("P18", DETECT, "    modulePromise = null;\n    throw error;\n  });\n  return modulePromise;", "    throw error;\n  });\n  return modulePromise;", "sin conexion: el rechazo de scanic queda cacheado hasta recargar"),
    ("P19", ENG, "  realPromise ??= loadReal().catch((error: unknown) => {\n    realPromise = null;\n    throw error;\n  });", "  realPromise ??= loadReal();", "sin conexion: el rechazo del motor real queda cacheado hasta recargar"),
    ("P20", EST, "  if (mode === \"photo\") return true;", "  if (mode === \"photo\") return false;", "presets: una foto sin tocar se estima como si se recodificara"),
    ("P21", FILT, "backgroundAt(maps[c], x + ox, y + oy));\n          data[o + c] = DOC_CURVE", "backgroundAt(maps[c], x, y));\n          data[o + c] = DOC_CURVE", "presets: el fondo de un fragmento se busca en la posicion equivocada"),
    ("P22", STORE, "  staged.set(session.id, session);\n  installLeaveHooks();", "  installLeaveHooks();", "volcado: lo apuntado con stage no se guarda"),
    ("P23", STORE, "  window.addEventListener(\"pagehide\", flushStagedOnLeave);", "", "volcado: pagehide no vuelca lo apuntado"),
    ("P26", EST, "export const MODEL_KEEP_BAND: KeepBand = { below: 0.15, above: 0.02 };", "export const MODEL_KEEP_BAND: KeepBand = { below: 0, above: 0 };", "presets: la estimacion de Alta ignora la regla del 15 % (extremo optimista)"),
    ("P27", OCR, "    if (typeof listing !== \"function\") return false;", "    if (typeof listing !== \"function\") return true;", "OCR: sin indexedDB.databases() se da el modelo por disponible sin mirarlo"),
    # --- Segunda ronda (membretes y lados del recorte, estimacion de paginas procesadas, nitidez/blanco a mayor resolucion, brillo/oscura, carga del motor, trozos del analisis)
    ("R01", CREF, "if (stepAt.length >= SAMPLES * STEP_MIN_SHARE && lineResidual", "if (false && lineResidual", "lados: un membrete oscuro con borde nitido detras del recorte no se detecta"),
    ("R02", CREF, "if (outliers / beyond.length >= OUTLIER_MIN_SHARE && columns >= OUTLIER_MIN_COLUMNS) return", "if (false) return", "lados: un membrete del color de la mesa pero con texto blanco no se detecta"),
    ("R03", CREF, "export const SAFETY_MARGIN_PX = 2;", "export const SAFETY_MARGIN_PX = 0;", "lados: sin margen de seguridad hacia fuera"),
    ("R04", CREF, "      pushes.push(Math.max(0, push));", "      pushes.push(0);", "lados: nunca se empujan hacia el borde real del papel"),
    ("R05", CREF, "      if (channelGap(paper, globalPaper) > GLOBAL_PAPER_TOLERANCE) {", "      if (false) {", "lados: se empuja aunque lo de dentro no parezca papel (la mesa cuenta como papel)"),
    ("R06", CREF, "    if (shift > maxShift) return { ok: false, reason: \"paper-continues\", side };", "", "lados: un recorte muy por dentro del papel se acepta"),
    ("R07", CREF, "export const STEP_SHARPNESS = 0.35;", "export const STEP_SHARPNESS = 0;", "lados: la penumbra de una sombra cuenta como borde"),
    ("R08", CREF, "    if (paperReachedCap > SAMPLES * 0.25) return { ok: false, reason: \"paper-continues\", side };", "", "lados: un papel que no acaba (fondo del color del papel) se acepta"),
    ("R09", GATE, "  if (!refined.ok) return { quad: null, verdict: { accept: false, reason: refined.reason, features: verdict.features } };", "", "recorte: no se aplica el ajuste ni la comprobacion de los lados"),
    ("R10", QUAL, "  if (reblur === null) return content && sharpness < VERY_BLURRY_ACUTANCE;", "  if (reblur === null) return false;", "borrosa: un texto desenfocado hasta no leerse (sin bordes) no se marca"),
    ("R11", QUAL, "  const blank = isEmptyPage(ink) && smooth;", "  const blank = isEmptyPage(ink);", "en blanco: un texto desenfocado ilegible cuenta como hoja en blanco"),
    ("R12", QUAL, "export const SHARPNESS_SIDE = 960;", "export const SHARPNESS_SIDE = 480;", "borrosa: la nitidez se mide a baja resolucion"),
    ("R13", "src/lib/scan/renderCore.ts", "    const wide = job.maxSide < MEASURE_CROP_SIDE && Math.max(source.width, source.height) > job.maxSide * 1.15 ?", "    const wide = false ?", "borrosa: la nitidez se mide sobre la miniatura de 640 px"),
    ("R14", QUAL, "      if (slope > GLARE_FLAT_SLOPE) continue;", "", "brillo: el borde antialias de un texto digital cuenta como papel (falso reflejo)"),
    ("R15", QUAL, "    dark: paperLevel < DARK_PAPER_THRESHOLD && brightLevel < DARK_BRIGHT_THRESHOLD,", "    dark: paperLevel < DARK_PAPER_THRESHOLD,", "oscura: una hoja iluminada sobre mesa oscura sale «oscura»"),
    ("R16", EST, "    if (expected.qualityRatio && presetId !== \"original\") {", "    if (false) {", "estimacion: las paginas procesadas no se estiman con su propia medida"),
    ("R17", EST, "  if (plan.action === \"keep\") return bytes;", "", "estimacion: una pagina que ya pesa poco por pixel se estima como recodificada"),
    ("R18", EST, "  if (ratio >= high) return original;", "", "estimacion: sin ahorro previsto sigue estimando lo recodificado"),
    ("R19", ENG, "  for (let attempt = 0; attempt <= ENGINE_LOAD_BACKOFF_MS.length; attempt += 1) {", "  for (let attempt = 0; attempt < 1; attempt += 1) {", "motor: un fallo puntual de carga no se reintenta"),
    ("R20", ENG, "  const needsReload = failedWhileOffline && online();", "  const needsReload = false;", "motor: no avisa de que hay que recargar si el cargador recuerda el fallo"),
    ("R21", ENG, "{ reason: \"load-failed\", needsReload, cause: lastError }", "{ reason: \"not-installed\", needsReload, cause: lastError }", "motor: el fallo de carga se confunde con «sin motor»"),
    ("R22", SIM, "    await pause();", "", "analisis: comparar hojas no cede el hilo"),
    ("R23", SIM, "    yield;\n  }", "  }", "analisis: la busqueda de alineacion de un bloque no cede el hilo"),
    ("R24", STORE, "  if (!asBytes && !blobVerified) return false;", "", "volcado: en modo blob sin guardado normal previo se arriesga una transaccion al irse (WebKit se cuelga)"),
    ("R25", STORE, "let storageMode: \"blob\" | \"bytes\" = readModeHint();", "let storageMode: \"blob\" | \"bytes\" = \"blob\";", "volcado: tras recargar se vuelve a probar Blob en un navegador que ya se sabe que no los guarda"),
    ("R26", STORE, "      if (asBytes && !row.thumbBytes) row.thumb = null;", "", "volcado: una pagina con miniatura nueva sin leer escribe un Blob en modo bytes"),
    ("R27", CREF, "    if (fit && fit.start <= maxShift && fit.end <= maxShift) {", "    if (false) {", "lados: un lado girado respecto al borde no se endereza (la cuña de papel de una esquina queda fuera)"),
    # --- Tercera ronda (tarjetas con cabecera, bordes inclinados, en blanco/casi vacia, desenfoque extremo, guardado en WebKit, guardado anticipado)
    ("T01", CREF, "lineResidual(stepAt) <= STEP_LINE_TOLERANCE", "lineResidual(stepAt) <= 0", "lados: un borde de membrete INCLINADO respecto al lado no se detecta"),
    ("T02", CREF, "    const margin = Math.max(SAFETY_MARGIN_PX, (options.margin ?? 0) * length);", "    const margin = SAFETY_MARGIN_PX;", "lados: las tarjetas pierden su margen de seguridad extra"),
    ("T03", GATE, "refineCrop(image, candidate, mode === \"id-card\" ? { margin: CARD_MARGIN_FRACTION } : {});", "refineCrop(image, candidate, {});", "recorte: el modo tarjeta no aplica el margen extra"),
    ("T04", QUAL, "  return stats.cells === 0 && stats.fraction <= EMPTY_MAX_FRACTION;", "  return stats.cells <= BLANK_MAX_CELLS && stats.fraction <= BLANK_MAX_FRACTION;", "en blanco: una firma, un sello o una palabra cuentan como hoja en blanco (se borrarian al quitar las blancas)"),
    ("T05", QUAL, "  const sparse = !blank && isBlankPage(ink) && smooth;", "  const sparse = false;", "casi vacia: una pagina con muy poco contenido no se avisa"),
    ("T06", QUAL, "  return sharpness === null && layout >= FADED_MIN_LAYOUT_SHARE;", "  return false;", "borrosa: un texto difuminado hasta desaparecer no se detecta"),
    ("T07", QUAL, "    blurry: !blank && !sparse && (", "    blurry: !blank && (", "borrosa: una pagina casi vacia con unas manchas suaves se marca borrosa"),
    ("T08", STORE, "    tx.onerror = (event) => fail(tx.error ?? (event?.target as IDBRequest | null)?.error ?? new Error(\"error de IndexedDB\"));", "", "guardado: un `error` de la transaccion (WebKit no emite abort) no se da por fallo"),
    ("T09", STORE, "    const timer = setTimeout(() => fail(new Error(\"la transaccion tarda demasiado\")), txGuardMs);", "    const timer = setTimeout(() => {}, txGuardMs);", "guardado: una transaccion sin eventos se espera para siempre"),
    ("T10", STORE, "    const timer = setTimeout(() => resolve({ ok: false, reason: \"unavailable\" }), saveGuardMs);", "    const timer = setTimeout(() => {}, saveGuardMs);", "guardado: un guardado colgado nunca devuelve el fallo a la interfaz"),
    ("T11", STORE, "  await settleStorageMode();\n  let db: IDBDatabase;", "  let db: IDBDatabase;", "guardado: no se prueba si el navegador guarda Blob antes de escribir"),
    ("T12", STORE, "  scheduleEarlySave(session.id);", "", "guardado: lo apuntado con stage no se guarda hasta el autoguardado largo o el pagehide"),
    ("T13", STORE, "      request.onerror = () => done(true);", "      request.onerror = () => done(false);", "guardado: un fallo al abrir la base de pruebas se toma por falta de Blob"),
    ("P25", STORE, "  if (!db || !validSession(session)) return false;\n  const asBytes", "  if (!db || storageMode !== \"blob\" || !validSession(session)) return false;\n  const asBytes", "volcado: sin Blob en IndexedDB (WebKit) el volcado al irse no empieza la transaccion en el acto"),
    ("P24", STORE, "    if (document.visibilityState === \"hidden\") flushStagedOnLeave();", "    if (false) flushStagedOnLeave();", "volcado: ocultar la pestana no vuelca lo apuntado"),
    ("W01", FIND, "  await yieldNow();\n  const live = detectLiveQuad(image);", "  const live = detectLiveQuad(image);", "deteccion: no se cede el hilo tras el detector (sin worker, una tarea larga)"),
    ("W02", FIND, "  await yieldNow();\n  return finishCrop", "  return finishCrop", "deteccion: no se cede el hilo antes de ajustar los lados (sin worker, una tarea larga)"),
    ("W03", FIND, "new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)", "new ImageData(image.data, image.width, image.height)", "deteccion: el detector recibe la imagen decodificada y no una copia"),
    ("W04", TASKS, "      cache = { token: request.token, image };\n      const corners = await findDocumentCorners", "      const corners = await findDocumentCorners", "deteccion: la imagen decodificada no se deja en cache para el render (se decodifica dos veces)"),
    ("W05", TASKS, "      const corners = await findDocumentCorners(image, request.mode, hooks.yield);", "      const corners = await findDocumentCorners(image, request.mode);", "deteccion: la tarea no pasa la cesion del hilo al buscar el documento"),
    ("W06", QUEUE, 'if (request.kind !== "decode" && request.kind !== "detect") clearTaskCache();', 'if (request.kind !== "decode") clearTaskCache();', "deteccion: sin worker, la cache de la imagen se libera antes de que el render la use"),
    ("W07", QUEUE, "    worker.postMessage({ warm: true } satisfies WorkerRequest);\n", "", "worker: no se le pide precargar el detector al calentarlo"),
    ("W08", WORKER, "    preloadDocumentDetection();\n    return;", "    return;", "worker: el aviso de calentar no precarga el detector"),
    ("W09", REAL, 'const detected = await enqueueTask({ kind: "detect", source: original, maxSide: DETECT_SIDE, mode, token }, signal);', 'const detected = await enqueueTask({ kind: "detect", source: original, maxSide: DETECT_SIDE, mode: "photo", token }, signal);', "deteccion: la tarea de detectar no recibe el modo de la pagina"),
]

FAST = ["npx", "vitest", "run", "--project", "engines", "--exclude", "src/lib/scan/scan.metrics.test.ts", "src/lib/scan", "src/app/recent", "src/lib/resumeLinks"]
FULL = ["npx", "vitest", "run", "--project", "engines", "src/lib/scan", "src/app/recent", "src/lib/resumeLinks"]
TESTS = FAST if "--fast" in sys.argv else FULL
# Las pruebas de componentes de lo del Escaner (jsdom: OCR, volcado al irse la pagina) tambien cuentan para matar una mutacion.
COMPONENTS = ["npx", "vitest", "run", "--project", "components", "src/lib/scan"]


def run_tests() -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive)."""
    if subprocess.run(TESTS, cwd=ROOT, capture_output=True, text=True).returncode != 0:
        return False
    return subprocess.run(COMPONENTS, cwd=ROOT, capture_output=True, text=True).returncode == 0


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check" in sys.argv
    wanted = set(args)
    selected = [m for m in MUTATIONS if not wanted or m[0] in wanted]
    missing = []
    for mutation_id, file, old, new, description in selected:
        original = (ROOT / file).read_text(encoding="utf8")
        if old not in original:
            missing.append(mutation_id)
            print(f"{mutation_id}: NO APLICA (texto original no encontrado) - {description}")
        elif old == new:
            missing.append(mutation_id)
            print(f"{mutation_id}: NO CAMBIA NADA - {description}")
    if check_only:
        print(f"{len(selected) - len(missing)} de {len(selected)} mutaciones aplican")
        return 1 if missing else 0
    if not run_tests():
        print("Las pruebas ya fallan sin mutar: arreglalas antes.")
        return 2
    survivors = list(missing)
    for mutation_id, file, old, new, description in selected:
        if mutation_id in missing:
            continue
        path = ROOT / file
        original = path.read_text(encoding="utf8")
        started = time.time()
        try:
            path.write_text(original.replace(old, new), encoding="utf8")
            alive = run_tests()
        finally:
            path.write_text(original, encoding="utf8")
        status = "SOBREVIVE" if alive else "muere"
        print(f"{mutation_id}: {status:10s} ({time.time() - started:4.1f}s) {description}", flush=True)
        if alive:
            survivors.append(mutation_id)
    killed = len(selected) - len(survivors)
    print(f"\n{killed} de {len(selected)} mutaciones mueren; sobreviven: {', '.join(survivors) or 'ninguna'}")
    return 0 if not survivors else 1


if __name__ == "__main__":
    sys.exit(main())
