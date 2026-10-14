import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RecentView } from "@/components/views/RecentView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";
import { addRecentEntry, clearRecentEntries } from "@/lib/recent";

/** Recientes en INGLES (U0.6): mismos controles, sin claves crudas ni texto en espanol. */

vi.mock("@/app/sign-pdf/signDrafts", () => ({
  listAllDrafts: vi.fn(async () => []),
  subscribeToDrafts: vi.fn(() => () => {}),
  deleteSessionDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));
vi.mock("@/app/edit-pdf/editDrafts", () => ({
  listEditDrafts: vi.fn(async () => [
    {
      schema: 1,
      id: "b".repeat(64),
      fileName: "report.pdf",
      fileSize: 10,
      totalBytes: 10,
      savedAt: "2026-10-14T11:00:00.000Z",
      pageCount: 2,
      currentPage: 0,
      pendingCount: 2,
    },
  ]),
  subscribeToEditDrafts: vi.fn(() => () => {}),
  deleteEditDraft: vi.fn(),
}));
vi.mock("@/app/pdf-pro/proDrafts", () => ({
  listProDrafts: vi.fn(async () => []),
  subscribeToProDrafts: vi.fn(() => () => {}),
  deleteProDraft: vi.fn(),
}));
vi.mock("@/app/pdf-pro/session/useDraftThumbnails", () => ({ useDraftThumbnails: () => ({}) }));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
});
afterAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(cleanup);

describe("RecentView (EN)", () => {
  it("todo sale en ingles: subtitulo, secciones, Continue, Open tool y Discard", async () => {
    clearRecentEntries();
    addRecentEntry("merge-pdf", "old.pdf");
    const { container } = render(
      <LanguageProvider>
        <RecentView />
      </LanguageProvider>,
    );

    await screen.findByRole("heading", { name: en.recent.unfinishedTitle });
    expect(screen.getByRole("heading", { level: 1, name: en.recent.title })).toBeTruthy();
    expect(screen.getByText(en.recent.subtitle)).toBeTruthy();
    expect(en.recent.subtitle).toContain("saved only in this browser, with the document");
    expect(screen.getByRole("heading", { name: en.recent.historyTitle })).toBeTruthy();

    const row = screen.getByText("report.pdf").closest("li")!;
    expect(within(row).getByText(/Edit PDF/)).toBeTruthy();
    expect(within(row).getByText(en.recent.changesMany.replace("{n}", "2"), { exact: false })).toBeTruthy();
    expect(within(row).getByRole("link", { name: en.common.continueLabel }).getAttribute("href")).toBe(
      `/edit-pdf?resume=edit:${"b".repeat(64)}`,
    );
    expect(within(row).getByRole("button", { name: en.recent.discard.replace("{name}", "report.pdf") })).toBeTruthy();
    const old = screen.getByText("old.pdf").closest("li")!;
    expect(within(old).getByRole("link", { name: en.recent.openTool })).toBeTruthy();

    const text = container.textContent ?? "";
    expect(text).not.toContain(es.recent.unfinishedTitle);
    expect(text).not.toContain(es.recent.openTool);
    expect(text).not.toMatch(/recent\.|resume\.|\{n\}|\{name\}/);
  });

  it("los diccionarios ES y EN de Recientes tienen las mismas claves", () => {
    expect(Object.keys(en.recent).sort()).toEqual(Object.keys(es.recent).sort());
    for (const key of Object.keys(es.recent) as (keyof typeof es.recent)[]) {
      expect(en.recent[key], key).toBeTruthy();
    }
    // Los marcadores {n} y {name} estan en los mismos textos en ambos idiomas.
    for (const key of Object.keys(es.recent) as (keyof typeof es.recent)[]) {
      expect(en.recent[key].includes("{n}"), key).toBe(es.recent[key].includes("{n}"));
      expect(en.recent[key].includes("{name}"), key).toBe(es.recent[key].includes("{name}"));
    }
  });
});
