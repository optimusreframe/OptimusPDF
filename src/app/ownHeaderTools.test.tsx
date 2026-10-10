import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { blockedRunText } from "@/components/tool/errorCopy";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { loadPdf } from "@/lib/pdf/core";
import { createInputGuard } from "@/lib/pdf/inputGuard";
import { buildBadFile, buildGoodPdf, pdfFile } from "@/lib/pdf/testing/inputFixtures";
import { CompareToolClient } from "@/app/compare-pdf/CompareToolClient";
import { COMPARE_STRINGS } from "@/app/compare-pdf/strings";
import { PdfaCheckerToolClient } from "@/app/pdf-to-pdfa/PdfaCheckerToolClient";
import { PDFA_STRINGS } from "@/app/pdf-to-pdfa/strings";
import { PdfSummarizerToolClient } from "@/app/pdf-summarizer/PdfSummarizerToolClient";
import { SUMMARIZER_STRINGS } from "@/app/pdf-summarizer/strings";
import { ScanToPdfClient } from "@/app/scan-to-pdf/ScanToPdfClient";
import { STRINGS as SCAN_STRINGS } from "@/app/scan-to-pdf/strings";

/**
 * Wave 6 · U5: las cuatro herramientas con cabecera propia (pdf-to-pdfa, compare,
 * summarizer, scan) se comportan como las que pasan por `ToolShell`: el archivo
 * elegido se ve con su chip (nombre, tamano, «Quitar»), no hay insignia
 * «Disponible», el banner de error es el mismo componente y un archivo malo no
 * se puede procesar.
 */

vi.mock("@/lib/pdf/summarize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/summarize")>();
  return {
    ...actual,
    detectWebGpuSupport: async () => "ready" as const,
    isModelCached: async () => false,
  };
});
vi.mock("@/lib/scan/documentDetection", () => ({
  preloadDocumentDetection: () => {},
  detectDocumentInBlob: () => new Promise(() => {}),
}));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  // jsdom no calcula cajas: el foco solo se da a elementos pintados.
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});

const guard = createInputGuard({
  open: async (file) => {
    (await loadPdf(file)).getPageCount();
  },
});

function mount(node: React.ReactNode) {
  return render(
    <LanguageProvider>
      <InputGuardContext.Provider value={guard}>{node}</InputGuardContext.Provider>
    </LanguageProvider>,
  );
}

function inputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
}

describe("pdf-to-pdfa — cabecera propia", () => {
  it("sin insignia «Disponible»", async () => {
    mount(<PdfaCheckerToolClient />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(es.common.live)).toBeNull();
    expect(document.body.textContent).not.toContain("Disponible");
  });

  it("el archivo elegido se muestra con su chip y «Quitar» (como en las demas)", async () => {
    const { container } = mount(<PdfaCheckerToolClient />);
    fireEvent.change(inputs(container)[0], {
      target: { files: [pdfFile(await buildGoodPdf(2), "informe.pdf")] },
    });
    expect(await screen.findByText("informe.pdf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quitar" })).toBeTruthy();
    // El selector de archivos desaparece mientras hay uno elegido.
    expect(screen.queryByRole("button", { name: "Seleccionar archivo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    expect(await screen.findByRole("button", { name: "Seleccionar archivo" })).toBeTruthy();
  });

  it("sin archivo, el boton de comprobar esta desactivado y dice por que", () => {
    mount(<PdfaCheckerToolClient />);
    const run = screen.getByRole("button", { name: PDFA_STRINGS.es.run }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(document.getElementById(run.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      PDFA_STRINGS.es.needFile,
    );
  });

  for (const [kind, message] of [
    ["truncated", es.tool.errors.corrupt],
    ["empty", es.tool.errors.emptyFile],
    ["notPdf", es.tool.errors.notPdf],
    ["renamedPng", es.tool.errors.notPdf],
    ["garbage", es.tool.errors.corrupt],
  ] as const) {
    it(`archivo ${kind}: el MISMO banner que en ToolShell y comprobar queda desactivado`, async () => {
      const { container } = mount(<PdfaCheckerToolClient />);
      fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile(kind)] } });
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(es.tool.fileProblemTitle);
      expect(alert.textContent).toContain(message);
      const run = screen.getByRole("button", { name: PDFA_STRINGS.es.run }) as HTMLButtonElement;
      await waitFor(() => expect(run.disabled).toBe(true));
      // El motivo nombra el boton REAL de la herramienta, no un «Procesar» que no existe.
      expect(document.getElementById(run.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
        blockedRunText(es, PDFA_STRINGS.es.run),
      );
    });
  }

  it("PDF cifrado: banner con el enlace a Desbloquear PDF", async () => {
    const { container } = mount(<PdfaCheckerToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("encrypted")] } });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("link", { name: es.tool.errors.encryptedAction }).getAttribute("href")).toBe(
      "/unlock-pdf",
    );
  });

  it("«Quitar archivo» del banner devuelve la zona de carga", async () => {
    const { container } = mount(<PdfaCheckerToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("empty")] } });
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Quitar archivo" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("button", { name: "Seleccionar archivo" })).toBeTruthy();
  });
});

