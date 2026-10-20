import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { freshLibrary, seedDoc } from "@/lib/backup/__fixtures__/libraryKit";
import { MyDocumentsView } from "@/components/views/MyDocumentsView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";

/** El respaldo de «Mis documentos» en INGLES: panel y hojas, sin español ni claves crudas. */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/documents" }));
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => null) }));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
});
afterAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  window.localStorage.removeItem("optimuspdf.lastBackup");
  freshLibrary();
});

function renderView() {
  return render(
    <LanguageProvider>
      <MyDocumentsView />
    </LanguageProvider>,
  );
}

describe("Mis documentos · respaldo (EN)", () => {
  it("en inglés: textos del panel y de las hojas, sin español ni claves crudas", async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    await seedDoc("a", 1, { name: "Contract A" });
    const { container } = renderView();
    fireEvent.click(await screen.findByRole("button", { name: en.documents.backup.exportAction }));
    const dialog = await screen.findByRole("dialog", { name: en.documents.backup.exportTitle });
    await within(dialog).findByText(/This will export: 1 document, 0 templates/);
    expect(dialog.textContent).not.toMatch(/documents\.|\{\w+\}/);
    expect(dialog.textContent).not.toContain(es.documents.backup.exportNever);
    fireEvent.click(within(dialog).getByRole("button", { name: en.common.close }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: en.documents.backup.importAction }));
    const importDialog = await screen.findByRole("dialog", { name: en.documents.backup.importTitle });
    expect(within(importDialog).getByRole("button", { name: en.documents.backup.pickZip })).toBeTruthy();
    expect(container.textContent).toContain(en.documents.backup.lastNever);
  });
});
