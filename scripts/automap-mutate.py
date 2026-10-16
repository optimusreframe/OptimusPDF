#!/usr/bin/env python3
"""
Mutaciones del automapeo (U2.8): aplica de una en una cambios pequenos a la logica (umbrales, agrupamiento por
repeticion, asociacion etiqueta-raya, orden de firmantes, limites) y comprueba que las pruebas
`src/lib/pdf/autoMap*.test.ts` fallan. Una mutacion que NO hace fallar ninguna prueba «sobrevive» y indica una prueba
que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/automap-mutate.py            # todas
    python3 scripts/automap-mutate.py M07 M12    # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = "src/lib/pdf/autoMapPage.ts"
LAYOUT = "src/lib/pdf/autoMapLayout.ts"
REPEAT = "src/lib/pdf/autoMapRepeat.ts"
MAIN = "src/lib/pdf/autoMap.ts"
TEXT = "src/lib/pdf/autoMapText.ts"
COLLECT = "src/lib/pdf/autoMapCollect.ts"
RASTER = "src/lib/pdf/autoMapRaster.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    ("M01", PAGE, "  initials: 7,", "  initials: 70,", "umbral: hueco maximo etiqueta-raya de unas iniciales"),
    ("M02", PAGE, "  signature: 14,", "  signature: 140,", "umbral: hueco maximo etiqueta-raya de una firma"),
    ("M03", PAGE, "BELOW_LABEL_MAX_GAP_EM = 2.4", "BELOW_LABEL_MAX_GAP_EM = 12", "umbral: leyenda debajo de la raya"),
    ("M04", PAGE, "ABOVE_LABEL_MAX_GAP_EM = 3.4", "ABOVE_LABEL_MAX_GAP_EM = 14", "umbral: rotulo encima de la raya"),
    ("M05", PAGE, "LINE_MIN_WIDTH_EM = 2.6", "LINE_MIN_WIDTH_EM = 0.5", "umbral: ancho minimo de una raya"),
    ("M06", PAGE, "LINE_MAX_PAGE_FRACTION = 0.62", "LINE_MAX_PAGE_FRACTION = 0.99", "umbral: una raya larga es un separador"),
    ("M07", PAGE, "LINE_MAX_THICKNESS_PT = 2.4", "LINE_MAX_THICKNESS_PT = 24", "umbral: grosor maximo de una raya"),
    ("M08", PAGE, "PHRASE_BREAK_EM = 1.4", "PHRASE_BREAK_EM = 14", "umbral: corte de frases por hueco ancho"),
    ("M09", PAGE, "return touchLeft && touchRight;", "return touchLeft || touchRight;", "asociacion: borde de celda de una tabla"),
    ("M10", PAGE, "if (list.length < 5) continue;", "if (list.length < 2) continue;", "papel pautado: minimo de rayas"),
    ("M11", PAGE, "if (regular >= 0.7 * gaps.length)", "if (regular >= 0 * gaps.length)", "papel pautado: regularidad del paso"),
    ("M12", PAGE, "row.sort((a, b) => a.assoc.line.x0 - b.assoc.line.x0);", "row.sort((a, b) => b.assoc.line.x0 - a.assoc.line.x0);", "firmantes: columnas, izquierda primero"),
    ("M13", PAGE, "[...pool].sort((a, b) => b.assoc.line.y - a.assoc.line.y)", "[...pool].sort((a, b) => a.assoc.line.y - b.assoc.line.y)", "firmantes: apiladas, de arriba abajo"),
    ("M14", PAGE, "    if (cost === null || cost < 0) continue;\n    // La firma de la otra parte", "    if (cost === null || cost < 0 || sig.assoc.anchor.role === \"company\") continue;\n    // La firma de la otra parte", "firmantes: la fecha pegada a la firma de la otra parte no es de un firmante"),
    ("M15", PAGE, "if (covered > 0.2) candidate.notes.push(\"covers-text\");", "if (covered > 2) candidate.notes.push(\"covers-text\");", "politica: no cubrir texto"),
    ("M16", PAGE, "const ALIGN_MIN_OVERLAP = 0.4;", "const ALIGN_MIN_OVERLAP = 0;", "asociacion: alineacion etiqueta-raya"),
    ("M17", PAGE, "const BOX_MIN_W_EM = 2.2;", "const BOX_MIN_W_EM = 0.2;", "casillas: ancho minimo (casilla de marcar no es de iniciales)"),
    ("M18", PAGE, "if (hasText || hasImage) continue;", "if (hasImage) continue;", "casillas: debe estar vacia"),
    ("M19", PAGE, "const SLOT_GROUP_GAP_EM = 2.6;", "const SLOT_GROUP_GAP_EM = 0;", "iniciales: marcas contiguas «__/__»"),
    ("M20", PAGE, "assoc.cost <= 1.3;", "assoc.cost <= 0;", "asociacion: raya compartida por varias etiquetas"),
    ("M21", PAGE, "signerIndex: order as 0 | 1,", "signerIndex: (1 - order) as 0 | 1,", "orden: el firmante 1 va a la izquierda"),
    ("M22", PAGE, "  const sorted = [...all].sort((a, b) => a.cost - b.cost);\n  const usedLines", "  const sorted = [...all].sort((a, b) => b.cost - a.cost);\n  const usedLines", "asociacion: gana el costo menor"),
    ("M24", PAGE, "if (assoc.anchor.role === \"company\") notes.push(\"company\");", "", "politica: firma de la otra parte"),
    ("M25", PAGE, "if (coverage(above, coverBoxes) > 0.25) continue;", "", "repeticion: subrayado de texto no es raya de iniciales"),
    ("M26", PAGE, "if (coverage(below, textBoxes) > 0.15) continue;", "", "repeticion: separador de pie no es raya de iniciales"),
    ("M27", LAYOUT, "if (length >= 2 * minW + gap) {", "if (length >= minW) {", "disposicion: mitades vs casillas contiguas"),
    ("M28", LAYOUT, "rects: [make(c0 - width / 2, c0 + width / 2), make(c1 - width / 2, c1 + width / 2)],", "rects: [make(c1 - width / 2, c1 + width / 2), make(c0 - width / 2, c0 + width / 2)],", "orden: mitades de la raya"),
    ("M29", LAYOUT, "const slots = host.slots.slice(0, signers);", "const slots = host.slots.slice(0, signers).reverse();", "orden: marcas «__/__»"),
    ("M30", LAYOUT, "const limitRight = env.pageWidth - margin;", "const limitRight = env.pageWidth;", "disposicion: margen de pagina"),
    ("M31", LAYOUT, "export const SIGNATURE_MAX_W_FRACTION = 0.5;", "export const SIGNATURE_MAX_W_FRACTION = 1.5;", "disposicion: ancho maximo de la firma"),
    ("M32", LAYOUT, "export const SIGNATURE_MIN_H_EM = 1.8;", "export const SIGNATURE_MIN_H_EM = 0.3;", "disposicion: altura minima libre de la firma"),
    ("M33", LAYOUT, "export const INITIAL_MIN_W_EM = 3.4;", "export const INITIAL_MIN_W_EM = 1;", "disposicion: ancho minimo de unas iniciales"),
    ("M34", LAYOUT, "if (box.y1 <= y0 + 0.3 * em) continue;", "continue;", "disposicion: la firma no cubre el texto de encima"),
    ("M35", REPEAT, "  tolX: 0.025,", "  tolX: 0.5,", "agrupamiento: tolerancia horizontal"),
    ("M36", REPEAT, "  tolY: 0.02,", "  tolY: 0.5,", "agrupamiento: tolerancia vertical"),
    ("M37", REPEAT, "  minPageRatio: 0.6,", "  minPageRatio: 0.05,", "agrupamiento: fraccion minima de paginas"),
    ("M38", REPEAT, "  widthTolerance: 0.35,", "  widthTolerance: 9,", "agrupamiento: parecido de largo"),
    ("M39", REPEAT, "if (usedInPage.has(cluster)) continue;", "", "agrupamiento: una raya por pagina y grupo"),
    ("M40", MAIN, "export const MAX_FIELDS_PER_PAGE = 12;", "export const MAX_FIELDS_PER_PAGE = 24;", "limite: campos por pagina"),
    ("M41", MAIN, "export const MAX_FIELDS_PER_DOCUMENT = 80;", "export const MAX_FIELDS_PER_DOCUMENT = 200;", "limite: campos por documento"),
    ("M42", MAIN, "export const REPEAT_HIGH_MIN_PAGES = 3;", "export const REPEAT_HIGH_MIN_PAGES = 1;", "politica: repeticion clara necesita 3 paginas"),
    ("M43", MAIN, "export const REPEAT_MIN_TOP_FRACTION = 0.12;", "export const REPEAT_MIN_TOP_FRACTION = 0;", "politica: la repeticion en el membrete no es `high`"),
    ("M44", MAIN, "iou(other.rect, field.rect) > 0.6", "iou(other.rect, field.rect) > 1.5", "deduplicacion: tipos distintos que casi coinciden"),
    ("M45", MAIN, "candidate.signerIndex >= signers", "candidate.signerIndex > signers", "politica: firmante de mas se ignora"),
    ("M46", MAIN, "const DEMOTING_NOTES = new Set([\"blocked\", \"covers-text\", \"covers-image\", \"company\", \"no-signer\", \"no-line\", \"slot-structural\"]);", "const DEMOTING_NOTES = new Set<string>([]);", "politica: los avisos bajan `high` a `review`"),
    ("M47", MAIN, "export const HIGH_CONFIDENCE = 0.75;", "export const HIGH_CONFIDENCE = 0.1;", "politica: umbral de `high`"),
    ("M48", MAIN, ".filter((line) => line.y >= 0.3 && line.y <= 0.97 && line.x1 - line.x0 >= 0.2)", ".filter((line) => line.y <= 0.97)", "escaneados: solo rayas largas y en la mitad inferior"),
    ("M49", COLLECT, "setTimeout(resolve, 0);", "resolve();", "rendimiento: ceder de verdad el control al hilo principal"),
    ("M50", TEXT, "const SHORT_PHRASE_MAX_WORDS = 6;", "const SHORT_PHRASE_MAX_WORDS = 60;", "diccionario: la prosa no es etiqueta"),
    ("M51", TEXT, "const MAX_LABEL_PHRASE_WORDS = 14;", "const MAX_LABEL_PHRASE_WORDS = 140;", "diccionario: frases largas con etiqueta al final"),
    ("M52", TEXT, ["(?!\\s*(?:of|de|del)\\b)/g },\n  { kind: \"name\"", "const dateAsData = DATE_AS_DATA.test(folded);"], ["/g },\n  { kind: \"name\"", "const dateAsData = false;"], "diccionario: «date of loss» no es la fecha de firma"),
    ("M53", TEXT, "  if (parenthesised || punctuated) return true;\n  if (/\\bplease", "  if (/\\bplease", "diccionario: «(initial)» entre parentesis"),
    ("M54", TEXT, "  if (client && !/\\b(?:public adjusters?", "  if (false && client && !/\\b(?:public adjusters?", "roles: el cliente no es la otra parte"),
    ("M55", TEXT, "  if (CO_SIGNER.test(normalized)) return 1;", "", "pistas: «co-insured» es el firmante 2"),
    ("M56", COLLECT, "const sub = subPathsOf(data);", "const sub = null;", "geometria: subtrazos de una misma ruta"),
    ("M57", COLLECT, "      if (m && m.length === 6) current = compose(current, m as unknown as Matrix);\n      continue;\n    }\n    if (ops.paintFormXObjectEnd", "      continue;\n    }\n    if (ops.paintFormXObjectEnd", "geometria: matriz de los XObject de formulario"),
    ("M58", COLLECT, "const sc = Math.max(g.viewWidth, 1) / 612;", "const sc = Math.max(g.viewWidth, 1) / 61.2;", "geometria: umbrales de forma proporcionales a la pagina"),
    ("M59", RASTER, "export const RASTER_MIN_LINE_FRACTION = 0.16;", "export const RASTER_MIN_LINE_FRACTION = 0.01;", "raster: largo minimo de la raya"),
    ("M60", RASTER, "export const RASTER_MAX_THICKNESS_FRACTION = 0.012;", "export const RASTER_MAX_THICKNESS_FRACTION = 0.5;", "raster: grosor maximo de la raya"),
]


def run_tests() -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive)."""
    result = subprocess.run(
        ["npx", "vitest", "run", "src/lib/pdf/autoMap", "--project", "engines"],
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
        pairs = list(zip(old, new)) if isinstance(old, list) else [(old, new)]
        if any(before not in original for before, _ in pairs):
            print(f"{mutation_id}: NO APLICA (texto original no encontrado) - {description}")
            survivors.append(mutation_id)
            continue
        started = time.time()
        try:
            mutated = original
            for before, after in pairs:
                mutated = mutated.replace(before, after)
            path.write_text(mutated, encoding="utf8")
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
