import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import { AssetCard } from "@/app/extract-assets/AssetCard";
import { makeAsset, mount, setLanguage } from "@/app/extract-assets/testUtils";

beforeEach(() => {
  setLanguage("es");
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});

function renderCard(overrides: Partial<Parameters<typeof AssetCard>[0]> = {}) {
  const handlers = { onToggle: vi.fn(), onDetails: vi.fn(), onDownload: vi.fn(), onSave: vi.fn() };
  const asset = makeAsset({ id: "a", confidence: 0.6, thumb: new Blob(["x"], { type: "image/png" }) });
  const view = mount(
    <ul>
      <AssetCard asset={asset} strings={es.extract} locale="es-ES" selected={false} busy={false} locked={false} {...handlers} {...overrides} />
    </ul>,
  );
  return { ...view, ...handlers, asset };
}

describe("AssetCard", () => {
  it("el elemento de la lista y su casilla se llaman «Firma probable, página 3, 420 × 140 px»", async () => {
    renderCard();
    const name = "Firma probable, página 3, 420 × 140 px";
    expect(screen.getByRole("listitem", { name })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name })).toBeTruthy();
    // La miniatura es decorativa: el nombre ya esta en la casilla.
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    expect(document.querySelector("img")!.getAttribute("alt")).toBe("");
  });

  it("el chip dice «probable» segun la confianza y el texto de pagina, tamano y peso", () => {
    renderCard();
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("Firma probable")).toBeTruthy();
    expect(item.textContent).toContain("página 3 · 420 × 140 px · 2,0 KB");
    renderCard({ asset: makeAsset({ id: "b", confidence: 0.97 }) });
    expect(screen.getAllByText("Firma").length).toBeGreaterThan(0);
  });

  it("marcar, detalles, descargar y guardar llaman a su manejador con el elemento; los nombres empiezan por el rotulo visible", () => {
    const { asset, onToggle, onDetails, onDownload, onSave } = renderCard();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith("a");
    const label = "Firma probable, página 3, 420 × 140 px";
    const download = screen.getByRole("button", { name: `Descargar: ${label}` });
    expect(download.textContent).toBe("Descargar");
    fireEvent.click(download);
    expect(onDownload).toHaveBeenCalledWith(asset);
    fireEvent.click(screen.getByRole("button", { name: `Ver detalles: ${label}` }));
    expect(onDetails).toHaveBeenCalledWith(asset);
    const save = screen.getByRole("button", { name: `Guardar en Firmas guardadas: ${label}` });
    expect(save.textContent).toBe("Guardar");
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(asset);
  });

  it("un elemento sin pixeles (texto) no ofrece «Guardar» y muestra su texto en lugar de la miniatura", () => {
    renderCard({ asset: makeAsset({ id: "t", kind: "watermark", confidence: 0.7, source: "text", pixel: null, thumb: null, ref: { engine: "text", text: "CONFIDENCIAL" }, formats: ["txt"] }) });
    expect(screen.getByText("CONFIDENCIAL")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Guardar en Firmas guardadas/ })).toBeNull();
    expect(screen.getByRole("listitem").getAttribute("aria-label")).toBe("Marca de agua probable, página 3, solo texto");
  });

  it("varias paginas: «Repetido en 6 páginas»", () => {
    renderCard({
      asset: makeAsset({ id: "r", kind: "logo", occurrences: [0, 1, 2, 3, 4, 5].map((pageIndex) => ({ pageIndex, rect: { x: 0, y: 0, width: 1, height: 1 } })) }),
    });
    expect(screen.getByRole("listitem").textContent).toContain("Repetido en 6 páginas");
    expect(screen.getByRole("listitem").getAttribute("aria-label")).toBe("Logo, 6 páginas, 420 × 140 px");
  });

  it("ocupado: el boton lo dice y esta desactivado; con una tarea larga en curso (ZIP) tambien", () => {
    renderCard({ busy: true });
    const busy = screen.getByRole("button", { name: /^Descargar:/ }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.textContent).toBe("Preparando…");
    renderCard({ locked: true });
    expect((screen.getAllByRole("button", { name: /^Descargar:/ })[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("seleccionada: la casilla esta marcada", () => {
    renderCard({ selected: true });
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("en ingles", () => {
    setLanguage("en");
    renderCard({ strings: en.extract });
    expect(screen.getByRole("listitem").getAttribute("aria-label")).toBe("Probable signature, page 3, 420 × 140 px");
    expect(screen.getByRole("button", { name: /^Download:/ })).toBeTruthy();
  });
});
