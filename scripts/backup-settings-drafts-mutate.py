#!/usr/bin/env python3
"""
Mutaciones de los modulos «Ajustes» y «Borradores» del paquete de respaldo (U4.6): aplica de una en una cambios pequenos a
la logica (lista blanca y validadores, caducidad y politica de trazos, huella del PDF, deteccion de identicos, limites,
versionado, atomicidad y deshacer) y comprueba que las pruebas de `src/lib/backup/` fallan. Una mutacion que NO hace fallar
ninguna prueba «sobrevive» y senala una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/backup-settings-drafts-mutate.py            # todas
    python3 scripts/backup-settings-drafts-mutate.py A01 D05    # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = "src/lib/backup/"
REGISTRY = LIB + "settingsRegistry.ts"
SETTINGS = LIB + "modules/settings.ts"
DRAFTS = LIB + "modules/drafts.ts"
SCHEMA = LIB + "modules/draftsSchema.ts"
PNG = LIB + "modules/draftsPng.ts"
SIGN_DRAFTS = "src/app/sign-pdf/signDrafts.ts"
EDIT_DRAFTS = "src/app/edit-pdf/editDrafts.ts"
PRO_DRAFTS = "src/app/pdf-pro/proDrafts.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    # --- Ajustes: lista blanca y validadores (settingsRegistry) ---
    ("A01", REGISTRY, 'if (typeof flag !== "boolean") return undefined;', "", "interruptores: un tipo cambiado invalida el ajuste"),
    ("A02", REGISTRY, "if (names.length > MAX_OBJECT_KEYS) return undefined;", "", "interruptores: tope de claves del objeto"),
    ("A03", REGISTRY, "typeof value === \"number\" && Number.isInteger(value) && value >= min && value <= max", "typeof value === \"number\" && value >= min && value <= max", "diseno de Pro: enteros"),
    ("A04", REGISTRY, "validate: (value) => (value === true ? true : undefined),", "validate: (value) => (value ? true : undefined),", "aviso visto: solo `true`"),
    ("A05", REGISTRY, "typeof value === \"string\" && (choices as readonly string[]).includes(value) ? value : undefined;", "typeof value === \"string\" ? value : undefined;", "tema / idioma: enumerado"),
    ("A06", REGISTRY, "raw.length === 0 || raw.length > MAX_STORED_SETTING_LENGTH", "raw.length === 0", "lo leido de localStorage tiene tope de longitud"),
    ("A07", REGISTRY, "validate: (value) => (value === 1 || value === 2 ? value : undefined),", "validate: (value) => (typeof value === \"number\" ? value : undefined),", "firmantes recordados: 1 o 2"),
    ("A08", REGISTRY, "() => [[SIGN_PDF_FEATURE_FLAGS_VERSION_KEY, String(SIGN_PDF_FEATURE_FLAGS_VERSION)]],", "() => [],", "ajustes de Firmar: se escribe la version (si no, vuelve a apagarse el registro)"),
    ("A09", REGISTRY, "return BY_KEY.get(key);", "return (SETTINGS_REGISTRY as unknown as Record<string, SettingDef>)[key];", "settingDef busca en un Map (no en un objeto con prototipo)"),
    # --- Ajustes: modulo (settings.ts) ---
    ("B01", SETTINGS, "if (!settingDef(key)) plan.ignoredKeys += 1;", "", "claves ajenas del paquete: se cuentan"),
    ("B02", SETTINGS, "if (write.expectRaw !== undefined && now !== write.expectRaw.raw) return { ok: false, reason: \"changed\" };", "", "aplicar: el almacenamiento no cambio desde la vista previa"),
    ("B03", SETTINGS, "else storage.setItem(key, before);", "else void before;", "fallo de cuota: se restauran los valores anteriores"),
    ("B04", SETTINGS, "if (!def || settingKeys.has(item.key)) return { ok: false, reason: \"invalid\" };", "if (!def) return { ok: false, reason: \"invalid\" };", "aplicar: una clave repetida en el plan se rechaza"),
    ("B05", SETTINGS, "if (decisions?.settings === \"replace\") {", "if (decisions?.settings !== undefined) {", "«Omitir» no escribe nada"),
    ("B06", SETTINGS, "return { settings: changes ? \"replace\" : \"omit\", valueHistory: \"omit\" };", "return { settings: changes ? \"replace\" : \"omit\", valueHistory: \"replace\" };", "el historial de valores (PII) se omite por defecto"),
    ("B07", SETTINGS, "new Set([\"__proto__\", \"constructor\", \"prototype\"])", "new Set<string>([])", "historial: etiquetas que tocan el prototipo"),
    ("B08", SETTINGS, "if (labels.length > VALUE_HISTORY_MAX_KEYS) return { ok: false };", "", "historial: tope de 200 etiquetas"),
    ("B09", SETTINGS, "options.includeValueHistory === true ? readLocalValueHistory(storage).entries : undefined", "options.includeValueHistory !== false ? readLocalValueHistory(storage).entries : undefined", "el historial de valores sale desmarcado por defecto"),
    ("B10", SETTINGS, "const value = def.validate(item.value);\n      if (value === undefined) return { ok: false, reason: \"invalid\" };", "const value = item.value as never;", "aplicar revalida cada valor con el validador de la lista blanca"),
    ("B11", SETTINGS, "list.length > VALUE_HISTORY_MAX_PER_KEY", "list.length > 1000", "historial: tope de 5 valores por etiqueta"),
    # --- Borradores: exportar ---
    ("C01", DRAFTS, "const keep = options.includeStrokes !== false && readSignaturesInDraft();", "const keep = options.includeStrokes !== false;", "exportar respeta «guardar las firmas»"),
    ("C02", SIGN_DRAFTS, "if (isExpired(meta, now)) expired += 1;", "if (false) expired += 1;", "no se exportan borradores caducados"),
    ("C02b", DRAFTS, "if (bytes > PACKAGE_BYTES_BUDGET) throw new PackageError(\"tooLarge\");", "", "exportar: tope de tamano del paquete"),
    ("C02c", DRAFTS, "fitsInPackage: bytes <= PACKAGE_BYTES_BUDGET,", "fitsInPackage: true,", "resumen: dice si cabe en un paquete"),
    ("C03", DRAFTS, "includesSignatureStrokes: withStrokes > 0 && keep,", "includesSignatureStrokes: withStrokes > 0,", "resumen: los trazos solo viajan si el ajuste lo permite"),
    ("C04", DRAFTS, "const stripped = keep ? { captures: meta.captures, stripped: false } : withoutCaptureStrokes(meta.captures);", "const stripped = { captures: meta.captures, stripped: false };", "sin trazos: el documento suelto sale sin firmas"),
    ("C05", DRAFTS, "const stripped = keep ? { blocks: meta.blocks, stripped: false } : withoutBlockStrokes(meta.blocks ?? []);", "const stripped = { blocks: meta.blocks, stripped: false };", "sin trazos: la sesion sale sin firmas"),
    ("C06", DRAFTS, "...(meta.ceremony && !stripped.stripped ? { ceremony: meta.ceremony } : {}),", "...(meta.ceremony ? { ceremony: meta.ceremony } : {}),", "sin trazos: no viaja el turno guardado"),
    # --- Borradores: validar y planificar ---
    ("D01", DRAFTS, "if (pdf.sha256 !== parsed.fingerprint) return invalid(\"fingerprint\", parsed.id, parsed.fileName);", "", "la huella del documento es la del PDF que viaja"),
    ("D02", DRAFTS, "if (pdf.sha256 !== header.id) return invalid(\"fingerprint\", header.id, header.fileName);", "", "el id de Editar es la huella de su PDF"),
    ("D03", DRAFTS, "if (!looksLikePdf(bytes)) return \"invalidPdf\";", "", "forma minima de un PDF"),
    ("D04", DRAFTS, "if (common.options.validatePdf && !(await common.options.validatePdf(bytes, fileName))) return \"invalidPdf\";", "", "inputGuard decide si el PDF se abre"),
    ("D05", DRAFTS, "if (!file?.bytes || !(await common.options.validateImage(file.bytes))) return \"invalidImage\";", "if (!file?.bytes) return \"invalidImage\";", "cada trazo se decodifica de verdad"),
    ("D06", SCHEMA, "if (Array.isArray(raw.blocks) && raw.blocks.length > MAX_DRAFT_BLOCKS) return fail(\"tooMany\");", "", "10 000 bloques se rechazan antes de recorrerlos"),
    ("D07", DRAFTS, "out[item.key] = item.conflictWith && !item.conflictWith.newer ? \"replace\" : item.canKeepBoth ? \"keepBoth\" : \"omit\";", "out[item.key] = \"replace\";", "no se pisa un borrador local mas nuevo por defecto"),
    ("D08", DRAFTS, "meta.id !== item.id && (meta.fingerprint ?? meta.id) === payload.meta.fingerprint", "false && (meta.fingerprint ?? meta.id) === payload.meta.fingerprint", "el mismo contenido bajo otro id es «idéntico»"),
    ("D09", DRAFTS, "const VOLATILE_ITEM_KEYS: ReadonlySet<string> = new Set([\"ref\", \"id\", \"savedAt\", \"expiresAt\"]);", "const VOLATILE_ITEM_KEYS: ReadonlySet<string> = new Set([\"ref\"]);", "lo idéntico no depende de id, fecha ni caducidad"),
    ("D10", DRAFTS, "return Date.parse(savedAt) > now + FUTURE_SLACK_MS ? new Date(now).toISOString() : savedAt;", "return savedAt;", "una fecha de guardado futura se recorta"),
    ("D10b", DRAFTS, "return new Date(Math.min(wanted, ceiling)).toISOString();", "return new Date(wanted).toISOString();", "una caducidad lejana se recorta a 7 dias"),
    ("D11", DRAFTS, "const expired = keeps && expiresAt !== null && isExpired({ expiresAt }, common.now);", "const expired = false;", "un borrador con trazos ya caducado se rechaza"),
    ("D12", DRAFTS, "if (!Array.isArray(value) || value.length > MAX_INDEX_ITEMS_PER_KIND) return emptyPlan(\"damaged\");", "if (!Array.isArray(value)) return emptyPlan(\"damaged\");", "tope de entradas por tipo en el indice"),
    ("D13", DRAFTS, "if (seen.has(item.key)) {", "if (false) {", "ids repetidos en el indice"),
    ("D14", SCHEMA, "if (!match || ctx.used.has(value.png) || !Number.isFinite(value.ratio) || value.ratio <= 0 || value.ratio > 20) {", "if (!match || !Number.isFinite(value.ratio) || value.ratio <= 0 || value.ratio > 20) {", "un archivo de trazo no se comparte entre dos trazos"),
    ("D15", SCHEMA, "if (Math.abs(real - value.ratio) > 0.02 * Math.max(1, real)) return { ok: false, reason: \"invalidImage\" };", "", "la proporcion es la del PNG"),
    ("D16", SCHEMA, "if (FORBIDDEN_KEYS.has(key)) continue;", "", "textValues: claves que tocan el prototipo"),
    ("D17", SCHEMA, ".replace(BIDI_CONTROLS, \"\")", "", "texto libre: sin marcas bidi"),
    ("D18", DRAFTS, "detectImageMime(file.bytes) !== asset.mime", "false", "Editar: el tipo de la imagen es el que dice"),
    ("D19", SCHEMA, "const rows = list(raw.history, MAX_PRO_HISTORY_NOTES);", "const rows = Array.isArray(raw.history) ? (raw.history as unknown[]) : null;", "PDF Pro: tope de notas de historial"),
    ("D20", PNG, "if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;", "if (bytes.byteLength === 0) return null;", "trazo PNG: tope de bytes"),
    # --- Borradores: aplicar ---
    ("E01", DRAFTS, "if (keep) return { payload, dropped: false };", "return { payload, dropped: false };", "la politica de trazos se relee al aplicar"),
    ("E02", DRAFTS, "const id = decision === \"keepBoth\" ? newDocumentDraftId(payload.meta.fingerprint ?? payload.meta.id) : payload.meta.id;", "const id = payload.meta.id;", "conservar ambos: id nuevo con nonce"),
    ("E03", DRAFTS, "...(decision === \"keepBoth\" && conflict ? { copyOf: conflict.id } : {}),", "", "conservar ambos: copyOf"),
    ("E04", DRAFTS, "if (policy.dropped || item.strokesDropped) strokesDropped += 1;", "", "se cuenta cuantos borradores perdieron los trazos"),
    ("E05", DRAFTS, "if (!(await revalidate(original, now))) return { ok: false, reason: \"invalid\" };", "", "aplicar revalida cada borrador"),
    ("E07", DRAFTS, "else if (decision === \"keepBoth\" && item.canKeepBoth) out.push({ item, decision });", "else if (decision === \"keepBoth\") out.push({ item, decision });", "Editar y PDF Pro no admiten «conservar ambos»"),
    ("E08", DRAFTS, "if (meta.fingerprint !== (await sha256Hex(bytes)) || meta.fileSize !== bytes.byteLength) return false;", "if (meta.fileSize !== bytes.byteLength) return false;", "revalidar: la huella del documento"),
    # --- Borradores: escritura atomica (signDrafts / editDrafts / proDrafts) ---
    ("F01", SIGN_DRAFTS, "if (count > MAX_DRAFTS || bytes > MAX_DRAFTS_TOTAL_BYTES) {", "if (false) {", "Firmar: la transaccion vuelve a comprobar el limite"),
    ("F02", SIGN_DRAFTS, "if (!current || current.savedAt !== expected.savedAt || (current.rev ?? 0) !== expected.rev) {", "if (!current) {", "Firmar: lo que se sustituye sigue siendo lo visto"),
    ("F03", SIGN_DRAFTS, "const rev = previous ? Math.max(previous.rev ?? 0, knownDraftRev(session.meta.id)) + 1 : 1;", "const rev = 1;", "Firmar: la rev sube al sustituir"),
    ("F04", SIGN_DRAFTS, "sessionStore.put({ ...session.meta, rev, writerId: tab.id } satisfies SessionDraftMeta);", "sessionStore.put({ ...session.meta, rev, writerId: \"otra\" } satisfies SessionDraftMeta);", "Firmar: el writerId es el de esta pestana"),
    ("F05", SIGN_DRAFTS, "for (const meta of outcome.before.sessions.values()) sessionStore.put(meta);", "", "Firmar: undo devuelve la sesion sustituida"),
    ("F06", SIGN_DRAFTS, "for (const record of outcome.before.files.values()) filesStore.put(record);", "", "Firmar: undo devuelve los archivos sustituidos"),
    ("F07", SIGN_DRAFTS, "              filesStore.delete(id);\n              metaStore.delete(id);\n              writtenFileIds.delete(id);", "              filesStore.delete(id);\n              writtenFileIds.delete(id);", "Firmar: undo borra lo creado"),
    ("F08", SIGN_DRAFTS, "if (localDocs.has(doc.meta.id) && !replaceDocs.has(doc.meta.id)) {", "if (false) {", "Firmar: un id ocupado sin declarar es un choque"),
    ("F09", EDIT_DRAFTS, "if (!current || current.savedAt !== expected.savedAt) {", "if (!current) {", "Editar: lo que se sustituye sigue siendo lo visto"),
    ("F10", EDIT_DRAFTS, "if (count > limits.maxDrafts || bytes > limits.maxTotalBytes) {", "if (false) {", "Editar: limite dentro de la transaccion"),
    ("F11", EDIT_DRAFTS, "for (const record of outcome.before.files) filesStore.put(record);", "", "Editar: undo devuelve la imagen y el PDF"),
    ("F12", PRO_DRAFTS, "if (count > limits.maxDrafts || bytes > limits.maxTotalBytes) {", "if (false) {", "PDF Pro: limite dentro de la transaccion"),
    ("F13", PRO_DRAFTS, "for (const row of outcome.before.rows) filesStore.put(row);", "", "PDF Pro: undo devuelve la fila y el manifiesto"),
    ("F14", PRO_DRAFTS, "if (!current || current.savedAt !== expected.savedAt) {", "if (!current) {", "PDF Pro: lo que se sustituye sigue siendo lo visto"),
    ("F15", PRO_DRAFTS, "              filesStore.delete(put.meta.id);\n              metaStore.delete(put.meta.id);\n              writtenSnapshots.delete(put.meta.id);", "              metaStore.delete(put.meta.id);\n              writtenSnapshots.delete(put.meta.id);", "PDF Pro: undo borra lo creado"),
]

TEST_ARGS = [
    "npx",
    "vitest",
    "run",
    "--project",
    "engines",
    "src/lib/backup/settingsRegistry",
    "src/lib/backup/modules/settings.test",
    "src/lib/backup/modules/drafts",
    "src/lib/backup/commitDraftImport",
    "src/lib/backup/goldenPackages",
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
