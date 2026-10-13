import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PdfError } from "@/lib/pdf/core";
import { ExportIndicator } from "@/app/pdf-pro/export/ExportIndicator";
import { getExportStore } from "@/app/pdf-pro/export/exportStore";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import type { ProExport, ProExportContext, ProExportResult } from "@/app/pdf-pro/ops/proExports";
import { mountTab } from "@/app/pdf-pro/tabs/docTestUtils";

/** Indicador global de la exportacion en curso (Wave 9) en INGLES. */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});

const EN = getExportStrings("en");

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
});
afterAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => cleanup());

function Bar() {
  return (
    <div data-pro-region="top">
      <h1 tabIndex={-1}>Document</h1>
      <ExportIndicator />
    </div>
  );
}

function engine(id: string) {
  const calls: ProExportContext[] = [];
  const entry: ProExport = {
    id,
    title: () => id,
    body: () => id,
    slug: "pdf-to-powerpoint",
    requiresNetwork: false,
    run: (_bytes, context) => {
      calls.push(context);
      return new Promise<ProExportResult>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new PdfError("cancelled")));
      });
    },
  };
  return { entry, calls };
}

describe("ExportIndicator en ingles", () => {
  it("texto, barra y «Cancel» en ingles; cancelar anuncia en ingles", async () => {
    const { doc } = await mountTab(<Bar />);
    const control = engine("powerpoint");
    act(() => void getExportStore(doc).start({ entry: control.entry, options: {}, selectedPages: [], language: "en" }));
    act(() => control.calls[0].onProgress(0.07));
    const group = screen.getByRole("group", { name: EN.indicator.group });
    expect(within(group).getByText(EN.indicator.running("PowerPoint"))).toBeTruthy();
    expect(within(group).getByText(EN.indicator.percent(7))).toBeTruthy();
    expect(within(group).getByRole("progressbar", { name: EN.indicator.progressLabel("PowerPoint") })).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: EN.indicator.cancelLabel("PowerPoint") }));
    expect(doc.getState().announcement?.text).toBe(EN.card.cancelled);
  });
});
