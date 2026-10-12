import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import JSZip from "jszip";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PagesTab } from "@/app/pdf-pro/pages/PagesTab";
import { getPagesStore } from "@/app/pdf-pro/pages/pagesStore";
import { openRichDoc, pdfFileOf, renderWithDoc, testInputGuard } from "@/app/pdf-pro/pages/pagesTestUtils";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { buildEncryptedPdf } from "@/lib/pdf/testing/inputFixtures";
import { TINY_PNG, allStreamsText, inspectPdf, makeRichPdf, marker } from "@/lib/pdf/testing/pageAssemblyFixtures";

/**
 * Hojas del organizador: pagina en blanco, insertar desde otro PDF (con contrasena, lectura
 * lenta y archivos danados), imagenes, unir PDFs, extraer y dividir. Motores reales.
 */

const downloads = vi.hoisted(() => ({ items: [] as { blob: Blob; name: string }[] }));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const { PDFDocument: Doc } = await import("@cantoo/pdf-lib");
  return {
    ...actual,
    openPdfDocument: async (source: Uint8Array) => {
      const loaded = await Doc.load(source, { updateMetadata: false });
      return {
        numPages: loaded.getPageCount(),
        getPage: async (n: number) => ({ index: n - 1, cleanup: () => undefined }),
        loadingTask: { destroy: async () => undefined },
      };
    },
    renderPageToDataUrl: async (page: { index: number }) => `data:image/png;base64,${page.index}`,
    downloadBlob: (blob: Blob, name: string) => {
      downloads.items.push({ blob, name });
    },
  };
});

const S = PRO_STRINGS.es.pages;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  downloads.items.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function setup(options: Parameters<typeof openRichDoc>[0] = { pages: 5 }, name = "informe.pdf") {
  const { doc, bytes } = await openRichDoc(options, name);
  const utils = renderWithDoc(doc, <PagesTab />, testInputGuard());
  await screen.findAllByRole("option");
  return { doc, bytes, store: getPagesStore(doc), ...utils };
}

const mainCards = () => within(document.querySelector("[data-pages-tab] > [data-pages-grid]") as HTMLElement).getAllByRole("option");
const cardOf = (n: number) => screen.getAllByRole("option", { name: new RegExp(`^Página ${n} de`) })[0];
const labelOf = (name: string) => screen.getByRole("button", { name });
const input = (kind: "pdf" | "images" | "merge") => document.querySelector(`[data-pages-input="${kind}"]`) as HTMLInputElement;
const choose = (kind: "pdf" | "images" | "merge", files: File[]) => fireEvent.change(input(kind), { target: { files } });
const dialog = () => screen.getAllByRole("dialog").at(-1) as HTMLElement;
/** La hoja de arriba (al abrir una desde «Más» la anterior aun esta saliendo). */
async function topDialog(): Promise<HTMLElement> {
  await screen.findAllByRole("dialog");
  return dialog();
}
async function openMore(name: string) {
  fireEvent.click(labelOf(S.actions.more));
  fireEvent.click(await screen.findByRole("button", { name }));
}
const pdfOf = async (pages: number, baseWidth = 500, name = "otro.pdf", extra = {}) =>
  pdfFileOf(await makeRichPdf({ pages, baseWidth, ...extra }), name);
