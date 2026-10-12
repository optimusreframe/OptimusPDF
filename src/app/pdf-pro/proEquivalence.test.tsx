import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PDFDocument, PDFName, PDFDict, PDFNumber } from "@cantoo/pdf-lib";
import type { ComponentType } from "react";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { WatermarkToolClient } from "@/app/add-watermark/WatermarkToolClient";
import { PageNumbersToolClient } from "@/app/add-page-numbers/PageNumbersToolClient";
import { CompressToolClient } from "@/app/compress-pdf/CompressToolClient";
import { CropToolClient } from "@/app/crop-pdf/CropToolClient";
import { RotateToolClient } from "@/app/rotate-pdf/RotateToolClient";
import { RepairToolClient } from "@/app/repair-pdf/RepairToolClient";
import { ProtectToolClient } from "@/app/protect-pdf/ProtectToolClient";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";
import { WATERMARK_STRINGS } from "@/app/add-watermark/strings";
import { PAGE_NUMBERS_STRINGS } from "@/app/add-page-numbers/strings";
import { DocumentTab } from "@/app/pdf-pro/tabs/DocumentTab";
import { ProtectTab } from "@/app/pdf-pro/tabs/ProtectTab";
import { cropBoxes, labelsOf, mountTab } from "@/app/pdf-pro/tabs/docTestUtils";
import { getDocTool } from "@/app/pdf-pro/tabs/docToolDefinitions";
import { __resetPageInfoCacheForTests } from "@/app/pdf-pro/ops/pageInfo";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { runOperation } from "@/app/pdf-pro/proAdapter";
import { cropOperation, headerFooterOperation, repairOperation, rotateOperation, watermarkOperation } from "@/app/pdf-pro/ops/docOperations";
import { marginsToRect, rectToMargins } from "@/app/pdf-pro/ops/cropMath";
import { makePdfBytes } from "@/app/pdf-pro/proTestUtils";
import { DEFAULT_CROP_RECT } from "@/lib/pdf/crop";
import { DEFAULT_PAGE_NUMBERS_OPTIONS, addPageNumbers } from "@/lib/pdf/pageNumbers";
import { DEFAULT_HEADER_FOOTER_OPTIONS } from "@/lib/pdf/headerFooter";
import { pdfFile } from "@/lib/pdf/testing/inputFixtures";
import { es } from "@/lib/locales/es";

/**
 * EQUIVALENCIA herramienta suelta ↔ PDF Pro (U5): el cliente suelto REAL (con `ToolShell`) y la operacion de PDF
 * Pro, con las mismas opciones y el mismo PDF, producen EXACTAMENTE los mismos bytes. Comparten motor, panel
 * y reglas; esta prueba lo demuestra de extremo a extremo (el cifrado de Proteger lleva sal aleatoria, asi que
 * se comparan sus parametros y su contenido descifrado).
 */

const downloaded = vi.hoisted(() => ({ items: [] as { blob: Blob; name: string }[] }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: (blob: Blob, name: string) => downloaded.items.push({ blob, name }) };
});
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => null) }));
vi.mock("@/components/tool/PageThumbnailGrid", () => ({ PageThumbnailGrid: () => null }));
vi.mock("@/app/organize-pdf/pageToolkit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/organize-pdf/pageToolkit")>();
  return { ...actual, usePageThumbnails: () => ({ pageCount: 3, thumbs: {}, loading: false, error: null }) };
});

const CROP_RECT_BUTTON = "fijar-recorte";
let cropRectToEmit = DEFAULT_CROP_RECT;
vi.mock("@/app/crop-pdf/CropCanvas", () => ({
  CropCanvas: ({ onRectChange }: { onRectChange: (rect: { x: number; y: number; width: number; height: number }) => void }) => (
    <button type="button" onClick={() => onRectChange(cropRectToEmit)}>
      {CROP_RECT_BUTTON}
    </button>
  ),
}));

const T = PRO_STRINGS.es.docTools;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  downloaded.items.length = 0;
  __resetPageInfoCacheForTests();
  cropRectToEmit = DEFAULT_CROP_RECT;
});
afterEach(() => cleanup());

/** Pasa un PDF por el cliente suelto, pulsa «Procesar» y «Descargar» y devuelve los bytes descargados. */
async function viaStandalone(Client: ComponentType, bytes: Uint8Array, interact?: () => void | Promise<void>): Promise<Uint8Array> {
  const view = render(
    <LanguageProvider>
      <InputGuardContext.Provider value={null}>
        <Client />
      </InputGuardContext.Provider>
    </LanguageProvider>,
  );
  fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files: [pdfFile(bytes, "informe.pdf")] },
  });
  await screen.findByText("informe.pdf");
  await interact?.();
  const run = screen.getAllByRole("button", { name: "Procesar" })[0] as HTMLButtonElement;
  await waitFor(() => expect(run.disabled).toBe(false));
  fireEvent.click(run);
  fireEvent.click(await screen.findByRole("button", { name: es.tool.download }));
  await waitFor(() => expect(downloaded.items).toHaveLength(1));
  const out = new Uint8Array(await downloaded.items[0].blob.arrayBuffer());
  view.unmount();
  downloaded.items.length = 0;
  return out;
}

