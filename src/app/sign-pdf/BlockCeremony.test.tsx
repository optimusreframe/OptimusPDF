import "fake-indexeddb/auto";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BlockCeremony } from "@/app/sign-pdf/BlockCeremony";
import {
  captureForBlock,
  isBlockComplete,
  type BlockContext,
  type CeremonyState,
  type DocRef,
} from "@/app/sign-pdf/blockModel";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { captureStamp } from "@/app/sign-pdf/captures";
import {
  clearVault,
  listVault,
  saveVaultEntry,
  vaultImageToDataUrl,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import {
  installCanvasStubs,
  pngDataUrl,
  vaultInput,
} from "@/app/sign-pdf/vaultTestUtils";
import {
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
} from "@/app/sign-pdf/signFeatureFlags";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import type { SignatureField, Signer } from "@/lib/pdf/sign";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";

/*
 * Ceremonia por BLOQUES (Wave 4 · U3). El foco de cada etapa se comprueba
 * contra el elemento real (`document.activeElement`) y cada test de foco falla
 * si se quita `useCeremonyFocus` (se comprobo a mano: ver el informe de la
 * unidad).
 */

const touchSpy = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/app/sign-pdf/signVault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/sign-pdf/signVault")>();
  return {
    ...actual,
    touchVaultEntry: (id: string) => {
      touchSpy.calls.push(id);
      return actual.touchVaultEntry(id);
    },
  };
});

const strings = SIGN_STRINGS.es;

const ANA: Signer = { id: "sg-1", name: "Ana Pérez", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const SOLO_FIRMA: Signer = { id: "sg-3", name: "Eva", color: "#e11d48" };

const A = "doc-a";
const B = "doc-b";
const C = "doc-c";
const DOCS: DocRef[] = [
  { id: A, name: "Contrato A.pdf" },
  { id: B, name: "Anexo.pdf" },
  { id: C, name: "Acta.pdf" },
];
const KEYS = { [A]: "key-a", [B]: "key-b", [C]: "key-c" };

function slot(
  id: string,
  signerId: string,
  type: SignatureField["type"] = "signature",
): SignatureField {
  return {
    id,
    signerId,
    pageIndex: 0,
    type,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  };
}

function docState(fields: SignatureField[]): DocState {
  return { ...EMPTY_DOC_STATE, fields };
}

/** Ana firma e inicia en A, firma en B y C; Luis firma en A y B. */
const DOC_STATES = {
  [A]: docState([slot("a1", ANA.id), slot("a2", ANA.id, "initials"), slot("a3", LUIS.id)]),
  [B]: docState([slot("b1", ANA.id), slot("b2", LUIS.id)]),
  [C]: docState([slot("c1", ANA.id)]),
};

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

const SAME_BLOCKS = [block("bk-1", ANA.id, [A, B, C], { auto: true }), block("bk-2", LUIS.id, [A, B], { auto: true })];
const SPLIT_BLOCKS = [
  block("bk-1", ANA.id, [A, B]),
  block("bk-3", ANA.id, [C]),
  block("bk-2", LUIS.id, [A, B], { auto: true }),
];

const DRAFT: SignatureDraft = { dataUrl: pngDataUrl({ seed: 5 }), ratio: 0.5 };
const INITIALS: SignatureDraft = { dataUrl: pngDataUrl({ width: 20, height: 20, seed: 6 }), ratio: 1 };

function ctxOf(
  docStates: Record<string, DocState> = DOC_STATES,
  keys: Record<string, string | null> = KEYS,
  signers: Signer[] = [ANA, LUIS],
): BlockContext {
  return { signers, docs: docStates, keys };
}

/**
 * El turno de la ceremonia se DERIVA del primer firmante pendiente al montar (Fase 0 · U0.2): con Ana ya
 * firmada, una ronda recien montada arranca en Luis. Las pruebas que recorren el turno de Ana con sus
 * trazos precargados lo declaran con el turno guardado explicito (el que antes era el inicio implicito).
 */
const ANA_TURN: CeremonyState = { signerId: ANA.id, stage: "handoff" };
const LUIS_TURN: CeremonyState = { signerId: LUIS.id, stage: "handoff" };

type HarnessProps = {
  /** Turno guardado inicial; con valor, la ceremonia va CONTROLADA (como en la sesion real). */
  ceremony?: CeremonyState | null;
  blocks?: SignerBlock[];
  docs?: DocRef[];
  docStates?: Record<string, DocState>;
  keys?: Record<string, string | null>;
  signers?: Signer[];
  blocked?: boolean;
  blockerMessages?: string[];
  onFinish?: () => void;
  onBlocks?: (blocks: SignerBlock[]) => void;
};

function Harness({
  ceremony: initialCeremony,
  blocks: initial = SAME_BLOCKS,
  docs = DOCS,
  docStates = DOC_STATES,
  keys = KEYS,
  signers = [ANA, LUIS],
  blocked = false,
  blockerMessages = [],
  onFinish = () => {},
  onBlocks,
}: HarnessProps) {
  const [blocks, setBlocks] = useState(initial);
  const [turn, setTurn] = useState<CeremonyState | null>(initialCeremony ?? null);
  return (
    <LanguageProvider>
      <BlockCeremony
        {...(initialCeremony !== undefined ? { ceremony: turn, onCeremonyChange: setTurn } : {})}
        signers={signers}
        docs={docs}
        docStates={docStates}
        keys={keys}
        blocks={blocks}
        onBlocksChange={(next) => {
          setBlocks(next);
          onBlocks?.(next);
        }}
        blockerMessages={blockerMessages}
        blocked={blocked}
        onFinish={onFinish}
        strings={strings}
      />
    </LanguageProvider>
  );
}

/** Bloques de `initial` ya firmados (firma e iniciales donde se exigen). */
function signed(
  initial: SignerBlock[],
  ids: string[],
  docStates = DOC_STATES,
): SignerBlock[] {
  const ctx = ctxOf(docStates);
  let blocks = initial;
  for (const id of ids) {
    blocks = captureForBlock(blocks, id, { signature: DRAFT, initials: INITIALS }, ctx);
  }
  return blocks;
}

let restoreCanvas = () => {};

beforeEach(async () => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __resetSignPdfFeatureFlagsCacheForTests();
  restoreCanvas = installCanvasStubs();
  touchSpy.calls.length = 0;
  await clearVault();
});
afterEach(() => restoreCanvas());