async function applyPlan(doc: Awaited<ReturnType<typeof setup>>["doc"]) {
  fireEvent.click(labelOf(S.status.apply));
  await waitFor(() => expect(doc.getState().document!.snapshots.length).toBeGreaterThan(1), { timeout: 10_000 });
}
const blobBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe("pagina en blanco", () => {
  it("inserta una pagina en blanco despues de la seleccionada con el tamano de su vecina", async () => {
    const ctx = await setup({ pages: 3, baseWidth: 420 });
    fireEvent.click(cardOf(2));
    await openMore(S.actions.insertBlank);
    expect(within(dialog()).getByText(S.sheets.blankSizeNeighbour)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: S.sheets.blankSubmit }));
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    expect(getPagesStore(ctx.doc).getState().plan[2].kind).toBe("blank");
    await applyPlan(ctx.doc);
    const info = await inspectPdf(ctx.doc.current() as Uint8Array);
    expect(info.pageCount).toBe(4);
    expect(info.markers[2]).toBeUndefined();
    expect(info.widths[2]).toBe(421);
  });

  it("A4 y Carta y varias paginas de una vez", async () => {
    const ctx = await setup({ pages: 2 });
    await openMore(S.actions.insertBlank);
    fireEvent.click(within(dialog()).getByRole("radio", { name: S.sheets.blankSizeLetter }));
    fireEvent.change(within(dialog()).getByLabelText(S.sheets.blankCount), { target: { value: "3" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: S.sheets.blankSubmit }));
    await waitFor(() => expect(mainCards()).toHaveLength(5));
    await applyPlan(ctx.doc);
    const info = await inspectPdf(ctx.doc.current() as Uint8Array);
    expect(info.widths.slice(2)).toEqual([612, 612, 612]);
    expect(ctx.doc.getState().document!.snapshots[1].label).toBe("Insertar 3 páginas en blanco");
  });

  it("la posicion «Al principio» la coloca la primera", async () => {
    const ctx = await setup({ pages: 2 });
    await openMore(S.actions.insertBlank);
    fireEvent.click(within(dialog()).getByRole("radio", { name: S.sheets.positionStart }));
    fireEvent.click(within(dialog()).getByRole("button", { name: S.sheets.blankSubmit }));
    await waitFor(() => expect(getPagesStore(ctx.doc).getState().plan[0].kind).toBe("blank"));
  });

  it("sin seleccion solo se ofrece al principio o al final", async () => {
    await setup({ pages: 2 });
    await openMore(S.actions.insertBlank);
    expect(within(dialog()).queryByRole("radio", { name: S.sheets.positionBefore })).toBeNull();
    expect(within(dialog()).getByRole("radio", { name: S.sheets.positionEnd })).toBeTruthy();
  });

  it("la blanca nueva queda seleccionada y deshacer la quita", async () => {
    const ctx = await setup({ pages: 3 });
    await openMore(S.actions.insertBlank);
    fireEvent.click(within(dialog()).getByRole("button", { name: S.sheets.blankSubmit }));
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    expect(getPagesStore(ctx.doc).getState().selection.size).toBe(1);
    fireEvent.click(labelOf(S.status.undo));
    expect(mainCards()).toHaveLength(3);
  });
});