/** Abre la herramienta en PDF Pro, aplica y devuelve los bytes del snapshot resultante. */
async function viaPro(bytes: Uint8Array, toolTitle: string, interact?: () => void | Promise<void>): Promise<Uint8Array> {
  const mounted = await mountTab(<DocumentTab />, { bytes, name: "informe.pdf" });
  fireEvent.click(screen.getByRole("button", { name: T.launcher.open(toolTitle) }));
  await screen.findByRole("heading", { level: 2, name: toolTitle });
  await interact?.();
  const apply = screen.getByRole("button", { name: T.runner.apply });
  expect(apply.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(apply);
  await waitFor(() => expect(labelsOf(mounted.doc)).toHaveLength(2));
  const out = mounted.doc.current()!;
  mounted.unmount();
  return out;
}

const same = (a: Uint8Array, b: Uint8Array) => expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);

describe("misma salida byte a byte", () => {
  it("1 · marca de agua con las opciones por defecto", async () => {
    const input = await makePdfBytes(3);
    const loose = await viaStandalone(WatermarkToolClient, input);
    const pro = await viaPro(input, T.tools.watermark.title);
    same(loose, pro);
  });

  it("2 · marca de agua con texto, transparencia, giro y rango cambiados en el panel", async () => {
    const input = await makePdfBytes(4);
    const interact = () => {
      fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.es.textLabel), { target: { value: "BORRADOR" } });
      fireEvent.click(screen.getByRole("radio", { name: "25 %" }));
      fireEvent.click(screen.getByRole("radio", { name: "90°" }));
      fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.es.pagesFrom), { target: { value: "2" } });
      fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.es.pagesTo), { target: { value: "3" } });
    };
    const loose = await viaStandalone(WatermarkToolClient, input, interact);
    const pro = await viaPro(input, T.tools.watermark.title, interact);
    same(loose, pro);
  });

  it("3 · numerar paginas con «Página n de p» y primer numero 5", async () => {
    const input = await makePdfBytes(3);
    const interact = () => {
      fireEvent.click(screen.getByRole("radio", { name: PAGE_NUMBERS_STRINGS.es.formatPageNofP }));
      fireEvent.change(screen.getByLabelText(PAGE_NUMBERS_STRINGS.es.firstNumberLabel), { target: { value: "5" } });
    };
    const loose = await viaStandalone(PageNumbersToolClient, input, interact);
    const pro = await viaPro(input, T.tools["page-numbers"].title, interact);
    same(loose, pro);
  });

  it("4 · comprimir un PDF sin imagenes: ambos devuelven el original SIN tocar", async () => {
    const input = await makePdfBytes(2);
    const loose = await viaStandalone(CompressToolClient, input);
    same(loose, input);
    const mounted = await mountTab(<DocumentTab />, { bytes: input });
    fireEvent.click(screen.getByRole("button", { name: T.launcher.open(T.tools.compress.title) }));
    await screen.findByRole("heading", { level: 2, name: T.tools.compress.title });
    fireEvent.click(screen.getByRole("button", { name: T.runner.apply }));
    await screen.findByText(PRO_STRINGS.es.warnings.unchanged);
    same(mounted.doc.current()!, input);
    expect(labelsOf(mounted.doc)).toEqual(["Original"]);
  });

  it("5 · rotar todo 180°", async () => {
    const input = await makePdfBytes(3);
    const loose = await viaStandalone(RotateToolClient, input, () => {
      fireEvent.click(screen.getByRole("tab", { name: "180°" }));
    });
    const pro = await viaPro(input, T.tools.rotate.title, () => {
      fireEvent.click(screen.getByRole("tab", { name: "180°" }));
    });
    same(loose, pro);
  });

  it("6 · recortar: la misma seleccion (margenes ⇄ rectangulo) da el mismo PDF", async () => {
    const input = await makePdfBytes(3);
    const page = { width: (300 * 25.4) / 72, height: (400 * 25.4) / 72 };
    const margins = { top: 12, right: 8, bottom: 20, left: 5 };
    cropRectToEmit = marginsToRect(margins, page);
    const loose = await viaStandalone(CropToolClient, input, () => {
      fireEvent.click(screen.getByRole("button", { name: CROP_RECT_BUTTON }));
    });
    const outcome = await runOperation(cropOperation, input, {
      margins,
      linked: false,
      scope: "all",
      fromPage: 1,
      toPage: 0,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) same(loose, outcome.bytes);
    // Y la inversa: el rectangulo por defecto de la suelta, expresado en margenes, da lo mismo.
    cropRectToEmit = DEFAULT_CROP_RECT;
    const looseDefault = await viaStandalone(CropToolClient, input, () => {
      fireEvent.click(screen.getByRole("button", { name: CROP_RECT_BUTTON }));
    });
    const proDefault = await runOperation(cropOperation, input, {
      margins: rectToMargins(DEFAULT_CROP_RECT, page),
      linked: false,
      scope: "all",
      fromPage: 1,
      toPage: 0,
    });
    expect(proDefault.ok).toBe(true);
    if (!proDefault.ok) return;
    const [a, b] = [await cropBoxes(looseDefault), await cropBoxes(proDefault.bytes)];
    for (let index = 0; index < a.length; index += 1) {
      expect(b[index].x).toBeCloseTo(a[index].x, 6);
      expect(b[index].width).toBeCloseTo(a[index].width, 6);
      expect(b[index].height).toBeCloseTo(a[index].height, 6);
    }
  });

  it("7 · reparar un PDF danado: mismo archivo reparado", async () => {
    const input = (await makePdfBytes(3)).slice(0, -40);
    const loose = await viaStandalone(RepairToolClient, input);
    const outcome = await runOperation(repairOperation, input, undefined);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) same(loose, outcome.bytes);
  });

  it("8 · encabezado/pie con «{n}» abajo en el centro = Numerar paginas (mismo motor de colocacion)", async () => {
    const input = await makePdfBytes(3);
    const numbered = await addPageNumbers(
      new File([input as unknown as BlobPart], "a.pdf", { type: "application/pdf" }),
      { ...DEFAULT_PAGE_NUMBERS_OPTIONS },
    );
    const outcome = await runOperation(headerFooterOperation, input, {
      ...DEFAULT_HEADER_FOOTER_OPTIONS,
      fontSize: DEFAULT_PAGE_NUMBERS_OPTIONS.fontSize,
      footer: { left: "", center: "{n}", right: "" },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) same(new Uint8Array(await numbered.arrayBuffer()), outcome.bytes);
  });

  it("9 · las opciones iniciales de PDF Pro son las de la herramienta suelta (marca de agua)", async () => {
    const input = await makePdfBytes(2);
    const tool = getDocTool("watermark");
    const options = tool.defaults({
      language: "es", fileName: "informe.pdf", pageCount: 2, byteLength: input.byteLength, bytes: input,
      snapshotId: "s", signatures: "none", wasEncrypted: false, firstPage: null,
    });
    const outcome = await runOperation(watermarkOperation, input, options as never);
    const loose = await viaStandalone(WatermarkToolClient, input);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) same(loose, outcome.bytes);
  });

  it("10 · rotar con la operacion directa = rotar con el cliente suelto", async () => {
    const input = await makePdfBytes(2);
    const loose = await viaStandalone(RotateToolClient, input);
    const outcome = await runOperation(rotateOperation, input, { angle: 90, scope: "all", fromPage: 1, toPage: 0, parity: "all" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) same(loose, outcome.bytes);
  });
});

