/*
 * Diccionario de etiquetas del automapeo (ES/EN) y clasificacion de roles. Funciones PURAS (sin pdf.js ni DOM).
 *
 * Un texto del PDF se normaliza (minusculas, sin acentos, sin subrayados) y se buscan las palabras clave de cada
 * tipo de etiqueta. Una coincidencia solo cuenta como ETIQUETA si no es prosa: va entre parentesis, termina en
 * dos puntos o subrayados, o la frase es corta. «Sign» dentro de una clausula («you may sign this…») no es una etiqueta.
 */

export type LabelKind =
  | "initials"
  | "signature"
  | "date"
  | "name"
  | "phone"
  | "address"
  | "email"
  | "claim"
  | "policy"
  | "insurer"
  | "other";

/** Quien firma: el cliente (asegurado, propietario...), la otra parte (ajustador, empresa...) o no se sabe. */
export type RoleKind = "client" | "company" | "unknown";

export type LabelHit = {
  kind: LabelKind;
  /** Indices dentro del texto NORMALIZADO que se paso a `findLabelHits`. */
  start: number;
  end: number;
  /** 1 = etiqueta clara (parentesis, dos puntos, subrayado o frase corta); 0.6 = etiqueta dentro de una frase mas larga. */
  strength: number;
};

/** Minusculas, sin acentos ni diacriticos, subrayados como espacios y espacios colapsados (la longitud puede cambiar). */
export function normalizeLabelText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normaliza conservando UNA posicion por caracter original (sin colapsar): sirve para mapear indices del texto
 * normalizado de vuelta a la posicion horizontal del texto original.
 */
export function foldKeepLength(text: string): string {
  let out = "";
  for (const ch of text) {
    const folded = ch.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    out += folded.length === 1 ? folded : folded.charAt(0) || " ";
  }
  return out;
}

type KeywordRule = { kind: LabelKind; pattern: RegExp };

