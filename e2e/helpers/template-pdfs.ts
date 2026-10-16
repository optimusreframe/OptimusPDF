/**
 * Contratos SINTETICOS para los E2E de plantillas (Fase 2 · U2.3/U2.4): 3-8 paginas de cuerpo con una linea de iniciales
 * repetida en la esquina inferior derecha y una pagina final con el bloque de firma de 1 o de 2 firmantes. Texto de
 * relleno inventado, distinto en cada pagina y en cada `label` (contratos distintos no se confunden entre si). NADA real.
 *
 * `reexport` guarda el mismo contenido con otros bytes (otro productor, flujos reordenados): lo que hace un exportador
 * al volver a guardar el contrato en blanco.
 */
import { PDFDocument } from "@cantoo/pdf-lib";
import { makeParagraph } from "../../src/lib/docLibrary/testing/syntheticContracts";
import { FONT_FRACTION, captionedLine, fillerLines, labelLine, renderSynthetic, type Item, type PageSpec, type SyntheticDoc } from "../../src/lib/pdf/testing/autoMapSynthetic";

/** Linea de iniciales: esquina inferior derecha (fraccion de pagina, como en los contratos reales del plan §11). */
export const INITIALS_LINE = { x0: 0.74, x1: 0.87, y: 0.93 };

function header(title: string): Item[] {
  return [{ t: "text", x: 0.1, y: 0.07, text: title, size: 0.0215, bold: true }];
}

export type ContractOptions = {
  label: string;
  /** Paginas en total (cuerpo + la de firmas): 3-8. */
  pages: number;
  signers: 1 | 2;
  /** Paginas (0-based) cuyo texto cambia por completo (sin equivalente en la plantilla). */
  changedPages?: number[];
  /** Paginas (0-based) en las que cambian unas pocas lineas (la huella las reconoce como «parecidas»: a revisar). */
  tweakedPages?: number[];
  /** Sin la linea de iniciales (contrato sin iniciales). */
  noInitials?: boolean;
  /** Pagina de firmas con lineas dudosas (firma «sin firmante claro», la de la otra parte y dos rayas con poco sitio) y campos de texto: dan sugerencias. */
  extras?: boolean;
};

/** Texto de relleno propio de cada contrato y de cada pagina (parrafos generados con semilla): paginas y contratos distintos no se parecen. */
function body(seed: number, page: number, count: number, tweaked: number): Item[] {
  const words = Array.from({ length: 12 }, (_, k) => makeParagraph(seed * 101 + page * 17 + k, k + 1)).join(" ").split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > 100) {
      lines.push(current);
      current = word;
    } else current = (current + " " + word).trim();
  }
  const altWords = Array.from({ length: 2 }, (_, k) => makeParagraph(seed * 31 + page * 7 + 9000 + k, k + 1)).join(" ").split(/\s+/);
  const altLines: string[] = [];
  current = "";
  for (const word of altWords) {
    if ((current + " " + word).trim().length > 100) {
      altLines.push(current);
      current = word;
    } else current = (current + " " + word).trim();
  }
  return lines.slice(0, count).map((text, index) => ({
    t: "text" as const,
    x: 0.1,
    y: 0.12 + index * 0.0215,
    text: index >= count - tweaked ? (altLines[index - (count - tweaked)] ?? text) : text,
    size: FONT_FRACTION,
    serif: true,
  }));
}

export function contractSpec({ label, pages, signers, changedPages = [], tweakedPages = [], noInitials = false, extras = false }: ContractOptions): SyntheticDoc {
  const seed = [...label].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const specs: PageSpec[] = [];
  for (let index = 0; index < pages - 1; index += 1) {
    const changed = changedPages.includes(index);
    const items: Item[] = [
      ...header(`${label} - Section ${index + 1}${changed ? " (revised)" : ""}`),
      ...body(seed + (changed ? 7001 : 0), index, 28, tweakedPages.includes(index) ? 6 : 0),
    ];
    // Texto propio de cada pagina: lo que hace distinguible a un contrato de otro y a una pagina de otra.
    items.push({ t: "text", x: 0.1, y: 0.9, text: `${label} clause ${index + 1}.${seed % 97}${changed ? " amended in full" : ""}`, size: 0.0165 });
    if (!noInitials) items.push({ t: "hline", x0: INITIALS_LINE.x0, x1: INITIALS_LINE.x1, y: INITIALS_LINE.y });
    specs.push({ items });
  }
  const y = 0.55;
  const sign: Item[] = [...header(`${label} - Signatures`), ...body(seed, 99, 8, 0)];
  if (signers === 2) sign.push(...captionedLine("Signature of Client 1", 0.1, 0.42, y), ...captionedLine("Signature of Client 2", 0.55, 0.88, y));
  else sign.push(...captionedLine("Signature of Client", 0.1, 0.5, y));
  if (extras) {
    sign.push(
      ...captionedLine("Signature", 0.1, 0.45, 0.75),
      ...captionedLine("Date", 0.55, 0.75, 0.75),
      ...labelLine("Print name:", 0.82, 0.1, 0.3),
      ...captionedLine("Signature of Adjuster", 0.55, 0.88, 0.66),
      // Dos rayas con texto pegado encima (poco sitio): propuestas de confianza media para cada firmante.
      { t: "text", x: 0.12, y: 0.335, text: "I have read and agree to all of the terms above in full.", size: 0.0165 },
      ...captionedLine("Signature of Client 1", 0.1, 0.45, 0.36),
      { t: "text", x: 0.57, y: 0.395, text: "Notes and other remarks go in this area.", size: 0.0165 },
      ...captionedLine("Signature of Client 2", 0.55, 0.88, 0.42),
    );
  }
  specs.push({ items: sign });
  return { name: label, signers, pages: specs };
}

export async function makeContract(options: ContractOptions): Promise<Buffer> {
  const { bytes } = await renderSynthetic(contractSpec(options));
  return Buffer.from(bytes);
}

/** El mismo contrato guardado otra vez: bytes distintos, mismo contenido. */
export async function reexport(bytes: Buffer): Promise<Buffer> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  pdf.setProducer("Another Exporter 9.1");
  pdf.setCreator("Word 16");
  pdf.setTitle("Re-exported");
  pdf.setCreationDate(new Date(86_400_000));
  const out = Buffer.from(await pdf.save({ useObjectStreams: false }));
  if (out.equals(bytes)) throw new Error("la reexportacion no cambio los bytes");
  return out;
}

export { fillerLines };
