import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import JSZip from "jszip";
import { es } from "@/lib/locales/es";
import { PdfError } from "@/lib/pdf/core";
import { setExtractEngine, unavailableEngine } from "@/lib/pdf/extractAssets";
import type { ExtractAssetsApi, ExtractResult } from "@/lib/pdf/extractAssets/types";
import { ExtractToolClient } from "@/app/extract-assets/ExtractToolClient";
import { mount, sampleAssets, setLanguage } from "@/app/extract-assets/testUtils";

/**
 * Pantalla de «Extraer elementos» en jsdom con un motor de pruebas MINIMO (sin pixeles): estados, filtros, seleccion,
 * descargas y ZIP, avisos, errores, cancelacion y estado vacio. El camino con pixeles (miniaturas, limpieza, recorte con
 * pdf.js) lo cubren las pruebas del motor y los E2E de navegador.
 */

const downloads: { name: string; blob: Blob }[] = [];
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: (blob: Blob, name: string) => downloads.push({ name, blob }) };
});
// El panel de recorte abre pdf.js (no corre en jsdom): se sustituye por un marcador (sus E2E usan el real).
vi.mock("@/app/extract-assets/RegionPanel", () => ({
  RegionPanel: ({ page, scannedPages }: { page: number; scannedPages: number[] }) => (
    <div data-testid="region-panel" data-page={page} data-scanned={scannedPages.join(",")} />
  ),
}));

const x = es.extract;

function result(overrides: Partial<ExtractResult> = {}): ExtractResult {
  return { pageCount: 6, assets: sampleAssets(), scannedPages: [4], warnings: [{ code: "scanned-page", pageIndex: 4 }], truncated: false, ...overrides };
}

function engine(overrides: Partial<ExtractAssetsApi> = {}): ExtractAssetsApi {
  return {
    extractAssets: vi.fn(async () => result()),
    renderAsset: vi.fn(async (_file, asset, format = "png") => new Blob([`${asset.id}:${format}`], { type: format === "txt" ? "text/plain" : "image/png" })),
    cropRegion: vi.fn(async () => ({ png: new Blob(["png"]), width: 1, height: 1 })),
    ...overrides,
  };
}

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  // jsdom no calcula cajas: el foco solo se da a elementos pintados.
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});
beforeEach(() => {
  setLanguage("es");
  downloads.length = 0;
});
afterEach(() => setExtractEngine(null));

const pdf = (name = "contrato.pdf") => new File([new Uint8Array([37, 80, 68, 70, 45, 49])], name, { type: "application/pdf" });

async function loadAndRun(api: ExtractAssetsApi = engine(), name = "contrato.pdf") {
  setExtractEngine(api);
  const view = mount(<ExtractToolClient />);
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [pdf(name)] } });
  fireEvent.click(await screen.findByRole("button", { name: x.run }));
  return { ...view, api };
}

const heading = () => document.querySelector("[data-extract-heading]") as HTMLElement;
const status = () => document.querySelector("[data-extract-status]") as HTMLElement;
const list = () => screen.getByRole("list", { name: x.listLabel });

