import "fake-indexeddb/auto";
import { useCallback, useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  SignToolClient,
  SoloFlow,
  type SignToolOptions,
} from "@/app/sign-pdf/SignToolClient";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { QUICK_SIGN_STRINGS } from "@/app/sign-pdf/fillMode/fillStrings";
import { LanguageProvider, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { detectFields, type DetectedField } from "@/lib/pdf/detectFields";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetSignTemplatesCacheForTests } from "@/app/sign-pdf/signTemplates";

/** Lo mismo que `DocumentCanvas.test.tsx`: sin pdf.js, una pagina simulada de 600 x 800. */
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 2,
      getPage: async () => ({ cleanup: () => {} }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

const strings = SIGN_STRINGS.es;
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: 600,
      height: 800,
      top: 0,
      left: 0,
      right: 600,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

const A = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", {
  type: "application/pdf",
  lastModified: 1_700_000_000_000,
});
const B = new File([new Uint8Array([9, 9, 9, 9])], "anexo.pdf", {
  type: "application/pdf",
  lastModified: 1_700_000_999_999,
});
let KEY_A = "";
let KEY_B = "";

const FIELD_NAME: DetectedField = {
  id: "txt-solo-1",
  pageIndex: 0,
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
  label: "Nombre",
  source: "acroform",
  confidence: "high",
};
const FIELD_DATE: DetectedField = {
  id: "txt-solo-2",
  pageIndex: 1,
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
  label: "Fecha",
  source: "acroform",
  confidence: "high",
};

beforeAll(async () => {
  KEY_A = await documentContentKey(A);
  KEY_B = await documentContentKey(B);
});

