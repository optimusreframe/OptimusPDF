import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoMapResult } from "@/lib/pdf/autoMapTypes";
import { computeFingerprintWith } from "@/lib/docLibrary/fingerprintEngine";
import { __resetLibraryForTests } from "@/lib/docLibrary/store";
import { resetSignHandoffForTests, setSignHandoff } from "@/lib/docLibrary/signHandoff";
import { nodeEnv } from "@/lib/docLibrary/testing/nodeEnv";
import { resave } from "@/lib/docLibrary/testing/syntheticContracts";
import { renderSynthetic } from "@/lib/pdf/testing/autoMapSynthetic";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { contractSpec } from "../../../e2e/helpers/template-pdfs";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { __resetSignPdfFeatureFlagsCacheForTests, setSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { __resetSignTemplatesCacheForTests, saveTemplate } from "@/app/sign-pdf/signTemplates";
import { emptyContent, repeatInitialsIn } from "@/app/sign-pdf/templateEditorModel";
import { saveTemplateToLibrary } from "@/app/sign-pdf/templateLibrary";
import { getDocument, replaceDocumentBytes } from "@/lib/docLibrary/store";
import { getTemplateForDocument } from "@/lib/docLibrary/templatesStore";

/** Lo que «abrir un documento guardado» devolveria, con el PDF base que se guardo en la prueba. */
const bases = new Map<string, Uint8Array>();
async function openFromTest(id: string) {
  const [entry, template, bytes] = await Promise.all([getDocument(id), getTemplateForDocument(id), Promise.resolve(bases.get(id))]);
  if (!entry || !bytes) return null;
  return { entry, template, file: new File([bytes as BlobPart], entry.fileName, { type: "application/pdf" }) };
}

const mocks = vi.hoisted(() => ({ autoMapFile: vi.fn(), openLibraryDocument: vi.fn(), pickPdfFile: vi.fn() }));
vi.mock("@/app/sign-pdf/templatePicker", () => ({ pickPdfFile: () => mocks.pickPdfFile() }));
vi.mock("@/lib/pdf/autoMapFile", () => ({ autoMapFile: mocks.autoMapFile }));
// Los bytes de IndexedDB falso salen de otro «realm» en jsdom (`instanceof Uint8Array` falla): se abre el PDF base de otro modo.
// En un navegador real lo comprueban los E2E. Todo lo demas (huella, plantillas, aplicacion) es el codigo de verdad.
vi.mock("@/app/sign-pdf/templateLibrary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/sign-pdf/templateLibrary")>()),
  openLibraryDocument: (id: string) => mocks.openLibraryDocument(id),
}));
vi.mock("@/lib/docLibrary/fingerprint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docLibrary/fingerprint")>()),
  computeFingerprint: async (source: Uint8Array | Blob) => computeFingerprintWith(source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer()), nodeEnv()),
}));
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/pdf/detectFields")>()), detectFields: vi.fn(async () => []) }));

const strings = SIGN_STRINGS.es;
const R = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const LINE = R(0.74, 0.885, 0.13, 0.045);

async function contract(label: string, pages = 5): Promise<Uint8Array> {
  return (await renderSynthetic(contractSpec({ label, pages, signers: 2 }))).bytes;
}
const pdfFile = (bytes: Uint8Array, name = "contrato.pdf") => new File([bytes as BlobPart], name, { type: "application/pdf" });

function configured(pages: number, name = "Mold Test") {
  const base = emptyContent(name, "es");
  const start = {
    ...base,
    variants: {
      ...base.variants,
      "2": {
        fields: [
          { id: "base", roleIndex: 0, pageIndex: 0, type: "initials" as const, rect: LINE, required: true, source: "manual" as const },
          { id: "sig1", roleIndex: 0, pageIndex: pages - 1, type: "signature" as const, rect: R(0.1, 0.5, 0.3, 0.05), required: true, source: "manual" as const },
          { id: "sig2", roleIndex: 1, pageIndex: pages - 1, type: "signature" as const, rect: R(0.55, 0.5, 0.3, 0.05), required: true, source: "manual" as const },
        ],
        textFields: [],
      },
    },
  };
  const out = repeatInitialsIn(start, "2", { basePage: 0, pageCount: pages });
  if ("error" in out) throw new Error(out.error);
  return out.content;
}

