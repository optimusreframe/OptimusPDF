#!/usr/bin/env python3
"""
Mutaciones de las correcciones F4-fix (H1-H9 de la verificacion independiente de «Respaldo y traslado»): aplica de una en
una cambios pequenos a la logica y comprueba que las pruebas NUEVAS (o las ajustadas) fallan. Una mutacion que NO hace fallar
ninguna prueba «sobrevive» y senala una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/f4fix-mutate.py            # todas
    python3 scripts/f4fix-mutate.py H101 H902  # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = "src/lib/backup/package.ts"
GP = "src/lib/backup/globalPackage.ts"
LAST = "src/lib/backup/lastBackup.ts"
REM = "src/lib/backup/backupReminder.ts"
LIB = "src/lib/backup/modules/library.ts"
COMMIT = "src/lib/backup/modules/libraryCommit.ts"
SIGS = "src/lib/backup/modules/signatures.ts"
SETT = "src/lib/backup/modules/settings.ts"
REG = "src/lib/backup/settingsRegistry.ts"
VAULT = "src/app/sign-pdf/signVault.ts"
SDRAFT = "src/app/sign-pdf/signDrafts.ts"
EDRAFT = "src/app/edit-pdf/editDrafts.ts"
PDRAFT = "src/app/pdf-pro/proDrafts.ts"
STORE = "src/lib/docLibrary/store.ts"
SHEET = "src/components/ui/Sheet.tsx"
MODEL = "src/app/settings/packageModel.ts"
EXPORT = "src/app/settings/ExportPackageSheet.tsx"
IMPORT = "src/app/settings/ImportPackageSheet.tsx"
CARDS = "src/app/settings/PackageItemCards.tsx"
DOCEXPORT = "src/app/documents/ExportBackupSheet.tsx"
DOCFLOW = "src/app/documents/backupFlow.ts"

NEW = [
    "src/lib/backup/lastBackup.parts.test.tsx",
    "src/lib/backup/globalPackage.quota.test.tsx",
    "src/lib/backup/globalPackage.absent.test.tsx",
    "src/lib/backup/modules/library.duplicate.test.tsx",
    "src/lib/backup/modules/libraryCommit.rev.test.tsx",
    "src/lib/backup/modules/signatures.tamper.test.ts",
    "src/lib/backup/modules/settings.rows.test.ts",
    "src/lib/backup/modules/settings.test.ts",
    "src/lib/backup/modules/signatures.test.ts",
    "src/app/settings/PackageSheets.f4fix.test.tsx",
    "src/components/ui/Sheet.closeLocked.test.tsx",
    "src/app/settings/packageModel.test.ts",
    "src/app/documents/backupFlow.test.ts",
]
LARGE = ["src/lib/backup/package.large.test.ts", "src/lib/backup/globalPackage.large.test.tsx", "src/lib/backup/package.test.ts"]

# (id, archivo, texto original, texto mutado, descripcion, pruebas). El original debe aparecer; se reemplaza la PRIMERA aparicion.
MUTATIONS = [
    # --- H1: presupuestos y limites del contenedor ---
    ("H101", PKG, "const budget: InflateBudget = { remaining: PACKAGE_LIMITS.maxUncompressedBytes };\n  const names", "const budget: InflateBudget = { remaining: PACKAGE_LIMITS.maxUncompressedBytes / 2 };\n  const names", "la capa externa tiene su propio presupuesto (no gasta el de la interior)", LARGE),
    ("H102", PKG, "  // Presupuesto de la capa INTERIOR (el contenido del paquete): <= 250 MiB realmente inflados, como siempre.\n  const budget: InflateBudget = { remaining: PACKAGE_LIMITS.maxUncompressedBytes };", "  const budget: InflateBudget = { remaining: PACKAGE_LIMITS.maxUncompressedBytes / 2 };", "la capa interior conserva sus 250 MiB (126-140 MB cifrados e importables)", LARGE),
    # H103 (el tope de exportacion cuenta manifest.json) y H104 (presupuesto de la capa externa) NO se mutan: son EQUIVALENTES
    # mientras `assertImportable` compruebe el tamano del archivo generado (con entradas STORE el archivo supera siempre lo
    # declarado) y `readCapped` corte cada lectura en lo declarado (el presupuesto externo solo lo gastan envelope.json y
    # payload.bin, ambos acotados). Son defensa en profundidad, no comportamiento observable.
    ("H105", GP, "overBy: Math.max(0, estimated - EXPORT_LIMIT_BYTES),", "overBy: 0,", "se dice cuanto sobra antes de exportar", NEW),
    ("H106", GP, "tooLarge: estimated > EXPORT_LIMIT_BYTES ||", "tooLarge: estimated > EXPORT_LIMIT_BYTES * 2 ||", "lo que no cabe se avisa antes de exportar", NEW),
    ("H107", DOCFLOW, "return { ok: false, reason: \"tooLarge\", overBy: summary.bytes - limit };", "return { ok: false, reason: \"tooLarge\" };", "Mis documentos tambien dice cuanto sobra", NEW),
    # --- H2 / H3: respaldo parcial y borrados ---
    ("H201", LAST, "const complete = REMINDER_PARTS.every((part) => covered.has(part));", "const complete = true;", "un respaldo parcial no es completo", NEW),
    ("H202", LAST, "    if (!parts.includes(part)) continue;\n    removed += by[part] ?? 0;", "    removed += by[part] ?? 0;", "un respaldo parcial solo descuenta los cambios de lo que viajo", NEW),
    ("H203", LAST, "const nothing = !traveledNow.has(part) && covered.has(part) ? at : stored.empty[part];", "const nothing = stored.empty[part];", "una parte vacia cuenta como respaldada", NEW),
    ("H204", LAST, "covered = new Date(Math.min(...REMINDER_PARTS.map((part) => (parts[part] as Date).getTime())));", "covered = new Date(Math.max(...REMINDER_PARTS.map((part) => (parts[part] as Date).getTime())));", "el ancla de 30 dias es la parte mas antigua", NEW),
    ("H205", EXPORT, "markLastBackup(new Date(), { traveled: entry.included,", "markLastBackup(new Date(), { traveled: [\"signatures\", \"library\", \"drafts\", \"settings\"],", "la hoja anota solo lo que viajo", NEW),
    ("H206", MODEL, "return date !== undefined && (full === null || date.getTime() > full.getTime());", "return date !== undefined;", "la linea no presume de parcial cuando el completo es mas reciente", NEW),
    ("H207", "src/app/settings/BackupReminder.tsx", "status.partialBackups ? copy.reminderDaysPartial : copy.reminderDaysNever", "copy.reminderDaysNever", "el aviso no dice «ningun respaldo» si hubo parciales", NEW),
    ("H301", VAULT, "    if (existed) noteBackupRelevantChange(undefined, \"signatures\");", "", "borrar una firma suma al contador del recordatorio", NEW),
    ("H302", VAULT, "const probe = store.count(id);\n        probe.onsuccess = () => {\n          setResult(probe.result > 0);", "const probe = store.count(id);\n        probe.onsuccess = () => {\n          setResult(true);", "borrar un id que no existe no cuenta", NEW),
    # --- H4: ausente != fallo ---
    ("H401", GP, "return state === undefined && plans.absent?.includes(name) ? \"absent\" : \"unavailable\";", "return \"unavailable\";", "el modulo que el paquete no traia es «absent»", NEW),
    ("H402", MODEL, "if (absent.length > 0) lines.push({", "if (false) lines.push({", "«El paquete no incluye: …» se dice", NEW),
    # --- H5: documentos sin copia ---
    ("H501", LIB, "const withCopy = listed.documents.filter((doc) => doc.byteLength > 0 && (blobIds === null || blobIds.has(doc.id)));", "const withCopy = listed.documents.filter((doc) => doc.byteLength > 0);", "el resumen no cuenta documentos cuya copia se perdio", NEW),
    ("H502", GP, "          libraryWithoutCopy = report.skippedDocuments;\n", "", "exportEverything informa de los documentos que no viajaron", NEW),
    ("H503", EXPORT, "withoutCopyNote(result.libraryWithoutCopy, copy, \"after\")", "null", "la hoja de Ajustes avisa DESPUES de exportar", NEW),
    ("H504", EXPORT, "const withoutCopyBefore = description && choice?.library === true ? withoutCopyNote(description.library.withoutCopy, copy, \"before\") : null;", "const withoutCopyBefore = null;", "la hoja de Ajustes avisa ANTES de exportar", NEW),
    ("H505", DOCEXPORT, "setNotes(skipped > 0 ?", "setNotes(false ?", "Mis documentos avisa despues de exportar", NEW),
    # --- H6: PDF repetido en el paquete ---
    ("H601", LIB, "    if (!first) {\n      firstWithPdf.set(sha, item);\n      continue;\n    }", "    if (true) {\n      firstWithPdf.set(sha, item);\n      continue;\n    }", "el PDF repetido dentro del paquete se detecta", NEW),
    ("H602", LIB, "    templateRowsOfDoc.set(first.id, [...(templateRowsOfDoc.get(first.id) ?? []), ...(templateRowsOfDoc.get(item.id) ?? [])]);", "    templateRowsOfDoc.set(first.id, [...(templateRowsOfDoc.get(first.id) ?? [])]);", "las plantillas del repetido pasan al que se importa", NEW),
    ("H603", LIB, "for (const item of plan.items) if (!item.duplicateOf) plan.counts[item.status] += 1;", "for (const item of plan.items) plan.counts[item.status] += 1;", "el repetido no suma a los recuentos", NEW),
    ("H604", LIB, "    if (first?.status === \"invalid\") {", "    if (false) {", "si el PDF repetido no pasa la puerta, sus copias tampoco", NEW),
    # --- H7: cuota llena ---
    ("H701", VAULT, "return { ok: false, reason: isQuotaError(error) ? \"quota\" : \"unavailable\" };\n  }\n}", "return { ok: false, reason: isQuotaError(error) ? \"limit\" : \"unavailable\" };\n  }\n}", "baul: cuota llena = quota (no «no caben»)", NEW),
    ("H702", SETT, "return { ok: false, reason: isStorageQuotaError(error) ? \"quota\" : \"unavailable\" };", "return { ok: false, reason: \"unavailable\" };", "ajustes: cuota llena = quota", NEW),
    ("H703", SDRAFT, "return { ok: false, reason: isDraftQuotaError(error) ? \"quota\" : \"unavailable\" };", "return { ok: false, reason: \"unavailable\" };", "borradores de Firmar: cuota llena = quota", NEW),
    ("H704", EDRAFT, "return { ok: true, written: puts.length, replaced: outcome.replaced, undo };\n  } catch (error) {\n    return { ok: false, reason: isQuotaError(error) ? \"quota\" : \"unavailable\" };", "return { ok: true, written: puts.length, replaced: outcome.replaced, undo };\n  } catch (error) {\n    void error;\n    return { ok: false, reason: \"unavailable\" };", "borradores de Editar: cuota llena = quota", NEW),
    ("H705", PDRAFT, "undo, finalize };\n  } catch (error) {\n    return { ok: false, reason: isQuotaError(error) ? \"quota\" : \"unavailable\" };", "undo, finalize };\n  } catch (error) {\n    void error;\n    return { ok: false, reason: \"unavailable\" };", "borradores de PDF Pro: cuota llena = quota", NEW),
    # --- H8: vista previa de Ajustes ---
    ("H801", REG, "export const SENSITIVE_SIGN_FLAGS: readonly string[] = [\"signaturesInDraft\", \"signatureVault\"];", "export const SENSITIVE_SIGN_FLAGS: readonly string[] = [\"signaturesInDraft\"];", "guardar firmas es sensible", NEW),
    ("H802", REG, "    group: \"notices\",\n    sensitive: true,", "    group: \"notices\",\n    sensitive: false,", "los avisos de privacidad son sensibles", NEW),
    ("H803", SETT, "valueHistory: \"omit\",\n    ...(sensitive.length > 0", "valueHistory: \"omit\",\n    ...(false && sensitive.length > 0", "lo sensible se omite por defecto", NEW),
    ("H804", SETT, "if (chosen.length === rows.length || rows[0].flag === undefined) {", "if (true) {", "elegir solo algunos interruptores fusiona con lo de ahora", NEW),
    ("H805", SETT, "    const own = hasOwn(rowDecisions, id) ? rowDecisions[id] : undefined;", "    const own = undefined as \"replace\" | \"omit\" | undefined;", "se decide por ajuste", NEW),
    ("H806", SETT, "      if (current === wanted) continue;", "", "los interruptores que no cambian no salen en la lista", NEW),
    ("H807", MODEL, "export function withAllRows(decisions: SettingsDecisions, decision: \"replace\" | \"omit\"): SettingsDecisions {\n  const { rows: _rows, ...rest } = decisions;", "export function withAllRows(decisions: SettingsDecisions, decision: \"replace\" | \"omit\"): SettingsDecisions {\n  const { ..._rows } = decisions; const rest = { ...decisions };", "«Reemplazar todos» / «Omitir todos» valen para todos", NEW),
    ("H808", CARDS, "{row.sensitive ? (\n                      <p", "{false ? (\n                      <p", "lo sensible se marca en la fila", NEW),
    ("H809", GP, "    settingsWanted += countSettingWrites(plans.settings, decisions.settings);", "    settingsWanted += plans.settings.items.length;", "el boton cuenta lo decidido, no todo", NEW),
    # --- H9: pruebas debiles ---
    ("H901", SIGS, "    if (!item.entry || !revalidate(item.entry)) return { ok: false, reason: \"invalid\" };", "    if (!item.entry) return { ok: false, reason: \"invalid\" };", "aplicar revalida cada firma del plan", NEW),
    ("H902", COMMIT, "          rev: current.rev + 1,", "          rev: current.rev,", "reemplazar una plantilla sube su rev", NEW),
    ("H903", COMMIT, "            rev: target.rev + 1,\n          };\n          bytesTotal", "            rev: target.rev,\n          };\n          bytesTotal", "reemplazar el PDF de un documento sube su rev", NEW),
    ("H904", COMMIT, "const bumped: DocumentEntry = { ...target, rev: target.rev + 1 };", "const bumped: DocumentEntry = { ...target };", "anadir plantillas a un documento sube su rev", NEW),
    # --- cerrar durante la importacion ---
    ("C01", SHEET, "      if (closeLockedRef.current) {", "      if (false) {", "una hoja bloqueada no se cierra", NEW),
    ("C02", IMPORT, "      closeLocked={applying}", "      closeLocked={false}", "la hoja de importar se bloquea mientras se aplica", NEW),
]

BROKEN_MARKERS = ("Transform failed", "Failed to parse source", "Pre-transform error")


def run_tests(tests):
    """True si las pruebas PASAN (la mutacion sobrevive). Si el codigo mutado ni compila, aborta: esa mutacion no vale."""
    result = subprocess.run(["npx", "vitest", "run", *tests, "--bail", "1"], cwd=ROOT, capture_output=True, text=True)
    output = result.stdout + result.stderr
    if result.returncode != 0 and any(marker in output for marker in BROKEN_MARKERS):
        raise RuntimeError("la mutacion no compila (no cuenta como muerta)")
    return result.returncode == 0


def main() -> int:
    wanted = set(sys.argv[1:])
    selected = [m for m in MUTATIONS if not wanted or m[0] in wanted]
    for group in (NEW, LARGE):
        if any(m[5] is group for m in selected) and not run_tests(group):
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
            path.write_text(original.replace(old, new, 1), encoding="utf8")
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