async function seed(
  name: string,
  overrides: Parameters<typeof vaultInput>[1] = {},
): Promise<VaultEntry> {
  const result = await saveVaultEntry(vaultInput(name, overrides));
  if (!result.ok) throw new Error("no se pudo sembrar el baul");
  return result.entry;
}

const ready = () => screen.getAllByRole("button", { name: strings.handoffReady })[0];
const toCapture = () => fireEvent.click(ready());
const heading = (name: string | RegExp) => screen.getByRole("heading", { name });
const finish = () =>
  screen.getByRole("button", { name: strings.applyAndDownload }) as HTMLButtonElement;

describe("BlockCeremony — arranque y turnos", () => {
  it("mientras falte la huella de algun documento espera con el aviso y sin arrancar la ronda", () => {
    render(<Harness keys={{ ...KEYS, [B]: null }} />);
    expect(screen.getByText(strings.checkingDocument)).toBeTruthy();
    expect(screen.queryByText(strings.handoffReady)).toBeNull();
  });

  it("el primer turno es de Ana y se anuncia «Turno 1 de 2»", () => {
    render(<Harness />);
    expect(screen.getByText(strings.turnOf(1, 2))).toBeTruthy();
    expect(heading(strings.handoffTitle("Ana Pérez"))).toBeTruthy();
  });

  it("un firmante sin huecos en ningun documento no tiene turno", () => {
    render(<Harness signers={[ANA, LUIS, SOLO_FIRMA]} blocks={[...SAME_BLOCKS, block("bk-9", SOLO_FIRMA.id, [A, B, C])]} />);
    expect(screen.getByText(strings.turnOf(1, 2))).toBeTruthy();
    expect(screen.queryByText("Eva")).toBeNull();
  });

  it("«Estoy listo» abre la captura de Ana con una fila por tipo exigido (firma e iniciales)", () => {
    render(<Harness />);
    toCapture();
    expect(heading(strings.captureTitle("Ana Pérez"))).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.captureSignature })).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.captureInitials })).toBeTruthy();
  });

  it("con un solo bloque no hay encabezado «Bloque 1» pero si el resumen «Aplica a: Todos (3)»", () => {
    render(<Harness />);
    toCapture();
    expect(screen.queryByText("Bloque 1")).toBeNull();
    expect(screen.getByText(strings.blockAppliesTo("Todos (3)"))).toBeTruthy();
  });

  it("con varios bloques cada uno lleva su encabezado y su resumen de alcance", () => {
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    const first = screen.getByRole("listitem", { name: "Bloque 1" });
    const second = screen.getByRole("listitem", { name: "Bloque 2" });
    expect(within(first).getByText(strings.blockAppliesTo("Contrato A, Anexo"))).toBeTruthy();
    expect(within(second).getByText(strings.blockAppliesTo("Acta"))).toBeTruthy();
    // El bloque 2 solo exige firma (Ana no tiene iniciales en Acta).
    expect(within(second).queryByRole("button", { name: /Crear iniciales/ })).toBeNull();
    expect(within(first).getByRole("button", { name: `${strings.captureInitials} · Bloque 1` })).toBeTruthy();
  });

  it("«Continuar» solo se habilita con TODOS los bloques del firmante completos", () => {
    const continueButton = () =>
      screen.getByRole("button", { name: strings.captureContinue }) as HTMLButtonElement;
    const none = render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    expect(continueButton().disabled).toBe(true);
    none.unmount();

    const one = render(<Harness blocks={signed(SPLIT_BLOCKS, ["bk-1"])} />);
    toCapture();
    expect(continueButton().disabled).toBe(true);
    one.unmount();

    render(<Harness ceremony={ANA_TURN} blocks={signed(SPLIT_BLOCKS, ["bk-1", "bk-3"])} />);
    toCapture();
    expect(continueButton().disabled).toBe(false);
  });
});

