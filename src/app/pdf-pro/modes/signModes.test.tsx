import "fake-indexeddb/auto";
import { useEffect, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import "@/app/pdf-pro/modes/signModes";
import { SIGN_MODE_DEFINITIONS } from "@/app/pdf-pro/modes/signModes";
import { ProModeHost, ProModeResult, ProModeSheets } from "@/app/pdf-pro/modes/ProModeHost";
import { getProMode, listProModes, registerProMode } from "@/app/pdf-pro/modes/proModes";
import { useProModeSession } from "@/app/pdf-pro/modes/useProModeSession";
import { createProWorkingDoc, type ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import { ProWorkingDocProvider } from "@/app/pdf-pro/useProWorkingDoc";
import type { ProTabId } from "@/app/pdf-pro/ProTabs";
import type { ProSignatureState } from "@/app/pdf-pro/proTypes";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { SIGN_EMBEDDED_STRINGS } from "@/app/sign-pdf/signEmbeddedStrings";
import { FILL_EMBEDDED_STRINGS } from "@/app/sign-pdf/fillEmbeddedStrings";
import { installCanvasStubs } from "@/app/sign-pdf/vaultTestUtils";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { clearVault } from "@/app/sign-pdf/signVault";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { detectAcroFormFields, detectFields } from "@/lib/pdf/detectFields";
import { loadPdf } from "@/lib/pdf/core";
import { pdfjsFieldObjects, pdfjsPageText } from "@/lib/pdf/testing/formFixtures";
import { contractFile, formFile, pageImageCount, realSignaturePng } from "@/app/pdf-pro/modes/modeTestUtils";
import { getModeStrings } from "@/app/pdf-pro/modes/modeStrings";

/**
 * Los modos Firmar y Rellenar con el ANFITRION REAL de U6 (`useProModeSession` + `ProModeHost`) y un documento
 * de trabajo real: un «Aplicar» = UN snapshot, deshacer global, confirmaciones y avisos.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({ numPages: 3, getPage: async () => ({ cleanup: () => {} }) }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

const strings = SIGN_STRINGS.es;
const sign = SIGN_EMBEDDED_STRINGS.es;
const fill = FILL_EMBEDDED_STRINGS.es;
const host = getModeStrings("es").host;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

let restoreCanvas = () => {};
beforeEach(async () => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockImplementation(async (file: File) => detectAcroFormFields(await loadPdf(file)));
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  restoreCanvas = installCanvasStubs(realSignaturePng());
  await clearVault();
});
afterEach(() => restoreCanvas());

async function openDoc(file: File, signatures: ProSignatureState = "none"): Promise<ProWorkingDoc> {
  const doc = createProWorkingDoc({ inspectSignatures: async () => signatures, language: "es" });
  const result = await doc.open(file);
  if (!result.ok) throw new Error("no se pudo abrir");
  return doc;
}

/** La pestana propia de Rellenar (`fill`) aun no existe en la barra de PDF Pro: el modo se registra para ella igualmente. */
const FILL_TAB = "fill" as unknown as ProTabId;

function Suite({ initialTab = "sign" as ProTabId }: { initialTab?: ProTabId }) {
  const [tab, setTab] = useState<ProTabId>(initialTab);
  const session = useProModeSession({
    tab,
    setTab,
    language: "es",
    focusTab: () => {},
    getViewerPage: () => 0,
    restoreViewerPage: () => {},
  });
  return (
    <div>
      <p data-testid="tab">{tab}</p>
      <div role="tablist" data-pro-region="tabs">
        <button role="tab" aria-selected={tab === "home"} data-tab="home">
          Inicio
        </button>
        <button role="tab" aria-selected={tab === "sign"} data-tab="sign">
          Firmar
        </button>
      </div>
      <button onClick={() => session.guard(() => setTab("home"))}>ir-a-inicio</button>
      <button
        onClick={() => {
          session.setIntent("fill");
          setTab("sign");
        }}
      >
        entrar-con-F
      </button>
      <button onClick={() => setTab("sign")}>ir-a-firmar</button>
      <button onClick={() => setTab(FILL_TAB)}>ir-a-rellenar</button>
      {session.active ? <ProModeHost session={session} panelId="panel" /> : <div>visor</div>}
      <ProModeResult session={session} />
      <ProModeSheets session={session} />
    </div>
  );
}

async function mount(file: File, options: { signatures?: ProSignatureState; tab?: ProTabId } = {}) {
  const doc = await openDoc(file, options.signatures);
  const view = render(
    <LanguageProvider>
      <ProWorkingDocProvider doc={doc}>
        <Suite initialTab={options.tab} />
      </ProWorkingDocProvider>
    </LanguageProvider>,
  );
  return { doc, ...view };
}

const hostApply = () => document.querySelector("[data-pro-mode-apply]") as HTMLElement;
const hostDiscard = () => document.querySelector("[data-pro-mode-discard]") as HTMLElement;
const paletteTool = (name: string) =>
  within(screen.getByRole("toolbar", { name: strings.paletteLabel })).getByRole("button", { name });

async function addText(value: string) {
  await screen.findByRole("toolbar", { name: strings.paletteLabel });
  fireEvent.click(paletteTool(strings.fieldTypeText));
  fireEvent.click(await screen.findByRole("button", { name: strings.addTextFieldHere }));
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  await waitFor(() => expect(hostApply().getAttribute("aria-disabled")).toBeNull());
}

async function createSignature(text = "Ana") {
  await screen.findByRole("toolbar", { name: strings.paletteLabel });
  fireEvent.click(screen.getAllByRole("button", { name: strings.createSignature })[0]);
  fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
  fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: strings.save }));
  await waitFor(() => expect(hostApply().getAttribute("aria-disabled")).toBeNull());
}

