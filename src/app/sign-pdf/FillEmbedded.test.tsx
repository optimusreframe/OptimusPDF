import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { FillEmbedded, type FillEmbeddedProps } from "@/app/sign-pdf/FillEmbedded";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { FILL_EMBEDDED_STRINGS, withFillWording } from "@/app/sign-pdf/fillEmbeddedStrings";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { listDrafts } from "@/app/sign-pdf/signDrafts";
import { ProModeHostContext, ProModeApplyError, type ProModeControls, type ProModeHostValue } from "@/app/pdf-pro/modes/modeContext";
import { __resetValueHistoryCacheForTests, bestMatchForKey } from "@/lib/valueHistory";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { detectAcroFormFields, detectFields, type DetectedField } from "@/lib/pdf/detectFields";
import { loadPdf } from "@/lib/pdf/core";
import { normalizeFieldLabel } from "@/lib/pdf/sign";
import {
  hasPoppler,
  makeFormPdf,
  makePlainPdf,
  pdfjsFieldObjects,
  pdfjsPageText,
  popplerText,
} from "@/lib/pdf/testing/formFixtures";
import { contractFile, formFile, toFile } from "@/app/pdf-pro/modes/modeTestUtils";

/** Sin pdf.js: una pagina simulada de 600 x 800. La deteccion de campos reales SI es la de verdad (pdf-lib). */
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

const strings = withFillWording("es");
const e = FILL_EMBEDDED_STRINGS.es;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

beforeEach(() => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockImplementation(async (file: File) => detectAcroFormFields(await loadPdf(file)));
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => vi.restoreAllMocks());

type Applied = { bytes: Uint8Array; label: string; warnings?: unknown };

function setup(overrides: Partial<FillEmbeddedProps> & { file: File }) {
  const applied: Applied[] = [];
  const onApply = vi.fn(async (bytes: Uint8Array, label: string, opts?: { warnings?: unknown }) => {
    applied.push({ bytes, label, warnings: opts?.warnings });
  });
  const onCancel = vi.fn();
  const onDirtyChange = vi.fn();
  const props: FillEmbeddedProps = { lang: "es", onApply, onCancel, onDirtyChange, ...overrides };
  const view = render(
    <LanguageProvider>
      <FillEmbedded {...props} />
    </LanguageProvider>,
  );
  return { ...view, applied, onApply, onCancel, onDirtyChange, props };
}

const applyButton = () => screen.getByRole("button", { name: e.apply }) as HTMLButtonElement;
const tool = (name: string) =>
  within(screen.getByRole("toolbar", { name: strings.paletteLabel })).getByRole("button", { name });

/** Espera a haber leido el formulario y a que la deteccion haya puesto los campos sobre la pagina. */
async function ready(fields = 5) {
  await screen.findByText(e.formFound(fields));
  await screen.findByRole("toolbar", { name: strings.paletteLabel });
}

const fieldGroup = (label: string) =>
  screen.getByRole("group", { name: new RegExp(`^${label}, (${strings.a11yPending}|${strings.a11yFilled})$`) });