/* Los patrones trabajan sobre texto sin acentos y en minusculas. */
const KEYWORD_RULES: readonly KeywordRule[] = [
  { kind: "initials", pattern: /\b(?:initials|iniciales|rubrica|initial here|initial|inicial|init\.)(?![a-z])/g },
  {
    kind: "signature",
    pattern:
      /\b(?:signatures?|signature of|sign here|sign below|sign|signed|firmas?|firmar|firmante|firmado|signatory)(?![a-z])/g,
  },
  // «Date of loss», «fecha de nacimiento»: son datos del cliente, no la fecha de firma. Se tratan como `other`.
  { kind: "date", pattern: /\b(?:date signed|signed date|fecha de firma|dated|date|fecha)(?![a-z])(?!\s*(?:of|de|del)\b)/g },
  { kind: "name", pattern: /\b(?:print(?:ed)? name|name|nombre completo|nombre|full name)(?![a-z])/g },
  { kind: "phone", pattern: /\b(?:phone|telephone|telefono|tel\.|cell(?:ular)?|mobile|movil)(?![a-z])/g },
  { kind: "address", pattern: /\b(?:address|direccion|domicilio|mailing address)(?![a-z])/g },
  { kind: "email", pattern: /\b(?:e-?mail|correo(?: electronico)?)(?![a-z])/g },
  { kind: "claim", pattern: /\b(?:claim(?: number| no\.?| #)?|reclamo|siniestro)(?![a-z])/g },
  { kind: "policy", pattern: /\b(?:policy(?: number| no\.?| #)?|poliza)(?![a-z])/g },
  { kind: "insurer", pattern: /\b(?:insurer|insurance company|aseguradora|carrier|compania de seguros)(?![a-z])/g },
];

/** Datos del cliente con «fecha»: etiqueta de texto, no la fecha de firma. */
const DATE_AS_DATA = /\b(?:date|fecha)\s+(?:of|de|del)\b|\bdob\b|\bfecha de (?:nacimiento|perdida|siniestro)\b/;

const CLIENT_ROLE =
  /\b(?:clients?|clientes?|insured(?:s|'s)?|asegurad[oa]s?|policy ?holders?|titular(?:es)?|owners?|duenos?|propietari[oa]s?|customers?|home ?owners?|applicants?|assignors?|borrowers?|tenants?|signers?|firmantes?|buyers?|contratante|mortgagors?|principal)\b/;
const COMPANY_ROLE =
  /\b(?:public adjusters?|adjusters?|ajustador(?:es)?|representatives?|representantes?|contractors?|contratistas?|company|empresa|attorneys?|abogad[oa]s?|licensed|witness(?:es)?|testigos?|notary|notario|authorized|autorizado|agent)\b/;

/** `Owner/Agent` es el propietario; `agent` solo es de la empresa si no acompana a un rol de cliente. */
export function roleOf(normalized: string): RoleKind {
  const client = CLIENT_ROLE.test(normalized);
  const company = COMPANY_ROLE.test(normalized);
  if (client && !/\b(?:public adjusters?|adjusters?|ajustador(?:es)?|representatives?|representantes?|licensed)\b/.test(normalized)) {
    return "client";
  }
  if (company) return "company";
  if (client) return "client";
  return "unknown";
}

const CO_SIGNER =
  /\b(?:co[\s-]?(?:insured|client|cliente|owner|applicant|policy ?holder|signer|borrower|buyer|asegurado)|coasegurad[oa]|cocliente|segundo|segunda|second|2nd|secondary|joint|spouse|conyuge)\b/;
const FIRST_SIGNER = /\b(?:primary|principal|first|1st|primer[oa]?)\b/;
const NUMBERED =
  /\b(?:clients?|clientes?|insured|asegurad[oa]|policy ?holder|owner|firmante|signer|signature|firma|initials|iniciales|titular|applicant|buyer)\s*(?:\(\s*([12])\s*\)|(?:no\.?|#|n[o°º])?\s*([12])(?![\d.]))/;
const NUMBERED_REVERSED = /(?:\(\s*([12])\s*\)|\b([12])\s*(?:st|nd|\.?o)?\b)\s*(?:signature|firma|insured|client|cliente|asegurado|firmante)/;

/** Indice de firmante que sugiere el texto ("Client 2", "Insured (1)", "Co-insured", "Firmante 1"). */
export function signerHintOf(normalized: string): 0 | 1 | undefined {
  const numbered = NUMBERED.exec(normalized);
  const digit = numbered ? (numbered[1] ?? numbered[2]) : (NUMBERED_REVERSED.exec(normalized) ?? [])[1] ?? (NUMBERED_REVERSED.exec(normalized) ?? [])[2];
  if (digit === "1") return 0;
  if (digit === "2") return 1;
  if (CO_SIGNER.test(normalized)) return 1;
  if (FIRST_SIGNER.test(normalized)) return 0;
  return undefined;
}

/** Palabras de una frase (los subrayados no cuentan). */
export function wordCount(normalized: string): number {
  return normalized.split(/\s+/).filter((word) => /[a-z0-9]/.test(word)).length;
}

const SHORT_PHRASE_MAX_WORDS = 6;
/** Una etiqueta que acompana a una hilera de guiones bajos o a una linea puede estar en una frase de hasta esto. */
const MAX_LABEL_PHRASE_WORDS = 14;

/**
 * Busca etiquetas en un texto ya NORMALIZADO por `foldKeepLength` (mismos indices que el original). Descarta la
 * prosa: la palabra clave debe ir entre parentesis, ante dos puntos/subrayado/barra de relleno, o la frase debe
 * ser corta. `phraseWords` es el numero de palabras de la frase completa a la que pertenece el texto.
 */
export function findLabelHits(folded: string, phraseWords: number): LabelHit[] {
  const hits: LabelHit[] = [];
  const dateAsData = DATE_AS_DATA.test(folded);
  for (const rule of KEYWORD_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(folded)) !== null) {
      if (match[0].length === 0) {
        rule.pattern.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      const before = folded.slice(Math.max(0, start - 2), start);
      const after = folded.slice(end, end + 3);
      const parenthesised = /\(\s*$/.test(before) || /^\s*\)/.test(after);
      const punctuated = /^\s*(?::|_|\.{3,}|-{2,}|\/)/.test(folded.slice(end, end + 4));
      let strength = 0;
      if (parenthesised || punctuated) strength = 1;
      else if (phraseWords <= SHORT_PHRASE_MAX_WORDS) strength = 0.9;
      else if (phraseWords <= MAX_LABEL_PHRASE_WORDS && /^\s*$/.test(folded.slice(end))) strength = 0.6;
      if (strength === 0) continue;
      let kind = rule.kind;
      if (kind === "date" && dateAsData) kind = "other";
      if (kind === "initials" && !isInitialsLabel(match[0], folded, start, end, parenthesised, punctuated, phraseWords)) continue;
      if (kind === "signature" && !isSignatureLabel(match[0], folded, start, end, parenthesised, punctuated, phraseWords)) continue;
      hits.push({ kind, start, end, strength });
    }
  }
  // Una misma palabra no es a la vez firma e iniciales: gana la mas especifica (mas larga).
  return hits
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
    .filter((hit, index, all) => !all.some((other, j) => j !== index && other.start <= hit.start && other.end >= hit.end && (other.start < hit.start || other.end > hit.end)));
}

/** «Initial» en singular admite «Initial Payment» como encabezado: solo vale entre parentesis, con puntuacion, o suelto. */
function isInitialsLabel(
  matched: string,
  folded: string,
  start: number,
  end: number,
  parenthesised: boolean,
  punctuated: boolean,
  phraseWords: number,
): boolean {
  if (matched === "initials" || matched === "iniciales" || matched === "initial here" || matched === "init.") return true;
  if (parenthesised || punctuated) return true;
  if (/\bplease\s*$/.test(folded.slice(Math.max(0, start - 8), start))) return true;
  return phraseWords <= 1 && end - start === folded.trim().length;
}

/** «Sign»/«signed» sueltos aparecen en prosa («signed by the client»): solo cuentan entre parentesis o con puntuacion/«here». */
function isSignatureLabel(
  matched: string,
  folded: string,
  start: number,
  end: number,
  parenthesised: boolean,
  punctuated: boolean,
  phraseWords: number,
): boolean {
  if (matched === "signature" || matched === "signatures" || matched === "firma" || matched === "firmas") return true;
  if (matched === "signature of" || matched === "sign here" || matched === "sign below" || matched === "signatory") return true;
  if (parenthesised || punctuated) return true;
  if (matched === "signed" || matched === "firmado") return /\bby\b/.test(folded.slice(end, end + 4)) && phraseWords <= 4;
  return phraseWords <= 2 && end - start >= 3;
}

/** Etiqueta corta y legible para mostrar (recorta a 60 caracteres y quita puntuacion de los extremos). */
export function displayLabel(text: string): string {
  let flat = text.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  // Se quitan los signos de los extremos, pero un parentesis solo si queda sin pareja («(INITIAL)» -> «INITIAL»).
  for (let guard = 0; guard < 6; guard += 1) {
    const before = flat;
    flat = flat.replace(/^[\s:.\-–—/]+|[\s:.\-–—/]+$/g, "");
    if (/^\(/.test(flat) && !flat.includes(")")) flat = flat.slice(1);
    else if (/\)$/.test(flat) && !flat.includes("(")) flat = flat.slice(0, -1);
    else if (/^\(.*\)$/.test(flat) && flat.indexOf(")") === flat.length - 1) flat = flat.slice(1, -1);
    flat = flat.trim();
    if (flat === before) break;
  }
  return flat.length > 60 ? flat.slice(0, 60).trimEnd() : flat;
}

/** Tipo de campo propuesto segun la etiqueta. */
export function fieldTypeForKind(kind: LabelKind): "signature" | "initials" | "date" | "text" {
  if (kind === "signature") return "signature";
  if (kind === "initials") return "initials";
  if (kind === "date") return "date";
  return "text";
}

/** Etiquetas de datos del cliente que justifican un campo de texto de nivel `high` cuando hay linea asociada. */
export const DATA_KINDS: ReadonlySet<LabelKind> = new Set<LabelKind>([
  "name",
  "phone",
  "address",
  "email",
  "claim",
  "policy",
  "insurer",
]);

/** Etiquetas de datos conocidas por su texto (para campos de texto detectados sin palabra clave de firma). */
export function dataKindOfLabel(label: string): LabelKind {
  const folded = foldKeepLength(label);
  if (DATE_AS_DATA.test(folded) || /\b(?:date of loss|loss date|fecha de perdida)\b/.test(folded)) return "other";
  for (const rule of KEYWORD_RULES) {
    if (rule.kind === "signature" || rule.kind === "initials") continue;
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(folded)) return rule.kind;
  }
  // «Client/Insured:», «Policyholder»: el nombre de quien firma.
  if (CLIENT_ROLE.test(folded)) return "name";
  return "other";
}
