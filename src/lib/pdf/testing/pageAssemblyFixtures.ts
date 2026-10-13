import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFOperator,
  PDFOperatorNames,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  degrees,
} from "@cantoo/pdf-lib";

/**
 * PDF de prueba del motor de paginas (Wave 7 · U4): documentos con metadatos, formulario,
 * marcadores, enlaces, destinos con nombre, etiquetas de pagina, recortes y rotaciones, y
 * lectores INDEPENDIENTES del motor (no reutilizan `pageAssemblyStructure.ts`) para comprobar el
 * resultado desde fuera.
 */

export type RichPdfOptions = {
  pages?: number;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: readonly string[];
  /** Un campo de texto por pagina (`campo-1`...), con valor. */
  form?: boolean;
  /** Un marcador por pagina (`Capitulo 1`...). */
  outline?: boolean;
  /** Marcadores anidados: pagina 1 es raiz, paginas 2..n cuelgan de ella. */
  nestedOutline?: boolean;
  /** Enlaces: de la pagina 1 a la ultima y un enlace web, y uno por nombre a la pagina 3. */
  links?: boolean;
  /** `/PageLabels`: romanos en las dos primeras paginas, luego arabigos desde 1. */
  pageLabels?: boolean;
  /** `/PageLabels` a medida: tramos `{start (0-based), style, prefix, st}`. Sustituye a `pageLabels`. */
  labelRanges?: readonly { start: number; style?: "D" | "R" | "r" | "A" | "a"; prefix?: string; st?: number }[];
  /** Con `labelRanges`: el arbol de numeros se parte en `/Kids` (un nodo por tramo, con `/Limits`). */
  labelsAsTree?: boolean;
  /** Arbol de estructura (PDF etiquetado) minimo con `/Pg` a cada pagina. */
  tagged?: boolean;
  /**
   * PDF etiquetado de verdad: contenido marcado (`BDC /P << /MCID 0 >>`), `/StructParents` en cada pagina,
   * `/ParentTree`, `/IDTree` y un elemento `Div` repartido entre las paginas 1 y 2 (contenido en dos paginas).
   */
  taggedContent?: boolean;
  /** Rotaciones iniciales por pagina (0-based). */
  rotations?: Record<number, number>;
  /** Recorte (CropBox) en las paginas indicadas: `[x, y, ancho, alto]`. */
  cropBoxes?: Record<number, [number, number, number, number]>;
  /** Anchura base; la pagina `i` mide `baseWidth + i` de ancho. */
  baseWidth?: number;
  height?: number;
  /** Un campo de firma (sin firmar) en la pagina 1, ademas del formulario. */
  signatureField?: boolean;
  /** Un campo de firma YA FIRMADO (con `/V`, diccionario de firma) en la pagina 1. */
  signedSignature?: boolean;
  /**
   * `/Rotate` y `/MediaBox` HEREDADOS del nodo `/Pages` raiz (las hojas no los traen). Las hojas
   * mantienen su tamano por herencia: todas miden `baseWidth` de ancho.
   */
  inheritedBoxes?: { rotate?: number };
  /** Cuelga las paginas de un arbol de dos niveles (nodos `/Pages` intermedios de `groupSize` hojas). */
  treeGroups?: number;
};

/** Marca de texto unica de la pagina `index` (0-based) en su contenido. */
export function marker(index: number): string {
  return `MARCA-PAGINA-${String(index + 1).padStart(4, "0")}`;
}

export function pageWidthOf(index: number, baseWidth = 300): number {
  return baseWidth + index;
}

