import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  BATCH_DELIVERY_READY,
  SignToolClient,
  prepareDocumentJob,
} from "@/app/sign-pdf/SignToolClient";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { captureStamp } from "@/app/sign-pdf/captures";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import { EMPTY_DOC_STATE, docIdOf, ensureBlocks } from "@/app/sign-pdf/docSet";
import { clearAllDrafts, draftFingerprint, listDrafts } from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LanguageProvider, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { detectFields, type DetectedField } from "@/lib/pdf/detectFields";
import { PdfError } from "@/lib/pdf/core";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";
import {
  __resetSignPdfFeatureFlagsCacheForTests,
  setSignPdfFeatureFlag,
} from "@/app/sign-pdf/signFeatureFlags";
import { __resetSignTemplatesCacheForTests } from "@/app/sign-pdf/signTemplates";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/** Lo mismo que `SoloFlow.test.tsx`: sin pdf.js, una pagina simulada. */
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
const MB = 1024 * 1024;

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

let seed = 10;
/** Archivo nuevo en cada llamada (la huella se cachea por objeto `File`). */
function pdf(name: string, byte?: number): File {
  const b = byte ?? (seed += 3) % 240;
  return new File([new Uint8Array([b, b + 1, b + 2, b + 3])], name, {
    type: "application/pdf",
    lastModified: 1_700_000_000_000 + b,
  });
}

/** Un archivo que dice pesar `mb` MB sin ocuparlos en memoria. */
function heavy(name: string, mb: number): File {
  const file = pdf(name);
  Object.defineProperty(file, "size", { value: mb * MB });
  return file;
}

const FIELD_A: DetectedField = {
  id: "txt-a",
  pageIndex: 0,
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
  label: "Nombre",
  source: "acroform",
  confidence: "high",
};
const FIELD_B: DetectedField = {
  id: "txt-b",
  pageIndex: 0,
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
  label: "Fecha",
  source: "acroform",
  confidence: "high",
};

beforeEach(() => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockImplementation(async (file: File) => {
    if (file.name === "a.pdf") return [FIELD_A];
    if (file.name === "b.pdf") return [FIELD_B];
    return [];
  });
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetSignTemplatesCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

afterEach(async () => {
  await clearAllDrafts();
});

function renderTool() {
  return render(
    <LanguageProvider>
      <SignToolClient />
    </LanguageProvider>,
  );
}

function pdfInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"][accept*="pdf"]');
  if (!input) throw new Error("no se encontro el input de archivo PDF");
  return input as HTMLInputElement;
}

/** Los campos de texto del lienzo, por etiqueta. */
const textGroup = (label: string) =>
  screen.queryByRole("group", {
    name: new RegExp(`^${label}, (${strings.a11yPending}|${strings.a11yFilled})$`),
  });

const docNav = () => screen.queryByRole("navigation", { name: strings.documentsLabel });
const docButtons = () =>
  within(docNav()!).getAllByRole("button");
const live = (index: number, count: number, name: string) =>
  strings.documentLive(index, count, name);

async function load(container: HTMLElement, ...files: File[]) {
  fireEvent.change(pdfInput(container), { target: { files } });
  await waitFor(() => expect(screen.getByText(es.tool.filesTitle)).toBeTruthy());
}

function altKey(key: "PageUp" | "PageDown", extra: KeyboardEventInit = {}) {
  act(() => {
    fireEvent.keyDown(window, { key, altKey: true, ...extra });
  });
}

