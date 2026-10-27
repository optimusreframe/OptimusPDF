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
    ("S09", QUAL, "blurry: sharpness !== null && !isBlankPage(ink) && sharpness < BLUR_ACUTANCE_THRESHOLD,", "blurry: sharpness !== null && sharpness < BLUR_ACUTANCE_THRESHOLD,", "una hoja en blanco se marca borrosa"),
    ("S10", QUAL, "dark: paperLevel < DARK_PAPER_THRESHOLD,", "dark: paperLevel > DARK_PAPER_THRESHOLD,", "oscuridad: comparacion invertida"),
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
]

FAST = ["npx", "vitest", "run", "--project", "engines", "--exclude", "src/lib/scan/scan.metrics.test.ts", "src/lib/scan", "src/app/recent", "src/lib/resumeLinks"]
FULL = ["npx", "vitest", "run", "--project", "engines", "src/lib/scan", "src/app/recent", "src/lib/resumeLinks"]
TESTS = FAST if "--fast" in sys.argv else FULL


def run_tests() -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive)."""
    result = subprocess.run(TESTS, cwd=ROOT, capture_output=True, text=True)
    return result.returncode == 0


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
