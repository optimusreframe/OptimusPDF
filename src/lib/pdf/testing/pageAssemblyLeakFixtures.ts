import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
} from "@cantoo/pdf-lib";

/**
 * Fixtures y lector para comprobar que lo QUITADO no sigue dentro del archivo (Wave 9 · B7 · D1).
 *
 * `makeLeakPdf(vector)`: 4 paginas (`LEAKP-1`..`LEAKP-4` como texto de su contenido) donde la pagina 3 (indice 2) lleva,
 * ademas, algo que la REFERENCIA desde una pagina que se conserva (0): una accion de salto, una cadena `/Next`, un
 * `/AA`, un `/P`, un articulo... Las anotaciones de las paginas quitadas llevan una marca propia (`LEAKA-<vector>`).
 * Todas las paginas conservan, ademas, un boton legitimo (pagina 1 -> pagina 2) que NO debe romperse.
 *
 * `scanFile(bytes)`: el archivo visto desde fuera del motor — numero de objetos `/Type /Page` y TODO el texto
 * (flujos descomprimidos y diccionarios), para buscar marcas por cadena.
 */

const N = PDFName.of;

export type LeakVector =
  | "widgetButton"
  | "buttonNamedDest"
  | "nextChain"
  | "nextChainMiddle"
  | "nextArray"
  | "pageAA"
  | "catalogAA"
  | "annotAA"
  | "annotP"
  | "popup"
  | "irt"
  | "openActionGoTo"
  | "openActionNext"
  | "openActionDest"
  | "threads"
  | "outlineResidual"
  | "calcOrder"
  | "namedAndLegacyDests"
  | "none";

export const LEAK_VECTORS: readonly LeakVector[] = [
  "widgetButton",
  "buttonNamedDest",
  "nextChain",
  "nextChainMiddle",
  "nextArray",
  "pageAA",
  "catalogAA",
  "annotAA",
  "annotP",
  "popup",
  "irt",
  "openActionGoTo",
  "openActionNext",
  "openActionDest",
  "threads",
  "outlineResidual",
  "calcOrder",
  "namedAndLegacyDests",
];

export const PAGE_MARKS = [1, 2, 3, 4].map((n) => `LEAKP-${n}`);

export function annotMark(vector: LeakVector): string {
  return `LEAKA-${vector}`;
}