describe("Sign PDF con varios documentos (flag multiDocument) — src/app/sign-pdf/SignToolClient.tsx", () => {
  it("con el flag encendido por defecto, el selector de archivos admite varios PDF", () => {
    const { container } = renderTool();
    expect(pdfInput(container).multiple).toBe(true);
  });

  it("subir dos PDF muestra la lista de documentos con el primero como activo", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    const buttons = docButtons();
    expect(buttons.map((b) => b.textContent)).toEqual(["1. a.pdf", "2. b.pdf"]);
    expect(buttons[0].getAttribute("aria-current")).toBe("true");
    expect(buttons[1].getAttribute("aria-current")).toBeNull();
    expect(screen.getByText(live(1, 2, "a.pdf"))).toBeTruthy();
  });

  it("con un solo documento no hay selector ni region viva de documentos: la interfaz de siempre", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"));
    expect(docNav()).toBeNull();
    expect(screen.queryByText(strings.documentSwitchHint)).toBeNull();
  });

  it("elegir otro documento mueve aria-current y anuncia 'Documento 2 de 2'", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    fireEvent.click(docButtons()[1]);
    expect(docButtons()[1].getAttribute("aria-current")).toBe("true");
    expect(docButtons()[0].getAttribute("aria-current")).toBeNull();
    expect(screen.getByText(live(2, 2, "b.pdf"))).toBeTruthy();
  });

  it("Alt+Av Pag y Alt+Re Pag cambian de documento sin dar la vuelta", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"));
    altKey("PageDown");
    await waitFor(() => expect(screen.getByText(live(2, 3, "b.pdf"))).toBeTruthy());
    altKey("PageDown");
    await waitFor(() => expect(screen.getByText(live(3, 3, "c.pdf"))).toBeTruthy());
    // En el ultimo no pasa nada.
    altKey("PageDown");
    expect(screen.getByText(live(3, 3, "c.pdf"))).toBeTruthy();
    altKey("PageUp");
    await waitFor(() => expect(screen.getByText(live(2, 3, "b.pdf"))).toBeTruthy());
    altKey("PageUp");
    altKey("PageUp");
    await waitFor(() => expect(screen.getByText(live(1, 3, "a.pdf"))).toBeTruthy());
  });

  it("tras cambiar con el teclado el foco va al documento activo del selector (el lienzo se remonta)", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    altKey("PageDown");
    await waitFor(() => expect(document.activeElement).toBe(docButtons()[1]));
  });

  it("PageDown sin Alt, o con otro modificador, no cambia de documento", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    act(() => {
      fireEvent.keyDown(window, { key: "PageDown" });
      fireEvent.keyDown(window, { key: "PageDown", altKey: true, ctrlKey: true });
      fireEvent.keyDown(window, { key: "PageDown", altKey: true, shiftKey: true });
      fireEvent.keyDown(window, { key: "PageDown", altKey: true, metaKey: true });
    });
    expect(screen.getByText(live(1, 2, "a.pdf"))).toBeTruthy();
  });

  it("con un dialogo abierto, Alt+Av Pag lo respeta y no cambia de documento", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    altKey("PageDown");
    expect(screen.getByText(live(1, 2, "a.pdf"))).toBeTruthy();
    modal.remove();
  });

  it("cada documento conserva SU estado: los campos detectados de uno no aparecen en el otro", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    await waitFor(() => expect(textGroup("Nombre")).toBeTruthy());
    expect(textGroup("Fecha")).toBeNull();

    fireEvent.click(docButtons()[1]);
    await waitFor(() => expect(textGroup("Fecha")).toBeTruthy());
    expect(textGroup("Nombre")).toBeNull();

    fireEvent.click(docButtons()[0]);
    await waitFor(() => expect(textGroup("Nombre")).toBeTruthy());
    expect(textGroup("Fecha")).toBeNull();
    // La deteccion no se repite al volver: el estado del documento sobrevive.
    expect(vi.mocked(detectFields).mock.calls.filter(([file]) => file.name === "a.pdf")).toHaveLength(1);
  });

  it("los firmantes son globales: lo que se anade con un documento activo esta tambien en el otro", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    fireEvent.change(screen.getByLabelText(strings.signerNameLabel(1)), { target: { value: "Ana" } });
    fireEvent.click(docButtons()[1]);
    await waitFor(() =>
      expect((screen.getByLabelText(strings.signerNameLabel(1)) as HTMLInputElement).value).toBe("Ana"),
    );
  });

  it("el limite de altas se mantiene con varios documentos: no mas de 2 firmantes", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    const add = () => screen.getByRole("button", { name: strings.addSigner }) as HTMLButtonElement;
    fireEvent.click(add());
    fireEvent.click(add());
    expect(add().disabled).toBe(true);
    expect(screen.getByText(strings.signerLimit)).toBeTruthy();
  });

  it("quitar el documento activo pasa al que ocupa su lugar y el otro conserva su estado", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"));
    fireEvent.click(docButtons()[1]);
    await waitFor(() => expect(textGroup("Fecha")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[1]);
    await waitFor(() => expect(docButtons().map((b) => b.textContent)).toEqual(["1. a.pdf", "2. c.pdf"]));
    expect(docButtons()[1].getAttribute("aria-current")).toBe("true");
    fireEvent.click(docButtons()[0]);
    await waitFor(() => expect(textGroup("Nombre")).toBeTruthy());
  });

  it("al quedar un solo documento desaparece el selector", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[1]);
    await waitFor(() => expect(docNav()).toBeNull());
    await waitFor(() => expect(textGroup("Nombre")).toBeTruthy());
  });

  it("reordenar la cola (Bajar) cambia el orden del selector y conserva el documento activo", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    fireEvent.click(screen.getAllByRole("button", { name: es.tool.moveDown })[0]);
    await waitFor(() => expect(docButtons().map((b) => b.textContent)).toEqual(["1. b.pdf", "2. a.pdf"]));
    // El activo era a.pdf y sigue siendolo.
    expect(docButtons()[1].getAttribute("aria-current")).toBe("true");
    await waitFor(() => expect(textGroup("Nombre")).toBeTruthy());
  });

  it("con varios documentos la descarga conjunta esta conectada: desactivada solo mientras falte algo, con el motivo visible", async () => {
    expect(BATCH_DELIVERY_READY).toBe(true);
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    // «Solo yo» sin firma creada sigue sin poder descargar, y dice por que.
    expect(screen.getAllByText(strings.noSignature).length).toBeGreaterThan(0);
    for (const run of screen.getAllByRole("button", { name: es.tool.run })) {
      expect((run as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[1]);
    await waitFor(() => expect(docNav()).toBeNull());
  });

  it("copias identicas: se aceptan las dos y se avisa, sin bloquear", async () => {
    const { container } = renderTool();
    await load(container, pdf("copia.pdf", 120), pdf("copia.pdf", 120));
    await waitFor(() =>
      expect(screen.getByText(strings.duplicateDocsNotice(["copia.pdf", "copia.pdf"]))).toBeTruthy(),
    );
    expect(docButtons()).toHaveLength(2);
  });

  it("documentos distintos no producen el aviso de copias", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByText(/mismo contenido/)).toBeNull();
  });
});

