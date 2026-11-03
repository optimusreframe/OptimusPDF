import type { Language } from "@/lib/i18n";
import { SIGN_STRINGS, type SignStrings } from "@/app/sign-pdf/strings";

/**
 * Textos del modo Firmar DENTRO de PDF Pro (Wave 7 · U7), es/en. Lo que el modo comparte con la herramienta
 * suelta sale de `SIGN_STRINGS` (mismo lienzo, misma ceremonia); aqui solo viven lo propio del modo embebido
 * (barra de «Aplicar», etiquetas del snapshot, avisos) y los pocos textos de Firmar que hablan de DESCARGAR
 * (`withEmbeddedWording`), que dentro de PDF Pro se «aplican» al documento.
 */
export type SignEmbeddedStrings = {
  regionLabel: string;
  title: string;
  apply: string;
  discard: string;
  applying: string;
  /** Aviso bajo la barra: la sesion de firma no se guarda como borrador. */
  sessionNote: string;
  /** Falta algo para poder aplicar. */
  notReady: string;
  ready: string;
  /** El documento cambio fuera del modo y la sesion en curso se descarto. */
  sessionReset: string;
  /** El resultado llego tarde: el documento ya habia cambiado. */
  staleResult: string;
  applyFailed: string;
  /** La firma es una imagen, no una firma digital criptografica. */
  notDigital: string;
  /** Etiqueta del snapshot: nadie con nombre firmo (solo yo, o firmantes sin nombre). */
  labelSigned: string;
  /** Etiqueta del snapshot con firmantes con nombre. */
  labelSignedBy: (names: string) => string;
  /** Etiqueta del snapshot cuando solo se edito texto (sin firma estampada). */
  labelEdited: string;
  /** Une 1 o 2 nombres: «Ana y Luis». */
  joinNames: (names: readonly string[]) => string;
  warningsTitle: string;
  /** Linea resumen cuando se pliegan DOS o mas avisos: «2 avisos» (el texto completo va al expandir). */
  warningsCount: (count: number) => string;
  /** Aviso corto (una linea) de que el texto original editado se elimina al aplicar; el completo es `editTextNote`. */
  editedTextShort: string;
  /** Texto del desplegable de notas («Que debes saber»). */
  notesLabel: string;
  /** Version de una linea de los avisos del documento (el texto completo esta en `PRO_STRINGS.warnings`). */
  warningShort: Record<"signaturesInvalidated" | "signaturesUnknown" | "decryptedCopy", string>;
  /** Conmutador Firmar / Rellenar dentro de la pestana Firmar de PDF Pro. */
  switchLabel: string;
  switchSign: string;
  switchFill: string;
  switchConfirmTitle: string;
  switchConfirmBody: (from: string) => string;
  switchConfirm: string;
  switchStay: string;
};