describe("registro de los modos Firmar y Rellenar", () => {
  it("importar signModes registra 'sign' y 'fill' en el registro compartido", () => {
    expect(getProMode("sign")?.id).toBe("sign");
    expect(getProMode("fill")?.id).toBe("fill");
    const tabs = listProModes().map((mode) => mode.tab);
    expect(tabs).toEqual(expect.arrayContaining(["sign", "fill"]));
  });

  it("las definiciones cumplen el contrato compartido (id, pestana, clave, componente, herramienta suelta)", () => {
    for (const definition of SIGN_MODE_DEFINITIONS) {
      expect(definition.id).toBe(definition.tab);
      expect(definition.labelKey).toBe(definition.id);
      expect(typeof definition.Component).toBe("function");
      expect(definition.preferredTool).toBe("sign-pdf");
    }
  });

  it("registrar otro modo en la misma pestana lo reemplaza y el disposer restituye solo si es el vigente", () => {
    const original = getProMode("sign")!;
    const dispose = registerProMode({ ...original, labelKey: "otro" });
    expect(getProMode("sign")!.labelKey).toBe("otro");
    dispose();
    expect(getProMode("sign")).toBeUndefined();
    registerProMode(original);
    expect(getProMode("sign")).toBe(original);
  });
});

describe("Firmar con el anfitrion real: un «Aplicar» = UN snapshot", () => {
  it("monta el modo en lugar del visor, con la barra del anfitrion (Aplicar/Descartar) y sin botones propios", async () => {
    const { file } = await contractFile();
    await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(screen.queryByText("visor")).toBeNull();
    expect(hostApply()).toBeTruthy();
    expect(hostApply().getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: sign.apply })).toBeNull();
    expect(document.querySelector("[data-pro-mode-host]")?.getAttribute("data-mode")).toBe("sign");
  });

  it("firmar y aplicar crea exactamente UN snapshot «Documento firmado», vuelve a la pestana de partida y lo anuncia", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await createSignature();
    expect(doc.getState().document!.snapshots).toHaveLength(1);
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    const snapshot = doc.currentSnapshot()!;
    expect(snapshot.label).toBe(sign.labelSigned);
    expect(snapshot.source).toBe("mode-apply");
    expect(snapshot.opId).toBe("mode:sign");
    expect(snapshot.pageCount).toBe(3);
    expect(await pageImageCount(snapshot.bytes, 0)).toBe(1);
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    expect(screen.getByText("visor")).toBeTruthy();
    expect(await screen.findByText(host.appliedTitle(sign.labelSigned))).toBeTruthy();
    expect(doc.getState().announcement?.text).toContain(sign.labelSigned);
    expect(doc.getState().dirty).toBe(true);
  });

  it("Ctrl+Z global tras aplicar deshace la firma y vuelve a los bytes originales; Ctrl+Shift+Z la rehace", async () => {
    const { file, bytes } = await contractFile(3);
    const { doc } = await mount(file);
    await createSignature();
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(doc.getState().document!.cursor).toBe(0);
    expect(Array.from(doc.current()!)).toEqual(Array.from(bytes));
    expect(await pageImageCount(doc.current()!, 0)).toBe(0);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    expect(doc.getState().document!.cursor).toBe(1);
    expect(await pageImageCount(doc.current()!, 0)).toBe(1);
  });

  it("mientras el modo esta abierto tiene su propio deshacer: el Ctrl+Z global no actua", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await createSignature();
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    fireEvent.click(screen.getByText("ir-a-firmar"));
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(doc.getState().ownUndoActive).toBe(true);
    expect(doc.getState().activeModes).toContain("sign");
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(doc.getState().document!.cursor).toBe(1);
  });

  it("dos aplicaciones seguidas son dos snapshots y se deshacen una a una (la huella se recalcula con cada snapshot)", async () => {
    const { file, bytes } = await contractFile(3);
    const { doc } = await mount(file);
    await addText("Primera");
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    fireEvent.click(screen.getByText("ir-a-firmar"));
    await addText("Segunda");
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(3));
    expect(await pdfjsPageText(doc.current()!, 1)).toContain("Primera");
    expect(await pdfjsPageText(doc.current()!, 1)).toContain("Segunda");
    expect(doc.undo()).toBe(true);
    expect(await pdfjsPageText(doc.current()!, 1)).toContain("Primera");
    expect(await pdfjsPageText(doc.current()!, 1)).not.toContain("Segunda");
    doc.undo();
    expect(Array.from(doc.current()!)).toEqual(Array.from(bytes));
  });

  it("al salir del modo se retira el registro del modo con deshacer propio", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(doc.getState().ownUndoActive).toBe(true);
    fireEvent.click(hostDiscard());
    await waitFor(() => expect(doc.getState().ownUndoActive).toBe(false));
    expect(doc.getState().activeModes).toEqual([]);
  });

  it("descartar sin cambios sale de inmediato y no crea snapshot", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(hostDiscard());
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    expect(doc.getState().document!.snapshots).toHaveLength(1);
  });

  it("descartar con cambios pregunta y, al confirmar, no crea snapshot (la sesion de firma se pierde)", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await addText("Perdido");
    fireEvent.click(hostDiscard());
    fireEvent.click(await screen.findByRole("button", { name: host.discardConfirm }));
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    expect(doc.getState().document!.snapshots).toHaveLength(1);
  });

  it("salir a otra pestana con cambios sin aplicar pregunta: 'Seguir' se queda", async () => {
    const { file } = await contractFile(3);
    await mount(file);
    await addText("Pendiente");
    fireEvent.click(screen.getByText("ir-a-inicio"));
    expect(await screen.findByText(host.leaveTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: host.leaveStay }));
    expect(screen.getByTestId("tab").textContent).toBe("sign");
  });

  it("'Descartar y salir' sale sin snapshot y 'Aplicar y salir' crea UN snapshot y sale", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await addText("Aplicar y salir");
    fireEvent.click(screen.getByText("ir-a-inicio"));
    fireEvent.click(await screen.findByRole("button", { name: host.leaveApply }));
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    expect(await pdfjsPageText(doc.current()!, 1)).toContain("Aplicar y salir");
  });

  it("'Descartar y salir' no crea snapshot", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await addText("No se guarda");
    fireEvent.click(screen.getByText("ir-a-inicio"));
    fireEvent.click(await screen.findByRole("button", { name: host.leaveDiscard }));
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    expect(doc.getState().document!.snapshots).toHaveLength(1);
  });
});

