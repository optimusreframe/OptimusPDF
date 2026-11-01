#!/usr/bin/env python3
"""
Mutaciones de la interfaz del autorrelleno desde documentos (unidad E2: hoja «Rellenar con datos del cliente», perfil del
cliente y su respaldo): aplica de una en una cambios pequenos a la logica (esquema y saneado, almacen de perfiles, modelo de la
hoja: que viene marcado, pisado, deshacer, origen del dato; maquina de estados, boton, modulo del respaldo, limpieza de datos) y
comprueba que las pruebas de Vitest fallan. Una mutacion que NO hace fallar ninguna prueba «sobrevive» y senala una prueba que
falta. Mismo patron que `scripts/scan-ui-mutate.py`.

Uso (desde la raiz del repo, con node_modules instalado):
    python3 scripts/autofill-ui-mutate.py            # todas
    python3 scripts/autofill-ui-mutate.py M07 M12    # solo esas

Los archivos se restauran siempre al terminar (tambien con Ctrl+C). No toca git.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = "src/app/sign-pdf/autofill/"
SCHEMA = "src/lib/clientProfile/schema.ts"
STORE = "src/lib/clientProfile/store.ts"
MODEL = UI + "model.ts"
FLOW = UI + "useAutofillFlow.ts"
LAUNCHER = UI + "AutofillLauncher.tsx"
BODY = UI + "AutofillBody.tsx"
SERVICES = UI + "autofillServices.ts"
REVIEW = UI + "ReviewStep.tsx"
MODULE = "src/lib/backup/modules/clientProfiles.ts"
GLOBAL = "src/lib/backup/globalPackage.ts"
CLEAR = "src/app/sign-pdf/clearLocalSignData.ts"
REGISTRY = "src/lib/backup/settingsRegistry.ts"
SHEET_EXPORT = "src/app/settings/ExportPackageSheet.tsx"

T_SCHEMA = ["src/lib/clientProfile/schema.test.ts"]
T_STORE = ["src/lib/clientProfile/store.test.tsx"]
T_MODEL = [UI + "model.test.ts"]
T_LAUNCHER = [UI + "AutofillLauncher.test.tsx"]
T_MODULE = ["src/lib/backup/modules/clientProfiles.test.tsx", "src/lib/backup/modules/clientProfiles.hostile.test.tsx"]
T_GOLDEN = ["src/lib/backup/goldenPackages.clientProfiles.test.tsx"]
T_GLOBAL = ["src/lib/backup/globalPackage.clientProfiles.dom.test.tsx"]
T_SHEETS = ["src/app/settings/PackageSheets.clientProfiles.test.tsx"]
T_CLEAR = ["src/app/sign-pdf/clearClientProfiles.test.tsx"]
T_REGISTRY = ["src/lib/backup/settingsRegistry.test.ts"]

# (id, archivo, texto original, texto mutado, descripcion, pruebas que deben matarla). El original debe aparecer.
MUTATIONS = [
    # --- Esquema y saneado (lo comparten el almacen y el respaldo) ---
    ("M01", SCHEMA, "if (raw.profiles.length > MAX_CLIENT_PROFILES) return { ok: false };", "if (raw.profiles.length > MAX_CLIENT_PROFILES + 1) return { ok: false };", "esquema: mas de 20 perfiles es un origen hostil", T_SCHEMA),
    ("M02", SCHEMA, "if (keys.length > MAX_PROFILE_VALUES) return { ok: false };", "if (keys.length > MAX_PROFILE_VALUES + 5) return { ok: false };", "esquema: mas de 40 valores en un perfil es un origen hostil", T_SCHEMA),
    ("M03", SCHEMA, " && !(key in Object.prototype) && key !== \"prototype\";", " && key !== \"prototype\";", "claves: las que chocan con el prototipo (constructor, toString…) no se guardan", T_SCHEMA),
    ("M04", SCHEMA, " && !(key in Object.prototype) && key !== \"prototype\";", " && !(key in Object.prototype);", "claves: `prototype` tampoco", T_SCHEMA),
    ("M05", SCHEMA, "const BIDI = /[\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g;", "const BIDI = /[\\u061c\\u200e\\u200f\\u202a-\\u202d\\u2066-\\u2069]/g;", "texto: se quitan las marcas de direccion (U+202E incluida)", T_SCHEMA + T_MODULE),
    ("M06", SCHEMA, ".replace(/\\s+/g, \" \")", ".replace(/[ ]{2,}/g, \" \")", "texto: tabuladores y saltos se juntan en un espacio", T_SCHEMA + T_MODULE),
    ("M07", SCHEMA, "export const MIN_PROFILE_VALUE_CHARS = 2;", "export const MIN_PROFILE_VALUE_CHARS = 1;", "valores: uno de 1 caracter no se guarda", T_SCHEMA + T_STORE),
    ("M08", SCHEMA, "|| seen.has(id)) {", ") {", "esquema: un id repetido se descarta", T_SCHEMA + T_MODULE),
    ("M09", SCHEMA, "if (source !== \"extracted\" && source !== \"typed\") return null;", "if (source !== \"extracted\") return null;", "valores: el origen `typed` es valido", T_SCHEMA + T_GOLDEN),
    ("M10", SCHEMA, "if (!isRecord(raw) || raw.version !== CLIENT_PROFILES_SCHEMA || !Array.isArray(raw.profiles)) return { ok: false };", "if (!isRecord(raw) || !Array.isArray(raw.profiles)) return { ok: false };", "esquema: una version interna distinta se rechaza", T_SCHEMA + T_MODULE),
    # --- Almacen ---
    ("M11", STORE, "if (current.length >= MAX_CLIENT_PROFILES) return { ok: false, reason: \"full\" };", "if (current.length > MAX_CLIENT_PROFILES) return { ok: false, reason: \"full\" };", "almacen: el perfil 21 no entra (y no borra ninguno)", T_STORE),
    ("M12", STORE, "const merged = { ...existing.values, ...values };", "const merged = { ...values };", "almacen: guardar con el mismo nombre conserva los demas valores", T_STORE),
    ("M13", STORE, "return name.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g, \"\").toLowerCase();", "return name.toLowerCase();", "almacen: el mismo nombre se reconoce sin tildes", T_STORE),
    ("M14", STORE, "if (Object.keys(rest).length === 0) return { ok: deleteClientProfile(id), profileDeleted: true };", "", "almacen: quitar el ultimo valor borra el perfil", T_STORE),
    ("M15", STORE, "{ value: clean, updatedAt: at, source: \"typed\" as const }", "{ value: clean, updatedAt: at, source: \"extracted\" as const }", "almacen: un valor corregido queda como escrito a mano", T_STORE),
    ("M16", STORE, "    cache = null;\n    emit();\n  });", "    emit();\n  });", "almacen: otra pestana cambia los datos y la cache se relee", T_STORE),
    ("M17", STORE, "  cache = EMPTY;\n  emit();\n  return true;", "  emit();\n  return true;", "almacen: «Borrar datos» deja la lista vacia en vivo", T_STORE),
    ("M18", STORE, "if (expectRaw !== undefined && before !== expectRaw) return \"changed\";", "", "almacen: no se escribe si lo guardado ya no es lo que vio la vista previa", T_STORE + T_MODULE),
    ("M19", STORE, "named.name === \"QuotaExceededError\" || ", "", "almacen: sin espacio se dice `quota`", T_STORE + T_MODULE),
    ("M20", STORE, "  cache = null;\n  return snapshot();", "  return snapshot();", "almacen: el respaldo decide con lo que hay AHORA, no con la cache", T_MODULE),
    # --- Modelo de la hoja ---
    ("M21", MODEL, "out[group.key] = highs.length === 1 ? highs[0].id : null;", "out[group.key] = highs.length >= 1 ? highs[0].id : null;", "marcado: dos valores seguros distintos NO se marcan solos", T_MODEL + T_LAUNCHER),
    ("M22", MODEL, "if (!unique.some((other) => comparable(other.value) === comparable(item.value))) unique.push(item);", "unique.push(item);", "agrupar: el mismo valor leido dos veces es uno solo", T_MODEL + T_LAUNCHER),
    ("M23", MODEL, "return TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.confidence - a.confidence;", "return b.confidence - a.confidence;", "agrupar: lo de confianza alta va antes que lo de revisar", T_MODEL),
    ("M24", MODEL, "if (comparable(current) === comparable(writeValue) && current !== \"\") continue;", "", "filas: un campo que ya dice lo mismo no es una fila", T_MODEL + T_LAUNCHER),
    ("M25", MODEL, "out[row.field.id] = !overwritesText(row) && !row.invalidDate;", "out[row.field.id] = !row.invalidDate;", "pisado: un campo con texto viene SIN marcar", T_MODEL + T_LAUNCHER),
    ("M26", MODEL, "|| (row.current !== \"\" && comparable(row.current) !== comparable(row.writeValue));", ";", "pisado: la interfaz no se fia solo del `overwrites` del motor", T_MODEL),
    ("M27", MODEL, "invalidDate: isDate && iso === null,", "invalidDate: false,", "fechas: un valor que no es una fecha escribible no se escribe en un campo de fecha", T_MODEL + T_LAUNCHER),
    ("M69", MODEL, "return isoOf(Number(match[3]), locale === \"es\" ? second : first, locale === \"es\" ? first : second);", "return isoOf(Number(match[3]), first, second);", "fechas: dd/mm/aaaa en espanol, mm/dd/aaaa en ingles", T_MODEL + T_LAUNCHER),
    ("M70", MODEL, "const last = new Date(Date.UTC(year, month, 0)).getUTCDate();\n  if (day > last) return null;", "", "fechas: 31/02 no es una fecha", T_MODEL),
    ("M71", MODEL, "written[row.field.id] = row.writeValue;", "written[row.field.id] = row.proposal.value;", "fechas: el campo de fecha guarda el ISO, no el texto del motor", T_MODEL + T_LAUNCHER),
    ("M28", MODEL, "if (!aliveFieldIds.has(id) || next[id] !== wrote) continue;", "if (!aliveFieldIds.has(id)) continue;", "deshacer: no pisa lo que la persona cambio despues del relleno", T_MODEL),
    ("M29", MODEL, "if (!aliveFieldIds.has(id) || next[id] !== wrote) continue;", "if (next[id] !== wrote) continue;", "deshacer: un campo borrado no resucita", T_MODEL),
    ("M30", MODEL, "if (row.invalidDate || checked[row.field.id] !== true) continue;", "if (row.invalidDate || checked[row.field.id] === false) continue;", "rellenar: solo las filas marcadas", T_MODEL),
    ("M31", MODEL, "sources[item.key] = corrected ? \"typed\" : \"extracted\";", "sources[item.key] = \"extracted\";", "perfil: un valor corregido se guarda como escrito a mano", T_MODEL + T_LAUNCHER),
    ("M32", MODEL, "const dataKey = dataKeys && Object.prototype.hasOwnProperty.call(dataKeys, field.id) ? dataKeys[field.id] : undefined;", "const dataKey = dataKeys?.[field.id];", "destinos: el dataKey no sale de la cadena de prototipos", T_MODEL),
    ("M33", MODEL, "return type === \"text\" || type === \"date\";", "return type !== \"checkbox\";", "destinos: ni casillas ni iniciales", T_MODEL + T_LAUNCHER),
    ("M34", MODEL, "return accepted.find((item) => item.key === \"insuredName1\")?.value ?? \"\";", "return accepted.find((item) => item.key === \"insuredName2\")?.value ?? \"\";", "perfil: se propone el nombre del asegurado", T_MODEL + T_LAUNCHER),
    ("M61", MODEL, "while (seen.has(id)) id = `${item.id}#${index}`;", "", "agrupar: ids unicos aunque el motor repita uno", T_MODEL),
    # --- Maquina de estados ---
    ("M35", FLOW, "export const MAX_SOURCES = 10;", "export const MAX_SOURCES = 100;", "fuentes: tope de 10 a la vez", T_LAUNCHER),
    ("M36", FLOW, "export const MAX_SOURCE_MB = 60;", "export const MAX_SOURCE_MB = 600;", "fuentes: tope de peso por archivo", T_LAUNCHER),
    ("M37", FLOW, "if (saveOn && accepted.length > 0 && !fromProfile) {", "if (false) {", "perfil: «Guardar como perfil» guarda al rellenar", T_LAUNCHER),
    ("M38", FLOW, "        setProfileError(profileFailureText(result.reason));\n        return;", "        setProfileError(profileFailureText(result.reason));", "perfil: si no se puede guardar NO se rellena a medias", T_LAUNCHER),
    ("M39", FLOW, "openReview(profileItems(profile), profile);", "openReview(profileItems(profile), null);", "perfil: con un perfil elegido no se ofrece volver a guardarlo", T_LAUNCHER),
    ("M40", FLOW, "  const cancel = useCallback(() => {\n    abortRef.current?.abort();\n  }, []);", "  const cancel = useCallback(() => {}, []);", "leer: «Cancelar» corta la lectura (senal de aborto)", T_LAUNCHER),
    ("M41", FLOW, "      runRef.current += 1;\n      abortRef.current?.abort();\n    },\n    [],\n  );", "      runRef.current += 1;\n    },\n    [],\n  );", "leer: cerrar la hoja cancela la lectura", T_LAUNCHER),
    # --- Modelo de lectura (OCR): el motor nunca lo descarga ---
    ("M62", FLOW, "if (!skip && sent.some((entry) => entry.kind === \"image\")) {", "if (false) {", "OCR: con fotos y sin modelo se pregunta ANTES de leer", T_LAUNCHER),
    ("M63", FLOW, "const sent = skip ? entries.filter((entry) => entry.kind !== \"image\") : entries;", "const sent = entries;", "OCR: «Leer sin las fotos» no manda las fotos al motor", T_LAUNCHER),
    ("M64", FLOW, "setOfferModel(result.warnings.some((warning) => warning.code === \"ocr-unavailable\"));", "setOfferModel(false);", "OCR: un PDF escaneado (aviso del motor) ofrece descargar el modelo y volver a leer", T_LAUNCHER),
    ("M65", FLOW, "if (outcome.reason !== \"cancelled\") {", "if (true) {", "OCR: cancelar la descarga no se presenta como un fallo", T_LAUNCHER),
    ("M66", BODY, "{flow.entries.some((entry) => entry.kind !== \"image\") ? (", "{true ? (", "OCR: «Leer sin las fotos» solo si hay algo que no es una foto", T_LAUNCHER),
    ("M67", SERVICES, "if (hook) return hook.ocrModelAvailable().catch(() => false);", "if (hook) return hook.ocrModelAvailable();", "OCR: si no se puede saber si hay modelo, se supone que no", T_LAUNCHER),
    ("M68", FLOW, "setSkippedPhotos(entries.length - sent.length);", "setSkippedPhotos(0);", "OCR: la revision dice cuantas fotos no se leyeron", T_LAUNCHER),
    # --- Boton y revision ---
    ("M43", LAUNCHER, "setLast(result.count > 0 ? result.patch : null);", "setLast(null);", "boton: tras rellenar queda «Deshacer»", T_LAUNCHER),
    ("M44", LAUNCHER, "if (fillableFields(textFields).length === 0) return null;", "", "boton: solo si el documento tiene campos de texto", T_LAUNCHER),
    ("M45", LAUNCHER, "initialFocus=\"[data-autofill-initial]\"", "", "foco: al abrir entra en la hoja (primer control)", T_LAUNCHER),
    ("M46", REVIEW, "{high ? strings.confidenceHigh : strings.confidenceReview}", "{high ? strings.confidenceReview : strings.confidenceHigh}", "revisar: la confianza se dice bien, con texto", T_LAUNCHER),
    ("M47", REVIEW, "{flow.warnings.length > 0 || flow.skippedPhotos > 0 ? (", "{false ? (", "revisar: los avisos del motor se muestran", T_LAUNCHER),
    # --- Modulo del respaldo ---
    ("M48", MODULE, "else if (item.status === \"different\") out[item.key] = item.conflictWith && !item.conflictWith.newer ? \"replace\" : \"keepBoth\";", "else if (item.status === \"different\") out[item.key] = \"replace\";", "respaldo: lo mas nuevo local jamas se pisa por defecto", T_MODULE + T_SHEETS),
    ("M49", MODULE, ".filter(({ decision }) => decision !== \"replace\").length;", ".length;", "respaldo: reemplazar no ocupa un sitio mas", T_MODULE),
    ("M50", MODULE, "if (!limits.ok) return { ok: false, reason: \"limit\", limits };", "", "respaldo: lo que no cabe se rechaza antes de escribir", T_MODULE + T_GLOBAL),
    ("M51", MODULE, "const outcome = replaceClientProfiles(next, plan.local.raw);", "const outcome = replaceClientProfiles(next, undefined);", "respaldo: un cambio de otra pestana durante la revision se detecta", T_MODULE),
    ("M52", MODULE, "const status: ClientProfileItemStatus = !mine ? \"new\" : sameClientProfile(mine, profile) ? \"identical\" : \"different\";", "const status: ClientProfileItemStatus = !mine ? \"new\" : \"different\";", "respaldo: lo identico se dice «ya lo tienes»", T_MODULE + T_GOLDEN),
    ("M53", MODULE, "next.push({ ...profile, id: newProfileId(), name });", "next.push({ ...profile, name });", "respaldo: «Conservar ambos» crea un perfil con id nuevo", T_MODULE),
    ("M54", STORE, "if (!checked.ok || checked.profiles.length !== profiles.length) return \"unavailable\";", "", "respaldo: lo que se escribe es lo saneado, nunca el objeto recibido", T_STORE),
    ("M55", GLOBAL, "const containsClientData = includesDrafts || includesScan || includesHistory || includesProfiles;", "const containsClientData = includesDrafts || includesScan || includesHistory;", "respaldo: los perfiles son datos de clientes (se recomienda cifrar)", T_GLOBAL),
    ("M56", GLOBAL, "scanSessions: scanSessions?.wanted ?? 0, clientProfiles: clientProfiles?.wanted ?? 0,", "scanSessions: scanSessions?.wanted ?? 0, clientProfiles: 0,", "respaldo: el boton «Importar N elementos» cuenta los perfiles", T_GLOBAL + T_SHEETS),
    ("M57", SHEET_EXPORT, "if (name === \"clientProfiles\" && on && capabilities && capabilities.profileIds.every((id) => profilesExcluded.includes(id))) setProfilesExcluded([]);", "", "respaldo: volver a marcar «Perfiles» tras quitarlos todos los ofrece todos", T_SHEETS),
    # --- Borrar datos ---
    ("M58", CLEAR, "const profilesCleared = clearClientProfiles();", "const profilesCleared = true;", "borrar datos: tambien se borran los perfiles (y no se dice «borrado» si falla)", T_CLEAR),
    ("M59", CLEAR, "if (!profilesCleared) failed.push(\"clientProfiles\");", "", "borrar datos: un perfil que no se pudo borrar se dice", T_CLEAR),
    ("M60", REGISTRY, "  \"optimuspdf.clientProfiles\",\n", "", "ajustes: la clave de los perfiles NO viaja en «Ajustes» (tiene su modulo)", T_REGISTRY),
]


def run_tests(tests) -> bool:
    """True si las pruebas PASAN (la mutacion sobrevive)."""
    result = subprocess.run(
        ["npx", "vitest", "run", "--project", "engines", "--project", "components", *tests],
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
