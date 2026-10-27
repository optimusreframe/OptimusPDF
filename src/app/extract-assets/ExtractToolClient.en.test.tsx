import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { en } from "@/lib/locales/en";
import { setExtractEngine } from "@/lib/pdf/extractAssets";
import { ExtractToolClient } from "@/app/extract-assets/ExtractToolClient";
import { mount, sampleAssets, setLanguage } from "@/app/extract-assets/testUtils";

/** «Extraer elementos» en INGLES (archivo aparte: el idioma se lee una vez por modulo, como en `ResumeGoneNotice.en.test`). */

const downloads: { name: string }[] = [];
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: (_blob: Blob, name: string) => downloads.push({ name }) };
});
vi.mock("@/lib/image/inkExtract", async (importOriginal) => (await import("@/app/extract-assets/testUtils")).withFakeInk(await importOriginal()));
vi.mock("@/app/extract-assets/RegionPanel", () => ({ RegionPanel: () => <div data-testid="region-panel" /> }));

beforeAll(() => {
  setLanguage("en");
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});

describe("Extract elements (EN)", () => {
  it("texts, accessible names and file names in English", async () => {
    setExtractEngine({
      extractAssets: async () => ({ pageCount: 6, assets: sampleAssets(), scannedPages: [4], warnings: [{ code: "scanned-page", pageIndex: 4 }], truncated: false }),
      renderAsset: async () => new Blob(["x"]),
    });
    const view = mount(<ExtractToolClient />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Extract elements");
    expect(document.querySelector("[data-extract-note]")!.textContent).toBe("Use this only with your own signatures or with the signer's permission.");
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File([new Uint8Array([37, 80, 68, 70])], "contract.pdf", { type: "application/pdf" })] } });
    fireEvent.click(await screen.findByRole("button", { name: en.extract.run }));
    await waitFor(() => expect(document.querySelector("[data-extract-heading]")!.textContent).toBe("We found 6 elements in 6 pages."));
    const list = screen.getByRole("list", { name: "Elements found" });
    expect(within(list).getByRole("listitem", { name: "Probable signature, page 4, 520 × 180 px" })).toBeTruthy();
    expect(document.querySelector('[data-notice="scanned-page"]')!.textContent).toContain("Page 5 is a scan");
    fireEvent.click(screen.getByRole("button", { name: /^Download: Signature, page 3/ }));
    await waitFor(() => expect(downloads[0]?.name).toBe("p03-signature-01.png"));
    expect(screen.getByRole("tab", { name: "Crop region" })).toBeTruthy();
  });
});
