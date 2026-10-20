#!/usr/bin/env python3
"""
Mutaciones del respaldo de plantillas y documentos (U4.5 + U4.2): aplica de una en una cambios pequenos a la logica
(exportar, planificar, decisiones, limites, atomicidad, revalidacion, estado «desactualizada», interfaz y flujo) y
comprueba que las pruebas fallan. Una mutacion que NO hace fallar ninguna prueba «sobrevive» y indica una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/library-backup-mutate.py            # todas
    python3 scripts/library-backup-mutate.py L01 C04    # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = "src/lib/backup/modules/library.ts"
COMMIT = "src/lib/backup/modules/libraryCommit.ts"
MIGR = "src/lib/backup/migrations/library/index.ts"
REGISTRY = "src/lib/backup/registry.ts"
LAST = "src/lib/backup/lastBackup.ts"
FLOW = "src/app/documents/backupFlow.ts"
MODEL = "src/app/documents/backupModel.ts"
EXPORT = "src/app/documents/ExportBackupSheet.tsx"
IMPORT = "src/app/documents/ImportBackupSheet.tsx"
PANEL = "src/app/documents/StoragePanel.tsx"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    # --- librería: comparar y planificar ---
    ("L01", LIB, "return sameContent(contentOf(a), contentOf(b));", "return true;", "«misma plantilla» = mismo contenido"),
    ("L02", LIB, "const MAX_DOC_ITEMS = 200;", "const MAX_DOC_ITEMS = 2000000;", "tope de elementos del índice de documentos"),
    ("L03", LIB, "if (entry.fingerprint.exact !== sha || (await sha256Hex(pdf)) !== sha) {", "if ((await sha256Hex(pdf)) !== sha) {", "la huella declara el SHA-256 del PDF"),
    ("L04", LIB, "pdf.length > LIBRARY_LIMITS.maxDocumentBytes || !hasPdfHeader(pdf)) {", "pdf.length > LIBRARY_LIMITS.maxDocumentBytes) {", "el PDF empieza por %PDF-"),
    ("L05", LIB, "if (seenIds.has(rawId)) {\n      docItems.push", "if (false) {\n      docItems.push", "ids de documento repetidos"),
    ("L06", LIB, "const target = byHash ?? byId;", "const target = byId;", "el mismo PDF con otro id cuenta como «ya lo tienes»"),
    ("L07", LIB, "if (!changes && !additions) item.status = \"identical\";", "if (false) item.status = \"identical\";", "idéntico = mismo PDF y mismas plantillas"),
    ("L08", LIB, "item.difference === \"pdf\" ? \"keepBoth\"", "item.difference === \"pdf\" ? \"replace\"", "decisión por defecto de otro PDF: conservar ambos"),
    ("L09", LIB, "if (item.difference === \"templates\" && item.changesTemplates !== true) return [\"import\", \"omit\"];", "", "opciones del mismo PDF con plantillas nuevas"),
    ("L10", LIB, "if (!libraryDecisionOptions(item).includes(decision)) continue;", "", "una decisión incoherente no se aprueba"),
    ("L11", LIB, "if (claimedTargets.has(target)) continue;", "", "un destino se reemplaza una sola vez"),
    ("L12", LIB, "if (nextDocuments > limits.maxDocuments) blocked = \"documents\";", "if (nextDocuments > limits.maxDocuments + 1000) blocked = \"documents\";", "límite de documentos antes de importar"),
    ("L13", LIB, "else if (nextBytes > limits.maxTotalBytes) blocked = \"bytes\";", "else if (false) blocked = \"bytes\";", "límite de espacio antes de importar"),
    ("L14", LIB, "nextPerDocument > limits.maxTemplatesPerDocument", "nextPerDocument > 9999", "límite de plantillas por documento antes de importar"),
    ("L15", LIB, "else if (addedBytes + Math.max(0, writes.pdfBytes) > room) blocked = \"quota\";", "", "espacio libre del navegador"),
    ("L16", LIB, "!issuedPlans.has(plan)", "false", "solo se aplican planes emitidos por el planificador"),
    ("L17", LIB, "if ((await sha256Hex(pdf)) !== document.fingerprint.exact) return false;", "", "se revalida el SHA-256 al aplicar"),
    ("L18", LIB, "(await sha256Hex(pdf)) !== doc.fingerprint.exact", "false", "exportar omite la copia que no es la de su huella"),
    ("L19", LIB, "const documentId = template.documentId !== null && fileOf.has(template.documentId) ? template.documentId : null;", "const documentId = template.documentId;", "plantilla de un documento que no viaja queda «sin documento»"),
    ("L20", LIB, "const RESERVED_TEMPLATE_FILES = new Set([\"index.json\", \"kits.json\", \"insurer-profiles.json\"]);", "const RESERVED_TEMPLATE_FILES = new Set([\"index.json\"]);", "nombres reservados de templates/"),
    ("L21", LIB, "while (used.has(candidate.toLowerCase())", "while (used.has(candidate)", "rutas únicas sin distinguir mayúsculas"),
    # --- migraciones y registro ---
    ("G01", MIGR, "export const CURRENT_LIBRARY_SCHEMA = 1;", "export const CURRENT_LIBRARY_SCHEMA = 2;", "el dorado v1 sigue importándose (esquema actual)"),
    ("G02", REGISTRY, "[LIBRARY_MODULE_SPEC.name]: LIBRARY_MODULE_SPEC,", "", "el módulo library está en el registro"),
    # --- escritura atómica ---
    ("C01", COMMIT, "if (!current || current.rev !== change.expectRev) throw new LibraryError(\"conflict\");", "if (!current) throw new LibraryError(\"conflict\");", "la plantilla a reemplazar sigue en la misma rev"),
    ("C02", COMMIT, "if (!target || target.rev !== op.expectRev) throw new LibraryError(\"conflict\");", "if (!target) throw new LibraryError(\"conflict\");", "el documento a reemplazar sigue en la misma rev"),
    ("C03", COMMIT, "if (existing.fingerprint.exact === op.entry.fingerprint.exact) throw new LibraryError(\"conflict\");", "", "un PDF que ya llegó no se duplica"),
    ("C04", COMMIT, "if (takenDocumentIds.has(id)) {", "if (false) {", "id de documento ocupado se reasigna"),
    ("C05", COMMIT, "if (takenTemplateIds.has(id)) {", "if (false) {", "id de plantilla ocupado se reasigna"),
    ("C06", COMMIT, ".slice(0, TEMPLATE_LIMITS.maxVersions - 1)", ".slice(0, 0)", "reemplazar guarda la versión anterior en el historial"),
    ("C07", COMMIT, "if (info.mode === \"replace\" && (info.retained ?? 0) > 0 && info.previous) {", "if (false) {", "plantillas conservadas tras reemplazar el PDF quedan desactualizadas"),
    ("C08", COMMIT, "else if (info.pkgStale && owned.length > 0) {", "else if (info.pkgStale) {", "sin plantillas no hay aviso de desactualizada"),
    ("C09", COMMIT, "if (owned.length > TEMPLATE_LIMITS.maxPerDocument) throw new LibraryError(\"full\", \"count\");", "", "20 plantillas por documento al escribir"),
    ("C10", COMMIT, "if (documentCount + counters.documentsCreated > LIBRARY_LIMITS.maxDocuments) throw new LibraryError(\"full\", \"count\");", "", "50 documentos al escribir"),
    ("C11", COMMIT, "if (bytesTotal > LIBRARY_LIMITS.maxTotalBytes) throw new LibraryError(\"full\", \"total\");", "", "400 MiB al escribir"),
    ("C12", COMMIT, "if (templateRows.length + counters.templatesAdded > TEMPLATE_LIMITS.maxTemplates) throw new LibraryError(\"full\", \"count\");", "", "200 plantillas al escribir"),
    ("C13", COMMIT, "if (code === \"conflict\") return { ok: false, reason: \"changed\" };", "if (code === \"conflict\") return { ok: false, reason: \"failed\" };", "conflicto = «changed»"),
    ("C14", COMMIT, "if (ownerId !== undefined && current.documentId !== ownerId) throw new LibraryError(\"conflict\");", "", "una plantilla de otro documento no se toca"),
    # --- flujo y modelo de la interfaz ---
    ("F01", FLOW, "if (summary.bytes > limit) return", "if (summary.bytes > limit * 10) return", "tope de 250 MB antes de leer los PDF"),
    ("F02", FLOW, "return check.status === \"ok\" || (check.status === \"encrypted\" && !check.needsPassword);", "return check.status === \"ok\";", "PDF con solo restricciones se admite"),
    ("F03", FLOW, "        done += 1;\n", "", "progreso por PDF"),
    ("M01", MODEL, "if (days <= 0) return { kind: \"today\" };", "if (days < 0) return { kind: \"today\" };", "último respaldo: hoy"),
    ("M02", MODEL, "return item.status === \"different\" ? \"decisionAdd\" : \"decisionImport\";", "return \"decisionImport\";", "rótulo «Añadir plantillas»"),
    ("M03", MODEL, "return item.changesTemplates ? \"hintTemplatesChanged\" : \"hintTemplatesNew\";", "return item.changesTemplates ? \"hintTemplatesNew\" : \"hintTemplatesChanged\";", "explicación de plantillas distintas"),
    ("M04", MODEL, "return reason === \"blocked\" ? \"invalid\" : reason;", "return reason as ApplyFailureKey;", "blocked cuenta como no válido"),
    ("M05", MODEL, "if (item.kind === \"document\" && item.duplicateOf === undefined) documents += 1;", "", "recuento de documentos del archivo"),
    ("B01", LAST, "/^\\d{4}-\\d{2}-\\d{2}T/", "/^\\d{4}/", "fecha ISO del último respaldo"),
    ("B02", LAST, "export const LAST_BACKUP_KEY = \"optimuspdf.lastBackup\";", "export const LAST_BACKUP_KEY = \"optimuspdf.lastbackup\";", "clave de localStorage"),
    # --- hojas ---
    ("U01", EXPORT, "const [protect, setProtect] = useState(canEncrypt);", "const [protect, setProtect] = useState(false);", "contraseña marcada por defecto"),
    ("U02", EXPORT, "    markLastBackup(new Date(), { traveled: [\"library\"], empty: emptyPartsRef.current });\n      announce();", "    announce();", "anotar el último respaldo al terminar"),
    ("U03", EXPORT, "else if (outcome === \"cancelled\") setError(copy.shareCancelled);", "else if (outcome === \"cancelled\") finish(ready.file, ready.documents, ready.templates, ready.encrypted);", "cerrar la hoja de compartir no cuenta como exportado"),
    ("U04", IMPORT, "disabled={phase === \"importing\" || check.wanted === 0 || !check.ok}", "disabled={phase === \"importing\"}", "botón bloqueado si no caben o no hay nada"),
    ("U05", IMPORT, "setDecisions(defaultLibraryDecisions(read.plan));", "setDecisions({});", "decisiones sugeridas al abrir la vista previa"),
    ("U06", IMPORT, "if (failure === \"changed\" && file) {", "if (false) {", "relee el archivo si la biblioteca cambió"),
    ("U07", IMPORT, "if (read.reason === \"wrongPassword\") {", "if (false) {", "contraseña incorrecta deja reintentar"),
    ("U08", PANEL, "lastBackupText(lastBackupView(lastBackup), t.documents.backup)", "t.documents.backup.lastNever", "el panel muestra el último respaldo"),
]

TEST_ARGS = [
    "npx",
    "vitest",
    "run",
    "src/lib/backup/modules/library",
    "src/lib/backup/goldenLibraryPackages",
    "src/lib/backup/goldenPackages",
    "src/lib/backup/lastBackup",
    "src/app/documents/backup",
    "src/app/documents/BackupSheets",
    "src/components/views/MyDocumentsView.backup",
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