describe("avisos de firmas digitales y de cifrado con el anfitrion real", () => {
  it("PDF con firmas digitales activas: el modo avisa de que se invalidan y el anfitrion pide confirmar antes de aplicar", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file, { signatures: "active" });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(document.querySelector("[data-pro-mode-warnings]")?.textContent).toContain("firmas digitales");
    await addText("Con firmas");
    fireEvent.click(hostApply());
    expect(await screen.findByText(host.signaturesTitle)).toBeTruthy();
    // Sin confirmar no hay snapshot.
    expect(doc.getState().document!.snapshots).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: host.signaturesConfirm }));
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
  });

  it("'Seguir sin aplicar' en la confirmacion de firmas no aplica y deja la sesion intacta", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file, { signatures: "active" });
    await addText("Sigo");
    fireEvent.click(hostApply());
    fireEvent.click(await screen.findByRole("button", { name: host.signaturesCancel }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(doc.getState().document!.snapshots).toHaveLength(1);
    expect(screen.getByTestId("tab").textContent).toBe("sign");
    // La sesion sigue intacta: lo escrito sigue ahi y se puede volver a intentar.
    expect(hostApply().getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(host.signaturesTitle)).toBeNull();
  });

  it("firmas que no se pudieron comprobar tambien piden confirmacion", async () => {
    const { file } = await contractFile(3);
    await mount(file, { signatures: "unknown" });
    await addText("Dudoso");
    fireEvent.click(hostApply());
    expect(await screen.findByText(host.signaturesTitle)).toBeTruthy();
  });

  it("un PDF sin firmas no pide confirmacion", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file, { signatures: "none" });
    await addText("Libre");
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    expect(screen.queryByText(host.signaturesTitle)).toBeNull();
  });
});