async function storeTemplate(label = "Alpha", pages = 5) {
  const bytes = await contract(label, pages);
  const saved = await saveTemplateToLibrary({ file: pdfFile(bytes), content: configured(pages), documentId: null, template: null });
  if (!saved.ok) throw new Error(saved.reason);
  bases.set(saved.document.id, bytes);
  return { bytes, saved };
}

function renderTool() {
  return render(
    <LanguageProvider>
      <SignToolClient />
    </LanguageProvider>,
  );
}
function upload(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}
const notices = () => document.querySelector("[data-template-notices]") as HTMLElement;
/** Los avisos no dejan ni un contenedor vacio en la pagina: sin avisos no hay elemento. */
const noticesText = () => document.querySelector("[data-template-notices]")?.textContent ?? "";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetSignTemplatesCacheForTests();
  __resetLibraryForTests();
  resetSignHandoffForTests();
  globalThis.indexedDB = new IDBFactory();
  bases.clear();
  mocks.openLibraryDocument.mockReset().mockImplementation(openFromTest);
  mocks.autoMapFile.mockReset().mockResolvedValue({ fields: [], pages: [], confidenceSummary: { high: 0, review: 0, ignore: 0, byType: { signature: 0, initials: 0, date: 0, text: 0 }, meanHighConfidence: 0, maxPerPage: 0 }, warnings: [] } satisfies AutoMapResult);
});
afterEach(() => cleanup());