const es: SignEmbeddedStrings = {
  regionLabel: "Firmar el documento",
  title: "Firmar",
  apply: "Aplicar firma",
  discard: "Descartar",
  applying: "Aplicando la firma…",
  sessionNote:
    "La sesión de firma no se guarda como borrador: si sales sin aplicar, se descarta. Lo que apliques queda en el historial del documento y se puede deshacer.",
  notReady: "Coloca tu firma o rellena algún campo para poder aplicar.",
  ready: "Listo para aplicar al documento.",
  sessionReset:
    "El documento cambió fuera de la firma, así que se descartó la sesión de firma en curso.",
  staleResult:
    "El documento cambió mientras se aplicaba la firma: el resultado se descartó. Vuelve a aplicarla.",
  applyFailed: "No se pudo aplicar la firma al documento.",
  notDigital:
    "Es una firma visual dibujada sobre la página, no una firma digital criptográfica con certificado.",
  labelSigned: "Documento firmado",
  labelSignedBy: (names) => `Firmado por ${names}`,
  labelEdited: "Texto editado",
  joinNames: (names) =>
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`,
  warningsTitle: "Antes de aplicar",
  warningsCount: (count) => (count === 1 ? "1 aviso" : `${count} avisos`),
  editedTextShort: "Texto editado: al aplicar se elimina el original",
  notesLabel: "Qué debes saber",
  warningShort: {
    signaturesInvalidated: "Las firmas digitales dejarán de ser válidas",
    signaturesUnknown: "No se pudo comprobar si hay firmas digitales",
    decryptedCopy: "Copia sin contraseña",
  },
  switchLabel: "Qué quieres hacer",
  switchSign: "Firmar documento",
  switchFill: "Rellenar formulario",
  switchConfirmTitle: "¿Cambiar de herramienta?",
  switchConfirmBody: (from) =>
    `Lo que llevas hecho en «${from}» no se ha aplicado y se descartará si cambias. Aplícalo antes si lo quieres conservar.`,
  switchConfirm: "Descartar y cambiar",
  switchStay: "Seguir aquí",
};

const en: SignEmbeddedStrings = {
  regionLabel: "Sign the document",
  title: "Sign",
  apply: "Apply signature",
  discard: "Discard",
  applying: "Applying the signature…",
  sessionNote:
    "The signing session isn't saved as a draft: if you leave without applying, it is discarded. What you apply stays in the document history and can be undone.",
  notReady: "Place your signature or fill in a field to be able to apply.",
  ready: "Ready to apply to the document.",
  sessionReset:
    "The document changed outside of signing, so the signing session in progress was discarded.",
  staleResult:
    "The document changed while the signature was being applied: the result was discarded. Apply it again.",
  applyFailed: "The signature couldn't be applied to the document.",
  notDigital:
    "This is a visual signature drawn on the page, not a cryptographic digital signature with a certificate.",
  labelSigned: "Signed document",
  labelSignedBy: (names) => `Signed by ${names}`,
  labelEdited: "Text edited",
  joinNames: (names) =>
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`,
  warningsTitle: "Before applying",
  warningsCount: (count) => (count === 1 ? "1 notice" : `${count} notices`),
  editedTextShort: "Edited text: the original is removed when you apply",
  notesLabel: "Good to know",
  warningShort: {
    signaturesInvalidated: "Digital signatures will stop being valid",
    signaturesUnknown: "Couldn't check for digital signatures",
    decryptedCopy: "Copy without a password",
  },
  switchLabel: "What do you want to do",
  switchSign: "Sign a document",
  switchFill: "Fill in a form",
  switchConfirmTitle: "Switch tool?",
  switchConfirmBody: (from) =>
    `What you've done in “${from}” hasn't been applied and will be discarded if you switch. Apply it first if you want to keep it.`,
  switchConfirm: "Discard and switch",
  switchStay: "Stay here",
};

export const SIGN_EMBEDDED_STRINGS: Record<Language, SignEmbeddedStrings> = { es, en };

/**
 * Los textos de Firmar que dicen «descargar», dichos para PDF Pro: aqui no se descarga, se APLICA al
 * documento de trabajo (la descarga es la de la barra de PDF Pro). El resto de claves no cambia.
 */
export function withEmbeddedWording(language: Language): SignStrings {
  const base = SIGN_STRINGS[language];
  if (language === "en") {
    return {
      ...base,
      embedded: true,
      applyAndDownload: "Finish and apply",
      finishAndDownload: "Apply to the document",
      editTextNote:
        "When you apply, the original text of what you edited is removed from the file, and a summary appears afterwards. In special cases (uncommon fonts, vertical or hidden text, shared content) it can't be removed: the summary tells you which one and why, and “Flatten page” in the Edit tab removes it completely.",
      editRemainsAdvice: (flattenLabel: string) =>
        `To remove it completely, go to the Edit tab of PDF Pro and use “${flattenLabel}”: the page becomes an image and the original text disappears.`,
      modeSingleHint:
        "You create your signature, place it wherever you want and, if the document has fields, fill them in right there. Then you apply it to the document. It's the quick way.",
    };
  }
  return {
    ...base,
    embedded: true,
    applyAndDownload: "Finalizar y aplicar",
    finishAndDownload: "Aplicar al documento",
    editTextNote:
      "Al aplicar, el texto original de lo que editaste se elimina del archivo, y después verás un resumen. En casos especiales (fuentes poco comunes, texto vertical u oculto, contenido compartido) no se puede quitar: el resumen te dice cuál y por qué, y «Aplanar página» en la pestaña Editar lo quita del todo.",
    editRemainsAdvice: (flattenLabel: string) =>
      `Para quitarlo del todo, ve a la pestaña Editar de PDF Pro y usa «${flattenLabel}»: la página pasa a ser una imagen y el texto original desaparece.`,
    modeSingleHint:
      "Creas tu firma, la colocas donde quieras y, si el documento tiene campos, los rellenas ahí mismo. Después la aplicas al documento. Es el camino rápido.",
  };
}