describe("Sign PDF — topes de la ronda", () => {
  it("11 documentos de golpe: entran 10 y se avisa amablemente del que se quedo fuera", async () => {
    const { container } = renderTool();
    const files = Array.from({ length: 11 }, (_, i) => pdf(`doc${i + 1}.pdf`));
    await load(container, ...files);
    expect(docButtons()).toHaveLength(10);
    expect(screen.getByText(strings.docLimitCount(10, ["doc11.pdf"]))).toBeTruthy();
  });

  it("un PDF de mas de 100 MB no se anade y se explica por que", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    fireEvent.change(pdfInput(container), { target: { files: [heavy("enorme.pdf", 101)] } });
    await waitFor(() => expect(screen.getByText(strings.docLimitSize(100, ["enorme.pdf"]))).toBeTruthy());
    expect(docButtons()).toHaveLength(2);
  });

  it("si la suma pasaria de 200 MB, el que no cabe se deja fuera", async () => {
    const { container } = renderTool();
    await load(container, heavy("a.pdf", 100), heavy("b.pdf", 95));
    fireEvent.change(pdfInput(container), { target: { files: [heavy("c.pdf", 50)] } });
    await waitFor(() => expect(screen.getByText(strings.docLimitTotal(200, ["c.pdf"]))).toBeTruthy());
    expect(docButtons()).toHaveLength(2);
  });

  it("el primer archivo rechazado no deja la herramienta en un estado a medias", async () => {
    const { container } = renderTool();
    fireEvent.change(pdfInput(container), { target: { files: [heavy("enorme.pdf", 150)] } });
    await waitFor(() => expect(screen.getByText(strings.docLimitSize(100, ["enorme.pdf"]))).toBeTruthy());
    // Sigue la zona de carga, sin lista.
    expect(pdfInput(container)).toBeTruthy();
    expect(screen.queryByText(es.tool.filesTitle)).toBeNull();
  });

  it("el aviso se puede cerrar", async () => {
    const { container } = renderTool();
    fireEvent.change(pdfInput(container), { target: { files: [heavy("enorme.pdf", 150)] } });
    const text = strings.docLimitSize(100, ["enorme.pdf"]);
    await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: es.common.close }));
    expect(screen.queryByText(text)).toBeNull();
  });

  it("una carga posterior sin problemas limpia el aviso anterior", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"));
    fireEvent.change(pdfInput(container), { target: { files: [heavy("enorme.pdf", 150)] } });
    const text = strings.docLimitSize(100, ["enorme.pdf"]);
    await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
    fireEvent.change(pdfInput(container), { target: { files: [pdf("b.pdf")] } });
    await waitFor(() => expect(screen.queryByText(text)).toBeNull());
  });
});

