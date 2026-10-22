#!/usr/bin/env python3
"""
Mutaciones del motor de anotaciones (U7.2): aplica de una en una cambios pequenos a la logica (umbrales, reglas de decision,
geometria de la vista, lectura de /V, regla del 50 %, tolerancias de los renders, topes) y comprueba que las pruebas de
`src/lib/pdf/extractAssets/annotations*.test.ts` y `watermark*.test.ts` fallan. Una mutacion que NO hace fallar ninguna prueba
«sobrevive» y indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 src/lib/pdf/extractAssets/__fixtures__/annots/mutate.py            # todas
    python3 src/lib/pdf/extractAssets/__fixtures__/annots/mutate.py M07 M12    # solo esas
    python3 src/lib/pdf/extractAssets/__fixtures__/annots/mutate.py --check    # solo comprueba que cada mutacion se puede aplicar

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[6]
D = "src/lib/pdf/extractAssets/"
INK = D + "annotationsInk.ts"
RASTER = D + "annotationsRaster.ts"
OPS = D + "watermarkOps.ts"
TEXT = D + "watermarkText.ts"
STAMPF = D + "annotationsFormStamp.ts"
PDFLIB = D + "annotationsPdfLib.ts"
SIG = D + "annotationsSig.ts"
STAMP = D + "annotationsStamp.ts"
MAIN = D + "annotations.ts"
RENDER = D + "annotationsRender.ts"
OCG = D + "watermarkOcg.ts"
TYPES = D + "annotationsTypes.ts"
PAGE = D + "annotationsPage.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    ("M01", INK, "    aspect >= 1.2 &&", "    aspect >= 0.1 &&", "Ink: una firma debe ser apaisada"),
    ("M02", INK, "shape.strokes.length <= 12 &&", "shape.strokes.length <= 1200 &&", "Ink: pocos trazos para ser firma"),
    ("M03", INK, "bounds.width <= viewWidth * 0.7 &&", "bounds.width <= viewWidth * 7 &&", "Ink: una firma no ocupa media pagina"),
    ("M04", INK, "const half = width / 2;", "const half = 0;", "Ink: medio grosor de margen en la caja"),
    ("M05", INK, "Math.min(rawWidth, 80)", "rawWidth", "Ink: grosor absurdo acotado"),
    ("M06", INK, "Math.max(0.05, rawOpacity)", "Math.max(0, rawOpacity)", "Ink: opacidad minima"),
    ("M07", INK, '.map((v) => v.toString(16).padStart(2, "0"))', '.map((v) => v.toString(16))', "Ink: el color del SVG lleva 2 cifras por canal"),
    ("M08", INK, "export const MAX_INK_POINTS = 60_000;", "export const MAX_INK_POINTS = 6_000_000;", "Ink: tope de puntos"),
    ("M09", INK, "points.push(toView(x, y));\n            budget -= 1;\n          }\n        }\n      }", "points.push([x, y]);\n            budget -= 1;\n          }\n        }\n      }", "Ink: los puntos pasan a la vista (pagina girada)"),
    ("M10", RASTER, "tolerance = 3)", "tolerance = 300)", "raster: tolerancia de la diferencia de renders"),
    ("M11", RASTER, "if (delta <= tolerance) continue;", "if (delta < 0) continue;", "raster: lo que no cambia no es de la anotacion"),
    ("M12", RASTER, "return Math.max(0.05, Math.min(wanted, byPixels, bySide));", "return Math.max(0.05, wanted);", "raster: tope de memoria del render"),
    ("M13", RASTER, "return pngBlob(fitInto(image, EXTRACT_LIMITS.thumbPx));", "return pngBlob(fitInto(image, 4096));", "raster: miniaturas de 256 px"),
    ("M14", RASTER, "Math.pow(ratio, 0.85)", "Math.pow(ratio, 0)", "raster: el tamano estimado crece con el area"),
    ("M15", RASTER, "offsetX: -region.x * scale", "offsetX: region.x * scale", "raster: desplazamiento de la region en la vista"),
    ("M16", RASTER, 'params.background ?? "rgba(0,0,0,0)"', 'params.background ?? "#ffffff"', "raster: el fondo es transparente"),
    ("M17", RASTER, "Math.min(1, Math.max(0, (rect.x + rect.width) / viewWidth))", "(rect.x + rect.width) / viewWidth", "raster: la caja normalizada se recorta a la pagina"),
    ("M18", OPS, 'if (key === "ca" && typeof value === "number")', 'if (key === "CA" && typeof value === "number")', "texto: la opacidad es la de relleno (ca)"),
    ("M19", OPS, "const visible = state.renderMode !== 3 && state.renderMode < 4;", "const visible = true;", "texto: el invisible (OCR) no cuenta"),
    ("M20", OPS, "if (gap <= size * 0.6) {", "if (gap <= size * 60) {", "texto: Tj contiguos de una linea se juntan, los lejanos no"),
    ("M21", OPS, "const previous = stack.pop();\n        if (previous) state = previous;", "stack.pop();", "texto: restore recupera la opacidad"),
    ("M22", OPS, "if (frame && frames.length === 0 && result.forms.length < MAX_FORMS", "if (frame && result.forms.length < MAX_FORMS", "forms: un Form anidado es parte del externo"),
    ("M23", OPS, "const m = Array.isArray(args) && args.length === 1 ? toMatrix(args[0]) : toMatrix(args);", "const m = toMatrix(args);", "texto: pdf.js envuelve la matriz de texto"),
    ("M24", OPS, "(Array.isArray(rawData) && rawData.length === 1 && isMatrixLike(rawData[0]) ? rawData[0] : rawData)", "rawData", "forms: pdf.js envuelve el trazado"),
    ("M25", OPS, "if (glyph < -200 && text.length > 0", "if (glyph < -2000000 && text.length > 0", "texto: un ajuste grande de TJ es un espacio"),
    ("M26", OPS, 'previous.ocIds.join(",") === currentOc().join(",")', "true", "texto: no se juntan textos de capas distintas"),
    ("M27", TEXT, "export const MIN_PAGE_FRACTION = 0.5;", "export const MIN_PAGE_FRACTION = 0.1;", "marca de texto: fraccion minima de paginas"),
    ("M28", TEXT, "export const MAX_WATERMARK_ALPHA = 0.85;", "export const MAX_WATERMARK_ALPHA = 1.1;", "marca de texto: debe ser translucido"),
    ("M29", TEXT, "export const BIG_TEXT_PT = 36;", "export const BIG_TEXT_PT = 3;", "marca de texto: cuerpo grande"),
    ("M30", TEXT, "return a >= 12 && a <= 78;", "return a >= 0 && a <= 90;", "marca de texto: diagonal"),
    ("M31", TEXT, "const repeated = count >= 2 && fraction >= MIN_PAGE_FRACTION;", "const repeated = count >= 1 && fraction >= MIN_PAGE_FRACTION;", "marca de texto: una sola pagina no cuenta"),
    ("M32", TEXT, "const single = pagesConsidered === 1 && count === 1 && keyword;", "const single = pagesConsidered === 1 && count === 1;", "marca de texto: una sola pagina exige palabra clave"),
    ("M33", TEXT, "if (run.ocIds.some((id) => excludeOcIds.has(id))) continue;", "", "marca de texto: lo que ya entrega la capa no se repite"),
    ("M34", TEXT, "rotate(${round1(-angle)} ", "rotate(${round1(angle)} ", "marca de texto: sentido del giro en el SVG"),
    ("M35", STAMPF, "form.dominantShare < 0.6", "form.dominantShare < 0", "sello de Form: color dominante"),
    ("M36", STAMPF, "export const STAMP_MAX_AREA = 0.2;", "export const STAMP_MAX_AREA = 2;", "sello de Form: area maxima"),
    ("M37", STAMPF, "form.lines >= 3 && form.curves < 4 && form.hasText &&", "form.lines >= 3 && form.curves < 4 &&", "sello de Form: el recuadro sin texto es un marco"),
    ("M38", STAMPF, "export const RESIDUAL_RATIO = 0.12;", "export const RESIDUAL_RATIO = 5;", "sello de Form: se quita el gris translucido de debajo"),
    ("M39", STAMPF, "if (hsv.h >= 200 && hsv.h <= 255", "if (hsv.h >= 200 && hsv.h <= 360", "sello de Form: azul saturado"),
    ("M40", STAMPF, "Math.round(item.form.bbox.width / 2)", "Math.round(item.form.bbox.width / 0.001)", "sello de Form: sellos iguales con 1-2 pt de diferencia"),
    ("M41", STAMPF, "bbox.width > viewWidth * 0.7", "bbox.width > viewWidth * 7", "sello de Form: tamano maximo"),
    ("M42", PDFLIB, "current = parent instanceof PDFDict ? parent : undefined;", "current = undefined;", "/Sig: FT y /V se heredan del padre"),
    ("M43", PDFLIB, "hasValue: value !== undefined && value !== PDFNull,", "hasValue: false,", "/Sig: lectura de /V"),
    ("M44", PDFLIB, "if (draws.length > 0 && depth < MAX_FORM_DEPTH) {", "if (draws.length > 0 && depth < 0) {", "/Sig: imagen dentro de Forms anidados"),
    ("M45", SIG, "return a.hasText && !a.hasImage && a.pathSegments <= 8;", "return a.hasText && !a.hasImage && a.pathSegments <= 800;", "/Sig: apariencia de texto"),
    ("M46", SIG, "const warning: ExtractWarning | undefined = signed ?", "const warning: ExtractWarning | undefined = false ?", "/Sig: aviso de firmado digitalmente"),
    ("M47", SIG, "confidence = 0.3;", "confidence = 0.9;", "/Sig: la apariencia de texto baja la confianza"),
    ("M48", SIG, "if (lib && (!appearance?.present || appearance.empty)) {", "if (false) {", "/Sig: campo vacio sin apariencia"),
    ("M49", SIG, "confidence = 0.6;", "confidence = 0.9;", "/Sig: sin pdf-lib la confianza es media"),
    ("M50", STAMP, "/(firma|signature|signed|sign\\s*here)/i", "/(firma|signature|signed)/i", "sello: el nombre habla de una firma"),
    ("M51", STAMP, 'confidence: signature ? 0.7 : 0.9', 'confidence: 0.5', "sello: alta confianza (anotacion de verdad)"),
    ("M52", MAIN, "return (flags & (ANNOT_FLAG_HIDDEN | ANNOT_FLAG_NOVIEW)) === 0;", "return true;", "motor: las anotaciones ocultas no se extraen"),
    ("M53", MAIN, "Math.min(options?.maxPages ?? EXTRACT_LIMITS.maxPages, EXTRACT_LIMITS.maxPages)", "(options?.maxPages ?? EXTRACT_LIMITS.maxPages)", "motor: tope de paginas del contrato"),
    ("M54", MAIN, "        page.cleanup();\n", "        void 0;\n", "motor: page.cleanup() por pagina"),
    ("M55", MAIN, "options.onProgress?.({", "void ({", "motor: progreso por pagina"),
    ("M56", MAIN, "(options.maxAssets ?? EXTRACT_LIMITS.maxAssets) - (ctx.assetsAlreadyFound ?? 0)", "(options.maxAssets ?? EXTRACT_LIMITS.maxAssets)", "motor: los elementos de otros motores cuentan para el tope"),
    ("M57", MAIN, "pagesWith.size / analyzedPages < 0.5", "pagesWith.size / analyzedPages < 0", "(d): la imagen translucida debe repetirse en >= 50 %"),
    ("M58", MAIN, "    if (signal?.aborted) throw new PdfError(\"cancelled\");\n    const pageIndex = pageIndices[position];", "    const pageIndex = pageIndices[position];", "motor: cancelacion antes de cada pagina"),
    ("M59", MAIN, "aggregateTextWatermarks(textPages, analyzedPages, ocgIds)", "aggregateTextWatermarks(textPages, analyzedPages, new Set())", "motor: la capa (a) y el texto (c) no se duplican"),
    ("M60", MAIN, "if (image.objectId && image.alpha < 0.85 && area >= BIG_IMAGE_AREA)", "if (image.objectId && image.alpha < 0.85)", "(d): solo imagenes grandes"),
    ("M62", RENDER, "const byId = ref.annotationId ? annotations.find((annotation) => annotation?.id === ref.annotationId) : undefined;", "const byId = undefined;", "regenerar: se busca la anotacion por su id"),
    ("M63", RENDER, "if (!asset.formats.includes(wanted)) throw", "if (false) throw", "regenerar: formato que el elemento no ofrece"),
    ("M64", OCG, "off.setVisibility(groupId, false);", "off.setVisibility(groupId, true);", "capa: se apaga el grupo para aislarlo"),
    ("M65", OCG, "return (await listOcgGroups(doc)).filter((group) => WATERMARK_NAME_PATTERN.test(foldText(group.name)));", "return (await listOcgGroups(doc));", "capa: solo las de nombre de marca de agua"),
    ("M66", TYPES, "marcas?[\\s_-]?(de[\\s_-]?)?agua|", "", "capa: «Marca de agua» es nombre de marca de agua"),
    ("M68", OPS, "      if (annotationDepth > 0) continue;\n", "", "texto: lo de dentro de beginAnnotation no es de la pagina"),
    ("M69", MAIN, '  if (capped) warnings.push({ code: "too-many-assets" });\n  if (signal?.aborted) throw new PdfError("cancelled");\n', '  if (capped) warnings.push({ code: "too-many-assets" });\n', "motor: cancelar al final tambien cuenta"),
    ("M70", MAIN, "ctx.getOperatorList ? ctx.getOperatorList(page, pageIndex) :", "false ? ctx.getOperatorList(page, pageIndex) :", "motor: reutiliza la lista de operadores del orquestador"),
    ("M71", RENDER, 'engine === "vector" && asset.source === "form"', 'engine === "vector"', "reparto: la firma vectorial beta no es de este motor"),
    ("M72", MAIN, "const stepTimeout = ctx.stepTimeoutMs ?? STEP_TIMEOUT_MS;", "const stepTimeout = STEP_TIMEOUT_MS;", "motor: plazo por paso de pdf.js (promesas sin resolver)"),
    ("M73", RASTER, 'signal?.addEventListener("abort", onAbort, { once: true });\n    promise.then(', 'promise.then(', "motor: cancelar con pdf.js colgado"),
    ("M67", PAGE, "if (x1 - x0 < 0.5 || y1 - y0 < 0.5) return null;", "if (false) return null;", "geometria: una caja de 0 x 0 no es visible"),
]


LAST_FAILURE = ""


def run_tests() -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive). Guarda en LAST_FAILURE la primera prueba que fallo."""
    global LAST_FAILURE
    result = subprocess.run(
        ["npx", "vitest", "run", "src/lib/pdf/extractAssets", "--project", "engines", "--bail", "1"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    LAST_FAILURE = next((line.strip() for line in (result.stdout + result.stderr).splitlines() if "FAIL" in line), "")
    return result.returncode == 0


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check" in sys.argv[1:]
    selected = [m for m in MUTATIONS if not args or m[0] in args]
    if check_only:
        missing = 0
        for mutation_id, file, old, _new, description in selected:
            text = (ROOT / file).read_text(encoding="utf8")
            if (old if isinstance(old, str) else old[0]) not in text:
                print(f"{mutation_id}: NO APLICA - {description}")
                missing += 1
        print(f"{len(selected) - missing} de {len(selected)} mutaciones se pueden aplicar")
        return 0 if missing == 0 else 1
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
        print(f"{mutation_id}: {status:10s} ({time.time() - started:4.1f}s) {description}" + ("" if alive else f"  <- {LAST_FAILURE[:150]}"), flush=True)
        if alive:
            survivors.append(mutation_id)
    killed = len(selected) - len(survivors)
    print(f"\n{killed} de {len(selected)} mutaciones mueren; sobreviven: {', '.join(survivors) or 'ninguna'}")
    return 0 if not survivors else 1


if __name__ == "__main__":
    sys.exit(main())
