/**
 * Nombres unicos para las entradas de un ZIP. Modulo sin dependencias (ni jszip) para que lo usen
 * los motores que solo cargan jszip bajo demanda (split) sin arrastrarlo al paquete inicial.
 */

/**
 * Opciones de `uniqueZipName`. Por defecto reproducen el comportamiento de
 * siempre (comparacion exacta, contador desde 1) que usa `pdfsToZip`.
 */
export type UniqueZipNameOptions = {
  /** Primer contador a probar. Por defecto 1 (`a (1).pdf`). */
  startAt?: number;
  /**
   * Clave con la que se compara `used`. Por defecto el propio nombre. Para
   * extractores que no distinguen mayusculas (Windows/macOS) o que
   * normalizan Unicode, quien llama pasa `minusculas + NFC`; en ese caso
   * `used` guarda CLAVES, no nombres.
   */
  key?: (name: string) => string;
};

/**
 * Devuelve un nombre que no colisiona con `used`. jszip sobrescribiria en
 * silencio una entrada anterior con el mismo nombre (`zip.file("a.pdf", …)`
 * dos veces deja solo la segunda), asi que los duplicados de entrada se
 * desambiguan aqui ANTES de llamar a `zip.file()`: `informe.pdf` ->
 * `informe (1).pdf`, `informe (2).pdf`, etc.
 */
export function uniqueZipName(
  name: string,
  used: Set<string>,
  options: UniqueZipNameOptions = {},
): string {
  const keyOf = options.key ?? ((value: string) => value);
  if (!used.has(keyOf(name))) {
    used.add(keyOf(name));
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";

  let counter = options.startAt ?? 1;
  let candidate = `${base} (${counter})${extension}`;
  // Con tope: nunca se itera sin limite, ni siquiera si `key` colapsa nombres distintos.
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS && used.has(keyOf(candidate)); attempt += 1) {
    counter += 1;
    candidate = `${base} (${counter})${extension}`;
  }
  if (used.has(keyOf(candidate))) candidate = `${base} (${counter}-${used.size + 1})${extension}`;
  used.add(keyOf(candidate));
  return candidate;
}

/** Intentos maximos de `uniqueZipName` antes de saltar a un contador seguro. */
const MAX_NAME_ATTEMPTS = 10_000;

/** Clave de comparacion para nombres de entrada de un ZIP: minusculas y Unicode NFC (Windows/macOS no distinguen). */
export function zipNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
