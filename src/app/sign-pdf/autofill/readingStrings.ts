/**
 * Textos del DE DONDE SALIO cada dato en la revision del autorrelleno (archivo, pagina, metodo y recorte de la imagen leida), en espanol e
 * ingles. Aparte de `strings.ts` (mismo patron que `templateStrings.ts`): la revision muestra, junto a cada valor, de que archivo salio
 * y, si lo leyo el OCR, el recorte de la zona para comprobarlo de un vistazo.
 */

export type ReadingStrings = {
  /** «Foto «IMG_01.jpg» · página 1 · leído de la imagen». */
  from: (name: string, kind: "pdf" | "image" | "text", scanned: boolean, page: number) => string;
  /** El valor lo leyo el OCR: se pide comprobarlo con el recorte. */
  ocrCheck: string;
  /** Una segunda lectura independiente de la zona dio el mismo valor / no lo dio. */
  confirmed: string;
  notConfirmed: string;
  /** Texto alternativo del recorte (una imagen). */
  cropAlt: (label: string) => string;
  cropLabel: string;
};

const ES: ReadingStrings = {
  from: (name, kind, scanned, page) => {
    const what = kind === "image" ? "Foto" : kind === "text" ? "Texto pegado" : scanned ? "PDF escaneado" : "PDF";
    return kind === "text" ? `${what} «${name}»` : `${what} «${name}» · página ${page}${kind === "image" || scanned ? " · leído de la imagen" : " · texto del archivo"}`;
  },
  ocrCheck: "Leído de una imagen: compáralo con el recorte.",
  confirmed: "Una segunda lectura dio lo mismo.",
  notConfirmed: "Una segunda lectura no coincidió: revísalo.",
  cropAlt: (label) => `Recorte de la imagen donde se leyó: ${label}`,
  cropLabel: "Así se ve en la imagen",
};

const EN: ReadingStrings = {
  from: (name, kind, scanned, page) => {
    const what = kind === "image" ? "Photo" : kind === "text" ? "Pasted text" : scanned ? "Scanned PDF" : "PDF";
    return kind === "text" ? `${what} “${name}”` : `${what} “${name}” · page ${page}${kind === "image" || scanned ? " · read from the image" : " · text of the file"}`;
  },
  ocrCheck: "Read from an image: compare it with the crop.",
  confirmed: "A second reading gave the same value.",
  notConfirmed: "A second reading did not match: check it.",
  cropAlt: (label) => `Crop of the image where this was read: ${label}`,
  cropLabel: "How it looks in the image",
};

export function readingStrings(locale: "es" | "en"): ReadingStrings {
  return locale === "en" ? EN : ES;
}