beforeEach(() => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetSignTemplatesCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

function soloOptions(patch: Partial<SignToolOptions> = {}): SignToolOptions {
  return {
    mode: "single",
    signaturePng: PNG,
    ratio: 0.3,
    pageIndex: 0,
    rect: { x: 0.2, y: 0.6, width: 0.32, height: 0.072 },
    signature: "",
    step: "signers",
    signers: [],
    fields: [],
    captures: {},
    activeSignerId: null,
    fieldPageIndex: 0,
    selectedFieldId: null,
    placementTool: "select",
    textFields: [],
    textValues: {},
    selectedTextFieldId: null,
    editingTextFieldId: null,
    textFieldsDetectedFor: null,
    ...patch,
  };
}

function Harness({
  file,
  onOptions,
  initial,
  onCreateSignature = () => {},
}: {
  file: File;
  onOptions: (options: SignToolOptions) => void;
  initial?: SignToolOptions;
  onCreateSignature?: () => void;
}) {
  const [options, setOptions] = useState<SignToolOptions>(() => initial ?? soloOptions());
  onOptions(options);
  // Estable, como el `setOptions` de `ToolShell`.
  const patch = useCallback(
    (next: Partial<SignToolOptions>) => setOptions((previous) => ({ ...previous, ...next })),
    [],
  );
  return (
    <SoloFlow
      file={file}
      options={options}
      setOptions={patch}
      onCreateSignature={onCreateSignature}
      strings={strings}
    />
  );
}

const soloGroup = () =>
  screen.getByRole("group", {
    name: `${strings.soloSignatureLabel}, ${strings.soloSignatureA11y}`,
  });
const textGroup = (label: string) =>
  screen.getByRole("group", {
    name: new RegExp(`^${label}, (${strings.a11yPending}|${strings.a11yFilled})$`),
  });

describe("SoloFlow — src/app/sign-pdf/SignToolClient.tsx (modo Solo yo inline)", () => {
  it("los campos detectados aparecen SOBRE la pagina junto a la firma y no hay formulario fuera del lienzo", async () => {
    vi.mocked(detectFields).mockResolvedValue([FIELD_NAME, FIELD_DATE]);
    let last = soloOptions();
    const { container } = render(<Harness file={A} onOptions={(o) => (last = o)} />);
    await waitFor(() => expect(last.textFields).toHaveLength(2));
    expect(last.textFieldsDetectedFor).toBe(KEY_A);
    expect(last.signature).toBe(KEY_A);
    expect(soloGroup()).toBeTruthy();
    expect(textGroup("Nombre")).toBeTruthy();
    expect(screen.getByText(strings.detectedFieldsSummary(2))).toBeTruthy();
    const host = container.querySelector('[data-canvas="host"]')!;
    const stray = [...container.querySelectorAll("form, input, textarea, select")].filter(
      (node) => !host.contains(node),
    );
    expect(stray).toEqual([]);
  });

  it("se rellena en linea: tocar el campo abre el editor, lo tecleado queda en las opciones y el aviso de pendientes cuenta", async () => {
    vi.mocked(detectFields).mockResolvedValue([FIELD_NAME, FIELD_DATE]);
    let last = soloOptions();
    render(<Harness file={A} onOptions={(o) => (last = o)} />);
    await waitFor(() => expect(last.textFields).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByText(strings.pendingTextFieldsWarning(2))).toBeTruthy(),
    );
    fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
    const input = await screen.findByRole("textbox", { name: "Nombre" });
    fireEvent.change(input, { target: { value: "Ana Perez" } });
    fireEvent.blur(input);
    expect(last.textValues[FIELD_NAME.id]).toBe("Ana Perez");
    await waitFor(() =>
      expect(screen.getByText(strings.pendingTextFieldsWarning(1))).toBeTruthy(),
    );
  });

  it("la region de aviso de pendientes esta siempre montada (vacia sin aviso)", async () => {
    render(<Harness file={A} onOptions={() => {}} />);
    await waitFor(() => expect(screen.getByText(strings.soloTotalSummary(1, 0))).toBeTruthy());
    const regions = screen.getAllByRole("status");
    // Anuncios del lienzo, estado de la deteccion y aviso de pendientes.
    expect(regions.length).toBeGreaterThanOrEqual(3);
    expect(regions.some((region) => region.textContent === "")).toBe(true);
  });

  it("quitar la firma la saca de las opciones (sin colocar) y 'Deshacer' la repone tal cual", async () => {
    let last = soloOptions();
    render(<Harness file={A} onOptions={(o) => (last = o)} />);
    await waitFor(() => expect(last.signature).toBe(KEY_A));
    const placed = last.rect;
    fireEvent.pointerDown(soloGroup(), { pointerId: 1, clientX: 300, clientY: 500 });
    fireEvent.pointerUp(soloGroup(), { pointerId: 1 });
    const bar = await screen.findByRole("group", { name: /^Acciones de / });
    fireEvent.click(
      within(bar).getByRole("button", {
        name: new RegExp(`^${strings.soloRemoveSignature}`),
      }),
    );
    expect(last.rect.width).toBe(0);
    expect(last.signaturePng).toBe(PNG);
    fireEvent.click(screen.getByRole("button", { name: strings.undoRemoveField }));
    expect(last.rect).toEqual(placed);
    expect(last.pageIndex).toBe(0);
  });

  it("al cambiar de archivo se reinicia lo del documento (firma colocada, campos, valores) y se conserva la firma creada; lo hecho antes de la huella se sella, no se pierde", async () => {
    vi.mocked(detectFields).mockResolvedValue([FIELD_NAME]);
    let last = soloOptions();
    const { rerender } = render(<Harness file={A} onOptions={(o) => (last = o)} />);
    await waitFor(() => expect(last.textFields).toHaveLength(1));
    rerender(<Harness file={B} onOptions={(o) => (last = o)} />);
    await waitFor(() => expect(last.signature).toBe(KEY_B));
    expect(last.signaturePng).toBe(PNG);
    // Sin colocar: el lienzo nuevo la colocara por defecto en la pagina nueva.
    await waitFor(() => expect(last.rect.width).toBeGreaterThan(0));
    expect(last.pageIndex).toBe(0);
    expect(last.textValues).toEqual({});
  });

  it("la deteccion no se repite si el estado ya trae sus campos (alternar de modo no duplica ni pisa)", async () => {
    vi.mocked(detectFields).mockResolvedValue([FIELD_NAME]);
    let last = soloOptions({
      signature: KEY_A,
      textFields: [FIELD_NAME],
      textValues: { [FIELD_NAME.id]: "Ana" },
      textFieldsDetectedFor: KEY_A,
    });
    render(<Harness file={A} initial={last} onOptions={(o) => (last = o)} />);
    await waitFor(() => expect(textGroup("Nombre")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(detectFields).not.toHaveBeenCalled();
    expect(last.textValues[FIELD_NAME.id]).toBe("Ana");
  });

  it("sin firma creada, el lienzo ofrece crearla y la herramienta Firma abre el compositor", async () => {
    const onCreate = vi.fn();
    render(
      <Harness
        file={A}
        initial={soloOptions({ signaturePng: "", ratio: 0, rect: { x: 0, y: 0, width: 0, height: 0 } })}
        onOptions={() => {}}
        onCreateSignature={onCreate}
      />,
    );
    await waitFor(() => expect(screen.getByText(strings.noSignature)).toBeTruthy());
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: strings.paletteLabel })).getByRole("button", {
        name: strings.fieldSignature,
      }),
    );
    expect(onCreate).toHaveBeenCalled();
  });
});

