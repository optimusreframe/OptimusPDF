#!/usr/bin/env python3
"""
Mutaciones de la interfaz de «Extraer elementos» (F7 · U7.4): aplica de una en una cambios pequenos a la logica (umbral de
«probable», filtros, nombres p03-firma-01, formato de descarga, seleccion, avisos, reglas de guardado en el baul, ZIP,
planificacion del recorte, capas del motor) y comprueba que las pruebas de `src/app/extract-assets` y
`src/lib/pdf/extractAssets` fallan. Una mutacion que NO hace fallar ninguna prueba «sobrevive» e indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/extract-ui-mutate.py            # todas
    python3 scripts/extract-ui-mutate.py M07 M12    # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL = "src/app/extract-assets/model.ts"
SAVE = "src/app/extract-assets/saveModel.ts"
ZIP = "src/lib/pdf/extractAssets/zip.ts"
REGION = "src/lib/pdf/extractAssets/region.ts"
INDEX = "src/lib/pdf/extractAssets/index.ts"
SELECTOR = "src/app/extract-assets/RegionSelector.tsx"
CLIENT = "src/app/extract-assets/ExtractToolClient.tsx"
SHEET = "src/app/extract-assets/SaveSignatureSheet.tsx"
PANEL = "src/app/extract-assets/RegionPanel.tsx"
FAKE = "src/lib/pdf/extractAssets/testing/fakeEngine.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    ("M01", MODEL, "export const PROBABLE_BELOW = 0.9;", "export const PROBABLE_BELOW = 0.5;", "umbral de confianza de «probable»"),
    ("M02", MODEL, '  if (asset.kind === "image" || asset.kind === "photo") return false;\n', "", "las imagenes y fotos nunca son «probables»"),
    ("M03", MODEL, '    case "image":\n    case "photo":\n      return "image";', '    case "image":\n      return "image";', "filtro: las fotos van con las imagenes"),
    ("M04", MODEL, "if (pages.length > 3) return", "if (pages.length > 30) return", "nombre accesible: mas de 3 paginas se cuentan"),
    ("M05", MODEL, '  if (asset.pixel === null && asset.formats.includes("txt")) return "txt";\n', "", "formato original: un texto se entrega como .txt"),
    ("M06", MODEL, "const width = maxPage > 99 ? 3 : 2;", "const width = 2;", "nombre de archivo: 3 cifras con mas de 99 paginas"),
    ("M07", MODEL, "const count = (counters.get(key) ?? 0) + 1;", "const count = (counters.get(key) ?? 0) + 2;", "nombre de archivo: contador por pagina y tipo"),
    ("M08", MODEL, "if (rectA.y !== rectB.y) return rectA.y - rectB.y;", "if (rectA.y !== rectB.y) return rectB.y - rectA.y;", "orden: de arriba abajo"),
    ("M09", MODEL, "  if (allVisibleSelected(selected, visible)) for", "  if (!allVisibleSelected(selected, visible)) for", "«Seleccionar todo» alterna marcar/desmarcar"),
    ("M10", MODEL, "from + maxPages - 1));\n  return { from: from + 1", "from + maxPages));\n  return { from: from + 1", "rango analizado: tope de paginas"),
    ("M11", MODEL, 'error.name === "PdfError"', "false", "errores: PdfError reconocido por nombre y codigo"),
    ("M12", MODEL, 'code === "aborted" || code === "cancelled"', 'code === "cancelled"', "cancelacion: el «aborted» del motor de tinta"),
    ("M13", MODEL, "pages.length === 1 ? strings.warnScannedOne", "pages.length === 0 ? strings.warnScannedOne", "aviso de escaneo en singular"),
    ("M14", SAVE, 'if (keys.has(normalizeSignerKey(name))) return { action: "error", reason: "nameTaken" };', "if (false) return { action: \"error\", reason: \"nameTaken\" };", "guardado: un nombre ya guardado no se duplica"),
    ("M15", SAVE, '    if (conflict === null) return { action: "error", reason: "conflictNeeded" };\n', "", "guardado: con conflicto hay que elegir"),
    ("M16", SAVE, 'return { ...input, origin: "extracted", sourceDocument };', 'return { ...input, origin: "uploaded", sourceDocument };', "guardado: origin «extracted»"),
    ("M17", SAVE, "deleteIds: [plan.existing.id]", "deleteIds: []", "reemplazo: borra la entrada vieja en la misma transaccion"),
    ("M18", SAVE, "expectUnchanged: [plan.existing]", "expectUnchanged: []", "reemplazo: no escribe si otra pestana cambio la entrada"),
    ("M19", SAVE, 'signature: kind === "signature" ? ink : toPrepared(existing.signature),', 'signature: kind === "signature" ? toPrepared(existing.signature) : ink,', "completar: la imagen nueva va en SU tipo"),
    ("M20", ZIP, "{ key: zipNameKey }", "{}", "ZIP: nombres unicos sin distinguir mayusculas ni Unicode"),
    ("M21", ZIP, '.replace(/^[\\s.-]+|[\\s.]+$/g, "")', ".replace(/^$/g, \"\")", "ZIP: sin puntos ni espacios al borde"),
    ("M22", ZIP, 'compression: compressible ? "DEFLATE" : "STORE"', 'compression: "STORE"', "ZIP: el texto y el SVG se comprimen"),
    ("M23", ZIP, "if (entries.length > MAX_ZIP_ENTRIES) throw", "if (entries.length > MAX_ZIP_ENTRIES * 100) throw", "ZIP: tope de entradas"),
    ("M24", REGION, "export const REGION_MIN_DPI = 300;", "export const REGION_MIN_DPI = 72;", "recorte: minimo de 300 ppp"),
    ("M25", REGION, "if (area(scale) > REGION_MAX_PIXELS) {", "if (false) {", "recorte: tope de 16 millones de pixeles"),
    ("M26", REGION, 'crop: "auto", margin: "auto"', 'crop: "none", margin: "auto"', "recorte: se recorta a la tinta"),
    ("M27", REGION, "if (options.cleanBackground === false) {", "if (false) {", "recorte: cleanBackground:false devuelve la region tal cual"),
    ("M28", INDEX, "return { ...unavailableEngine, ...(installed ?? {}), ...(testHook() ?? {}) };", "return { ...unavailableEngine, ...(testHook() ?? {}), ...(installed ?? {}) };", "fachada: el gancho de pruebas manda sobre lo instalado"),
    ("M29", INDEX, 'readonly code = "engine-unavailable";', 'readonly code = "otro";', "fachada: el error de motor ausente es reconocible"),
    ("M30", SELECTOR, "const KEY_STEP = 0.01;", "const KEY_STEP = 0.1;", "rectangulo: paso de 1 % con el teclado"),
    ("M31", SELECTOR, 'event.shiftKey ? nudgeCorner(rectRef.current, "se", dx, dy) : shiftCrop(rectRef.current, dx, dy)', 'event.shiftKey ? shiftCrop(rectRef.current, dx, dy) : nudgeCorner(rectRef.current, "se", dx, dy)', "rectangulo: flechas mueven, Mayus + flechas redimensionan"),
    ("M32", CLIENT, "maxAssets: EXTRACT_LIMITS.maxAssets,", "", "pantalla: pide el tope de 500 elementos"),
    ("M33", CLIENT, "setSelected((previous) => pruneSelection(previous, output.assets));", "", "pantalla: la seleccion se limpia al volver a buscar"),
    ("M34", PANEL, "dpi: Number(quality),", "dpi: 300,", "panel: la calidad elegida llega al motor"),
    ("M35", PANEL, "const key = `${page}|", "const key = `${0}|", "panel: la vista previa se descarta al cambiar de pagina"),
    ("M36", SHEET, 'vaultStatus !== "loading" && !saving', "!saving", "hoja: no se guarda sin la lista del baul"),
    ("M37", FAKE, "const tooMany = pageCount > maxPages && !requested;", "const tooMany = false;", "motor falso: aviso de mas de 300 paginas"),
]


def run_tests() -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive)."""
    result = subprocess.run(
        ["npx", "vitest", "run", "src/app/extract-assets", "src/lib/pdf/extractAssets", "src/lib/tools-registry"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
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
