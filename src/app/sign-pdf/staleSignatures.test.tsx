import "fake-indexeddb/auto";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BlockCeremony } from "@/app/sign-pdf/BlockCeremony";
import { SigningCeremony } from "@/app/sign-pdf/SigningCeremony";
import { captureForBlock, type BlockContext, type CeremonyState, type DocRef } from "@/app/sign-pdf/blockModel";
import { captureStamp, type CaptureMap } from "@/app/sign-pdf/captures";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { stampKeyOf } from "@/app/sign-pdf/textEdits";
import { installCanvasStubs, pngDataUrl } from "@/app/sign-pdf/vaultTestUtils";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/**
 * F0-fix · D7: se edita el texto original DESPUES de que alguien firmo y su firma deja de valer. La pantalla dice QUE paso y
 * QUIEN debe firmar de nuevo (en la ceremonia y en la lista de progreso), y el turno vuelve a esa persona.
 */

const es = SIGN_STRINGS.es;
const en = SIGN_STRINGS.en;
const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const A = "doc-a";
const B = "doc-b";
const DOCS: DocRef[] = [
  { id: A, name: "Contrato A.pdf" },
  { id: B, name: "Anexo B.pdf" },
];
const FP = { [A]: "a".repeat(64), [B]: "b".repeat(64) };
const EDIT = makeEdit({ id: "e1", blockId: "p0-b0", text: "nuevo" });
const EDITED = { [A]: stampKeyOf(FP[A], [EDIT]) as string, [B]: FP[B] };
const DRAFT = { dataUrl: pngDataUrl({ seed: 5 }), ratio: 0.5 };

const slot = (id: string, signerId: string): SignatureField => ({
  id,
  signerId,
  pageIndex: 0,
  type: "signature",
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
});
const docStates = (): Record<string, DocState> => ({
  [A]: { ...EMPTY_DOC_STATE, fields: [slot("a1", ANA.id), slot("a2", LUIS.id)] },
  [B]: { ...EMPTY_DOC_STATE, fields: [slot("b1", ANA.id), slot("b2", LUIS.id)] },
});

const SPLIT: SignerBlock[] = [
  { id: "bk-1", signerId: ANA.id, appliesTo: [A, B], signature: null, initials: null, stamps: {}, auto: true },
  { id: "bk-2", signerId: LUIS.id, appliesTo: [A, B], signature: null, initials: null, stamps: {}, auto: true },
];

/** Los dos firmaron con el documento tal cual. */
function bothSigned(): SignerBlock[] {
  const ctx: BlockContext = { signers: [ANA, LUIS], docs: docStates(), keys: FP };
  let blocks = captureForBlock(SPLIT, "bk-1", { signature: DRAFT }, ctx);
  blocks = captureForBlock(blocks, "bk-2", { signature: DRAFT }, ctx);
  return blocks;
}

function Harness({
  blocks: initial,
  keys,
  ceremony: initialCeremony,
  language = "es",
}: {
  blocks: SignerBlock[];
  keys: Record<string, string | null>;
  ceremony?: CeremonyState | null;
  language?: "es" | "en";
}) {
  const [blocks, setBlocks] = useState(initial);
  const [turn, setTurn] = useState<CeremonyState | null>(initialCeremony ?? null);
  return (
    <LanguageProvider>
      <BlockCeremony
        {...(initialCeremony !== undefined ? { ceremony: turn, onCeremonyChange: setTurn } : {})}
        signers={[ANA, LUIS]}
        docs={DOCS}
        docStates={docStates()}
        keys={keys}
        blocks={blocks}
        onBlocksChange={setBlocks}
        blockerMessages={[]}
        blocked={false}
        onFinish={() => {}}
        strings={language === "en" ? en : es}
      />
    </LanguageProvider>
  );
}

let restoreCanvas = () => {};
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  restoreCanvas = installCanvasStubs();
});
afterEach(() => {
  cleanup();
  restoreCanvas();
});

/** La frase visible (el aviso); la misma frase tambien la repite la region viva para lectores de pantalla. */
const notice = () => within(document.querySelector("[data-stale-signatures]") as HTMLElement);

const FRASE_ANA = "La firma de Ana ya no es válida porque cambiaste el texto del documento: Ana debe volver a firmar.";