export async function makeRichPdf(options: RichPdfOptions = {}): Promise<Uint8Array> {
  const {
    pages = 5,
    baseWidth = 300,
    height = 400,
  } = options;
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  if (options.title) document.setTitle(options.title);
  if (options.author) document.setAuthor(options.author);
  if (options.subject) document.setSubject(options.subject);
  if (options.keywords) document.setKeywords([...options.keywords]);

  for (let index = 0; index < pages; index += 1) {
    const page = document.addPage([pageWidthOf(index, baseWidth), height]);
    const markContent = (mcid: number, draw: () => void) => {
      if (!options.taggedContent) {
        draw();
        return;
      }
      page.pushOperators(
        PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
          PDFName.of(mcid === 0 ? "P" : "Span"),
          `<< /MCID ${mcid} >>`,
        ]),
      );
      draw();
      page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
    };
    markContent(0, () => page.drawText(marker(index), { x: 30, y: height - 60, size: 14, font }));
    // Contenido compartido entre las paginas 1 y 2 (lo cuenta un solo elemento de estructura).
    if (options.taggedContent && index < 2) {
      markContent(1, () => page.drawText(`COMPARTIDO-${index + 1}`, { x: 30, y: height - 90, size: 12, font }));
    }
    if (options.taggedContent) page.node.set(PDFName.of("StructParents"), PDFNumber.of(index));
    const rotation = options.rotations?.[index];
    if (rotation) page.setRotation(degrees(rotation));
    const crop = options.cropBoxes?.[index];
    if (crop) page.setCropBox(crop[0], crop[1], crop[2], crop[3]);
  }

  if (options.form) {
    const form = document.getForm();
    for (let index = 0; index < pages; index += 1) {
      const field = form.createTextField(`campo-${index + 1}`);
      field.setText(`valor-${index + 1}`);
      field.addToPage(document.getPage(index), { x: 30, y: 200, width: 150, height: 24 });
    }
  }

  const context = document.context;
  const pageRefs = document.getPages().map((page) => page.ref);

  if (options.outline || options.nestedOutline) {
    const rootRef = context.nextRef();
    const itemRefs = pageRefs.map(() => context.nextRef());
    const nested = Boolean(options.nestedOutline);
    pageRefs.forEach((pageRef, index) => {
      const dict = context.obj({
        Title: PDFHexString.fromText(`Capitulo ${index + 1}`),
        Dest: [pageRef, PDFName.of("XYZ"), null, null, null],
      });
      const parentRef = nested && index > 0 ? itemRefs[0] : rootRef;
      dict.set(PDFName.of("Parent"), parentRef);
      if (nested) {
        if (index > 1) dict.set(PDFName.of("Prev"), itemRefs[index - 1]);
        if (index > 0 && index < pageRefs.length - 1) dict.set(PDFName.of("Next"), itemRefs[index + 1]);
        if (index === 0) {
          dict.set(PDFName.of("First"), itemRefs[1] ?? itemRefs[0]);
          dict.set(PDFName.of("Last"), itemRefs[itemRefs.length - 1]);
          dict.set(PDFName.of("Count"), PDFNumber.of(pageRefs.length - 1));
        }
      } else {
        if (index > 0) dict.set(PDFName.of("Prev"), itemRefs[index - 1]);
        if (index < pageRefs.length - 1) dict.set(PDFName.of("Next"), itemRefs[index + 1]);
      }
      context.assign(itemRefs[index], dict);
    });
    const root = context.obj({
      Type: "Outlines",
      First: itemRefs[0],
      Last: nested ? itemRefs[0] : itemRefs[itemRefs.length - 1],
      Count: nested ? pageRefs.length : pageRefs.length,
    });
    context.assign(rootRef, root);
    document.catalog.set(PDFName.of("Outlines"), rootRef);
  }

  if (options.links && pages >= 3) {
    const addLink = (pageIndex: number, dict: PDFDict) => {
      const page = document.getPage(pageIndex);
      const ref = context.register(dict);
      page.node.addAnnot(ref);
    };
    addLink(
      0,
      context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 10, 100, 40],
        Border: [0, 0, 0],
        Dest: [pageRefs[pages - 1], PDFName.of("Fit")],
      }),
    );
    addLink(
      0,
      context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 50, 100, 80],
        Border: [0, 0, 0],
        A: { S: "URI", URI: PDFString.of("https://example.com/") },
      }),
    );
    addLink(
      0,
      context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 90, 100, 120],
        Border: [0, 0, 0],
        A: { S: "GoTo", D: PDFString.of("destino-tres") },
      }),
    );
    // Destino con nombre (arbol de nombres) a la pagina 3 y uno legacy a la ultima.
    const namesArray = context.obj([PDFString.of("destino-tres"), [pageRefs[2], PDFName.of("Fit")]]);
    const destsTree = context.obj({ Names: namesArray });
    const namesDict = context.obj({ Dests: destsTree });
    document.catalog.set(PDFName.of("Names"), namesDict);
    const legacy = context.obj({});
    legacy.set(PDFName.of("destino-final"), context.obj([pageRefs[pages - 1], PDFName.of("Fit")]));
    document.catalog.set(PDFName.of("Dests"), legacy);
  }

  if (options.labelRanges) {
    const entries = options.labelRanges.map((range) => {
      const dict = context.obj({});
      if (range.style) dict.set(PDFName.of("S"), PDFName.of(range.style));
      if (range.prefix !== undefined) dict.set(PDFName.of("P"), PDFString.of(range.prefix));
      if (range.st !== undefined) dict.set(PDFName.of("St"), PDFNumber.of(range.st));
      return { start: range.start, dict };
    });
    if (options.labelsAsTree) {
      const kids = entries.map((entry) =>
        context.register(
          context.obj({
            Nums: [entry.start, entry.dict],
            Limits: [entry.start, entry.start],
          }),
        ),
      );
      document.catalog.set(PDFName.of("PageLabels"), context.obj({ Kids: kids }));
    } else {
      const nums: PDFObject[] = [];
      for (const entry of entries) nums.push(PDFNumber.of(entry.start), entry.dict);
      document.catalog.set(PDFName.of("PageLabels"), context.obj({ Nums: nums }));
    }
  }

  if (options.pageLabels) {
    const labels = context.obj({
      Nums: [
        0,
        { S: "r" },
        Math.min(2, pages),
        { S: "D", St: 1 },
      ],
    });
    document.catalog.set(PDFName.of("PageLabels"), labels);
  }

  if (options.tagged) {
    const kids = pageRefs.map((pageRef) => context.register(context.obj({ Type: "StructElem", S: "P", Pg: pageRef })));
    const root = context.obj({ Type: "StructTreeRoot", K: kids });
    document.catalog.set(PDFName.of("StructTreeRoot"), context.register(root));
    document.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));
  }

  if (options.taggedContent) {
    const rootRef = context.nextRef();
    const documentRef = context.nextRef();
    const paragraphs = pageRefs.map((pageRef, index) =>
      context.register(
        context.obj({
          Type: "StructElem",
          S: "P",
          P: documentRef,
          Pg: pageRef,
          K: 0,
          ID: PDFString.of(`parrafo-${index + 1}`),
        }),
      ),
    );
    const kids: PDFRef[] = [...paragraphs];
    let division: PDFRef | undefined;
    if (pages >= 2) {
      division = context.register(
        context.obj({
          Type: "StructElem",
          S: "Div",
          P: documentRef,
          ID: PDFString.of("compartido"),
          K: [
            { Type: "MCR", Pg: pageRefs[0], MCID: 1 },
            { Type: "MCR", Pg: pageRefs[1], MCID: 1 },
          ],
        }),
      );
      kids.push(division);
    }
    context.assign(documentRef, context.obj({ Type: "StructElem", S: "Document", P: rootRef, K: kids }));
    const nums: PDFObject[] = [];
    pageRefs.forEach((_pageRef, index) => {
      const entry: PDFObject[] = [paragraphs[index]];
      if (division && index < 2) entry.push(division);
      nums.push(PDFNumber.of(index), context.obj(entry));
    });
    const parentTree = context.register(context.obj({ Nums: nums }));
    const idNames: PDFObject[] = [];
    paragraphs.forEach((ref, index) => idNames.push(PDFString.of(`parrafo-${index + 1}`), ref));
    if (division) idNames.push(PDFString.of("compartido"), division);
    // El arbol de nombres va ordenado por clave: «compartido» < «parrafo-N».
    const ordered: PDFObject[] = [];
    if (division) ordered.push(PDFString.of("compartido"), division);
    paragraphs.forEach((ref, index) => ordered.push(PDFString.of(`parrafo-${index + 1}`), ref));
    const idTree = context.register(context.obj({ Names: ordered }));
    context.assign(
      rootRef,
      context.obj({
        Type: "StructTreeRoot",
        K: documentRef,
        ParentTree: parentTree,
        ParentTreeNextKey: pages,
        IDTree: idTree,
      }),
    );
    document.catalog.set(PDFName.of("StructTreeRoot"), rootRef);
    document.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));
  }

  if (options.signatureField || options.signedSignature) {
    const widget = context.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Sig",
      T: PDFString.of("firma"),
      Rect: [30, 100, 180, 140],
      F: 4,
    });
    widget.set(PDFName.of("P"), pageRefs[0]);
    if (options.signedSignature) {
      widget.set(
        PDFName.of("V"),
        context.register(
          context.obj({
            Type: "Sig",
            Filter: "Adobe.PPKLite",
            SubFilter: "adbe.pkcs7.detached",
            ByteRange: [0, 0, 0, 0],
            Contents: PDFHexString.of("00".repeat(16)),
            M: PDFString.of("D:20260101000000Z"),
            Name: PDFString.of("Ana Perez"),
          }),
        ),
      );
    }
    const widgetRef = context.register(widget);
    document.getPage(0).node.addAnnot(widgetRef);
    const form = document.getForm();
    const fieldsArray = form.acroForm.dict.lookup(PDFName.of("Fields"), PDFArray);
    fieldsArray.push(widgetRef);
  }

  if (options.inheritedBoxes) {
    const root = document.catalog.Pages();
    const width = baseWidth;
    root.set(PDFName.of("MediaBox"), context.obj([0, 0, width, height]));
    if (options.inheritedBoxes.rotate !== undefined) {
      root.set(PDFName.of("Rotate"), PDFNumber.of(options.inheritedBoxes.rotate));
    }
    for (const page of document.getPages()) {
      page.node.delete(PDFName.of("MediaBox"));
      page.node.delete(PDFName.of("Rotate"));
    }
  }

  if (options.treeGroups && options.treeGroups > 0) {
    const root = document.catalog.Pages();
    const rootRef = document.catalog.get(PDFName.of("Pages")) as PDFRef;
    const leaves = document.getPages();
    const groups: PDFRef[] = [];
    for (let start = 0; start < leaves.length; start += options.treeGroups) {
      const slice = leaves.slice(start, start + options.treeGroups);
      const node = context.obj({
        Type: "Pages",
        Kids: slice.map((page) => page.ref),
        Count: slice.length,
        Parent: rootRef,
      });
      const nodeRef = context.register(node);
      for (const page of slice) page.node.set(PDFName.of("Parent"), nodeRef);
      groups.push(nodeRef);
    }
    root.set(PDFName.of("Kids"), context.obj(groups));
  }

  return document.save({ useObjectStreams: false });
}

