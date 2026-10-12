import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { PagesStore, MAX_PAGES_PDF_SOURCES } from "@/app/pdf-pro/pages/pagesStore";
import { addImageFiles, addPdfFiles, isImageFile, newSourceId, unlockPdfSource } from "@/app/pdf-pro/pages/pagesSources";
import { testInputGuard } from "@/app/pdf-pro/pages/pagesTestUtils";
import { pdfFileOf } from "@/app/pdf-pro/pages/pagesTestUtils";
import { buildEncryptedPdf } from "@/lib/pdf/testing/inputFixtures";
import { TINY_PNG, makeRichPdf } from "@/lib/pdf/testing/pageAssemblyFixtures";

/** Lectura de los documentos e imagenes que se suman al organizador (motores reales, sin pdf.js). */

const store = () => {
  const s = new PagesStore();
  s.syncBase("s1", 3);
  return s;
};
const guard = testInputGuard();
const png = (name = "a.png", type = "image/png") => new File([TINY_PNG as unknown as BlobPart], name, { type });

afterEach(() => vi.restoreAllMocks());

describe("isImageFile / newSourceId", () => {
  it("reconoce imagenes por tipo MIME o, sin tipo, por extension", () => {
    expect(isImageFile(png("a.png"))).toBe(true);
    expect(isImageFile(png("a.jpg", "image/jpeg"))).toBe(true);
    expect(isImageFile(new File(["x"], "b.webp", { type: "" }))).toBe(true);
    expect(isImageFile(new File(["x"], "b.avif", { type: "" }))).toBe(true);
    expect(isImageFile(new File(["x"], "b.txt", { type: "text/plain" }))).toBe(false);
    expect(isImageFile(new File(["x"], "b.pdf", { type: "application/pdf" }))).toBe(false);
    expect(isImageFile(new File(["x"], "sin-extension", { type: "" }))).toBe(false);
  });

  it("los ids de fuente no se repiten", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSourceId("pdf")));
    expect(ids.size).toBe(200);
  });
});

