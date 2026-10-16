#!/usr/bin/env python3
"""
Mutaciones de la INTERFAZ de plantillas (U2.3 + U2.4): aplica de una en una cambios pequenos a la logica del editor
(historial, iniciales en todas las paginas, variantes, sugerencias), de la aplicacion a un documento (documento limpio,
firmantes, reutilizar ids, deshacer, aceptar), del controlador (restaurado, limpio, modo, nº de firmantes, sugerencias) y de la
biblioteca (validar antes de guardar, no dejar huerfanos, no duplicar) y comprueba que las pruebas fallan. Una mutacion que
NO hace fallar ninguna prueba «sobrevive» e indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/templates-ui-mutate.py            # todas
    python3 scripts/templates-ui-mutate.py M01 C02    # solo esas

Mutaciones EQUIVALENTES que se retiraron (no cambian el resultado): «igualar» en la pagina 0 (no hay pagina -1) y comprobar el
«limpio» antes y dentro de la escritura (se deja solo el de dentro); validar antes de guardar el PDF (la restauracion de un PDF
huerfano ya lo cubre, `L02`).

Los archivos se restauran siempre al terminar. No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = "src/app/sign-pdf/"
MODEL = APP + "templateEditorModel.ts"
SESSION = APP + "templateSession.ts"
CONTROLLER = APP + "useTemplateController.ts"
LIBRARY = APP + "templateLibrary.ts"
EDITOR = APP + "TemplateEditor.tsx"
NOTICES = APP + "TemplateNotices.tsx"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    # --- modelo del editor ---
    ("M01", MODEL, "history.lastKey === key && now - history.lastAt <= COALESCE_MS", "now - history.lastAt <= COALESCE_MS", "historial: un arrastre solo se funde con el MISMO campo"),
    ("M02", MODEL, "if (past.length > HISTORY_LIMIT) past.shift();", "if (past.length > HISTORY_LIMIT + 50) past.shift();", "historial: tope de pasos"),
    ("M03", MODEL, "return changed.length === 1 ? `edit:${changed[0]}` : null;", "return changed.length >= 1 ? `edit:${changed[0]}` : null;", "arrastre: varios campos no son un arrastre"),
    ("M04", MODEL, "return own.length === 0 ? null : union(own.map((field) => field.rect));", "return own.length === 0 ? null : own[0].rect;", "linea de iniciales: union de las dos mitades"),
    ("M05", MODEL, 'const toPage = options.toPage ?? "all";', 'const toPage = "all";', "repetir: el rango «N a M» se respeta"),
    ("M07", MODEL, "pageIndex === page - 1 && field.roleIndex < signers", "pageIndex === page + 1 && field.roleIndex < signers", "igualar: es la pagina ANTERIOR"),
    ("M08", MODEL, '    if (field.type === "initials") continue;\n    if (field.roleIndex >= signersOf(to)) continue;', "    if (field.roleIndex >= signersOf(to)) continue;", "copiar variante: las iniciales se reparten, no se copian tal cual"),
    ("M09", MODEL, "fields.push(takeOwnership({ ...base, id: slot.id", "fields.push(({ ...base, id: slot.id", "mover un campo automatico lo hace manual"),
    ("M10", MODEL, 'if (type === "date" && old.type !== "date" && next.rule === undefined && next.dataKey === undefined) {', "if (false) {", "un campo que pasa a «fecha» estrena la regla hoy"),
    ("M11", MODEL, "filter((f) => !f.needsReview)", "filter((f) => f.needsReview)", "detectar: solo lo seguro se coloca solo"),
    ("M12", MODEL, "    delete value.needsReview;\n    value.id = value.id && !taken.has(value.id) ? value.id : mint.sign();", "    value.id = value.id && !taken.has(value.id) ? value.id : mint.sign();", "aceptar: la sugerencia deja de estar «a revisar»"),
    ("M14", MODEL, "if (!field.id || !ID_PATTERN.test(field.id) || seen.has(field.id)) field.id = mint.sign();", "if (!field.id || seen.has(field.id)) field.id = mint.sign();", "ids de campos validos (la biblioteca los exige)"),
    # --- aplicar a un documento ---
    ("S01", SESSION, '  if (doc.textFields.some((field) => field.source === "manual")) return false;', "", "limpio: un campo de texto a mano es trabajo"),
    ("S02", SESSION, "  if (session.blocks.some((block) => block.appliesTo.includes(docId) && (block.signature !== null || block.initials !== null))) return false;", "", "limpio: un trazo recogido es trabajo"),
    ("S03", SESSION, "while (signers.length < count) {", "while (signers.length <= count) {", "solo se crean los firmantes que faltan"),
    ("S04", SESSION, "index < count || !input.previous?.createdSignerIds.includes(signer.id)", "true", "bajar a 1 firmante retira el que creo la plantilla"),
    ("S05", SESSION, "old.signerId === field.signerId && old.pageIndex === field.pageIndex", "old.pageIndex === field.pageIndex", "reutilizar id: mismo firmante"),
    ("S06", SESSION, "  if (want === 2 && !options.support.two) return 1;", "", "sin variante de 2 se usa 1 firmante"),
    ("S07", SESSION, "const restoreMode = !touchedOtherDocs && signersChanged && keepSigners.length === 0 ? record.before.mode : session.mode;", "const restoreMode = session.mode;", "deshacer devuelve «Solo yo»"),
    ("S08", SESSION, "  if (item.pageIndex === null) return null;", "", "una sugerencia sin pagina equivalente no se puede aceptar"),
    ("S09", SESSION, "return keys.length === Object.keys(current).length && keys.every", "return keys.every", "plantilla intacta: tambien cuenta lo que se anadio"),
    ("S10", SESSION, 'field.tier === "high" && field.signerIndex === 1 &&', 'field.tier === "high" && field.signerIndex === 0 &&', "automapeo: 2 firmantes solo si hay un firmante 2 seguro"),
    ("S11", SESSION, "        if (field.tier === \"review\") {\n          pending.push", "        if (field.tier !== \"ignore\") {\n          pending.push", "firma sin firmante claro: solo si es de revision"),
    # --- controlador ---
    ("C01", CONTROLLER, "        if (isRestored(file)) continue;", "", "un archivo restaurado manda: no se le aplica nada"),
    ("C03", CONTROLLER, "        if (!force && !isPristine(current, docId)) return {};\n        const plan = planTemplateApplication", "        const plan = planTemplateApplication", "no se aplica sobre un documento ya trabajado (al escribir)"),
    ("C04", CONTROLLER, '        if (bridge.read().session.mode !== "multi") {\n          // Con «Solo yo»', '        if (false) {\n          // Con «Solo yo»', "en «Solo yo» un documento desconocido espera"),
    ("C05", CONTROLLER, "          if (length === notice.signerCount) continue;", "", "cambiar el nº de firmantes re-aplica la variante"),
    ("C06", CONTROLLER, 'item.kind === "sign" && item.signerIndex === undefined)).map', "false)).map", "«Añadir todas» no añade firmas sin firmante claro"),
    ("C07", CONTROLLER, 'if (lookup && (lookup.level === "exact" || lookup.level === "match")) {', 'if (lookup && (lookup.level === "exact" || lookup.level === "match" || lookup.level === "similar")) {', "«Parece» pregunta, no aplica sola"),
    ("C08", CONTROLLER, "if (count !== analysed && result.fields.length > 0) result", "if (count !== analysed) result", "no se vuelve a mapear sin campos"),
    ("C09", CONTROLLER, "      bridge.commit((current) => planUndo(current, docId, record));\n", "", "deshacer escribe en la sesion"),
    # --- biblioteca ---
    ("L02", LIBRARY, "      if (createdDocument) await deleteDocument(document.id).catch(() => false);", "", "no dejar un PDF huerfano si falla la plantilla"),
    ("L03", LIBRARY, "documents.find((entry) => entry.fingerprint.exact === fingerprint.exact) ?? null", "null", "el mismo PDF no se duplica"),
    ("L04", LIBRARY, '.filter((field) => field.source !== "heuristic-vector" && field.source !== "heuristic-raster")', "", "no se guardan las sugerencias heuristicas"),
    ("L05", LIBRARY, "    if (isDecryptedCopy(input.file)) return { ok: false, reason: \"encrypted\" };", "", "una copia descifrada nunca se guarda"),
    # --- editor y avisos ---
    ("E01", EDITOR, "    if (!hasSignFields(content)) {", "    if (false) {", "no se guarda una plantilla sin firmas ni iniciales"),
    ("E02", EDITOR, "    if (dirty) setLeaveOpen(true);", "    if (false) setLeaveOpen(true);", "cerrar con cambios pregunta"),
    ("E03", EDITOR, 'disabled={pageCount === 0} onClick={() => repeat(0, "all")}', 'onClick={() => repeat(0, "all")}', "repetir espera a conocer las paginas"),
    ("E04", NOTICES, "item.pageIndex === null ? (", "false ? (", "sugerencia sin pagina: no se ofrece añadirla"),
]

TEST_ARGS = [
    "npx",
    "vitest",
    "run",
    APP + "templateEditorModel.test.ts",
    APP + "templateSession.test.ts",
    APP + "templateLibrary.test.ts",
    APP + "useTemplateController.test.tsx",
    APP + "TemplateEditor.test.tsx",
    APP + "TemplateNotices.test.tsx",
    APP + "SignToolClient.templates.test.tsx",
    "--bail",
    "1",
]

BROKEN_MARKERS = ("Transform failed", "SyntaxError", "ParseError", "Unexpected token", "Failed to parse source")


def run_tests() -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive). Si el codigo mutado ni compila, esa mutacion no vale."""
    result = subprocess.run(TEST_ARGS, cwd=ROOT, capture_output=True, text=True)
    output = result.stdout + result.stderr
    if result.returncode != 0 and any(marker in output for marker in BROKEN_MARKERS):
        raise RuntimeError("la mutacion no compila (no cuenta como muerta)")
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
        except RuntimeError as error:
            print(f"{mutation_id}: ERROR      {error} - {description}", flush=True)
            survivors.append(mutation_id)
            continue
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
