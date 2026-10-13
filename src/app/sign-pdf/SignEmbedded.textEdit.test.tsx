import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { SignEmbedded, type SignEmbeddedProps } from "@/app/sign-pdf/SignEmbedded";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { SIGN_EMBEDDED_STRINGS, withEmbeddedWording } from "@/app/sign-pdf/signEmbeddedStrings";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { makeBlock } from "@/app/edit-pdf/editTestUtils";
import { installCanvasStubs } from "@/app/sign-pdf/vaultTestUtils";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetEditPdfFeatureFlagsCacheForTests } from "@/app/edit-pdf/editFeatureFlags";
import { clearVault } from "@/app/sign-pdf/signVault";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { realSignaturePng } from "@/app/pdf-pro/modes/modeTestUtils";
import { pdfjsPageText } from "@/lib/pdf/testing/formFixtures";
import type { TextBlock } from "@/lib/pdf/editTypes";

/**
 * B1 en PDF Pro (Firmar · «Aplicar»): el texto original editado se quita del archivo y lo que paso con cada bloque
 * llega a la tarjeta de «Aplicado» como `notices` (resumen + motivos), y la cabecera del modo pliega la nota del
 * texto editado junto con los avisos del documento. Documentos reales (pdf-lib + el motor de F2); solo pdf.js y el
 * analisis de bloques estan simulados (pagina de 600 x 800 pt, 1 px por punto).
 */

const analysis = vi.hoisted(() => ({ blocks: [] as unknown[] }));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 2,
      getPage: async () => ({
        cleanup: () => {},
        view: [0, 0, 600, 800],
        rotate: 0,
        getViewport: () => ({ width: 600, height: 800 }),
      }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});
vi.mock("@/lib/pdf/textBlocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/textBlocks")>();
  return {
    ...actual,
    analyzeDocPageText: vi.fn(async (_doc: unknown, pageIndex: number) => ({
      blocks: (analysis.blocks as TextBlock[]).filter((block) => block.pageIndex === pageIndex),
      hasTextLayer: true,
      failed: false,
      hiddenCount: 0,
    })),
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

const strings = SIGN_STRINGS.es;
const e = SIGN_EMBEDDED_STRINGS.es;
const wording = withEmbeddedWording("es");
const flow = EDIT_FLOW_STRINGS.es;
const inline = EDIT_STRINGS.es.inline;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
});

let restoreCanvas = () => {};
beforeEach(async () => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetEditPdfFeatureFlagsCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  restoreCanvas = installCanvasStubs(realSignaturePng());
  await clearVault();
});
afterEach(() => restoreCanvas());

/* ------------------------------------------------------------------ *
 * PDF reales (pagina 600 x 800)
 * ------------------------------------------------------------------ */

/** «Contrato» a 16 pt en (50, 740): un texto que F2 SI puede quitar. */
async function plainFile(): Promise<File> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index += 1) {
    doc.addPage([600, 800]).drawText("Contrato", { x: 50, y: 740, size: 16, font });
  }
  return new File([(await doc.save()) as BlobPart], "contrato.pdf", { type: "application/pdf" });
}

/** El mismo texto dentro de un Form XObject que comparten las dos paginas: F2 no lo puede quitar. */
async function sharedFile(): Promise<File> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const xobject = doc.context.register(
    doc.context.stream("BT /F1 16 Tf 0 0 Td (Contrato) Tj ET", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, -10, 300, 30],
      Matrix: [1, 0, 0, 1, 50, 740],
      Resources: { Font: { F1: font.ref } },
    }),
  );
  for (let index = 0; index < 2; index += 1) {
    const page = doc.addPage([600, 800]);
    page.node.setXObject(PDFName.of("Fx"), xobject);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q /Fx Do Q")));
  }
  return new File([(await doc.save()) as BlobPart], "compartido.pdf", { type: "application/pdf" });
}

const BLOCK = makeBlock("p0-b0", { text: "Contrato", box: { x: 49, y: 737, width: 80, height: 20 }, fontSize: 16 });

type Applied = { bytes: Uint8Array; label: string; opts?: { warnings?: unknown; notices?: string[] } };

function setup(file: File, overrides: Partial<SignEmbeddedProps> = {}) {
  const applied: Applied[] = [];
  const onApply = vi.fn(async (bytes: Uint8Array, label: string, opts?: Applied["opts"]) => {
    applied.push({ bytes, label, opts });
  });
  const view = render(
    <LanguageProvider>
      <SignEmbedded file={file} lang="es" onApply={onApply} onCancel={vi.fn()} onDirtyChange={vi.fn()} {...overrides} />
    </LanguageProvider>,
  );
  return { ...view, applied, onApply };
}

const palette = () => screen.getByRole("toolbar", { name: strings.paletteLabel });
const block = () =>
  document.querySelector<HTMLElement>('[data-block-layer] [data-element-id="p0-b0"][data-drag-mode="move"]')!;

