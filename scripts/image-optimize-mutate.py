#!/usr/bin/env python3
"""
Mutaciones de la optimizacion de imagenes para PDF (`src/lib/image/prepareForPdf.ts`, `jpegCalibration.ts` y su uso en
`src/lib/pdf/imagesToPdf.ts`): aplica de una en una cambios pequenos a la politica (regla del 15 %, nunca ampliar, topes de
lienzo de iOS, EXIF, alfa, grafico frente a foto, estimacion, calibracion, tope por celda) y comprueba que las pruebas
correspondientes fallan. Una mutacion que NO hace fallar ninguna prueba «sobrevive» e indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/image-optimize-mutate.py            # todas
    python3 scripts/image-optimize-mutate.py P03 P07    # solo esas
    python3 scripts/image-optimize-mutate.py --check    # solo comprueba que el texto original existe

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PREP = "src/lib/image/prepareForPdf.ts"
CAL = "src/lib/image/jpegCalibration.ts"
ENGINE = "src/lib/pdf/imagesToPdf.ts"
EST = "src/lib/image/estimatePdfSize.ts"

FAST = ["src/lib/image/prepareForPdf.test.ts", "src/lib/image/jpegCalibration.test.ts"]
QUALITY = ["src/lib/image/prepareForPdf.quality.test.ts"]
ENGINE_TESTS = ["src/lib/pdf/imagesToPdf.quality.test.ts"]

# (id, archivo, texto original, texto mutado, descripcion, pruebas). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    ("P01", PREP, "const smaller = transcoded.bytes.byteLength <= originalBytes * (1 - MIN_SAVING);", "const smaller = transcoded.bytes.byteLength < originalBytes * (1 - MIN_SAVING);", "regla del 15 %: el limite exacto ya no vale", FAST),
    ("P02", PREP, "export const MIN_SAVING = 0.15;", "export const MIN_SAVING = 0;", "regla del 15 %: se sustituye aunque pese casi lo mismo", FAST),
    ("P03", PREP, "  let scale = 1;\n  if (maxSide !== null) scale = Math.min(scale, maxSide / Math.max(w, h));\n  scale = Math.min(scale, Math.sqrt(maxPixels / (w * h)));\n  if (!(scale < 1)) return { width: w, height: h, scale: 1 };\n  const limit = maxSide ?? Number.POSITIVE_INFINITY;", "  let scale = maxSide !== null ? maxSide / Math.max(w, h) : 1;\n  scale = Math.min(scale, Math.sqrt(maxPixels / (w * h)));\n  const limit = maxSide ?? Number.POSITIVE_INFINITY;", "nunca ampliar: el reductor amplia las imagenes pequenas hasta el tope", FAST),
    ("P04", PREP, "scale = Math.min(scale, Math.sqrt(maxPixels / (w * h)));", "", "iOS: sin tope de area del lienzo", FAST),
    ("P05", PREP, "const nextW = Math.max(targetWidth, Math.round(w / 2));", "const nextW = Math.max(targetWidth, Math.round(w / 3));", "reduccion por pasos: un paso baja a mas de la mitad", FAST),
    ("P06", PREP, "  if (first.scale < 1) {\n    w = Math.max(first.width, targetWidth);", "  if (false) {\n    w = Math.max(first.width, targetWidth);", "iOS: el primer lienzo no respeta los topes", FAST),
    ("P07", PREP, "if (cap(hint) && bytesPerPixel <= preset.keepBytesPerPixel) return { action: \"keep\", reason: \"already-small\" };", "if (bytesPerPixel <= preset.keepBytesPerPixel) return { action: \"keep\", reason: \"already-small\" };", "politica: un JPEG ligero pero demasiado grande pasa sin reducir", FAST),
    ("P08", PREP, "if (cap(hint) && byteLength <= SMALL_PNG_BYTES) return { action: \"keep\", reason: \"small-png\" };", "if (byteLength <= SMALL_PNG_BYTES) return { action: \"keep\", reason: \"small-png\" };", "politica: un PNG pequeno pero demasiado grande pasa sin reducir", FAST),
    ("P09", PREP, "export const SMALL_PNG_BYTES = 256 * 1024;", "export const SMALL_PNG_BYTES = 0;", "politica: ningun PNG es «pequeno»", FAST),
    ("P10", PREP, "if (nonOpaque > alphaLimit) {", "if (nonOpaque >= 0) {", "alfa: toda transparencia cuenta como real", FAST),
    ("P11", PREP, "if (scanned.realAlpha || scanned.graphic) format = \"png\";", "if (scanned.graphic) format = \"png\";", "alfa: un PNG con transparencia real pasa a JPEG", FAST),
    ("P12", PREP, "else flatten = scanned.anyAlpha;", "else flatten = false;", "alfa trivial: no se aplana sobre blanco (sale negro)", FAST),
    ("P13", PREP, "if ((kind === \"heic\" || kind === \"avif\") && heifQuarterTurns(bytes) % 2 === 1) swap = true;", "", "cabecera: el giro `irot` de HEIC/AVIF no cambia ancho por alto", FAST),
    ("P14", PREP, "let swap = orientation >= 5;", "let swap = orientation >= 6;", "EXIF: las orientaciones 5 (transpuesta) no giran el tamano visto", FAST),
    ("P15", PREP, "if (colorType === 4 || colorType === 6) return true;", "if (colorType === 6) return true;", "PNG: gris con alfa (tipo 4) no cuenta como alfa", FAST),
    ("P16", PREP, "const side = Math.min(preset.maxSide, Math.max(MIN_FIT_SIDE, Math.round(fitMaxSide)));", "const side = Math.min(preset.maxSide, Math.round(fitMaxSide));", "tope por celda: sin lado minimo", FAST),
    ("P17", PREP, "    options.bakeOrientation &&\n", "", "EXIF: `bakeOrientation` se ignora", FAST),
    ("P18", PREP, "encoded = Math.min(Math.max(preset.sizeRatio * byteLength * ratio ** 0.75, outPixels * 0.08), outPixels * 0.45);", "encoded = preset.sizeRatio * byteLength;", "estimacion: no baja al reducir los pixeles", FAST + QUALITY),
    ("P19", PREP, "const optimized = plan.mustConvert ? Math.min(encoded, unoptimized) : Math.min(encoded, byteLength);", "const optimized = encoded;", "estimacion: puede superar el peso del original", FAST),
    ("P20", PREP, "if (header.kind === \"jpeg\") {\n    if (isOriginal) return { action: \"keep\", reason: \"original-preset\" };", "if (header.kind === \"jpeg\") {\n    if (false) return { action: \"keep\", reason: \"original-preset\" };", "«Original»: un JPEG ya no se conserva", FAST),
    ("P21", PREP, "quality: 0.87, targetBytesPerPixel", "quality: 0.5, targetBytesPerPixel", "calidad de «Equilibrada» cambiada", FAST + QUALITY),
    ("P22", PREP, "maxSide: 3000, quality", "maxSide: 6000, quality", "tope de lado de «Equilibrada» cambiado", FAST + QUALITY),
    ("C01", CAL, "if (!Number.isFinite(reference)) return quality;", "", "calibracion: sin referencia finita se sigue midiendo", FAST),
    ("C02", CAL, "if ((await measure(quality)) <= limit) return quality;", "if ((await measure(quality)) < 0) return quality;", "calibracion: un codificador igual que Chromium se corrige igualmente", FAST),
    ("C03", CAL, "export const MIN_CALIBRATED_QUALITY = 0.5;", "export const MIN_CALIBRATED_QUALITY = 0.1;", "calibracion: sin calidad minima", FAST),
    ("E01", ENGINE, "const fit = ppi > 0 ? pixelsNeededForRect(provisional.photos[position].rect, ppi) : undefined;", "const fit = undefined;", "varias por hoja: no se acotan los pixeles por celda", ENGINE_TESTS),
    ("E02", ENGINE, "    orientation: layout.orientation,\n    margin: MARGINS[layout.margin],", "    orientation: \"auto\" as const,\n    margin: MARGINS[layout.margin],", "varias por hoja: se ignora la orientacion pedida", ENGINE_TESTS),
]


def run_tests(tests) -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive)."""
    result = subprocess.run(["npx", "vitest", "run", "--project", "engines", *tests], cwd=ROOT, capture_output=True, text=True)
    return result.returncode == 0


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check" in sys.argv
    wanted = set(args)
    selected = [m for m in MUTATIONS if not wanted or m[0] in wanted]
    missing = []
    for mutation_id, file, old, new, description, _tests in selected:
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
    if not run_tests(FAST + QUALITY + ENGINE_TESTS):
        print("Las pruebas ya fallan sin mutar: arreglalas antes.")
        return 2
    survivors = list(missing)
    for mutation_id, file, old, new, description, tests in selected:
        if mutation_id in missing:
            continue
        path = ROOT / file
        original = path.read_text(encoding="utf8")
        started = time.time()
        try:
            path.write_text(original.replace(old, new), encoding="utf8")
            alive = run_tests(tests)
        finally:
            path.write_text(original, encoding="utf8")
        status = "SOBREVIVE" if alive else "muere"
        print(f"{mutation_id}: {status:10s} ({time.time() - started:5.1f}s) {description}", flush=True)
        if alive:
            survivors.append(mutation_id)
    killed = len(selected) - len(survivors)
    print(f"\n{killed} de {len(selected)} mutaciones mueren; sobreviven: {', '.join(survivors) or 'ninguna'}")
    return 0 if not survivors else 1


if __name__ == "__main__":
    sys.exit(main())
