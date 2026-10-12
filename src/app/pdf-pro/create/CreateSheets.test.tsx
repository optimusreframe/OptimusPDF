import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { useProCreate } from "@/app/pdf-pro/create/useProCreate";
import { PdfError } from "@/lib/pdf/core";
import { es } from "@/lib/locales/es";

/**
 * «Nuevo PDF desde imágenes» y «Nuevo documento en blanco» (U8): selector, orden, tamaño y margen, creacion con el
 * motor de «Imagen a PDF» (carga diferida) y entrega del PDF a la suite.
 */

const engine = vi.hoisted(() => ({ imagesToPdf: vi.fn() }));
vi.mock("@/lib/pdf/imagesToPdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/imagesToPdf")>();
  return { ...actual, imagesToPdf: engine.imagesToPdf };
});

const C = PRO_STRINGS.es.create;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterAll(() => window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es"));
beforeEach(() => {
  engine.imagesToPdf.mockReset();
  engine.imagesToPdf.mockResolvedValue({ blob: new Blob(["%PDF-fake"], { type: "application/pdf" }), kind: "pdf", count: 1 });
});
afterEach(() => cleanup());

const created: File[] = [];
function Harness() {
  const create = useProCreate((file) => created.push(file));
  return (
    <div>
      <button onClick={create.pickImages}>imagenes</button>
      <button onClick={create.openBlank}>blanco</button>
      {create.node}
    </div>
  );
}
function mount() {
  created.length = 0;
  return render(
    <LanguageProvider>
      <Harness />
    </LanguageProvider>,
  );
}
const input = () => document.querySelector<HTMLInputElement>("[data-pro-create-input]")!;
const image = (name: string, size = 10, type = "image/png") => new File([new Uint8Array(size)], name, { type });
const pick = (...files: File[]) => fireEvent.change(input(), { target: { files } });

describe("selector de imagenes", () => {
  it("el selector acepta varias imagenes y esta oculto al teclado y a los lectores", () => {
    mount();
    expect(input().accept).toBe("image/*");
    expect(input().multiple).toBe(true);
    expect(input().tabIndex).toBe(-1);
    expect(input().getAttribute("aria-hidden")).toBe("true");
  });

  it("elegir imagenes abre la hoja con la lista en el orden elegido", async () => {
    mount();
    pick(image("b.png"), image("a.jpg", 10, "image/jpeg"));
    const list = await screen.findByRole("list", { name: C.images.listLabel });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("1. b.png"),
      expect.stringContaining("2. a.jpg"),
    ]);
    expect(screen.getByText(new RegExp(C.images.count(2)))).toBeTruthy();
  });

  it("subir y bajar reordena (y los extremos no se mueven)", async () => {
    mount();
    pick(image("a.png"), image("b.png"), image("c.png"));
    const list = await screen.findByRole("list", { name: C.images.listLabel });
    const names = () => within(list).getAllByRole("listitem").map((li) => li.querySelector("span")?.textContent);
    expect(names()).toEqual(["1. a.png", "2. b.png", "3. c.png"]);
    expect(screen.getByRole("button", { name: C.images.moveUp("a.png") }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: C.images.moveDown("a.png") }));
    expect(names()).toEqual(["1. b.png", "2. a.png", "3. c.png"]);
    fireEvent.click(screen.getByRole("button", { name: C.images.moveUp("c.png") }));
    expect(names()).toEqual(["1. b.png", "2. c.png", "3. a.png"]);
  });

  it("quitar una imagen la saca de la lista; sin imagenes «Crear PDF» queda inactivo", async () => {
    mount();
    pick(image("a.png"));
    await screen.findByRole("list", { name: C.images.listLabel });
    fireEvent.click(screen.getByRole("button", { name: C.images.remove("a.png") }));
    expect(screen.getByText(C.images.none)).toBeTruthy();
    expect(screen.getByRole("button", { name: C.images.create }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: C.images.create }));
    expect(engine.imagesToPdf).not.toHaveBeenCalled();
  });

  it("lo que no es imagen se omite y se dice", async () => {
    mount();
    pick(image("a.png"), new File(["x"], "nota.txt", { type: "text/plain" }));
    await screen.findByRole("list", { name: C.images.listLabel });
    expect(screen.getByText(C.images.notImage("nota.txt"))).toBeTruthy();
    expect(within(screen.getByRole("list", { name: C.images.listLabel })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("sin tipo MIME se reconoce por la extension", async () => {
    mount();
    pick(image("foto.JPEG", 5, ""));
    const list = await screen.findByRole("list", { name: C.images.listLabel });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });

  it("cancelar el selector (sin archivos) no abre nada", () => {
    mount();
    pick();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("crear el PDF desde imagenes", () => {
  it("llama al motor con las imagenes en orden, UN documento, y entrega el File", async () => {
    mount();
    pick(image("b.png"), image("a.png"));
    await screen.findByRole("list", { name: C.images.listLabel });
    fireEvent.click(screen.getByRole("button", { name: C.images.moveDown("b.png") }));
    fireEvent.click(screen.getByRole("button", { name: C.images.create }));
    await waitFor(() => expect(created).toHaveLength(1));
    const [files, options] = engine.imagesToPdf.mock.calls[0];
    expect(files.map((file: File) => file.name)).toEqual(["a.png", "b.png"]);
    expect(options).toMatchObject({ merge: true, pageSize: "a4", margin: "none", orientation: "auto" });
    expect(created[0].name).toBe(C.images.fileName);
    expect(created[0].type).toBe("application/pdf");
  });

  it("tamaño y margen elegidos llegan al motor", async () => {
    mount();
    pick(image("a.png"));
    await screen.findByRole("list", { name: C.images.listLabel });
    fireEvent.click(screen.getByRole("radio", { name: "Carta" }));
    fireEvent.click(screen.getByRole("radio", { name: "Grande" }));
    fireEvent.click(screen.getByRole("button", { name: C.images.create }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(engine.imagesToPdf.mock.calls[0][1]).toMatchObject({ pageSize: "letter", margin: "large" });
  });

  it("un error del motor se explica en la hoja y se puede reintentar", async () => {
    engine.imagesToPdf.mockRejectedValueOnce(new PdfError("corrupt"));
    mount();
    pick(image("a.png"));
    await screen.findByRole("list", { name: C.images.listLabel });
    fireEvent.click(screen.getByRole("button", { name: C.images.create }));
    expect((await screen.findByRole("alert")).textContent).toContain(es.tool.errors.corrupt);
    expect(created).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: C.images.create }));
    await waitFor(() => expect(created).toHaveLength(1));
  });

  it("tras crear la hoja se cierra", async () => {
    mount();
    pick(image("a.png"));
    await screen.findByRole("list", { name: C.images.listLabel });
    fireEvent.click(screen.getByRole("button", { name: C.images.create }));
    await waitFor(() => expect(created).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("«Cancelar» cierra sin crear nada", async () => {
    mount();
    pick(image("a.png"));
    await screen.findByRole("list", { name: C.images.listLabel });
    fireEvent.click(screen.getByRole("button", { name: C.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(created).toHaveLength(0);
  });

  it("el limite de imagenes se avisa", async () => {
    mount();
    pick(...Array.from({ length: 101 }, (_, i) => image(`i${i}.png`)));
    const list = await screen.findByRole("list", { name: C.images.listLabel });
    expect(within(list).getAllByRole("listitem")).toHaveLength(100);
    expect(screen.getByText(C.images.tooMany(100))).toBeTruthy();
  });
});

describe("nuevo documento en blanco", () => {
  async function createBlank() {
    fireEvent.click(screen.getByRole("button", { name: C.blank.create }));
    await waitFor(() => expect(created).toHaveLength(1));
    return PDFDocument.load(await created[0].arrayBuffer());
  }

  it("al abrirse el foco va a su primer campo (el tamaño elegido), no al panel", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "blanco" }));
    await screen.findByRole("dialog");
    const a4 = screen.getByRole("radio", { name: C.blank.a4 });
    expect(a4.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(a4);
  });

  it("por defecto: A4 vertical de una pagina", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "blanco" }));
    await screen.findByRole("dialog");
    const doc = await createBlank();
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getWidth()).toBeCloseTo(595.28, 1);
    expect(created[0].name).toBe(C.blank.fileName);
  });

  it("Carta, horizontal y 4 paginas", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "blanco" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("radio", { name: C.blank.letter }));
    fireEvent.click(screen.getByRole("radio", { name: C.blank.landscape }));
    fireEvent.change(screen.getByLabelText(C.blank.pagesLabel), { target: { value: "4" } });
    const doc = await createBlank();
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getPage(0).getWidth()).toBe(792);
    expect(doc.getPage(0).getHeight()).toBe(612);
  });

  it("el numero de paginas se acota a 1..200", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "blanco" }));
    await screen.findByRole("dialog");
    const field = screen.getByLabelText(C.blank.pagesLabel) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "9999" } });
    expect(field.value).toBe("200");
    fireEvent.change(field, { target: { value: "0" } });
    expect(field.value).toBe("1");
    expect(screen.getByText(C.blank.pagesHint(200))).toBeTruthy();
  });

  it("«Cancelar» cierra sin crear", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "blanco" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: C.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(created).toHaveLength(0);
  });

  it("cada vez que se abre arranca con los valores por defecto", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "blanco" }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText(C.blank.pagesLabel), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: C.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "blanco" }));
    await screen.findByRole("dialog");
    expect((screen.getByLabelText(C.blank.pagesLabel) as HTMLInputElement).value).toBe("1");
    await act(async () => {});
  });
});
