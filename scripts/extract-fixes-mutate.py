#!/usr/bin/env python3
"""
Mutaciones de las CORRECCIONES del Extractor tras la verificacion independiente (clasificador H1-H3/H5-H7, pantalla H4/H8-H10/H13/H15/H16,
memoria H11/H12): aplica de una en una cambios pequenos y comprueba que las pruebas relacionadas fallan. Una mutacion que NO hace fallar
ninguna prueba «sobrevive» e indica una prueba que falta (o un cambio equivalente, que se anota).

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/extract-fixes-mutate.py            # todas
    python3 scripts/extract-fixes-mutate.py F03 F12    # solo esas

Cada mutacion corre solo las pruebas que la cubren (columna `tests`), no toda la suite. Los archivos se restauran siempre al terminar
(tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
D = "src/lib/pdf/extractAssets/"
A = "src/app/extract-assets/"
RULES = D + "classifyRules.ts"
PIXELS = D + "classifyPixels.ts"
TEXT = D + "classifyText.ts"
CLASSIFY = D + "classify.ts"
MODEL = A + "model.ts"
CLEAN = A + "cleanDownload.ts"
CLIENT = A + "ExtractToolClient.tsx"
GALLERY = A + "ExtractGallery.tsx"
REGMODEL = A + "regionModel.ts"
SELECTOR = A + "RegionSelector.tsx"
PREP = D + "imagesPrep.ts"
FLATE = D + "imagesFlate.ts"
IMAGES = D + "images.ts"
ORCH = D + "orchestrate.ts"
PNGS = D + "imagesPngStream.ts"
OPLIST = D + "opListCache.ts"
ANNOT = D + "annotations.ts"

RULE_TESTS = [D + "classifyRules.fixes.test.ts", D + "classifyRules.test.ts", D + "verif.corpus.test.ts"]
PIXEL_TESTS = [D + "classifyPixels.fixes.test.ts", D + "classifyPixels.test.ts", D + "verif.corpus.test.ts"]
MODEL_TESTS = [A + "model.fixes.test.ts", A + "model.test.ts"]
CLIENT_TESTS = [A + "ExtractToolClient.test.tsx", A + "ExtractToolClient.fixes.test.tsx"]
REGION_TESTS = [A + "regionModel.test.ts", A + "RegionSelector.test.tsx", A + "RegionNudge.test.tsx"]
BIG_TESTS = [D + "images.big.test.ts", D + "imagesFlate.test.ts"]

# (id, archivo, texto original, texto mutado, descripcion, pruebas). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    ("F01", RULES, "export const MAX_INK_ASPECT = 9;", "export const MAX_INK_ASPECT = 90;", "H6: una raya o cenefa (tinta mas de 9 veces mas ancha que alta) no es firma", RULE_TESTS),
    ("F02", RULES, "export const MIN_BAR_RUNS = 6;", "export const MIN_BAR_RUNS = 2;", "H1: un codigo de barras tiene 6 o mas barras (una «M» o «R», 3)", RULE_TESTS),
    ("F03", RULES, "export const MAX_STROKE_SPAN = 0.3;", "export const MAX_STROKE_SPAN = 0.9;", "H1: una banda ancha de tinta (30 % de las columnas) es una barra", RULE_TESTS),
    ("F04", RULES, "export const FRAME_MIN_SIDES = 0.85;", "export const FRAME_MIN_SIDES = 0;", "H2: un marco de verdad tiene los cuatro lados (unas iniciales al ras, no)", RULE_TESTS),
    ("F05", RULES, "features.chromaticShare >= 0.6 && features.dominantHueShare >= 0.85", "features.chromaticShare >= 0.6 && features.dominantHueShare >= 0.99", "H1: tinta de UN tono (azul de boligrafo con ruido de JPEG)", RULE_TESTS),
    ("F06", RULES, "export const STAMP_ASPECT = { min: 0.45, max: 4 } as const;", "export const STAMP_ASPECT = { min: 0.45, max: 2.6 } as const;", "H5: un sello rectangular 3:1 es un sello", RULE_TESTS),
    ("F07", RULES, "export const NO_LABEL_THICK_MAX_CONFIDENCE = 0.65;", "export const NO_LABEL_THICK_MAX_CONFIDENCE = 0.89;", "H1: iniciales gruesas sin etiqueta solo «posibles»", RULE_TESTS),
    ("F08", RULES, 'const footerInitials = !hasLabel && g.band === "bottom" && repeated && aspectInitials;', 'const footerInitials = !hasLabel && g.band !== null && repeated && aspectInitials;', "H1: iniciales sin etiqueta solo en el PIE (no en la cabecera)", RULE_TESTS),
    ("F09", RULES, '  if (kind === "signature" && !sigLabel && g.band === "top") return null;\n', "", "H6: un manuscrito repetido en la cabecera sin etiqueta es un logo", RULE_TESTS),
    ("F10", RULES, "if (!sigLabel || !thin || g.aspect < INITIALS_ASPECT.min", "if (!sigLabel || g.aspect < INITIALS_ASPECT.min", "H6: un icono relleno y cuadrado junto a «Firma» no es firma", RULE_TESTS),
    ("F11", RULES, "const height = Math.min(g.heightFrac, g.longHeightFrac ?? g.heightFrac);", "const height = g.heightFrac;", "H3: la altura se mide contra el lado largo de la pagina", RULE_TESTS),
    ("F12", RULES, "(large ? SIGNATURE_HEIGHT.maxLabelled : SIGNATURE_HEIGHT.max)", "SIGNATURE_HEIGHT.max", "H3: una firma grande recortada con etiqueta se acepta", RULE_TESTS),
    ("F13", RULES, "const large = hasLabel && features.transparent >= OPAQUE_BELOW_TRANSPARENT;", "const large = hasLabel;", "H3: un JPEG opaco grande junto a un texto no es una firma grande", RULE_TESTS),
    ("F14", RULES, "if (!features.lightBackground && !(loose && features.localPaper)) return false;", "if (!features.lightBackground) return false;", "H7: foto con sombra con etiqueta cerca", RULE_TESTS),
    ("F15", PIXELS, "const LOCAL_PAPER_MAX_SATURATION = 0.3;", "const LOCAL_PAPER_MAX_SATURATION = 1;", "H7: un cuadro de color liso no es papel", PIXEL_TESTS),
    ("F16", PIXELS, "    frameSides = Math.min(\n", "    frameSides = Math.max(\n", "H2: frameSides es el MINIMO de los cuatro bordes", PIXEL_TESTS),
    ("F17", PIXELS, "      if (full && !inColumnRun) columnRuns += 1;\n", "      if (full) columnRuns += 1;\n", "H1: se cuentan barras (rachas), no columnas", PIXEL_TESTS),
    ("F18", TEXT, "...(kind === \"initials\" && RUBRICA.test(folded) ? { alsoSignature: true } : {})", "", "H7: «Rubrica» es etiqueta de firma tambien", [D + "classifyText.fixes.test.ts", D + "verif.corpus.test.ts", D + "classifyRules.fixes.test.ts"]),
    ("F19", TEXT, 'label.kind !== kind && !(kind === "signature" && label.alsoSignature)', "label.kind !== kind", "H7: nearestLabel admite «Rubrica» como firma", [D + "classifyText.fixes.test.ts", D + "verif.corpus.test.ts"]),
    ("F20", TEXT, "const FIRMADO_POR = /\\bfirmad[oa] por\\b/;", "const FIRMADO_POR = /\\bnuncajamas\\b/;", "H7: «Firmado por:» es etiqueta de firma", [D + "classifyText.fixes.test.ts", D + "verif.corpus.test.ts"]),
    ("F21", CLASSIFY, "longHeightFrac: height / Math.max(size.width, size.height, 1),", "longHeightFrac: height / size.height,", "H3: el lado largo de la pagina apaisada", [D + "verif.corpus.test.ts", D + "classify.test.ts", D + "classify.geometry.test.ts"]),
    ("F22", MODEL, "    if (list.length < 2) continue;\n", "    if (list.length < 1) continue;\n", "H9: lo que tiene nombre unico no lleva ordinal", MODEL_TESTS + CLIENT_TESTS),
    ("F23", MODEL, "return [ordinal ? fill(strings.ordinalOf, { label: type, n: ordinal.n, total: ordinal.total }) : type,", "return [type,", "H9: el nombre accesible lleva el ordinal", MODEL_TESTS + CLIENT_TESTS),
    ("F24", MODEL, 'new Set<AssetSource>(["xobject", "inline", "mask"])', 'new Set<AssetSource>(["xobject", "inline", "mask", "ink-annot"])', "H8: solo se limpian las imagenes incrustadas", MODEL_TESTS),
    ("F25", MODEL, 'if (preference === "png") return { format: "png", clean: true };', 'if (preference === "png") return { format: "png", clean: false };', "H8: «PNG» entrega la firma limpia", MODEL_TESTS + CLIENT_TESTS),
    ("F26", MODEL, "const untouched = needsClean(asset) && !choice.clean && choice.format === \"png\";", "const untouched = false;", "H8: el PNG sin limpiar lleva `-original`", MODEL_TESTS + CLIENT_TESTS),
    ("F27", MODEL, "(hasNothingToExtract(asset) ? empty : usable).push(asset);", "usable.push(asset);", "H4: un campo de firma vacio no es una tarjeta", MODEL_TESTS + CLIENT_TESTS),
    ("F28", MODEL, "  for (const warning of byCode(\"too-many-annotations\")) {", "  for (const warning of [] as typeof result.warnings) {", "H10: aviso de anotaciones recortadas", MODEL_TESTS + CLIENT_TESTS),
    ("F29", ANNOT, "if (all.length > MAX_ANNOTATIONS_PER_PAGE) {", "if (all.length > MAX_ANNOTATIONS_PER_PAGE * 100) {", "H10: el motor avisa al recortar", [D + "annotations.truncated.test.ts"]),
    ("F30", CLEAN, "{ ink: \"original\", evenLighting: !hasAlpha, crop: \"auto\", margin: \"auto\" }", "{ ink: \"original\", evenLighting: false, crop: \"auto\", margin: \"auto\" }", "H8: iluminacion pareja para las imagenes sin alfa", CLIENT_TESTS),
    ("F31", CLEAN, "crop: \"auto\", margin: \"auto\"", "crop: \"none\", margin: \"auto\"", "H8: recorte ajustado a la tinta", CLIENT_TESTS),
    ("F32", CLIENT, "const choice = resolveChoice(asset, formatPreference);\n        try {", "const choice = { format: \"png\" as const, clean: false };\n        try {", "H8: el ZIP tambien limpia", CLIENT_TESTS),
    ("F33", REGMODEL, "const edge = Math.max(nextX, rect.x + CROP_MIN_FRACTION);", "const edge = nextX;", "H13: un borde no baja del lado minimo", REGION_TESTS),
    ("F34", REGMODEL, "const left = Math.min(nextX, right - CROP_MIN_FRACTION);", "const left = nextX;", "H13: el borde izquierdo no cruza el derecho", REGION_TESTS),
    ("F35", REGMODEL, "export const NUDGE_STEP = 0.02;", "export const NUDGE_STEP = 0.05;", "H13: paso de 2 % de los botones de ajuste", REGION_TESTS),
    ("F36", SELECTOR, "const TAP_SLOP_PX = 6;", "const TAP_SLOP_PX = 0;", "H13: un toque con pocos pixeles de temblor sigue siendo un toque", REGION_TESTS),
    ("F37", SELECTOR, "const next = picked ? moveHandle(current, picked, x, y) : shiftCrop(", "const next = false ? moveHandle(current, picked!, x, y) : shiftCrop(", "H13: con un asa elegida el toque en la pagina la coloca", REGION_TESTS),
    ("F38", SELECTOR, "export const EDGE_HANDLE_MIN_PX = 96;", "export const EDGE_HANDLE_MIN_PX = 0;", "H13: los bordes cortos no llevan asa (no se tapan las zonas de toque)", REGION_TESTS + [A + "RegionPanel.test.tsx"]),
    ("F39", GALLERY, "lg:grid-cols-4", "lg:grid-cols-3", "H15: 4 columnas en el iPad apaisado", CLIENT_TESTS),
    ("F40", CLIENT, 'phase === "done" && "hidden md:block"', '"md:block"', "H16: la descripcion se oculta en el movil con el resultado a la vista", CLIENT_TESTS),
    ("F41", PREP, "export const BIG_ANALYSIS_PX = 12_000_000;", "export const BIG_ANALYSIS_PX = 120_000_000;", "H11: umbral de 12 MP", BIG_TESTS),
    ("F42", PREP, "if (!dct && !flate && pixels <= maxPixels) continue;", "if (!dct && pixels <= maxPixels) continue;", "H11: los Flate grandes tambien se sustituyen", BIG_TESTS),
    ("F43", PREP, "const masked = dict.has(PDFName.of(\"SMask\")) || dict.has(PDFName.of(\"Mask\"));", "const masked = false;", "H11: con mascara no se reduce a mano", BIG_TESTS),
    ("F44", FLATE, "const divisor = colCount[ox] * rowsInCell;", "const divisor = colCount[ox];", "H11: promedio de cada celda", BIG_TESTS),
    ("F45", FLATE, "if ((await inflatedLength(spec.bytes, stride * height, slicer)) !== stride * height) return null;", "", "H11: un flujo con predictor PNG danado no se envuelve", BIG_TESTS),
    ("F46", FLATE, "(pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;", "(pa <= pb && pa <= pc ? a : pb <= pc ? c : b)) & 0xff;", "H11: filtro Paeth (la rama del borde superior)", BIG_TESTS),
    ("F47", IMAGES, "            analysis.width = big.width;\n            analysis.height = big.height;\n", "", "H11: medidas reales de la foto grande", BIG_TESTS),
    ("F48", OPLIST, "if (this.used + size <= this.budget) {", "if (true) {", "H11: presupuesto de operadores", [D + "opListCache.test.ts"]),
    ("F49", ORCH, "        big: prep.big,\n        getOperatorList,", "        big: prep.big,", "H11: la lista de operadores se comparte entre pasadas", [D + "opListCache.test.ts"]),
    ("F50", ORCH, "if (flate && asset.pixel) {", "if (false) {", "H11: el PNG de un Flate grande no pasa por pdf.js", BIG_TESTS),
    ("F51", PNGS, "filtered[o++] = 1; // «Sub»", "filtered[o++] = 0; // «Sub»", "H11: PNG por bandas con filtro Sub", [D + "imagesPngStream.test.ts"]),
    ("F52", PREP, "if (key !== options.keep) refs.push(ref);", "refs.push(ref);", "H11: `keep` deja real solo esa imagen", BIG_TESTS),
]


def run_tests(tests) -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive)."""
    result = subprocess.run(["npx", "vitest", "run", *tests], cwd=ROOT, capture_output=True, text=True)
    return result.returncode == 0


def main() -> int:
    wanted = set(sys.argv[1:])
    selected = [m for m in MUTATIONS if not wanted or m[0] in wanted]
    survivors = []
    for mutation_id, file, old, new, description, tests in selected:
        path = ROOT / file
        original = path.read_text(encoding="utf8")
        if old not in original:
            print(f"{mutation_id}: NO APLICA (texto original no encontrado) - {description}")
            survivors.append(mutation_id)
            continue
        if not run_tests(tests):
            print(f"{mutation_id}: las pruebas ya fallan sin mutar - {description}")
            survivors.append(mutation_id)
            continue
        started = time.time()
        try:
            path.write_text(original.replace(old, new), encoding="utf8")
            alive = run_tests(tests)
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