describe("compare-pdf — cabecera propia", () => {
  const strings = COMPARE_STRINGS.es;

  it("sin insignia «Disponible»", async () => {
    mount(<CompareToolClient />);
    await screen.findByRole("heading", { level: 1 });
    expect(document.body.textContent).not.toContain("Disponible");
  });

  it("los huecos dicen «Añadir documento A» / «Añadir documento B», no «Añadir más archivos»", () => {
    mount(<CompareToolClient />);
    expect(screen.getByRole("button", { name: "Añadir documento A" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Añadir documento B" })).toBeTruthy();
    expect(screen.queryByText("Añadir más archivos")).toBeNull();
  });

  it("el input de cada hueco tiene nombre accesible propio", () => {
    const { container } = mount(<CompareToolClient />);
    const names = inputs(container).map((input) => input.getAttribute("aria-label"));
    expect(names).toEqual(["Añadir documento A", "Añadir documento B"]);
  });

  it("cada documento elegido se ve con su chip y «Quitar»", async () => {
    const { container } = mount(<CompareToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [pdfFile(await buildGoodPdf(1), "a.pdf")] } });
    fireEvent.change(inputs(container)[0], { target: { files: [pdfFile(await buildGoodPdf(1), "b.pdf")] } });
    expect(await screen.findByText("a.pdf")).toBeTruthy();
    expect(await screen.findByText("b.pdf")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Quitar" })).toHaveLength(2);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: strings.run }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("un documento malo en el hueco B: banner con su nombre y comparar desactivado", async () => {
    const { container } = mount(<CompareToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [pdfFile(await buildGoodPdf(1), "a.pdf")] } });
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("truncated")] } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Archivo: truncado.pdf");
    expect(alert.textContent).toContain(es.tool.errors.corrupt);
    const run = screen.getByRole("button", { name: strings.run }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(true));
    fireEvent.click(within(alert).getByRole("button", { name: "Quitar archivo" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("button", { name: "Añadir documento B" })).toBeTruthy();
    expect(screen.getByText("a.pdf")).toBeTruthy();
  });

  it("sin los dos documentos, el motivo se lee junto al boton", () => {
    mount(<CompareToolClient />);
    const run = screen.getByRole("button", { name: strings.run }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(document.getElementById(run.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      strings.needBoth,
    );
  });
});

describe("pdf-summarizer — cabecera propia", () => {
  const strings = SUMMARIZER_STRINGS.es;

  async function mountReady() {
    const utils = mount(<PdfSummarizerToolClient />);
    await waitFor(() => expect(inputs(utils.container).length).toBeGreaterThan(0));
    return utils;
  }

  it("sin insignia «Disponible» (se conserva la de IA)", async () => {
    await mountReady();
    expect(document.body.textContent).not.toContain("Disponible");
    expect(screen.getByText(strings.aiBadge)).toBeTruthy();
  });

  it("el archivo elegido sale con chip «Quitar»", async () => {
    const { container } = await mountReady();
    fireEvent.change(inputs(container)[0], { target: { files: [pdfFile(await buildGoodPdf(2), "libro.pdf")] } });
    expect(await screen.findByText("libro.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    await waitFor(() => expect(screen.queryByText("libro.pdf")).toBeNull());
  });

  it("sin archivo ni permiso, el boton de resumir dice qué falta", async () => {
    await mountReady();
    const run = screen.getByRole("button", { name: strings.consentButton }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(document.getElementById(run.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      strings.runNeedsFile,
    );
  });

  it("con archivo sin autorizar el modelo, el motivo cambia", async () => {
    const { container } = await mountReady();
    fireEvent.change(inputs(container)[0], { target: { files: [pdfFile(await buildGoodPdf(1), "libro.pdf")] } });
    await screen.findByText("libro.pdf");
    const run = screen.getByRole("button", { name: strings.consentButton }) as HTMLButtonElement;
    expect(document.getElementById(run.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      strings.runNeedsConsent,
    );
  });

  it("un archivo roto: el mismo banner y no se puede resumir aunque se autorice", async () => {
    const { container } = await mountReady();
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("garbage")] } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.corrupt);
    fireEvent.click(screen.getByRole("checkbox", { name: strings.consentCheckbox }));
    const run = screen.getByRole("button", { name: strings.consentButton }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(document.getElementById(run.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      blockedRunText(es, strings.consentButton),
    );
  });
});

describe("scan-to-pdf — cabecera propia", () => {
  const strings = SCAN_STRINGS.es;

  it("sin insignia «Disponible»", async () => {
    mount(<ScanToPdfClient />);
    await screen.findByRole("heading", { level: 1 });
    expect(document.body.textContent).not.toContain("Disponible");
  });

  it("sin capturas, generar esta desactivado y dice por que (panel y barra movil)", () => {
    mount(<ScanToPdfClient />);
    const buttons = screen.getAllByRole("button", { name: strings.generate }) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
        strings.needCapture,
      );
    }
  });

  it("UN solo boton de generar visible en escritorio (el del panel); la barra es solo movil", () => {
    mount(<ScanToPdfClient />);
    const visible = (screen.getAllByRole("button", { name: strings.generate }) as HTMLButtonElement[]).filter(
      (button) => !button.closest(".md\\:hidden"),
    );
    expect(visible).toHaveLength(1);
    expect(visible[0].closest("aside")).toBeTruthy();
  });

  it("no hay ningun role=alert mientras no haya error", () => {
    mount(<ScanToPdfClient />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("N3 — foco al banner y «Elegir otro archivo» en las cabeceras propias", () => {
  const picked = async (name: string) => pdfFile(await buildGoodPdf(2), name);

  async function replaceThrough(container: HTMLElement, file: File) {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Elegir otro archivo" }));
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    const chooser = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]')).find(
      (candidate) => candidate.getAttribute("aria-label") === "Elegir otro archivo",
    ) as HTMLInputElement;
    fireEvent.change(chooser, { target: { files: [file] } });
  }

  it("pdf-to-pdfa: el foco va al banner y el archivo elegido sustituye al malo", async () => {
    const { container } = mount(<PdfaCheckerToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("garbage")] } });
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.contains(document.activeElement)).toBe(true));
    await replaceThrough(container, await picked("bueno.pdf"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("bueno.pdf")).toBeTruthy();
    expect(screen.queryByText("basura.pdf")).toBeNull();
    const run = screen.getByRole("button", { name: PDFA_STRINGS.es.run }) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(false));
  });

  it("compare-pdf: el archivo elegido ocupa el hueco del documento malo (B), A queda intacto", async () => {
    const { container } = mount(<CompareToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [await picked("a.pdf")] } });
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("truncated")] } });
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.contains(document.activeElement)).toBe(true));
    await replaceThrough(container, await picked("b.pdf"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("a.pdf")).toBeTruthy();
    expect(screen.getByText("b.pdf")).toBeTruthy();
    expect(screen.queryByText("truncado.pdf")).toBeNull();
  });

  it("pdf-summarizer: foco al banner y reemplazo del archivo", async () => {
    const { container } = render(
      <LanguageProvider>
        <InputGuardContext.Provider value={guard}>
          <PdfSummarizerToolClient />
        </InputGuardContext.Provider>
      </LanguageProvider>,
    );
    await waitFor(() => expect(inputs(container).length).toBeGreaterThan(0));
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("empty")] } });
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.contains(document.activeElement)).toBe(true));
    await replaceThrough(container, await picked("libro.pdf"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("libro.pdf")).toBeTruthy();
  });

  it("pdf-to-pdfa: un archivo de otro formato elegido en el selector avisa y no sustituye al malo", async () => {
    const { container } = mount(<PdfaCheckerToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("garbage")] } });
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Elegir otro archivo" }));
    click.mockRestore();
    const chooser = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]')).find(
      (candidate) => candidate.getAttribute("aria-label") === "Elegir otro archivo",
    ) as HTMLInputElement;
    fireEvent.change(chooser, { target: { files: [new File(["x"], "nota.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(es.tool.fileProblemTitle));
    expect(screen.getByText("basura.pdf")).toBeTruthy();
  });

  it("pdf-to-pdfa: >100 MB es un AVISO (region de estado, titulo propio), no un error", async () => {
    const { container } = mount(<PdfaCheckerToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("tooLarge")] } });
    await waitFor(() => expect(document.querySelector("[data-error-banner]")).toBeTruthy());
    const banner = document.querySelector("[data-error-banner]") as HTMLElement;
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain(es.tool.largeFileTitle);
    expect(banner.textContent).not.toContain(es.tool.errors.title);
    await waitFor(() => expect(banner.contains(document.activeElement)).toBe(true));
  });
});

