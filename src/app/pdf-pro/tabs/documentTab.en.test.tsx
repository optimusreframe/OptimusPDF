import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { DocumentTab } from "@/app/pdf-pro/tabs/DocumentTab";
import { ProtectTab } from "@/app/pdf-pro/tabs/ProtectTab";
import { labelsOf, mountTab, pageTexts } from "@/app/pdf-pro/tabs/docTestUtils";
import { __resetPageInfoCacheForTests } from "@/app/pdf-pro/ops/pageInfo";
import { WATERMARK_STRINGS } from "@/app/add-watermark/strings";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";

/** Las mismas herramientas en INGLES: nombres, motivos, etiquetas de snapshot y avisos. */

vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => null) }));

const T = PRO_STRINGS.en.docTools;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
});
afterAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => __resetPageInfoCacheForTests());
afterEach(() => cleanup());

async function openTool(title: string) {
  fireEvent.click(screen.getByRole("button", { name: T.launcher.open(title) }));
  await screen.findByRole("heading", { level: 2, name: title });
}

describe("PDF Pro en ingles", () => {
  it("la lista de herramientas y el resumen salen en ingles", async () => {
    await mountTab(<DocumentTab />, { pages: 2 });
    for (const id of ["watermark", "page-numbers", "header-footer", "compress", "crop", "rotate", "metadata", "repair", "ocr"] as const) {
      expect(screen.getByRole("button", { name: T.launcher.open(T.tools[id].title) })).toBeTruthy();
    }
    expect(screen.getByRole("heading", { name: T.summary.title })).toBeTruthy();
    expect(screen.getByText("2 pages")).toBeTruthy();
  });

  it("marca de agua: texto por defecto en ingles y etiqueta «Watermark “CONFIDENTIAL”»", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.watermark.title);
    expect((screen.getByLabelText(WATERMARK_STRINGS.en.textLabel) as HTMLInputElement).value).toBe("CONFIDENTIAL");
    fireEvent.click(screen.getByRole("button", { name: T.runner.apply }));
    await waitFor(() => expect(labelsOf(doc)).toEqual(["Original", "Watermark “CONFIDENTIAL”"]));
    expect(doc.getState().announcement?.text).toBe(PRO_STRINGS.en.announce.applied("Watermark “CONFIDENTIAL”"));
    expect((await pageTexts(doc.current()!))[0]).toContain("CONFIDENTIAL");
  });

  it("motivos en ingles: texto vacio y rango fuera del documento", async () => {
    await mountTab(<DocumentTab />, { pages: 2 });
    await openTool(T.tools.watermark.title);
    fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.en.textLabel), { target: { value: "" } });
    expect(screen.getByText(WATERMARK_STRINGS.en.textRequired)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.en.textLabel), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.en.pagesFrom), { target: { value: "9" } });
    expect(screen.getByText(T.runner.rangeBeyond)).toBeTruthy();
  });

  it("encabezado y pie: «Page n of p» al pie y etiqueta en ingles", async () => {
    const { doc } = await mountTab(<DocumentTab />, { pages: 2 });
    await openTool(T.tools["header-footer"].title);
    fireEvent.click(screen.getByRole("button", { name: T.runner.apply }));
    await waitFor(() => expect(labelsOf(doc)).toEqual(["Original", "Header and footer"]));
    expect((await pageTexts(doc.current()!))[1]).toContain("Page 2 of 2");
  });

  it("rotar: «Rotate 90° (all pages)»", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.rotate.title);
    fireEvent.click(screen.getByRole("button", { name: T.runner.apply }));
    await waitFor(() => expect(labelsOf(doc)).toEqual(["Original", "Rotate 90° (all pages)"]));
  });

  it("OCR: marca «Needs a connection» y aviso en ingles", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.ocr.title);
    const notice = document.querySelector("[data-needs-network]") as HTMLElement;
    expect(within(notice).getByText(T.runner.networkBadge)).toBeTruthy();
    expect(within(notice).getByText(T.runner.networkBody)).toBeTruthy();
  });

  it("comprimir sin ganancia: «The result is the same…» y sin snapshot", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.compress.title);
    fireEvent.click(screen.getByRole("button", { name: T.runner.apply }));
    expect(await screen.findByText(PRO_STRINGS.en.warnings.unchanged)).toBeTruthy();
    expect(labelsOf(doc)).toEqual(["Original"]);
  });

  it("proteger: motivo Latin-1 en ingles y aviso de copia descifrada", async () => {
    await mountTab(<ProtectTab />, { encrypted: true });
    fireEvent.change(screen.getByLabelText(PROTECT_STRINGS.en.passwordLabel), { target: { value: "pa€ss" } });
    expect(screen.getByText(PROTECT_STRINGS.en.errors.unsupportedChars.replace("{chars}", "€"))).toBeTruthy();
    expect(screen.getByText(T.protect.encryptedOriginTitle)).toBeTruthy();
    expect(screen.getByRole("button", { name: T.protect.saveButton }).getAttribute("aria-disabled")).toBe("true");
  });
});
