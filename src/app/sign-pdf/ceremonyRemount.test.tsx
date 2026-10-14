import "fake-indexeddb/auto";
import { useCallback, useLayoutEffect, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MultiFlow, type SignToolOptions } from "@/app/sign-pdf/SignToolClient";
import { captureForBlock, type CeremonyState } from "@/app/sign-pdf/blockModel";
import { captureStamp, type CaptureMap } from "@/app/sign-pdf/captures";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { EMPTY_DOC_STATE, docIdOf, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { DEFAULT_SESSION, applyViewPatch, viewOf, type SignSession } from "@/app/sign-pdf/signSession";
import { useSessionBridge } from "@/app/sign-pdf/useSessionBridge";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { clearVault } from "@/app/sign-pdf/signVault";
import { installCanvasStubs, pngDataUrl } from "@/app/sign-pdf/vaultTestUtils";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { detectFields } from "@/lib/pdf/detectFields";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/*
 * El turno de la ceremonia vive en la SESION (Fase 0 · U0.2, causa T1 de `docs/PLAN-FIRMA-AGIL.md`): en el
 * paso Firmar, tocar la pestana de otro documento remonta `MultiFlow` (`key={docId}`) y «Atras» -> «Continuar»
 * desmonta la ceremonia. Aqui se recorre eso con `MultiFlow` de verdad (el cableado `options.ceremony` ->
 * ceremonia -> `setOptions({ ceremony })` -> sesion), con varios documentos y con uno solo.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({ numPages: 2, getPage: async () => ({ cleanup: () => {} }) }),
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
const SIG: SignatureDraft = { dataUrl: pngDataUrl({ seed: 3 }), ratio: 0.5 };

function makeFile(name: string, byte: number): File {
  return new File([new Uint8Array([byte, byte + 1, byte + 2, byte + 3])], name, {
    type: "application/pdf",
    lastModified: 1_700_000_000_000 + byte,
  });
}
const FILE_A = makeFile("Contrato A.pdf", 11);
const FILE_B = makeFile("Anexo B.pdf", 22);
const FILES = [FILE_A, FILE_B];
const A = docIdOf(FILE_A);
const B = docIdOf(FILE_B);
const KEYS: Record<string, string> = {};

function slot(id: string, signerId: string): SignatureField {
  return {
    id,
    signerId,
    pageIndex: 0,
    type: "signature",
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
afterEach(() => restoreCanvas());

/* ------------------------------------------------------------------ *
 * Varios documentos: tocar la pestana de otro documento
 * ------------------------------------------------------------------ */

function docWith(fields: SignatureField[], docId: string): DocState {
  return { ...EMPTY_DOC_STATE, fields, sealedKey: KEYS[docId], textFieldsDetectedFor: KEYS[docId] };
}

function block(id: string, signerId: string, appliesTo: string[]): SignerBlock {
  return { id, signerId, appliesTo, signature: null, initials: null, stamps: {}, auto: true };
}

/** Dos documentos, Ana y Luis firman en los dos (un bloque por firmante para ambos). */
function twoDocsSession(patch: Partial<SignSession> = {}): SignSession {
  const docs = {
    [A]: docWith([slot("a1", ANA.id), slot("a2", LUIS.id)], A),
    [B]: docWith([slot("b1", ANA.id), slot("b2", LUIS.id)], B),
  };
  const ctx = { signers: [ANA, LUIS], docs, keys: KEYS };
  const blocks = captureForBlock(
    [block("bk-1", ANA.id, [A, B]), block("bk-2", LUIS.id, [A, B])],
    "bk-1",
    { signature: SIG },
    ctx,
  );
  return {
    ...DEFAULT_SESSION,
    mode: "multi",
    step: "sign",
    signers: [ANA, LUIS],
    activeSignerId: ANA.id,
    docs,
    docOrder: [A, B],
    activeDocId: A,
    signMode: "same",
    blocks,
    ...patch,
  };
}

function Arnes({
  initial,
  onSession,
}: {
  initial: SignSession;
  onSession?: (session: SignSession) => void;
}) {
  const bridge = useSessionBridge();
  const [session, setSession] = useState<SignSession>(initial);
  const setShell = useCallback(
    (patch: Partial<SignSession>) => setSession((previous) => ({ ...previous, ...patch })),
    [],
  );
  useLayoutEffect(() => {
    bridge.sync(FILES, session, setShell);
    onSession?.(session);
  });
  const activeId = session.activeDocId ?? A;
  const activeFile = FILES.find((file) => docIdOf(file) === activeId) ?? FILES[0];
  const view = viewOf(session, activeId);
  const setView = useCallback(
    (patch: Parameters<typeof applyViewPatch>[2]) => bridge.setView(activeId, patch),
    [bridge, activeId],
  );
  return (
    <LanguageProvider>
      {/* La pestana de documento del anfitrion real: cambia el documento activo. */}
      <button type="button" onClick={() => bridge.commit(() => ({ activeDocId: B }))}>
        pestana 2
      </button>
      <button type="button" onClick={() => bridge.commit(() => ({ activeDocId: A }))}>
        pestana 1
      </button>
      <MultiFlow
        key={activeId}
        file={activeFile}
        options={view}
        setOptions={setView}
        onFinish={() => {}}
        strings={strings}
        multi={{ files: FILES, session, keys: KEYS, bridge }}
      />
    </LanguageProvider>
  );
}

async function settled() {
  await waitFor(() => expect(screen.queryByText(strings.checkingDocument)).toBeNull());
}
const heading = (name: string) => screen.getByRole("heading", { name });
const goToTab = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const handoff = () => screen.getAllByRole("button", { name: strings.handoffReady })[0];

describe("paso Firmar con varios documentos — el turno sobrevive a tocar la pestana de otro documento", () => {
  it("tras el turno de Ana, cambiar de documento deja el turno de Luis (no vuelve a «Turno 1 de 2»)", async () => {
    let last: SignSession = DEFAULT_SESSION;
    // Ana ya firmo (bloque 1); el turno guardado es el suyo, como al terminar de recoger su firma.
    render(
      <Arnes
        initial={twoDocsSession({ ceremony: { signerId: ANA.id, stage: "handoff" } })}
        onSession={(session) => (last = session)}
      />,
    );
    await settled();
    fireEvent.click(handoff());
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect(last.ceremony).toEqual({ signerId: LUIS.id, stage: "handoff" });

    goToTab("pestana 2");
    await settled();
    expect(last.activeDocId).toBe(B);
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect(heading(strings.handoffTitle("Luis"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: strings.handoffTitle("Ana") })).toBeNull();

    // Y de vuelta al documento 1: igual.
    goToTab("pestana 1");
    await settled();
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
  });

  it("la etapa tambien sobrevive: captura de Luis abierta -> cambiar de documento -> sigue en su captura", async () => {
    render(<Arnes initial={twoDocsSession({ ceremony: { signerId: LUIS.id, stage: "handoff" } })} />);
    await settled();
    fireEvent.click(handoff());
    expect(heading(strings.captureTitle("Luis"))).toBeTruthy();
    goToTab("pestana 2");
    await settled();
    expect(heading(strings.captureTitle("Luis"))).toBeTruthy();
  });

  it("sin turno guardado y con Ana ya firmada, el paso arranca en Luis y cambiar de documento no cambia eso", async () => {
    render(<Arnes initial={twoDocsSession()} />);
    await settled();
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    goToTab("pestana 2");
    await settled();
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect(heading(strings.handoffTitle("Luis"))).toBeTruthy();
  });

  it("«Atras» -> «Continuar» conserva el turno en el paso Firmar", async () => {
    let last: SignSession = DEFAULT_SESSION;
    render(
      <Arnes
        initial={twoDocsSession({ ceremony: { signerId: LUIS.id, stage: "capture" } })}
        onSession={(session) => (last = session)}
      />,
    );
    await settled();
    expect(heading(strings.captureTitle("Luis"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.back }));
    await waitFor(() => expect(last.step).toBe("document"));
    expect(screen.queryByRole("heading", { name: strings.captureTitle("Luis") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.next }));
    await waitFor(() => expect(last.step).toBe("sign"));
    expect(heading(strings.captureTitle("Luis"))).toBeTruthy();
    expect(last.ceremony).toEqual({ signerId: LUIS.id, stage: "capture" });
  });
});

/* ------------------------------------------------------------------ *
 * Un documento: «Atras» -> «Continuar» (SigningCeremony)
 * ------------------------------------------------------------------ */

const SOLO = makeFile("contrato.pdf", 5);
let SOLO_KEY = "";
beforeAll(async () => {
  SOLO_KEY = await documentContentKey(SOLO);
});

function soloField(id: string, signerId: string): SignatureField {
  return slot(id, signerId);
}

function soloOptions(captures: CaptureMap, ceremony?: CeremonyState | null): SignToolOptions {
  return {
    mode: "multi",
    signaturePng: "",
    ratio: 0,
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    signature: SOLO_KEY,
    step: "sign",
    signers: [ANA, LUIS],
    fields: [soloField("f1", ANA.id), soloField("f2", LUIS.id)],
    captures,
    activeSignerId: ANA.id,
    fieldPageIndex: 0,
    selectedFieldId: null,
    placementTool: "select",
    textFields: [],
    textValues: {},
    selectedTextFieldId: null,
    editingTextFieldId: null,
    textFieldsDetectedFor: SOLO_KEY,
    ceremony,
  };
}

function SoloFlow({
  captures,
  ceremony,
  onOptions,
}: {
  captures: CaptureMap;
  ceremony?: CeremonyState | null;
  onOptions?: (options: SignToolOptions) => void;
}) {
  const [options, setOptions] = useState<SignToolOptions>(() => soloOptions(captures, ceremony));
  const patch = useCallback(
    (next: Partial<SignToolOptions>) => setOptions((previous) => ({ ...previous, ...next })),
    [],
  );
  useLayoutEffect(() => {
    onOptions?.(options);
  });
  return (
    <LanguageProvider>
      <MultiFlow file={SOLO} options={options} setOptions={patch} onFinish={() => {}} strings={strings} />
    </LanguageProvider>
  );
}

describe("paso Firmar con un documento — «Atras» -> «Continuar» no reinicia el turno", () => {
  /** Se calcula al usarla: la huella del documento llega en `beforeAll`, despues de definir las pruebas. */
  const anaDoneCaptures = (): CaptureMap => ({
    [ANA.id]: {
      signature: SIG,
      initials: null,
      stamp: captureStamp(SOLO_KEY, [soloField("f1", ANA.id), soloField("f2", LUIS.id)], ANA.id),
    },
  });

  it("tras el turno de Ana sigue el de Luis despues de ir «Atras» y volver", async () => {
    let last: SignToolOptions | null = null;
    render(
      <SoloFlow
        captures={anaDoneCaptures()}
        ceremony={{ signerId: ANA.id, stage: "handoff" }}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();
    fireEvent.click(handoff());
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect((last as SignToolOptions | null)?.ceremony).toEqual({ signerId: LUIS.id, stage: "handoff" });

    fireEvent.click(screen.getByRole("button", { name: strings.back }));
    await waitFor(() => expect((last as SignToolOptions | null)?.step).toBe("document"));
    fireEvent.click(screen.getByRole("button", { name: strings.next }));
    await waitFor(() => expect((last as SignToolOptions | null)?.step).toBe("sign"));
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect(heading(strings.handoffTitle("Luis"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: strings.handoffTitle("Ana") })).toBeNull();
  });

  it("sin turno guardado, con Ana firmada, la ceremonia arranca en Luis tambien en un documento", async () => {
    render(<SoloFlow captures={anaDoneCaptures()} />);
    await settled();
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect(heading(strings.handoffTitle("Luis"))).toBeTruthy();
  });
});
