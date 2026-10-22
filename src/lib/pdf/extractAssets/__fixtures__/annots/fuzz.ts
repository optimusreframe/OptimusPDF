/** Anotaciones GENERADAS AL AZAR (semilla fija) y deliberadamente rotas, para las pruebas de robustez. Solo pruebas. */

import { PDFDocument, PDFHexString, PDFName, PDFString } from "@cantoo/pdf-lib";

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const SUBTYPES = ["Ink", "Stamp", "Widget", "Watermark", "FreeText", "Link", "Highlight", "Popup", "Text", "Square", "Unknown"];

function garbage(random: () => number, depth = 0): unknown {
  const kind = Math.floor(random() * 9);
  switch (kind) {
    case 0: return Math.floor(random() * 2000) - 500;
    case 1: return random() * 1e9;
    case 2: return -random() * 1e9;
    case 3: return PDFString.of("texto");
    case 4: return PDFName.of("Nombre");
    case 5: return depth < 2 ? Array.from({ length: Math.floor(random() * 8) }, () => garbage(random, depth + 1)) : 0;
    case 6: return depth < 2 ? { W: garbage(random, depth + 1), S: PDFName.of("S") } : {};
    case 7: return null;
    default: return PDFHexString.of("00ff");
  }
}

export async function randomDocument(seed: number): Promise<Uint8Array> {
  const random = lcg(seed);
  const doc = await PDFDocument.create();
  const pages = 1 + Math.floor(random() * 3);
  for (let p = 0; p < pages; p += 1) {
    const page = doc.addPage([300 + random() * 400, 300 + random() * 600]);
    const refs = [];
    const count = 2 + Math.floor(random() * 10);
    for (let i = 0; i < count; i += 1) {
      const subtype = SUBTYPES[Math.floor(random() * SUBTYPES.length)];
      const dict: Record<string, unknown> = { Type: "Annot", Subtype: subtype, P: page.ref };
      const keys = ["Rect", "InkList", "C", "BS", "CA", "F", "AP", "FT", "V", "T", "Name", "Contents", "QuadPoints", "Parent"];
      for (const key of keys) {
        if (random() < 0.55) dict[key] = garbage(random);
      }
      if (random() < 0.5) dict.Rect = [random() * 300, random() * 300, random() * 400, random() * 400].map((n) => Math.round(n));
      if (subtype === "Ink" && random() < 0.6) dict.InkList = [Array.from({ length: 2 + Math.floor(random() * 30) }, () => Math.round(random() * 500))];
      if (subtype === "Widget" && random() < 0.6) dict.FT = PDFName.of("Sig");
      refs.push(doc.context.register(doc.context.obj(dict as never)));
    }
    page.node.set(PDFName.of("Annots"), doc.context.obj(refs as never));
  }
  return doc.save();
}
