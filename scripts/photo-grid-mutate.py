#!/usr/bin/env python3
"""
Mutaciones de la composicion de «Fotos por pagina» (`src/lib/pdf/photoGrid.ts`): aplica de una en una cambios pequenos
(gutter, simetria, contain, celdas, ultima hoja, modo 2, margenes, orientacion, numero de hojas) y comprueba que
`src/lib/pdf/photoGrid.test.ts` falla. Una mutacion que NO hace fallar ninguna prueba «sobrevive» e indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/photo-grid-mutate.py            # todas
    python3 scripts/photo-grid-mutate.py G03 G07    # solo esas
    python3 scripts/photo-grid-mutate.py --check    # solo comprueba que el texto original existe

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRID = "src/lib/pdf/photoGrid.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    ("G01", GRID, "export const GRID_GUTTER = 12;", "export const GRID_GUTTER = 0;", "gutter fijo a cero"),
    ("G02", GRID, "return { cols: 2, rows: perPage / 2 };", "return { cols: 2, rows: perPage / 2 + 1 };", "forma: una fila de mas"),
    ("G03", GRID, "const scale = Math.min(cell.width / photo.width, cell.height / photo.height);", "const scale = Math.max(cell.width / photo.width, cell.height / photo.height);", "contain: cover en vez de contain (recorta)"),
    ("G04", GRID, "return { x: cell.x + (cell.width - width) / 2, y: cell.y + (cell.height - height) / 2, width, height };", "return { x: cell.x, y: cell.y, width, height };", "contain: la foto no se centra en la celda"),
    ("G05", GRID, "const alone = column === 0 && position === count - 1; // unica de su fila: se centra", "const alone = false; // unica de su fila: se centra", "ultima hoja: la foto sola de la fila no se centra"),
    ("G06", GRID, "const width = Math.min(boxWidth, (boxHeight - gutter) / ratioSum);", "const width = boxWidth;", "modo 2: no se reducen si no caben a lo alto"),
    ("G07", GRID, "const middle = Math.max(gutter, free / 3);", "const middle = free / 3;", "modo 2: sin separacion minima entre las dos"),
    ("G08", GRID, "const outer = Math.max(0, (free - middle) / 2);", "const outer = 0;", "modo 2: el espacio libre no se reparte arriba y abajo"),
    ("G09", GRID, "const cellWidth = (boxWidth - gutter) / 2;", "const cellWidth = boxWidth / 2;", "cuadricula: celdas sin descontar el gutter horizontal"),
    ("G10", GRID, "const cellHeight = (boxHeight - gutter * (rows - 1)) / rows;", "const cellHeight = boxHeight / rows;", "cuadricula: celdas sin descontar los gutters verticales"),
    ("G11", GRID, "y: boxTop - (row + 1) * cellHeight - row * gutter, width: cellWidth", "y: boxTop - (row + 1) * cellHeight, width: cellWidth", "cuadricula: filas pegadas (sin gutter vertical)"),
    ("G12", GRID, "const margin = Math.max(0, Math.min(options.margin, Math.min(pageWidth, pageHeight) / 4));", "const margin = options.margin;", "margen sin acotar"),
    ("G13", GRID, "return orientation === \"landscape\" ? { width: long, height: short } : { width: short, height: long };", "return orientation === \"landscape\" ? { width: short, height: long } : { width: long, height: short };", "orientacion: horizontal y vertical intercambiadas"),
    ("G14", GRID, "const first = sheet * perPage;", "const first = sheet * perPage + 1;", "rango de la hoja: empieza una foto tarde"),
    ("G15", GRID, "return count <= 0 ? 0 : Math.ceil(count / perPage);", "return count <= 0 ? 0 : Math.floor(count / perPage);", "numero de hojas: la ultima hoja incompleta se pierde"),
    ("G16", GRID, "const row = Math.floor(position / cols);", "const row = Math.ceil(position / cols);", "cuadricula: fila de cada foto"),
    ("G17", GRID, "const firstY = boxTop - outer - firstHeight;", "const firstY = boxTop - firstHeight;", "modo 2: sin espacio libre encima de la primera foto"),
    ("G18", GRID, "const x = boxX + (boxWidth - width) / 2;", "const x = boxX;", "modo 2: las fotos no se centran"),
    ("G19", GRID, "const column = position % cols;", "const column = 0;", "cuadricula: todas en la primera columna"),
    ("G20", GRID, "if (options.perPage === 1) {", "if (options.perPage === 99) {", "1 por hoja: ya no es una sola celda"),
]

TESTS = ["npx", "vitest", "run", "--project", "engines", "src/lib/pdf/photoGrid.test.ts"]


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