/* ------------------------------------------------------------------ *
 * Lectores independientes
 * ------------------------------------------------------------------ */

export type PdfReport = {
  title: string | undefined;
  author: string | undefined;
  subject: string | undefined;
  keywords: string | undefined;
  pageCount: number;
  /** Ancho de cada pagina segun MediaBox (sirve de identidad: `300 + i`). */
  widths: number[];
  rotations: number[];
  /** Marca de texto de cada pagina (`marker`). */
  markers: (string | undefined)[];
  /** Nombres completos de los campos del AcroForm. */
  fieldNames: string[];
  /** Texto de los marcadores en orden (profundidad primero). */
  outlineTitles: string[];
  /** Indice de pagina al que apunta cada marcador (`-1` = no apunta a una pagina del documento). */
  outlineTargets: number[];
  /** Destinos de los enlaces de cada pagina (`"uri"`, `"page:N"` o `"broken"`). */
  links: string[][];
  /** Numero de objetos `/Type /Page` en el archivo (detecta paginas huerfanas). */
  pageObjects: number;
  /** Tiene `/PageLabels`. */
  hasPageLabels: boolean;
  hasStructTree: boolean;
};

function decodeStream(stream: PDFStream): string {
  try {
    const raw = stream as unknown as Parameters<typeof decodePDFRawStream>[0];
    const text = Buffer.from(decodePDFRawStream(raw).decode()).toString("latin1");
    // pdf-lib escribe el texto como cadena hexadecimal: se muestra legible.
    return text.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_all, hex: string) =>
      Buffer.from(hex, "hex").toString("latin1"),
    );
  } catch {
    return "";
  }
}

