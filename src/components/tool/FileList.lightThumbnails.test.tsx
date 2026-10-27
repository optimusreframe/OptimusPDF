import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { LanguageProvider } from "@/lib/i18n";
import { FileList } from "@/components/tool/FileList";

/** `lightThumbnails` (H11): con fotos enormes la miniatura del selector no abre el PDF con pdf.js (lo decodificaria entero). */

const opened = vi.hoisted(() => vi.fn());
const prepared = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: opened,
    closePdfDocument: vi.fn(async () => {}),
    renderPageToDataUrl: vi.fn(async () => "data:image/png;base64,AAAA"),
  };
});
vi.mock("@/lib/pdf/extractAssets/imagesPrep", () => ({ prepareImagesFor: prepared, MAX_IMAGE_PIXELS: 50_000_000 }));

const pdf = () => new File([new Uint8Array([37, 80, 68, 70, 45])], "fotos.pdf", { type: "application/pdf" });
const view = (props: { lightThumbnails?: boolean }) =>
  render(
    <LanguageProvider>
      <FileList files={[pdf()]} onChange={() => {}} {...props} />
    </LanguageProvider>,
  );

beforeEach(() => {
  opened.mockReset().mockResolvedValue({ getPage: async () => ({ cleanup: () => {} }) });
  prepared.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("FileList · lightThumbnails", () => {
  it("con fotos enormes: no se abre el PDF y queda el icono generico", async () => {
    prepared.mockResolvedValue({ big: new Map([["1R", {}]]) });
    view({ lightThumbnails: true });
    await waitFor(() => expect(prepared).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).not.toHaveBeenCalled();
    expect(document.querySelector("img")).toBeNull();
  });
  it("sin fotos enormes: miniatura de siempre", async () => {
    prepared.mockResolvedValue({ big: new Map() });
    view({ lightThumbnails: true });
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    expect(opened).toHaveBeenCalledTimes(1);
  });
  it("sin la opcion (el resto de herramientas): ni se prepara ni cambia nada", async () => {
    view({});
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    expect(prepared).not.toHaveBeenCalled();
    expect(screen.getByText("fotos.pdf")).toBeTruthy();
  });
  it("si la preparacion falla, la miniatura no se pinta pero la lista sigue (icono generico)", async () => {
    prepared.mockRejectedValue(new Error("boom"));
    view({ lightThumbnails: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("fotos.pdf")).toBeTruthy();
  });
});
