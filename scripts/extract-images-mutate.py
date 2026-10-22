#!/usr/bin/env python3
"""
Mutaciones del motor de imagenes de «Extraer elementos» (U7.0 + U7.1): aplica de una en una cambios pequenos a la logica
(recorrido de matrices, lectura de pixeles, deduplicacion, topes, JPEG original, configuracion del WASM) y comprueba que
las pruebas `src/lib/pdf/extractAssets/images*.test.ts` y `src/lib/pdf/core.wasm*.test.ts` fallan. Una mutacion que NO
hace fallar ninguna prueba «sobrevive» y indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/extract-images-mutate.py            # todas
    python3 scripts/extract-images-mutate.py M07 M12    # solo esas
    python3 scripts/extract-images-mutate.py --check    # solo comprueba que el texto original existe

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OPS = "src/lib/pdf/extractAssets/imagesOps.ts"
PIX = "src/lib/pdf/extractAssets/imagesPixels.ts"
JPEG = "src/lib/pdf/extractAssets/imagesJpeg.ts"
MAIN = "src/lib/pdf/extractAssets/images.ts"
CORE = "src/lib/pdf/core.ts"
NEXT = "next.config.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    # --- recorrido de la lista de operadores (matrices) ---
    ("M01", OPS, "      matrix = top?.matrix ?? IDENTITY;\n      fill = top?.fill ?? [0, 0, 0];\n      formDepth = Math.max(0, formDepth - 1);", "      formDepth = Math.max(0, formDepth - 1);", "matrices: un Form XObject no restaura la CTM al cerrarse"),
    ("M02", OPS, "if (isMatrix(args)) matrix = multiplyMatrix(matrix, toMatrix(args));", "if (isMatrix(args)) matrix = multiplyMatrix(toMatrix(args), matrix);", "matrices: orden de composicion de `cm`"),
    ("M03", OPS, "if (isMatrix(formMatrix)) matrix = multiplyMatrix(matrix, toMatrix(formMatrix));", "", "matrices: se ignora la matriz del Form XObject"),
    ("M04", OPS, "      const top = stack.pop();\n      matrix = top?.matrix ?? IDENTITY;\n      fill = top?.fill ?? [0, 0, 0];\n    } else if (op === ops.transform)", "      stack.pop();\n    } else if (op === ops.transform)", "matrices: `restore` no deshace el `cm`"),
    ("M05", OPS, "matrix: multiplyMatrix(matrix, [scaleX, 0, 0, scaleY, positions[k], positions[k + 1]])", "matrix: multiplyMatrix(matrix, [scaleY, 0, 0, scaleX, positions[k], positions[k + 1]])", "repeticiones: escala X/Y intercambiadas"),
    ("M06", OPS, "ok = push({ opIndex: index, entry: k / 2, kind: \"xobject\"", "ok = push({ opIndex: index, entry: 0, kind: \"xobject\"", "repeticiones: la entrada de cada aparicion"),
    ("M07", OPS, "const clamp = (v: number): number => Math.min(1, Math.max(0, v));", "const clamp = (v: number): number => v;", "geometria: las cajas se recortan a la pagina"),
    ("M08", OPS, "const gy0 = Math.max(0, Math.ceil(rect.y * grid - 0.5));", "const gy0 = Math.max(0, Math.floor(rect.y * grid + 3));", "cobertura: celdas de la union"),
    ("M09", OPS, "stack.length = 0;\n      formDepth = 0;\n      matrix = IDENTITY;\n      fill = [0, 0, 0];\n      const list", "formDepth = 0;\n      matrix = IDENTITY;\n      fill = [0, 0, 0];\n      const list", "anotaciones: empiezan desde la pila vacia de la pagina"),
    ("M10", OPS, "if (isMatrix(list[2])) matrix = multiplyMatrix(matrix, toMatrix(list[2]));", "", "anotaciones: transformacion de la anotacion"),
    ("M11", OPS, "y: y0, width: x1 - x0, height: y1 - y0 };", "y: y0, width: x1 - x0, height: y0 - y1 };", "geometria: alto de la caja"),
    # --- pixeles ---
    ("M12", PIX, "const value = byte & (128 >> (x & 7)) ? 255 : 0;", "const value = byte & (128 >> (x & 7)) ? 0 : 255;", "pixeles: gris de 1 bit invertido"),
    ("M13", PIX, "        out[dst + 3] = byte & (128 >> (x & 7)) ? 0 : 255;", "        out[dst + 3] = byte & (128 >> (x & 7)) ? 255 : 0;", "pixeles: mascara de 1 bit invertida"),
    ("M14", PIX, "        out[dst + 3] = 255;\n        src += 3;", "        out[dst + 3] = 0;\n        src += 3;", "pixeles: RGB expandido a RGBA opaco"),
    ("M15", PIX, "if (a !== 255) hasAlpha = true;", "if (a < 0) hasAlpha = true;", "analisis: deteccion de transparencia"),
    ("M16", PIX, "sums[k] += data[index] * a;\n        sums[k + 1] += data[index + 1] * a;\n        sums[k + 2] += data[index + 2] * a;", "sums[k] += data[index] * 255;\n        sums[k + 1] += data[index + 1] * 255;\n        sums[k + 2] += data[index + 2] * 255;", "miniatura: el color se pondera por el alfa"),
    ("M17", PIX, "const scale = Math.min(1, thumbPx / Math.max(width, height));", "const scale = Math.min(2, thumbPx / Math.max(width, height));", "miniatura: nunca se agranda"),
    ("M18", PIX, "const from = (r * parentWidth + x) * 4;", "const from = (r * parentWidth) * 4;", "atlas: columna de inicio de la casilla"),
    ("M19", PIX, "  mix(sample);\n", "", "huella: la muestra de pixeles a tamano completo"),
    ("M20", PIX, "    for (const entry of [this.bandCanvas, this.full]) {", "    this.bitmap.close?.();\n    for (const entry of [this.bandCanvas, this.full]) {", "bitmap: no se cierra el ImageBitmap de pdf.js"),
    ("M21", PIX, "  return new Promise((resolve) => setTimeout(resolve, 0));\n}", "  return Promise.resolve();\n}", "hilo: ceder de verdad el control"),
    ("M22", PIX, "if (now() - this.since < SLICE_MS) return;", "return;", "hilo: nunca se cede el control"),
    ("M23", PIX, "const bandRows = Math.max(1, Math.floor(BAND_PIXELS / width));\n  let hasAlpha = false;", "const bandRows = height;\n  let hasAlpha = false;", "memoria: el analisis lee la imagen entera de una vez"),
    ("M24", PIX, "if (this.signal?.aborted) throw abortError();", "", "cancelacion: se comprueba en cada tick"),
    # --- motor ---
    ("M25", MAIN, "export const SCANNED_COVERAGE = 0.9;", "export const SCANNED_COVERAGE = 0.5;", "escaneo: cobertura de pagina"),
    ("M26", MAIN, "export const MAX_OCCURRENCES_PER_ASSET = 500;", "export const MAX_OCCURRENCES_PER_ASSET = 5000;", "limite: apariciones por elemento"),
    ("M27", MAIN, "            const sameRef = byRef.get(ref);", "            const sameRef = undefined as AssetState | undefined;", "dedup: por referencia de objeto"),
    ("M28", MAIN, "          const duplicate = byHash.get(hashKey);", "          const duplicate = undefined as AssetState | undefined;", "dedup: por huella de pixeles"),
    ("M29", MAIN, "jpeg.width === analysis.width && jpeg.height === analysis.height", "true", "JPEG original: debe coincidir con las medidas decodificadas"),
    ("M30", MAIN, "if (biggest > maxPixels) {", "if (biggest > maxPixels * 1000) {", "limite: imagen de mas de 50 MP"),
    ("M31", MAIN, "if (states.length >= maxAssets) {", "if (states.length > maxAssets) {", "limite: tope de elementos"),
    ("M32", MAIN, "  if (hasAlpha) return [\"png\"];\n  return jpegOriginal ? [\"png\", \"jpg-original\"] : [\"png\", \"jpg\"];", "  if (hasAlpha) return [\"png\", \"jpg\"];\n  return jpegOriginal ? [\"png\", \"jpg-original\"] : [\"png\", \"jpg\"];", "formatos: una imagen con alfa no puede ir a JPEG"),
    ("M33", MAIN, "        page?.cleanup();", "        void page;", "memoria: page.cleanup() por pagina"),
    ("M34", MAIN, "  const stores = [page.objs as unknown as PageObjectStore, page.commonObjs as unknown as PageObjectStore];", "  const stores = [page.objs as unknown as PageObjectStore];", "objetos: las imagenes globales viven en commonObjs"),
    ("M35", MAIN, "const ANNOTATION_MODE_DISABLE = 0;", "const ANNOTATION_MODE_DISABLE = 1;", "contenido: sin las anotaciones por defecto"),
    ("M36", MAIN, "if (chars < MIN_CHARS_FOR_TEXT_PAGE) {", "if (chars < 0) {", "escaneo: sin texto"),
    ("M37", MAIN, "if (last - first + 1 > maxPages) {", "if (last - first + 1 > maxPages * 100) {", "limite: tope de paginas"),
    ("M38", MAIN, "    if (event.inForm) state.inForm = true;", "", "motivos: dentro de un formulario"),
    ("M39", MAIN, "    if (event.inAnnotation) state.inAnnotation = true;", "", "motivos: dentro de una anotacion"),
    ("M40", MAIN, "if (!asset.formats.includes(format)) throw new ImageAssetError(\"format-unavailable\"", "if (false) throw new ImageAssetError(\"format-unavailable\"", "render: solo los formatos ofrecidos"),
    ("M41", MAIN, "if (ref && ref !== parsed.ref) throw new ImageAssetError(\"asset-changed\"", "if (false) throw new ImageAssetError(\"asset-changed\"", "render: el objeto debe seguir siendo el mismo"),
    ("M42", MAIN, "          missedObjects += 1;\n", "", "plazo: tras un objeto que no llega, los siguientes esperan menos"),
    # --- JPEG original ---
    ("M43", JPEG, "      if (dict.has(PDFName.of(\"SMask\")) || dict.has(PDFName.of(\"Mask\")) || dict.has(PDFName.of(\"Decode\"))) continue;", "      if (dict.has(PDFName.of(\"Mask\")) || dict.has(PDFName.of(\"Decode\"))) continue;", "JPEG original: no con /SMask"),
    ("M44", JPEG, "|| dict.has(PDFName.of(\"Decode\"))) continue;", ") continue;", "JPEG original: no con /Decode"),
    ("M45", JPEG, "(header.components !== 1 && header.components !== 3)", "(header.components > 4)", "JPEG original: solo gris o RGB"),
    ("M46", JPEG, "  if (doc.isEncrypted) return index;", "", "JPEG original: no en un documento cifrado"),
    ("M47", JPEG, "filter.size() === 1 && ", "", "JPEG original: un unico filtro"),
    ("M48", JPEG, "if (!header || ", "if (", "JPEG original: los bytes deben ser un JPEG"),
    ("M49", JPEG, "return ref.generationNumber === 0 ? `${ref.objectNumber}R` : `${ref.objectNumber}R${ref.generationNumber}`;", "return `${ref.objectNumber}R`;", "JPEG original: clave igual a la ref de pdf.js"),
    ("M50", JPEG, "if (pdfBytes.byteLength > MAX_JPEG_SCAN_BYTES) return index;", "", "JPEG original: tope de tamano al abrir con pdf-lib"),
    # --- U7.0: decodificadores WASM ---
    ("M51", CORE, "      wasmUrl: PDF_WASM_URL,\n", "", "wasm: openPdfDocument no pasa wasmUrl"),
    ("M52", CORE, "export const PDF_WASM_URL = \"/pdfjs-wasm/\";", "export const PDF_WASM_URL = \"/pdfjs-wasm\";", "wasm: la ruta debe acabar en barra"),
    ("M53", NEXT, "        source: \"/pdfjs-wasm/:path*\",", "        source: \"/pdfjs-wasm-x/:path*\",", "wasm: cabecera de cache de los decodificadores"),
    ("M54", NEXT, "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:", "script-src 'self' 'unsafe-inline' blob:", "wasm: el CSP debe permitir WebAssembly"),
]

TESTS = [
    "npx", "vitest", "run", "--project", "engines",
    "src/lib/pdf/extractAssets/images", "src/lib/pdf/core.wasm",
]


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
        print(f"{mutation_id}: {status:10s} ({time.time() - started:4.1f}s) {description}")
        if alive:
            survivors.append(mutation_id)
    killed = len(selected) - len(survivors)
    print(f"\n{killed} de {len(selected)} mutaciones mueren; sobreviven: {', '.join(survivors) or 'ninguna'}")
    return 0 if not survivors else 1


if __name__ == "__main__":
    sys.exit(main())