/** Texto (latin1) de TODOS los flujos del archivo: para comprobar que algo ya no esta. */
export async function allStreamsText(bytes: Uint8Array): Promise<string> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  let text = "";
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (object instanceof PDFStream) text += decodeStream(object);
  }
  return text;
}

function lookupDict(document: PDFDocument, object: unknown): PDFDict | undefined {
  const value = object instanceof PDFRef ? document.context.lookup(object) : object;
  if (value instanceof PDFDict) return value;
  if (value instanceof PDFStream) return value.dict;
  return undefined;
}

function textOf(value: unknown): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return undefined;
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfReport> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = document.context;
  const pages = document.getPages();
  const refIndex = new Map<string, number>();
  pages.forEach((page, index) => refIndex.set(page.ref.toString(), index));

  const markers = pages.map((page) => {
    const contents = page.node.Contents();
    const streams: PDFStream[] = [];
    if (contents instanceof PDFStream) streams.push(contents);
    else if (contents instanceof PDFArray) {
      for (let index = 0; index < contents.size(); index += 1) {
        const item = context.lookup(contents.get(index));
        if (item instanceof PDFStream) streams.push(item);
      }
    }
    const text = streams.map(decodeStream).join("\n");
    return /MARCA-PAGINA-\d{4}/.exec(text)?.[0];
  });

  const destPage = (dest: unknown, named: Map<string, unknown>, depth = 0): number | "uri" | "broken" => {
    if (depth > 4) return "broken";
    const value = dest instanceof PDFRef ? context.lookup(dest) : dest;
    if (value instanceof PDFArray) {
      const first = value.get(0);
      if (first instanceof PDFRef) {
        const found = refIndex.get(first.toString());
        return found === undefined ? "broken" : found;
      }
      return "broken";
    }
    if (value instanceof PDFDict) return destPage(value.get(PDFName.of("D")), named, depth + 1);
    const key = value instanceof PDFName ? value.decodeText() : textOf(value);
    if (key !== undefined) {
      const found = named.get(key);
      return found === undefined ? "broken" : destPage(found, named, depth + 1);
    }
    return "broken";
  };

  const named = new Map<string, unknown>();
  const legacy = lookupDict(document, document.catalog.get(PDFName.of("Dests")));
  if (legacy) for (const [name, value] of legacy.entries()) named.set(name.decodeText(), value);
  const namesDict = lookupDict(document, document.catalog.get(PDFName.of("Names")));
  const tree = namesDict ? lookupDict(document, namesDict.get(PDFName.of("Dests"))) : undefined;
  const walk = (node: PDFDict | undefined, depth = 0) => {
    if (!node || depth > 10) return;
    const arr = node.lookup(PDFName.of("Names"));
    if (arr instanceof PDFArray) {
      for (let index = 0; index + 1 < arr.size(); index += 2) {
        const key = textOf(arr.lookup(index));
        if (key !== undefined) named.set(key, arr.get(index + 1));
      }
    }
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) {
      for (let index = 0; index < kids.size(); index += 1) walk(lookupDict(document, kids.get(index)), depth + 1);
    }
  };
  walk(tree);

  const links = pages.map((page) => {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    const out: string[] = [];
    if (!annots) return out;
    for (let index = 0; index < annots.size(); index += 1) {
      const annot = lookupDict(document, annots.get(index));
      if (!annot) continue;
      const subtype = annot.get(PDFName.of("Subtype"));
      if (!(subtype instanceof PDFName) || subtype.decodeText() !== "Link") continue;
      const action = lookupDict(document, annot.get(PDFName.of("A")));
      if (action) {
        const kind = action.get(PDFName.of("S"));
        if (kind instanceof PDFName && kind.decodeText() === "URI") {
          out.push("uri");
          continue;
        }
        const target = destPage(action.get(PDFName.of("D")), named);
        out.push(typeof target === "number" ? `page:${target}` : target);
        continue;
      }
      const target = destPage(annot.get(PDFName.of("Dest")), named);
      out.push(typeof target === "number" ? `page:${target}` : target);
    }
    return out;
  });

  const outlineTitles: string[] = [];
  const outlineTargets: number[] = [];
  const outlines = lookupDict(document, document.catalog.get(PDFName.of("Outlines")));
  if (outlines) {
    const seen = new Set<string>();
    const visit = (firstRef: unknown) => {
      let current = firstRef;
      while (current instanceof PDFRef && !seen.has(current.toString())) {
        seen.add(current.toString());
        const item = lookupDict(document, current);
        if (!item) break;
        outlineTitles.push(textOf(item.get(PDFName.of("Title"))) ?? "");
        const target = destPage(item.get(PDFName.of("Dest")) ?? item.get(PDFName.of("A")), named);
        outlineTargets.push(typeof target === "number" ? target : -1);
        visit(item.get(PDFName.of("First")));
        current = item.get(PDFName.of("Next"));
      }
    };
    visit(outlines.get(PDFName.of("First")));
  }

  const fieldNames: string[] = [];
  const form = lookupDict(document, document.catalog.get(PDFName.of("AcroForm")));
  const fields = form ? form.lookup(PDFName.of("Fields")) : undefined;
  const walkField = (item: unknown, prefix: string, depth = 0) => {
    if (depth > 20) return;
    const dict = lookupDict(document, item);
    if (!dict) return;
    const partial = textOf(dict.get(PDFName.of("T")));
    const full = partial !== undefined ? (prefix ? `${prefix}.${partial}` : partial) : prefix;
    if (partial !== undefined) fieldNames.push(full);
    const kids = dict.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) for (let index = 0; index < kids.size(); index += 1) walkField(kids.get(index), full, depth + 1);
  };
  if (fields instanceof PDFArray) for (let index = 0; index < fields.size(); index += 1) walkField(fields.get(index), "");

  let pageObjects = 0;
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) {
      const type = object.get(PDFName.of("Type"));
      if (type instanceof PDFName && type.decodeText() === "Page") pageObjects += 1;
    }
  }

  const info = document.context.lookup(document.context.trailerInfo.Info);
  const infoText = (key: string) => (info instanceof PDFDict ? textOf(info.lookup(PDFName.of(key))) : undefined);

  return {
    title: infoText("Title"),
    author: infoText("Author"),
    subject: infoText("Subject"),
    keywords: infoText("Keywords"),
    pageCount: pages.length,
    widths: pages.map((page) => Math.round(page.getMediaBox().width * 100) / 100),
    rotations: pages.map((page) => ((page.getRotation().angle % 360) + 360) % 360),
    markers,
    fieldNames,
    outlineTitles,
    outlineTargets,
    links,
    pageObjects,
    hasPageLabels: document.catalog.has(PDFName.of("PageLabels")),
    hasStructTree: document.catalog.has(PDFName.of("StructTreeRoot")),
  };
}