async function typeInto(label: string, value: string) {
  const group = await waitFor(() => fieldGroup(label));
  fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(group, { pointerId: 1 });
  const input = await screen.findByRole("textbox", { name: label });
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

async function tapCheckbox(label: string) {
  const group = await waitFor(() => fieldGroup(label));
  fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(group, { pointerId: 1 });
}

describe("FillEmbedded: lectura del formulario", () => {
  it("lee los 5 campos reales y los dice (estado role=status)", async () => {
    const { file } = await formFile();
    setup({ file });
    await ready(5);
    expect(document.querySelector("[data-fill-form-status]")?.getAttribute("role")).toBe("status");
  });

  it("los campos de texto y la casilla estan SOBRE la pagina; el desplegable, en el panel de opciones", async () => {
    const { file } = await formFile();
    setup({ file });
    await ready();
    await waitFor(() => expect(fieldGroup("nombre")).toBeTruthy());
    expect(fieldGroup("apellido")).toBeTruthy();
    expect(fieldGroup("notas")).toBeTruthy();
    expect(fieldGroup("acepto")).toBeTruthy();
    const choices = document.querySelector("[data-fill-choices]")!;
    expect(within(choices as HTMLElement).getByLabelText(/^pais/)).toBeTruthy();
  });

  it("un PDF sin formulario lo dice, no ofrece aplanar ni panel de opciones y no deja aplicar", async () => {
    const bytes = await makePlainPdf(2);
    const file = toFile(bytes);
    setup({ file });
    await screen.findByText(e.noForm);
    expect(document.querySelector("[data-fill-flatten]")).toBeNull();
    expect(document.querySelector("[data-fill-choices]")).toBeNull();
    expect(applyButton().disabled).toBe(true);
  });

  it("un PDF cuyo formulario no se puede leer avisa de que solo se puede escribir encima", async () => {
    const file = toFile(new Uint8Array([1, 2, 3, 4]), "roto.pdf");
    setup({ file });
    await screen.findByText(e.formUnreadable);
  });

  it("mientras se leen los campos lo dice", async () => {
    const { file } = await formFile();
    setup({ file });
    expect(screen.getByText(e.loadingForm)).toBeTruthy();
    await ready();
  });

  it("los textos del lienzo hablan de rellenar, no de firmar", async () => {
    const { file } = await formFile();
    setup({ file });
    await ready();
    expect(screen.getByText(strings.documentTitle)).toBeTruthy();
    expect(screen.queryByText(SIGN_STRINGS.es.documentTitle)).toBeNull();
    expect(document.body.textContent).not.toMatch(/antes de firmar/);
  });

  it("no hay paleta de firma: sin firmantes el lienzo solo ofrece texto, casilla y fecha", async () => {
    const { file } = await formFile();
    setup({ file });
    await ready();
    expect(screen.queryByRole("button", { name: strings.fieldSignature })).toBeNull();
    expect(tool(strings.fieldTypeText)).toBeTruthy();
  });

  it("los campos de solo lectura no se ofrecen en el lienzo", async () => {
    const bytes = await makeFormPdf({ textFields: ["editable"], readOnlyText: true });
    setup({ file: toFile(bytes) });
    await screen.findByText(e.formFound(2));
    await waitFor(() => expect(fieldGroup("editable")).toBeTruthy());
    expect(screen.queryByRole("group", { name: /^fijo, / })).toBeNull();
  });

  it("los valores que ya trae el PDF aparecen rellenados y no cuentan como cambios", async () => {
    const bytes = await makeFormPdf({ textFields: ["nombre"], initialText: "Marta", checkbox: true, checkboxChecked: true });
    const { onDirtyChange } = setup({ file: toFile(bytes) });
    await screen.findByText(e.formFound(2));
    await waitFor(() => expect(fieldGroup("nombre")).toBeTruthy());
    expect(within(fieldGroup("nombre")).getByText("Marta")).toBeTruthy();
    expect(applyButton().disabled).toBe(true);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });
});

describe("FillEmbedded: aplicar escribe los campos REALES", () => {
  it("un campo de texto: /V con acentos, snapshot «Formulario rellenado (1 campo)» y sigue siendo campo", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file });
    await ready();
    await typeInto("nombre", "Ñandú José");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].label).toBe("Formulario rellenado (1 campo)");
    const objects = await pdfjsFieldObjects(applied[0].bytes);
    expect(objects.nombre[0].value).toBe("Ñandú José");
    expect((await PDFDocument.load(applied[0].bytes)).getForm().getFields()).toHaveLength(5);
  });

  it("texto, casilla y desplegable a la vez: «(3 campos)» y los tres valores en el PDF (pdf.js)", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file });
    await ready();
    await typeInto("apellido", "Pérez");
    await tapCheckbox("acepto");
    const choices = document.querySelector("[data-fill-choices]") as HTMLElement;
    fireEvent.change(within(choices).getByLabelText(/^pais/), { target: { value: "México" } });
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].label).toBe("Formulario rellenado (3 campos)");
    const objects = await pdfjsFieldObjects(applied[0].bytes);
    expect(objects.apellido[0].value).toBe("Pérez");
    expect(objects.acepto[0].value).not.toBe("Off");
    expect(objects.pais[0].value).toBe("México");
  });

  it.skipIf(!hasPoppler())("poppler ve el texto escrito en los campos (apariencia generada)", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file });
    await ready();
    await typeInto("nombre", "Visible en poppler");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(popplerText(applied[0].bytes)).toContain("Visible en poppler");
  });

  it("radios y lista de opciones se eligen en el panel y se escriben", async () => {
    const bytes = await makeFormPdf({ textFields: [], radio: true, list: true, multiList: true });
    const { applied } = setup({ file: toFile(bytes) });
    await screen.findByText(e.formFound(2));
    const choices = await waitFor(() => {
      const node = document.querySelector("[data-fill-choices]") as HTMLElement | null;
      if (!node) throw new Error("sin panel");
      return node;
    });
    fireEvent.click(within(choices).getByRole("radio", { name: "F" }));
    const list = within(choices).getByLabelText(/^idiomas/) as HTMLSelectElement;
    for (const option of Array.from(list.options)) option.selected = option.value === "es" || option.value === "fr";
    fireEvent.change(list);
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    const document2 = await PDFDocument.load(applied[0].bytes);
    expect((document2.getForm().getRadioGroup("sexo") as unknown as { getSelected(): string }).getSelected()).toBe("F");
    expect(
      (document2.getForm().getOptionList("idiomas") as unknown as { getSelected(): string[] }).getSelected(),
    ).toEqual(["es", "fr"]);
    expect(applied[0].label).toBe("Formulario rellenado (2 campos)");
  });

  it("vaciar un campo que traia valor lo deja vacio en el PDF", async () => {
    const bytes = await makeFormPdf({ textFields: ["nombre"], initialText: "Borrar" });
    const { applied } = setup({ file: toFile(bytes) });
    await screen.findByText(e.formFound(1));
    await typeInto("nombre", "");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect((await pdfjsFieldObjects(applied[0].bytes)).nombre[0].value).toBe("");
  });

  it("un campo que no se toco conserva su apariencia original", async () => {
    const bytes = await makeFormPdf({ textFields: ["a", "b"], initialText: "intacto" });
    const { applied } = setup({ file: toFile(bytes) });
    await screen.findByText(e.formFound(2));
    await typeInto("b", "nuevo");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    const objects = await pdfjsFieldObjects(applied[0].bytes);
    expect(objects.a[0].value).toBe("intacto");
    expect(objects.b[0].value).toBe("nuevo");
  });

  it("aplanar: los campos pasan a ser contenido (sin campos y con el texto en la pagina)", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file });
    await ready();
    await typeInto("nombre", "Aplanado");
    fireEvent.click(document.querySelector("[data-fill-flatten]")!);
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect((await PDFDocument.load(applied[0].bytes)).getForm().getFields()).toHaveLength(0);
    expect(await pdfjsPageText(applied[0].bytes, 1)).toContain("Aplanado");
    expect(applied[0].label).toBe("Formulario rellenado (1 campo)");
  });

  it("aplanar sin rellenar nada tambien se puede aplicar, con su propia etiqueta", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file });
    await ready();
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(document.querySelector("[data-fill-flatten]")!);
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].label).toBe(e.labelFlattened);
    expect((await PDFDocument.load(applied[0].bytes)).getForm().getFields()).toHaveLength(0);
  });
});

