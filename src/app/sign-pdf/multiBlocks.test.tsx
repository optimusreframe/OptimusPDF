import "fake-indexeddb/auto";
import { useCallback, useLayoutEffect, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
 * `MultiFlow` con VARIOS documentos (prop `multi`): control mismas/distintas,
 * bloques por firmante, cobertura, «Deshacer» y paso de firma por bloques. El
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

configure({ asyncUtilTimeout: 5000 });

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

const modeTab = (label: string) => screen.getByRole("tab", { name: label });
const announcement = () =>
  screen
    .getAllByRole("status")
    .map((node) => node.textContent ?? "")
    .join(" | ");

describe("MultiFlow con varios documentos — control «mismas / distintas»", () => {
  it("se ve con mas de un documento, sobre el paso Firmantes, con «Mismas firmas» elegido", async () => {
    render(<Arnes initial={baseSession()} />);
    await settled();
    expect(modeTab(strings.signModeSame).getAttribute("aria-selected")).toBe("true");
    expect(modeTab(strings.signModeIndependent).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText(strings.signModeSameHint)).toBeTruthy();
  });

  it("con UN documento no hay control, ni bloques: la interfaz de siempre", async () => {
    render(
      <LanguageProvider>
        <MultiFlowOne />
      </LanguageProvider>,
    );
    await settled();
    expect(screen.queryByRole("tab", { name: strings.signModeSame })).toBeNull();
    expect(screen.queryByText(/Aplica a:/)).toBeNull();
    expect(screen.queryByRole("button", { name: strings.blockAdd })).toBeNull();
  });

  it("no aparece en los otros pasos", async () => {
    render(<Arnes initial={baseSession({ step: "document" })} />);
    await settled();
    expect(screen.queryByRole("tab", { name: strings.signModeSame })).toBeNull();
  });

  it("pasar a «distintas» crea un bloque por (firmante, documento) y lo anuncia", async () => {
    let last = baseSession();
    render(<Arnes initial={baseSession()} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(modeTab(strings.signModeIndependent));
    await waitFor(() => expect(last.signMode).toBe("independent"));
    expect(last.blocks.filter((item) => item.signerId === ANA.id).map((item) => item.appliesTo)).toEqual([
      [A],
      [B],
      [C],
    ]);
    expect(last.blocks.filter((item) => item.signerId === LUIS.id)).toHaveLength(3);
    expect(announcement()).toContain(strings.signModeChangedIndependent);
    expect(screen.getByText(strings.signModeIndependentHint)).toBeTruthy();
    // Cada tarjeta de firmante pinta ahora sus 3 bloques.
    const ana = screen.getByRole("group", { name: strings.signerBlocksLabel("Ana") });
    expect(within(ana).getAllByText(/^Bloque \d$/)).toHaveLength(3);
  });

  it("volver a «mismas» sin trazos distintos fusiona sin ofrecer deshacer", async () => {
    let last = baseSession();
    render(<Arnes initial={baseSession()} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(modeTab(strings.signModeIndependent));
    await waitFor(() => expect(last.signMode).toBe("independent"));
    fireEvent.click(modeTab(strings.signModeSame));
    await waitFor(() => expect(last.signMode).toBe("same"));
    expect(last.blocks.filter((item) => item.signerId === ANA.id)).toHaveLength(1);
    expect(last.blocks.find((item) => item.signerId === ANA.id)!.appliesTo).toEqual([A, B, C]);
    expect(screen.queryByRole("button", { name: strings.undoSignMode })).toBeNull();
    expect(announcement()).toContain(strings.signModeChangedSame);
  });

  const differing = (): SignerBlock[] => [
    block("bk-1", ANA.id, [A], { signature: SIG, stamps: { [A]: "s1" } }),
    block("bk-3", ANA.id, [B], { signature: OTHER, stamps: { [B]: "s2" } }),
    block("bk-4", ANA.id, [C]),
    block("bk-2", LUIS.id, [A, B, C], { auto: true }),
  ];

  it("de «distintas» a «mismas» con trazos DISTINTOS avisa de lo descartado y ofrece «Deshacer»", async () => {
    let last = baseSession();
    render(
      <Arnes
        initial={baseSession({ signMode: "independent", blocks: differing() })}
        onSession={(s) => (last = s)}
      />,
    );
    await settled();
    fireEvent.click(modeTab(strings.signModeSame));
    await waitFor(() => expect(last.signMode).toBe("same"));
    expect(screen.getByText(strings.signModeMergedNotice(1))).toBeTruthy();
    expect(last.blocks.filter((item) => item.signerId === ANA.id)).toHaveLength(1);
    expect(last.blocks.find((item) => item.signerId === ANA.id)!.signature).toEqual(SIG);
  });

  it("«Deshacer» devuelve el modo y los bloques tal como estaban (con sus trazos distintos)", async () => {
    let last = baseSession();
    const before = differing();
    render(
      <Arnes
        initial={baseSession({ signMode: "independent", blocks: before })}
        onSession={(s) => (last = s)}
      />,
    );
    await settled();
    fireEvent.click(modeTab(strings.signModeSame));
    fireEvent.click(await screen.findByRole("button", { name: strings.undoSignMode }));
    await waitFor(() => expect(last.signMode).toBe("independent"));
    expect(last.blocks).toBe(before);
    expect(announcement()).toContain(strings.signModeRestored);
    expect(screen.queryByRole("button", { name: strings.undoSignMode })).toBeNull();
  });

  it("tras «Deshacer» el foco vuelve al segmento del modo recuperado, no a <body>", async () => {
    render(
      <Arnes initial={baseSession({ signMode: "independent", blocks: differing() })} />,
    );
    await settled();
    fireEvent.click(modeTab(strings.signModeSame));
    const undo = await screen.findByRole("button", { name: strings.undoSignMode });
    undo.focus();
    fireEvent.click(undo);
    await waitFor(() =>
      expect(modeTab(strings.signModeIndependent).getAttribute("aria-selected")).toBe("true"),
    );
    expect(document.activeElement).toBe(modeTab(strings.signModeIndependent));
  });

  it("el «Deshacer» dura 6 s y despues desaparece", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <Arnes initial={baseSession({ signMode: "independent", blocks: differing() })} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    fireEvent.click(modeTab(strings.signModeSame));
    expect(screen.getByRole("button", { name: strings.undoSignMode })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5900);
    });
    expect(screen.getByRole("button", { name: strings.undoSignMode })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.queryByRole("button", { name: strings.undoSignMode })).toBeNull();
  });

  it("si despues de fusionar se edita el alcance de un bloque, «Deshacer» ya no se ofrece (pisaria ese trabajo)", async () => {
    render(
      <Arnes initial={baseSession({ signMode: "independent", blocks: differing() })} />,
    );
    await settled();
    fireEvent.click(modeTab(strings.signModeSame));
    await screen.findByRole("button", { name: strings.undoSignMode });
    fireEvent.click(screen.getByRole("button", { name: strings.blockAddFor("Ana") }));
    await waitFor(() => expect(screen.queryByRole("button", { name: strings.undoSignMode })).toBeNull());
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

describe("MultiFlow con varios documentos — bloques de cada firmante", () => {
  it("cada firmante muestra «Bloque 1 · Aplica a: Todos (3)»", async () => {
    render(<Arnes initial={baseSession()} />);
    await settled();
    for (const name of ["Ana", "Luis"]) {
      const group = screen.getByRole("group", { name: strings.signerBlocksLabel(name) });
      expect(within(group).getByText("Bloque 1")).toBeTruthy();
      expect(within(group).getByText(strings.blockAppliesTo("Todos (3)"))).toBeTruthy();
    }
  });

  it("el contador de huecos de cada firmante suma todos los documentos", async () => {
    render(<Arnes initial={baseSession()} />);
    await settled();
    // Ana: a1 + b1 = 2 huecos; Luis: a2 = 1.
    expect(screen.getByText(strings.signerFieldCount(2))).toBeTruthy();
    expect(screen.getByText(strings.signerFieldCount(1))).toBeTruthy();
  });

  it("«Cambiar» abre la hoja de alcance, aplica y anuncia el nuevo alcance", async () => {
    let last = baseSession();
    render(<Arnes initial={baseSession()} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(screen.getByRole("button", { name: strings.blockChangeScopeFor("Bloque 1", "Ana") }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Acta" }));
    fireEvent.click(screen.getByRole("button", { name: strings.scopeApply }));
    await waitFor(() => expect(last.blocks.find((item) => item.id === "bk-1")!.appliesTo).toEqual([A, B]));
    expect(last.blocks.find((item) => item.id === "bk-1")!.auto).toBe(false);
    expect(announcement()).toContain(strings.blockScopeUpdated("Bloque 1", "Contrato A, Anexo"));
    // El documento que se quedo sin bloque de Ana es una cobertura a resolver solo si ella tiene huecos alli (no: Acta no tiene).
    expect(screen.queryByText(strings.coverageMissing("Ana", "Acta"))).toBeNull();
  });

  it("un documento marcado en otro bloque del mismo firmante cambia de bloque y se anuncia", async () => {
    let last = baseSession({
      signMode: "independent",
      blocks: [
        block("bk-1", ANA.id, [A, B]),
        block("bk-3", ANA.id, [C]),
        block("bk-2", LUIS.id, [A, B, C], { auto: true }),
      ],
    });
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    fireEvent.click(screen.getByRole("button", { name: strings.blockChangeScopeFor("Bloque 2", "Ana") }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Anexo" }));
    expect(screen.getByText(strings.scopeMovePreview("Anexo", 1))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.scopeApply }));
    await waitFor(() =>
      expect(last.blocks.find((item) => item.id === "bk-3")!.appliesTo).toEqual([B, C]),
    );
    expect(last.blocks.find((item) => item.id === "bk-1")!.appliesTo).toEqual([A]);
    expect(announcement()).toContain(strings.blockScopeMoved("Anexo", 1, 2));
  });

  it("«Añadir bloque» parte el bloque ancho, anuncia el bloque nuevo y lleva el foco a su «Cambiar»", async () => {
    let last = baseSession();
    render(<Arnes initial={baseSession()} onSession={(s) => (last = s)} />);
    await settled();
    const add = screen.getAllByRole("button", { name: strings.blockAddFor("Ana") })[0];
    add.focus();
    fireEvent.click(add);
    await waitFor(() => expect(last.blocks.filter((item) => item.signerId === ANA.id)).toHaveLength(2));
    const ana = last.blocks.filter((item) => item.signerId === ANA.id);
    expect(ana[0].appliesTo).toEqual([A, B]);
    expect(ana[1].appliesTo).toEqual([C]);
    expect(announcement()).toContain(strings.blockAdded("Ana", 2));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: strings.blockChangeScopeFor("Bloque 2", "Ana") }),
      ),
    );
  });

  it("con cada documento en su propio bloque, «Añadir bloque» queda desactivado y lo explica", async () => {
    render(
      <Arnes
        initial={baseSession({
          signMode: "independent",
          blocks: [
            block("bk-1", ANA.id, [A]),
            block("bk-3", ANA.id, [B]),
            block("bk-4", ANA.id, [C]),
            block("bk-2", LUIS.id, [A, B, C], { auto: true }),
          ],
        })}
      />,
    );
    await settled();
    const anaGroup = screen.getByRole("group", { name: strings.signerBlocksLabel("Ana") });
    expect(
      (within(anaGroup).getByRole("button", { name: strings.blockAddFor("Ana") }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(anaGroup).getByText(strings.blockAddFull)).toBeTruthy();
  });

  it("«Quitar bloque» solo existe cuando hay mas de uno; pasa sus documentos al anterior, lo anuncia y devuelve el foco", async () => {
    let last = baseSession({
      blocks: [
        block("bk-1", ANA.id, [A, B]),
        block("bk-3", ANA.id, [C]),
        block("bk-2", LUIS.id, [A, B, C], { auto: true }),
      ],
    });
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    expect(screen.queryByRole("button", { name: strings.blockRemoveFor("Bloque 1", "Luis") })).toBeNull();
    const remove = screen.getByRole("button", { name: strings.blockRemoveFor("Bloque 2", "Ana") });
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(last.blocks.filter((item) => item.signerId === ANA.id)).toHaveLength(1));
    expect(last.blocks.find((item) => item.signerId === ANA.id)!.appliesTo).toEqual([A, B, C]);
    expect(announcement()).toContain(strings.blockRemoved(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: strings.blockAddFor("Ana") })),
    );
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("MultiFlow con varios documentos — cobertura", () => {
  const holed = () =>
    baseSession({
      blocks: [
        block("bk-1", ANA.id, [A], { auto: false }),
        block("bk-2", LUIS.id, [A, B, C], { auto: true }),
      ],
    });

  it("un firmante con huecos en un documento sin bloque: mensaje bloqueante y boton para anadirlo", async () => {
    let last = holed();
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    expect(screen.getByText(strings.coverageMissing("Ana", "Anexo"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.coverageAddBlock("Anexo") }));
    await waitFor(() =>
      expect(screen.queryByText(strings.coverageMissing("Ana", "Anexo"))).toBeNull(),
    );
    expect(last.blocks.filter((item) => item.signerId === ANA.id).map((item) => item.appliesTo)).toEqual([
      [A],
      [B],
    ]);
  });

  it("con cobertura pendiente «Añadir bloque» sigue disponible y NO dice que cada documento ya tiene el suyo", async () => {
    let last = holed();
    render(<Arnes initial={last} onSession={(s) => (last = s)} />);
    await settled();
    const group = screen.getByRole("group", { name: strings.signerBlocksLabel("Ana") });
    const add = within(group).getByRole("button", { name: strings.blockAddFor("Ana") }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    expect(within(group).queryByText(strings.blockAddFull)).toBeNull();
    fireEvent.click(add);
    await waitFor(() =>
      expect(last.blocks.filter((item) => item.signerId === ANA.id).map((item) => item.appliesTo)).toEqual([
        [A],
        [B],
      ]),
    );
  });

  it("tras «Añadir bloque para X» el foco va al «Cambiar» del bloque nuevo, no a <body>", async () => {
    render(<Arnes initial={holed()} />);
    await settled();
    const button = screen.getByRole("button", { name: strings.coverageAddBlock("Anexo") });
    button.focus();
    fireEvent.click(button);
    const change = await screen.findByRole("button", {
      name: strings.blockChangeScopeFor("Bloque 2", "Ana"),
    });
    await waitFor(() => expect(document.activeElement).toBe(change));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("sin huecos en ese documento no hay aviso (Luis no firma Acta)", async () => {
    render(<Arnes initial={holed()} />);
    await settled();
    expect(screen.queryByText(strings.coverageMissing("Luis", "Acta"))).toBeNull();
    expect(screen.queryByText(strings.coverageMissing("Ana", "Acta"))).toBeNull();
  });

  it("la region de avisos esta siempre montada", async () => {
    render(<Arnes initial={baseSession()} />);
    await settled();
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(2);
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
    expect(screen.getByText(strings.blockAppliesTo("Todos (3)"))).toBeTruthy();
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
  it("el control y los bloques salen en ingles", async () => {
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
    await waitFor(() => expect(screen.getByRole("tab", { name: en.signModeSame })).toBeTruthy());
    expect(screen.getByRole("tab", { name: en.signModeIndependent })).toBeTruthy();
    expect(screen.getAllByText(en.blockAppliesTo("All (3)")).length).toBe(2);
  });
});

