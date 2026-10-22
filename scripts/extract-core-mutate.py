#!/usr/bin/env python3
"""
Mutaciones del clasificador y el orquestador de «Extraer elementos» (F7 · U7.3): aplica de una en una cambios pequenos a los
umbrales y a la logica (solidez de la tinta, etiquetas y cercania, aro y marco de los sellos, logos, fotos, marcas de agua, firmas
vectoriales, deduplicacion, orden, progreso, rango, topes, cancelacion, cifrado, reutilizacion del documento...) y comprueba que las
pruebas de `src/lib/pdf/extractAssets` (clasificador, vectores, orquestador, corpus) fallan. Una mutacion que NO hace fallar ninguna
prueba «sobrevive» e indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/extract-core-mutate.py            # todas
    python3 scripts/extract-core-mutate.py M07 M12    # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
D = "src/lib/pdf/extractAssets/"
TYPES = D + "classifyTypes.ts"
RULES = D + "classifyRules.ts"
PIXELS = D + "classifyPixels.ts"
TEXT = D + "classifyText.ts"
VECJ = D + "classifyVectors.ts"
CLASSIFY = D + "classify.ts"
VECTORS = D + "vectors.ts"
ORCH = D + "orchestrate.ts"
PAGES = D + "orchestratePages.ts"
INDEX = D + "index.ts"
RENDER = D + "vectorsRender.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    ("M01", TYPES, "export const SIGNATURE_MAX_SOLIDITY = 0.6;", "export const SIGNATURE_MAX_SOLIDITY = 0.95;", "solidez maxima de una firma de trazo fino"),
    ("M02", RULES, "features.inkFraction < 0.004", "features.inkFraction < 0.0001", "tinta minima de una firma"),
    ("M03", PIXELS, "const LIGHT_BACKGROUND_LUMA = 190;", "const LIGHT_BACKGROUND_LUMA = 20;", "luminancia minima del fondo claro"),
    ("M04", RULES, "(features.colorBins > LOOSE_MAX_BINS || features.inkFraction > LOOSE_MAX_INK)", "(false)", "tinta gruesa: una insignia de colores no son iniciales"),
    ("M05", RULES, "features.transparent < OPAQUE_BELOW_TRANSPARENT && !hasLabel", "false", "un escaneo opaco sin etiqueta no es firma"),
    ("M06", RULES, "weights.push(0.65 * label.label.strength);", "weights.push(0.1 * label.label.strength);", "peso de la etiqueta cercana"),
    ("M07", RULES, 'kind = aspectInitials && g.aspect < SIGNATURE_ASPECT.min * 1.2 ? "initials" : "signature";', 'kind = "signature";', "con las dos etiquetas manda el tamano"),
    ("M08", RULES, "if (g.widthFrac > SIGNATURE_MAX_WIDTH) return null;", "", "una cenefa ancha no es una firma"),
    ("M09", RULES, "if ((features.ringShare >= 0.55 && features.centerShare <= 0.3) || features.frameShare >= 0.6) return null;", "", "circulo o cuadro vacios no son firma"),
    ("M10", RULES, "if (features.frameShare >= 0.45) return \"frame\";", "if (features.frameShare >= 0.95) return \"frame\";", "sello rectangular: marco"),
    ("M11", RULES, "  if (g.band) {\n    // `band` solo existe", "  if (true) {\n    // `band` solo existe", "logo: solo en la franja de cabecera o pie"),
    ("M12", RULES, "if (g.repeatPages >= 3) weights.push(0.5);", "", "logo: mas certeza con >= 3 paginas"),
    ("M13", TYPES, "export const PHOTO_MIN_BINS = 150;", "export const PHOTO_MIN_BINS = 2;", "foto: colores minimos"),
    ("M14", RULES, "if (g.repeatPages < 2 || g.repeatPages < input.analyzedPages * 0.5) return null;", "if (g.repeatPages < 1) return null;", "marca de agua: repetida en la mitad de las paginas"),
    ("M15", TYPES, "export const HEURISTIC_MAX_CONFIDENCE = 0.89;", "export const HEURISTIC_MAX_CONFIDENCE = 0.99;", "tope de confianza de una heuristica"),
    ("M16", TYPES, "export const NEAR_LABEL_LINES = 2;", "export const NEAR_LABEL_LINES = 9;", "cercania: dos lineas de texto"),
    ("M17", TEXT, "export const LEADING = 1.2;", "export const LEADING = 0.5;", "interlineado de la linea de texto"),
    ("M18", TEXT, "strength = 0.5;", "strength = 1;", "«Insured» solo es una etiqueta debil"),
    ("M19", TEXT, "<= Math.max(piece.height, current.height) * 0.35", "<= Math.max(piece.height, current.height) * 30", "trozos de la misma linea: misma base"),
    ("M20", TYPES, "export const HEADER_FOOTER_BAND = 0.2;", "export const HEADER_FOOTER_BAND = 0.6;", "franja de cabecera y pie del 20 %"),
    ("M21", CLASSIFY, "const SAME_PLACE = 0.04;", "const SAME_PLACE = 5;", "misma posicion de una repeticion"),
    ("M22", CLASSIFY, "export const DUPLICATE_IOU = 0.6;", "export const DUPLICATE_IOU = 0.001;", "duplicado entre motores: IoU"),
    ("M23", CLASSIFY, "if (ka !== kb) return ka - kb;", "if (ka !== kb) return kb - ka;", "orden: firmas primero"),
    ("M24", CLASSIFY, "iou(occurrence.rect, candidate.rect) >= 0.6", "iou(occurrence.rect, candidate.rect) >= 0.0", "imagen translucida repetida: enlace por posicion"),
    ("M25", RULES, "if (features.fullSpanShare > 0.3) return null;", "", "sello: sin barras de borde de pagina"),
    ("M26", VECTORS, "export const GROUP_GAP_PT = 14;", "export const GROUP_GAP_PT = 0.5;", "firma vectorial: agrupar trazos cercanos"),
    ("M27", VECTORS, "const MIN_AXIS_SEGMENT_PT = 3;", "const MIN_AXIS_SEGMENT_PT = 0;", "tinta digital: tramos diminutos no son rectos"),
    ("M28", VECTORS, "export const MAX_STROKE_LUMA = 235;", "export const MAX_STROKE_LUMA = 999;", "trazos blancos no son tinta"),
    ("M29", VECTORS, "if (r.closed && r.segments <= MAX_SHAPE_SEGMENTS", "if (false && r.segments <= MAX_SHAPE_SEGMENTS", "marcadores cerrados de un grafico"),
    ("M30", VECTORS, "if (overlap >= bbox.width * 0.5 && line.x1 - line.x0 >= bbox.width * 0.6) return true;", "if (overlap >= 0 && line.x1 - line.x0 >= 0) return true;", "firma sobre una raya"),
    ("M31", VECJ, "export const VECTOR_MIN_X_REVERSALS = 2;", "export const VECTOR_MIN_X_REVERSALS = 0;", "firma vectorial: bucles"),
    ("M32", VECJ, "export const VECTOR_MAX_TEXT_OVERLAP = 0.2;", "export const VECTOR_MAX_TEXT_OVERLAP = 5;", "firma vectorial: sin texto dentro"),
    ("M33", TYPES, "export const VECTOR_MAX_CONFIDENCE = 0.7;", "export const VECTOR_MAX_CONFIDENCE = 0.99;", "firma vectorial: nunca probable"),
    ("M34", VECJ, "if (!near && !onLine) return null;", "", "firma vectorial: pide etiqueta o raya"),
    ("M35", ORCH, "clamp(Math.floor(options.maxPages ?? EXTRACT_LIMITS.maxPages), 1, EXTRACT_LIMITS.maxPages)", "clamp(Math.floor(options.maxPages ?? EXTRACT_LIMITS.maxPages), 1, 99999)", "tope duro de 300 paginas"),
    ("M36", ORCH, "if (pageIndex < lastReported) return;", "", "el progreso nunca retrocede"),
    ("M37", ORCH, "let to = clamp(Math.floor(options.pageRange?.to ?? pageCount - 1), from, pageCount - 1);", "let to = clamp(Math.floor(options.pageRange?.to ?? pageCount - 1), 0, pageCount - 1);", "rango: el fin no antes del inicio"),
    ("M38", ORCH, "const tailStart = Math.max(0, bytes.length - 64 * 1024);", "const tailStart = Math.max(0, bytes.length - 4);", "cifrado: se mira el final del archivo"),
    ("M39", ORCH, "      throw toPdfError(error);\n    }\n    if (signal?.aborted) throw cancelled();\n\n    const createSurface", "      throw toPdfError(error);\n    }\n\n    const createSurface", "cancelar tras el motor de imagenes"),
    ("M40", ORCH, "    return id === asset.id ? asset : { ...asset, id };", "    return asset;", "ids unicos entre motores"),
    ("M41", ORCH, "      assets = assets.slice(0, maxAssets);", "", "tope de 500 elementos tras fusionar"),
    ("M42", ORCH, "export const DOCUMENT_IDLE_MS = 15_000;", "export const DOCUMENT_IDLE_MS = 0;", "el documento de las descargas se mantiene un rato"),
    ("M43", ORCH, "(lease.source !== file || lease.env !== env || lease.closing)", "(lease.closing)", "otro archivo cierra el documento anterior"),
    ("M44", ORCH, "failedPages.size >= analyzed && facts.failures >= analyzed", "false", "todas las paginas ilegibles = archivo danado"),
    ("M45", ORCH, "includeAnnotations: false", "includeAnnotations: true", "las anotaciones son del otro motor"),
    ("M46", ORCH, "assetsAlreadyFound: images.assets.length", "assetsAlreadyFound: 0", "el tope de elementos es global"),
    ("M47", ORCH, "containment(rect, occurrence.rect) >= 0.7", "containment(rect, occurrence.rect) >= 9", "firma vectorial dentro de un sello no se ofrece"),
    ("M48", ORCH, "const truncated = warnings.some((warning) => warning.code === \"too-many-pages\" || warning.code === \"too-many-assets\");", "const truncated = false;", "truncated por topes"),
    ("M49", ORCH, "if (!asset.formats.includes(wanted)) throw new ExtractRenderError(\"unsupported-format\"", "if (false) throw new ExtractRenderError(\"unsupported-format\"", "formato no ofrecido"),
    ("M50", INDEX, "return { ...defaultEngine, ...(installed ?? {}), ...(testHook() ?? {}) };", "return { ...unavailableEngine, ...(installed ?? {}), ...(testHook() ?? {}) };", "el motor real es el de por defecto"),
    ("M51", PAGES, "if (scan.candidates.length > 0) vectors = toPageVectors(pageIndex, scan);", "", "los trazos vectoriales llegan al clasificador"),
    ("M52", RENDER, "if (!best || bestScore < 0.5) throw", "if (!best) throw", "regenerar la firma vectorial: coincidencia de caja"),
    ("M53", RULES, "if (features.darkShare + features.blueShare < 0.7) return false;", "", "la tinta de una firma es oscura o azul"),
    ("M54", PIXELS, "const BACKGROUND_MIN_SHARE = 0.5;", "const BACKGROUND_MIN_SHARE = 0.0;", "el fondo ocupa la mayor parte de la imagen"),
    ("M55", CLASSIFY, "const scannedPage = asset.occurrences.some((occurrence) => ctx.scanned.has(occurrence.pageIndex));", "const scannedPage = false;", "pagina escaneada: motivo y no es foto"),
]

TESTS = [
    "src/lib/pdf/extractAssets/classify",
    "src/lib/pdf/extractAssets/vectors",
    "src/lib/pdf/extractAssets/orchestrate",
    "src/lib/pdf/extractAssets/index.test.ts",
]


def run_tests() -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive)."""
    result = subprocess.run(["npx", "vitest", "run", "--project", "engines", *TESTS], cwd=ROOT, capture_output=True, text=True)
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