describe("BlockCeremony — foco al cambiar de etapa y de turno (no se pierde en <body>)", () => {
  it("al montar NO roba el foco", () => {
    render(<Harness />);
    expect(document.activeElement).toBe(document.body);
  });

  it("«Estoy listo»: el foco va al encabezado de la captura, no a <body>", () => {
    render(<Harness />);
    toCapture();
    const h = heading(strings.captureTitle("Ana Pérez"));
    expect(h.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(h);
  });

  it("«Continuar»: el foco va al encabezado de la revision", () => {
    render(<Harness ceremony={ANA_TURN} blocks={signed(SAME_BLOCKS, ["bk-1"])} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    expect(document.activeElement).toBe(heading(strings.reviewTitle("Ana Pérez")));
  });

  it("«Rehacer» en la revision devuelve el foco al encabezado de la captura", () => {
    render(<Harness ceremony={ANA_TURN} blocks={signed(SAME_BLOCKS, ["bk-1"])} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    fireEvent.click(screen.getByRole("button", { name: strings.reviewRedo }));
    expect(document.activeElement).toBe(heading(strings.captureTitle("Ana Pérez")));
  });

  it("«Siguiente» lleva el foco al traspaso del siguiente firmante", () => {
    // Luis aun no ha firmado: el siguiente turno es el suyo (a quien ya firmo no se le pasa el dispositivo).
    render(<Harness ceremony={ANA_TURN} blocks={signed(SAME_BLOCKS, ["bk-1"])} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect(document.activeElement).toBe(heading(strings.handoffTitle("Luis")));
  });

  it("al terminar el ultimo turno el foco va al balance de la ronda", () => {
    // El ultimo turno (Luis) con todo ya recogido: al terminarlo no queda nadie y el foco va al balance.
    render(<Harness ceremony={LUIS_TURN} blocks={signed(SAME_BLOCKS, ["bk-1", "bk-2"])} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    fireEvent.click(screen.getByRole("button", { name: strings.reviewFinish }));
    expect(document.activeElement).toBe(heading(strings.allSignedTitle));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("«Estoy listo» de la lista de la ronda (goToTurn) mueve el foco al traspaso de ese turno", () => {
    render(<Harness />);
    // [0] es el del traspaso de Ana; [1] y [2] los de la lista de la ronda (Ana, Luis).
    const luis = screen.getAllByRole("button", { name: strings.handoffReady })[2];
    fireEvent.click(luis);
    expect(document.activeElement).toBe(heading(strings.handoffTitle("Luis")));
  });

  it("repetir la misma etapa y turno no mueve el foco (no se roba si no cambio nada)", () => {
    render(<Harness />);
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    // El «Estoy listo» de la lista de la ronda para Ana, que YA tiene el turno en traspaso: ni etapa ni turno cambian.
    fireEvent.click(screen.getAllByRole("button", { name: strings.handoffReady })[1]);
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

describe("BlockCeremony — firmas guardadas del baul", () => {
  it("«Usar una guardada» rellena firma e iniciales del bloque con SELLO por documento y toca la entrada una vez", async () => {
    const entry = await seed("Ana Pérez");
    let last: SignerBlock[] = SAME_BLOCKS;
    render(<Harness onBlocks={(next) => (last = next)} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.vaultUseSavedFor(strings.fieldSignature) }));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));

    const ana = last.find((item) => item.id === "bk-1")!;
    expect(ana.signature?.dataUrl).toBe(vaultImageToDataUrl(entry.signature!));
    expect(ana.initials?.dataUrl).toBe(vaultImageToDataUrl(entry.initials!));
    for (const doc of [A, B, C] as const) {
      expect(ana.stamps[doc]).toBe(captureStamp(KEYS[doc], DOC_STATES[doc].fields, ANA.id));
    }
    expect(isBlockComplete(ana, ctxOf())).toBe(true);
    expect(touchSpy.calls).toEqual([entry.id]);
    expect(await screen.findByText(strings.vaultApplied("Ana Pérez"))).toBeTruthy();
  });

  it("la casilla «Aplicar a todos mis bloques» solo se ofrece si el firmante tiene mas de un bloque", async () => {
    await seed("Ana Pérez");
    const { unmount } = render(<Harness />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.vaultUseSavedFor(strings.fieldSignature) }));
    await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") });
    expect(screen.queryByRole("checkbox", { name: strings.vaultApplyAll })).toBeNull();
    unmount();

    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    fireEvent.click(
      screen.getByRole("button", { name: `${strings.vaultUseSavedFor(strings.fieldSignature)} · Bloque 1` }),
    );
    expect(await screen.findByRole("checkbox", { name: strings.vaultApplyAll })).toBeTruthy();
  });

  it("sin marcar la casilla solo se rellena el bloque elegido", async () => {
    await seed("Ana Pérez");
    let last: SignerBlock[] = SPLIT_BLOCKS;
    render(<Harness blocks={SPLIT_BLOCKS} onBlocks={(next) => (last = next)} />);
    toCapture();
    fireEvent.click(
      screen.getByRole("button", { name: `${strings.vaultUseSavedFor(strings.fieldSignature)} · Bloque 1` }),
    );
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));
    expect(last.find((item) => item.id === "bk-1")!.signature).not.toBeNull();
    expect(last.find((item) => item.id === "bk-3")!.signature).toBeNull();
  });

  it("marcada: rellena tambien los OTROS bloques vacios de Ana y no los de Luis; toca la entrada UNA vez", async () => {
    const entry = await seed("Ana Pérez");
    let last: SignerBlock[] = SPLIT_BLOCKS;
    render(<Harness blocks={SPLIT_BLOCKS} onBlocks={(next) => (last = next)} />);
    toCapture();
    fireEvent.click(
      screen.getByRole("button", { name: `${strings.vaultUseSavedFor(strings.fieldSignature)} · Bloque 1` }),
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: strings.vaultApplyAll }));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));

    expect(last.find((item) => item.id === "bk-1")!.signature).not.toBeNull();
    const third = last.find((item) => item.id === "bk-3")!;
    expect(third.signature?.dataUrl).toBe(vaultImageToDataUrl(entry.signature!));
    expect(third.stamps[C]).toBe(captureStamp("key-c", DOC_STATES[C].fields, ANA.id));
    expect(last.find((item) => item.id === "bk-2")!.signature).toBeNull();
    expect(touchSpy.calls).toEqual([entry.id]);
    expect(await screen.findByText(strings.vaultAppliedAll("Ana Pérez", 1))).toBeTruthy();
  });

  it("marcada: NO pisa un bloque que ya tenia su propia firma", async () => {
    await seed("Ana Pérez");
    const own = captureForBlock(SPLIT_BLOCKS, "bk-3", { signature: DRAFT }, ctxOf());
    let last: SignerBlock[] = own;
    render(<Harness blocks={own} onBlocks={(next) => (last = next)} />);
    toCapture();
    fireEvent.click(
      screen.getByRole("button", { name: `${strings.vaultUseSavedFor(strings.fieldSignature)} · Bloque 1` }),
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: strings.vaultApplyAll }));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));
    expect(last.find((item) => item.id === "bk-3")!.signature).toEqual(DRAFT);
  });

  it("la casilla nace desmarcada en cada apertura", async () => {
    await seed("Ana Pérez");
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    const open = () =>
      fireEvent.click(
        screen.getByRole("button", { name: `${strings.vaultUseSavedFor(strings.fieldSignature)} · Bloque 1` }),
      );
    open();
    const first = (await screen.findByRole("checkbox", { name: strings.vaultApplyAll })) as HTMLInputElement;
    fireEvent.click(first);
    expect(first.checked).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: strings.vaultTitle })).toBeNull());
    open();
    const second = (await screen.findByRole("checkbox", { name: strings.vaultApplyAll })) as HTMLInputElement;
    expect(second.checked).toBe(false);
  });

  it("una guardada sin iniciales deja el bloque a medias y lo explica sin alarma", async () => {
    await seed("Ana Pérez", { initials: null });
    let last: SignerBlock[] = SAME_BLOCKS;
    render(<Harness onBlocks={(next) => (last = next)} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.vaultUseSavedFor(strings.fieldSignature) }));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));
    expect(last.find((item) => item.id === "bk-1")!.initials).toBeNull();
    expect(await screen.findByText(strings.vaultAppliedPartial("Ana Pérez", ["initials"]))).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: strings.captureContinue }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("el aviso del baul no se queda colgado al pasar a la revision", async () => {
    await seed("Ana Pérez");
    render(<Harness />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.vaultUseSavedFor(strings.fieldSignature) }));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));
    await screen.findByText(strings.vaultApplied("Ana Pérez"));
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    expect(screen.queryByText(strings.vaultApplied("Ana Pérez"))).toBeNull();
  });

  it("con el baul apagado no hay «Usar una guardada»", () => {
    window.localStorage.setItem(
      SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ signatureVault: false }),
    );
    __resetSignPdfFeatureFlagsCacheForTests();
    render(<Harness />);
    toCapture();
    expect(screen.queryByRole("button", { name: strings.vaultUseSavedFor(strings.fieldSignature) })).toBeNull();
  });
});

