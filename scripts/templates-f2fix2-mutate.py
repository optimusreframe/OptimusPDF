#!/usr/bin/env python3
"""
Mutaciones de las CORRECCIONES F2 de la 2ª ronda (F2-fix2): aplica de una en una cambios pequenos a
  - `templateSession.ts` (firmas del firmante que se queda: `restampKeptSigners`; ids por rol: `reuseFieldIdsByRole`;
    reemplazo del documento al aplicar lo guardado: `replaceDocument`; firmantes que otro documento usa; trabajo con solo
    iniciales: `signerWork`),
  - `useTemplateController.ts` (aplicar lo guardado, anuncio del firmante que se queda),
  - `TemplateNotices.tsx` y `Sheet.tsx` (fondo `inert`, nota del firmante que se queda),
  - `SignToolClient.tsx` (todos los archivos con la plantilla desactualizada)
y comprueba que las pruebas fallan. Una mutacion que NO hace fallar ninguna prueba «sobrevive» e indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/templates-f2fix2-mutate.py            # todas
    python3 scripts/templates-f2fix2-mutate.py R01 H02    # solo esas

Los archivos se restauran siempre al terminar. No toca git. Cada mutacion reemplaza la aparicion `nth` (1 = la primera) de su texto.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = "src/app/sign-pdf/"
SESSION = APP + "templateSession.ts"
CONTROLLER = APP + "useTemplateController.ts"
NOTICES = APP + "TemplateNotices.tsx"
CLIENT = APP + "SignToolClient.tsx"
SHEET = "src/components/ui/Sheet.tsx"

T_SESSION = APP + "templateSession.test.ts"
T_CONTROLLER = APP + "useTemplateController.test.tsx"
T_NOTICES = APP + "TemplateNotices.test.tsx"
T_SHEET = "src/components/ui/Sheet.test.tsx"
T_CLIENT = APP + "SignToolClient.templates.test.tsx"

# (id, archivo, texto original, texto mutado, nth, pruebas, descripcion)
MUTATIONS = [
    # --- F4: el trabajo con solo iniciales / solo firma cuenta ---
    ("W01", SESSION, "block.signerId === signer.id && (block.signature !== null || block.initials !== null)", "block.signerId === signer.id && (block.signature !== null)", 1, [T_SESSION], "signerWork: los trazos de solo iniciales no cuentan (el mutante que sobrevivio a la 1ª ronda)"),
    ("W02", SESSION, "block.signerId === signer.id && (block.signature !== null || block.initials !== null)", "block.signerId === signer.id && (block.initials !== null)", 1, [T_SESSION], "signerWork: los trazos de solo firma no cuentan"),
    # --- F1: las firmas del que se queda sobreviven ---
    ("R01", SESSION, "const renewed = captureStamp(key, newFields, block.signerId);", "const renewed = stored;", 1, [T_SESSION, T_CONTROLLER], "el sello del firmante que se queda no se rehace (su firma caduca al cambiar de variante)"),
    ("R02", SESSION, "    if (stored !== captureStamp(key, oldFields, block.signerId)) return block;\n", "", 1, [T_SESSION], "una firma que YA habia caducado se revalida al cambiar de variante"),
    ("R03", SESSION, 'const key = stored.split("~")[0];', 'const key = "otra-huella";', 1, [T_SESSION], "el sello rehecho cambia la huella del documento (taparia que el texto cambio)"),
    ("R04", SESSION, "return renewed === stored ? block : { ...block, stamps: { ...block.stamps, [docId]: renewed } };", "return { ...block, stamps: { ...block.stamps, [docId]: renewed, otro: renewed } };", 1, [T_SESSION], "el sello rehecho toca los sellos de otros documentos del bloque"),
    ("R05", SESSION, "blocks: restampKeptSigners({ before: session, docId, nextSigners: signers, nextDoc, blocks: ensureBlocks(signers, docOrder, session.signMode, session.blocks) }),", "blocks: ensureBlocks(signers, docOrder, session.signMode, session.blocks),", 1, [T_SESSION, T_CONTROLLER], "aplicar la plantilla no rehace los sellos del firmante que se queda"),
    ("R06", SESSION, "blocks: restampKeptSigners({ before: session, docId, nextSigners: signers, nextDoc, blocks: ensureBlocks(signers, docOrder, session.signMode, session.blocks) }),", "blocks: ensureBlocks(signers, docOrder, session.signMode, session.blocks),", 2, [T_SESSION, T_CONTROLLER], "aplicar el automapeo no rehace los sellos del firmante que se queda"),
    ("R07", SESSION, "const index = pool.findIndex((old) => old.signerId === field.signerId && old.pageIndex === field.pageIndex && old.type === field.type);", "const index = -1;", 1, [T_SESSION], "el hueco que cambia de tamano pierde su id (identidad firmante + pagina + tipo)"),
    ("R08", SESSION, "old.signerId === field.signerId && old.pageIndex === field.pageIndex && old.type === field.type);", "old.signerId === field.signerId && old.pageIndex === field.pageIndex);", 1, [T_SESSION], "los ids por rol cruzan tipos (una firma toma el id de unas iniciales)"),
    ("R09", SESSION, "reuseFieldIdsByRole(rest.previousFields, reuseFieldIds(rest.previousFields, result.fields))", "reuseFieldIds(rest.previousFields, result.fields)", 1, [T_SESSION], "plantilla: sin ids estables por rol"),
    ("R10", SESSION, "reuseFieldIdsByRole(rest.previousFields, reuseFieldIds(rest.previousFields, fields))", "reuseFieldIds(rest.previousFields, fields)", 1, [T_SESSION], "automapeo: sin ids estables por rol"),
    # --- F2: aplicar lo guardado sobre un documento con trabajo no duplica ---
    ("D01", SESSION, "input.replaceDocument ? { signerIds: new Set(roleSigners.map((signer) => signer.id)) } : undefined", "undefined", 1, [T_SESSION, T_CONTROLLER], "aplicar lo guardado sin registro previo duplica los campos"),
    ("D02", SESSION, 'for (const field of doc.textFields) if (field.source === "manual") textIds.add(field.id);', "for (const field of doc.textFields) textIds.add(field.id);", 1, [T_SESSION], "el reemplazo se lleva por delante los campos de la deteccion automatica (AcroForm)"),
    ("D03", SESSION, "if (replace.signerIds.has(field.signerId)) fieldIds.add(field.id);", "fieldIds.add(field.id);", 1, [T_SESSION], "el reemplazo se lleva por delante los huecos de firmantes que la plantilla no cubre"),
    ("D04", CONTROLLER, "undefined, true, false, true);", "undefined, true, false, false);", 1, [T_CONTROLLER], "«Firmar este documento» tras guardar no reemplaza lo que ya habia"),
    ("D05", CONTROLLER, "applyTemplateNow(file, pending.lookup, pending.count, true, true, pending.replaceDocument === true)", "applyTemplateNow(file, pending.lookup, pending.count, true, true, false)", 1, [T_CONTROLLER], "confirmar «Quitar y cambiar» tras guardar desde el editor vuelve a duplicar los campos"),
    ("D06", CONTROLLER, "confirm: { count, loss: stopped, lookup, ...(replaceDocument ? { replaceDocument: true } : {}) }", "confirm: { count, loss: stopped, lookup }", 1, [T_CONTROLLER], "la pregunta no recuerda que se estaba reemplazando el documento"),
    # --- F3: un firmante que otro documento usa no se retira ---
    ("S01", SESSION, "    if (!signerUsedElsewhere(session, docId, signer.id)) return false;\n", "    return false;\n", 1, [T_SESSION, T_CONTROLLER], "bajar a 1 firmante retira al firmante que otro documento usa"),
    ("S02", SESSION, "state.fields.some((field) => field.signerId === signerId)", "state.fields.length > 0", 1, [T_SESSION], "cualquier campo de otro documento (de otro firmante) impide retirar al firmante"),
    ("S03", SESSION, "    ...(kept.length > 0 ? { keptSigners: kept } : {}),\n    before: input.previous?.before ?? { mode: session.mode, signers: session.signers, activeSignerId: session.activeSignerId },\n    pages: distinctPages(fields, textFields),", "    before: input.previous?.before ?? { mode: session.mode, signers: session.signers, activeSignerId: session.activeSignerId },\n    pages: distinctPages(fields, textFields),", 1, [T_SESSION, T_CONTROLLER, T_NOTICES], "la plantilla no anota al firmante que se queda"),
    ("S04", SESSION, "    ...(kept.length > 0 ? { keptSigners: kept } : {}),\n    before: input.previous?.before ?? { mode: session.mode, signers: session.signers, activeSignerId: session.activeSignerId },\n    pages: distinctPages(reusedFields, reusedText),", "    before: input.previous?.before ?? { mode: session.mode, signers: session.signers, activeSignerId: session.activeSignerId },\n    pages: distinctPages(reusedFields, reusedText),", 1, [T_SESSION], "el automapeo no anota al firmante que se queda"),
    ("S05", CONTROLLER, "say(kept && kept.length > 0 ?", "say(false ?", 1, [T_CONTROLLER], "el firmante que se queda no se anuncia"),
    ("S06", NOTICES, 'record.keptSigners && record.keptSigners.length > 0 ? <p className="mt-1 text-footnote text-muted-foreground" data-template-kept="">{t.keptSigners(record.keptSigners)}</p> : null', "null", 1, [T_NOTICES], "el aviso no dice que un firmante se queda"),
    # --- OBS: fondo inerte ---
    ("H01", NOTICES, "      closeLabel={t.changeClose}\n      inertBackground\n    />", "      closeLabel={t.changeClose}\n    />", 1, [T_NOTICES], "la hoja de confirmacion no aisla el fondo"),
    ("H02", SHEET, "if (!inertBackground || !isPresent || !rootRef.current) return;", "if (!isPresent || !rootRef.current) return;", 1, [T_SHEET], "todas las hojas dejan el fondo inert (sin la opcion)"),
    ("H03", SHEET, "      if (hold.count > 0) continue;\n", "", 1, [T_SHEET], "con hojas apiladas el fondo se destapa al cerrar la primera"),
    ("H04", SHEET, '      if (!hold.wasInert) element.removeAttribute("inert");', '      element.removeAttribute("inert");', 1, [T_SHEET], "se destapa lo que ya era inert por otro motivo"),
    ("H05", SHEET, "if (element === except ||", "if (", 1, [T_SHEET], "la propia hoja queda inert"),
    ("H06", SHEET, "  }, [inertBackground, isPresent]);", "  }, []);", 1, [T_SHEET], "el fondo no se destapa al cerrar la hoja (limpieza solo al desmontar)"),
    # --- todos los archivos desactualizados ---
    ("A01", CLIENT, "[...current.filter((name) => name !== fileName && loaded.has(name)), fileName]", "[fileName]", 1, [T_CLIENT], "con varios archivos desactualizados gana el ultimo"),
    ("A02", CLIENT, "[...current.filter((name) => name !== fileName && loaded.has(name)), fileName]", "[...current, fileName]", 1, [T_CLIENT], "el mismo archivo se anota dos veces"),
]

BROKEN_MARKERS = ("Transform failed", "SyntaxError", "ParseError", "Unexpected token", "Failed to parse source")


def run_tests(files) -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive). Si el codigo mutado ni compila, esa mutacion no vale."""
    result = subprocess.run(["npx", "vitest", "run", *files, "--bail", "1"], cwd=ROOT, capture_output=True, text=True)
    output = result.stdout + result.stderr
    if result.returncode != 0 and any(marker in output for marker in BROKEN_MARKERS):
        raise RuntimeError("la mutacion no compila (no cuenta como muerta)")
    return result.returncode == 0


def replace_nth(text: str, old: str, new: str, nth: int):
    start = -1
    for _ in range(nth):
        start = text.find(old, start + 1)
        if start < 0:
            return None
    return text[:start] + new + text[start + len(old):]


def main() -> int:
    wanted = set(sys.argv[1:])
    selected = [m for m in MUTATIONS if not wanted or m[0] in wanted]
    every = sorted({file for m in selected for file in m[5]})
    if not run_tests(every):
        print("Las pruebas ya fallan sin mutar: arreglalas antes.")
        return 2
    survivors = []
    for mutation_id, file, old, new, nth, tests, description in selected:
        path = ROOT / file
        original = path.read_text(encoding="utf8")
        mutated = replace_nth(original, old, new, nth)
        if mutated is None:
            print(f"{mutation_id}: NO APLICA (texto original no encontrado) - {description}")
            survivors.append(mutation_id)
            continue
        started = time.time()
        try:
            path.write_text(mutated, encoding="utf8")
            alive = run_tests(tests)
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