/** Uno o varios vectores a la vez en el mismo documento (los que comparten clave del catalogo se pisan: gana el ultimo). */
export async function makeLeakPdf(vectors: LeakVector | readonly LeakVector[]): Promise<Uint8Array> {
  const list: readonly LeakVector[] = typeof vectors === "string" ? [vectors] : vectors;
  const vector: LeakVector = list[0] ?? "none";
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const ctx = pdf.context;
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [0, 1, 2, 3].map((index) => {
    const page = pdf.addPage([300, 400]);
    page.drawText(PAGE_MARKS[index], { x: 24, y: 300, size: 22, font });
    return page;
  });
  const refs = pages.map((page) => page.ref);
  const catalog = pdf.catalog;
  const fit = (index: number) => ctx.obj([refs[index], N("Fit")]);
  const goTo = (index: number, extra: Record<string, unknown> = {}) =>
    ctx.obj({ S: N("GoTo"), D: fit(index), ...extra } as never);
  const uri = (extra: Record<string, unknown> = {}) =>
    ctx.obj({ S: N("URI"), URI: PDFString.of("https://example.org/"), ...extra } as never);

  const addAnnot = (pageIndex: number, dict: Record<string, unknown>): PDFRef => {
    const ref = ctx.register(ctx.obj({ Type: N("Annot"), Rect: [20, 20, 120, 60], F: 4, ...dict } as never));
    const annots = pages[pageIndex].node.Annots() ?? ctx.obj([]);
    annots.push(ref);
    pages[pageIndex].node.set(N("Annots"), annots);
    return ref;
  };
  const button = (pageIndex: number, name: string, extra: Record<string, unknown>) =>
    addAnnot(pageIndex, { Subtype: N("Widget"), FT: N("Btn"), Ff: 65536, T: PDFString.of(name), ...extra });

  // Legitimo: un boton de la pagina 1 que lleva a la pagina 2 (ambas se conservan), con una accion encadenada.
  button(0, "legit", { A: goTo(1, { Next: uri() }) });

  for (const current of list) {
    const mark = annotMark(current);
    switch (current) {
      case "widgetButton":
        button(0, "toDead", { A: goTo(2) });
        break;
      case "buttonNamedDest": {
        catalog.set(N("Names"), ctx.obj({ Dests: ctx.obj({ Names: [PDFString.of("gone"), fit(2)] }) }));
        button(0, "toDeadNamed", { A: ctx.obj({ S: N("GoTo"), D: PDFString.of("gone") }) });
        break;
      }
      case "nextChain":
        addAnnot(0, { Subtype: N("Link"), Border: [0, 0, 0], A: uri({ Next: goTo(2) }) });
        break;
      case "nextChainMiddle":
        button(0, "middle", { A: goTo(2, { Next: uri() }) });
        break;
      case "nextArray":
        button(0, "array", { A: uri({ Next: [uri(), goTo(2), goTo(1)] }) });
        break;
      case "pageAA":
        pages[0].node.set(N("AA"), ctx.obj({ O: goTo(2), C: uri() }));
        break;
      case "catalogAA":
        catalog.set(N("AA"), ctx.obj({ WC: goTo(2), WS: uri() }));
        break;
      case "annotAA":
        button(0, "withAA", { AA: ctx.obj({ E: goTo(2), U: uri() }) });
        break;
      case "annotP":
        addAnnot(0, { Subtype: N("Text"), Contents: PDFString.of("nota"), P: refs[2] });
        break;
      case "popup": {
        const text = addAnnot(0, { Subtype: N("Text"), Contents: PDFString.of("nota") });
        const popup = addAnnot(2, { Subtype: N("Popup"), Parent: text, Contents: PDFString.of(mark) });
        (ctx.lookup(text) as PDFDict).set(N("Popup"), popup);
        break;
      }
      case "irt": {
        const reply = addAnnot(2, { Subtype: N("Text"), Contents: PDFString.of(mark) });
        addAnnot(0, { Subtype: N("Text"), Contents: PDFString.of("respuesta"), IRT: reply });
        break;
      }
      case "openActionGoTo":
        catalog.set(N("OpenAction"), goTo(2));
        break;
      case "openActionNext":
        catalog.set(N("OpenAction"), uri({ Next: goTo(2) }));
        break;
      case "openActionDest":
        catalog.set(N("OpenAction"), fit(2));
        break;
      case "threads": {
        const beads = refs.map(() => ctx.nextRef());
        const thread = ctx.nextRef();
        beads.forEach((bead, index) =>
          ctx.assign(
            bead,
            ctx.obj({
              Type: N("Bead"),
              T: thread,
              N: beads[(index + 1) % 4],
              V: beads[(index + 3) % 4],
              P: refs[index],
              R: [0, 0, 100, 100],
            } as never),
          ),
        );
        ctx.assign(thread, ctx.obj({ Type: N("Thread"), F: beads[0] } as never));
        catalog.set(N("Threads"), ctx.obj([thread]));
        pages.forEach((page, index) => page.node.set(N("B"), ctx.obj([beads[index]])));
        break;
      }
      case "outlineResidual": {
        // Un marcador por pagina; el de la pagina 1 lleva ademas una accion URI con un salto encadenado a la 3.
        const root = ctx.nextRef();
        const first = ctx.nextRef();
        const second = ctx.nextRef();
        ctx.assign(
          first,
          ctx.obj({ Title: PDFString.of("uno"), Parent: root, A: uri({ Next: goTo(2) }), Next: second } as never),
        );
        ctx.assign(second, ctx.obj({ Title: PDFString.of("dos"), Parent: root, Dest: fit(1), Prev: first } as never));
        ctx.assign(root, ctx.obj({ Type: N("Outlines"), First: first, Last: second, Count: 2 } as never));
        catalog.set(N("Outlines"), root);
        break;
      }
      case "calcOrder": {
        const field = addAnnot(2, {
          Subtype: N("Widget"),
          FT: N("Tx"),
          T: PDFString.of("campoMuerto"),
          V: PDFString.of(mark),
          P: refs[2],
        });
        catalog.set(N("AcroForm"), ctx.obj({ Fields: [field], CO: [field] } as never));
        break;
      }
      case "namedAndLegacyDests":
        catalog.set(N("Dests"), ctx.obj({ vieja: fit(2), viva: fit(1) } as never));
        catalog.set(
          N("Names"),
          ctx.obj({
            Dests: ctx.obj({ Names: [PDFString.of("a"), fit(2), PDFString.of("b"), fit(1)] }),
          } as never),
        );
        addAnnot(0, { Subtype: N("Link"), Border: [0, 0, 0], A: ctx.obj({ S: N("GoTo"), D: PDFString.of("a") }) });
        break;
      case "none":
        break;
    }
  }

  // Una marca en cada anotacion de las paginas que se quitan (la pagina 3 y la 4), para buscarla por cadena.
  const mark = annotMark(vector);
  for (const index of [2, 3]) {
    const annots = pages[index].node.Annots();
    if (!annots) continue;
    for (let at = 0; at < annots.size(); at += 1) {
      const dict = ctx.lookup(annots.get(at));
      if (dict instanceof PDFDict && !dict.has(N("Contents")) && !dict.has(N("V"))) {
        dict.set(N("Contents"), PDFString.of(mark));
      }
    }
  }
  // Una anotacion con marca en la pagina 4 SIEMPRE (si el motor no la suelta, se ve).
  addAnnot(3, { Subtype: N("Text"), Contents: PDFString.of(`${mark}-p4`) });
  return new Uint8Array(await pdf.save({ useObjectStreams: false }));
}

