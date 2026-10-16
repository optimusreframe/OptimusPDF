#!/usr/bin/env python3
"""
Mutaciones de las CORRECCIONES F2 (F2-fix, tras la verificacion independiente): aplica de una en una cambios pequenos a
  - lo que un cambio de firmantes / «Deshacer» quitaria (`templateSession.ts`: perdida de trabajo, `planUndo`),
  - el controlador (`useTemplateController.ts`: pedir confirmacion, traspaso con plantilla desactualizada, tope de campos),
  - el almacen (`store.ts`, `templatesStore.ts`, `schema.ts`, `templateStale.ts`: aviso «desactualizada» persistido),
  - la biblioteca de plantillas (`templateLibrary.ts`: la otra variante, «documento nuevo»),
  - la interfaz (`TemplateNotices.tsx`, `TemplateEditor.tsx`, `documentsModel.ts`, `DocumentCard.tsx`)
y comprueba que las pruebas fallan. Una mutacion que NO hace fallar ninguna prueba «sobrevive» e indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/templates-f2fix-mutate.py            # todas
    python3 scripts/templates-f2fix-mutate.py F01 S02    # solo esas

Los archivos se restauran siempre al terminar. No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = "src/app/sign-pdf/"
LIB = "src/lib/docLibrary/"
DOCS = "src/app/documents/"
SESSION = APP + "templateSession.ts"
CONTROLLER = APP + "useTemplateController.ts"
LIBRARY = APP + "templateLibrary.ts"
NOTICES = APP + "TemplateNotices.tsx"
EDITOR = APP + "TemplateEditor.tsx"
STORE = LIB + "store.ts"
TSTORE = LIB + "templatesStore.ts"
SCHEMA = LIB + "schema.ts"
STALE = LIB + "templateStale.ts"
MODEL = DOCS + "documentsModel.ts"
CARD = DOCS + "DocumentCard.tsx"
ACTIONS = DOCS + "documentActions.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    # --- perdida de trabajo (puro) ---
    ("F01", SESSION, "    const work = signerWork(args.session, signer, args.previous);\n    if (work.strokes || work.typed)", "    const work = signerWork(args.session, signer, args.previous);\n    if (work.typed)", "cambio de firmantes: los trazos del firmante que se quita SI cuentan como trabajo"),
    ("F02", SESSION, '  const typed = name !== "" && name !== (record?.createdNames?.[signer.id] ?? "").trim();', "  const typed = false;", "un nombre real escrito es trabajo"),
    ("F03", SESSION, '    if (known.has(id) && !kept.has(id) && value.trim() !== "") count += 1;', "    if (known.has(id) && !kept.has(id)) count += 1;", "un valor VACIO no es trabajo"),
    ("F04", SESSION, "        const work = signerWork(session, signer, record);\n        return work.strokes || work.typed;", "        return false;", "Deshacer no quita un firmante con trazos o nombre escrito"),
    ("F05", SESSION, '  for (const id of textIds) if ((textValues[id] ?? "").trim() === "") delete textValues[id];', "  for (const id of textIds) delete textValues[id];", "Deshacer no borra valores escritos"),
    ("F06", SESSION, "    const fresh = created.includes(id) ? signers.find((signer) => signer.id === id)?.name : undefined;", "    const fresh = undefined as string | undefined;", "se recuerda el nombre con que nacio cada firmante creado (el generico no es trabajo)"),
    ("F07", SESSION, "  if (otherDocsTouched(session, docId)) return { signers: [], values };\n", "", "undoWork: con otros documentos tocados los firmantes no se retiran"),
    ("F08", SESSION, "  return loss.signers.length > 0 || loss.values > 0;", "  return loss.signers.length > 0;", "hasLoss cuenta los valores"),
    # --- controlador ---
    ("C01", CONTROLLER, "          documentId: lookup.documentId,\n        });\n        if (!allowLoss && hasLoss(plan.loss)) {", "          documentId: lookup.documentId,\n        });\n        if (false) {", "re-aplicar la plantilla pide confirmar antes de quitar trabajo"),
    ("C02", CONTROLLER, "              previous,\n            });\n            if (!allowLoss && hasLoss(plan.loss)) {", "              previous,\n            });\n            if (false) {", "re-aplicar el automapeo pide confirmar antes de quitar trabajo"),
    ("C03", CONTROLLER, "      if (hasLoss(work)) {\n        say(latest.current.strings.template.undoBlockedAnnounce);", "      if (false) {\n        say(latest.current.strings.template.undoBlockedAnnounce);", "Deshacer no actua si ya hay trabajo de la persona"),
    ("C04", CONTROLLER, "applyTemplateNow(file, pending.lookup, pending.count, true, true)", "applyTemplateNow(file, pending.lookup, pending.count, true, false)", "«Quitar y cambiar» hace el cambio"),
    ("C05", CONTROLLER, "} else if (entry && template && entry.templateStale) {", "} else if (false) {", "plantilla desactualizada: se compara el PDF real"),
    ("C06", CONTROLLER, "if (entry && template && !entry.templateStale) {", "if (entry && template) {", "plantilla desactualizada: no se asume «exacto»"),
    ("C07", CONTROLLER, "                options.onStaleSkipped?.(file.name);", "", "se avisa de que la plantilla desactualizada no se aplico"),
    ("C08", CONTROLLER, '          cap: result.warnings.some((warning) => warning.code === "document-field-cap")', '          cap: result.warnings.some((warning) => warning.code === "page-field-cap")', "el tope por documento llega a la interfaz"),
    ("C09", CONTROLLER, "keepOtherVariant: true", "keepOtherVariant: false", "guardar lo mapeado conserva la otra variante"),
    ("C10", CONTROLLER, "      if (!notice || notice.count === count || notice.busy || notice.confirm) return;", "      if (!notice || notice.count === count || notice.busy) return;", "con la pregunta abierta, el segmento no hace nada"),
    ("C11", CONTROLLER, "filter((page) => !page.hasInitialsLine)", "filter((page) => page.hasInitialsLine)", "las paginas sin cubrir son las SIN iniciales"),
    # --- almacen ---
    ("S01", STORE, "      const base = previousStale?.base ?? existing.fingerprint;", "      const base = existing.fingerprint;", "se compara con el PDF sobre el que se configuro la plantilla"),
    ("S02", STORE, "    if (existing.templateIds.length > 0) {\n      const base", "    if (true) {\n      const base", "un documento sin plantilla nunca queda desactualizado"),
    ("S03", STORE, "since: previousStale?.since ?? now,", "since: now,", "la fecha del aviso es la primera vez"),
    ("S04", STORE, "    if (!existing.templateStale) return { entry: existing, written: false };\n", "", "«sigue valiendo» sin aviso no escribe"),
    ("S05", STORE, "    const templateStale = input.templateStale ?? existing?.templateStale;", "    const templateStale = input.templateStale;", "actualizar un documento conserva el aviso"),
    ("S06", TSTORE, "document.templateStale?.base ?? document.fingerprint", "document.fingerprint", "el reconocimiento usa la huella sobre la que se configuro"),
    ("S07", TSTORE, "templateIds.length > 0 && templateStale ?", "templateStale ?", "borrar la ultima plantilla quita el aviso"),
    ("S08", SCHEMA, "  if (!isInt(raw.percent, 0, 100)) return null;\n", "", "el aviso guardado se valida (porcentaje)"),
    ("S09", SCHEMA, "const templateStale = raw.templateStale === undefined ? null : parseTemplateStale(raw.templateStale);", "const templateStale = null as ReturnType<typeof parseTemplateStale>;", "el aviso se lee de IndexedDB"),
    ("S10", STALE, '  if (result.level === "exact") return { stale: false };\n', "", "el mismo PDF exacto no queda desactualizado"),
    # --- biblioteca ---
    ("L01", LIBRARY, "if (input.keepOtherVariant && stored && !document.templateStale)", "if (input.keepOtherVariant && stored)", "una plantilla desactualizada no conserva su otra variante"),
    ("L02", LIBRARY, "if (document.templateStale) await markTemplatesCurrent(document.id).catch(() => undefined);", "", "reconfigurar deja la plantilla al dia"),
    ("L03", LIBRARY, "input.asNewDocument ? null : input.documentId ? await getDocument(input.documentId) : null", "input.documentId ? await getDocument(input.documentId) : null", "«documento nuevo» no reutiliza el documento de antes"),
    ("L04", LIBRARY, "    if (isEmptyVariant(variants[key]) && !isEmptyVariant(stored.variants[key])) {", "    if (false) {", "se conserva la variante que no se esta guardando"),
    # --- interfaz ---
    ("U01", NOTICES, "const canUndo = !session || !hasLoss(undoWork(session, notice.docId, record));", "const canUndo = true;", "«Deshacer» no se ofrece con trabajo hecho"),
    ("U02", MODEL, 'return stale && state !== "none" ? "stale" : state;', 'return stale ? "stale" : state;', "sin plantilla (✗) no hay nada desactualizado"),
    ("U03", CARD, "{stale && onKeepTemplate ? (", "{onKeepTemplate ? (", "«sigue valiendo» solo con la plantilla desactualizada"),
    ("U04", EDITOR, '{failure === "conflict" ? (', "{failure !== null ? (", "«documento nuevo» solo tras un conflicto"),
    ("U05", NOTICES, "open={pending !== null}", "open={true}", "la hoja de confirmacion solo se abre con un cambio pendiente"),
    ("U06", ACTIONS, "replaceVerdict(doc.templateStale?.base ?? doc.fingerprint, entry.fingerprint, hasTemplate)", "replaceVerdict(doc.fingerprint, entry.fingerprint, hasTemplate)", "el aviso de reemplazo compara con el PDF de la plantilla"),
]

TEST_ARGS = [
    "npx",
    "vitest",
    "run",
    APP + "templateSession.test.ts",
    APP + "useTemplateController.test.tsx",
    APP + "TemplateNotices.test.tsx",
    APP + "templateLibrary.test.ts",
    APP + "TemplateEditor.test.tsx",
    LIB + "templateStale.test.ts",
    LIB + "store.test.ts",
    LIB + "templatesStore.test.ts",
    "src/components/views/MyDocumentsView.test.tsx",
    DOCS + "MyDocumentsHomeSection.test.tsx",
    DOCS + "documentsModel.test.ts",
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
