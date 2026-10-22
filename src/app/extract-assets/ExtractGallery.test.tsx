import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { es } from "@/lib/locales/es";
import { FIRST_BATCH, ExtractGallery, NEXT_BATCH, type ExtractGalleryProps } from "@/app/extract-assets/ExtractGallery";
import { countByFilter, filterAssets, sortAssets } from "@/app/extract-assets/model";
import { makeAsset, mount, sampleAssets, setLanguage } from "@/app/extract-assets/testUtils";

beforeEach(() => {
  setLanguage("es");
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});

function renderGallery(overrides: Partial<ExtractGalleryProps> = {}) {
  const assets = sortAssets(sampleAssets());
  const filter = overrides.filter ?? "all";
  const handlers = {
    onFilter: vi.fn(),
    onToggle: vi.fn(),
    onToggleAll: vi.fn(),
    onClearSelection: vi.fn(),
    onFormat: vi.fn(),
    onDetails: vi.fn(),
    onDownload: vi.fn(),
    onSave: vi.fn(),
    onZip: vi.fn(),
    onZipCancel: vi.fn(),
  };
  const props: ExtractGalleryProps = {
    strings: es.extract,
    locale: "es-ES",
    assets,
    visible: filterAssets(assets, filter),
    counts: countByFilter(assets),
    filter,
    selected: new Set(),
    busyId: null,
    zip: { phase: "idle" },
    formatPreference: "png",
    offersOriginal: true,
    ...handlers,
    ...overrides,
  };
  return { ...mount(<ExtractGallery {...props} />), ...handlers, assets };
}

describe("ExtractGallery", () => {
  it("es una lista con un elemento por cada visible y el nombre accesible de la lista", () => {
    renderGallery();
    const list = screen.getByRole("list", { name: "Elementos encontrados" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
  });

  it("los filtros llevan su recuento, solo aparecen los que tienen elementos y el activo esta pulsado", () => {
    renderGallery({ filter: "signature" });
    const group = screen.getByRole("group", { name: "Filtrar por tipo" });
    const names = within(group).getAllByRole("button").map((button) => button.textContent);
    expect(names).toEqual(["Todos6", "Firmas2", "Iniciales1", "Imágenes1", "Logos1", "Marcas de agua1"]);
    expect(within(group).getByRole("button", { name: /^Firmas/ }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: /^Todos/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Mostrando 2 de 6")).toBeTruthy();
  });

  it("pulsar un filtro lo pide; un filtro activo sin elementos sigue visible (para poder salir de el)", () => {
    const { onFilter } = renderGallery();
    fireEvent.click(screen.getByRole("button", { name: /^Logos/ }));
    expect(onFilter).toHaveBeenCalledWith("logo");
    renderGallery({ filter: "stamp", visible: [] });
    expect(screen.getAllByRole("button", { name: /^Sellos/ }).length).toBeGreaterThan(0);
    expect(screen.getByText("No hay elementos de este tipo.")).toBeTruthy();
  });

  it("«Seleccionar todo» es una casilla real: marcada con todo, indeterminada con parte, desactivada sin nada visible", () => {
    const assets = sortAssets(sampleAssets());
    const { unmount } = renderGallery({ selected: new Set(assets.map((a) => a.id)) });
    const all = screen.getByRole("checkbox", { name: "Seleccionar todo" }) as HTMLInputElement;
    expect(all.checked).toBe(true);
    unmount();
    const partial = renderGallery({ selected: new Set([assets[0].id]) });
    const box = screen.getByRole("checkbox", { name: "Seleccionar todo" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.indeterminate).toBe(true);
    fireEvent.click(box);
    expect(partial.onToggleAll).toHaveBeenCalled();
    partial.unmount();
    renderGallery({ visible: [] });
    expect((screen.getByRole("checkbox", { name: "Seleccionar todo" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("sin seleccion no hay barra de ZIP; con seleccion aparece con el recuento y llama a onZip", () => {
    const first = renderGallery();
    expect(screen.queryByRole("button", { name: "Descargar seleccionados (.zip)" })).toBeNull();
    expect(screen.getByText("Ninguno seleccionado")).toBeTruthy();
    first.unmount();
    const { onZip, onClearSelection } = renderGallery({ selected: new Set(["sig-a", "sig-b"]) });
    expect(screen.getAllByText("2 seleccionados").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Descargar seleccionados (.zip)" }));
    expect(onZip).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Quitar selección" }));
    expect(onClearSelection).toHaveBeenCalled();
  });

  it("preparando el ZIP: el boton dice «Preparando 3 de 8», esta desactivado y aparece «Cancelar»; las descargas individuales se bloquean", () => {
    const { onZipCancel } = renderGallery({ selected: new Set(["sig-a"]), zip: { phase: "working", done: 3, total: 8 } });
    const zip = screen.getByRole("button", { name: "Preparando 3 de 8" }) as HTMLButtonElement;
    expect(zip.disabled).toBe(true);
    expect(zip.getAttribute("aria-busy")).toBe("true");
    for (const download of screen.getAllByRole("button", { name: /^Descargar:/ })) expect((download as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onZipCancel).toHaveBeenCalled();
  });

  it("el selector de formato solo aparece si algo ofrece mas que PNG, con la opcion activa pulsada", () => {
    const first = renderGallery({ offersOriginal: false });
    expect(screen.queryByRole("group", { name: "Formato al descargar" })).toBeNull();
    first.unmount();
    const { onFormat } = renderGallery({ formatPreference: "original" });
    const group = screen.getByRole("group", { name: "Formato al descargar" });
    expect(within(group).getByRole("button", { name: "Original" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "PNG" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(within(group).getByRole("button", { name: "PNG" }));
    expect(onFormat).toHaveBeenCalledWith("png");
  });

  it("una casilla de tarjeta llama a onToggle con su id; las acciones llegan con el elemento", () => {
    const { onToggle, onDownload, assets } = renderGallery();
    fireEvent.click(screen.getByRole("checkbox", { name: "Firma, página 3, 420 × 140 px" }));
    expect(onToggle).toHaveBeenCalledWith("sig-a");
    fireEvent.click(screen.getByRole("button", { name: /^Descargar: Foto|^Descargar: Imagen/ }));
    expect(onDownload).toHaveBeenCalledWith(assets.find((a) => a.id === "img-a"));
  });
});

describe("pintado progresivo (500 elementos sin una tarea larga)", () => {
  const many = Array.from({ length: FIRST_BATCH + NEXT_BATCH * 2 + 5 }, (_, index) => makeAsset({ id: `m${index}`, occurrences: [{ pageIndex: index % 9, rect: { x: 0, y: index / 1000, width: 0.1, height: 0.1 } }] }));

  it("empieza con el primer lote y anade el resto en turnos hasta pintar TODAS; el recuento no depende de lo pintado", async () => {
    renderGallery({ assets: many, visible: many, counts: countByFilter(many) });
    const list = screen.getByRole("list", { name: "Elementos encontrados" });
    expect(within(list).getAllByRole("listitem").length).toBeLessThan(many.length);
    expect(screen.getByText(`Mostrando ${many.length} de ${many.length}`)).toBeTruthy();
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(many.length));
  });

  it("pocos elementos se pintan de una vez", () => {
    renderGallery();
    expect(within(screen.getByRole("list", { name: "Elementos encontrados" })).getAllByRole("listitem")).toHaveLength(6);
  });
});