describe("antes de buscar", () => {
  it("cabecera, nota de una linea SIN casilla ni marca, y «Buscar elementos» desactivado con su motivo", () => {
    setExtractEngine(engine());
    mount(<ExtractToolClient />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Extraer elementos");
    const note = document.querySelector("[data-extract-note]") as HTMLElement;
    expect(note.textContent).toBe("Úsalo solo con firmas propias o con autorización de su titular.");
    expect(note.querySelector("input, button, a")).toBeNull();
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    const run = screen.getByRole("button", { name: x.run }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(document.getElementById(run.getAttribute("aria-describedby") ?? "")!.textContent).toBe(x.runNeedFile);
  });

  it("con un PDF elegido: «Abrir en PDF Pro» (enlace) y el boton se activa", async () => {
    setExtractEngine(engine());
    const view = mount(<ExtractToolClient />);
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [pdf()] } });
    expect(await screen.findByText("contrato.pdf")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Abrir en PDF Pro" }).getAttribute("href")).toBe("/pdf-pro");
    expect((screen.getByRole("button", { name: x.run }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("existe UNA sola region viva", () => {
    setExtractEngine(engine());
    mount(<ExtractToolClient />);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
});

describe("resultado", () => {
  it("recuento en el titulo (con el foco), lista con nombres accesibles y la nota de pagina escaneada", async () => {
    await loadAndRun();
    await waitFor(() => expect(heading().textContent).toBe("Encontramos 6 elementos en 6 páginas."));
    expect(document.activeElement).toBe(heading());
    expect(within(list()).getAllByRole("listitem")).toHaveLength(6);
    expect(within(list()).getByRole("listitem", { name: "Firma, página 3, 420 × 140 px" })).toBeTruthy();
    expect(within(list()).getByRole("listitem", { name: "Firma probable, página 4, 520 × 180 px" })).toBeTruthy();
    expect(within(list()).getByRole("listitem", { name: "Marca de agua probable, página 1, solo texto" })).toBeTruthy();
    expect(document.querySelector('[data-notice="scanned-page"]')!.textContent).toContain("La página 5 es un escaneo");
  });

  it("el motor recibe el PDF, los topes (300 paginas, 500 elementos) y la senal de cancelacion", async () => {
    const { api } = await loadAndRun();
    await screen.findByRole("list", { name: x.listLabel });
    const call = vi.mocked(api.extractAssets).mock.calls[0];
    expect((call[0] as File).name).toBe("contrato.pdf");
    expect(call[1]).toMatchObject({ maxPages: 300, maxAssets: 500, pageRange: undefined });
    expect(call[1]!.signal).toBeInstanceOf(AbortSignal);
    expect(typeof call[1]!.onProgress).toBe("function");
  });

  it("filtrar cambia la lista y se anuncia en la region viva", async () => {
    await loadAndRun();
    await screen.findByRole("list", { name: x.listLabel });
    fireEvent.click(screen.getByRole("button", { name: /^Firmas/ }));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
    expect(status().textContent).toBe("Mostrando 2 de 6");
    fireEvent.click(screen.getByRole("button", { name: /^Todos/ }));
    expect(status().textContent).toBe("Mostrando 6 de 6");
  });

  it("seleccionar todo / quitar, y la seleccion sobrevive al cambio de filtro", async () => {
    await loadAndRun();
    await screen.findByRole("list", { name: x.listLabel });
    fireEvent.click(screen.getByRole("button", { name: /^Firmas/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: x.selectAll }));
    expect(screen.getAllByText("2 seleccionados").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Todos/ }));
    expect(within(list()).getAllByRole("checkbox", { checked: true })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Quitar selección" }));
    expect(screen.getByText("Ninguno seleccionado")).toBeTruthy();
  });

  it("descarga individual: nombre p03-firma-01.png y bytes del motor; el JPG original con «Original»", async () => {
    const { api } = await loadAndRun();
    await screen.findByRole("list", { name: x.listLabel });
    fireEvent.click(screen.getByRole("button", { name: /^Descargar: Firma, página 3/ }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toBe("p03-firma-01.png");
    expect(await downloads[0].blob.text()).toBe("sig-a:png");
    expect(status().textContent).toBe("Descargado: p03-firma-01.png");
    fireEvent.click(screen.getByRole("button", { name: "Original" }));
    fireEvent.click(screen.getByRole("button", { name: /^Descargar: Firma probable, página 4/ }));
    await waitFor(() => expect(downloads).toHaveLength(2));
    expect(downloads[1].name).toBe("p04-firma-01.jpg");
    expect(vi.mocked(api.renderAsset).mock.calls.at(-1)![2]).toBe("jpg-original");
    fireEvent.click(screen.getByRole("button", { name: /^Descargar: Marca de agua/ }));
    await waitFor(() => expect(downloads).toHaveLength(3));
    expect(downloads[2].name).toBe("p01-marca-de-agua-01.txt");
  });

  it("un fallo al preparar una descarga lo dice y no deja el boton bloqueado", async () => {
    const api = engine({ renderAsset: vi.fn(async () => { throw new Error("boom"); }) });
    await loadAndRun(api);
    await screen.findByRole("list", { name: x.listLabel });
    const button = screen.getByRole("button", { name: /^Descargar: Firma, página 3/ }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(status().textContent).toBe(x.downloadFailed));
    expect(status().className).toContain("text-destructive-text");
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(downloads).toHaveLength(0);
  });

  it("ZIP de los seleccionados: un archivo por elemento, nombres sin colision y aviso con el recuento", async () => {
    await loadAndRun();
    await screen.findByRole("list", { name: x.listLabel });
    fireEvent.click(screen.getByRole("button", { name: /^Firmas/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: x.selectAll }));
    fireEvent.click(screen.getByRole("button", { name: x.zip }));
    await waitFor(() => expect(downloads).toHaveLength(1), { timeout: 5000 });
    expect(downloads[0].name).toBe("contrato-elementos.zip");
    const zip = await JSZip.loadAsync(new Uint8Array(await downloads[0].blob.arrayBuffer()));
    expect(Object.keys(zip.files).sort()).toEqual(["p03-firma-01.png", "p04-firma-01.png"]);
    expect(await zip.files["p03-firma-01.png"].async("string")).toBe("sig-a:png");
    await waitFor(() => expect(status().textContent).toBe("ZIP descargado con 2 archivos."));
  });

  it("ZIP: un elemento que falla se omite y se dice; si fallan todos, error", async () => {
    let calls = 0;
    const api = engine({
      renderAsset: vi.fn(async (_f, asset) => {
        calls += 1;
        if (asset.id === "sig-b") throw new Error("boom");
        return new Blob([asset.id]);
      }),
    });
    await loadAndRun(api);
    await screen.findByRole("list", { name: x.listLabel });
    fireEvent.click(screen.getByRole("button", { name: /^Firmas/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: x.selectAll }));
    fireEvent.click(screen.getByRole("button", { name: x.zip }));
    await waitFor(() => expect(downloads).toHaveLength(1), { timeout: 5000 });
    expect(status().textContent).toBe("ZIP descargado con 1 archivo. 1 no se pudieron preparar.");
    expect(calls).toBe(2);
  });

  it("detalle: motivos, confianza, paginas y formatos; Escape lo cierra", async () => {
    await loadAndRun();
    await screen.findByRole("list", { name: x.listLabel });
    fireEvent.click(screen.getByRole("button", { name: /^Ver detalles: Firma probable, página 4/ }));
    const dialog = await screen.findByRole("dialog", { name: x.detailTitle });
    expect(within(dialog).getByText("fondo casi blanco")).toBeTruthy();
    expect(within(dialog).getByText("Confianza: 60 %")).toBeTruthy();
    expect(within(dialog).getByText("Página 4")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "PNG" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "JPG original" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "JPG original" }));
    await waitFor(() => expect(downloads.at(-1)?.name).toBe("p04-firma-01.jpg"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: x.detailTitle })).toBeNull());
  });

  it("«Empezar con otro PDF» vuelve a la pantalla de carga", async () => {
    await loadAndRun();
    await screen.findByRole("list", { name: x.listLabel });
    fireEvent.click(screen.getByRole("button", { name: x.startOver }));
    expect(await screen.findByRole("button", { name: "Seleccionar archivo" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: x.listLabel })).toBeNull();
  });
});

describe("avisos y pestanas", () => {
  it("«Recortar región» del aviso de escaneo abre la pestana en esa pagina", async () => {
    await loadAndRun();
    await screen.findByRole("list", { name: x.listLabel });
    expect(screen.queryByTestId("region-panel")).toBeNull();
    fireEvent.click(within(document.querySelector('[data-notice="scanned-page"]') as HTMLElement).getByRole("button", { name: x.warnScannedAction }));
    const panel = await screen.findByTestId("region-panel");
    expect(panel.getAttribute("data-page")).toBe("4");
    expect(panel.getAttribute("data-scanned")).toBe("4");
    expect(screen.getByRole("tab", { name: x.tabRegion }).getAttribute("aria-selected")).toBe("true");
  });

  it("las pestanas: el panel de recorte solo se monta al visitarlo y la galeria vuelve intacta", async () => {
    await loadAndRun();
    await screen.findByRole("list", { name: x.listLabel });
    fireEvent.click(screen.getByRole("tab", { name: x.tabRegion }));
    expect(await screen.findByTestId("region-panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Elementos/ }));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(6);
  });

  it("mas de 300 paginas: aviso y formulario de rango que vuelve a pedir SOLO ese rango (0-based al motor)", async () => {
    const big = result({ pageCount: 450, scannedPages: [], warnings: [{ code: "too-many-pages" }], truncated: true });
    const extractAssets = vi.fn(async (_f: File | Uint8Array, options?: { pageRange?: { from: number; to: number } }) =>
      options?.pageRange ? result({ pageCount: 450, scannedPages: [], warnings: [] }) : big,
    );
    await loadAndRun(engine({ extractAssets: extractAssets as ExtractAssetsApi["extractAssets"] }));
    await waitFor(() => expect(heading().textContent).toBe("Encontramos 6 elementos en 300 páginas."));
    expect(document.querySelector('[data-notice="too-many-pages"]')!.textContent).toContain("450 páginas");
    const form = document.querySelector("[data-extract-range]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Desde la página"), { target: { value: "301" } });
    fireEvent.change(within(form).getByLabelText("Hasta la página"), { target: { value: "450" } });
    fireEvent.click(within(form).getByRole("button", { name: x.rangeApply }));
    await waitFor(() => expect(heading().textContent).toBe("Encontramos 6 elementos en 150 páginas."));
    expect(extractAssets.mock.calls[1][1]!.pageRange).toEqual({ from: 300, to: 449 });
    expect(document.querySelector('[data-notice="too-many-pages"]')).toBeNull();
  });

  it("al volver a buscar con otro rango, la seleccion solo conserva lo que sigue existiendo", async () => {
    const first = result({ pageCount: 450, scannedPages: [], warnings: [{ code: "too-many-pages" }], truncated: true });
    const extractAssets = vi.fn(async (_f: File | Uint8Array, options?: { pageRange?: { from: number; to: number } }) =>
      options?.pageRange ? result({ pageCount: 450, assets: sampleAssets().filter((a) => a.id !== "sig-a"), scannedPages: [], warnings: [] }) : first,
    );
    await loadAndRun(engine({ extractAssets: extractAssets as ExtractAssetsApi["extractAssets"] }));
    await screen.findByRole("list", { name: x.listLabel });
    fireEvent.click(screen.getByRole("checkbox", { name: "Firma, página 3, 420 × 140 px" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Firma probable, página 4, 520 × 180 px" }));
    expect(screen.getAllByText("2 seleccionados").length).toBeGreaterThan(0);
    const form = document.querySelector("[data-extract-range]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Desde la página"), { target: { value: "301" } });
    fireEvent.change(within(form).getByLabelText("Hasta la página"), { target: { value: "450" } });
    fireEvent.click(within(form).getByRole("button", { name: x.rangeApply }));
    await waitFor(() => expect(heading().textContent).toBe("Encontramos 5 elementos en 150 páginas."));
    expect(screen.getAllByText("1 seleccionado").length).toBeGreaterThan(0);
  });

  it("otros avisos (firma digital, imagen enorme, no se pudo leer, cifrado)", async () => {
    await loadAndRun(
      engine({
        extractAssets: vi.fn(async () =>
          result({ scannedPages: [], warnings: [{ code: "digital-signature", pageIndex: 1 }, { code: "image-too-large", pageIndex: 2 }, { code: "decode-failed", pageIndex: 3 }, { code: "encrypted" }] }),
        ),
      }),
    );
    await screen.findByRole("list", { name: x.listLabel });
    const notices = document.querySelector("[data-extract-notices]")!.textContent ?? "";
    for (const text of ["La página 2 tiene una firma digital", "página 3 es demasiado grande", "No se pudo leer una imagen de la página 4", "El documento está cifrado"]) {
      expect(notices.replace("Una imagen de la", "")).toContain(text.replace("página 3 es demasiado grande", "página 3 es demasiado grande"));
    }
  });
});

describe("estados especiales", () => {
  it("sin elementos: texto exacto, salida al recorte", async () => {
    await loadAndRun(engine({ extractAssets: vi.fn(async () => result({ assets: [], scannedPages: [], warnings: [] })) }));
    await waitFor(() => expect(heading().textContent).toBe(x.foundNone));
    const empty = document.querySelector("[data-extract-empty]") as HTMLElement;
    expect(empty.textContent).toContain("No encontramos elementos; prueba a recortar una región.");
    fireEvent.click(within(empty).getByRole("button", { name: x.goRegion }));
    expect(await screen.findByTestId("region-panel")).toBeTruthy();
  });

  it("sin motor de deteccion (unavailableEngine; el de por defecto ya es el real): lo explica y deja el recorte manual", async () => {
    setExtractEngine(unavailableEngine);
    const view = mount(<ExtractToolClient />);
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [pdf()] } });
    fireEvent.click(await screen.findByRole("button", { name: x.run }));
    await waitFor(() => expect(heading().textContent).toBe(x.autoUnavailable));
    expect(await screen.findByTestId("region-panel")).toBeTruthy();
    expect(screen.getByRole("tab", { name: x.tabRegion }).getAttribute("aria-selected")).toBe("true");
  });

  it("un PDF protegido o danado que detecta el motor muestra el banner de error compartido y se puede reintentar", async () => {
    const extractAssets = vi.fn().mockRejectedValueOnce(new PdfError("encrypted")).mockResolvedValue(result());
    setExtractEngine(engine({ extractAssets }));
    const view = mount(<ExtractToolClient />);
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [pdf()] } });
    fireEvent.click(await screen.findByRole("button", { name: x.run }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.encrypted);
    expect(within(alert).getByRole("link", { name: es.tool.errors.encryptedAction }).getAttribute("href")).toBe("/unlock-pdf");
    fireEvent.click(screen.getByRole("button", { name: x.run }));
    await waitFor(() => expect(heading().textContent).toContain("Encontramos 6 elementos"));
  });

  it("un fallo cualquiera del motor da el mensaje general (sin el texto tecnico) y vuelve a la pantalla de carga", async () => {
    setExtractEngine(engine({ extractAssets: vi.fn(async () => { throw new Error("TypeError interno"); }) }));
    const view = mount(<ExtractToolClient />);
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [pdf()] } });
    fireEvent.click(await screen.findByRole("button", { name: x.run }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("TypeError");
    expect(screen.getByRole("button", { name: x.run })).toBeTruthy();
  });
});

describe("progreso y cancelacion", () => {
  function slowEngine() {
    let progress: ((value: { pageIndex: number; pageCount: number; assetsSoFar: number }) => void) | undefined;
    let signal: AbortSignal | undefined;
    const extractAssets = vi.fn((_f: File | Uint8Array, options?: Parameters<ExtractAssetsApi["extractAssets"]>[1]) => {
      progress = options?.onProgress;
      signal = options?.signal;
      return new Promise<ExtractResult>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelado", "AbortError")));
      });
    });
    return { extractAssets: extractAssets as ExtractAssetsApi["extractAssets"], emit: (value: Parameters<NonNullable<typeof progress>>[0]) => progress?.(value), signal: () => signal };
  }

  it("muestra «Página N de M» con los hallados y se puede cancelar: aborta el motor, avisa y devuelve el foco al boton", async () => {
    const slow = slowEngine();
    await loadAndRun(engine({ extractAssets: slow.extractAssets }));
    const overlay = await screen.findByRole("dialog");
    slow.emit({ pageIndex: 2, pageCount: 8, assetsSoFar: 4 });
    await waitFor(() => expect(overlay.textContent).toContain("Página 3 de 8 · 4 encontrados"));
    fireEvent.click(within(overlay).getByRole("button", { name: "Cancelar" }));
    expect(slow.signal()!.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(status().textContent).toBe(x.cancelled);
    expect(screen.queryByRole("list", { name: x.listLabel })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: x.run })));
  });

  it("un resultado que llega tarde, tras cancelar, se ignora", async () => {
    let resolve: (value: ExtractResult) => void = () => {};
    const api = engine({ extractAssets: vi.fn(() => new Promise<ExtractResult>((r) => { resolve = r; })) });
    await loadAndRun(api);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    resolve(result());
    await new Promise((done) => setTimeout(done, 20));
    expect(screen.queryByRole("list", { name: x.listLabel })).toBeNull();
    expect(document.querySelector("[data-extract-heading]")).toBeNull();
  });

  it("desmontar mientras busca aborta el motor", async () => {
    const slow = slowEngine();
    const { unmount } = await loadAndRun(engine({ extractAssets: slow.extractAssets }));
    await screen.findByRole("dialog");
    unmount();
    expect(slow.signal()!.aborted).toBe(true);
  });
});
