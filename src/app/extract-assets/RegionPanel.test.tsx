import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { es } from "@/lib/locales/es";
import { InkError } from "@/lib/image/inkCore";
import { makePng } from "@/lib/backup/__fixtures__/pngFactory";
import { RegionPanel } from "@/app/extract-assets/RegionPanel";
import { mount, setLanguage } from "@/app/extract-assets/testUtils";

/**
 * Panel «Recortar región» en jsdom: pdf.js y el recorte se sustituyen por dobles (el recorte real y el visor real se
 * prueban en `region.test.ts` y en `extract-ui-region.spec.ts`). Aqui: paginas, pagina escaneada, parametros del recorte,
 * vista previa que se descarta al cambiar algo, errores, descarga con nombre y el paso a «Guardar».
 */

const downloads: { name: string; blob: Blob }[] = [];
const crop = vi.hoisted(() => vi.fn());

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const page = { getViewport: () => ({ width: 612, height: 792 }), cleanup: () => {} };
  return {
    ...actual,
    openPdfDocument: vi.fn(async () => ({ numPages: 12, getPage: async () => page })),
    closePdfDocument: vi.fn(async () => {}),
    renderPageToCanvas: vi.fn(async () => document.createElement("canvas")),
    downloadBlob: (blob: Blob, name: string) => downloads.push({ name, blob }),
  };
});
vi.mock("@/lib/pdf/extractAssets", () => ({ cropRegion: crop }));

const x = es.extract;
const file = new File([new Uint8Array([37, 80, 68, 70])], "Contrato.pdf", { type: "application/pdf" });

beforeEach(() => {
  setLanguage("es");
  downloads.length = 0;
  crop.mockReset().mockImplementation(async () => ({ png: new Blob([makePng({ width: 80, height: 30, seed: 5 }) as unknown as BlobPart], { type: "image/png" }), width: 800, height: 300 }));
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
});

function Host({ initialPage = 0, scanned = [] as number[], onStatus = vi.fn(), onSaved = vi.fn() }) {
  const [page, setPage] = useState(initialPage);
  return <RegionPanel file={file} page={page} onPageChange={setPage} scannedPages={scanned} strings={x} closeLabel="Cerrar" onStatus={onStatus} onSaved={onSaved} />;
}

async function open(props: Parameters<typeof Host>[0] = {}) {
  const view = mount(<Host {...props} />);
  await waitFor(() => expect(screen.getByRole("img", { name: /^Página \d+ de 12 del PDF$/ })).toBeTruthy());
  return view;
}

const cropButton = () => screen.getByRole("button", { name: x.regionCrop }) as HTMLButtonElement;
const pageInput = () => document.querySelector("[data-region-page]") as HTMLInputElement;
const rect = () => document.querySelector("[data-region-rect]") as HTMLElement;

describe("visor", () => {
  it("abre el documento, dice la pagina y el total y empieza en la pagina pedida", async () => {
    await open({ initialPage: 4 });
    expect(screen.getByRole("img", { name: "Página 5 de 12 del PDF" })).toBeTruthy();
    expect(pageInput().value).toBe("5");
    expect(screen.getByText("de 12")).toBeTruthy();
  });

  it("anterior / siguiente / numero: avanzan, no pasan de los limites y el campo se corrige al salir", async () => {
    await open();
    expect((screen.getByRole("button", { name: x.regionPrev }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: x.regionNext }));
    expect(pageInput().value).toBe("2");
    fireEvent.change(pageInput(), { target: { value: "12" } });
    expect(screen.getByRole("img", { name: "Página 12 de 12 del PDF" })).toBeTruthy();
    expect((screen.getByRole("button", { name: x.regionNext }) as HTMLButtonElement).disabled).toBe(true);
    // Un valor fuera de rango no cambia de pagina y, al salir del campo, vuelve a la pagina real.
    fireEvent.change(pageInput(), { target: { value: "99" } });
    expect(screen.getByRole("img", { name: "Página 12 de 12 del PDF" })).toBeTruthy();
    fireEvent.blur(pageInput());
    expect(pageInput().value).toBe("12");
  });

  it("una pagina escaneada lleva su aviso; las demas no", async () => {
    await open({ initialPage: 3, scanned: [3] });
    expect(document.querySelector("[data-region-scanned]")!.textContent).toBe(x.regionScanned);
    fireEvent.click(screen.getByRole("button", { name: x.regionNext }));
    expect(document.querySelector("[data-region-scanned]")).toBeNull();
  });
});

