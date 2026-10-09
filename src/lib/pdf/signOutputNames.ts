import { withSuffix } from "@/lib/pdf/core";

/**
 * Nombres de los archivos que entrega "Firmar PDF" (PDF unico y ZIP de
 * varios documentos). Modulo puro, sin DOM ni React.
 *
 * Formato: `<firmantes> - <documento>-firmado.pdf`. Los firmantes son los
 * que aplican a ESE documento; sin firmantes queda `<documento>-firmado.pdf`.
 *
 * Por que NO se usa `slugify` (core.ts): destruye acentos y mayusculas
 * ("Ana Pérez" -> "ana-perez"), y aqui el nombre es lo que el usuario ve y
 * reconoce en su carpeta. Lo unico que se retira es lo que ningun sistema
 * de archivos admite o lo que sirve para falsear un nombre.
 */

export type NameLang = "es" | "en";

/** Sufijo antes de la extension. Mismo valor que `filenameSuffix` de sign-pdf/strings.ts. */
const SIGNED_SUFFIX: Record<NameLang, string> = {
  es: "firmado",
  en: "signed",
};

/** Limites del nombre (ver plan Wave 4). */
export const MAX_SIGNERS_PART_CHARS = 50;
export const MAX_DOCUMENT_PART_CHARS = 80;
export const MAX_ENTRY_CHARS = 120;
export const MAX_ENTRY_BYTES = 200;

const ELLIPSIS = "…";
const SEPARATOR = " - ";

/** Menos que esto no se recorta el documento antes de empezar a recortar los firmantes. */
const MIN_DOCUMENT_CHARS = 12;

/* ------------------------------------------------------------------ *
 * Saneado
 * ------------------------------------------------------------------ */

/** Controles C0/C1 (incluye tab y saltos de linea) y DEL. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * Invisibles que falsean nombres: marcas y anulaciones bidireccionales
 * (U+202E "RLO" invierte la extension a la vista), espacio de ancho cero,
 * BOM y separadores de linea/parrafo. U+200C/U+200D (ZWNJ/ZWJ) se
 * conservan: son parte legitima de emoji compuestos y de alfabetos como el
 * persa.
 */
