#!/usr/bin/env python3
"""
Mutaciones del «OptimusPDF Package» global y de «Respaldo y traslado» (U4.7 + U4.8): aplica de una en una cambios pequenos
a la logica (orquestacion, recordatorio de 30 dias / 10 cambios, modelo de pantalla, hojas, aviso y foco) y comprueba que las
pruebas fallan. Una mutacion que NO hace fallar ninguna prueba «sobrevive» y senala una prueba que falta.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/global-package-mutate.py            # todas
    python3 scripts/global-package-mutate.py G01 R04    # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GP = "src/lib/backup/globalPackage.ts"
REM = "src/lib/backup/backupReminder.ts"
LAST = "src/lib/backup/lastBackup.ts"
REG = "src/lib/backup/settingsRegistry.ts"
VAULT = "src/app/sign-pdf/signVault.ts"
STORE = "src/lib/docLibrary/store.ts"
MODEL = "src/app/settings/packageModel.ts"
EXPORT = "src/app/settings/ExportPackageSheet.tsx"
IMPORT = "src/app/settings/ImportPackageSheet.tsx"
CARDS = "src/app/settings/PackageItemCards.tsx"
SECTION = "src/app/settings/BackupSection.tsx"
REMC = "src/app/settings/BackupReminder.tsx"
HOOK = "src/app/settings/useBackupReminder.ts"
FOCUS = "src/app/settings/focusFallback.ts"

# (id, archivo, texto original, texto mutado, descripcion). El original debe aparecer; se reemplazan TODAS sus apariciones.
MUTATIONS = [
    # --- orquestacion (globalPackage.ts) ---
    ("G01", GP, 'export const PACKAGE_MODULES: readonly PackageModuleName[] = ["signatures", "library", "drafts", "settings"];', 'export const PACKAGE_MODULES: readonly PackageModuleName[] = ["settings", "signatures", "library", "drafts"];', "orden fijo: ajustes el ultimo"),
    ("G02", GP, "return `OptimusPDF-paquete-${date.getFullYear()}-", "return `paquete-${date.getFullYear()}-", "nombre OptimusPDF-paquete-AAAA-MM-DD"),
    ("G04", GP, "exportSettings({ includeValueHistory: options.includeValueHistory === true })", "exportSettings({ includeValueHistory: true })", "el historial de valores NO viaja salvo que se pida"),
    ("G05", GP, "if (count === 0 && !history) omitted.push", "if (false) omitted.push", "ajustes vacios se omiten con aviso"),
    ("G06", GP, "if (!read.modules.some((module) => PACKAGE_MODULES.includes(module.name as PackageModuleName))) {", "if (false) {", "paquete sin modulos conocidos se dice"),
    ("G07", GP, 'if (drafts && !drafts.ok) blocked.push("drafts");', "", "limites de borradores bloquean antes de importar"),
    ("G08", GP, "ok: blocked.length === 0,", "ok: true,", "ok solo si todos los modulos caben"),
    ("G10", GP, 'reloadRequired: outcomes.some((item) => item.module === "settings" && item.status === "applied" && item.reloadRequired),', "reloadRequired: false,", "aplicar ajustes pide recargar"),
    ("G12", GP, 'if (!plan || plan.state !== "ok") outcomes.push({ module: "settings", status: "skipped"', 'if (!plan) outcomes.push({ module: "settings", status: "skipped"', "modulo de version mas nueva se salta"),
    ("G13", GP, "|| (includesDrafts && !draftsInfo.fitsInPackage),", ",", "borradores que no caben en un paquete"),
    ("G14", GP, "encryptionRecommended: containsSignatures || containsClientData,", "encryptionRecommended: containsClientData,", "firmas piden cifrar"),
    ("G15", GP, "const draftsIncludeStrokes = drafts.ok && kind(\"sign\") && drafts.includesSignatureStrokes && strokesWanted;", "const draftsIncludeStrokes = drafts.ok && kind(\"sign\") && drafts.includesSignatureStrokes;", "quitar los trazos los saca del resumen"),
    ("G16", GP, "modules: { signatures: true, library: true, drafts: true }", "modules: { signatures: true, library: true, drafts: true, settings: true }", "los ajustes solos no cuentan para el recordatorio"),
    ("G18", GP, "const strokesWanted = options.includeStrokes !== false;", "const strokesWanted = true;", "includeStrokes: false quita los trazos"),
    # --- recordatorio ---
    ("R01", REM, "export const REMINDER_AFTER_DAYS = 30;", "export const REMINDER_AFTER_DAYS = 31;", "30 dias"),
    ("R02", REM, "export const REMINDER_AFTER_CHANGES = 10;", "export const REMINDER_AFTER_CHANGES = 11;", "10 cambios"),
    ("R03", REM, "export const SNOOZE_DAYS = 7;", "export const SNOOZE_DAYS = 8;", "«Recordármelo luego» = 7 dias"),
    ("R04", REM, 'const reason: ReminderReason | null = byChanges ? "changes" : byDays ? "days" : null;', 'const reason: ReminderReason | null = byDays ? "days" : byChanges ? "changes" : null;', "con cambios y dias manda «cambios»"),
    ("R05", REM, "return { due: reason !== null && !snoozed,", "return { due: reason !== null,", "pospuesto no avisa"),
    ("R06", REM, "changes: Math.min(state.changes + 1, MAX_REMINDER_CHANGES),", "changes: Math.min(state.changes + 2, MAX_REMINDER_CHANGES),", "cada cambio suma uno"),
    ("R07", REM, "since: state.since ?? now.toISOString(),", "since: now.toISOString(),", "el comienzo de los 30 dias se fija una sola vez"),
    ("R08", REM, "  if (backupCoverageDate() !== null) return;\n  const state = readReminderState();", "  const state = readReminderState();", "no se ancla el reloj si ya hubo respaldo"),
    ("R09", REM, "const anchor = lastBackup ?? (state.since ? new Date(state.since) : null);", "const anchor = lastBackup;", "sin respaldo los dias se cuentan desde el primer cambio"),
    ("R10", LAST, "    window.localStorage.removeItem(BACKUP_REMINDER_KEY);", "    void BACKUP_REMINDER_KEY;", "hacer un respaldo reinicia el contador"),
    ("R11", VAULT, "if (!result.duplicate) noteBackupRelevantChange(undefined, \"signatures\");", "noteBackupRelevantChange(undefined, \"signatures\");", "repetir una firma no cuenta como cambio"),
    ("R12", STORE, "  noteBackupRelevantChange(undefined, \"library\");\n  ensureSignals();", "  ensureSignals();", "los cambios de la biblioteca cuentan"),
    ("R13", REG, '  "optimuspdf.backupReminder",\n', "", "la clave del recordatorio esta clasificada como NO exportable"),
    ("R14", HOOK, "if (alive) setVisible(has);", "if (alive) setVisible(true);", "solo se avisa si hay algo que respaldar"),
    # --- modelo de pantalla ---
    ("M01", MODEL, "if (options.includeValueHistory && description.settings.valueHistoryLabels > 0) parts.push(copy.summaryHistory);", "if (description.settings.valueHistoryLabels > 0) parts.push(copy.summaryHistory);", "el resumen nombra el historial solo si va"),
    ("M02", MODEL, 'return item.canKeepBoth ? ["replace", "keepBoth", "omit"] : ["replace", "omit"];', 'return ["replace", "keepBoth", "omit"];', "conservar ambos solo en Firmar"),
    ("M03", MODEL, "if (anyFailed && anyApplied) lines.push(", "if (anyFailed) lines.push(", "lo ya importado se conserva solo si algo se aplico"),
    ("M04", MODEL, 'return outcome.why === "absent" ? null :', "return null; // ", "un modulo que no se pudo importar tiene su linea"),
    ("M05", MODEL, "settings: description.settings.keys > 0,", "settings: true,", "ajustes marcados solo si hay ajustes"),
    # --- hojas, tarjetas, aviso y foco ---
    ("U01", EXPORT, "const protect = protectChoice ?? recommended;", "const protect = protectChoice ?? true;", "contraseña marcada por defecto solo si hay firmas o datos de clientes"),
    ("U02", EXPORT, "const [history, setHistory] = useState(false);", "const [history, setHistory] = useState(true);", "historial de valores desmarcado por defecto"),
    ("U03", EXPORT, "    markLastBackup(new Date(), { traveled: entry.included, empty: emptyPartsRef.current.filter((name) => !entry.included.includes(name)) });\n", "    void emptyPartsRef;\n", "anotar el ultimo respaldo al terminar"),
    ("U04", EXPORT, 'else if (outcome === "cancelled") setError(copy.shareCancelled);', 'else if (outcome === "cancelled") finish(ready);', "cerrar la hoja de compartir no cuenta como exportado"),
    ("U05", IMPORT, 'disabled={phase === "importing" || limits.wanted === 0 || !limits.ok}', 'disabled={phase === "importing"}', "boton bloqueado si no hay nada o no caben"),
    ("U06", IMPORT, 'if (read.reason === "wrongPassword") {', "if (false) {", "contraseña incorrecta deja reintentar"),
    ("U07", IMPORT, "{result.outcome.reloadRequired ? (", "{false ? (", "aviso «Recarga para aplicar los ajustes»"),
    ("U08", REMC, "if (snooze()) announce(copy.reminderLaterDone);", "if (snooze()) void copy.reminderLaterDone;", "posponer se anuncia"),
    ("U09", SECTION, "lastBackupLine(lastBackup.full, lastBackup.parts, copy)", "copy.lastNever", "la seccion muestra el ultimo respaldo"),
    ("U10", CARDS, '{item.status !== "invalid" && item.hasStrokes ? (', "{false ? (", "«Contiene tu firma» en los borradores con trazos"),
    ("U11", FOCUS, "if (!active || active === document.body) target()?.focus({ preventScroll: true });", "void target;", "el foco no se pierde en <body>"),
    ("U12", IMPORT, "setDecisions(defaultEverythingDecisions(read.plans));", 'setDecisions({ signatures: {}, library: {}, drafts: {}, settings: { settings: "omit", valueHistory: "omit" } });', "decisiones sugeridas al abrir la vista previa"),
]

# Mutaciones EQUIVALENTES (retiradas de la lista: el resultado observable no cambia, solo CUANDO se comprueba):
#  - G03: quitar el rechazo temprano por tamano (`describeExport().tooLarge`): lo mismo lo vuelve a rechazar `exportDraftsDetailed`
#    / `buildPackage` con `tooLarge` (solo se pierde el ahorro de no leer los PDF);
#  - G09: ajustes sin nada aprobado sin saltar la llamada: `applySettingsImport` con «Omitir» devuelve 0 escritos = «nada»;
#  - G11: biblioteca sin cambios con estado «applied»: un resultado con cero escrituras no ocurre con elementos aprobados;
#  - G17: quitar el aviso temprano de cifrado no disponible: `buildPackage` lanza `unavailable` y se traduce al mismo motivo.

TEST_ARGS = [
    "npx",
    "vitest",
    "run",
    "src/lib/backup/globalPackage",
    "src/lib/backup/backupReminder",
    "src/lib/backup/goldenPackages",
    "src/lib/backup/settingsRegistry",
    "src/lib/docLibrary/store.test",
    "src/app/settings",
    "--bail",
    "1",
]

# (`SyntaxError` suelto NO es un marcador: lo imprime tambien un JSON.parse de una prueba que falla de verdad.)
BROKEN_MARKERS = ("Transform failed", "Failed to parse source", "Pre-transform error")


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