describe("Sign PDF con el flag apagado (comportamiento de siempre)", () => {
  beforeEach(() => {
    setSignPdfFeatureFlag("multiDocument", false);
  });

  it("el selector admite un solo archivo y no hay 'anadir mas'", async () => {
    const { container } = renderTool();
    expect(pdfInput(container).multiple).toBe(false);
    await load(container, pdf("a.pdf"));
    expect(screen.queryByText(es.tool.addMore)).toBeNull();
    expect(docNav()).toBeNull();
    expect(screen.queryByRole("button", { name: es.tool.moveDown })).toBeNull();
  });

  it("si llegan varios de golpe se queda con el primero", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    expect(docNav()).toBeNull();
    expect(screen.getAllByRole("button", { name: es.tool.remove })).toHaveLength(1);
    await waitFor(() => expect(textGroup("Nombre")).toBeTruthy());
  });

  it("un archivo de mas de 100 MB sigue pasando, pero el aviso ya NO se borra al instante", async () => {
    const { container } = renderTool();
    fireEvent.change(pdfInput(container), { target: { files: [heavy("grande.pdf", 130)] } });
    await waitFor(() => expect(screen.getByText(es.tool.filesTitle)).toBeTruthy());
    expect(await screen.findByText(es.tool.errors.tooLarge)).toBeTruthy();
  });

  it("el flujo de un solo documento sigue funcionando: deteccion y relleno en el lienzo", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"));
    await waitFor(() => expect(textGroup("Nombre")).toBeTruthy());
  });
});

