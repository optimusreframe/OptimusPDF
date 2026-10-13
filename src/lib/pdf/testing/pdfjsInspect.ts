/**
 * Lectores de un PDF resultante hechos con pdf.js (el lector que usan los navegadores), AJENOS al motor
 * de paginas: lo que el motor escribio se comprueba como lo veria un visor real. Corre en Node
 * (build «legacy» de pdfjs-dist); sin imports con alias para que lo usen tanto Vitest como Playwright.
 */

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;
function getPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

type Document = Awaited<ReturnType<Pdfjs["getDocument"]>["promise"]>;

async function withDocument<T>(bytes: Uint8Array, fn: (pdf: Document) => Promise<T>): Promise<T> {
  const pdfjs = await getPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  try {
    return await fn(pdf);
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Etiquetas de pagina tal como las lee pdf.js (`null` si el documento no tiene `/PageLabels`). */
export async function pdfjsPageLabels(bytes: Uint8Array): Promise<string[] | null> {
  return withDocument(bytes, (pdf) => pdf.getPageLabels());
}

export type PdfjsLink =
  /** Salta a la pagina `page` (0-based) del propio documento. */
  | { kind: "page"; page: number }
  | { kind: "url"; url: string }
  /** Un destino que no lleva a ninguna pagina del documento. */
  | { kind: "broken" };

type Dest = string | unknown[] | null | undefined;

async function destToPage(pdf: Document, dest: Dest): Promise<number | null> {
  let explicit: unknown = dest;
  if (typeof dest === "string") explicit = await pdf.getDestination(dest);
  if (!Array.isArray(explicit)) return null;
  const target = explicit[0] as { num: number; gen: number } | number | null;
  if (target && typeof target === "object") {
    try {
      return await pdf.getPageIndex(target as never);
    } catch {
      return null;
    }
  }
  return typeof target === "number" ? target : null;
}

/** Enlaces de cada pagina (en orden de aparicion): a que pagina saltan (0-based) o a que URL. */
export async function pdfjsLinks(bytes: Uint8Array): Promise<PdfjsLink[][]> {
  return withDocument(bytes, async (pdf) => {
    const out: PdfjsLink[][] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const annotations = await page.getAnnotations();
      const links: PdfjsLink[] = [];
      for (const annotation of annotations) {
        if (annotation.subtype !== "Link") continue;
        if (annotation.url) {
          links.push({ kind: "url", url: String(annotation.url) });
          continue;
        }
        const target = await destToPage(pdf, annotation.dest as Dest);
        links.push(target === null ? { kind: "broken" } : { kind: "page", page: target });
      }
      out.push(links);
    }
    return out;
  });
}

export type PdfjsOutlineItem = { title: string; page: number | null; depth: number };

/** Marcadores en orden de documento, con la pagina (0-based) a la que saltan. */
export async function pdfjsOutline(bytes: Uint8Array): Promise<PdfjsOutlineItem[]> {
  return withDocument(bytes, async (pdf) => {
    const outline = await pdf.getOutline();
    const items: PdfjsOutlineItem[] = [];
    const visit = async (nodes: NonNullable<typeof outline>, depth: number) => {
      for (const node of nodes) {
        items.push({ title: node.title, page: await destToPage(pdf, node.dest as Dest), depth });
        if (node.items?.length) await visit(node.items as NonNullable<typeof outline>, depth + 1);
      }
    };
    if (outline) await visit(outline, 0);
    return items;
  });
}

export type PdfjsStruct = { role: string; children: PdfjsStruct[]; content: string[] };

/** Arbol de estructura (PDF etiquetado) de una pagina (1-based) segun pdf.js, o `null` si no lo tiene. */
export async function pdfjsStructTree(bytes: Uint8Array, pageNumber: number): Promise<PdfjsStruct | null> {
  return withDocument(bytes, async (pdf) => {
    const page = await pdf.getPage(pageNumber);
    const tree = await page.getStructTree();
    if (!tree) return null;
    type Raw = { role?: string; type?: string; id?: string; children?: Raw[] };
    const convert = (node: Raw): PdfjsStruct => {
      const children: PdfjsStruct[] = [];
      const content: string[] = [];
      for (const child of node.children ?? []) {
        if (child.type === "content" || child.type === "object") {
          if (child.id) content.push(child.id);
        } else {
          children.push(convert(child));
        }
      }
      return { role: node.role ?? "", children, content };
    };
    return convert(tree as Raw);
  });
}

/** Roles de un arbol de estructura en profundidad (`["Root", "Document", "P"...]`), sin la raiz. */
export function structRoles(tree: PdfjsStruct | null): string[] {
  if (!tree) return [];
  const roles: string[] = [];
  const visit = (node: PdfjsStruct) => {
    for (const child of node.children) {
      roles.push(child.role);
      visit(child);
    }
  };
  visit(tree);
  return roles;
}

/** Cantidad de contenidos marcados que cuelgan del arbol. */
export function structContentCount(tree: PdfjsStruct | null): number {
  if (!tree) return 0;
  return tree.content.length + tree.children.reduce((total, child) => total + structContentCount(child), 0);
}