describe("V-F — el foco llega a un destino logico, sin <body>, en las cabeceras propias", () => {
  const good = async (name: string) => pdfFile(await buildGoodPdf(2), name);

  it("pdf-to-pdfa: «Quitar» de la lista con el unico archivo deja el foco en el selector de archivos", async () => {
    const { container } = mount(<PdfaCheckerToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [await good("a.pdf")] } });
    await screen.findByText("a.pdf");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: PDFA_STRINGS.es.run }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    const pick = await screen.findByRole("button", { name: "Seleccionar archivo", hidden: false });
    await waitFor(() => expect(document.activeElement).toBe(pick));
  });

  it("pdf-to-pdfa: «Quitar archivo» del banner deja el foco en el selector de archivos", async () => {
    const { container } = mount(<PdfaCheckerToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("empty")] } });
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Quitar archivo" }));
    const pick = await screen.findByRole("button", { name: "Seleccionar archivo", hidden: false });
    await waitFor(() => expect(document.activeElement).toBe(pick));
  });

  it("compare-pdf: «Quitar» de un hueco deja el foco en un control de la zona (nunca <body>)", async () => {
    const { container } = mount(<CompareToolClient />);
    fireEvent.change(inputs(container)[0], { target: { files: [await good("a.pdf")] } });
    await screen.findByText("a.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.closest("main, div")).toBeTruthy();
    expect(screen.queryByText("a.pdf")).toBeNull();
  });

  it("pdf-summarizer: «Quitar archivo» del banner deja el foco en el selector de archivos", async () => {
    const { container } = render(
      <LanguageProvider>
        <InputGuardContext.Provider value={guard}>
          <PdfSummarizerToolClient />
        </InputGuardContext.Provider>
      </LanguageProvider>,
    );
    await waitFor(() => expect(inputs(container).length).toBeGreaterThan(0));
    fireEvent.change(inputs(container)[0], { target: { files: [await buildBadFile("garbage")] } });
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Quitar archivo" }));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(screen.queryByText("basura.pdf")).toBeNull();
  });
});