describe("FillEmbedded: texto que se dibuja", () => {
  it("texto libre sobre el documento (herramienta Texto) se DIBUJA en la pagina y no toca los campos", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file });
    await ready();
    fireEvent.click(tool(strings.fieldTypeText));
    fireEvent.click(await screen.findByRole("button", { name: strings.addTextFieldHere }));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Nota libre" } });
    fireEvent.blur(input);
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(await pdfjsPageText(applied[0].bytes, 1)).toContain("Nota libre");
    const objects = await pdfjsFieldObjects(applied[0].bytes);
    expect(Object.keys(objects).sort()).toEqual(["acepto", "apellido", "nombre", "notas", "pais"]);
  });

  it("un hueco sugerido con valor se dibuja (documento sin formulario)", async () => {
    const suggestion: DetectedField = {
      id: "vec-1",
      pageIndex: 0,
      rect: { x: 0.2, y: 0.4, width: 0.4, height: 0.04 },
      label: "Ciudad",
      source: "heuristic-vector",
      confidence: "medium",
    };
    vi.mocked(detectFields).mockResolvedValue([suggestion]);
    const file = toFile(await makePlainPdf(2));
    const { applied } = setup({ file });
    await screen.findByText(e.noForm);
    await typeInto("Ciudad", "Valencia");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].label).toBe("Formulario rellenado (1 campo)");
    expect(await pdfjsPageText(applied[0].bytes, 1)).toContain("Valencia");
  });

  it("una sugerencia sin tocar no se aplica", async () => {
    const suggestion: DetectedField = {
      id: "vec-1",
      pageIndex: 0,
      rect: { x: 0.2, y: 0.4, width: 0.4, height: 0.04 },
      label: "Ciudad",
      source: "heuristic-vector",
      confidence: "medium",
    };
    vi.mocked(detectFields).mockResolvedValue([suggestion]);
    setup({ file: toFile(await makePlainPdf(1)) });
    await screen.findByText(e.noForm);
    expect(applyButton().disabled).toBe(true);
  });
});

