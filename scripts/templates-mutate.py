#!/usr/bin/env python3
"""
Mutaciones de las plantillas por documento (U2.2): aplica de una en una cambios pequenos a la logica (disposicion de
iniciales, rangos de paginas, validacion, versiones, concurrencia, aplicacion, estado, migracion y exportacion) y
comprueba que las pruebas de `src/lib/docLibrary/` fallan. Una mutacion que NO hace fallar ninguna prueba «sobrevive» y
indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/templates-mutate.py            # todas
    python3 scripts/templates-mutate.py T01 S02    # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = "src/lib/docLibrary/"
REPEAT = LIB + "templateRepeat.ts"
SCHEMA = LIB + "templateSchema.ts"
TYPES = LIB + "templateTypes.ts"
APPLY = LIB + "templateApply.ts"
AUTO = LIB + "templateAuto.ts"
STORE = LIB + "templatesStore.ts"
LEGACY = LIB + "templateLegacy.ts"
PERSIST = LIB + "persist.ts"
IDB = LIB + "store.ts"
KEYS = LIB + "dataKeys.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    # --- iniciales en todas las paginas (templateRepeat) ---
    ("R01", REPEAT, "export const DEFAULT_INITIALS_GAP = 0.1;", "export const DEFAULT_INITIALS_GAP = 0;", "disposicion: hueco por defecto entre firmantes"),
    ("R02", REPEAT, "const width = (base.width - space) / 2;", "const width = base.width / 2;", "disposicion: las mitades descuentan el hueco"),
    (
        "R03",
        REPEAT,
        "    { x: round(base.x), y: base.y, width: round(width), height: base.height },\n    { x: round(base.x + width + space), y: base.y, width: round(width), height: base.height },",
        "    { x: round(base.x + width + space), y: base.y, width: round(width), height: base.height },\n    { x: round(base.x), y: base.y, width: round(width), height: base.height },",
        "orden: firmante 1 a la izquierda y 2 a la derecha",
    ),
    ("R04", REPEAT, "if (!(gap >= 0 && gap <= 0.5))", "if (!(gap >= 0))", "limite superior del hueco"),
    ("R05", REPEAT, "const x = Math.min(Math.max(rect.x + dx, 0), Math.max(0, 1 - rect.width));", "const x = Math.max(rect.x + dx, 0);", "ajuste fino: no salirse por la derecha"),
    ("R06", REPEAT, "const y = Math.min(Math.max(rect.y + dy, 0), Math.max(0, 1 - rect.height));", "const y = Math.min(rect.y + dy, 1 - rect.height);", "ajuste fino: no salirse por arriba"),
    ("R07", REPEAT, "if (hasExisting && !replace) {", "if (hasExisting && replace) {", "replaceExisting respeta lo que ya hay"),
    ("R08", REPEAT, "field.roleIndex < options.signers", "field.roleIndex <= options.signers", "solo se sustituyen las iniciales de los firmantes que se colocan"),
    ("R09", REPEAT, "if (options.pageCount !== undefined && page >= options.pageCount) {", "if (options.pageCount !== undefined && page > options.pageCount) {", "paginas fuera del documento"),
    ("R10", REPEAT, "for (let page = fromPage; page <= to; page += 1) requested.push(page);", "for (let page = fromPage; page < to; page += 1) requested.push(page);", "rango fromPage..toPage incluye la ultima"),
    ("R11", REPEAT, "for (let page = fromPage; page < count; page += 1) requested.push(page);", "for (let page = fromPage; page < count - 1; page += 1) requested.push(page);", "'all' llega hasta la ultima pagina"),
    ("R12", REPEAT, "!Object.hasOwn(adjust, String(page))", "false", "ajuste: solo propiedades propias"),
    ("R13", REPEAT, "Math.max(rect.x + dx, 0)", "Math.max(rect.x - dx, 0)", "ajuste fino: signo del desplazamiento en x"),
    ("R14", REPEAT, "if (fields.length + variant.textFields.length > TEMPLATE_LIMITS.maxFieldsPerVariant) throw", "if (false) throw", "tope de campos al repetir"),
    # --- validacion (templateSchema / tipos) ---
    ("S01", SCHEMA, "if (!isUnit(x + width) || !isUnit(y + height)) return null;", "if (false) return null;", "rect: debe caber en la pagina"),
    ("S02", TYPES, "export const RECT_EPSILON = 1e-6;", "export const RECT_EPSILON = 0.5;", "rect: tolerancia numerica"),
    ("S03", SCHEMA, "value >= 0 && value <= 1 + RECT_EPSILON", "value >= -1 && value <= 1 + RECT_EPSILON", "rect: sin negativos"),
    ("S04", SCHEMA, "Math.min(roleCount, maxRole + 1) - 1", "roleCount - 1", "la variante «1» solo admite el rol 0"),
    ("S05", SCHEMA, "if (fieldsRaw.length + textRaw.length > TEMPLATE_LIMITS.maxFieldsPerVariant) return null;", "if (fieldsRaw.length + textRaw.length > 5000) return null;", "tope de 500 campos por variante"),
    ("S06", SCHEMA, "return Object.hasOwn(record, key) ? record[key] : undefined;", "return record[key];", "lectura solo de propiedades propias"),
    ("S07", SCHEMA, "if (ids.has(field.id)) return null;", "", "ids repetidos en una variante"),
    ("S08", SCHEMA, "raw.length < 1 || raw.length > 2) return null;", "raw.length < 1 || raw.length > 5) return null;", "como mucho 2 roles"),
    ("S09", SCHEMA, "historyRaw.length > TEMPLATE_LIMITS.maxVersions - 1", "historyRaw.length > 50", "tope del historial guardado"),
    ("S10", SCHEMA, "if (!snapshot || seen.has(snapshot.version) || snapshot.version > template.version) return null;", "if (!snapshot) return null;", "historial: versiones distintas y menores"),
    ("S11", KEYS, "export const DATA_KEY_PATTERN = /^[a-z][A-Za-z0-9_.]{0,39}$/;", "export const DATA_KEY_PATTERN = /^[a-z][A-Za-z0-9_.]{0,99}$/;", "longitud maxima del dataKey"),
    ("S12", SCHEMA, 'if (own(raw, "schemaVersion") !== TEMPLATE_SCHEMA_VERSION) return null;', "", "version de esquema de la fila"),
    # --- aplicar a un documento (templateApply) ---
    ("A01", APPLY, "if (variantHasSignFields(two)) return { key: \"2\", variant: two, warnings };", "if (variantHasSignFields(one)) return { key: \"2\", variant: two, warnings };", "2 firmantes usa la variante «2»"),
    ("A02", APPLY, "two.fields.filter((field) => field.roleIndex === 0)", "two.fields.filter((field) => field.roleIndex === 1)", "respaldo de 1 firmante: los campos del firmante 1"),
    ("A03", APPLY, 'field.dataKey !== "insuredName2"', 'field.dataKey !== "insuredName3"', "respaldo de 1 firmante: sin textos del asegurado 2"),
    ("A04", APPLY, 'if (reviewSet.has(templatePage)) return { documentPage, reason: "pageReview" };', "", "paginas «parecidas» no se aplican solas"),
    ("A05", APPLY, 'if (needsReview) return { documentPage, reason: "needsReview" };', "", "campos a revisar no se aplican solos"),
    ("A06", APPLY, "Number.isInteger(mapped) && mapped >= 0 ? mapped : null;", "Number.isInteger(mapped) && mapped >= -1 ? mapped : null;", "mapa de paginas: valores raros"),
    ("A07", APPLY, 'if (options.pageCount !== undefined && documentPage >= options.pageCount) return { documentPage: null, reason: "outOfRange" };', 'if (options.pageCount !== undefined && documentPage > options.pageCount) return { documentPage: null, reason: "outOfRange" };', "pagina destino fuera de rango"),
    ("A08", APPLY, "if (reviewSet.has(field.pageIndex)) {", "if (false) {", "clonar: marcar para revisar las paginas parecidas"),
    ("A09", APPLY, "if (identity && template.layout)", "if (template.layout)", "clonar: el diseno de iniciales solo con mapa identidad"),
    ("A10", APPLY, 'if (field.label !== "") detected.label = field.label;', "", "formato de Firmar: etiqueta"),
    ("A11", APPLY, 'if (field.type !== "text") detected.type = field.type;', "detected.type = field.type;", "formato de Firmar: el tipo «text» no se escribe"),
    ("A12", APPLY, 'const role = options.roles?.[field.roleIndex]?.signerId ?? template.roles[field.roleIndex]?.key', 'const role = template.roles[field.roleIndex]?.key', "signerId real de cada rol"),
    # --- almacen: versiones, concurrencia, estado (templatesStore / store) ---
    ("T01", STORE, 'if (stored.rev !== expected) throw new LibraryError("conflict");', "", "concurrencia: rev al guardar una version"),
    ("T02", STORE, ".slice(0, TEMPLATE_LIMITS.maxVersions - 1)", ".slice(0, TEMPLATE_LIMITS.maxVersions + 4)", "tope de 5 versiones"),
    ("T03", STORE, "version: stored.version + 1, updatedAt: now, rev: stored.rev + 1, history }", "version: stored.version, updatedAt: now, rev: stored.rev + 1, history }", "editar crea version+1"),
    ("T04", STORE, "if (sameContent(contentOf(stored), contentOf(next))) return { stored, written: false };", "", "guardar sin cambios no escribe"),
    ("T05", STORE, 'if (version === current.version) throw new LibraryError("invalid");', "", "restaurar la version actual"),
    ("T06", STORE, "if (has2 && (has1 || fallback)) return", "if (has2) return", "estado: ready necesita forma de firmar con uno"),
    ("T07", STORE, 'const fallback = !has1 && has2 && template.variants["2"].fields.some((field) => field.roleIndex === 0);', 'const fallback = !has1 && has2;', "estado: respaldo del firmante 1"),
    ("T08", IDB, "await req(templates.put({ ...row, documentId: null, rev: rev + 1, updatedAt: nowIso() }));", "await req(templates.delete(row.id as string));", "borrar documento: sus plantillas quedan sin documento"),
    ("T09", IDB, "const DB_VERSION = 2;", "const DB_VERSION = 1;", "migracion de esquema v1 -> v2"),
    ("T10", IDB, "if (!db.objectStoreNames.contains(TEMPLATES)) {", "if (false) {", "migracion: crear el almacen de plantillas"),
    ("T11", STORE, "forDocument >= TEMPLATE_LIMITS.maxPerDocument", "forDocument > TEMPLATE_LIMITS.maxPerDocument", "tope por documento"),
    ("T12", STORE, 'if (mode === "add" ? has : !has) return;', "", "templateIds sin duplicados"),
    ("T13", STORE, 'if (documentId !== null) await linkDocument(tx, documentId, id, "add");\n    await req(templates.put(checked));', "await req(templates.put(checked));", "crear: enlazar templateIds del documento"),
    ("T14", STORE, "const winner = same[0];", "const winner = same[same.length - 1];", "misma huella: gana la plantilla mas reciente"),
    ("T15", IDB, "await req(tx.objectStore(TEMPLATES).clear());", "", "clearLibrary borra las plantillas"),
    ("T16", STORE, 'if (clash !== undefined && mode === "skip") {', "if (false) {", "importar: conflicto de id con skip"),
    ("T17", STORE, 'if (current.documentId !== null) await linkDocument(tx, current.documentId, id, "remove");', "", "reasignar: quitar del documento anterior"),
    ("T18", STORE, 'if (typeof documentId === "string" && ID_PATTERN.test(documentId)) await linkDocument(tx, documentId, id, "remove");', "", "borrar plantilla: quitar de templateIds"),
    ("T19", STORE, "const history = [snapshotOf(stored), ...stored.history]", "const history = [...stored.history]", "editar conserva la version anterior"),
    # --- migracion de localStorage ---
    ("L01", LEGACY, "if (migrated.has(legacy.legacyId)) {", "if (false) {", "migracion idempotente"),
    ("L02", LEGACY, "const roleCount = Math.min(2, Math.max(1, legacy.signerNames.length, maxIndex + 1));", "const roleCount = Math.max(1, legacy.signerNames.length, maxIndex + 1);", "maximo 2 firmantes"),
    ("L03", LEGACY, "const width = Math.min(rw, 1 - x);", "const width = rw;", "recortar rect antiguo a la pagina"),
    ("L04", LEGACY, "return !(legacy && migrated.has(legacy.legacyId));", "return true;", "markMigrated borra solo lo migrado"),
    ("L05", LEGACY, 'roleCount === 1 ? { "1": variant } : { "2": variant }', 'roleCount === 1 ? { "2": variant } : { "1": variant }', "variante segun nº de firmantes"),
    ("L06", LEGACY, '|| own(parsed, "version") !== LEGACY_SCHEMA_VERSION', "", "version del formato antiguo"),
    # --- automapeo -> plantilla ---
    ("U01", AUTO, 'if (field.tier === "ignore") {', "if (false) {", "los `ignore` no entran"),
    ("U02", AUTO, 'const review = field.tier === "review";', 'const review = field.tier === "high";', "needsReview solo en tier review"),
    ("U03", AUTO, "if (field.signerIndex === undefined || field.signerIndex >= options.signers) {", "if (field.signerIndex === undefined) {", "el firmante 2 no entra con 1 firmante"),
    ("U04", AUTO, 'required: false, rule: "today", source: "auto"', 'required: false, source: "auto"', "fecha: regla today"),
    ("U05", AUTO, "iou(own.rect, field.rect) >= minOverlap", "iou(own.rect, field.rect) > 2", "fusion: mismo sitio = mismo campo"),
    ("U06", AUTO, "if (field.id && dismissed.has(field.id)) {", "if (false) {", "fusion: ids descartados"),
    ("U07", AUTO, "const minOverlap = options.minOverlap ?? 0.3;", "const minOverlap = options.minOverlap ?? 0.99;", "fusion: solapamiento minimo"),
    ("U08", AUTO, 'field.source = "manual";', 'field.source = "auto";', "trazabilidad: auto movido pasa a manual"),
    ("U09", AUTO, 'const copy: TemplateSignField = { ...field, rect: { ...field.rect }, source: "auto" };', 'const copy: TemplateSignField = { ...field, rect: { ...field.rect }, source: "manual" };', "fusion: lo anadido queda auto"),
    # --- exportar / importar ---
    ("P01", PERSIST, "if (templates && templates.length > 0) {", "if (false) {", "exportar plantillas"),
    ("P02", PERSIST, "parseTemplate({ ...item, rev: 1 })", "parseTemplate({ rev: 1, ...item })", "importar: la rev no viaja"),
    ("P03", PERSIST, "if (version > TEMPLATES_EXPORT_SCHEMA) {", "if (false) {", "importar: bloque de plantillas mas nuevo"),
    ("P04", PERSIST, "if (templates.length >= TEMPLATE_LIMITS.maxTemplates) return;", "", "importar: tope de 200 plantillas"),
    ("P05", PERSIST, "if (seen.has(template.id)) {", "if (false) {", "importar: ids repetidos"),
]

TEST_ARGS = [
    "npx",
    "vitest",
    "run",
    "--project",
    "engines",
    "src/lib/docLibrary/template",
    "src/lib/docLibrary/dataKeys",
    "src/lib/docLibrary/store.test",
    "src/lib/docLibrary/persist.test",
    "--bail",
    "1",
]


BROKEN_MARKERS = ("Transform failed", "SyntaxError", "ParseError", "Unexpected token", "Failed to parse source")


def run_tests() -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive). Si el codigo mutado ni compila, aborta: esa mutacion no vale."""
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