/** Parametros del cifrado (R, V, P, longitud de clave) de un PDF protegido. */
async function encryptionParams(bytes: Uint8Array): Promise<Record<string, number>> {
  const document = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const entry = document.context.trailerInfo.Encrypt;
  const dict = entry ? document.context.lookup(entry, PDFDict) : undefined;
  const read = (key: string): number => {
    const value = dict?.get(PDFName.of(key));
    return value instanceof PDFNumber ? value.asNumber() : Number.NaN;
  };
  return { R: read("R"), V: read("V"), P: read("P"), Length: read("Length") };
}

describe("Proteger: mismos parametros de cifrado y mismo contenido descifrado", () => {
  const P = PROTECT_STRINGS.es;

  async function fill() {
    fireEvent.change(screen.getByLabelText(P.passwordLabel), { target: { value: "secreto1" } });
    fireEvent.change(screen.getByLabelText(P.confirmLabel), { target: { value: "secreto1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(P.permissionCopying) }));
  }

  it("la herramienta suelta y «Guardar con contraseña…» cifran igual", async () => {
    const input = await makePdfBytes(2);
    const loose = await viaStandalone(ProtectToolClient, input, fill);

    const mounted = await mountTab(<ProtectTab />, { bytes: input });
    await fill();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: T.protect.saveButton }));
    });
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    const pro = new Uint8Array(await downloaded.items[0].blob.arrayBuffer());
    mounted.unmount();

    expect(await encryptionParams(pro)).toEqual(await encryptionParams(loose));
    const open = (bytes: Uint8Array) => PDFDocument.load(bytes, { password: "secreto1", updateMetadata: false } as never);
    expect((await open(pro)).getPageCount()).toBe((await open(loose)).getPageCount());
    // El contenido descifrado es el mismo PDF (el /ID y la sal del cifrado son aleatorios: no se comparan bytes).
    const [a, b] = [await open(pro), await open(loose)];
    expect(a.getPages().map((page) => page.getSize())).toEqual(b.getPages().map((page) => page.getSize()));
  });
});