describe("FillEmbedded: orden de escritura", () => {
  it("primero se escriben (y aplanan) los campos y DESPUES se dibuja el texto libre: el texto queda encima", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file });
    await ready();
    await typeInto("nombre", "CAMPO");
    fireEvent.click(tool(strings.fieldTypeText));
    fireEvent.click(await screen.findByRole("button", { name: strings.addTextFieldHere }));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "ENCIMA" } });
    fireEvent.blur(input);
    fireEvent.click(document.querySelector("[data-fill-flatten]")!);
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    const text = await pdfjsPageText(applied[0].bytes, 1);
    expect(text).toContain("CAMPO");
    expect(text).toContain("ENCIMA");
    // pdf.js lista el texto en el orden en que se pinta: el dibujado va despues del campo aplanado.
    expect(text.indexOf("CAMPO")).toBeLessThan(text.indexOf("ENCIMA"));
    expect(applied[0].label).toBe("Formulario rellenado (2 campos)");
  });
});

describe("FillEmbedded: avisos previos", () => {
  it("avisa de los caracteres que la tipografia estandar no puede pintar (y /V los conserva)", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file });
    await ready();
    await typeInto("nombre", "OK ✓");
    const note = await waitFor(() => {
      const node = document.querySelector("[data-fill-unsupported]");
      if (!node) throw new Error("sin aviso");
      return node;
    });
    expect(note.textContent).toContain("✓");
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect((await pdfjsFieldObjects(applied[0].bytes)).nombre[0].value).toBe("OK ✓");
  });

  it("avisa de que un valor se recortara al maximo del campo", async () => {
    const bytes = await makeFormPdf({ textFields: ["corto"], maxLengthText: 4 });
    const { applied } = setup({ file: toFile(bytes) });
    await screen.findByText(e.formFound(1));
    await typeInto("corto", "abcdefgh");
    await waitFor(() => expect(document.querySelector("[data-fill-truncated]")?.textContent).toBe(e.willTruncate(1)));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect((await pdfjsFieldObjects(applied[0].bytes)).corto[0].value).toBe("abcd");
  });

  it("firmas digitales activas y copia descifrada: avisos visibles y en warnings", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file, facts: { signatures: "active", encrypted: true } });
    await ready();
    const group = document.querySelector("[data-pro-mode-warnings]")!;
    expect(group.textContent).toContain("firmas digitales");
    expect(group.textContent).toContain("sin contraseña");
    await typeInto("nombre", "x");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].warnings).toEqual([{ code: "signaturesInvalidated" }, { code: "decryptedCopy" }]);
  });

  it("dice que la sesion no se guarda como borrador y no escribe ninguno", async () => {
    const { file } = await formFile();
    setup({ file });
    await ready();
    expect(screen.getByText(e.sessionNote)).toBeTruthy();
    await typeInto("nombre", "Ana");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await listDrafts()).toEqual([]);
  });
});