describe("Rellenar dentro de la pestana Firmar (conmutador) con el anfitrion real", () => {
  it("el conmutador ofrece Firmar y Rellenar formulario; Firmar es lo de arriba por defecto", async () => {
    const { file } = await contractFile(3);
    await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    const group = document.querySelector("[data-pro-mode-switch]") as HTMLElement;
    expect(within(group).getByRole("tab", { name: sign.switchSign }).getAttribute("aria-selected")).toBe("true");
    expect(within(group).getByRole("tab", { name: sign.switchFill }).getAttribute("aria-selected")).toBe("false");
  });

  it("rellenar un formulario real y aplicar crea UN snapshot «Formulario rellenado (2 campos)» con los valores en /V", async () => {
    const { file } = await formFile();
    const { doc } = await mount(file);
    fireEvent.click(await screen.findByRole("tab", { name: sign.switchFill }));
    await screen.findByText(fill.formFound(5));
    const group = await waitFor(() => screen.getByRole("group", { name: /^nombre, / }));
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(group, { pointerId: 1 });
    const input = await screen.findByRole("textbox", { name: "nombre" });
    fireEvent.change(input, { target: { value: "Ñandú" } });
    fireEvent.blur(input);
    const choices = document.querySelector("[data-fill-choices]") as HTMLElement;
    fireEvent.change(within(choices).getByLabelText(/^pais/), { target: { value: "Chile" } });
    await waitFor(() => expect(hostApply().getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    const snapshot = doc.currentSnapshot()!;
    expect(snapshot.label).toBe("Formulario rellenado (2 campos)");
    expect(snapshot.source).toBe("mode-apply");
    const objects = await pdfjsFieldObjects(snapshot.bytes);
    expect(objects.nombre[0].value).toBe("Ñandú");
    expect(objects.pais[0].value).toBe("Chile");
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
  });

  it("deshacer global tras rellenar devuelve el formulario vacio original", async () => {
    const { file, bytes } = await formFile();
    const { doc } = await mount(file);
    fireEvent.click(await screen.findByRole("tab", { name: sign.switchFill }));
    await screen.findByText(fill.formFound(5));
    const group = await waitFor(() => screen.getByRole("group", { name: /^apellido, / }));
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(group, { pointerId: 1 });
    const input = await screen.findByRole("textbox", { name: "apellido" });
    fireEvent.change(input, { target: { value: "Pérez" } });
    fireEvent.blur(input);
    await waitFor(() => expect(hostApply().getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    doc.undo();
    expect(Array.from(doc.current()!)).toEqual(Array.from(bytes));
  });

  it("cambiar de Firmar a Rellenar con trabajo sin aplicar pide confirmacion; 'Seguir aqui' se queda", async () => {
    const { file } = await formFile();
    await mount(file);
    await addText("Sin aplicar");
    fireEvent.click(screen.getByRole("tab", { name: sign.switchFill }));
    expect(await screen.findByText(sign.switchConfirmTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: sign.switchStay }));
    expect(screen.getByRole("tab", { name: sign.switchSign }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("[data-pro-mode='sign']")).toBeTruthy();
  });

  it("'Descartar y cambiar' pasa a Rellenar y descarta lo que no se habia aplicado", async () => {
    const { file } = await formFile();
    const { doc } = await mount(file);
    await addText("Descartable");
    fireEvent.click(screen.getByRole("tab", { name: sign.switchFill }));
    fireEvent.click(await screen.findByRole("button", { name: sign.switchConfirm }));
    await screen.findByText(fill.formFound(5));
    expect(document.querySelector("[data-pro-mode='fill']")).toBeTruthy();
    expect(doc.getState().document!.snapshots).toHaveLength(1);
    expect(hostApply().getAttribute("aria-disabled")).toBe("true");
  });

  it("cambiar con la sesion limpia no pregunta", async () => {
    const { file } = await formFile();
    await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    fireEvent.click(screen.getByRole("tab", { name: sign.switchFill }));
    await waitFor(() => expect(document.querySelector("[data-pro-mode='fill']")).toBeTruthy());
    expect(screen.queryByText(sign.switchConfirmTitle)).toBeNull();
  });

  it("el modo 'fill' registrado para una pestana propia tambien funciona con el anfitrion", async () => {
    const { file } = await formFile();
    const { doc } = await mount(file, { tab: FILL_TAB });
    await screen.findByText(fill.formFound(5));
    expect(document.querySelector("[data-pro-mode-switch]")).toBeNull();
    const group = await waitFor(() => screen.getByRole("group", { name: /^nombre, / }));
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(group, { pointerId: 1 });
    const input = await screen.findByRole("textbox", { name: "nombre" });
    fireEvent.change(input, { target: { value: "Pestana propia" } });
    fireEvent.blur(input);
    await waitFor(() => expect(hostApply().getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    expect(doc.currentSnapshot()!.opId).toBe("mode:fill");
  });
});

describe("ProSignMode: herramienta pedida por el anfitrion (intent)", () => {
  async function renderMode(intent: { tool: string; nonce: number } | null) {
    const { file, bytes } = await formFile();
    const doc = await openDoc(file);
    const hostValue = {
      tab: "sign",
      initialPage: 0,
      reportPage: () => {},
      registerControls: () => {},
      intent,
      busy: false,
    };
    const { ProSignMode } = await import("@/app/pdf-pro/modes/ProSignMode");
    const { ProModeHostContext } = await import("@/app/pdf-pro/modes/modeContext");
    const view = render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc}>
          <ProModeHostContext.Provider value={hostValue}>
            <ProSignMode file={doc.currentFile()!} bytes={bytes} lang="es" onApply={async () => {}} onCancel={() => {}} onDirtyChange={() => {}} />
          </ProModeHostContext.Provider>
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    return { view, doc, bytes, hostValue, ProSignMode, ProModeHostContext };
  }

  it("sin peticion abre Firmar", async () => {
    await renderMode(null);
    expect(document.querySelector("[data-pro-mode='sign']")).toBeTruthy();
  });

  it("una peticion de 'fill' abre Rellenar formulario", async () => {
    await renderMode({ tool: "fill", nonce: 1 });
    await screen.findByText(fill.formFound(5));
    expect(document.querySelector("[data-pro-mode='fill']")).toBeTruthy();
    expect(screen.getByRole("tab", { name: sign.switchFill }).getAttribute("aria-selected")).toBe("true");
  });

  it("una peticion de 'sign' abre Firmar", async () => {
    await renderMode({ tool: "sign", nonce: 4 });
    expect(document.querySelector("[data-pro-mode='sign']")).toBeTruthy();
  });

  it("una herramienta desconocida se ignora", async () => {
    await renderMode({ tool: "image", nonce: 2 });
    expect(document.querySelector("[data-pro-mode='sign']")).toBeTruthy();
  });

  it("una peticion nueva (nonce mayor) cambia de herramienta estando limpio; la misma no se repite", async () => {
    const { view, hostValue, ProSignMode, ProModeHostContext, doc, bytes } = await renderMode({ tool: "fill", nonce: 1 });
    await screen.findByText(fill.formFound(5));
    fireEvent.click(screen.getByRole("tab", { name: sign.switchSign }));
    await waitFor(() => expect(document.querySelector("[data-pro-mode='sign']")).toBeTruthy());
    const again = (intent: { tool: string; nonce: number }) =>
      view.rerender(
        <LanguageProvider>
          <ProWorkingDocProvider doc={doc}>
            <ProModeHostContext.Provider value={{ ...hostValue, intent }}>
              <ProSignMode file={doc.currentFile()!} bytes={bytes} lang="es" onApply={async () => {}} onCancel={() => {}} onDirtyChange={() => {}} />
            </ProModeHostContext.Provider>
          </ProWorkingDocProvider>
        </LanguageProvider>,
      );
    // El mismo nonce: no vuelve a Rellenar.
    again({ tool: "fill", nonce: 1 });
    expect(document.querySelector("[data-pro-mode='sign']")).toBeTruthy();
    again({ tool: "fill", nonce: 2 });
    await waitFor(() => expect(document.querySelector("[data-pro-mode='fill']")).toBeTruthy());
  });
});

describe("documento cifrado (copia descifrada) con el anfitrion real", () => {
  it("avisa de que se trabaja con una copia sin contrasena", async () => {
    const { file } = await contractFile(3);
    const doc = createProWorkingDoc({ inspectSignatures: async () => "none", language: "es" });
    await doc.open(file, { encrypted: true });
    render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc}>
          <Suite />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(document.querySelector("[data-pro-mode-warnings]")?.textContent).toContain("sin contraseña");
  });
});

describe("el resultado conserva el documento", () => {
  it("firmar no cambia el numero de paginas ni pierde el texto original", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await addText("Anotacion");
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    const resulting = await PDFDocument.load(doc.current()!);
    expect(resulting.getPageCount()).toBe(3);
    expect(await pdfjsPageText(doc.current()!, 2)).toContain("Contrato pagina 2");
  });

  it("en ingles el anfitrion y el modo hablan ingles y la etiqueta del snapshot tambien", async () => {
    const { file } = await contractFile(3);
    const doc = createProWorkingDoc({ inspectSignatures: async () => "none", language: "en" });
    await doc.open(file);
    function EnSuite() {
      const [tab, setTab] = useState<ProTabId>("sign");
      const session = useProModeSession({
        tab,
        setTab,
        language: "en",
        focusTab: () => {},
        getViewerPage: () => 0,
        restoreViewerPage: () => {},
      });
      return session.active ? <ProModeHost session={session} panelId="panel" /> : <div>viewer</div>;
    }
    function Switch({ to }: { to: Language }) {
      const { setLanguage } = useI18n();
      useEffect(() => {
        setLanguage(to);
      }, [setLanguage, to]);
      return null;
    }
    render(
      <LanguageProvider>
        <Switch to="en" />
        <ProWorkingDocProvider doc={doc}>
          <EnSuite />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    const en = SIGN_STRINGS.en;
    await screen.findByRole("toolbar", { name: en.paletteLabel });
    fireEvent.click(within(screen.getByRole("toolbar", { name: en.paletteLabel })).getByRole("button", { name: en.fieldTypeText }));
    fireEvent.click(await screen.findByRole("button", { name: en.addTextFieldHere }));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.blur(input);
    await waitFor(() => expect(hostApply().getAttribute("aria-disabled")).toBeNull());
    await act(async () => {
      fireEvent.click(hostApply());
    });
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    expect(doc.currentSnapshot()!.label).toBe(SIGN_EMBEDDED_STRINGS.en.labelSigned);
    // Se devuelve el idioma de pruebas al de siempre.
    function Back() {
      const { setLanguage } = useI18n();
      useEffect(() => setLanguage("es"), [setLanguage]);
      return null;
    }
    render(
      <LanguageProvider>
        <Back />
      </LanguageProvider>,
    );
  });
});


/* ------------------------------------------------------------------ *
 * Correcciones del verificador: foco, aviso de recarga, barra y «Aplicar» apagado
 * ------------------------------------------------------------------ */

const frames = async (count = 6) => {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
  }
};
const fireUnload = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe("foco al entrar con S o F (sin pulsar una pestana)", () => {
  it("S: entrar a Firmar con el foco en <body> lo deja en el conmutador de herramienta, nunca en <body>", async () => {
    const { file } = await contractFile(3);
    await mount(file, { tab: "home" as ProTabId });
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      fireEvent.click(screen.getByText("ir-a-firmar"));
    });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await frames();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      document.querySelector("[data-pro-mode-switch] [role='tab'][aria-selected='true']"),
    );
  });

  it("F: entrar con la peticion de Rellenar deja el foco en el conmutador (Rellenar formulario)", async () => {
    const { file } = await formFile();
    await mount(file, { tab: "home" as ProTabId });
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      fireEvent.click(screen.getByText("entrar-con-F"));
    });
    await screen.findByText(fill.formFound(5));
    await frames();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      document.querySelector("[data-pro-mode-switch] [role='tab'][aria-selected='true']"),
    );
    expect(document.activeElement?.textContent).toBe(sign.switchFill);
  });

  it("entrar pulsando la pestana respeta su foco", async () => {
    const { file } = await contractFile(3);
    await mount(file, { tab: "home" as ProTabId });
    const tab = document.querySelector("[data-tab='sign']") as HTMLElement;
    tab.focus();
    await act(async () => {
      fireEvent.click(screen.getByText("ir-a-firmar"));
    });
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    await frames();
    expect(document.activeElement).toBe(tab);
  });
});