describe("Firmar con plantillas de documento", () => {
  it("subir el MISMO PDF reexportado aplica solo la plantilla: modo varios, 2 firmantes con el nombre de su rol, aviso con Deshacer", async () => {
    const { bytes } = await storeTemplate();
    const { container } = renderTool();
    upload(container, pdfFile(await resave(bytes, { title: "otra vez" }), "contrato-nuevo.pdf"));
    await waitFor(() => expect(noticesText()).toContain("Plantilla «Mold Test» aplicada"), { timeout: 15_000 });
    expect(noticesText()).toContain("2 firmantes · 12 campos en 5 páginas");
    expect(screen.getByRole("tab", { name: strings.modeMulti }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("Nombre del firmante 1") as HTMLInputElement).value).toBe("Asegurado");
    expect((screen.getByLabelText("Nombre del firmante 2") as HTMLInputElement).value).toBe("Co-asegurado");
    expect(screen.getByText("12 huecos en total")).toBeTruthy();
    // Con «Ir a firmar» se llega a la ceremonia sin mas pasos.
    fireEvent.click(screen.getByRole("button", { name: "Ir a firmar" }));
    expect(await screen.findByRole("heading", { name: "Pásale el dispositivo a Asegurado" })).toBeTruthy();
    // El aviso sigue ahi y se puede deshacer.
    fireEvent.click(within(notices()).getByRole("button", { name: "Deshacer" }));
    await waitFor(() => expect(noticesText()).not.toContain("aplicada"));
    expect(screen.getByRole("tab", { name: strings.modeSingle }).getAttribute("aria-selected")).toBe("true");
  }, 40_000);

  it("el cambio de 2 a 1 firmante del aviso re-aplica la variante", async () => {
    const { bytes } = await storeTemplate();
    const { container } = renderTool();
    upload(container, pdfFile(await resave(bytes)));
    await waitFor(() => expect(noticesText()).toContain("aplicada"), { timeout: 15_000 });
    fireEvent.click(within(notices()).getByRole("tab", { name: "1 firmante" }));
    await waitFor(() => expect(noticesText()).toContain("1 firmante · 6 campos en 5 páginas"));
    expect(screen.queryByLabelText("Nombre del firmante 2")).toBeNull();
    expect(screen.getByText("6 huecos en total")).toBeTruthy();
  }, 40_000);

  it("con «Aplicar plantillas automáticamente» apagado no se aplica nada", async () => {
    const { bytes } = await storeTemplate();
    setSignPdfFeatureFlag("autoApplyTemplates", false);
    setSignPdfFeatureFlag("autoDetectFields", false);
    const { container } = renderTool();
    upload(container, pdfFile(await resave(bytes)));
    await screen.findByText("contrato.pdf");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(document.querySelector("[data-template-notice]")).toBeNull();
    expect(screen.getByRole("tab", { name: strings.modeSingle }).getAttribute("aria-selected")).toBe("true");
  }, 30_000);

  it("un PDF desconocido en «Solo yo» no cambia nada; al elegir «Varios firmantes» se mapea y se aplican los campos seguros", async () => {
    mocks.autoMapFile.mockResolvedValue({
      fields: [
        { id: "a", pageIndex: 0, rect: R(0.74, 0.885, 0.065, 0.045), type: "initials", signerIndex: 0, confidence: 0.9, tier: "high", reason: "r", source: "label" },
        { id: "b", pageIndex: 0, rect: R(0.81, 0.885, 0.065, 0.045), type: "initials", signerIndex: 1, confidence: 0.9, tier: "high", reason: "r", source: "label" },
        { id: "c", pageIndex: 1, rect: R(0.1, 0.5, 0.3, 0.05), type: "signature", signerIndex: 0, confidence: 0.5, tier: "review", reason: "Raya de firma sin etiqueta", source: "geometry" },
      ],
      pages: [],
      confidenceSummary: { high: 2, review: 1, ignore: 0, byType: { signature: 1, initials: 2, date: 0, text: 0 }, meanHighConfidence: 0.9, maxPerPage: 3 },
      warnings: [],
    } satisfies AutoMapResult);
    const { container } = renderTool();
    upload(container, pdfFile(await contract("Zulu Unknown")));
    await screen.findByText("contrato.pdf");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(mocks.autoMapFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: strings.modeMulti }));
    await waitFor(() => expect(noticesText()).toContain("Detectamos 2 campos automáticamente"), { timeout: 15_000 });
    expect(noticesText()).toContain("Sugerencias (1)");
    // La sugerencia se acepta desde el panel.
    fireEvent.click(within(notices()).getByRole("button", { name: "Sugerencias (1)" }));
    fireEvent.click(within(notices()).getByRole("button", { name: "Añadir: Firma de Asegurado, página 2" }));
    await waitFor(() => expect(screen.getByText("3 huecos en total")).toBeTruthy());
    expect(noticesText()).not.toContain("Sugerencias (");
  }, 40_000);

  it("«Detectar campos automáticamente» a mano en el paso Documento", async () => {
    const { container } = renderTool();
    upload(container, pdfFile(await contract("Zulu Manual")));
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    await waitFor(() => expect(mocks.autoMapFile).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: `2. ${strings.stepDocument}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Detectar campos automáticamente" }));
    await waitFor(() => expect(mocks.autoMapFile).toHaveBeenCalledTimes(2));
  }, 30_000);
});

describe("traspaso desde «Mis documentos»", () => {
  it("firmar: abre el documento guardado como si se hubiera subido y aplica su plantilla sin buscar por huella", async () => {
    const { saved } = await storeTemplate("Alpha");
    expect(setSignHandoff({ documentIds: [saved.document.id], mode: "sign" })).toBe(true);
    renderTool();
    await waitFor(() => expect(noticesText()).toContain("Plantilla «Mold Test» aplicada"), { timeout: 15_000 });
    expect(screen.getByText(saved.document.fileName)).toBeTruthy();
    // El traspaso se recoge UNA vez (y lo que se restaura de un borrador no recibe plantilla encima).
    cleanup();
    renderTool();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(document.querySelector("[data-template-notice]")).toBeNull();
  }, 40_000);

  it("firmar con un documento que ya no existe: mensaje claro y la herramienta queda vacía", async () => {
    expect(setSignHandoff({ documentIds: ["ya-no-esta"], mode: "sign" })).toBe(true);
    renderTool();
    expect(await screen.findByText("Un documento ya no está en Mis documentos y no se pudo abrir.")).toBeTruthy();
  });

  it("firmar con varios documentos: abre los que existen y avisa de los que no", async () => {
    const one = await storeTemplate("Alpha");
    const bytesTwo = await contract("Beta", 4);
    const savedTwo = await saveTemplateToLibrary({ file: pdfFile(bytesTwo, "beta.pdf"), content: configured(4, "Beta"), documentId: null, template: null });
    if (!savedTwo.ok) throw new Error(savedTwo.reason);
    bases.set(savedTwo.document.id, bytesTwo);
    setSignHandoff({ documentIds: [one.saved.document.id, "fantasma", savedTwo.document.id], mode: "sign" });
    renderTool();
    await waitFor(() => expect(noticesText()).toContain("Mold Test"), { timeout: 15_000 });
    await waitFor(() => expect(document.querySelectorAll("[data-template-notice]").length).toBe(2), { timeout: 15_000 });
    expect(screen.getByText("Un documento ya no está en Mis documentos y no se pudo abrir.")).toBeTruthy();
  }, 40_000);

  it("varios documentos con la plantilla desactualizada: el aviso nombra TODOS, no solo el ultimo", async () => {
    const ids: string[] = [];
    // «alpha.pdf» dos veces (dos documentos distintos con el mismo nombre): el aviso lo nombra una sola vez.
    for (const [label, name] of [["Alpha", "alpha.pdf"], ["Beta", "beta.pdf"], ["Gamma", "gamma.pdf"], ["Delta", "alpha.pdf"]] as const) {
      const bytes = await contract(label, 4);
      const saved = await saveTemplateToLibrary({ file: pdfFile(bytes, name), content: configured(4, label), documentId: null, template: null });
      if (!saved.ok) throw new Error(saved.reason);
      // Se reemplaza el PDF por otro contrato: la plantilla queda desactualizada y el PDF real ya no coincide con ella.
      const other = await contract(`Zulu ${label} Totally Different`, 4);
      await replaceDocumentBytes(saved.document.id, other);
      bases.set(saved.document.id, other);
      ids.push(saved.document.id);
    }
    setSignHandoff({ documentIds: ids, mode: "sign" });
    renderTool();
    const stale = () => [...document.querySelectorAll('[role="status"]')].filter((element) => (element.textContent ?? "").includes("desactualizada"));
    await waitFor(() => expect(stale()).toHaveLength(1), { timeout: 20_000 });
    // Dejan pasar las tres huellas y comprueban el texto final.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const text = stale()[0].textContent!;
    for (const name of ["alpha.pdf", "beta.pdf", "gamma.pdf"]) expect(text).toContain(name);
    expect(text.match(/alpha\.pdf/g)).toHaveLength(1);
    expect(stale()).toHaveLength(1);
  }, 60_000);

  it("configurar: abre el editor con el PDF base y su plantilla", async () => {
    const { saved } = await storeTemplate("Alpha");
    setSignHandoff({ documentIds: [saved.document.id], mode: "configure" });
    renderTool();
    expect(await screen.findByRole("heading", { name: "Configurar plantilla" }, { timeout: 15_000 })).toBeTruthy();
    expect((screen.getByLabelText("Nombre de la plantilla") as HTMLInputElement).value).toBe("Mold Test");
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeTruthy();
    // La herramienta sigue montada pero oculta mientras dura el editor.
    expect((document.querySelector("div[hidden]") as HTMLElement | null)?.querySelector('input[type="file"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Configurar plantilla" })).toBeNull());
  }, 40_000);

  it("configurar con un documento que ya no existe: mensaje y sin editor", async () => {
    setSignHandoff({ documentIds: ["ya-no-esta"], mode: "configure" });
    renderTool();
    expect(await screen.findByText("Un documento ya no está en Mis documentos y no se pudo abrir.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Configurar plantilla" })).toBeNull();
  });

  it("un traspaso caducado o inexistente no hace nada", async () => {
    renderTool();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(screen.queryByRole("heading", { name: "Configurar plantilla" })).toBeNull();
  });
});

describe("entradas al modo «Configurar plantilla»", () => {
  it("desde el botón de la barra con un PDF nuevo: editor vacío con la nota de privacidad", async () => {
    mocks.pickPdfFile.mockResolvedValue(pdfFile(await contract("Gamma"), "gamma.pdf"));
    renderTool();
    fireEvent.click(screen.getByRole("button", { name: "Configurar plantilla" }));
    expect(await screen.findByRole("heading", { name: "Configurar plantilla" }, { timeout: 15_000 })).toBeTruthy();
    expect((screen.getByLabelText("Nombre de la plantilla") as HTMLInputElement).value).toBe("gamma");
    expect(screen.getByText(/Se guarda una copia de este PDF en este navegador; usa contratos en blanco, sin datos de clientes/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Guardar plantilla" })).toBeTruthy();
  }, 30_000);

  it("el botón solo está con la herramienta vacía (con un PDF cargado ya no ocupa la barra: va en el panel de opciones)", async () => {
    const { container } = renderTool();
    expect(screen.getByRole("button", { name: "Configurar plantilla" })).toBeTruthy();
    upload(container, pdfFile(await contract("Delta Idle"), "delta.pdf"));
    await screen.findByText("delta.pdf");
    expect(screen.queryByRole("button", { name: "Configurar plantilla" })).toBeNull();
  });

  it("si no se elige ningún PDF no se abre nada", async () => {
    mocks.pickPdfFile.mockResolvedValue(null);
    renderTool();
    fireEvent.click(screen.getByRole("button", { name: "Configurar plantilla" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.queryByRole("heading", { name: "Configurar plantilla" })).toBeNull();
  });

  it("la herramienta no añade un segundo selector de PDF a la página (el de la zona de carga sigue siendo el único)", () => {
    const { container } = renderTool();
    expect(container.querySelectorAll('input[type="file"][accept*="pdf"]')).toHaveLength(1);
    expect(document.body.querySelectorAll('input[type="file"][accept*="pdf"]')).toHaveLength(1);
  });
});

describe("plantillas antiguas (localStorage)", () => {
  it("al aplicar una plantilla antigua a un PDF se ofrece convertirla en la de este documento, y el editor arranca con lo aplicado", async () => {
    setSignPdfFeatureFlag("autoDetectFields", false);
    expect(
      saveTemplate({
        name: "Vieja",
        pageCount: 5,
        signers: [{ id: "sg-x", name: "Ana", color: "#0d4bff" }],
        fields: [
          { id: "f1", signerId: "sg-x", pageIndex: 0, type: "initials", rect: R(0.74, 0.885, 0.13, 0.045) },
          { id: "f2", signerId: "sg-x", pageIndex: 4, type: "signature", rect: R(0.1, 0.5, 0.3, 0.05) },
        ],
        textFields: [],
      }),
    ).toBe("ok");
    const { container } = renderTool();
    upload(container, pdfFile(await contract("Delta Legacy"), "delta.pdf"));
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    fireEvent.click(await screen.findByRole("button", { name: strings.templatesButton }));
    fireEvent.click(await screen.findByRole("button", { name: strings.templatesApply }));
    const convert = await screen.findByRole("button", { name: "Convertir a plantilla de este documento" });
    expect(screen.getByText("Así se aplicará sola cada vez que cargues este PDF.")).toBeTruthy();
    fireEvent.click(convert);
    expect(await screen.findByRole("heading", { name: "Configurar plantilla" }, { timeout: 15_000 })).toBeTruthy();
    expect((screen.getByLabelText("Nombre de la plantilla") as HTMLInputElement).value).toBe("delta");
    expect(within(document.querySelector("[data-template-editor]") as HTMLElement).getByText(/En este documento: 2 huecos/)).toBeTruthy();
    // El aviso de conversion se va una vez usado.
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Configurar plantilla" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Convertir a plantilla de este documento" })).toBeNull();
  }, 40_000);
});