/** Activa «Editar texto» y cambia el titulo por `next`. */
async function editTitle(next: string) {
  await screen.findByRole("toolbar", { name: strings.paletteLabel });
  fireEvent.click(within(palette()).getByRole("button", { name: strings.toolEditText }));
  await waitFor(() => expect(block()).toBeTruthy());
  fireEvent.keyDown(block(), { key: "Enter" });
  const editor = await screen.findByRole("textbox", { name: inline.editorLabel });
  editor.textContent = next;
  fireEvent.input(editor);
  fireEvent.keyDown(editor, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: inline.editorLabel })).toBeNull());
  fireEvent.click(within(palette()).getByRole("button", { name: strings.toolSelect }));
}

const applyButton = () => screen.getByRole("button", { name: e.apply }) as HTMLButtonElement;

describe("Firmar en PDF Pro con texto editado", () => {
  it("el original se quita y la tarjeta de «Aplicado» recibe el resumen: «N textos editados: el original se elimino del archivo»", async () => {
    analysis.blocks = [BLOCK];
    const file = await plainFile();
    const { applied } = setup(file);
    await editTitle("Acuerdo");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].label).toBe(e.labelEdited);
    expect(applied[0].opts?.notices).toEqual(["1 texto editado: el original se eliminó del archivo."]);
    // El motor de F2 lo quito de verdad: el original ya no se extrae y el nuevo si.
    const text = await pdfjsPageText(applied[0].bytes, 1);
    expect(text).toContain("Acuerdo");
    expect(text).not.toContain("Contrato");
    expect(await pdfjsPageText(applied[0].bytes, 2)).toContain("Contrato");
  });

  it("si el original NO se puede quitar: resumen, el bloque con su motivo y la salida de PDF Pro (pestaña Editar)", async () => {
    analysis.blocks = [BLOCK];
    const file = await sharedFile();
    const { applied } = setup(file);
    await editTitle("Acuerdo");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    const notices = applied[0].opts?.notices ?? [];
    expect(notices[0]).toBe("1 texto editado: no se pudo quitar el original (más abajo, por qué).");
    expect(notices[1]).toBe(
      `Página 1, «Acuerdo»: el original sigue bajo la edición. ${flow.remainsReason("shared-xobject")}`,
    );
    expect(notices[2]).toBe(wording.editRemainsAdvice(flow.flattenAction));
    expect(notices[2]).toContain("pestaña Editar de PDF Pro");
    expect(notices[2]).not.toContain("archivo descargado");
    expect(notices).toHaveLength(3);
  });

  it("sin texto editado, `onApply` NO lleva avisos propios del texto (la tarjeta es la de siempre)", async () => {
    analysis.blocks = [BLOCK];
    const file = await plainFile();
    const { applied } = setup(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(within(palette()).getByRole("button", { name: strings.fieldTypeText }));
    fireEvent.click(await screen.findByRole("button", { name: strings.addTextFieldHere }));
    const input = await screen.findByRole("textbox", { name: strings.textFieldFallbackLabel(1) });
    fireEvent.change(input, { target: { value: "Ana" } });
    fireEvent.blur(input);
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].opts).toBeUndefined();
  });
});

describe("Firmar en PDF Pro: la cabecera pliega los avisos con la nota del texto editado", () => {
  it("con texto editado y SIN avisos del documento: una sola linea con la nota (icono neutro) y el texto completo", async () => {
    analysis.blocks = [BLOCK];
    const file = await plainFile();
    setup(file);
    expect(document.querySelector('[data-warning="editedText"]')).toBeNull();
    await editTitle("Acuerdo");
    const item = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-pro-mode-warnings] [data-warning="editedText"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(item.textContent).toContain(e.editedTextShort);
    // La nota completa (la de PDF Pro: «pestana Editar») queda para lectores de pantalla y el `title`.
    expect(item.getAttribute("title")).toBe(wording.editTextNote);
    expect(item.getAttribute("title")).toMatch(/pestaña Editar/);
    expect(document.querySelector("[data-notice-fold]")).toBeNull();
  });

  it("con firma digital + copia sin contraseña + texto editado: «3 avisos» plegado y, al expandir, el texto completo de los tres", async () => {
    analysis.blocks = [BLOCK];
    const file = await plainFile();
    setup(file, { facts: { signatures: "active", encrypted: true } });
    await editTitle("Acuerdo");
    const fold = await screen.findByRole("button", { name: e.warningsCount(3) });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll("[data-pro-mode-warnings] li")).toHaveLength(3);
    // Plegado, el panel solo es para lectores de pantalla; expandido, se ve.
    const panel = document.querySelector<HTMLElement>("[data-notice-fold-panel]")!;
    expect(panel.className).toContain("sr-only");
    fireEvent.click(fold);
    expect(panel.className).not.toContain("sr-only");
    expect(panel.textContent).toContain(wording.editTextNote);
    expect(panel.textContent).toContain("firmas digitales");
    expect(panel.textContent).toContain("contraseña");
  });

  it("el panel de «Editar texto» del lienzo compacto no repite la nota", async () => {
    analysis.blocks = [BLOCK];
    const file = await plainFile();
    setup(file);
    await editTitle("Acuerdo");
    const panel = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-edit-text-panel]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(panel.textContent).not.toContain(wording.editTextNote);
    expect(panel.textContent).not.toContain(strings.editTextNote);
  });
});