describe("insertar desde otro PDF", () => {
  it("elegir un PDF abre la hoja, lee el archivo y ofrece sus paginas (todas elegidas)", async () => {
    await setup({ pages: 3 });
    choose("pdf", [await pdfOf(5)]);
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getAllByRole("option")).toHaveLength(5));
    expect(within(sheet).getByText("otro.pdf")).toBeTruthy();
    expect(within(sheet).getByText(S.sheets.pdfPagesChosen(5, 5))).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: S.sheets.pdfSubmit(5) })).toBeTruthy();
  });

  it("insertar un rango de paginas en medio y aplicar", async () => {
    const ctx = await setup({ pages: 3 });
    fireEvent.click(cardOf(1));
    choose("pdf", [await pdfOf(5)]);
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getAllByRole("option")).toHaveLength(5));
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.pdfSelectNone }));
    const sheetCards = within(sheet).getAllByRole("option");
    fireEvent.click(sheetCards[1]);
    fireEvent.click(sheetCards[2], { ctrlKey: true });
    expect(within(sheet).getByText(S.sheets.pdfPagesChosen(2, 5))).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.pdfSubmit(2) }));
    await waitFor(() => expect(mainCards()).toHaveLength(5));
    await applyPlan(ctx.doc);
    const info = await inspectPdf(ctx.doc.current() as Uint8Array);
    expect(info.widths).toEqual([300, 501, 502, 301, 302]);
    expect(ctx.doc.getState().document!.snapshots[1].label).toBe("Insertar 2 páginas de otros PDF");
  });

  it("sin elegir ninguna pagina no se puede insertar", async () => {
    await setup({ pages: 2 });
    choose("pdf", [await pdfOf(3)]);
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getAllByRole("option")).toHaveLength(3));
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.pdfSelectNone }));
    const submit = within(sheet).getByRole("button", { name: S.sheets.pdfNoneChosen });
    expect(submit.hasAttribute("disabled")).toBe(true);
  });

  it("cerrar la hoja sin insertar suelta el documento leido (no queda en el plan ni en memoria)", async () => {
    const ctx = await setup({ pages: 2 });
    choose("pdf", [await pdfOf(3)]);
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getAllByRole("option")).toHaveLength(3));
    expect(Object.keys(getPagesStore(ctx.doc).getState().sources)).toHaveLength(1);
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.close }));
    await waitFor(() => expect(Object.keys(getPagesStore(ctx.doc).getState().sources)).toHaveLength(0));
    expect(mainCards()).toHaveLength(2);
  });

  it("un PDF cifrado pide la contrasena y, con la correcta, se lee", async () => {
    await setup({ pages: 2 });
    const encrypted = pdfFileOf(await buildEncryptedPdf("secreto"), "cifrado.pdf");
    choose("pdf", [encrypted]);
    const password = await screen.findByLabelText("Contraseña", undefined, { timeout: 5000 });
    fireEvent.change(password, { target: { value: "secreto" } });
    fireEvent.submit(password.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.queryByLabelText("Contraseña")).toBeNull(), { timeout: 10_000 });
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getByText("cifrado.pdf")).toBeTruthy());
    await waitFor(() => expect(within(sheet).getAllByRole("option")).toHaveLength(1));
  });

  it("una contrasena equivocada se explica y deja reintentar", async () => {
    await setup({ pages: 2 });
    choose("pdf", [pdfFileOf(await buildEncryptedPdf("secreto"), "cifrado.pdf")]);
    const password = await screen.findByLabelText("Contraseña", undefined, { timeout: 5000 });
    fireEvent.change(password, { target: { value: "mala" } });
    fireEvent.submit(password.closest("form") as HTMLFormElement);
    await waitFor(() => expect(document.querySelector("[data-password-message]")?.textContent).toMatch(/no es correcta|incorrecta/i), { timeout: 10_000 });
  });

  it("un archivo que no es PDF se explica con el mensaje claro", async () => {
    await setup({ pages: 2 });
    choose("pdf", [new File(["hola"], "nota.pdf", { type: "application/pdf" })]);
    const sheet = await topDialog();
    await waitFor(() => expect(sheet.textContent).toMatch(/PDF/));
    expect(within(sheet).queryAllByRole("option")).toHaveLength(0);
    expect(within(sheet).queryByRole("button", { name: /^Insertar/ })).toBeNull();
  });

  it("un PDF danado se explica y no ofrece paginas", async () => {
    await setup({ pages: 2 });
    choose("pdf", [pdfFileOf(new TextEncoder().encode("%PDF-1.7\nbasura sin estructura"), "roto.pdf")]);
    const sheet = await topDialog();
    await waitFor(() => expect(sheet.textContent).toMatch(/dañad|abrir|arregl|no se puede/i), { timeout: 10_000 });
    expect(within(sheet).queryAllByRole("option")).toHaveLength(0);
  });

  it("lectura LENTA: mientras se lee no se puede insertar y al terminar no se pierde ninguna pagina", async () => {
    const ctx = await setup({ pages: 2 });
    const bytes = await makeRichPdf({ pages: 4, baseWidth: 640 });
    class SlowFile extends File {
      async arrayBuffer() {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return super.arrayBuffer();
      }
    }
    choose("pdf", [new SlowFile([bytes as unknown as BlobPart], "lento.pdf", { type: "application/pdf" })]);
    const sheet = await topDialog();
    expect(within(sheet).queryByRole("button", { name: /^Insertar/ })).toBeNull();
    expect(within(sheet).getByText(S.sheets.fileReading)).toBeTruthy();
    await waitFor(() => expect(within(sheet).getAllByRole("option")).toHaveLength(4), { timeout: 10_000 });
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.pdfSubmit(4) }));
    await waitFor(() => expect(mainCards()).toHaveLength(6));
    await applyPlan(ctx.doc);
    const info = await inspectPdf(ctx.doc.current() as Uint8Array);
    expect(info.widths).toEqual([300, 301, 640, 641, 642, 643]);
  });

  it("si el plan usa una fuente que aun no esta lista, «Aplicar» queda bloqueado y se explica", async () => {
    const ctx = await setup({ pages: 2 });
    const store = getPagesStore(ctx.doc);
    act(() => {
      store.addSource({ id: "x", kind: "pdf", name: "x.pdf", size: 1, status: "reading" });
      store.commit(
        [...store.getState().plan, { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0, id: "e1" }],
        "insertar",
      );
    });
    expect(labelOf(S.status.apply).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(S.status.cannotApplyReading)).toBeTruthy();
    act(() => {
      store.patchSource("x", { status: "error", error: "corrupt" });
    });
    expect(labelOf(S.status.apply).getAttribute("aria-disabled")).toBe("true");
  });

  it("el boton «Insertar desde PDF…» abre el selector de archivos", async () => {
    await setup({ pages: 2 });
    const click = vi.spyOn(input("pdf"), "click").mockImplementation(() => undefined);
    await openMore(S.actions.insertFromPdf);
    expect(click).toHaveBeenCalled();
  });

  it("inserta al principio con «Al principio»", async () => {
    const ctx = await setup({ pages: 2 });
    choose("pdf", [await pdfOf(2, 800)]);
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getAllByRole("option")).toHaveLength(2));
    fireEvent.click(within(sheet).getByRole("radio", { name: S.sheets.positionStart }));
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.pdfSubmit(2) }));
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    await applyPlan(ctx.doc);
    expect((await inspectPdf(ctx.doc.current() as Uint8Array)).widths).toEqual([800, 801, 300, 301]);
  });

  it("el PDF externo con campos de formulario trae sus campos y conserva los del documento", async () => {
    const ctx = await setup({ pages: 2, form: true });
    choose("pdf", [await pdfOf(2, 500, "form.pdf", { form: true })]);
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getAllByRole("option")).toHaveLength(2));
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.pdfSubmit(2) }));
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    await applyPlan(ctx.doc);
    const info = await inspectPdf(ctx.doc.current() as Uint8Array);
    expect(info.fieldNames.sort()).toEqual(["campo-1", "campo-1_2", "campo-2", "campo-2_2"]);
    expect(await allStreamsText(ctx.doc.current() as Uint8Array)).toContain(marker(1));
  });
});