function streamText(stream: PDFStream): string {
  try {
    const decoded =
      stream instanceof PDFRawStream
        ? Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1")
        : Buffer.from(stream.getContents()).toString("latin1");
    // pdf-lib escribe el texto de las fuentes estandar como cadena hexadecimal: se muestra legible.
    return decoded.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_all, hex: string) => Buffer.from(hex, "hex").toString("latin1"));
  } catch {
    return "";
  }
}

export type FileScan = {
  /** Objetos `/Type /Page` (las hojas), vivas o huerfanas. */
  pageObjects: number;
  /** Texto de TODOS los objetos: flujos descomprimidos, diccionarios, arreglos, cadenas. */
  text: string;
};

/** Mira el archivo desde fuera del motor: cuenta las hojas y junta el texto de cada objeto. */
export async function scanFile(bytes: Uint8Array): Promise<FileScan> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  let pageObjects = 0;
  let text = "";
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (object instanceof PDFStream) {
      text += `${streamText(object)}\n${object.dict.toString()}\n`;
      if (object.dict.get(N("Type")) === N("Page")) pageObjects += 1;
    } else {
      text += `${String(object)}\n`;
      if (object instanceof PDFDict && object.get(N("Type")) === N("Page")) pageObjects += 1;
    }
  }
  // Y los bytes tal cual: lo que no este comprimido se ve igual.
  text += `\n${Buffer.from(bytes).toString("latin1")}`;
  return { pageObjects, text };
}

/** Pagina (indice) a la que lleva la accion `/A` del boton `name` de la pagina `pageIndex`, o `undefined`. */
export async function buttonTarget(bytes: Uint8Array, pageIndex: number, name: string): Promise<number | undefined> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = document.context;
  const pages = document.getPages();
  const annots = pages[pageIndex].node.Annots();
  if (!annots) return undefined;
  for (let at = 0; at < annots.size(); at += 1) {
    const dict = context.lookup(annots.get(at));
    if (!(dict instanceof PDFDict)) continue;
    const title = dict.get(N("T"));
    if (!(title instanceof PDFString) || title.decodeText() !== name) continue;
    const action = context.lookup(dict.get(N("A")));
    if (!(action instanceof PDFDict)) return undefined;
    const dest = context.lookup(action.get(N("D")));
    if (!(dest instanceof PDFArray)) return undefined;
    const target = dest.get(0);
    return target instanceof PDFRef ? pages.findIndex((page) => page.ref === target) : undefined;
  }
  return undefined;
}

/** Cadena de acciones (`/Next`) del boton `name`: tipos `S` en orden (`GoTo`, `URI`...). */
export async function buttonChain(bytes: Uint8Array, pageIndex: number, name: string): Promise<string[]> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = document.context;
  const annots = document.getPages()[pageIndex].node.Annots();
  const out: string[] = [];
  if (!annots) return out;
  for (let at = 0; at < annots.size(); at += 1) {
    const dict = context.lookup(annots.get(at));
    if (!(dict instanceof PDFDict)) continue;
    const title = dict.get(N("T"));
    if (!(title instanceof PDFString) || title.decodeText() !== name) continue;
    const walk = (value: unknown, depth: number) => {
      const resolved = value instanceof PDFRef ? context.lookup(value) : value;
      if (depth > 8) return;
      if (resolved instanceof PDFArray) {
        for (let index = 0; index < resolved.size(); index += 1) walk(resolved.get(index), depth + 1);
      } else if (resolved instanceof PDFDict) {
        out.push(String(resolved.get(N("S"))).replace("/", ""));
        const next = resolved.get(N("Next"));
        if (next) walk(next, depth + 1);
      }
    };
    walk(dict.get(N("A")), 0);
  }
  return out;
}

/** Numero de cuentas de articulo (`/Type /Bead`) que sigue habiendo en el archivo. */
export async function countBeads(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  let total = 0;
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.get(N("Type")) === N("Bead")) total += 1;
  }
  return total;
}