describe("carreras a4 y a5 — el estado cuelga del DocId, no de la huella", () => {
  type Gate = { bytes: Uint8Array; open: () => void; opened: Promise<void> };
  const gates: Gate[] = [];
  let digestSpy: ReturnType<typeof vi.spyOn> | null = null;

  const toView = (data: BufferSource): Uint8Array =>
    ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  beforeEach(() => {
    const subtle = globalThis.crypto.subtle;
    const original = subtle.digest.bind(subtle);
    digestSpy = vi.spyOn(subtle, "digest").mockImplementation((async (
      algorithm: AlgorithmIdentifier,
      data: BufferSource,
    ) => {
      const view = toView(data);
      const gate = gates.find((candidate) => sameBytes(candidate.bytes, view));
      if (gate) await gate.opened;
      return original(algorithm, data);
    }) as typeof subtle.digest);
  });

  afterEach(() => {
    digestSpy?.mockRestore();
    digestSpy = null;
    gates.length = 0;
  });

  /** Cierra la puerta de la huella de `file`; devuelve su huella real y como abrirla. */
  async function holdHash(file: File): Promise<{ key: string; release: () => void }> {
    const key = await documentContentKey(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    gates.push({ bytes, open, opened });
    return { key, release: open };
  }

  it("a4: A se quita antes de que llegue su huella; la tardia no sella ni guarda nada bajo B", async () => {
    const a = pdf("a.pdf", 31);
    const b = pdf("b.pdf", 61);
    const held = await holdHash(a);
    const keyB = await documentContentKey(b);
    const { container } = renderTool();
    await load(container, a, b);

    // A sale ANTES de que su huella exista.
    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[0]);
    await waitFor(() => expect(docNav()).toBeNull());
    // B es el unico: pasa a "Varios firmantes" y empieza a trabajar.
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));

    // Ahora llega, tarde, la huella de A.
    await act(async () => {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // El borrador (autoguardado) es de B, con SU huella; nada bajo la de A.
    await waitFor(async () => {
      const ids = (await listDrafts()).map((draft) => draftFingerprint(draft));
      expect(ids).toContain(keyB);
    });
    const ids = (await listDrafts()).map((draft) => draftFingerprint(draft));
    expect(ids).not.toContain(held.key);
    expect(screen.getByLabelText(strings.signerNameLabel(1))).toBeTruthy();
  });

  it("a5: se quita A y se sube C mientras la huella de A esta en vuelo; C no hereda nada de A", async () => {
    const a = pdf("a.pdf", 33);
    const c = pdf("c.pdf", 133);
    const held = await holdHash(a);
    const { container } = renderTool();
    await load(container, a, pdf("b.pdf", 63));

    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[0]);
    await waitFor(() => expect(docNav()).toBeNull());
    fireEvent.change(pdfInput(container), { target: { files: [c] } });
    await waitFor(() => expect(docButtons().map((button) => button.textContent)).toEqual(["1. b.pdf", "2. c.pdf"]));

    await act(async () => {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.click(docButtons()[1]);
    // C esta en blanco: ni los campos de A ni los de B.
    await waitFor(() => expect(screen.getByText(live(2, 2, "c.pdf"))).toBeTruthy());
    expect(textGroup("Nombre")).toBeNull();
    expect(textGroup("Fecha")).toBeNull();
    // B sigue con lo suyo.
    fireEvent.click(docButtons()[0]);
    await waitFor(() => expect(textGroup("Fecha")).toBeTruthy());
  });

  it("quitar el unico documento y subir otro distinto lo deja en blanco aunque la huella del primero llegue tarde", async () => {
    const a = pdf("a.pdf", 35);
    const held = await holdHash(a);
    const { container } = renderTool();
    await load(container, a);
    fireEvent.click(screen.getByRole("button", { name: es.tool.remove }));
    await waitFor(() => expect(screen.queryByText(es.tool.filesTitle)).toBeNull());
    await load(container, pdf("c.pdf", 135));
    await act(async () => {
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(textGroup("Nombre")).toBeNull();
  });
});

describe("prepareDocumentJob — enganche para la entrega de varios documentos", () => {
  const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
  const DRAFT = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 };
  const field = (id: string): SignatureField => ({
    id,
    signerId: ANA.id,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  });
  const ctx = { language: "es" as const, strings, certificateEnabled: false };

  async function twoDocSession() {
    const a = pdf("a.pdf", 80);
    const b = pdf("b.pdf", 90);
    const [idA, idB] = [docIdOf(a), docIdOf(b)];
    const [keyA, keyB] = [await documentContentKey(a), await documentContentKey(b)];
    const fieldsA = [field("f1")];
    const fieldsB = [field("f2"), field("f3")];
    const blocks = ensureBlocks([ANA], [idA, idB], "same", []).map((block) => ({
      ...block,
      signature: DRAFT,
      stamps: {
        [idA]: captureStamp(keyA, fieldsA, ANA.id),
        [idB]: captureStamp(keyB, fieldsB, ANA.id),
      },
    }));
    const session: SignSession = {
      ...DEFAULT_SESSION,
      mode: "multi",
      signers: [ANA],
      blocks,
      docOrder: [idA, idB],
      activeDocId: idA,
      docs: {
        [idA]: { ...EMPTY_DOC_STATE, sealedKey: keyA, fields: fieldsA },
        [idB]: { ...EMPTY_DOC_STATE, sealedKey: keyB, fields: fieldsB },
      },
    };
    return { a, b, idA, idB, session };
  }

  it("produce las colocaciones de cada documento con SU vista: huecos propios, mismo trazo", async () => {
    const { a, b, idA, idB, session } = await twoDocSession();
    const jobA = await prepareDocumentJob(idA, a, session, ctx);
    const jobB = await prepareDocumentJob(idB, b, session, ctx);
    expect(jobA.params.placements).toHaveLength(1);
    expect(jobB.params.placements).toHaveLength(2);
    expect(jobA.docId).toBe(idA);
  });

  it("un documento cuyo trazo no tiene sello valido (no lo vio) no se firma", async () => {
    const { b, idB, session } = await twoDocSession();
    const broken: SignSession = {
      ...session,
      blocks: session.blocks.map((block) => ({ ...block, stamps: {} })),
    };
    await expect(prepareDocumentJob(idB, b, broken, ctx)).rejects.toMatchObject({
      code: "nothingSelected",
    });
  });

  it("se recalcula la huella: un archivo cambiado por otro de igual nombre no se firma", async () => {
    const { idA, session } = await twoDocSession();
    const impostor = pdf("a.pdf", 200);
    await expect(prepareDocumentJob(idA, impostor, session, ctx)).rejects.toBeInstanceOf(PdfError);
  });

  it("incluye el certificado solo si esta activo", async () => {
    const { a, idA, session } = await twoDocSession();
    const job = await prepareDocumentJob(idA, a, session, { ...ctx, certificateEnabled: true });
    expect(job.params.certificate?.signerNames).toEqual(["Ana"]);
  });
});