describe("insertar imagenes", () => {
  const png = (name = "foto.png") => new File([TINY_PNG as unknown as BlobPart], name, { type: "image/png" });

  it("elegir imagenes abre la hoja con la lista y se insertan como paginas", async () => {
    const ctx = await setup({ pages: 2 });
    choose("images", [png("a.png"), png("b.png")]);
    const sheet = await topDialog();
    expect(within(sheet).getByText("a.png")).toBeTruthy();
    expect(within(sheet).getByText("b.png")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.imagesSubmit(2) }));
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    await applyPlan(ctx.doc);
    const info = await inspectPdf(ctx.doc.current() as Uint8Array);
    expect(info.pageCount).toBe(4);
    expect(info.widths.slice(2)).toEqual([595.28, 595.28]);
    expect(ctx.doc.getState().document!.snapshots[1].label).toBe("Insertar 2 imágenes");
  });

  it("el tamano de pagina elegido (Carta) se respeta", async () => {
    const ctx = await setup({ pages: 1 });
    choose("images", [png()]);
    const sheet = await topDialog();
    fireEvent.click(within(sheet).getByRole("radio", { name: S.sheets.imagesSizeLetter }));
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.imagesSubmit(1) }));
    await waitFor(() => expect(mainCards()).toHaveLength(2));
    await applyPlan(ctx.doc);
    expect((await inspectPdf(ctx.doc.current() as Uint8Array)).widths[1]).toBe(612);
  });

  it("un archivo que no es imagen aparece con su error y no se inserta", async () => {
    await setup({ pages: 1 });
    choose("images", [new File(["x"], "notas.txt", { type: "text/plain" })]);
    const sheet = await topDialog();
    expect(within(sheet).getByText("notas.txt")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: S.sheets.imagesSubmit(0) }).hasAttribute("disabled")).toBe(true);
  });

  it("se puede quitar una imagen de la lista antes de insertar", async () => {
    await setup({ pages: 1 });
    choose("images", [png("a.png"), png("b.png")]);
    const sheet = await topDialog();
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.removeFile("a.png") }));
    expect(within(sheet).queryByText("a.png")).toBeNull();
    expect(within(sheet).getByRole("button", { name: S.sheets.imagesSubmit(1) })).toBeTruthy();
  });

  it("las imagenes se insertan despues de la pagina seleccionada", async () => {
    const ctx = await setup({ pages: 3 });
    fireEvent.click(cardOf(1));
    choose("images", [png()]);
    const sheet = await topDialog();
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.imagesSubmit(1) }));
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    expect(getPagesStore(ctx.doc).getState().plan[1].kind).toBe("image");
  });
});