describe("aviso de recarga con una sesion sin aplicar", () => {
  it("con trabajo sin aplicar el navegador pregunta; limpio, no", async () => {
    const { file } = await contractFile(3);
    await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(fireUnload()).toBe(false);
    await addText("Pendiente");
    expect(fireUnload()).toBe(true);
  });

  it("se retira al aplicar", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await addText("Aplicado");
    expect(fireUnload()).toBe(true);
    fireEvent.click(hostApply());
    await waitFor(() => expect(doc.getState().document!.snapshots).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    expect(fireUnload()).toBe(false);
  });

  it("se retira al descartar", async () => {
    const { file } = await contractFile(3);
    await mount(file);
    await addText("Descartado");
    fireEvent.click(hostDiscard());
    fireEvent.click(await screen.findByRole("button", { name: host.discardConfirm }));
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    expect(fireUnload()).toBe(false);
  });

  it("tambien avisa en Rellenar con un formulario a medias", async () => {
    const { file } = await formFile();
    await mount(file);
    fireEvent.click(await screen.findByRole("tab", { name: sign.switchFill }));
    await screen.findByText(fill.formFound(5));
    expect(fireUnload()).toBe(false);
    const choices = await waitFor(() => document.querySelector("[data-fill-choices]") as HTMLElement);
    fireEvent.change(within(choices).getByLabelText(/^pais/), { target: { value: "Chile" } });
    await waitFor(() => expect(fireUnload()).toBe(true));
  });
});

