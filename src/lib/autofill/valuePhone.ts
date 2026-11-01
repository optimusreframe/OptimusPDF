/**
 * Telefonos (EE. UU. / Puerto Rico / Mexico y numeros internacionales con «+»), con o sin prefijo, y correos electronicos.
 * Normalizan a un formato legible: «(305) 555-0100», «+52 55 1234 5678», «maria@example.com».
 */

export type PhoneMatch = {
  /** Formato legible. */
  value: string;
  /** Posicion en el texto de entrada. */
  index: number;
  end: number;
  /** `local` = 7 cifras sin codigo de area (solo se acepta junto a una etiqueta). */
  kind: "nanp" | "mx" | "intl" | "local";
  /** Trae «+» o prefijo de pais explicito. */
  prefixed: boolean;
};

const CANDIDATE_RE = /(?<![\w@.+\-/])(\+?\d[\d\s().\-–]{5,22}\d)(?![\w@]|[.\-]\d)/g;

function allSame(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

/** Codigo de area / central NANP valido: primera cifra 2-9 y no «N11». */
function validNanpPart(part: string, isArea: boolean): boolean {
  if (!/^[2-9]\d\d$/.test(part)) return false;
  if (part.endsWith("11") && part[1] === "1") return false;
  // 555-01xx esta reservado para ficcion, pero se acepta (es el que usan los ejemplos); 000/911 no.
  return isArea ? part !== "911" : true;
}

function formatNanp(digits: string): string {
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Interpreta UN tramo candidato (ya aislado por la expresion). */
function classify(raw: string, labeled: boolean): Omit<PhoneMatch, "index" | "end"> | null {
  const digits = raw.replace(/\D/g, "");
  const plus = raw.trim().startsWith("+");
  // Un patron de fecha o de documento (separadores mezclados con letras) ya quedo fuera por la expresion; aqui se descartan
  // las secuencias triviales.
  if (digits.length < 7 || digits.length > 15 || allSame(digits) || digits === "1234567890" || digits === "0123456789") return null;
  // Formas «2026-03-04» o «03/04/2026» NO son telefonos.
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(raw.trim()) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(raw.trim())) return null;

  if (digits.length === 10 && !plus) {
    if (validNanpPart(digits.slice(0, 3), true) && validNanpPart(digits.slice(3, 6), false)) return { value: formatNanp(digits), kind: "nanp", prefixed: false };
    // Mexico: 10 cifras nacionales; solo con etiqueta (no se distingue de otros numeros largos).
    if (labeled && /^[1-9]\d{9}$/.test(digits)) return { value: `${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`, kind: "mx", prefixed: false };
    return null;
  }
  if (digits.length === 11 && digits.startsWith("1") && validNanpPart(digits.slice(1, 4), true) && validNanpPart(digits.slice(4, 7), false)) {
    return { value: formatNanp(digits.slice(1)), kind: "nanp", prefixed: true };
  }
  if (plus && digits.startsWith("52") && (digits.length === 12 || (digits.length === 13 && digits[2] === "1"))) {
    const national = digits.length === 13 ? digits.slice(3) : digits.slice(2);
    return { value: `+52 ${national.slice(0, 2)} ${national.slice(2, 6)} ${national.slice(6)}`, kind: "mx", prefixed: true };
  }
  if (plus && digits.startsWith("1") && digits.length === 11) {
    return validNanpPart(digits.slice(1, 4), true) ? { value: `+1 ${formatNanp(digits.slice(1))}`, kind: "nanp", prefixed: true } : null;
  }
  if (plus && digits.length >= 9 && digits.length <= 15) {
    // Otro pais: se conserva con el «+» y los grupos del original.
    const grouped = raw.trim().replace(/[().\-–]/g, " ").replace(/\s+/g, " ").trim();
    return { value: grouped, kind: "intl", prefixed: true };
  }
  if (digits.length === 7 && labeled && /^[2-9]/.test(digits) && !/[\s]{2,}/.test(raw)) return { value: `${digits.slice(0, 3)}-${digits.slice(3)}`, kind: "local", prefixed: false };
  return null;
}

/**
 * Todos los telefonos validos de un texto, en orden. `labeled` = el texto va tras una etiqueta de telefono (acepta 7 cifras y
 * 10 cifras mexicanas). Un numero precedido de «fax» o de «ext» no cuenta.
 */
export function findPhones(text: string, labeled = false): PhoneMatch[] {
  const out: PhoneMatch[] = [];
  CANDIDATE_RE.lastIndex = 0;
  for (let match = CANDIDATE_RE.exec(text); match !== null; match = CANDIDATE_RE.exec(text)) {
    const raw = match[1];
    const before = text.slice(Math.max(0, match.index - 14), match.index).toLowerCase().replace(/\($/, "");
    if (/\bfax\b\s*(?:no\.?|#|number)?\s*[:.\-]?\s*$/.test(before) || /\bf\s*[:.]\s*$/.test(before)) continue;
    let found = classify(raw, labeled);
    let offset = 0;
    let length = match[0].length;
    if (!found) {
      // Dos numeros pegados («33166 305-697-3745»): se busca un telefono NANP completo dentro del tramo.
      STRICT_RE.lastIndex = 0;
      const inner = STRICT_RE.exec(raw);
      if (!inner) continue;
      found = classify(inner[0], labeled);
      if (!found) continue;
      offset = match[0].indexOf(inner[0]);
      length = inner[0].length;
    }
    const start = match.index + Math.max(0, offset);
    // Extension: «ext. 123» / «x123» justo despues.
    const tail = text.slice(start + length, start + length + 12);
    const ext = /^\s*(?:ext\.?|extension|x)\s*(\d{1,6})\b/i.exec(tail);
    const value = ext ? `${found.value} ext. ${ext[1]}` : found.value;
    out.push({ ...found, value, index: start, end: start + length + (ext ? ext[0].length : 0) });
  }
  return out;
}

const STRICT_RE = /(?<!\d)(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?!\d)/g;

/* ------------------------------------------------------------------ *
 * Correo electronico
 * ------------------------------------------------------------------ */

export type EmailMatch = { value: string; index: number; end: number; generic: boolean };

const EMAIL_RE = /(?<![\w.%+\-@])([A-Za-z0-9._%+\-]{1,64})@([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,24})(?![\w@-])/g;

/** Partes locales de buzones de una organizacion (no de una persona). */
const GENERIC_LOCAL = new Set(["info", "contact", "contacto", "admin", "office", "oficina", "support", "soporte", "sales", "ventas", "claims", "reclamos", "billing", "noreply", "no-reply", "hello", "hola", "service", "servicio", "help", "mail", "webmaster", "customerservice"]);

export function validEmail(value: string): boolean {
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@") || /\s/.test(value)) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (domain.length > 253 || domain.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => label.length >= 1 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")) && /^[A-Za-z]{2,24}$/.test(labels[labels.length - 1]);
}

/** Todos los correos validos de un texto (en minusculas). */
export function findEmails(text: string): EmailMatch[] {
  const out: EmailMatch[] = [];
  EMAIL_RE.lastIndex = 0;
  for (let match = EMAIL_RE.exec(text); match !== null; match = EMAIL_RE.exec(text)) {
    const value = `${match[1]}@${match[2]}`.replace(/[.\-]+$/, "").toLowerCase();
    if (!validEmail(value)) continue;
    out.push({ value, index: match.index, end: match.index + match[0].length, generic: GENERIC_LOCAL.has(match[1].toLowerCase()) });
  }
  return out;
}