describe("unir PDFs", () => {
  it("anade varios documentos al final, con todas sus paginas y en orden", async () => {
    const ctx = await setup({ pages: 2 });
    choose("merge", [await pdfOf(2, 500, "a.pdf"), await pdfOf(3, 700, "b.pdf")]);
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getByRole("button", { name: S.sheets.mergeSubmit(2, 5) })).toBeTruthy(), { timeout: 10_000 });
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.mergeSubmit(2, 5) }));
    await waitFor(() => expect(mainCards().length).toBeGreaterThan(0));
    await waitFor(() => expect(getPagesStore(ctx.doc).getState().plan).toHaveLength(7));
    await applyPlan(ctx.doc);
    expect((await inspectPdf(ctx.doc.current() as Uint8Array)).widths).toEqual([300, 301, 500, 501, 700, 701, 702]);
  });

  it("mientras un documento se lee, «Añadir» no esta disponible", async () => {
    await setup({ pages: 2 });
    class SlowFile extends File {
      async arrayBuffer() {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return super.arrayBuffer();
      }
    }
    const bytes = await makeRichPdf({ pages: 2, baseWidth: 500 });
    choose("merge", [new SlowFile([bytes as unknown as BlobPart], "lento.pdf", { type: "application/pdf" })]);
    const sheet = await topDialog();
    const submit = within(sheet).getByRole("button", { name: S.sheets.mergeSubmit(0, 0) });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(within(sheet).getByRole("button", { name: S.sheets.mergeSubmit(1, 2) }).hasAttribute("disabled")).toBe(false), { timeout: 10_000 });
  });

  it("al principio tambien se puede", async () => {
    const ctx = await setup({ pages: 2 });
    choose("merge", [await pdfOf(1, 500, "a.pdf")]);
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getByRole("button", { name: S.sheets.mergeSubmit(1, 1) }).hasAttribute("disabled")).toBe(false), { timeout: 10_000 });
    fireEvent.click(within(sheet).getByRole("radio", { name: S.sheets.positionStart }));
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.mergeSubmit(1, 1) }));
    await waitFor(() => expect(getPagesStore(ctx.doc).getState().plan[0].kind).toBe("external"));
  });

  it("el maximo es 10 documentos: el 11.º se rechaza y se avisa", async () => {
    const ctx = await setup({ pages: 1 });
    const spoken: string[] = [];
    ctx.doc.subscribe(() => {
      const text = ctx.doc.getState().announcement?.text;
      if (text && spoken[spoken.length - 1] !== text) spoken.push(text);
    });
    const files = await Promise.all(Array.from({ length: 11 }, (_, i) => pdfOf(1, 400 + i, `d${i}.pdf`)));
    choose("merge", files);
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getAllByRole("listitem")).toHaveLength(10), { timeout: 10_000 });
    expect(spoken).toContain(S.announce.limitReached);
    expect(getPagesStore(ctx.doc).pdfSourceCount()).toBe(10);
  });

  it("el 11.º ademas se explica con un aviso VISIBLE (cuantos y cuales), que se puede cerrar", async () => {
    const ctx = await setup({ pages: 1 });
    const files = await Promise.all(Array.from({ length: 13 }, (_, i) => pdfOf(1, 400 + i, `doc${i + 1}.pdf`)));
    choose("merge", files);
    await topDialog();
    const note = await waitFor(() => {
      const found = document.querySelector("[data-pages-omitted]") as HTMLElement | null;
      expect(found).not.toBeNull();
      return found!;
    });
    expect(note.textContent).toContain(S.announce.omittedTitle(3, 10));
    expect(note.textContent).toContain("doc11.pdf, doc12.pdf, doc13.pdf");
    expect(note.getAttribute("role")).toBe("note");
    // No es una segunda region viva: el anuncio sigue siendo UNICO (en el documento de trabajo).
    expect(note.getAttribute("aria-live")).toBeNull();
    expect(note.closest("[aria-live]")).toBeNull();
    expect(ctx.doc.getState().document).not.toBeNull();
    fireEvent.click(within(note).getByRole("button", { name: S.announce.omittedDismiss }));
    expect(document.querySelector("[data-pages-omitted]")).toBeNull();
  });

  it("con 10 documentos ya añadidos, uno mas desde «Insertar desde PDF» tambien lo avisa con su nombre", async () => {
    const ctx = await setup({ pages: 1 });
    choose("merge", await Promise.all(Array.from({ length: 10 }, (_, i) => pdfOf(1, 400 + i, `base${i}.pdf`))));
    await topDialog();
    await waitFor(() => expect(getPagesStore(ctx.doc).pdfSourceCount()).toBe(10));
    choose("pdf", [await pdfOf(1, 700, "extra.pdf")]);
    await waitFor(() => expect(document.querySelector("[data-pages-omitted]")?.textContent).toContain("extra.pdf"));
  });

  it("quitar un documento de la lista lo suelta", async () => {
    const ctx = await setup({ pages: 1 });
    choose("merge", [await pdfOf(1, 500, "a.pdf"), await pdfOf(1, 600, "b.pdf")]);
    const sheet = await topDialog();
    await waitFor(() => expect(within(sheet).getAllByRole("listitem")).toHaveLength(2));
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.removeFile("a.pdf") }));
    expect(getPagesStore(ctx.doc).pdfSourceCount()).toBe(1);
  });
});