describe("recorte", () => {
  it("pide al motor la pagina (0-based), la region (la del rectangulo), 300 ppp y limpiar el fondo; muestra la vista previa y lo anuncia", async () => {
    const onStatus = vi.fn();
    await open({ initialPage: 2, onStatus });
    fireEvent.click(cropButton());
    await waitFor(() => expect(document.querySelector("[data-region-preview]")).not.toBeNull());
    expect(crop).toHaveBeenCalledTimes(1);
    const [passed, page, region, options] = crop.mock.calls[0];
    expect(passed).toBe(file);
    expect(page).toBe(2);
    expect(region).toEqual({ x: 0.12, y: 0.66, width: 0.4, height: 0.12 });
    expect(options).toMatchObject({ dpi: 300, cleanBackground: true });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(onStatus).toHaveBeenCalledWith("Recorte listo: 800 × 300 px.");
    expect(screen.getByText("800 × 300 px")).toBeTruthy();
  });

  it("calidad alta (600 ppp) y sin limpiar se pasan al motor", async () => {
    await open();
    fireEvent.click(screen.getByRole("radio", { name: x.regionQualityHigh }));
    fireEvent.click(screen.getByRole("checkbox", { name: x.regionClean }));
    fireEvent.click(cropButton());
    await waitFor(() => expect(crop).toHaveBeenCalled());
    expect(crop.mock.calls[0][3]).toMatchObject({ dpi: 600, cleanBackground: false });
  });

  it("la vista previa se DESCARTA al mover el rectangulo, cambiar de pagina o de ajustes (ya no es de lo que se ve)", async () => {
    await open();
    fireEvent.click(cropButton());
    await waitFor(() => expect(document.querySelector("[data-region-result]")).not.toBeNull());
    fireEvent.keyDown(rect(), { key: "ArrowRight" });
    expect(document.querySelector("[data-region-result]")).toBeNull();
    fireEvent.click(cropButton());
    await waitFor(() => expect(document.querySelector("[data-region-result]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: x.regionNext }));
    expect(document.querySelector("[data-region-result]")).toBeNull();
    fireEvent.click(cropButton());
    await waitFor(() => expect(document.querySelector("[data-region-result]")).not.toBeNull());
    fireEvent.click(screen.getByRole("radio", { name: x.regionQualityHigh }));
    expect(document.querySelector("[data-region-result]")).toBeNull();
  });

  it("mientras recorta, el boton lo dice y esta desactivado (un solo recorte a la vez)", async () => {
    let finish: () => void = () => {};
    crop.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ png: new Blob([makePng() as unknown as BlobPart]), width: 40, height: 20 }); }));
    await open();
    fireEvent.click(cropButton());
    const busy = screen.getByRole("button", { name: x.regionCropping }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    finish();
    await waitFor(() => expect(cropButton().disabled).toBe(false));
  });

  it("errores del motor de tinta: sin tinta, demasiado oscura y cualquier otro", async () => {
    const onStatus = vi.fn();
    await open({ onStatus });
    crop.mockRejectedValueOnce(new InkError("no-ink"));
    fireEvent.click(cropButton());
    expect(await screen.findByText(x.regionNoInk)).toBeTruthy();
    expect(onStatus).toHaveBeenLastCalledWith(x.regionNoInk, true);
    crop.mockRejectedValueOnce(new InkError("too-dark"));
    fireEvent.click(cropButton());
    expect(await screen.findByText(x.regionTooDark)).toBeTruthy();
    crop.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(cropButton());
    expect(await screen.findByText(x.regionFailed)).toBeTruthy();
    expect(document.querySelector("[data-region-result]")).toBeNull();
  });

  it("una cancelacion no es un error: no se muestra nada", async () => {
    await open();
    crop.mockRejectedValueOnce(new InkError("aborted"));
    fireEvent.click(cropButton());
    await waitFor(() => expect(cropButton().disabled).toBe(false));
    expect(screen.queryByText(x.regionFailed)).toBeNull();
  });

  it("descargar: p01-region-01.png, y la segunda en la misma pagina, 02; otra pagina empieza en 01", async () => {
    await open();
    fireEvent.click(cropButton());
    await waitFor(() => expect(document.querySelector("[data-region-download]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-region-download]")!);
    fireEvent.click(document.querySelector("[data-region-download]")!);
    fireEvent.click(screen.getByRole("button", { name: x.regionNext }));
    fireEvent.click(cropButton());
    await waitFor(() => expect(document.querySelector("[data-region-download]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-region-download]")!);
    expect(downloads.map((entry) => entry.name)).toEqual(["p01-region-01.png", "p01-region-02.png", "p02-region-01.png"]);
  });
});

describe("guardar el recorte", () => {
  it("abre la hoja con la imagen ya limpia (sin color de tinta), guarda con el nombre del PDF y «Recortar otra» devuelve el foco al rectangulo", async () => {
    const onSaved = vi.fn();
    await open({ onSaved });
    fireEvent.click(cropButton());
    await waitFor(() => expect(document.querySelector("[data-region-save]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-region-save]")!);
    const dialog = await screen.findByRole("dialog", { name: x.saveTitle });
    expect(within(dialog).queryByRole("radio", { name: "Negro" })).toBeNull();
    await waitFor(() => expect((document.querySelector("[data-extract-save-submit]") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(document.querySelector("[data-extract-save-name]")!, { target: { value: "Ana Pérez" } });
    fireEvent.click(document.querySelector("[data-extract-save-submit]")!);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("Guardada en Firmas guardadas: Ana Pérez."));
    fireEvent.click(await within(dialog).findByRole("button", { name: x.saveCropAnother }));
    await waitFor(() => expect(document.querySelector("[data-region-result]")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rect()));
  });
});