describe("BlockCeremony · una firma que dejo de valer porque se cambio el texto", () => {
  it("dice QUE paso y QUIEN debe volver a firmar (la frase exacta), para cada firmante afectado", () => {
    render(<Harness blocks={bothSigned()} keys={EDITED} />);
    const notice = document.querySelector("[data-stale-signatures]") as HTMLElement;
    expect(notice).toBeTruthy();
    expect(within(notice).getByText(FRASE_ANA)).toBeTruthy();
    expect(within(notice).getByText("La firma de Luis ya no es válida porque cambiaste el texto del documento: Luis debe volver a firmar.")).toBeTruthy();
  });

  it("el turno VUELVE a Ana (traspaso), aunque el guardado fuera de Luis", () => {
    // Tras editar solo se invalida lo de quien firmo ANTES: aqui solo firmo Ana y Luis iba por su turno.
    const ctx: BlockContext = { signers: [ANA, LUIS], docs: docStates(), keys: FP };
    const onlyAna = captureForBlock(SPLIT, "bk-1", { signature: DRAFT }, ctx);
    render(<Harness blocks={onlyAna} keys={EDITED} ceremony={{ signerId: LUIS.id, stage: "capture" }} />);
    expect(screen.getByRole("heading", { name: es.handoffTitle("Ana") })).toBeTruthy();
    expect(screen.getByText(es.turnOf(1, 2))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: es.captureTitle("Luis") })).toBeNull();
  });

  it("en la lista de la ronda, quien debe volver a firmar sale con ✗ y «Debe volver a firmar · cambió el texto del documento» (no solo «Sin firmar»)", () => {
    render(<Harness blocks={bothSigned()} keys={EDITED} />);
    const row = document.querySelector('[data-stale-signer="sg-1"]') as HTMLElement;
    expect(row).toBeTruthy();
    // Sigue pendiente («Sin firmar», como siempre) y ademas dice QUE paso.
    expect(row.textContent).toContain("Sin firmar");
    expect(row.querySelector("[data-stale-reason]")?.textContent).toBe("Debe volver a firmar · cambió el texto del documento");
    expect(row.querySelector("svg")).toBeTruthy();
  });

  it("en la lista de progreso del turno, el trazo que ya estaba hecho sale marcado «ya no es válida»", () => {
    const ctx: BlockContext = { signers: [ANA, LUIS], docs: docStates(), keys: FP };
    // Ana con DOS bloques (uno por documento): firmo los dos y el texto cambio en el documento A.
    const twoBlocks: SignerBlock[] = [
      { id: "bk-1", signerId: ANA.id, appliesTo: [A], signature: null, initials: null, stamps: {}, auto: false },
      { id: "bk-3", signerId: ANA.id, appliesTo: [B], signature: null, initials: null, stamps: {}, auto: false },
      SPLIT[1],
    ];
    let blocks = captureForBlock(twoBlocks, "bk-1", { signature: DRAFT }, ctx);
    blocks = captureForBlock(blocks, "bk-3", { signature: DRAFT }, ctx);
    render(<Harness blocks={blocks} keys={EDITED} ceremony={{ signerId: ANA.id, stage: "capture" }} />);
    const list = screen.getByRole("list", { name: es.ceremonyProgressLabel("Ana") });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // El bloque del documento A (con el texto cambiado) ya no es valido; el del B sigue hecho.
    expect(items[0].textContent).toContain("ya no es válida");
    expect(items[1].textContent).not.toContain("ya no es válida");
    expect(items[1].textContent).toContain("hecho");
  });

  it("sin cambios en el documento no hay aviso ni marca de obsoleta", () => {
    render(<Harness blocks={bothSigned()} keys={FP} />);
    expect(document.querySelector("[data-stale-signatures]")).toBeNull();
    expect(document.querySelector("[data-stale-signer]")).toBeNull();
  });

  it("quien nunca firmo esta «Sin firmar» a secas: no se le pide «volver» a firmar", () => {
    render(<Harness blocks={SPLIT} keys={EDITED} />);
    expect(document.querySelector("[data-stale-signatures]")).toBeNull();
    expect(screen.getAllByText("Sin firmar").length).toBeGreaterThan(0);
  });

  it("al volver a firmar con el documento ya editado, el aviso de esa persona desaparece", () => {
    const ctx: BlockContext = { signers: [ANA, LUIS], docs: docStates(), keys: EDITED };
    const blocks = captureForBlock(bothSigned(), "bk-1", { signature: DRAFT }, ctx);
    render(<Harness blocks={blocks} keys={EDITED} />);
    expect(screen.queryByText(FRASE_ANA)).toBeNull();
    expect(notice().getByText(/La firma de Luis ya no es válida/)).toBeTruthy();
  });

  it("si cambian los huecos de firma lo dice con esas palabras", () => {
    const moved = docStates();
    moved[A] = { ...moved[A], fields: [slot("a1", ANA.id), slot("a1b", ANA.id), slot("a2", LUIS.id)] };
    const blocks = bothSigned();
    render(
      <LanguageProvider>
        <BlockCeremony
          signers={[ANA, LUIS]}
          docs={DOCS}
          docStates={moved}
          keys={FP}
          blocks={blocks}
          onBlocksChange={() => {}}
          blockerMessages={[]}
          blocked={false}
          onFinish={() => {}}
          strings={es}
        />
      </LanguageProvider>,
    );
    expect(notice().getByText("La firma de Ana ya no es válida porque cambiaste los huecos de firma del documento: Ana debe volver a firmar.")).toBeTruthy();
  });

  it("en ingles, todo en ingles", () => {
    render(<Harness blocks={bothSigned()} keys={EDITED} language="en" />);
    expect(notice().getByText("Ana's signature is no longer valid because you changed the document text: Ana must sign again.")).toBeTruthy();
    expect(document.querySelector("[data-stale-reason]")?.textContent).toBe("Must sign again · the document text changed");
  });

  it("«Listo, es mi turno» de quien debe volver a firmar abre su captura y la firma de nuevo deja la lista al dia", () => {
    render(<Harness blocks={bothSigned()} keys={EDITED} ceremony={{ signerId: ANA.id, stage: "handoff" }} />);
    fireEvent.click(screen.getAllByRole("button", { name: es.handoffReady })[0]);
    expect(screen.getByRole("heading", { name: es.captureTitle("Ana") })).toBeTruthy();
  });
});