describe("extraer paginas", () => {
  it("descarga un PDF nuevo con SOLO las paginas seleccionadas y no toca el documento", async () => {
    const ctx = await setup({ pages: 5, title: "Libro", form: true, outline: true });
    fireEvent.click(cardOf(2));
    fireEvent.click(cardOf(4), { ctrlKey: true });
    await openMore(S.actions.extract);
    const sheet = dialog();
    expect(within(sheet).getByText(S.sheets.extractBody(2))).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.extractDownload }));
    await waitFor(() => expect(downloads.items).toHaveLength(1));
    expect(downloads.items[0].name).toBe("informe-extraido.pdf");
    const info = await inspectPdf(await blobBytes(downloads.items[0].blob));
    expect(info.markers).toEqual([marker(1), marker(3)]);
    expect(info.title).toBe("Libro");
    expect(info.fieldNames.sort()).toEqual(["campo-2", "campo-4"]);
    expect(ctx.doc.getState().document!.snapshots).toHaveLength(1);
    expect(mainCards()).toHaveLength(5);
  });

  it("se puede cambiar el nombre y se le anade .pdf", async () => {
    await setup({ pages: 3 });
    fireEvent.click(cardOf(1));
    await openMore(S.actions.extract);
    fireEvent.change(within(dialog()).getByLabelText(S.sheets.extractName), { target: { value: "mis paginas" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: S.sheets.extractDownload }));
    await waitFor(() => expect(downloads.items).toHaveLength(1));
    expect(downloads.items[0].name).toBe("mis paginas.pdf");
  });

  it("extrae lo que se ve (con cambios sin aplicar) en el orden del plan", async () => {
    await setup({ pages: 4 });
    fireEvent.click(cardOf(4));
    fireEvent.click(labelOf(S.actions.moveBefore));
    fireEvent.click(labelOf(S.actions.moveBefore));
    fireEvent.click(labelOf(S.actions.moveBefore));
    fireEvent.click(cardOf(2), { ctrlKey: true });
    await openMore(S.actions.extract);
    fireEvent.click(within(dialog()).getByRole("button", { name: S.sheets.extractDownload }));
    await waitFor(() => expect(downloads.items).toHaveLength(1));
    const info = await inspectPdf(await blobBytes(downloads.items[0].blob));
    expect(info.markers).toEqual([marker(3), marker(0)]);
  });

  it("«Abrir como documento nuevo» pide confirmacion y reemplaza el documento de trabajo", async () => {
    const ctx = await setup({ pages: 4 });
    fireEvent.click(cardOf(3));
    await openMore(S.actions.extract);
    fireEvent.click(within(dialog()).getByRole("button", { name: S.sheets.extractOpen }));
    fireEvent.click(await screen.findByRole("button", { name: S.sheets.extractOpenConfirm }));
    await waitFor(() => expect(ctx.doc.getState().pageCount).toBe(1));
    expect(ctx.doc.getState().document!.name).toBe("informe-extraido.pdf");
    expect(downloads.items).toHaveLength(0);
  });

  it("extraer sin seleccion no esta disponible", async () => {
    await setup({ pages: 3 });
    fireEvent.click(labelOf(S.actions.more));
    const button = await screen.findByRole("button", { name: S.actions.extract });
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

describe("dividir", () => {
  it("por rangos: un ZIP con un PDF por rango, con nombres unicos", async () => {
    await setup({ pages: 6, title: "Libro" });
    await openMore(S.actions.split);
    const sheet = dialog();
    fireEvent.change(await within(sheet).findByLabelText(S.sheets.splitRangesLabel), { target: { value: "1-2, 4, 5-6" } });
    await waitFor(() => expect(within(sheet).getByText(/Se crearán 3 archivos/)).toBeTruthy());
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.splitSubmit }));
    await waitFor(() => expect(downloads.items).toHaveLength(1));
    expect(downloads.items[0].name).toBe("informe-dividido.zip");
    const zip = await JSZip.loadAsync(await blobBytes(downloads.items[0].blob));
    expect(Object.keys(zip.files).sort()).toEqual(["informe-1-2.pdf", "informe-4.pdf", "informe-5-6.pdf"]);
    const part = await inspectPdf(await zip.files["informe-5-6.pdf"].async("uint8array"));
    expect(part.markers).toEqual([marker(4), marker(5)]);
    expect(part.title).toBe("Libro");
  });

  it("cada N paginas", async () => {
    await setup({ pages: 7 });
    await openMore(S.actions.split);
    const sheet = dialog();
    fireEvent.click(await within(sheet).findByRole("tab", { name: S.sheets.splitModeEvery }));
    fireEvent.change(within(sheet).getByLabelText(S.sheets.splitEveryLabel), { target: { value: "3" } });
    await waitFor(() => expect(within(sheet).getByText(/Se crearán 3 archivos/)).toBeTruthy());
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.splitSubmit }));
    await waitFor(() => expect(downloads.items).toHaveLength(1));
    const zip = await JSZip.loadAsync(await blobBytes(downloads.items[0].blob));
    expect(Object.keys(zip.files)).toHaveLength(3);
  });

  it("por marcadores: una parte por marcador con su titulo", async () => {
    await setup({ pages: 3, outline: true });
    await openMore(S.actions.split);
    const sheet = dialog();
    fireEvent.click(await within(sheet).findByRole("tab", { name: S.sheets.splitModeBookmarks }));
    await waitFor(() => expect(within(sheet).getByText(/Se crearán 3 archivos/)).toBeTruthy());
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.splitSubmit }));
    await waitFor(() => expect(downloads.items).toHaveLength(1));
    const zip = await JSZip.loadAsync(await blobBytes(downloads.items[0].blob));
    expect(Object.keys(zip.files).sort()).toEqual(["informe - Capitulo 1.pdf", "informe - Capitulo 2.pdf", "informe - Capitulo 3.pdf"]);
  });

  it("por marcadores en un documento SIN marcadores avisa de que saldria un solo archivo", async () => {
    await setup({ pages: 3 });
    await openMore(S.actions.split);
    const sheet = dialog();
    fireEvent.click(await within(sheet).findByRole("tab", { name: S.sheets.splitModeBookmarks }));
    await waitFor(() => expect(within(sheet).getByText(S.sheets.splitNoBookmarks)).toBeTruthy());
  });

  it("un rango fuera del documento muestra el error y no se puede dividir", async () => {
    await setup({ pages: 3 });
    await openMore(S.actions.split);
    const sheet = dialog();
    fireEvent.change(await within(sheet).findByLabelText(S.sheets.splitRangesLabel), { target: { value: "2-9" } });
    expect((await within(sheet).findByRole("alert")).textContent).toContain("1 y 3");
    expect(within(sheet).getByRole("button", { name: S.sheets.splitSubmit }).hasAttribute("disabled")).toBe(true);
  });

  it("un solo rango descarga un PDF, no un ZIP", async () => {
    await setup({ pages: 4 });
    await openMore(S.actions.split);
    const sheet = dialog();
    fireEvent.change(await within(sheet).findByLabelText(S.sheets.splitRangesLabel), { target: { value: "2-3" } });
    await waitFor(() => expect(within(sheet).getByText(/Se creará 1 archivo/)).toBeTruthy());
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.splitSubmit }));
    await waitFor(() => expect(downloads.items).toHaveLength(1));
    expect(downloads.items[0].name).toBe("informe-2-3.pdf");
    expect(downloads.items[0].blob.type).toBe("application/pdf");
  });

  it("con cambios sin aplicar divide el documento TAL COMO SE VE y lo avisa", async () => {
    await setup({ pages: 5 });
    fireEvent.click(cardOf(1));
    fireEvent.click(labelOf(S.actions.remove));
    await openMore(S.actions.split);
    const sheet = dialog();
    expect(await within(sheet).findByText(S.sheets.splitPending)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("tab", { name: S.sheets.splitModeEvery }));
    fireEvent.change(within(sheet).getByLabelText(S.sheets.splitEveryLabel), { target: { value: "2" } });
    await waitFor(() => expect(within(sheet).getByText(/Se crearán 2 archivos/)).toBeTruthy(), { timeout: 10_000 });
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.splitSubmit }));
    await waitFor(() => expect(downloads.items).toHaveLength(1));
    const zip = await JSZip.loadAsync(await blobBytes(downloads.items[0].blob));
    const first = await inspectPdf(await zip.files["informe-1-2.pdf"].async("uint8array"));
    expect(first.markers).toEqual([marker(1), marker(2)]);
  });

  it("no modifica el documento de trabajo", async () => {
    const ctx = await setup({ pages: 4 });
    await openMore(S.actions.split);
    const sheet = dialog();
    fireEvent.change(await within(sheet).findByLabelText(S.sheets.splitRangesLabel), { target: { value: "1, 2" } });
    await waitFor(() => expect(within(sheet).getByText(/Se crearán 2 archivos/)).toBeTruthy());
    fireEvent.click(within(sheet).getByRole("button", { name: S.sheets.splitSubmit }));
    await waitFor(() => expect(downloads.items).toHaveLength(1));
    expect(ctx.doc.getState().document!.snapshots).toHaveLength(1);
  });
});

describe("la barra ancha", () => {
  it("con el panel ancho aparece la barra completa con todos los botones y sin la barra compacta", async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 900 });
    try {
      const ctx = await setup({ pages: 3 });
      const toolbar = document.querySelector("[data-pages-toolbar]") as HTMLElement;
      expect(toolbar.hasAttribute("data-compact")).toBe(false);
      for (const name of [S.actions.selectAll, S.actions.selectOdd, S.actions.selectEven, S.actions.selectRange, S.actions.insertBlank, S.actions.insertFromPdf, S.actions.insertImages, S.actions.mergePdfs, S.actions.extract, S.actions.split]) {
        expect(within(toolbar).getByRole("button", { name })).toBeTruthy();
      }
      expect(screen.queryByRole("button", { name: S.actions.more })).toBeNull();
      fireEvent.click(within(toolbar).getByRole("button", { name: S.actions.selectAll }));
      expect(getPagesStore(ctx.doc).getState().selection.size).toBe(3);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    }
  });
});