const INVISIBLE_CHARS =
  /[\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
/** Reservados de Windows/NTFS y comodines de Unix que rompen rutas y extractores. */
const FORBIDDEN_CHARS = /[\\/:*?"<>|]/g;
/** Sustitutos sueltos (UTF-16 mal formado): romperian TextEncoder y el ZIP. */
const LONE_SURROGATES =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

/**
 * Deja una cadena usable como PARTE de un nombre de archivo:
 * NFC, sin controles ni caracteres prohibidos, espacios colapsados, sin
 * puntos ni espacios en los extremos y sin nombres reservados de Windows
 * (`CON` -> `CON_`). Conserva acentos, mayusculas, CJK y emoji. Puede
 * devolver "" (el que llama decide el valor de reserva).
 */
export function safeFilenamePart(value: string): string {
  let text = value
    .normalize("NFC")
    .replace(LONE_SURROGATES, "")
    .replace(CONTROL_CHARS, " ")
    .replace(INVISIBLE_CHARS, "")
    .replace(FORBIDDEN_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  // Puntos y espacios en los extremos (Windows los descarta; ".." es peligroso).
  text = text.replace(/^[.\s]+|[.\s]+$/g, "");
  if (text === "") return "";
  // Windows mira lo anterior al primer punto: "con.algo" tambien es CON.
  const stem = text.split(".")[0].trim();
  if (WINDOWS_RESERVED.test(stem)) text = `${text}_`;
  return text;
}

/* ------------------------------------------------------------------ *
 * Recorte por grafemas
 * ------------------------------------------------------------------ */

/**
 * Divide en unidades visibles (grafemas) para no partir un emoji
 * compuesto ni separar una letra de su acento al recortar. Si el entorno
 * no tiene `Intl.Segmenter`, cae a puntos de codigo.
 */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/** Recorta a `max` unidades visibles (la elipsis cuenta) y la deja sana. */
function truncate(text: string, max: number): string {
  const units = graphemes(text);
  if (units.length <= max) return text;
  if (max <= 1) return units.slice(0, Math.max(0, max)).join("");
  const head = units
    .slice(0, max - 1)
    .join("")
    .replace(/[.\s]+$/g, "");
  return `${head}${ELLIPSIS}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/* ------------------------------------------------------------------ *
 * Firmantes
 * ------------------------------------------------------------------ */

/**
 * "Ana" / "Ana y Luis" ("Ana and Luis") / "Ana, Luis +1".
 * Los nombres vacios (o que quedan vacios al sanear) se omiten y los
 * repetidos (sin distinguir mayusculas) cuentan una vez. El caso de mas
 * de dos solo aparece con datos heredados: el alta esta limitada a 2.
 */
export function joinSignerNames(names: readonly string[], lang: NameLang): string {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of names) {
    const part = safeFilenamePart(raw ?? "");
    if (part === "") continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(part);
  }
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) {
    return `${clean[0]} ${lang === "en" ? "and" : "y"} ${clean[1]}`;
  }
  return `${clean[0]}, ${clean[1]} +${clean.length - 2}`;
}

/* ------------------------------------------------------------------ *
 * Nombre del PDF firmado
 * ------------------------------------------------------------------ */

export type SignedFilenameInput = {
  signerNames: readonly string[];
  /** Nombre del documento original, con o sin `.pdf`. */
  documentName: string;
  lang: NameLang;
};

const DOCUMENT_FALLBACK: Record<NameLang, string> = {
  es: "documento",
  en: "document",
};

/** Quita `.pdf` (cualquier capitalizacion); otras "extensiones" (`v1.2`) se conservan. */
function documentStem(documentName: string): string {
  // `stripExtension` (core.ts) no quita nada en ".pdf" (punto en la posicion
  // 0) y quitaria el ".2" de "informe v1.2": aqui solo se retira ".pdf".
  return documentName.trim().replace(/\.pdf$/i, "");
}

/**
 * `<firmantes> - <documento>-firmado.pdf` (en: `-signed.pdf`) respetando:
 * firmantes <= 50 caracteres, documento <= 80, y el nombre completo
 * <= 120 caracteres y <= 200 bytes UTF-8. Cuando el total no cabe se
 * recorta primero el documento (hasta 12 caracteres) y despues los
 * firmantes; siempre con elipsis. Sin firmantes: `<documento>-firmado.pdf`.
 */
export function signedFilename(input: SignedFilenameInput): string {
  const { lang } = input;
  const suffix = SIGNED_SUFFIX[lang];
  const signers = joinSignerNames(input.signerNames, lang);
  const document =
    safeFilenamePart(documentStem(input.documentName)) || DOCUMENT_FALLBACK[lang];

  let maxSigners = MAX_SIGNERS_PART_CHARS;
  let maxDocument = MAX_DOCUMENT_PART_CHARS;

  const build = (): string => {
    const documentPart = truncate(document, maxDocument);
    const tail = withSuffix(`${documentPart}.pdf`, suffix);
    if (signers === "") return tail;
    return `${truncate(signers, maxSigners)}${SEPARATOR}${tail}`;
  };

  let result = build();
  // Cada vuelta quita al menos una unidad: termina siempre.
  while (
    (graphemes(result).length > MAX_ENTRY_CHARS ||
      byteLength(result) > MAX_ENTRY_BYTES) &&
    (maxDocument > 1 || maxSigners > 1)
  ) {
    if (maxDocument > MIN_DOCUMENT_CHARS) maxDocument -= 1;
    else if (signers !== "" && maxSigners > 1) maxSigners -= 1;
    else maxDocument -= 1;
    result = build();
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Colisiones y nombre del ZIP
 * ------------------------------------------------------------------ */

/** Clave de comparacion: sin distinguir mayusculas ni forma Unicode. */
function collisionKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Hace unicos los nombres de las entradas del ZIP, en el mismo orden. Dos
 * nombres chocan si coinciden en minusculas NFC (los extractores de
 * Windows y macOS no distinguen mayusculas): el segundo pasa a
 * `Nombre (2).pdf`, el tercero a `Nombre (3).pdf`.
 */
export function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    if (!used.has(collisionKey(name))) {
      used.add(collisionKey(name));
      return name;
    }
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let counter = 2; ; counter += 1) {
      const suffix = ` (${counter})${extension}`;
      // El nombre FINAL, con el sufijo, tiene que respetar los mismos limites
      // que el original: se recorta el cuerpo (por grafemas), no el sufijo.
      const units = graphemes(base);
      let candidate = `${units.join("")}${suffix}`;
      while (
        units.length > 1 &&
        (graphemes(candidate).length > MAX_ENTRY_CHARS ||
          byteLength(candidate) > MAX_ENTRY_BYTES)
      ) {
        units.pop();
        candidate = `${units.join("").replace(/[.\s]+$/g, "")}${suffix}`;
      }
      if (!used.has(collisionKey(candidate))) {
        used.add(collisionKey(candidate));
        return candidate;
      }
    }
  });
}

/** `Firmados - 3 documentos.zip` / `Signed - 3 documents.zip`. */
export function zipFilename(count: number, lang: NameLang): string {
  const n = Math.max(0, Math.floor(count));
  if (lang === "en") {
    return `Signed - ${n} ${n === 1 ? "document" : "documents"}.zip`;
  }
  return `Firmados - ${n} ${n === 1 ? "documento" : "documentos"}.zip`;
}
