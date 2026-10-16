import "fake-indexeddb/auto";
import { useCallback, useLayoutEffect, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MultiFlow } from "@/app/sign-pdf/SignToolClient";
import { captureForBlock } from "@/app/sign-pdf/blockModel";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import {
  EMPTY_DOC_STATE,
  docIdOf,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import {
  DEFAULT_SESSION,
  applyViewPatch,
  viewOf,
  type SignSession,
} from "@/app/sign-pdf/signSession";
import { useSessionBridge } from "@/app/sign-pdf/useSessionBridge";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import {
  __resetSignPdfFeatureFlagsCacheForTests,
} from "@/app/sign-pdf/signFeatureFlags";
import { clearVault } from "@/app/sign-pdf/signVault";
import { installCanvasStubs, pngDataUrl } from "@/app/sign-pdf/vaultTestUtils";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { detectFields } from "@/lib/pdf/detectFields";
import type { SignatureField, Signer } from "@/lib/pdf/sign";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";

/*
 * `MultiFlow` con VARIOS documentos (prop `multi`): tabla «¿Quién firma qué?», copias, cobertura, «Deshacer» y paso de firma por bloques. El
 * anfitrion real (`DocumentSessionHost`) se sustituye por un arnes con el
 * mismo puente de sesion (`useSessionBridge`) y la misma vista derivada.
 */

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

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };

function makeFile(name: string, byte: number): File {
  return new File([new Uint8Array([byte, byte + 1, byte + 2, byte + 3])], name, {
    type: "application/pdf",
    lastModified: 1_700_000_000_000 + byte,
  });
}

const FILE_A = makeFile("Contrato A.pdf", 11);
const FILE_B = makeFile("Anexo.pdf", 22);
const FILE_C = makeFile("Acta.pdf", 33);
const FILES = [FILE_A, FILE_B, FILE_C];
const A = docIdOf(FILE_A);
const B = docIdOf(FILE_B);
const C = docIdOf(FILE_C);

const KEYS: Record<string, string> = {};

const SIG: SignatureDraft = { dataUrl: pngDataUrl({ seed: 3 }), ratio: 0.5 };
const OTHER: SignatureDraft = { dataUrl: pngDataUrl({ seed: 4 }), ratio: 0.5 };

function slot(id: string, signerId: string, type: SignatureField["type"] = "signature"): SignatureField {
  return {
    id,
    signerId,
    pageIndex: 0,
    type,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  };
}

