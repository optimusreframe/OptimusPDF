import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { ConvertTab } from "@/app/pdf-pro/tabs/ConvertTab";
import { mountTab } from "@/app/pdf-pro/tabs/docTestUtils";

/** «Convertir» en INGLES: titulos, opciones, rangos y avisos. */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});

const E = PRO_STRINGS.en.export;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
});
afterAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => cleanup());

const card = (id: string) => document.querySelector<HTMLElement>(`[data-export="${id}"]`)!;

describe("Convertir en ingles", () => {
  it("las ocho tarjetas salen con su titulo en ingles", async () => {
    await mountTab(<ConvertTab />);
    for (const [id, text] of Object.entries(E.formats)) {
      expect(within(card(id)).getByRole("heading", { name: text.title })).toBeTruthy();
      expect(within(card(id)).getByText(text.body)).toBeTruthy();
    }
  });

  it("el panel de imagenes habla ingles: formato, DPI y alcance", async () => {
    await mountTab(<ConvertTab />);
    fireEvent.click(within(card("images")).getByRole("button", { name: E.card.showOptions }));
    expect(within(card("images")).getByRole("tab", { name: E.images.scopeRange })).toBeTruthy();
    expect(within(card("images")).getByRole("tab", { name: E.images.dpi[2] })).toBeTruthy();
    fireEvent.click(within(card("images")).getByRole("tab", { name: E.images.scopeRange }));
    fireEvent.change(within(card("images")).getByLabelText(E.images.rangeLabel), { target: { value: "9" } });
    expect(card("images").querySelector("[data-export-problem]")?.textContent).toBe(E.images.rangeInvalid(3));
  });

  it("el aviso de OCR y red esta en ingles", async () => {
    await mountTab(<ConvertTab />);
    expect(within(card("text")).getByText(E.card.mayNeedNetwork)).toBeTruthy();
    expect(within(card("text")).getByText(E.card.ocrNetwork)).toBeTruthy();
  });
});