describe("FillEmbedded: sesion, errores y anfitrion", () => {
  it("onDirtyChange: sube con el primer valor, baja al desmontar", async () => {
    const { file } = await formFile();
    const { onDirtyChange, unmount } = setup({ file });
    await ready();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await typeInto("nombre", "Ana");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("'Descartar' llama a onCancel sin aplicar", async () => {
    const { file } = await formFile();
    const { onCancel, onApply } = setup({ file });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: e.discard }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("si onApply rechaza, la sesion sigue y se avisa con role=alert", async () => {
    const { file } = await formFile();
    const onApply = vi.fn(async () => Promise.reject(new Error("fallo")));
    setup({ file, onApply });
    await ready();
    await typeInto("nombre", "Ana");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    expect((await screen.findByRole("alert")).textContent).toContain(e.applyFailed);
    expect(applyButton().disabled).toBe(false);
  });

  it("otro snapshot con trabajo sin aplicar descarta lo rellenado y avisa", async () => {
    const first = await formFile();
    const second = await formFile();
    const { rerender } = setup({ file: first.file, bytes: first.bytes });
    await ready();
    await typeInto("nombre", "Ana");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    rerender(
      <LanguageProvider>
        <FillEmbedded file={second.file} bytes={second.bytes} lang="es" onApply={async () => {}} onCancel={() => {}} />
      </LanguageProvider>,
    );
    expect(await screen.findByText(e.sessionReset)).toBeTruthy();
    await ready();
    expect(applyButton().disabled).toBe(true);
  });

  it("carrera: si el documento cambia MIENTRAS se escribe el formulario, el resultado se descarta", async () => {
    const first = await formFile();
    const second = await formFile();
    const onApply = vi.fn(async () => {});
    const { rerender } = setup({ file: first.file, bytes: first.bytes, onApply });
    await ready();
    await typeInto("nombre", "Ana");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    rerender(
      <LanguageProvider>
        <FillEmbedded file={second.file} bytes={second.bytes} lang="es" onApply={onApply} onCancel={() => {}} />
      </LanguageProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("se acuerda de lo escrito para reutilizarlo (historial de valores por etiqueta, como Firmar)", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file });
    await ready();
    await typeInto("nombre", "Ana Reutilizable");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(bestMatchForKey(normalizeFieldLabel("nombre"))).toBe("Ana Reutilizable");
  });

  it("no recuerda casillas ni opciones (solo texto con etiqueta)", async () => {
    const { file } = await formFile();
    const { applied } = setup({ file });
    await ready();
    await tapCheckbox("acepto");
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(bestMatchForKey(normalizeFieldLabel("acepto"))).toBeFalsy();
  });

  it("un PDF roto no se puede rellenar: error claro y nada aplicado", async () => {
    const roto = toFile(new Uint8Array([9, 9, 9, 9]), "roto.pdf");
    const { onApply } = setup({ file: roto });
    await screen.findByText(e.formUnreadable);
    fireEvent.click(tool(strings.fieldTypeText));
    fireEvent.click(await screen.findByRole("button", { name: strings.addTextFieldHere }));
    const input = await screen.findByRole("textbox", { name: strings.textFieldFallbackLabel(1) });
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.blur(input);
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    expect((await screen.findByRole("alert")).textContent).toContain(e.applyFailed);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("en ingles: etiqueta del snapshot y textos en ingles", async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    const { file } = await formFile();
    const en = FILL_EMBEDDED_STRINGS.en;
    const enStrings = withFillWording("en");
    const { applied } = setup({ file, lang: "en" });
    await screen.findByText(en.formFound(5));
    const group = await waitFor(() => screen.getByRole("group", { name: /^nombre, / }));
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(group, { pointerId: 1 });
    const input = await screen.findByRole("textbox", { name: "nombre" });
    fireEvent.change(input, { target: { value: "Ana" } });
    fireEvent.blur(input);
    expect(screen.getByText(enStrings.documentTitle)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: en.apply }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: en.apply }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].label).toBe("Form filled in (1 field)");
  });
});

function hostValue(overrides: Partial<ProModeHostValue> = {}): ProModeHostValue & { controls: ProModeControls | null } {
  const value = {
    tab: "sign",
    initialPage: 0,
    reportPage: vi.fn(),
    registerControls: vi.fn((controls: ProModeControls | null) => {
      value.controls = controls;
    }),
    intent: null,
    busy: false,
    controls: null as ProModeControls | null,
    ...overrides,
  };
  return value;
}

describe("FillEmbedded: con el anfitrion de modos", () => {
  function hosted(host: ReturnType<typeof hostValue>, file: File) {
    const applied: Applied[] = [];
    const onApply = vi.fn(async (bytes: Uint8Array, label: string) => {
      applied.push({ bytes, label });
    });
    const view = render(
      <LanguageProvider>
        <ProModeHostContext.Provider value={host}>
          <FillEmbedded file={file} lang="es" onApply={onApply} onCancel={() => {}} onDirtyChange={() => {}} />
        </ProModeHostContext.Provider>
      </LanguageProvider>,
    );
    return { ...view, applied, onApply };
  }

  it("registra su 'aplicar' y no pinta botones propios", async () => {
    const host = hostValue();
    const { file } = await formFile();
    hosted(host, file);
    await ready();
    expect(host.controls).not.toBeNull();
    expect(screen.queryByRole("button", { name: e.apply })).toBeNull();
    expect(screen.queryByRole("button", { name: e.discard })).toBeNull();
  });

  it("'apply' sin nada rellenado rechaza con ProModeApplyError", async () => {
    const host = hostValue();
    const { file } = await formFile();
    hosted(host, file);
    await ready();
    await expect(host.controls!.apply()).rejects.toMatchObject({ userMessage: e.notReady });
    await expect(host.controls!.apply()).rejects.toBeInstanceOf(ProModeApplyError);
  });

  it("'apply' con un campo rellenado escribe el formulario y llama a onApply una vez", async () => {
    const host = hostValue();
    const { file } = await formFile();
    const { applied, onApply } = hosted(host, file);
    await ready();
    await typeInto("nombre", "Con anfitrion");
    await screen.findByText(e.ready);
    let result: boolean | undefined;
    await act(async () => {
      result = await host.controls!.apply();
    });
    expect(result).toBe(true);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect((await pdfjsFieldObjects(applied[0].bytes)).nombre[0].value).toBe("Con anfitrion");
  });

  it("'Cancelar' del anfitrion mientras se aplica descarta el resultado: sin onApply y 'apply' devuelve false", async () => {
    const host = hostValue();
    const { file } = await formFile();
    const { onApply } = hosted(host, file);
    await ready();
    await typeInto("nombre", "Cancelable");
    await screen.findByText(e.ready);
    let result: boolean | undefined;
    await act(async () => {
      const pending = host.controls!.apply();
      host.controls!.cancel!();
      result = await pending;
    });
    expect(result).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("arranca en la pagina del visor y la informa", async () => {
    const host = hostValue({ initialPage: 1 });
    const { file } = await formFile();
    hosted(host, file);
    await ready();
    await waitFor(() => expect(host.reportPage).toHaveBeenCalledWith(1));
  });

  it("con el anfitrion ocupado el contenido queda inerte", async () => {
    const host = hostValue({ busy: true });
    const { file } = await formFile();
    const { container } = hosted(host, file);
    await ready();
    expect(container.querySelector("[data-pro-mode-scroll]")?.hasAttribute("inert")).toBe(true);
  });
});

describe("FillEmbedded: campos en otras paginas y accesibilidad", () => {
  it("el panel de opciones dice en que pagina esta cada campo", async () => {
    const bytes = await makeFormPdf({ pages: 2, textFields: [], dropdown: true });
    setup({ file: toFile(bytes) });
    await screen.findByText(e.formFound(1));
    const choices = await waitFor(() => {
      const node = document.querySelector("[data-fill-choices]") as HTMLElement | null;
      if (!node) throw new Error("sin panel");
      return node;
    });
    expect(within(choices).getByText(new RegExp(e.choicePage(1)))).toBeTruthy();
  });

  it("el panel de opciones tiene titulo y cada control su etiqueta", async () => {
    const bytes = await makeFormPdf({ textFields: [], dropdown: true, radio: true });
    setup({ file: toFile(bytes) });
    await screen.findByText(e.formFound(2));
    const panel = await waitFor(() => screen.getByRole("region", { name: e.choicesTitle }));
    expect(within(panel).getByRole("group", { name: /sexo/ })).toBeTruthy();
    expect(within(panel).getByRole("combobox", { name: /pais/ })).toBeTruthy();
  });

  it("la casilla de aplanar tiene etiqueta accesible y descripcion", async () => {
    const { file } = await formFile();
    setup({ file });
    await ready();
    const checkbox = screen.getByRole("checkbox", { name: new RegExp(e.flattenLabel) });
    expect(checkbox).toBeTruthy();
    expect(screen.getByText(e.flattenHint)).toBeTruthy();
  });

  it("la region del modo lleva su nombre accesible", async () => {
    const { file } = await formFile();
    setup({ file });
    await ready();
    expect(screen.getByRole("region", { name: e.regionLabel })).toBeTruthy();
  });
});

describe("FillEmbedded: contrato sin formulario con la herramienta Texto", () => {
  it("un contrato de 3 paginas se puede rellenar escribiendo encima y se aplica", async () => {
    const { file } = await contractFile(3);
    const { applied } = setup({ file });
    await screen.findByText(e.noForm);
    fireEvent.click(tool(strings.fieldTypeText));
    fireEvent.click(await screen.findByRole("button", { name: strings.addTextFieldHere }));
    const input = await screen.findByRole("textbox", { name: strings.textFieldFallbackLabel(1) });
    fireEvent.change(input, { target: { value: "Firmado en Madrid" } });
    fireEvent.blur(input);
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(await pdfjsPageText(applied[0].bytes, 1)).toContain("Firmado en Madrid");
    expect((await PDFDocument.load(applied[0].bytes)).getPageCount()).toBe(3);
  });
});