describe("SigningCeremony (un documento) · lo mismo", () => {
  const FIELDS = [slot("f1", ANA.id), slot("f2", LUIS.id)];
  const captureOf = (key: string, signerId: string): CaptureMap[string] => ({
    signature: DRAFT,
    initials: null,
    stamp: captureStamp(key, FIELDS.filter((field) => field.signerId === signerId), signerId),
  });
  // `captureStamp` mira solo los huecos del firmante: se calcula con todos y se filtra dentro.
  const capturesFor = (key: string): CaptureMap => ({
    [ANA.id]: { ...captureOf(key, ANA.id), stamp: captureStamp(key, FIELDS, ANA.id) },
    [LUIS.id]: { ...captureOf(key, LUIS.id), stamp: captureStamp(key, FIELDS, LUIS.id) },
  });

  function renderSingle(documentKey: string, captures: CaptureMap, ceremony?: CeremonyState | null, strings = es) {
    return render(
      <LanguageProvider>
        <SigningCeremony
          signers={[ANA, LUIS]}
          fields={FIELDS}
          captures={captures}
          onCapturesChange={() => {}}
          documentKey={documentKey}
          onFinish={() => {}}
          strings={strings}
          {...(ceremony !== undefined ? { ceremony, onCeremonyChange: () => {} } : {})}
        />
      </LanguageProvider>,
    );
  }

  it("tras editar el texto, dice que la firma de cada uno ya no es valida y quien debe volver a firmar", () => {
    renderSingle(stampKeyOf(FP[A], [EDIT]) as string, capturesFor(FP[A]));
    const notice = document.querySelector("[data-stale-signatures]") as HTMLElement;
    expect(within(notice).getByText(FRASE_ANA)).toBeTruthy();
    expect(document.querySelector('[data-stale-signer="sg-1"] [data-stale-reason]')?.textContent).toBe(
      "Debe volver a firmar · cambió el texto del documento",
    );
  });

  it("el turno vuelve a Ana aunque el guardado fuera de Luis", () => {
    const edited = stampKeyOf(FP[A], [EDIT]) as string;
    const captures: CaptureMap = { [ANA.id]: capturesFor(FP[A])[ANA.id] };
    renderSingle(edited, captures, { signerId: LUIS.id, stage: "capture" });
    expect(screen.getByRole("heading", { name: es.handoffTitle("Ana") })).toBeTruthy();
  });

  it("sin cambios no hay aviso", () => {
    renderSingle(FP[A], capturesFor(FP[A]));
    expect(document.querySelector("[data-stale-signatures]")).toBeNull();
  });

  it("en ingles", () => {
    renderSingle(stampKeyOf(FP[A], [EDIT]) as string, capturesFor(FP[A]), undefined, en);
    expect(notice().getByText("Ana's signature is no longer valid because you changed the document text: Ana must sign again.")).toBeTruthy();
  });
});
