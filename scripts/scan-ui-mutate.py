#!/usr/bin/env python3
"""
Mutaciones de la interfaz del Escaner (unidad E2): aplica de una en una cambios pequenos a la logica (historial, mover/duplicar,
geometria de la cuadricula, sensor de arrastre, guarda de salida, lectura de la URL, guardado y estados) y comprueba que las
pruebas de Vitest fallan. Una mutacion que NO hace fallar ninguna prueba «sobrevive» y senala una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/scan-ui-mutate.py            # todas
    python3 scripts/scan-ui-mutate.py M07 M12    # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = "src/app/scan-to-pdf/"
STATE = DIR + "scanState.ts"
LAYOUT = DIR + "gridLayout.ts"
DRAG = DIR + "gridDrag.ts"
LEAVE = DIR + "useScanLeaveGuard.ts"
URL = DIR + "scanUrl.ts"
PREFS = DIR + "scanPrefs.ts"
SESSION = DIR + "useScanSession.ts"
GRID = DIR + "PageGrid.tsx"
REVIEW = DIR + "ReviewScreen.tsx"
STORE = "src/lib/scan/testing/fakeStore.ts"
ENGINE = "src/lib/scan/testing/fakeEngine.ts"

T_STATE = [DIR + "scanState.test.ts"]
T_LAYOUT = [DIR + "gridLayout.test.ts"]
T_DRAG = [DIR + "gridDrag.test.tsx"]
T_LEAVE = [DIR + "useScanLeaveGuard.test.tsx"]
T_URL = [DIR + "scanUrl.test.tsx"]
T_PIECES = [DIR + "pieces.test.tsx"]
T_CLIENT = [DIR + "ScanToPdfClient.test.tsx"]
T_FAKES = ["src/lib/scan/testing/fakes.test.ts"]

# (id, archivo, texto original, texto mutado, descripcion, pruebas que deben matarla). El original debe aparecer.
MUTATIONS = [
    ("M01", STATE, "const at = clamped - before;", "const at = clamped;", "mover: el hueco no descuenta las paginas movidas que estaban antes", T_STATE),
    ("M02", STATE, "if (target < 0 || target >= result.length || set.has(result[target].id)) continue;", "if (target < 0 || target >= result.length) continue;", "mover con teclado: un grupo no se salta a si mismo", T_STATE),
    ("M03", STATE, "      delete flags.duplicateOf;\n      out.push({ ...page, id: makeId(), flags });", "      out.push({ ...page, id: makeId(), flags });", "duplicar: la copia no hereda «repetida»", T_STATE),
    ("M04", STATE, "export const COALESCE_MS = 2000;", "export const COALESCE_MS = 0;", "historial: las flechas seguidas son UN paso de deshacer", T_STATE),
    ("M05", STATE, "export const HISTORY_LIMIT = 60;", "export const HISTORY_LIMIT = 6000;", "historial: tope de pasos", T_STATE),
    ("M06", STATE, "        ...mapEverywhere(state, next),\n        pendingIds: state.pendingIds.filter((id) => id !== action.id),", "        pages: state.pages.map(next),\n        pendingIds: state.pendingIds.filter((id) => id !== action.id),", "resolver una pagina reservada tambien en el historial", T_STATE),
    ("M07", STATE, "page.id === action.id && renderKeyOf(page) === action.key ? {", "page.id === action.id ? {", "un recalculo viejo no pisa uno nuevo (clave de renderizado)", T_STATE),
    ("M08", STATE, "return `${title} · ${suggested?.date ?? day}`;", "return `${title} · ${day}`;", "nombre: la fecha del titulo reconocido", T_STATE),
    ("M09", STATE, ".slice(0, 120);", ".slice(0, 1200);", "nombre de archivo: largo maximo", T_STATE),
    ("M10", STATE, "const turn = (((Math.round(value / 90) * 90) % 360) + 360) % 360;", "const turn = (Math.round(value / 90) * 90) % 360;", "girar: el giro negativo vuelve a 0..270", T_STATE),
    ("M11", STATE, "if (flags.blank) found.push(\"blank\");", "if (flags.blank) found.push(\"duplicate\");", "avisos: «en blanco» no es «repetida»", T_STATE),
    ("M12", STATE, "    delete flags.noDocument;\n    return { ...page, corners, flags };", "    return { ...page, corners, flags };", "recorte manual: quita «Sin documento»", T_STATE),
    ("M13", STATE, "future: [{ pages: state.pages, label: entry.label }, ...state.future],", "future: state.future,", "deshacer: se puede rehacer", T_STATE),
    ("M14", STATE, "return { ...state, pages: action.pages, past, future: [], pendingIds, rev: state.rev + 1 };", "return { ...state, pages: action.pages, past, future: state.future, pendingIds, rev: state.rev + 1 };", "una operacion nueva borra el futuro de rehacer", T_STATE),
    ("M15", LAYOUT, "const cols = Math.max(2, Math.floor((usable + gap) / (minTile + gap)));", "const cols = Math.max(1, Math.floor((usable + gap) / (minTile + gap)));", "cuadricula: minimo de 2 columnas en un telefono", T_LAYOUT),
    ("M16", LAYOUT, "const after = within > layout.tileW / 2 ? 1 : 0;", "const after = within > layout.tileW ? 1 : 0;", "arrastre: la mitad derecha de una tarjeta es «despues»", T_LAYOUT),
    ("M17", LAYOUT, "Math.floor(top / layout.rowH) - overscan));", "Math.floor(top / layout.rowH)));", "virtualizacion: margen de filas por encima", T_LAYOUT),
    ("M18", LAYOUT, "return rows === 0 ? 0 : rows * layout.rowH - layout.gap;", "return rows === 0 ? 0 : rows * layout.rowH;", "cuadricula: alto total sin el hueco final", T_LAYOUT),
    ("M19", DRAG, "const DRAG_THRESHOLD = 5;", "const DRAG_THRESHOLD = 500;", "arrastre: un clic no es un arrastre pero un movimiento si", T_DRAG),
    ("M20", DRAG, "const LONG_PRESS_SLOP = 8;", "const LONG_PRESS_SLOP = 800;", "pulsacion larga: mover antes de tiempo es desplazar", T_DRAG),
    ("M21", DRAG, "if (session?.active && event.cancelable) event.preventDefault();", "if (event.cancelable) event.preventDefault();", "tacto: solo se corta el desplazamiento mientras se arrastra", T_DRAG),
    ("M22", DRAG, "deps.suppressClick.current = true;", "deps.suppressClick.current = false;", "arrastre: el clic que sigue a soltar se descarta", T_DRAG),
    ("M23", DRAG, "if (!session || event.pointerId !== session.pointerId) return;\n    session.client = { x: event.clientX, y: event.clientY };", "if (!session) return;\n    session.client = { x: event.clientX, y: event.clientY };", "arrastre: un segundo dedo no mueve la tarjeta", T_DRAG),
    ("M24", LEAVE, "return pendingWrite || !work.saved;", "return pendingWrite && !work.saved;", "salir: avisa si hay algo pendiente O sin guardar", T_LEAVE),
    ("M25", URL, "const ID = /^[a-z0-9][a-z0-9-]{7,63}$/;", "const ID = /^[a-zA-Z0-9][a-zA-Z0-9-/.]{7,63}$/;", "URL: solo ids con la forma exacta (nada de rutas)", T_URL),
    ("M26", URL, "if (values.length > 1) return { present: true, id: null };", "", "URL: varios valores a la vez no restauran nada", T_URL),
    ("M27", STORE, "export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;", "export const SESSION_TTL_MS = 140 * 24 * 60 * 60 * 1000;", "almacen: expiracion a los 14 dias", T_FAKES),
    ("M28", PREFS, "if (typeof value.mode === \"string\" && (MODES as string[]).includes(value.mode)) out.mode = value.mode as ScanMode;", "if (typeof value.mode === \"string\") out.mode = value.mode as ScanMode;", "preferencias: el modo guardado se valida", T_PIECES),
    ("M29", SESSION, "outcome.reason === \"quota\" ? \"quota\" : outcome.reason === \"tooBig\" ? \"tooBig\" : \"unavailable\"", "outcome.reason === \"quota\" ? \"unavailable\" : outcome.reason === \"tooBig\" ? \"tooBig\" : \"unavailable\"", "guardado: el motivo de «no guardado» (cuota)", T_CLIENT),
    ("M30", SESSION, "if (snapshot.pages.length === 0) {\n          await store.remove(snapshot.id);", "if (false) {\n          await store.remove(snapshot.id);", "guardado: una sesion vaciada se borra del almacen", T_CLIENT),
    ("M31", ENGINE, "if (tokens.includes(\"fail\")) throw new Error(\"fake-create-failed\");", "", "doble de prueba: `fail` rechaza", T_FAKES),
    ("M32", GRID, "export const VIRTUALIZE_FROM = 30;", "export const VIRTUALIZE_FROM = 3000;", "cuadricula: virtualiza con muchas paginas", T_PIECES),
]


def run_tests(tests) -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive)."""
    result = subprocess.run(
        ["npx", "vitest", "run", *tests],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def main() -> int:
    wanted = set(sys.argv[1:])
    selected = [m for m in MUTATIONS if not wanted or m[0] in wanted]
    baseline = sorted({t for m in selected for t in m[5]})
    if not run_tests(baseline):
        print("Las pruebas ya fallan sin mutar: arreglalas antes.")
        return 2
    survivors = []
    for mutation_id, file, old, new, description, tests in selected:
        path = ROOT / file
        original = path.read_text(encoding="utf8")
        if old not in original:
            print(f"{mutation_id}: NO APLICA (texto original no encontrado) - {description}")
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
