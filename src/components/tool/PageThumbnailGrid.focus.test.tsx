import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PageThumbnailGrid } from "@/components/tool/PageThumbnailGrid";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

/**
 * pdf.js y su worker no arrancan en jsdom: se sustituyen las tres funciones
 * de render de `core.ts` por el minimo que la rejilla necesita (3 paginas).
 * Lo que se comprueba aqui es el foco tras quitar, no el rasterizado.
 */
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 3,
      getPage: async () => ({ cleanup: () => {} }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

const FILE = new File([new Uint8Array([1, 2, 3])], "doc.pdf", {
  type: "application/pdf",
});

async function renderGrid() {
  render(
    <LanguageProvider>
      <PageThumbnailGrid files={[FILE]} removable reorderable selectable />
    </LanguageProvider>,
  );
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Quitar" })).toHaveLength(3),
  );
}

const removeButtons = () => screen.getAllByRole("button", { name: "Quitar" });

/**
 * Tras quitar una pagina el boton pulsado desaparece con su celda: el foco no
 * debe caer a <body>. Pasa al "Quitar" de la pagina que ocupa ahora esa
 * posicion (o al de la ultima) y, si no queda ninguna, al encabezado.
 */
describe("PageThumbnailGrid — foco al quitar paginas", () => {
  it("quitar una pagina intermedia lleva el foco al Quitar de la que ocupa su lugar", async () => {
    await renderGrid();
    const buttons = removeButtons();
    buttons[1].focus();
    expect(document.activeElement).toBe(buttons[1]);

    fireEvent.click(buttons[1]);

    const after = removeButtons();
    expect(after).toHaveLength(2);
    // La que era la tercera pagina es ahora la segunda: su boton recibe el foco.
    expect(document.activeElement).toBe(after[1]);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("quitar la ultima pagina lleva el foco al Quitar de la nueva ultima", async () => {
    await renderGrid();
    const buttons = removeButtons();
    buttons[2].focus();

    fireEvent.click(buttons[2]);

    const after = removeButtons();
    expect(after).toHaveLength(2);
    expect(document.activeElement).toBe(after[1]);
  });

  it("al quitar la unica pagina que queda, el foco va al encabezado de la rejilla (no a body)", async () => {
    await renderGrid();
    // Se vacian las paginas de una en una, como lo haria alguien con teclado.
    for (let remaining = 3; remaining > 0; remaining -= 1) {
      const buttons = removeButtons();
      expect(buttons).toHaveLength(remaining);
      buttons[0].focus();
      fireEvent.click(buttons[0]);
      if (remaining > 1) {
        expect(document.activeElement).toBe(removeButtons()[0]);
      }
    }

    expect(screen.queryAllByRole("button", { name: "Quitar" })).toHaveLength(0);
    const heading = screen.getByRole("heading", { name: "Vista previa de páginas" });
    expect(document.activeElement).toBe(heading);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("otros cambios de la rejilla (marcar una pagina) no mueven el foco", async () => {
    await renderGrid();
    const toggle = screen.getByRole("button", { name: "Página 2" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(toggle);
  });
});
