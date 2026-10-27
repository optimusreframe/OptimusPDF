import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { es } from "@/lib/locales/es";
import { setExtractEngine } from "@/lib/pdf/extractAssets";
import type { ExtractAssetsApi, ExtractResult, ExtractedAsset } from "@/lib/pdf/extractAssets/types";
import { ExtractToolClient } from "@/app/extract-assets/ExtractToolClient";
import { makeAsset, mount, setLanguage } from "@/app/extract-assets/testUtils";

/** Pantalla de «Extraer elementos» tras la verificacion independiente: H4, H9, H10, H15 y H16 (jsdom, motor minimo sin pixeles). */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: () => {} };
});
vi.mock("@/lib/image/inkExtract", async (importOriginal) => (await import("@/app/extract-assets/testUtils")).withFakeInk(await importOriginal()));
vi.mock("@/app/extract-assets/RegionPanel", () => ({ RegionPanel: () => <div data-testid="region-panel" /> }));

const x = es.extract;

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});
beforeEach(() => setLanguage("es"));
afterEach(() => setExtractEngine(null));

const twoSignaturesSamePage: ExtractedAsset[] = [
  makeAsset({ id: "sig-left", kind: "signature", confidence: 0.85, occurrences: [{ pageIndex: 3, rect: { x: 0.1, y: 0.5, width: 0.3, height: 0.07 } }] }),
  makeAsset({ id: "sig-right", kind: "signature", confidence: 0.85, occurrences: [{ pageIndex: 3, rect: { x: 0.55, y: 0.5, width: 0.3, height: 0.07 } }] }),
  makeAsset({ id: "ini", kind: "initials", confidence: 0.85, pixel: { width: 160, height: 90, hasAlpha: true }, occurrences: [{ pageIndex: 3, rect: { x: 0.8, y: 0.9, width: 0.1, height: 0.05 } }] }),
];
const emptyField = makeAsset({ id: "field", kind: "signature", confidence: 0.1, source: "sig-widget", pixel: null, formats: [], bytesEstimate: 0, occurrences: [{ pageIndex: 3, rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.07 } }] });

function engineFor(assets: ExtractedAsset[], extra: Partial<ExtractResult> = {}): ExtractAssetsApi {
  return {
    extractAssets: vi.fn(async () => ({ pageCount: 6, assets, scannedPages: [], warnings: [], truncated: false, ...extra })),
    renderAsset: vi.fn(async (_file, asset, format = "png") => new Blob([`${asset.id}:${format}`])),
    cropRegion: vi.fn(async () => ({ png: new Blob(["png"]), width: 1, height: 1 })),
  };
}

async function run(api: ExtractAssetsApi) {
  setExtractEngine(api);
  const view = mount(<ExtractToolClient />);
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File([new Uint8Array([37, 80, 68, 70])], "contrato.pdf", { type: "application/pdf" })] } });
  fireEvent.click(await screen.findByRole("button", { name: x.run }));
  await screen.findByRole("list", { name: x.listLabel });
  return view;
}