describe("BlockCeremony — firma nueva con el compositor y «Recordar»", () => {
  async function typeSignature(text = "Ana") {
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: text } });
  }

  it("crear la firma de un bloque la sella en TODOS los documentos de su alcance", async () => {
    let last: SignerBlock[] = SAME_BLOCKS;
    render(<Harness onBlocks={(next) => (last = next)} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureSignature }));
    await typeSignature();
    fireEvent.click(screen.getByRole("button", { name: strings.save }));
    await waitFor(() => expect(last.find((item) => item.id === "bk-1")!.signature).not.toBeNull());
    const ana = last.find((item) => item.id === "bk-1")!;
    expect(Object.keys(ana.stamps).sort()).toEqual([A, B, C]);
    expect(ana.initials).toBeNull();
  });

  it("«Recordar» en un bloque de varios documentos guarda «N documentos» como origen", async () => {
    render(<Harness />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureSignature }));
    await typeSignature();
    fireEvent.click(screen.getByRole("checkbox", { name: strings.vaultRemember }));
    fireEvent.click(screen.getByRole("button", { name: strings.save }));
    expect(await screen.findByText(strings.vaultSaved)).toBeTruthy();
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].signerName).toBe("Ana Pérez");
    expect(entries[0].sourceDocument).toBe("3 documentos");
  });

  it("«Recordar» en un bloque de UN documento guarda el nombre de ese documento", async () => {
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: `${strings.captureSignature} · Bloque 2` }));
    await typeSignature();
    fireEvent.click(screen.getByRole("checkbox", { name: strings.vaultRemember }));
    fireEvent.click(screen.getByRole("button", { name: strings.save }));
    expect(await screen.findByText(strings.vaultSaved)).toBeTruthy();
    const { entries } = await listVault();
    expect(entries[0].sourceDocument).toBe("Acta.pdf");
  });

  it("rehacer deja el boton como «Rehacer» con el trazo visible", async () => {
    render(<Harness ceremony={ANA_TURN} blocks={signed(SAME_BLOCKS, ["bk-1"])} />);
    toCapture();
    expect(screen.getAllByRole("button", { name: strings.captureRedo })).toHaveLength(2);
    expect(screen.getAllByAltText(strings.fieldSignature).length).toBeGreaterThan(0);
  });
});

