#!/usr/bin/env python3
"""
Mutaciones del modulo «Escaneos en curso» del respaldo (sesiones del Escaner en el «OptimusPDF Package»): aplica de una en
una cambios pequenos a la logica (resumen, exportar, validadores, planificar, decisiones, limites, aplicar, orquestacion
global, modelo de pantalla, hojas y tarjetas) y comprueba que las pruebas fallan. Una mutacion que NO hace fallar ninguna
prueba «sobrevive» y senala una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/backup-scan-sessions-mutate.py            # todas
    python3 scripts/backup-scan-sessions-mutate.py S01 C04    # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOD = "src/lib/backup/modules/scanSessions.ts"
SCHEMA = "src/lib/backup/modules/scanSessionsSchema.ts"
GP = "src/lib/backup/globalPackage.ts"
LAST = "src/lib/backup/lastBackup.ts"
MODEL = "src/app/settings/packageModel.ts"
EXPORT = "src/app/settings/ExportPackageSheet.tsx"
IMPORT = "src/app/settings/ImportPackageSheet.tsx"
CARDS = "src/app/settings/PackageItemCards.tsx"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    # --- modulo: resumen y exportar ---
    ("S01", MOD, "  const known = sizeMemo.get(summary.id);\n  if (known && known.savedAt === summary.savedAt) return { pages: known.pages, bytes: known.bytes };\n", "", "el tamano medido se recuerda por id + fecha de guardado"),
    ("S02", MOD, "(summary) => wanted === null || wanted.has(summary.id)", "(summary) => true", "solo las sesiones pedidas con `ids`"),
    ("S03", MOD, "if (bytes + declared > PACKAGE_BYTES_BUDGET || pages + session.pages.length > MAX_SCAN_PACKAGE_PAGES) throw new PackageError(\"tooLarge\");", "", "lo que no cabe se rechaza ANTES de leer ninguna foto"),
    ("S04", MOD, "    skippedPages += portable.skippedPages + (session.lostPages ?? 0);", "    skippedPages += portable.skippedPages;", "las paginas que el almacen dio por perdidas se cuentan"),
    ("S05", MOD, "    if (!parseScanPage(item, sessionRef)) return null;\n", "", "nunca se escribe lo que el lector rechazaria"),
    ("S06", MOD, "    if (sessions.length >= MAX_SCAN_PACKAGE_SESSIONS) throw new PackageError(\"tooLarge\");\n", "", "tope de sesiones por paquete"),
    # --- modulo: planificar ---
    ("S07", MOD, "  if (Date.parse(header.savedAt) + SCAN_SESSION_TTL_MS <= now) return invalid(\"expired\", header);", "", "una sesion caducada en el paquete se rechaza"),
    ("S08", MOD, "    if (!inspected.ok || inspected.info.ext !== parsed.ext ||", "    if (!inspected.ok ||", "la extension de la ruta es la del formato REAL de los bytes"),
    ("S09", MOD, "    if (!parsed || seenRefs.has(parsed.ref) || seenIds.has(parsed.id)) {", "    if (!parsed) {", "ids y referencias de pagina repetidos se descartan"),
    ("S10", MOD, "  if (declaredPages > MAX_SCAN_PACKAGE_PAGES) return emptyPlan(\"damaged\", now);\n", "", "un indice con mas paginas de las que caben en un paquete es hostil"),
    ("S11", MOD, " || migrated.sessions.length > MAX_SCAN_PACKAGE_SESSIONS) throw", ") throw", "mas sesiones de las que caben: indice hostil"),
    ("S12", MOD, "  if (storeBytesOf(originalBytes, pages.length) > SESSION_BYTES_CAP) return invalid(\"tooLarge\", header);", "", "tope por sesion del almacen"),
    ("S13", MOD, "      if ((await sha256Hex(await readBytes(page.original))) !== payload.pages[index].sha256) return false;", "", "identica = mismos bytes (no solo mismo tamano)"),
    ("S14", MOD, "    if (summary.id === item.id || summary.pageCount !== payload.pages.length || summary.name !== payload.name) continue;", "    if (summary.id === item.id) continue;", "el mismo contenido bajo otro id solo se busca entre sesiones parecidas"),
    ("S15", MOD, "  return !(Number.isFinite(a) && Number.isFinite(b)) || a >= b;", "  return !(Number.isFinite(a) && Number.isFinite(b)) || a > b;", "un empate de fechas cuenta como «igual de nueva»"),
    # --- modulo: decisiones y limites ---
    ("S16", MOD, "item.conflictWith && !item.conflictWith.newer ? \"replace\" : \"keepBoth\"", "\"replace\"", "jamas se sugiere pisar una sesion mas nueva"),
    ("S17", MOD, "    if (item.status === \"new\" && decision === \"import\") out.push({ item, decision });", "    if (item.status !== \"invalid\" && decision === \"import\") out.push({ item, decision });", "«Importar» solo vale para lo nuevo"),
    ("S18", MOD, "    ok: largest <= SESSION_BYTES_CAP && (free === null || bytes <= free),", "    ok: true,", "los limites bloquean lo que no cabe"),
    ("S19", MOD, "  if (!limits.ok) return { ok: false, reason: \"limit\", limits };\n", "", "lo que no cabe NO se escribe"),
    # --- modulo: aplicar ---
    ("S20", MOD, "    if (local) return { status: \"changed\" };", "", "una sesion que aparecio despues no se pisa con «Importar»"),
    ("S21", MOD, "    if (!local || !seen || local.savedAt !== seen.savedAt) return { status: \"changed\" };", "    if (!local || !seen) return { status: \"changed\" };", "una sesion que cambio despues de la vista previa no se reemplaza"),
    ("S22", MOD, "    if (!local || !seen || local.savedAt !== seen.savedAt) return { status: \"changed\" };", "    if (!local || !seen) return { status: \"changed\" };", "una sesion que cambio despues de la vista previa no se reemplaza (savedAt)"),
    ("S23", MOD, "    if (suffix) name = ", "    if (false) name = ", "la copia «Conservar ambos» lleva el nombre marcado"),
    ("S24", MOD, "    id = newScanSessionId();", "    id = payload.id;", "«Conservar ambos» usa un id nuevo"),
    ("S25", MOD, "  return { status: \"saved\", id: result.forkedAs ?? id };", "  return { status: \"saved\", id };", "si el almacen bifurca, se informa el id real"),
    ("S26", MOD, "      failedReason ??= outcome.reason;", "", "se cuenta el motivo por el que el almacen no pudo guardar"),
    ("S27", MOD, "    if (!isRecord(payload) || !isValidScanSessionId(payload.id) || !Array.isArray(payload.pages)) return null;", "    if (!isRecord(payload) || !Array.isArray(payload.pages)) return null;", "aplicar revalida el id de la sesion"),
    ("S28", MOD, "      if (!inspected.ok || inspected.info.mime !== page.mime) return null;", "", "aplicar revalida que la foto sea una foto"),
    ("S29", MOD, "    if (!(Date.parse(savedAt) + SCAN_SESSION_TTL_MS > now)) return null;", "", "aplicar revalida la caducidad"),
    ("S30", MOD, "      if (!fields || ids.has(fields.id)) return null;", "      if (!fields) return null;", "aplicar revalida ids de pagina repetidos y campos"),
    # --- validadores ---
    ("C01", SCHEMA, "  if (!(raw.rotation === 0 || raw.rotation === 90 || raw.rotation === 180 || raw.rotation === 270)) return null;", "", "rotacion solo 0/90/180/270"),
    ("C02", SCHEMA, "const x = finite(point.x, -0.5, 1.5);", "const x = finite(point.x, -1e9, 1e9);", "esquinas dentro de rango"),
    ("C03", SCHEMA, "|| FORBIDDEN_KEYS.has(key) ||", "||", "claves __proto__ del qualityRatio"),
    ("C04", SCHEMA, "width > MAX_SCAN_SIDE || height > MAX_SCAN_SIDE || width * height > MAX_SCAN_PIXELS", "false", "bomba de pixeles de la cabecera"),
    ("C05", SCHEMA, "  if (!verdict.ok) return { ok: false, problem: verdict.problem === \"notImage\" || verdict.problem === \"empty\" ? \"notImage\" : \"corrupt\" };", "", "estructura completa de la foto (JPEG con EOI, PNG con IEND)"),
    ("C06", SCHEMA, "    if (!isIn(MODES, value.mode)) return null;", "", "ajustes de la sesion: modo del enumerado"),
    ("C07", SCHEMA, "  return clean.length <= MAX_SCAN_OCR_CHARS ? clean : null;", "  return clean;", "texto reconocido acotado"),
    ("C08", SCHEMA, "`^scan-sessions/${sessionRef}-${ref}\\\\.([a-z0-9]{2,5})$`", "`^scan-sessions/s[0-9]+-${ref}\\\\.([a-z0-9]{2,5})$`", "la ruta de la foto pertenece a SU sesion"),
    ("C09", SCHEMA, "  if (raw.pages.length > MAX_SCAN_PAGES_PER_SESSION) return { failure: \"tooMany\" };", "", "tope de paginas por sesion"),
    ("C10", SCHEMA, "createdAt: cappedClock(createdAt, now),", "createdAt,", "fechas del futuro recortadas"),
    ("C11", SCHEMA, "    if (value[key] === true) out[key] = true;", "    out[key] = value[key] as boolean;", "solo las banderas puestas (false = ausente)"),
    # --- orquestacion global ---
    ("G01", GP, '"drafts", "scanSessions", "settings"];', '"drafts", "settings", "scanSessions"];', "orden fijo: ajustes el ultimo"),
    ("G02", GP, "  scanSessions: SCAN_SESSIONS_MODULE,", '  scanSessions: "scanSessions",', "el modulo viaja como scan-sessions"),
    ("G03", GP, "|| (includesScan && !scanInfo.fitsInPackage),", ",", "escaneos que no caben en un paquete"),
    ("G04", GP, "const containsClientData = includesDrafts || includesScan || includesHistory;", "const containsClientData = includesDrafts || includesHistory;", "fotos de documentos piden cifrar"),
    ("G05", GP, "const scan = modules.scanSessions !== undefined ?", "const scan = isChosen(modules, \"scanSessions\") ?", "se ofrece el modulo aunque este desmarcado"),
    ("G06", GP, "          scanSkippedPages = report.skippedPages;\n", "", "las paginas que no viajan se cuentan"),
    ("G07", GP, "        else if (result.written === 0 && result.failed > 0) {", "        else if (false) {", "si el almacen no guarda ninguna, el modulo falla con su motivo"),
    ("G08", GP, '  if (scanSessions && !scanSessions.ok) blocked.push("scanSessions");\n', "", "lo que no cabe bloquea la importacion"),
    ("G09", GP, "copySuffix: options.scanCopySuffix", "copySuffix: undefined", "la copia lleva el texto del idioma"),
    ("G10", GP, "ids: options.scanSessionIds", "ids: undefined", "solo viajan las sesiones elegidas"),
    ("G11", GP, "fitsInPackage: scanSelectionFits(scanChosen),", "fitsInPackage: scanSelectionFits(scanAll),", "«cabe» se mide sobre lo elegido"),
    ("G12", LAST, '["signatures", "library", "drafts", "scanSessions", "settings"] as const;', '["signatures", "library", "drafts", "settings"] as const;', "«ultimo respaldo» anota los escaneos"),
    # --- modelo de pantalla, hojas y tarjetas ---
    ("M01", MODEL, "description.scanSessions.fitsInPackage && !description.scanSessions.large", "description.scanSessions.fitsInPackage", "casilla desmarcada si pesan mucho"),
    ("M02", MODEL, "    if (outcome.status === \"nothing\" && extra.length === 0)", "    if (outcome.status === \"nothing\")", "lo que cambio mientras se revisaba se dice aunque no se importe nada"),
    ("M03", MODEL, "pages: countText(description.scanSessions.selectedPages, copy.pagesOne, copy.pagesMany),", "pages: countText(description.scanSessions.selectedCount, copy.pagesOne, copy.pagesMany),", "el resumen cuenta paginas"),
    ("U01", EXPORT, "if (capabilities && capabilities.scanIds.every((other) => next.includes(other))) setChoice(", "if (false) setChoice(", "sin ninguna sesion elegida la casilla general se desmarca"),
    ("U02", EXPORT, "      scanSessionIds,\n      password: wantsPassword ? password : undefined,", "      password: wantsPassword ? password : undefined,", "exportar lleva SOLO las sesiones elegidas"),
    ("U03", EXPORT, "if (name === \"scanSessions\" && on && capabilities && capabilities.scanIds.every((id) => scanExcluded.includes(id))) setScanExcluded([]);", "", "volver a marcar los escaneos ofrece todos"),
    ("U04", EXPORT, "{scanOn && scan?.large ? (", "{false ? (", "aviso de lo grande"),
    ("U05", IMPORT, "        scanCopySuffix: copy.scanCopySuffix,\n", "", "la copia lleva el texto del idioma"),
    ("U06", IMPORT, "{limits.scanSessions && (limits.scanSessions.wanted > 0 || !limits.scanSessions.ok) ? (", "{false ? (", "linea de limites de los escaneos"),
    ("U07", CARDS, "{item.status !== \"invalid\" && item.discardedPages > 0 ? (", "{false ? (", "paginas danadas se cuentan en la tarjeta"),
]

TEST_ARGS = [
    "npx",
    "vitest",
    "run",
    "src/lib/backup/modules/scanSessions",
    "src/lib/backup/globalPackage",
    "src/lib/backup/goldenPackages",
    "src/lib/backup/lastBackup",
    "src/app/settings",
    "--bail",
    "1",
]

# (`SyntaxError` suelto NO es un marcador: lo imprime tambien un JSON.parse de una prueba que falla de verdad.)
BROKEN_MARKERS = ("Transform failed", "Failed to parse source", "Pre-transform error")


def run_tests() -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive). Si el codigo mutado ni compila, aborta: esa mutacion no vale."""
    result = subprocess.run(TEST_ARGS, cwd=ROOT, capture_output=True, text=True)
    output = result.stdout + result.stderr
    if result.returncode != 0 and any(marker in output for marker in BROKEN_MARKERS):
        raise RuntimeError("la mutacion no compila (no cuenta como muerta)")
    return result.returncode == 0


def main() -> int:
    wanted = set(sys.argv[1:])
    selected = [m for m in MUTATIONS if not wanted or m[0] in wanted]
    if not run_tests():
        print("Las pruebas ya fallan sin mutar: arreglalas antes.")
        return 2
    survivors = []
    for mutation_id, file, old, new, description in selected:
        path = ROOT / file
        original = path.read_text(encoding="utf8")
        if old not in original:
            print(f"{mutation_id}: NO APLICA (texto original no encontrado) - {description}")
            survivors.append(mutation_id)
            continue
        started = time.time()
        try:
            path.write_text(original.replace(old, new), encoding="utf8")
            alive = run_tests()
        except RuntimeError as error:
            print(f"{mutation_id}: ERROR      {error} - {description}", flush=True)
            survivors.append(mutation_id)
            continue
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
