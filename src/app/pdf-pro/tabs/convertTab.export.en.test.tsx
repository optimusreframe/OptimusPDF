import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { getExportStore } from "@/app/pdf-pro/export/exportStore";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { ConvertTab } from "@/app/pdf-pro/tabs/ConvertTab";
import { mountTab } from "@/app/pdf-pro/tabs/docTestUtils";

/** «Convertir» en INGLES: titulos, opciones, rangos y avisos. */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});

const runner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/app/pdf-pro/export/exportRunners", () => ({ runExportFormat: runner.run }));

const E = PRO_STRINGS.en.export;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
});
afterAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  runner.run.mockReset();
  runner.run.mockImplementation(async (id: string) => ({ blob: new Blob([id]), filename: `salida-${id}.bin` }));
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

describe("Convertir · exportacion persistente (Wave 9)", () => {
  it("desmontar la pestaña con una exportacion en marcha NO la cancela ni dice que se cancelo", async () => {
    const { doc, unmount } = await mountTab(<ConvertTab />);
    fireEvent.click(within(card("text")).getByRole("button", { name: E.formats.text.title }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    unmount();
    expect(getExportStore(doc).getState().job?.phase === "running" || getExportStore(doc).getState().job?.phase === "done").toBe(true);
    expect(doc.getState().announcement?.text).not.toBe(E.card.cancelled);
  });

  it("el resultado, la version y el aviso de otra exportacion en curso hablan ingles", async () => {
    let finish!: (value: { blob: Blob; filename: string }) => void;
    runner.run.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await mountTab(<ConvertTab />);
    fireEvent.click(within(card("json")).getByRole("button", { name: E.formats.json.title }));
    await within(card("json")).findByRole("progressbar");
    expect(within(card("json")).getByText(E.card.runningFrom("Original"))).toBeTruthy();
    expect(within(card("text")).getByText(E.card.inProgressOther(E.formatsShort.json))).toBeTruthy();
    await act(async () => finish({ blob: new Blob(["j"]), filename: "report-json.json" }));
    expect(within(card("json")).getByText(E.card.result("report-json.json", "Original"))).toBeTruthy();
  });
});