describe("BlockCeremony — alcance, cobertura y entrega", () => {
  it("«Cambiar» abre la hoja de alcance del bloque con sus documentos marcados", () => {
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.blockChangeScopeFor("Bloque 1", "Ana Pérez") }));
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByRole("checkbox", { name: "Contrato A" }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole("checkbox", { name: "Anexo" }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole("checkbox", { name: "Acta" }) as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByRole("checkbox", { name: strings.scopeAllLabel }) as HTMLInputElement).checked).toBe(false);
  });

  it("marcar un documento de otro bloque avisa, antes de aplicar, de que saldra de ese bloque", () => {
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.blockChangeScopeFor("Bloque 1", "Ana Pérez") }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Acta" }));
    expect(screen.getByText(strings.scopeMovePreview("Acta", 2))).toBeTruthy();
  });

  it("aplicar mueve el documento, deja un solo bloque con el invariante y lo anuncia", async () => {
    let last: SignerBlock[] = SPLIT_BLOCKS;
    render(<Harness blocks={SPLIT_BLOCKS} onBlocks={(next) => (last = next)} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.blockChangeScopeFor("Bloque 1", "Ana Pérez") }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Acta" }));
    fireEvent.click(screen.getByRole("button", { name: strings.scopeApply }));
    const ana = last.filter((item) => item.signerId === ANA.id);
    expect(ana).toHaveLength(1);
    expect(ana[0].appliesTo).toEqual([A, B, C]);
    expect(ana[0].auto).toBe(false);
    await waitFor(() =>
      expect(screen.getByText(new RegExp(strings.blockScopeMoved("Acta", 2, 1)))).toBeTruthy(),
    );
  });

  it("no deja aplicar un alcance vacio y lo dice", () => {
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.blockChangeScopeFor("Bloque 2", "Ana Pérez") }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Acta" }));
    expect(screen.getByText(strings.scopeEmpty)).toBeTruthy();
    expect((screen.getByRole("button", { name: strings.scopeApply }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("«Todos los documentos» marca y desmarca todas las casillas", () => {
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.blockChangeScopeFor("Bloque 1", "Ana Pérez") }));
    fireEvent.click(screen.getByRole("checkbox", { name: strings.scopeAllLabel }));
    for (const name of ["Contrato A", "Anexo", "Acta"]) {
      expect((screen.getByRole("checkbox", { name }) as HTMLInputElement).checked).toBe(true);
    }
    fireEvent.click(screen.getByRole("checkbox", { name: strings.scopeAllLabel }));
    for (const name of ["Contrato A", "Anexo", "Acta"]) {
      expect((screen.getByRole("checkbox", { name }) as HTMLInputElement).checked).toBe(false);
    }
  });

  it("ampliar el alcance de un bloque ya firmado lo deja pendiente para los documentos nuevos", () => {
    const done = signed(SPLIT_BLOCKS, ["bk-1", "bk-3"]);
    render(<Harness ceremony={ANA_TURN} blocks={done} />);
    toCapture();
    expect((screen.getByRole("button", { name: strings.captureContinue }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: strings.blockChangeScopeFor("Bloque 1", "Ana Pérez") }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Acta" }));
    fireEvent.click(screen.getByRole("button", { name: strings.scopeApply }));
    // bk-3 se queda sin documentos y desaparece; bk-1 ya no tiene sello para «Acta».
    expect((screen.getByRole("button", { name: strings.captureContinue }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("cobertura: «Falta el bloque de Ana para Acta» con su boton para anadirlo", () => {
    const holed = [block("bk-1", ANA.id, [A, B], { auto: true }), block("bk-2", LUIS.id, [A, B], { auto: true })];
    let last: SignerBlock[] = holed;
    render(<Harness blocks={holed} onBlocks={(next) => (last = next)} />);
    expect(screen.getByText(strings.coverageMissing("Ana Pérez", "Acta"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.coverageAddBlock("Acta") }));
    const ana = last.filter((item) => item.signerId === ANA.id);
    expect(ana).toHaveLength(2);
    expect(ana.find((item) => item.appliesTo.includes(C))!.appliesTo).toEqual([C]);
    expect(screen.queryByText(strings.coverageMissing("Ana Pérez", "Acta"))).toBeNull();
  });

  it("tras «Añadir bloque para X» el foco va al balance de la ronda, no a <body>", () => {
    const holed = [block("bk-1", ANA.id, [A, B], { auto: true }), block("bk-2", LUIS.id, [A, B], { auto: true })];
    render(<Harness blocks={holed} />);
    const add = screen.getByRole("button", { name: strings.coverageAddBlock("Acta") });
    add.focus();
    fireEvent.click(add);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.tagName).toBe("H4");
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("la region viva de anuncios esta siempre montada", () => {
    render(<Harness />);
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  it("«Aplicar y descargar» sigue desactivado mientras haya bloques por firmar", () => {
    render(<Harness blocks={signed(SAME_BLOCKS, ["bk-1"])} />);
    expect(finish().disabled).toBe(true);
    expect(screen.getByText(strings.pendingBody(1))).toBeTruthy();
  });

  it("con todo firmado se habilita y avisa de cuantos documentos se descargan", () => {
    const onFinish = vi.fn();
    render(<Harness blocks={signed(SAME_BLOCKS, ["bk-1", "bk-2"])} onFinish={onFinish} />);
    expect(finish().disabled).toBe(false);
    expect(screen.getByText(strings.batchReadyBody(3))).toBeTruthy();
    fireEvent.click(finish());
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("si la entrega esta bloqueada por otra razon, lo dice y no deja descargar aunque todos hayan firmado", () => {
    render(
      <Harness
        blocks={signed(SAME_BLOCKS, ["bk-1", "bk-2"])}
        blocked
        blockerMessages={[strings.batchDocEmpty("Acta")]}
      />,
    );
    expect(finish().disabled).toBe(true);
    expect(screen.getByText(strings.batchDocEmpty("Acta"))).toBeTruthy();
    expect(screen.queryByText(strings.batchReadyBody(3))).toBeNull();
  });

  it("«Empezar de nuevo» borra los trazos de todos los bloques y vuelve al primer turno", () => {
    let last: SignerBlock[] = [];
    render(<Harness blocks={signed(SAME_BLOCKS, ["bk-1", "bk-2"])} onBlocks={(next) => (last = next)} />);
    // Rotulos largos: ambos botones parten el texto en vez de desbordar con una tipografia ancha (F0-fix3).
    for (const label of [strings.applyAndDownload, strings.restartCeremony]) {
      expect(screen.getByRole("button", { name: label }).className.split(/\s+/), label).toEqual(
        expect.arrayContaining(["whitespace-normal!", "max-w-full"]),
      );
    }
    fireEvent.click(screen.getByRole("button", { name: strings.restartCeremony }));
    expect(last.every((item) => item.signature === null && item.initials === null)).toBe(true);
    expect(last.every((item) => Object.keys(item.stamps).length === 0)).toBe(true);
    expect(finish().disabled).toBe(true);
    expect(screen.getByText(strings.turnOf(1, 2))).toBeTruthy();
  });

  it("la lista de la ronda marca «Firmado» y «Pendiente» por firmante", () => {
    render(<Harness blocks={signed(SAME_BLOCKS, ["bk-1"])} />);
    const list = screen.getAllByRole("list").find((item) => within(item).queryByText("Luis"))!;
    expect(within(list).getByText(strings.statusSigned)).toBeTruthy();
    expect(within(list).getByText(strings.statusPending)).toBeTruthy();
  });

  it("en modo «distintas» (un bloque por documento) cada documento pide su firma", () => {
    const independent = [
      block("bk-1", ANA.id, [A]),
      block("bk-2", ANA.id, [B]),
      block("bk-3", ANA.id, [C]),
      block("bk-4", LUIS.id, [A]),
      block("bk-5", LUIS.id, [B]),
    ];
    render(<Harness blocks={independent} />);
    toCapture();
    expect(screen.getAllByRole("listitem", { name: /^Bloque \d$/ })).toHaveLength(3);
    expect(screen.getByText(strings.blockAppliesTo("Contrato A"))).toBeTruthy();
    expect(screen.getByText(strings.blockAppliesTo("Anexo"))).toBeTruthy();
    expect(screen.getByText(strings.blockAppliesTo("Acta"))).toBeTruthy();
  });

  it("los botones de cada bloque tienen nombres distintos (accesibles) y 44 px con puntero grueso", () => {
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    const names = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");
    // «Listo, es mi turno» de la lista de la ronda se repite por firmante igual que en `SigningCeremony`.
    const duplicates = names.filter(
      (name, index) =>
        name && name !== strings.handoffReady && names.indexOf(name) !== index,
    );
    expect(duplicates).toEqual([]);
    const change = screen.getByRole("button", { name: strings.blockChangeScopeFor("Bloque 1", "Ana Pérez") });
    expect(change.className).toContain("pointer-coarse:h-11");
  });
});

describe("BlockCeremony — textos en ingles", () => {
  it("el traspaso y el resumen de alcance salen en ingles", () => {
    const en = SIGN_STRINGS.en;
    render(
      <LanguageProvider>
        <BlockCeremony
          signers={[ANA, LUIS]}
          docs={DOCS}
          docStates={DOC_STATES}
          keys={KEYS}
          blocks={SAME_BLOCKS}
          onBlocksChange={() => {}}
          blockerMessages={[]}
          blocked={false}
          onFinish={() => {}}
          strings={en}
        />
      </LanguageProvider>,
    );
    expect(screen.getByRole("heading", { name: en.handoffTitle("Ana Pérez") })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: en.handoffReady })[0]);
    expect(screen.getByText(en.blockAppliesTo("All (3)"))).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Turno que sobrevive, que falta y progreso (Fase 0 · U0.2)
 * ------------------------------------------------------------------ */

/**
 * La sesion de verdad: el turno y los bloques viven FUERA de la ceremonia, que se desmonta y se vuelve a
 * montar (tocar la pestana de otro documento, «Atras» -> «Continuar»). `remount` simula ese remontaje.
 */
function SessionHost({
  initialBlocks = SAME_BLOCKS,
  initialCeremony = null,
  docStates = DOC_STATES,
  docs = DOCS,
  keys = KEYS,
  signers = [ANA, LUIS],
  onCeremony,
}: {
  initialBlocks?: SignerBlock[];
  initialCeremony?: CeremonyState | null;
  docStates?: Record<string, DocState>;
  docs?: DocRef[];
  keys?: Record<string, string | null>;
  signers?: Signer[];
  onCeremony?: (next: CeremonyState | null) => void;
}) {
  const [blocks, setBlocks] = useState(initialBlocks);
  const [ceremony, setCeremony] = useState<CeremonyState | null>(initialCeremony);
  const [generation, setGeneration] = useState(0);
  return (
    <LanguageProvider>
      <button type="button" onClick={() => setGeneration((count) => count + 1)}>
        remontar
      </button>
      <output data-testid="stored">{ceremony ? `${ceremony.signerId}:${ceremony.stage}` : "none"}</output>
      <BlockCeremony
        key={generation}
        signers={signers}
        docs={docs}
        docStates={docStates}
        keys={keys}
        blocks={blocks}
        onBlocksChange={setBlocks}
        blockerMessages={[]}
        blocked={false}
        onFinish={() => {}}
        strings={strings}
        ceremony={ceremony}
        onCeremonyChange={(next) => {
          setCeremony(next);
          onCeremony?.(next);
        }}
      />
    </LanguageProvider>
  );
}

const remount = () => fireEvent.click(screen.getByRole("button", { name: "remontar" }));
const stored = () => screen.getByTestId("stored").textContent;

describe("BlockCeremony — el turno se deriva de lo que falta al montar", () => {
  it("con Ana ya firmada, la ronda arranca en el turno de Luis (no vuelve a pasarle el dispositivo a Ana)", () => {
    render(<Harness blocks={signed(SAME_BLOCKS, ["bk-1"])} />);
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect(heading(strings.handoffTitle("Luis"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: strings.handoffTitle("Ana Pérez") })).toBeNull();
  });

  it("con todos firmados no hay turno que pasar: se ve el balance «Ya han firmado todos»", () => {
    render(<Harness blocks={signed(SAME_BLOCKS, ["bk-1", "bk-2"])} />);
    expect(screen.queryByText(/^Turno \d+ de \d+$/)).toBeNull();
    expect(heading(strings.allSignedTitle)).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.handoffReady })).toBeNull();
  });

  it("con nadie firmado arranca en el primero de la cola", () => {
    render(<Harness />);
    expect(screen.getByText(strings.turnOf(1, 2))).toBeTruthy();
    expect(heading(strings.handoffTitle("Ana Pérez"))).toBeTruthy();
  });

  it("derivar el turno no roba el foco al montar", () => {
    render(<Harness blocks={signed(SAME_BLOCKS, ["bk-1"])} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("BlockCeremony — el turno guardado en la sesion sobrevive a remontar la ceremonia", () => {
  it("tras el turno de Ana, tocar otra pestana (remontar) deja el turno de Luis, no vuelve a Ana", () => {
    render(<SessionHost initialBlocks={signed(SAME_BLOCKS, ["bk-1"])} initialCeremony={ANA_TURN} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));
    expect(stored()).toBe("sg-2:handoff");
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();

    remount();
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
    expect(heading(strings.handoffTitle("Luis"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: strings.handoffTitle("Ana Pérez") })).toBeNull();
  });

  it("la etapa tambien sobrevive: captura de Luis a medias -> remontar -> sigue en su captura", () => {
    render(<SessionHost initialBlocks={signed(SAME_BLOCKS, ["bk-1"])} initialCeremony={LUIS_TURN} />);
    toCapture();
    expect(heading(strings.captureTitle("Luis"))).toBeTruthy();
    remount();
    expect(heading(strings.captureTitle("Luis"))).toBeTruthy();
    expect(stored()).toBe("sg-2:capture");
  });

  it("la revision de quien acaba de firmar sobrevive al remontaje (Ana no vuelve al traspaso)", () => {
    render(<SessionHost initialBlocks={signed(SAME_BLOCKS, ["bk-1"])} initialCeremony={ANA_TURN} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    expect(heading(strings.reviewTitle("Ana Pérez"))).toBeTruthy();
    remount();
    expect(heading(strings.reviewTitle("Ana Pérez"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: strings.handoffTitle("Ana Pérez") })).toBeNull();
  });

  it("remontar sin haber actuado no escribe nada en la sesion (no hay turnos inventados)", () => {
    const writes: Array<CeremonyState | null> = [];
    render(<SessionHost onCeremony={(next) => writes.push(next)} />);
    remount();
    remount();
    expect(writes).toEqual([]);
    expect(stored()).toBe("none");
  });

  it("remontar mientras llegan las huellas (keys null) ensena la espera y NO pisa el turno guardado", () => {
    const view = render(
      <SessionHost
        initialBlocks={signed(SAME_BLOCKS, ["bk-1"])}
        initialCeremony={LUIS_TURN}
        keys={{ ...KEYS, [B]: null }}
      />,
    );
    expect(screen.getByText(strings.checkingDocument)).toBeTruthy();
    expect(stored()).toBe("sg-2:handoff");
    view.unmount();
  });

  it("un turno guardado de un firmante que ya no tiene huecos se descarta y se deriva (sin romper)", () => {
    const eva: CeremonyState = { signerId: SOLO_FIRMA.id, stage: "capture" };
    render(<SessionHost initialBlocks={signed(SAME_BLOCKS, ["bk-1"])} initialCeremony={eva} signers={[ANA, LUIS, SOLO_FIRMA]} />);
    expect(heading(strings.handoffTitle("Luis"))).toBeTruthy();
  });

  it("«Empezar la ronda de nuevo» guarda el primer turno del traspaso y vacia los trazos", () => {
    render(<SessionHost initialBlocks={signed(SAME_BLOCKS, ["bk-1", "bk-2"])} initialCeremony={LUIS_TURN} />);
    fireEvent.click(screen.getByRole("button", { name: strings.restartCeremony }));
    expect(stored()).toBe("sg-1:handoff");
    expect(screen.getByText(strings.turnOf(1, 2))).toBeTruthy();
    expect(finish().disabled).toBe(true);
  });
});

describe("BlockCeremony — al completar un turno salta al siguiente firmante PENDIENTE", () => {
  const THREE = [ANA, LUIS, SOLO_FIRMA];
  const DOCS_3 = {
    ...DOC_STATES,
    [C]: docState([slot("c1", ANA.id), slot("c2", SOLO_FIRMA.id)]),
  };
  const BLOCKS_3 = [
    block("bk-1", ANA.id, [A, B, C], { auto: true }),
    block("bk-2", LUIS.id, [A, B], { auto: true }),
    block("bk-3", SOLO_FIRMA.id, [C], { auto: true }),
  ];

  it("se salta a quien ya firmo: de Ana pasa directamente a Eva, con Luis firmado", () => {
    const blocks = signed(BLOCKS_3, ["bk-1", "bk-2"], DOCS_3);
    render(<SessionHost initialBlocks={blocks} initialCeremony={ANA_TURN} docStates={DOCS_3} signers={THREE} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));
    expect(heading(strings.handoffTitle("Eva"))).toBeTruthy();
    expect(screen.getByText(strings.turnOf(3, 3))).toBeTruthy();
    expect(stored()).toBe("sg-3:handoff");
  });

  it("firmando fuera de orden, al terminar vuelve al primero pendiente (Luis termina y le toca a Ana)", () => {
    // Luis y Ana estan pendientes; se elige a Luis desde la lista de la ronda y, ya firmado, le toca a Ana.
    render(<SessionHost initialBlocks={signed(SAME_BLOCKS, ["bk-2"])} initialCeremony={LUIS_TURN} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    expect(screen.getByRole("button", { name: strings.reviewNext })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));
    expect(heading(strings.handoffTitle("Ana Pérez"))).toBeTruthy();
    expect(stored()).toBe("sg-1:handoff");
  });

  it("si despues del turno no queda nadie pendiente el boton dice «He terminado» y la ronda se cierra", () => {
    render(<SessionHost initialBlocks={signed(SAME_BLOCKS, ["bk-1", "bk-2"])} initialCeremony={LUIS_TURN} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: strings.captureContinue }));
    expect(screen.queryByRole("button", { name: strings.reviewNext })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.reviewFinish }));
    expect(stored()).toBe("none");
    expect(heading(strings.allSignedTitle)).toBeTruthy();
    // Y remontar despues de cerrar la ronda tampoco resucita el turno de Ana.
    remount();
    expect(screen.queryByRole("heading", { name: strings.handoffTitle("Ana Pérez") })).toBeNull();
    expect(heading(strings.allSignedTitle)).toBeTruthy();
  });
});

describe("BlockCeremony — «Ver cómo queda» apagado dice QUE falta", () => {
  const missingText = (items: string[]) => strings.ceremonyMissing(items);
  const continueButton = () =>
    screen.getByRole("button", { name: strings.captureContinue }) as HTMLButtonElement;

  it("con varios bloques nombra cada trazo pendiente con su documento y enlaza el boton con la frase", () => {
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    const hint = screen.getByText(
      missingText([
        "Firma · Contrato A, Anexo",
        "Iniciales · Contrato A, Anexo",
        "Firma · Acta",
      ]),
    );
    expect(continueButton().disabled).toBe(true);
    expect(continueButton().getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.id).not.toBe("");
  });

  it("al firmar un bloque la frase se acorta y al completar todo desaparece y se habilita", () => {
    const one = render(<Harness blocks={signed(SPLIT_BLOCKS, ["bk-1"])} ceremony={ANA_TURN} />);
    toCapture();
    expect(screen.getByText(missingText(["Firma · Acta"]))).toBeTruthy();
    expect(continueButton().disabled).toBe(true);
    one.unmount();

    render(<Harness blocks={signed(SPLIT_BLOCKS, ["bk-1", "bk-3"])} ceremony={ANA_TURN} />);
    toCapture();
    expect(screen.queryByText(/^Falta:/)).toBeNull();
    expect(screen.queryByRole("button", { name: strings.ceremonyGoToMissing })).toBeNull();
    expect(continueButton().disabled).toBe(false);
    expect(continueButton().getAttribute("aria-describedby")).toBeNull();
  });

  it("con un solo bloque la frase nombra solo el tipo («Falta: Firma; Iniciales»), sin documento", () => {
    render(<Harness />);
    toCapture();
    expect(screen.getByText(missingText(["Firma", "Iniciales"]))).toBeTruthy();
  });

  it("«Ir a lo que falta» lleva el foco y la vista al primer trazo pendiente", () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      render(<Harness blocks={signed(SPLIT_BLOCKS, ["bk-1"])} ceremony={ANA_TURN} />);
      toCapture();
      const go = screen.getByRole("button", { name: strings.ceremonyGoToMissing });
      go.focus();
      fireEvent.click(go);
      const target = screen.getByRole("button", { name: `${strings.captureSignature} · Bloque 2` });
      expect(document.activeElement).toBe(target);
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy.mock.instances[0]).toBe(target);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("«Ir a lo que falta» funciona aunque el navegador no tenga scrollIntoView (jsdom antiguo)", () => {
    const original = Element.prototype.scrollIntoView;
    // @ts-expect-error simula un entorno sin la API
    Element.prototype.scrollIntoView = undefined;
    try {
      render(<Harness blocks={SPLIT_BLOCKS} />);
      toCapture();
      fireEvent.click(screen.getByRole("button", { name: strings.ceremonyGoToMissing }));
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: `${strings.captureSignature} · Bloque 1` }),
      );
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("«Ir a lo que falta» mide 44 px con puntero grueso (boton md) y no es un enlace ambiguo", () => {
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    const go = screen.getByRole("button", { name: strings.ceremonyGoToMissing });
    expect(go.className).toContain("h-11");
  });

  it("la lista de progreso marca hecho/falta por trazo y bloque, con el estado tambien en texto", () => {
    render(<Harness blocks={signed(SPLIT_BLOCKS, ["bk-1"])} ceremony={ANA_TURN} />);
    toCapture();
    const list = screen.getByRole("list", { name: strings.ceremonyProgressLabel("Ana Pérez") });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      `Firma · Contrato A, Anexo${strings.ceremonyItemDone}`,
      `Iniciales · Contrato A, Anexo${strings.ceremonyItemDone}`,
      `Firma · Acta${strings.ceremonyItemMissing}`,
    ]);
    // ✓ (check) en lo hecho y ○ (circle) en lo que falta.
    expect(items[0].querySelector("svg.lucide-check")).not.toBeNull();
    expect(items[2].querySelector("svg.lucide-circle")).not.toBeNull();
    expect(items[2].querySelector("svg.lucide-check")).toBeNull();
  });

  it("con un solo trazo que recoger no se pinta lista de progreso (la propia fila ya lo dice)", () => {
    render(<Harness blocks={[block("bk-1", ANA.id, [B, C]), block("bk-2", LUIS.id, [A, B])]} />);
    toCapture();
    expect(screen.queryByRole("list", { name: strings.ceremonyProgressLabel("Ana Pérez") })).toBeNull();
    expect(screen.getByText(missingText(["Firma"]))).toBeTruthy();
  });

  it("anuncia lo que falta tras guardar un trazo, en UNA sola region viva (no se anade otra)", async () => {
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    const announced = missingText(["Firma · Contrato A, Anexo", "Iniciales · Contrato A, Anexo"]);
    const carrying = () => screen.getAllByRole("status").filter((node) => node.textContent === announced);
    const regionsBefore = screen.getAllByRole("status").length;
    expect(carrying()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: `${strings.captureSignature} · Bloque 2` }));
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
    fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: strings.save }));
    await waitFor(() => expect(carrying()).toHaveLength(1));
    expect(carrying()[0].getAttribute("aria-live")).toBe("polite");
    // La region ya estaba montada (vacia) antes de anunciar: el lector de pantalla lee el CAMBIO.
    expect(screen.getAllByRole("status").length).toBe(regionsBefore);
  });

  it("al aplicar una firma guardada se anuncia lo que falta (o que ya esta todo)", async () => {
    await seed("Ana Pérez");
    render(<Harness blocks={SPLIT_BLOCKS} />);
    toCapture();
    fireEvent.click(screen.getByRole("button", { name: `${strings.vaultUseSavedFor(strings.fieldSignature)} · Bloque 1` }));
    fireEvent.click(await screen.findByRole("button", { name: strings.vaultUseFor("Ana Pérez") }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((node) => node.textContent === missingText(["Firma · Acta"])),
      ).toBe(true),
    );
  });

  it("en ingles: la frase, el boton y la lista salen en ingles", () => {
    const en = SIGN_STRINGS.en;
    render(
      <LanguageProvider>
        <BlockCeremony
          signers={[ANA, LUIS]}
          docs={DOCS}
          docStates={DOC_STATES}
          keys={KEYS}
          blocks={SPLIT_BLOCKS}
          onBlocksChange={() => {}}
          blockerMessages={[]}
          blocked={false}
          onFinish={() => {}}
          strings={en}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: en.handoffReady })[0]);
    expect(screen.getByText(en.ceremonyMissing(["Signature · Contrato A, Anexo", "Initials · Contrato A, Anexo", "Signature · Acta"]))).toBeTruthy();
    expect(screen.getByRole("button", { name: en.ceremonyGoToMissing })).toBeTruthy();
    expect(screen.getByRole("list", { name: en.ceremonyProgressLabel("Ana Pérez") })).toBeTruthy();
  });
});