describe("addImageFiles", () => {
  it("una imagen valida queda lista con su vista previa", () => {
    const s = store();
    const url = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const { ids } = addImageFiles({ store: s }, [png()]);
    expect(url).toHaveBeenCalled();
    expect(s.getState().sources[ids[0]]).toMatchObject({ kind: "image", status: "ready", previewUrl: "blob:preview", pageCount: 1 });
  });

  it("un archivo que no es imagen queda en error `invalidType` (visible, no se descarta)", () => {
    const s = store();
    const { ids } = addImageFiles({ store: s }, [new File(["x"], "n.txt", { type: "text/plain" })]);
    expect(s.getState().sources[ids[0]]).toMatchObject({ status: "error", error: "invalidType" });
  });

  it("una imagen vacia es `emptyFile` y una enorme `tooLarge`", () => {
    const s = store();
    const huge = new File([""], "g.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: 101 * 1024 * 1024 });
    const { ids } = addImageFiles({ store: s }, [new File([], "v.png", { type: "image/png" }), huge]);
    expect(s.getState().sources[ids[0]].error).toBe("emptyFile");
    expect(s.getState().sources[ids[1]].error).toBe("tooLarge");
  });

  it("devuelve un id por archivo, en orden", () => {
    const s = store();
    const { ids } = addImageFiles({ store: s }, [png("a.png"), png("b.png"), png("c.png")]);
    expect(ids.map((id) => s.getState().sources[id].name)).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("si no se puede crear la URL de vista previa la imagen sigue siendo utilizable", () => {
    const s = store();
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("no URL");
    });
    const { ids } = addImageFiles({ store: s }, [png()]);
    expect(s.getState().sources[ids[0]]).toMatchObject({ status: "ready", previewUrl: undefined });
  });
});

describe("addPdfFiles", () => {
  it("un PDF valido pasa de `reading` a `ready` con su recuento y sus tamanos", async () => {
    const s = store();
    const file = pdfFileOf(await makeRichPdf({ pages: 4, baseWidth: 410 }), "otro.pdf");
    const { ids } = addPdfFiles({ store: s, guard }, [file]);
    expect(s.getState().sources[ids[0]].status).toBe("reading");
    await waitFor(() => expect(s.getState().sources[ids[0]].status).toBe("ready"));
    const source = s.getState().sources[ids[0]];
    expect(source.pageCount).toBe(4);
    expect(source.infos?.map((info) => info.width)).toEqual([410, 411, 412, 413]);
    expect(source.data?.byteLength).toBeGreaterThan(100);
  });

  it("lee el contenido de verdad: un PDF de 0 paginas validas o danado queda en error", async () => {
    const s = store();
    const { ids } = addPdfFiles({ store: s, guard }, [pdfFileOf(new TextEncoder().encode("%PDF-1.7\nbasura"), "roto.pdf")]);
    await waitFor(() => expect(s.getState().sources[ids[0]].status).toBe("error"));
    expect(s.getState().sources[ids[0]].error).toBe("corrupt");
  });

  it("un archivo vacio es `emptyFile` y un texto con extension .pdf es `notPdf`", async () => {
    const s = store();
    const { ids } = addPdfFiles({ store: s, guard }, [
      new File([], "vacio.pdf", { type: "application/pdf" }),
      pdfFileOf(new TextEncoder().encode("hola, no soy pdf"), "texto.pdf"),
    ]);
    await waitFor(() => expect(s.getState().sources[ids[1]].status).toBe("error"));
    await waitFor(() => expect(s.getState().sources[ids[0]].status).toBe("error"));
    expect(s.getState().sources[ids[0]].error).toBe("emptyFile");
    expect(s.getState().sources[ids[1]].error).toBe("notPdf");
  });

  it("un PDF cifrado queda a la espera de contrasena y la correcta lo abre", async () => {
    const s = store();
    const { ids } = addPdfFiles({ store: s, guard }, [pdfFileOf(await buildEncryptedPdf("secreto"), "cifrado.pdf")]);
    await waitFor(() => expect(s.getState().sources[ids[0]].status).toBe("password"), { timeout: 10_000 });
    expect(await unlockPdfSource({ store: s, guard }, ids[0], "mala")).toBe("wrongPassword");
    expect(s.getState().sources[ids[0]].status).toBe("password");
    expect(await unlockPdfSource({ store: s, guard }, ids[0], "secreto")).toBe("ready");
    expect(s.getState().sources[ids[0]]).toMatchObject({ status: "ready", pageCount: 1, decrypted: true });
  });

  it("`unlockPdfSource` de una fuente que no existe falla sin lanzar", async () => {
    expect(await unlockPdfSource({ store: store(), guard }, "x", "a")).toBe("failed");
  });

  it("respeta el limite de 10 PDF: los que sobran se rechazan y se cuentan", async () => {
    const s = store();
    const bytes = await makeRichPdf({ pages: 1 });
    const files = Array.from({ length: MAX_PAGES_PDF_SOURCES + 3 }, (_, index) => pdfFileOf(bytes, `d${index}.pdf`));
    const { ids, rejected } = addPdfFiles({ store: s, guard }, files);
    expect(ids).toHaveLength(MAX_PAGES_PDF_SOURCES);
    expect(rejected).toBe(3);
    expect(s.pdfSourceCount()).toBe(MAX_PAGES_PDF_SOURCES);
    await waitFor(() => expect(ids.every((id) => s.getState().sources[id].status === "ready")).toBe(true), { timeout: 10_000 });
  });

  it("lectura LENTA: queda `reading` hasta terminar y entonces trae TODAS las paginas", async () => {
    const s = store();
    const bytes = await makeRichPdf({ pages: 6, baseWidth: 333 });
    class SlowFile extends File {
      async arrayBuffer() {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return super.arrayBuffer();
      }
    }
    const file = new SlowFile([bytes as unknown as BlobPart], "lento.pdf", { type: "application/pdf" });
    const { ids } = addPdfFiles({ store: s, guard }, [file]);
    expect(s.getState().sources[ids[0]].status).toBe("reading");
    expect(s.getState().sources[ids[0]].pageCount).toBeUndefined();
    await waitFor(() => expect(s.getState().sources[ids[0]].status).toBe("ready"), { timeout: 10_000 });
    expect(s.getState().sources[ids[0]].pageCount).toBe(6);
  });

  it("sin comprobacion de entrada (pruebas) tambien lee el archivo", async () => {
    const s = store();
    const { ids } = addPdfFiles({ store: s }, [pdfFileOf(await makeRichPdf({ pages: 2 }), "a.pdf")]);
    await waitFor(() => expect(s.getState().sources[ids[0]].status).toBe("ready"));
  });
});