describe("H9 · dos firmas de la misma pagina se distinguen", () => {
  it("la lista, la casilla y los botones llevan «1 de 2» / «2 de 2»; lo demas no", async () => {
    await run(engineFor(twoSignaturesSamePage));
    const list = screen.getByRole("list", { name: x.listLabel });
    expect(within(list).getByRole("listitem", { name: "Firma probable 1 de 2, página 4, 420 × 140 px" })).toBeTruthy();
    expect(within(list).getByRole("listitem", { name: "Firma probable 2 de 2, página 4, 420 × 140 px" })).toBeTruthy();
    expect(within(list).getByRole("listitem", { name: "Iniciales probables, página 4, 160 × 90 px" })).toBeTruthy();
    expect(within(list).getByRole("checkbox", { name: "Firma probable 2 de 2, página 4, 420 × 140 px" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descargar: Firma probable 1 de 2, página 4, 420 × 140 px" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ver detalles: Firma probable 2 de 2, página 4, 420 × 140 px" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Guardar en Firmas guardadas: Firma probable 1 de 2, página 4, 420 × 140 px" })).toBeTruthy();
    // Tambien se ve (no solo lo oye un lector de pantalla).
    expect(within(list).getAllByText(/^[12] de 2$/)).toHaveLength(2);
  });
});

describe("H4 · un campo de firma vacio no se ofrece", () => {
  it("no hay tarjeta ni «Descargar» ni «Guardar» para el, no cuenta en la lista, en las pestanas ni en el resumen, y se avisa en una linea", async () => {
    await run(engineFor([...twoSignaturesSamePage, emptyField]));
    expect(document.querySelector('[data-asset-id="field"]')).toBeNull();
    expect(within(screen.getByRole("list", { name: x.listLabel })).getAllByRole("listitem")).toHaveLength(3);
    expect(document.querySelector("[data-extract-heading]")!.textContent).toBe("Encontramos 3 elementos en 6 páginas.");
    expect(screen.getByRole("tab", { name: "Elementos (3)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Firmas\s*2$/ })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Descargar: / })).toHaveLength(3);
    const notice = document.querySelector('[data-notice="empty-sig-field"]') as HTMLElement;
    expect(notice.textContent).toContain("Hay 1 campo de firma sin firma dentro");
  });
  it("si solo hay campos vacios es como no encontrar nada, con su aviso", async () => {
    setExtractEngine(engineFor([emptyField]));
    const view = mount(<ExtractToolClient />);
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File([new Uint8Array([37, 80, 68, 70])], "contrato.pdf", { type: "application/pdf" })] } });
    fireEvent.click(await screen.findByRole("button", { name: x.run }));
    await waitFor(() => expect(document.querySelector("[data-extract-empty]")).not.toBeNull());
    expect(document.querySelector("[data-extract-heading]")!.textContent).toBe(x.foundNone);
    expect(document.querySelector('[data-notice="empty-sig-field"]')).not.toBeNull();
  });
});

describe("H10 · recortar anotaciones sin avisar", () => {
  it("el aviso `too-many-annotations` se ve en la interfaz con la pagina y el numero", async () => {
    await run(engineFor(twoSignaturesSamePage, { warnings: [{ code: "too-many-annotations", pageIndex: 0, detail: "10000" }], truncated: true }));
    const notice = document.querySelector('[data-notice="too-many-annotations"]') as HTMLElement;
    expect(notice.textContent).toBe("La página 1 tiene 10000 anotaciones: solo se revisaron las primeras 300. Puede haber más elementos.");
  });
});

describe("H15 · galeria en escritorio y H16 · primera tarjeta en el movil", () => {
  it("la cuadricula pasa de 1 columna (movil) a 2, 3, 4 (desde 1024 px, el iPad apaisado) y 5 columnas", async () => {
    await run(engineFor(twoSignaturesSamePage));
    const grid = document.querySelector("[data-extract-grid]") as HTMLElement;
    for (const token of ["grid-cols-1", "min-[520px]:grid-cols-2", "md:grid-cols-3", "lg:grid-cols-4", "2xl:grid-cols-5"]) expect(grid.className, token).toContain(token);
  });
  it("los filtros van en UNA fila desplazable en el movil (y se apilan en escritorio) y los chips no se encogen", async () => {
    await run(engineFor(twoSignaturesSamePage));
    const row = document.querySelector("[data-filter-row]") as HTMLElement;
    expect(row.className).toContain("overflow-x-auto");
    expect(row.className).toContain("md:flex-wrap");
    for (const chip of row.querySelectorAll("button")) expect(chip.className).toContain("shrink-0");
  });
  it("con el resultado a la vista el movil oculta la descripcion de la herramienta (queda titulo y nota) y compacta el resumen", async () => {
    setExtractEngine(engineFor(twoSignaturesSamePage));
    const view = mount(<ExtractToolClient />);
    const description = () => document.querySelector("header p") as HTMLElement;
    expect(description().className).not.toContain("hidden");
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File([new Uint8Array([37, 80, 68, 70])], "contrato.pdf", { type: "application/pdf" })] } });
    fireEvent.click(await screen.findByRole("button", { name: x.run }));
    await screen.findByRole("list", { name: x.listLabel });
    expect(description().className).toContain("hidden");
    expect(description().className).toContain("md:block");
    const summary = document.querySelector("[data-extract-summary]") as HTMLElement;
    expect(summary.className).toContain("p-3");
    expect(summary.className).toContain("md:p-5");
    expect(document.querySelector("[data-extract-note]")).not.toBeNull();
  });
  it("la barra de formato explica que «PNG» entrega la firma limpia y «Original» la imagen tal cual", async () => {
    await run(engineFor(twoSignaturesSamePage));
    expect(document.querySelector("[data-format-hint]")!.textContent).toBe(x.formatCleanHint);
    fireEvent.click(screen.getByRole("button", { name: "Original" }));
    expect(document.querySelector("[data-format-hint]")!.textContent).toBe(x.formatOriginalHint);
  });
});