describe("barra del anfitrion: nombre, «Aplicar» apagado y un solo elemento", () => {
  it("la barra dice «Firmando» en Firmar y «Rellenando» en Rellenar, y vuelve", async () => {
    const { file } = await formFile();
    await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    const name = () => document.querySelector("[data-pro-mode-name]")?.textContent;
    expect(name()).toBe("Firmando");
    fireEvent.click(screen.getByRole("tab", { name: sign.switchFill }));
    await waitFor(() => expect(name()).toBe("Rellenando"));
    fireEvent.click(screen.getByRole("tab", { name: sign.switchSign }));
    await waitFor(() => expect(name()).toBe("Firmando"));
  });

  it("al entrar directamente en Rellenar (intent) la barra ya dice «Rellenando»", async () => {
    const { file } = await formFile();
    await mount(file, { tab: "home" as ProTabId });
    await act(async () => {
      fireEvent.click(screen.getByText("entrar-con-F"));
    });
    await screen.findByText(fill.formFound(5));
    await waitFor(() => expect(document.querySelector("[data-pro-mode-name]")?.textContent).toBe("Rellenando"));
  });

  it("hay UN solo [data-pro-mode-bar] y, con anfitrion en reposo, ninguna barra propia", async () => {
    const { file } = await contractFile(3);
    await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(document.querySelectorAll("[data-pro-mode-bar]")).toHaveLength(1);
    expect(document.querySelector("[data-pro-mode-actions]")).toBeNull();
  });

  it("«Aplicar» sin cambios se ve apagado (aria-disabled con estilo) y al pulsarlo anuncia «No hay cambios que aplicar»", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(hostApply().getAttribute("aria-disabled")).toBe("true");
    expect(hostApply().className).toContain("aria-disabled:opacity-50");
    fireEvent.click(hostApply());
    expect(doc.getState().announcement?.text).toBe(host.noChanges);
    expect(doc.getState().document!.snapshots).toHaveLength(1);
  });

  it("con cambios «Aplicar» no se apaga ni anuncia nada de «sin cambios»", async () => {
    const { file } = await contractFile(3);
    const { doc } = await mount(file);
    await addText("Con cambios");
    expect(hostApply().getAttribute("aria-disabled")).toBeNull();
    expect(doc.getState().announcement?.text).not.toBe(host.noChanges);
  });

  it("descartar un modo limpio deja el foco en una pestana en el mismo instante (nunca en <body>)", async () => {
    const { file } = await contractFile(3);
    await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    hostDiscard().focus();
    expect(document.activeElement).toBe(hostDiscard());
    fireEvent.click(hostDiscard());
    // El host sale en cuanto termina de descartar; sin `focusTab` (aqui no hay barra real) el foco solo puede estar
    // en una pestana si se coloco ANTES de retirar la barra.
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("home"));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
  });
});

describe("lienzo compacto dentro de los modos", () => {
  it("el titulo y la ayuda del lienzo quedan solo para lectores de pantalla", async () => {
    const { file } = await contractFile(3);
    await mount(file);
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect(document.querySelector("[data-canvas-intro]")?.className).toContain("sr-only");
  });

  it("las notas estan plegadas (details cerrado) y los avisos ocupan una linea cada uno", async () => {
    const { file } = await contractFile(3);
    const doc = createProWorkingDoc({ inspectSignatures: async () => "active", language: "es" });
    await doc.open(file, { encrypted: true });
    render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc}>
          <Suite />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    await screen.findByRole("toolbar", { name: strings.paletteLabel });
    expect((document.querySelector("[data-pro-mode-notes]") as HTMLDetailsElement).open).toBe(false);
    expect(document.querySelectorAll("[data-pro-mode-warnings] li")).toHaveLength(2);
    expect(document.querySelector("[data-pro-mode-warnings]")?.textContent).toContain("firmas digitales");
  });
});