beforeAll(async () => {
  for (const file of FILES) KEYS[docIdOf(file)] = await documentContentKey(file);
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

let restoreCanvas = () => {};
beforeEach(async () => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __resetSignPdfFeatureFlagsCacheForTests();
  restoreCanvas = installCanvasStubs();
  await clearVault();
});
afterEach(() => {
  restoreCanvas();
  vi.useRealTimers();
});

function docWith(fields: SignatureField[], docId: string): DocState {
  return { ...EMPTY_DOC_STATE, fields, sealedKey: KEYS[docId], textFieldsDetectedFor: KEYS[docId] };
}

function block(
  id: string,
  signerId: string,
  appliesTo: string[],
  extra: Partial<SignerBlock> = {},
): SignerBlock {
  return {
    id,
    signerId,
    appliesTo,
    signature: null,
    initials: null,
    stamps: {},
    auto: false,
    ...extra,
  };
}

/** Sesion de partida: 3 documentos, Ana y Luis, Ana firma en A y B, Luis en A. */
function baseSession(patch: Partial<SignSession> = {}): SignSession {
  return {
    ...DEFAULT_SESSION,
    mode: "multi",
    step: "signers",
    signers: [ANA, LUIS],
    activeSignerId: ANA.id,
    docs: {
      [A]: docWith([slot("a1", ANA.id), slot("a2", LUIS.id)], A),
      [B]: docWith([slot("b1", ANA.id)], B),
      [C]: docWith([], C),
    },
    docOrder: [A, B, C],
    activeDocId: A,
    signMode: "same",
    blocks: [
      block("bk-1", ANA.id, [A, B, C], { auto: true }),
      block("bk-2", LUIS.id, [A, B, C], { auto: true }),
    ],
    ...patch,
  };
}

function Arnes({
  files = FILES,
  initial,
  onSession,
  onFinish = () => {},
}: {
  files?: File[];
  initial: SignSession;
  onSession?: (session: SignSession) => void;
  onFinish?: () => void;
}) {
  const bridge = useSessionBridge();
  const [session, setSession] = useState<SignSession>(initial);
  const setShell = useCallback(
    (patch: Partial<SignSession>) => setSession((previous) => ({ ...previous, ...patch })),
    [],
  );
  useLayoutEffect(() => {
    bridge.sync(files, session, setShell);
    onSession?.(session);
  });
  const activeId = session.activeDocId ?? docIdOf(files[0]);
  const activeFile = files.find((file) => docIdOf(file) === activeId) ?? files[0];
  const view = viewOf(session, activeId);
  const setView = useCallback(
    (patch: Parameters<typeof applyViewPatch>[2]) => bridge.setView(activeId, patch),
    [bridge, activeId],
  );
  return (
    <LanguageProvider>
      <MultiFlow
        key={activeId}
        file={activeFile}
        options={view}
        setOptions={setView}
        onFinish={onFinish}
        strings={strings}
        multi={{ files, session, keys: KEYS, bridge }}
      />
    </LanguageProvider>
  );
}

async function settled() {
  await waitFor(() => expect(screen.queryByText(strings.checkingDocument)).toBeNull());
}

const announcement = () =>
  screen
    .getAllByRole("status")
    .map((node) => node.textContent ?? "")
    .join(" | ");

const asg = strings.assignment;
/** Celda (Ana/Luis, documento) por su nombre accesible: «Ana en Anexo: Firma A». */
const cellOf = (signer: string, doc: string, group: string | null) =>
  screen.getByRole("button", { name: asg.cellLabel(signer, doc, group) }) as HTMLButtonElement;
const tableShortcut = (label: string) => fireEvent.click(screen.getByRole("button", { name: label }));

describe("MultiFlow con varios documentos — tabla «¿Quién firma qué?» (sustituye a «Mismas / Distintas»)", () => {
  it("se ve con mas de un documento, sobre el paso Firmantes, con «Firma A» en todas las celdas y sin el control antiguo", async () => {
    render(<Arnes initial={baseSession()} />);
    await settled();
    expect(screen.getByRole("heading", { name: asg.title })).toBeTruthy();
    expect(screen.getByRole("grid", { name: asg.tableLabel })).toBeTruthy();
    for (const signer of ["Ana", "Luis"]) {
      for (const doc of ["Contrato A", "Anexo", "Acta"]) expect(cellOf(signer, doc, "Firma A")).toBeTruthy();
    }
    expect(screen.queryByRole("tab", { name: strings.signModeSame })).toBeNull();
    expect(screen.queryByRole("tab", { name: strings.signModeIndependent })).toBeNull();
  });

  it("con UN documento no hay tabla, ni bloques: la interfaz de siempre", async () => {
    render(
      <LanguageProvider>
        <MultiFlowOne />
      </LanguageProvider>,
    );
    await settled();
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.queryByText(/Aplica a:/)).toBeNull();
    expect(screen.queryByRole("button", { name: strings.blockAdd })).toBeNull();
  });

  it("no aparece en los otros pasos", async () => {
    render(<Arnes initial={baseSession({ step: "document" })} />);
    await settled();
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("«Una firma por documento» crea un bloque por (firmante, documento), deriva el modo y lo anuncia", async () => {
    let last = baseSession();
    render(<Arnes initial={baseSession()} onSession={(s) => (last = s)} />);
    await settled();
    tableShortcut(asg.shortcutPerDoc);
    await waitFor(() => expect(last.signMode).toBe("independent"));
    expect(last.blocks.filter((item) => item.signerId === ANA.id).map((item) => item.appliesTo)).toEqual([[A], [B], [C]]);
    expect(last.blocks.filter((item) => item.signerId === LUIS.id)).toHaveLength(3);
    expect(announcement()).toContain(asg.shortcutApplied(asg.shortcutPerDoc));
    expect(cellOf("Ana", "Acta", "Firma C")).toBeTruthy();
  });

  it("«Una firma para todos» sin trazos distintos fusiona sin pedir confirmacion", async () => {
    let last = baseSession({ signMode: "independent", blocks: [
      block("bk-1", ANA.id, [A]), block("bk-3", ANA.id, [B]), block("bk-4", ANA.id, [C]),
      block("bk-2", LUIS.id, [A, B, C], { auto: true }),
    ] });
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    tableShortcut(asg.shortcutAll);
    await waitFor(() => expect(last.signMode).toBe("same"));
    expect(last.blocks.filter((item) => item.signerId === ANA.id)).toHaveLength(1);
    expect(last.blocks.find((item) => item.signerId === ANA.id)!.appliesTo).toEqual([A, B, C]);
    expect(last.blocks.find((item) => item.signerId === ANA.id)!.auto).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  const differing = (): SignerBlock[] => [
    block("bk-1", ANA.id, [A], { signature: SIG, stamps: { [A]: "s1" } }),
    block("bk-3", ANA.id, [B], { signature: OTHER, stamps: { [B]: "s2" } }),
    block("bk-4", ANA.id, [C]),
    block("bk-2", LUIS.id, [A, B, C], { auto: true }),
  ];

  it("con trazos ya recogidos que se perderian pide confirmacion con la frase «Esto borrará la firma B de Ana…»", async () => {
    let last = baseSession({ signMode: "independent", blocks: differing() });
    const before = last.blocks;
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    tableShortcut(asg.shortcutAll);
    const dialog = await screen.findByRole("dialog", { name: asg.confirmTitle });
    expect(within(dialog).getByText(asg.lostLine("Firma B", "Ana", 1, ["signature"]))).toBeTruthy();
    // Mientras se decide, nada cambia.
    expect(last.blocks).toBe(before);
    fireEvent.click(within(dialog).getByRole("button", { name: asg.confirmCancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(last.blocks).toBe(before);
    expect(announcement()).toContain(asg.cancelled);
  });

  it("«Continuar» aplica el cambio y «Deshacer cambio» devuelve los bloques tal como estaban (con sus trazos)", async () => {
    let last = baseSession({ signMode: "independent", blocks: differing() });
    const before = last.blocks;
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    tableShortcut(asg.shortcutAll);
    const dialog = await screen.findByRole("dialog", { name: asg.confirmTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: asg.confirmContinue }));
    await waitFor(() => expect(last.signMode).toBe("same"));
    expect(last.blocks.filter((item) => item.signerId === ANA.id)).toHaveLength(1);
    expect(last.blocks.find((item) => item.signerId === ANA.id)!.signature).toEqual(SIG);
    fireEvent.click(screen.getByRole("button", { name: asg.undo }));
    await waitFor(() => expect(last.signMode).toBe("independent"));
    expect(last.blocks).toBe(before);
    expect(announcement()).toContain(asg.undone);
    expect(screen.queryByRole("button", { name: asg.undo })).toBeNull();
  });

  it("tocar una celda parte el grupo: «Ana en Acta» pasa de A a B (un bloque nuevo, sin firma) y se anuncia", async () => {
    let last = baseSession();
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(cellOf("Ana", "Acta", "Firma A"));
    await waitFor(() => expect(last.blocks.filter((item) => item.signerId === ANA.id)).toHaveLength(2));
    const ana = last.blocks.filter((item) => item.signerId === ANA.id);
    expect(ana[0].appliesTo).toEqual([A, B]);
    expect(ana[1].appliesTo).toEqual([C]);
    expect(ana[1].signature).toBeNull();
    expect(ana[0].auto).toBe(false);
    expect(announcement()).toContain(asg.cellChanged("Ana", "Acta", "Firma B"));
    expect(cellOf("Ana", "Acta", "Firma B")).toBeTruthy();
    // Luis no cambia.
    expect(cellOf("Luis", "Acta", "Firma A")).toBeTruthy();
  });

  it("tocar otra vez da «no firma» y otra mas vuelve a la firma A; la ultima celda de un firmante no se puede quitar", async () => {
    let last = baseSession();
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(cellOf("Ana", "Acta", "Firma A"));
    fireEvent.click(await screen.findByRole("button", { name: asg.cellLabel("Ana", "Acta", "Firma B") }));
    await screen.findByRole("button", { name: asg.cellLabel("Ana", "Acta", null) });
    expect(last.blocks.filter((item) => item.signerId === ANA.id).map((item) => item.appliesTo)).toEqual([[A, B]]);
    fireEvent.click(cellOf("Ana", "Acta", null));
    await screen.findByRole("button", { name: asg.cellLabel("Ana", "Acta", "Firma A") });
    expect(last.blocks.find((item) => item.signerId === ANA.id)!.appliesTo).toEqual([A, B, C]);

    // Ana con una sola celda con firma: tocarla no la quita.
    const only = baseSession({
      blocks: [block("bk-1", ANA.id, [A]), block("bk-2", LUIS.id, [A, B, C], { auto: true })],
    });
    cleanup();
    render(<Arnes initial={only} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(cellOf("Ana", "Contrato A", "Firma A"));
    expect(announcement()).toContain(asg.lastSignerCell("Ana"));
    expect(last.blocks.find((item) => item.signerId === ANA.id)!.appliesTo).toEqual([A]);
  });

  it("teclado: las flechas mueven el foco entre celdas, un solo punto de tabulacion y Enter alterna", async () => {
    let last = baseSession();
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    const grid = screen.getByRole("grid", { name: asg.tableLabel });
    const cells = within(grid).getAllByRole("button").filter((node) => node.hasAttribute("data-cell"));
    expect(cells.filter((node) => node.getAttribute("tabindex") === "0")).toHaveLength(1);
    const first = cellOf("Ana", "Contrato A", "Firma A");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cellOf("Luis", "Contrato A", "Firma A"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cellOf("Luis", "Anexo", "Firma A"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(cellOf("Ana", "Anexo", "Firma A"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(cellOf("Ana", "Contrato A", "Firma A"));
    // El foco rodante: solo la celda enfocada es tabulable.
    expect(within(grid).getAllByRole("button").filter((node) => node.getAttribute("tabindex") === "0")).toHaveLength(1);
    // Intro/Espacio los da el boton nativo: pulsa y cambia (la tabla es canonica: el grupo que se separa pasa a ser el «B»
    // si no abre la columna, y aqui la celda tocada es la primera, asi que las otras dos pasan a «B»).
    fireEvent.click(document.activeElement as HTMLElement);
    await screen.findByRole("button", { name: asg.cellLabel("Ana", "Anexo", "Firma B") });
    expect(cellOf("Ana", "Contrato A", "Firma A")).toBeTruthy();
  });

  it("las celdas miden 44 px y la tabla se convierte en tarjetas en pantalla estrecha (filas con clases `flex-col`/`sm:grid`)", async () => {
    render(<Arnes initial={baseSession()} />);
    await settled();
    const cell = cellOf("Ana", "Anexo", "Firma A");
    expect(cell.className).toContain("size-11");
    const row = cell.closest('[role="row"]') as HTMLElement;
    expect(row.className).toContain("flex-col");
    expect(row.className).toContain("sm:grid");
  });

  it("copias: «+» sube las de UN documento (se guardan en su estado) y el resumen cuenta los archivos", async () => {
    let last = baseSession();
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    expect(screen.getByText(asg.summaryFiles(3))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Anexo") }));
    await waitFor(() => expect(last.docs[B].copies).toBe(2));
    expect(last.docs[A].copies).toBeUndefined();
    expect(screen.getByText(asg.summaryFiles(4))).toBeTruthy();
    expect(announcement()).toContain(asg.copiesChanged("Anexo", 2));
    fireEvent.click(screen.getByRole("button", { name: asg.copiesLess("Anexo") }));
    await waitFor(() => expect(last.docs[B].copies).toBeUndefined());
  });

  it("«Copias de todos» pone las mismas copias en todos los documentos (3 documentos x 2 = 6 archivos)", async () => {
    let last = baseSession();
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(screen.getByRole("button", { name: asg.allCopiesMore }));
    await waitFor(() => expect([A, B, C].map((id) => last.docs[id].copies)).toEqual([2, 2, 2]));
    expect(screen.getByText(asg.summaryFiles(6))).toBeTruthy();
    expect(announcement()).toContain(asg.allCopiesChanged(2));
  });

  it("el tope de copias por documento (5) y de archivos (50) se dice y no se supera", async () => {
    let last = baseSession({
      docs: {
        ...baseSession().docs,
        [A]: { ...docWith([slot("a1", ANA.id), slot("a2", LUIS.id)], A), copies: 5 },
      },
    });
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Contrato A") }));
    expect(announcement()).toContain(asg.copiesAtMax(5));
    expect(last.docs[A].copies).toBe(5);
  });

  it("el contador de huecos de cada firmante suma todos los documentos", async () => {
    render(<Arnes initial={baseSession()} />);
    await settled();
    // Ana: a1 + b1 = 2 huecos; Luis: a2 = 1.
    expect(screen.getByText(strings.signerFieldCount(2))).toBeTruthy();
    expect(screen.getByText(strings.signerFieldCount(1))).toBeTruthy();
  });

  it("el resumen cuenta quien firma cuantos documentos y con cuantas firmas", async () => {
    let last = baseSession({
      signMode: "same",
      blocks: [
        block("bk-1", ANA.id, [A, B]),
        block("bk-3", ANA.id, [C]),
        block("bk-2", LUIS.id, [A], { auto: false }),
      ],
    });
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    expect(screen.getByText(asg.summarySigner("Ana", 3, [
      { letter: "A", docs: ["Contrato A", "Anexo"] },
      { letter: "B", docs: ["Acta"] },
    ]))).toBeTruthy();
    expect(screen.getByText(asg.summarySigner("Luis", 1, [{ letter: "A", docs: ["Contrato A"] }]))).toBeTruthy();
    expect(screen.getByText(asg.summaryFiles(3))).toBeTruthy();
  });

  it("un borrador antiguo en modo «distintas» se restaura con su tabla equivalente (A, B, C por documento)", async () => {
    render(
      <Arnes
        initial={baseSession({
          signMode: "independent",
          blocks: [
            block("bk-1", ANA.id, [A]), block("bk-3", ANA.id, [B]), block("bk-4", ANA.id, [C]),
            block("bk-2", LUIS.id, [A]), block("bk-5", LUIS.id, [B]), block("bk-6", LUIS.id, [C]),
          ],
        })}
      />,
    );
    await settled();
    expect(cellOf("Ana", "Contrato A", "Firma A")).toBeTruthy();
    expect(cellOf("Ana", "Anexo", "Firma B")).toBeTruthy();
    expect(cellOf("Luis", "Acta", "Firma C")).toBeTruthy();
  });
});

function MultiFlowOne() {
  const bridge = useSessionBridge();
  const [session, setSession] = useState<SignSession>(
    baseSession({
      docs: { [A]: docWith([], A) },
      docOrder: [A],
      blocks: [block("bk-1", ANA.id, [A], { auto: true }), block("bk-2", LUIS.id, [A], { auto: true })],
    }),
  );
  const setShell = useCallback(
    (patch: Partial<SignSession>) => setSession((previous) => ({ ...previous, ...patch })),
    [],
  );
  useLayoutEffect(() => {
    bridge.sync([FILE_A], session, setShell);
  });
  return (
    <MultiFlow
      file={FILE_A}
      options={viewOf(session, A)}
      setOptions={(patch) => bridge.setView(A, patch)}
      onFinish={() => {}}
      strings={strings}
    />
  );
}

describe("MultiFlow con varios documentos — huecos sin firmante (cobertura) en la tabla", () => {
  const holed = () =>
    baseSession({
      blocks: [
        block("bk-1", ANA.id, [A], { auto: false }),
        block("bk-2", LUIS.id, [A, B, C], { auto: true }),
      ],
    });
  const slotMessage = (signer: string, doc: string) =>
    asg.issue.slotWithoutSigner({ signer, doc, group: "", count: 0, max: 0, strokes: [] });

  it("un firmante con huecos en un documento sin grupo: mensaje bloqueante y «Ir a corregirlo» lleva el foco a su celda", async () => {
    render(<Arnes initial={holed()} />);
    await settled();
    expect(screen.getByText(slotMessage("Ana", "Anexo"))).toBeTruthy();
    const row = screen.getByText(slotMessage("Ana", "Anexo")).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: asg.fixIt }));
    expect(document.activeElement).toBe(cellOf("Ana", "Anexo", null));
  });

  it("tocar esa celda lo resuelve: el aviso desaparece y Ana firma Anexo con un grupo", async () => {
    let last = holed();
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(cellOf("Ana", "Anexo", null));
    await waitFor(() => expect(screen.queryByText(slotMessage("Ana", "Anexo"))).toBeNull());
    expect(last.blocks.filter((item) => item.signerId === ANA.id).map((item) => item.appliesTo)).toEqual([[A, B]]);
  });

  it("sin huecos en ese documento no hay aviso (Luis no firma Acta)", async () => {
    render(<Arnes initial={holed()} />);
    await settled();
    expect(screen.queryByText(slotMessage("Luis", "Acta"))).toBeNull();
    expect(screen.queryByText(slotMessage("Ana", "Acta"))).toBeNull();
  });

  it("la region de avisos esta siempre montada", async () => {
    render(<Arnes initial={baseSession()} />);
    await settled();
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1);
  });
});

describe("MultiFlow con varios documentos — quitar un firmante y «Deshacer»", () => {
  it("«Deshacer» devuelve al firmante CON sus bloques (alcance, trazos y sellos), no uno vacio", async () => {
    const withStrokes = baseSession({
      blocks: [
        block("bk-1", ANA.id, [A, B], { signature: SIG, stamps: { [A]: "x", [B]: "y" } }),
        block("bk-3", ANA.id, [C]),
        block("bk-2", LUIS.id, [A, B, C], { auto: true }),
      ],
    });
    let last = withStrokes;
    render(<Arnes initial={withStrokes} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(screen.getByRole("button", { name: strings.removeSigner("Ana") }));
    await waitFor(() => expect(last.signers.map((s) => s.id)).toEqual([LUIS.id]));
    expect(last.blocks.some((item) => item.signerId === ANA.id)).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: strings.undoRemoveSigner }));
    await waitFor(() => expect(last.signers.map((s) => s.id)).toEqual([ANA.id, LUIS.id]));
    const ana = last.blocks.filter((item) => item.signerId === ANA.id);
    expect(ana.map((item) => item.appliesTo)).toEqual([[A, B], [C]]);
    expect(ana[0].signature).toEqual(SIG);
    expect(ana[0].stamps).toEqual({ [A]: "x", [B]: "y" });
  });
});

describe("MultiFlow con varios documentos — paso Firmar por bloques", () => {
  const stamped = (): SignSession => {
    const session = baseSession({ step: "sign" });
    return session;
  };

  it("el paso Firmar usa la ceremonia por bloques, con el primer turno de Ana", async () => {
    render(<Arnes initial={stamped()} />);
    await settled();
    expect(screen.getByText(strings.turnOf(1, 2))).toBeTruthy();
    expect(screen.getByRole("heading", { name: strings.handoffTitle("Ana") })).toBeTruthy();
    // Resumen del alcance en el traspaso -> captura.
    fireEvent.click(screen.getAllByRole("button", { name: strings.handoffReady })[0]);
    expect(screen.getByText(asg.groupFor("Firma A", "Contrato A, Anexo, Acta"))).toBeTruthy();
  });

  it("firmar todo habilita «Aplicar y descargar» y lo ejecuta", async () => {
    const onFinish = vi.fn();
    // Acta tambien tiene un hueco de Ana: ningun documento queda sin nada que aplicar.
    const docs = {
      ...baseSession().docs,
      [C]: docWith([slot("c1", ANA.id)], C),
    };
    const ctx = { signers: [ANA, LUIS], docs, keys: KEYS };
    let blocks = baseSession().blocks;
    for (const id of ["bk-1", "bk-2"]) blocks = captureForBlock(blocks, id, { signature: SIG }, ctx);
    render(<Arnes initial={baseSession({ step: "sign", blocks, docs })} onFinish={onFinish} />);
    await settled();
    const finish = screen.getByRole("button", { name: strings.applyAndDownload }) as HTMLButtonElement;
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("falta firmar: queda desactivado y cuenta los firmantes pendientes", async () => {
    render(<Arnes initial={stamped()} />);
    await settled();
    const finish = screen.getByRole("button", { name: strings.applyAndDownload }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    expect(screen.getByText(strings.pendingBody(2))).toBeTruthy();
  });

  it("si un documento no tiene nada que aplicar, la entrega se bloquea con el motivo", async () => {
    const ctx = { signers: [ANA, LUIS], docs: baseSession().docs, keys: KEYS };
    let blocks = baseSession().blocks;
    for (const id of ["bk-1", "bk-2"]) blocks = captureForBlock(blocks, id, { signature: SIG }, ctx);
    render(<Arnes initial={baseSession({ step: "sign", blocks })} />);
    await settled();
    // Acta no tiene huecos ni campos rellenos.
    expect(screen.getByText(strings.batchDocEmpty("Acta"))).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: strings.applyAndDownload }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("el paso Firmar se abre en cuanto CUALQUIER documento tiene huecos (no solo el activo)", async () => {
    // Activo: C (sin huecos). A y B si tienen.
    render(<Arnes initial={baseSession({ activeDocId: C })} />);
    await settled();
    const sign = screen.getByRole("button", { name: `3. ${strings.stepSign}` }) as HTMLButtonElement;
    expect(sign.disabled).toBe(false);
  });

  it("sin huecos en ningun documento no se abre el paso Firmar", async () => {
    render(
      <Arnes
        initial={baseSession({
          docs: { [A]: docWith([], A), [B]: docWith([], B), [C]: docWith([], C) },
        })}
      />,
    );
    await settled();
    const sign = screen.getByRole("button", { name: `3. ${strings.stepSign}` }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true);
  });

  it("la ceremonia usa las huellas de TODOS los documentos: sin la de alguno espera", async () => {
    const withMissingKey = { ...KEYS, [B]: null as unknown as string };
    render(
      <LanguageProvider>
        <ArnesWithKeys keys={withMissingKey} initial={stamped()} />
      </LanguageProvider>,
    );
    expect((await screen.findAllByText(strings.checkingDocument)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: strings.handoffTitle("Ana") })).toBeNull();
  });
});

function ArnesWithKeys({
  keys,
  initial,
}: {
  keys: Record<string, string | null>;
  initial: SignSession;
}) {
  const bridge = useSessionBridge();
  const [session, setSession] = useState<SignSession>(initial);
  const setShell = useCallback(
    (patch: Partial<SignSession>) => setSession((previous) => ({ ...previous, ...patch })),
    [],
  );
  useLayoutEffect(() => {
    bridge.sync(FILES, session, setShell);
  });
  return (
    <MultiFlow
      file={FILE_A}
      options={viewOf(session, A)}
      setOptions={(patch) => bridge.setView(A, patch)}
      onFinish={() => {}}
      strings={strings}
      multi={{ files: FILES, session, keys, bridge }}
    />
  );
}

describe("MultiFlow con varios documentos — textos en ingles", () => {
  it("la tabla, los atajos y el resumen salen en ingles", async () => {
    const en = SIGN_STRINGS.en;
    function English() {
      const bridge = useSessionBridge();
      const [session, setSession] = useState<SignSession>(baseSession());
      const setShell = useCallback(
        (patch: Partial<SignSession>) => setSession((previous) => ({ ...previous, ...patch })),
        [],
      );
      useLayoutEffect(() => {
        bridge.sync(FILES, session, setShell);
      });
      return (
        <MultiFlow
          file={FILE_A}
          options={viewOf(session, A)}
          setOptions={(patch) => bridge.setView(A, patch)}
          onFinish={() => {}}
          strings={en}
          multi={{ files: FILES, session, keys: KEYS, bridge }}
        />
      );
    }
    render(
      <LanguageProvider>
        <English />
      </LanguageProvider>,
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: en.assignment.title })).toBeTruthy());
    expect(screen.getByRole("button", { name: en.assignment.shortcutAll })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.assignment.cellLabel("Ana", "Contrato A", "Signature A") })).toBeTruthy();
    expect(screen.getByText(en.assignment.summaryFiles(3))).toBeTruthy();
  });
});