/**
 * Huella de dibujo de cada pagina: flujos de contenido decodificados + MediaBox + CropBox +
 * `/Rotate`. Dos paginas con la misma huella (y los mismos recursos, que pdf-lib copia tal cual)
 * se rasterizan igual: es la comparacion «a pixel» que se puede hacer sin canvas en Node.
 */
export async function pageDrawFingerprints(bytes: Uint8Array): Promise<string[]> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = document.context;
  return document.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams: PDFStream[] = [];
    if (contents instanceof PDFStream) streams.push(contents);
    else if (contents instanceof PDFArray) {
      for (let index = 0; index < contents.size(); index += 1) {
        const item = context.lookup(contents.get(index));
        if (item instanceof PDFStream) streams.push(item);
      }
    }
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    const box = (b: { x: number; y: number; width: number; height: number }) =>
      [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 1000) / 1000).join(",");
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    return `${box(media)}|${box(crop)}|${rotation}|${streams.map(decodeStream).join("\n")}`;
  });
}

/** PDF sencillo de `pages` paginas con marcas (`marker`). */
export function simplePdf(pages: number, options: RichPdfOptions = {}): Promise<Uint8Array> {
  return makeRichPdf({ ...options, pages });
}

/** Un PNG de 1x1 pixel valido (para paginas desde imagenes). */
export const TINY_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