describe("SignToolClient — modo Solo yo de punta a punta (jsdom)", () => {
  async function pdfFile(name: string): Promise<File> {
    const doc = await PDFDocument.create();
    doc.addPage([307, 307]);
    const bytes = await doc.save({ useObjectStreams: true });
    return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
  }
  const pdfInput = (container: HTMLElement) =>
    container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;

  it("sin firma ni campos no se puede procesar; con un campo de texto relleno si, y se descarga", async () => {
    const file = await pdfFile("solo.pdf");
    const { container } = render(
      <LanguageProvider>
        <SignToolClient />
      </LanguageProvider>,
    );
    fireEvent.change(pdfInput(container), { target: { files: [file] } });
    // El modo por defecto es "Solo yo" y ya no hay colocador aparte: el lienzo unico.
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    const run = () => screen.getAllByRole("button", { name: "Procesar" });
    expect(run().every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

    fireEvent.click(
      within(screen.getByRole("toolbar", { name: strings.paletteLabel })).getByRole("button", {
        name: strings.fieldTypeText,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.addTextFieldHere }));
    const textInput = await screen.findByRole("textbox", {
      name: strings.textFieldFallbackLabel(1),
    });
    fireEvent.change(textInput, { target: { value: "Ana Perez" } });
    fireEvent.blur(textInput);

    await waitFor(() =>
      expect(run().some((button) => !(button as HTMLButtonElement).disabled)).toBe(true),
    );
    fireEvent.click(run().find((button) => !(button as HTMLButtonElement).disabled)!);
    await waitFor(() => expect(screen.getByText("solo-firmado.pdf")).toBeTruthy());
  });

  it("alternar a Varios firmantes y volver conserva los campos rellenados (el estado es del documento)", async () => {
    const file = await pdfFile("alterna.pdf");
    const { container } = render(
      <LanguageProvider>
        <SignToolClient />
      </LanguageProvider>,
    );
    fireEvent.change(pdfInput(container), { target: { files: [file] } });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: strings.paletteLabel })).getByRole("button", {
        name: strings.fieldTypeText,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.addTextFieldHere }));
    const textInput = await screen.findByRole("textbox", {
      name: strings.textFieldFallbackLabel(1),
    });
    fireEvent.change(textInput, { target: { value: "Ana Perez" } });
    fireEvent.blur(textInput);

    fireEvent.click(screen.getByRole("tab", { name: strings.modeMulti }));
    fireEvent.click(screen.getByRole("button", { name: `2. ${strings.stepDocument}` }));
    expect(await screen.findByRole("group", { name: strings.textFieldFallbackLabel(1) + ", " + strings.a11yFilled })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: strings.modeSingle }));
    expect(await screen.findByRole("group", { name: strings.textFieldFallbackLabel(1) + ", " + strings.a11yFilled })).toBeTruthy();
  });

  describe("quitar el archivo y cargar otro SIN huella (contexto no seguro: sin crypto.subtle)", () => {
    async function twoPdfs(): Promise<[File, File]> {
      const make = async (size: number, name: string) => {
        const doc = await PDFDocument.create();
        doc.addPage([size, size]);
        const bytes = await doc.save({ useObjectStreams: true });
        return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
      };
      return [await make(311, "a.pdf"), await make(313, "b.pdf")];
    }
    const filled = () => screen.queryAllByRole("group", { name: /, rellenado$/ });

    async function addValueInA(valueText: string) {
      fireEvent.click(
        within(screen.getByRole("toolbar", { name: strings.paletteLabel })).getByRole("button", {
          name: strings.fieldTypeText,
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: strings.addTextFieldHere }));
      const input = await screen.findByRole("textbox", { name: strings.textFieldFallbackLabel(1) });
      fireEvent.change(input, { target: { value: valueText } });
      fireEvent.blur(input);
      await waitFor(() => expect(filled()).toHaveLength(1));
    }

    it("Solo yo: lo tecleado en A no aparece en B (la huella nunca llega)", async () => {
      // La huella nunca llega: sin ella el reinicio por cambio de huella no puede ocurrir.
      vi.spyOn(crypto.subtle, "digest").mockImplementation(() =>
        Promise.reject(new Error("sin crypto.subtle")),
      );
      const [a, b] = await twoPdfs();
      const { container } = render(
        <LanguageProvider>
          <SignToolClient />
        </LanguageProvider>,
      );
      const input = () =>
        container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;
      fireEvent.change(input(), { target: { files: [a] } });
      await screen.findByRole("toolbar", { name: strings.paletteLabel });
      await addValueInA("DATO-DE-A");

      fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
      await waitFor(() => expect(input()).toBeTruthy());
      fireEvent.change(input(), { target: { files: [b] } });
      await screen.findByRole("toolbar", { name: strings.paletteLabel });
      await waitFor(() => expect(screen.getByText(strings.soloTotalSummary(0, 0))).toBeTruthy());
      expect(filled()).toHaveLength(0);
      expect(screen.queryByDisplayValue("DATO-DE-A")).toBeNull();
      vi.restoreAllMocks();
    });

    it("Varios firmantes: lo de A no aparece en B, y los firmantes se conservan", async () => {
      vi.spyOn(crypto.subtle, "digest").mockImplementation(() =>
        Promise.reject(new Error("sin crypto.subtle")),
      );
      const [a, b] = await twoPdfs();
      const { container } = render(
        <LanguageProvider>
          <SignToolClient />
        </LanguageProvider>,
      );
      const input = () =>
        container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;
      fireEvent.change(input(), { target: { files: [a] } });
      fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
      fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
      fireEvent.click(screen.getByRole("button", { name: `2. ${strings.stepDocument}` }));
      await addValueInA("DATO-DE-A");

      fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
      await waitFor(() => expect(input()).toBeTruthy());
      fireEvent.change(input(), { target: { files: [b] } });
      // Quien firma ya estaba decidido: la ronda nueva arranca en «Documento» (W3-B2) con «Firman: Firmante 1 · Cambiar»;
      // «Cambiar» da el paso Firmantes con el firmante de siempre, y de ahi se vuelve al documento sin nada de A.
      await waitFor(() =>
        expect(screen.getByText(QUICK_SIGN_STRINGS.es.signersRecap(strings.defaultSignerName(1)))).toBeTruthy(),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: `${QUICK_SIGN_STRINGS.es.signersChange}. ${QUICK_SIGN_STRINGS.es.signersChangeHint}`,
        }),
      );
      expect(
        screen.getByRole("button", { name: strings.removeSigner(strings.defaultSignerName(1)) }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: `2. ${strings.stepDocument}` }));
      await screen.findByRole("toolbar", { name: strings.paletteLabel });
      expect(filled()).toHaveLength(0);
      expect(screen.getByText(strings.canvasEmptyHint)).toBeTruthy();
      vi.restoreAllMocks();
    });
  });
});
