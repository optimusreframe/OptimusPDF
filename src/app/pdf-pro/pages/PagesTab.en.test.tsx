import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { PagesTab } from "@/app/pdf-pro/pages/PagesTab";
import { openRichDoc, renderWithDoc } from "@/app/pdf-pro/pages/pagesTestUtils";
import { inspectPdf } from "@/lib/pdf/testing/pageAssemblyFixtures";

/** El organizador de paginas en INGLES: etiquetas, anuncios, etiqueta del snapshot y avisos. */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const { PDFDocument: Doc } = await import("@cantoo/pdf-lib");
  return {
    ...actual,
    openPdfDocument: async (source: Uint8Array) => {
      const loaded = await Doc.load(source, { updateMetadata: false });
      return {
        numPages: loaded.getPageCount(),
        getPage: async (n: number) => ({ index: n - 1, cleanup: () => undefined }),
        loadingTask: { destroy: async () => undefined },
      };
    },
    renderPageToDataUrl: async (page: { index: number }) => `data:image/png;base64,${page.index}`,
  };
});

const E = PRO_STRINGS.en.pages;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
});
afterAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => cleanup());

async function setup(options: Parameters<typeof openRichDoc>[0] = { pages: 4 }) {
  const { doc } = await openRichDoc(options);
  renderWithDoc(doc, <PagesTab />);
  await screen.findAllByRole("option");
  return { doc };
}

describe("PagesTab en ingles", () => {
  it("el panel, la cuadricula y los botones salen en ingles", async () => {
    await setup();
    expect(screen.getByRole("region", { name: E.panelTitle })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: E.gridLabel(4) })).toBeTruthy();
    expect(screen.getByText(E.status.noChanges)).toBeTruthy();
    for (const name of [E.status.apply, E.actions.rotateLeft, E.actions.rotateRight, E.actions.remove, E.actions.duplicate, E.actions.moveBefore, E.actions.moveAfter, E.actions.more]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("option", { name: /^Page 2 of 4/ })).toBeTruthy();
  });

  it("los anuncios y la etiqueta del snapshot salen en ingles", async () => {
    const { doc } = await setup({ pages: 5 });
    fireEvent.click(screen.getByRole("option", { name: /^Page 5 of 5/ }));
    expect(doc.getState().announcement?.text).toBe(E.announce.selected(1));
    fireEvent.click(screen.getByRole("button", { name: E.actions.moveBefore }));
    fireEvent.click(screen.getByRole("button", { name: E.actions.remove }));
    expect(doc.getState().announcement?.text).toBe(E.announce.removed(1));
    fireEvent.click(screen.getByRole("button", { name: E.status.apply }));
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    expect(doc.getState().document!.snapshots[1].label).toBe("Delete 1 page");
    expect((await inspectPdf(doc.current() as Uint8Array)).pageCount).toBe(4);
  });

  it("el chip de cambios y el aviso del motor, en ingles", async () => {
    const { doc } = await setup({ pages: 4, outline: true });
    fireEvent.click(screen.getByRole("option", { name: /^Page 2 of 4/ }));
    fireEvent.click(screen.getByRole("button", { name: E.actions.remove }));
    expect(screen.getByText(E.status.changes(1))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: E.status.apply }));
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    const notices = await screen.findByRole("region", { name: E.status.warningsTitle });
    expect(notices.textContent).toContain("1 bookmarks that pointed to deleted pages were removed.");
  });
});
