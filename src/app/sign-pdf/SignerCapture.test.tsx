import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SignerManager } from "@/app/sign-pdf/SignerManager";
import { useEarlyCapture } from "@/app/sign-pdf/useEarlyCapture";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { captureStamp, type CaptureMap } from "@/app/sign-pdf/captures";
import { EMPTY_DOC_STATE, type DocId, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import type { SessionBridge } from "@/app/sign-pdf/useSessionBridge";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import { stampKeyOf } from "@/app/sign-pdf/textEdits";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import type { Signer } from "@/lib/pdf/sign";

/*
 * El compositor real dibuja en un canvas (E2E lo recorre de punta a punta): aqui se sustituye por un boton que «guarda» un
 * trazo fijo para probar lo que importa de esta pieza -- el estado en texto, las acciones y a donde va lo guardado.
 */
const DRAFT: SignatureDraft = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 };
vi.mock("@/app/sign-pdf/SignatureComposer", () => ({
  SignatureComposer: ({
    onSave,
    onClose,
    title,
  }: {
    onSave: (draft: SignatureDraft) => void;
    onClose: () => void;
    title?: string;
  }) => (
    <div role="dialog" aria-label={title}>
      <button
        type="button"
        onClick={() => {
          onSave(DRAFT);
          onClose();
        }}
      >
        Usar esta firma
      </button>
    </div>
  ),
}));

const strings = SIGN_STRINGS.es;
const en = SIGN_STRINGS.en;
const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const KEY = "a".repeat(64);

/* ------------------------------------------------------------------ *
 * Un documento
 * ------------------------------------------------------------------ */

type SingleProps = {
  signers?: Signer[];
  initialCaptures?: CaptureMap;
  stampKey?: string | null;
  fieldCounts?: Record<string, number>;
  language?: typeof strings;
  onCaptures?: (captures: CaptureMap) => void;
};

function SingleHarness({
  signers = [ANA, LUIS],
  initialCaptures = {},
  stampKey = KEY,
  fieldCounts = {},
  language = strings,
  onCaptures,
}: SingleProps) {
  const [captures, setCaptures] = useState<CaptureMap>(initialCaptures);
  const early = useEarlyCapture({
    options: { signers, captures },
    setOptions: (patch) => {
      if (patch.captures) {
        setCaptures(patch.captures);
        onCaptures?.(patch.captures);
      }
    },
    stampKey,
    fileName: "contrato.pdf",
    strings: language,
  });
  return (
    <SignerManager
      signers={signers}
      onSignersChange={() => {}}
      activeSignerId={signers[0]?.id ?? null}
      onActiveSignerIdChange={() => {}}
      fieldCounts={fieldCounts}
      strings={language}
      capture={early}
    />
  );
}

/** La tarjeta de un firmante (la que lleva su estado). */
function card(signerId: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-early-capture="${signerId}"]`);
  if (!node) throw new Error(`sin tarjeta para ${signerId}`);
  return node;
}

const statusText = (signerId: string) => card(signerId).querySelector("[data-early-status]")?.textContent ?? "";

describe("recoger firma e iniciales en el paso Firmantes (un documento)", () => {
  it("cada firmante empieza «Sin recoger», con «Recoger firma e iniciales» y sin «Quitar»", () => {
    render(<SingleHarness />);
    expect(statusText(ANA.id)).toBe(strings.early.statusNone);
    expect(statusText(LUIS.id)).toBe(strings.early.statusNone);
    expect(within(card(ANA.id)).getByRole("button", { name: strings.early.collectFor("Ana") }).textContent).toBe(strings.early.collect);
    expect(within(card(ANA.id)).queryByRole("button", { name: /Quitar lo recogido/ })).toBeNull();
  });

  it("el estado se dice con TEXTO para cada caso (firma sola, iniciales solas, las dos)", () => {
    const stamp = captureStamp(KEY);
    render(
      <SingleHarness
        initialCaptures={{
          [ANA.id]: { signature: DRAFT, initials: DRAFT, stamp },
          [LUIS.id]: { signature: DRAFT, initials: null, stamp },
        }}
      />,
    );
    expect(statusText(ANA.id)).toBe("Firma e iniciales recogidas");
    expect(statusText(LUIS.id)).toBe("Solo firma");
    expect(within(card(ANA.id)).getByRole("button", { name: strings.early.changeFor("Ana") }).textContent).toBe("Cambiar");
    expect(within(card(ANA.id)).getByRole("button", { name: strings.early.removeFor("Ana") }).textContent).toBe("Quitar");
  });

  it("recoger la firma y luego las iniciales desde el panel, con la huella del documento y sin ningun hueco", () => {
    const seen: CaptureMap[] = [];
    render(<SingleHarness onCaptures={(captures) => seen.push(captures)} />);
    fireEvent.click(within(card(ANA.id)).getByRole("button", { name: strings.early.collectFor("Ana") }));

    const panel = within(card(ANA.id)).getByRole("group", { name: strings.early.panelLabel("Ana") });
    // Las mismas filas y rotulos de la ceremonia: Firma / Iniciales, cada una con «Usar una guardada».
    expect(within(panel).getByRole("button", { name: strings.captureSignature })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: strings.captureInitials })).toBeTruthy();
    expect(within(panel).getAllByRole("button", { name: /Usar una guardada/ })).toHaveLength(2);

    fireEvent.click(within(panel).getByRole("button", { name: strings.captureSignature }));
    fireEvent.click(screen.getByRole("button", { name: "Usar esta firma" }));
    expect(seen.at(-1)?.[ANA.id]).toEqual({ signature: DRAFT, initials: null, stamp: KEY });
    expect(statusText(ANA.id)).toBe("Solo firma");

    fireEvent.click(within(panel).getByRole("button", { name: strings.captureInitials }));
    fireEvent.click(screen.getByRole("button", { name: "Usar esta firma" }));
    expect(seen.at(-1)?.[ANA.id]).toEqual({ signature: DRAFT, initials: DRAFT, stamp: KEY });
    expect(statusText(ANA.id)).toBe("Firma e iniciales recogidas");
    // Luis no se toco.
    expect(seen.at(-1)?.[LUIS.id]).toBeUndefined();
    expect(statusText(LUIS.id)).toBe(strings.early.statusNone);
  });

  it("se puede dejar una de las dos: solo iniciales", () => {
    render(<SingleHarness />);
    fireEvent.click(within(card(ANA.id)).getByRole("button", { name: strings.early.collectFor("Ana") }));
    fireEvent.click(within(card(ANA.id)).getByRole("button", { name: strings.captureInitials }));
    fireEvent.click(screen.getByRole("button", { name: "Usar esta firma" }));
    expect(statusText(ANA.id)).toBe("Solo iniciales");
  });

  it("«Quitar» vacia lo recogido de ese firmante y lo anuncia; «Listo» cierra el panel", async () => {
    const seen: CaptureMap[] = [];
    const stamp = captureStamp(KEY);
    render(
      <SingleHarness
        initialCaptures={{
          [ANA.id]: { signature: DRAFT, initials: DRAFT, stamp },
          [LUIS.id]: { signature: DRAFT, initials: DRAFT, stamp },
        }}
        onCaptures={(captures) => seen.push(captures)}
      />,
    );
    fireEvent.click(within(card(ANA.id)).getByRole("button", { name: strings.early.removeFor("Ana") }));
    expect(Object.keys(seen.at(-1) ?? {})).toEqual([LUIS.id]);
    expect(statusText(ANA.id)).toBe(strings.early.statusNone);
    expect(statusText(LUIS.id)).toBe("Firma e iniciales recogidas");
    expect(screen.getByRole("status", { name: "" }).textContent).toContain(strings.early.announceRemoved("Ana"));
    // El foco no se pierde: el boton «Quitar» desaparece y pasa a «Recoger» de la misma tarjeta.
    await waitFor(() => expect(document.activeElement).toBe(within(card(ANA.id)).getByRole("button", { name: strings.early.collectFor("Ana") })));

    fireEvent.click(within(card(LUIS.id)).getByRole("button", { name: strings.early.changeFor("Luis") }));
    expect(within(card(LUIS.id)).getByRole("group", { name: strings.early.panelLabel("Luis") })).toBeTruthy();
    fireEvent.click(within(card(LUIS.id)).getByRole("button", { name: strings.early.done }));
    expect(within(card(LUIS.id)).queryByRole("group")).toBeNull();
  });

  it("con trazo recogido y sin campos se avisa en una linea «aun no tiene campos»; con campos, no", () => {
    const stamp = captureStamp(KEY);
    const captures: CaptureMap = { [ANA.id]: { signature: DRAFT, initials: DRAFT, stamp } };
    const { unmount } = render(<SingleHarness initialCaptures={captures} fieldCounts={{}} />);
    expect(card(ANA.id).querySelector("[data-early-no-fields]")?.textContent).toBe(strings.early.noFieldsYet);
    // Luis no recogio nada: no hay nada que avisar.
    expect(card(LUIS.id).querySelector("[data-early-no-fields]")).toBeNull();
    unmount();
    render(<SingleHarness initialCaptures={captures} fieldCounts={{ [ANA.id]: 2 }} />);
    expect(card(ANA.id).querySelector("[data-early-no-fields]")).toBeNull();
  });

  it("el texto original editado deja «Debe volver a firmar · cambió el texto del documento» y la frase completa", () => {
    const stamp = captureStamp(KEY);
    const edited = stampKeyOf(KEY, [makeEdit({ id: "e1", blockId: "p0-b0", text: "nuevo" })]);
    render(
      <SingleHarness
        stampKey={edited}
        initialCaptures={{ [ANA.id]: { signature: DRAFT, initials: DRAFT, stamp } }}
      />,
    );
    expect(statusText(ANA.id)).toBe("Debe volver a firmar · cambió el texto del documento");
    const notice = document.querySelector("[data-stale-signatures]");
    expect(notice?.textContent).toContain("La firma de Ana ya no es válida porque cambiaste el texto del documento");
    // Quitar sigue disponible (limpia el trazo caducado) y recoger de nuevo parte de cero.
    expect(within(card(ANA.id)).getByRole("button", { name: strings.early.removeFor("Ana") })).toBeTruthy();
    expect(within(card(ANA.id)).getByRole("button", { name: strings.early.collectFor("Ana") })).toBeTruthy();
  });

  it("cambiar de documento deja «cambió el documento»", () => {
    const stamp = captureStamp(KEY);
    render(<SingleHarness stampKey={"b".repeat(64)} initialCaptures={{ [ANA.id]: { signature: DRAFT, initials: null, stamp } }} />);
    expect(statusText(ANA.id)).toBe("Debe volver a firmar · cambió el documento");
  });

  it("mientras la huella se calcula no se puede recoger nada y se dice", () => {
    render(<SingleHarness stampKey={null} />);
    expect(statusText(ANA.id)).toBe(strings.checkingDocument);
    expect((within(card(ANA.id)).getByRole("button", { name: strings.early.collectFor("Ana") }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("los textos salen en inglés con el idioma en inglés", () => {
    const stamp = captureStamp(KEY);
    render(<SingleHarness language={en} initialCaptures={{ [ANA.id]: { signature: DRAFT, initials: DRAFT, stamp } }} />);
    expect(statusText(ANA.id)).toBe("Signature and initials collected");
    expect(statusText(LUIS.id)).toBe("Not collected");
    expect(within(card(ANA.id)).getByRole("button", { name: en.early.removeFor("Ana") }).textContent).toBe("Remove");
  });

  it("el estado no depende del color: cada estado lleva su texto y el icono va oculto a los lectores", () => {
    const stamp = captureStamp(KEY);
    render(<SingleHarness initialCaptures={{ [ANA.id]: { signature: DRAFT, initials: null, stamp } }} />);
    for (const node of document.querySelectorAll("[data-early-status]")) {
      expect((node.textContent ?? "").trim().length).toBeGreaterThan(0);
      for (const icon of node.querySelectorAll("svg")) expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

/* ------------------------------------------------------------------ *
 * Varios documentos
 * ------------------------------------------------------------------ */

const A: DocId = "doc-a";
const B: DocId = "doc-b";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const DOCS = [
  { id: A, name: "Contrato.pdf" },
  { id: B, name: "Anexo.pdf" },
];

const docStates = (): Record<DocId, DocState> => ({ [A]: { ...EMPTY_DOC_STATE }, [B]: { ...EMPTY_DOC_STATE } });

const independent = (): SignerBlock[] => [
  { id: "bk-1", signerId: ANA.id, appliesTo: [A], signature: null, initials: null, stamps: {}, auto: false },
  { id: "bk-2", signerId: ANA.id, appliesTo: [B], signature: null, initials: null, stamps: {}, auto: false },
  { id: "bk-3", signerId: LUIS.id, appliesTo: [A, B], signature: null, initials: null, stamps: {}, auto: false },
];

/** Puente de prueba: aplica el patch a una sesion en memoria, como el real, y repinta. */
function MultiHarness({
  blocks: initialBlocks,
  stampKeys = { [A]: KEY_A, [B]: KEY_B },
  onBlocks,
}: {
  blocks: SignerBlock[];
  stampKeys?: Record<DocId, string | null>;
  onBlocks?: (blocks: SignerBlock[]) => void;
}) {
  const [session, setSession] = useState<SignSession>({
    ...DEFAULT_SESSION,
    signers: [ANA, LUIS],
    docs: docStates(),
    docOrder: [A, B],
    blocks: initialBlocks,
    signMode: "independent",
  });
  const sessionRef = useRef(session);
  const bridge = {
    commit: (compute: (current: SignSession, files: File[]) => Partial<SignSession>) => {
      const patch = compute(sessionRef.current, []);
      if (Object.keys(patch).length === 0) return;
      sessionRef.current = { ...sessionRef.current, ...patch };
      setSession(sessionRef.current);
      if (patch.blocks) onBlocks?.(patch.blocks);
    },
  } as unknown as SessionBridge;
  const early = useEarlyCapture({
    options: { signers: session.signers, captures: {} },
    setOptions: () => {},
    stampKey: null,
    strings,
    multi: { session, bridge, docs: DOCS, stampKeys },
  });
  return (
    <SignerManager
      signers={session.signers}
      onSignersChange={() => {}}
      activeSignerId={ANA.id}
      onActiveSignerIdChange={() => {}}
      fieldCounts={{}}
      strings={strings}
      capture={early}
    />
  );
}

describe("recoger firma e iniciales con varios documentos", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("un firmante con dos grupos ve una fila de Firma e Iniciales POR GRUPO, con el nombre del grupo y sus documentos", () => {
    render(<MultiHarness blocks={independent()} />);
    fireEvent.click(within(card(ANA.id)).getByRole("button", { name: strings.early.collectFor("Ana") }));
    const panel = within(card(ANA.id)).getByRole("group", { name: strings.early.panelLabel("Ana") });
    expect(within(panel).getByText(/Firma A — para: Contrato/)).toBeTruthy();
    expect(within(panel).getByText(/Firma B — para: Anexo/)).toBeTruthy();
    // Con varios grupos el nombre accesible de cada boton lleva el grupo: «Crear mi firma · Firma B».
    expect(within(panel).getByRole("button", { name: "Crear mi firma · Firma B" })).toBeTruthy();
    // Luis tiene un solo grupo (los dos documentos): sin rotular el grupo.
    fireEvent.click(within(card(LUIS.id)).getByRole("button", { name: strings.early.collectFor("Luis") }));
    const luis = within(card(LUIS.id)).getByRole("group", { name: strings.early.panelLabel("Luis") });
    expect(within(luis).getByRole("button", { name: strings.captureSignature })).toBeTruthy();
  });

  it("recoger en un grupo sella SUS documentos con su huella, aunque aun no haya huecos; el otro grupo sigue sin recoger", () => {
    let last: SignerBlock[] = [];
    render(<MultiHarness blocks={independent()} onBlocks={(blocks) => (last = blocks)} />);
    fireEvent.click(within(card(ANA.id)).getByRole("button", { name: strings.early.collectFor("Ana") }));
    fireEvent.click(within(card(ANA.id)).getByRole("button", { name: "Crear mi firma · Firma A" }));
    fireEvent.click(screen.getByRole("button", { name: "Usar esta firma" }));
    const first = last.find((block) => block.id === "bk-1")!;
    expect(first.signature).toBe(DRAFT);
    expect(first.stamps).toEqual({ [A]: KEY_A });
    expect(last.find((block) => block.id === "bk-2")!.signature).toBeNull();
    expect(statusText(ANA.id)).toBe(strings.early.statusPartial);
  });

  it("recoger lo de todos los grupos deja al firmante completo; «Quitar» los vacia todos", () => {
    let last: SignerBlock[] = [];
    render(<MultiHarness blocks={independent()} onBlocks={(blocks) => (last = blocks)} />);
    fireEvent.click(within(card(ANA.id)).getByRole("button", { name: strings.early.collectFor("Ana") }));
    for (const group of ["A", "B"]) {
      for (const type of ["firma", "iniciales"]) {
        const name = type === "firma" ? `Crear mi firma · Firma ${group}` : `Crear mis iniciales · Firma ${group}`;
        fireEvent.click(within(card(ANA.id)).getByRole("button", { name }));
        fireEvent.click(screen.getByRole("button", { name: "Usar esta firma" }));
      }
    }
    expect(statusText(ANA.id)).toBe("Firma e iniciales recogidas");
    fireEvent.click(within(card(ANA.id)).getByRole("button", { name: strings.early.removeFor("Ana") }));
    expect(statusText(ANA.id)).toBe(strings.early.statusNone);
    expect(last.filter((block) => block.signerId === ANA.id).every((block) => block.signature === null && block.initials === null)).toBe(true);
  });

  it("si cambia el texto de un documento del grupo, el firmante dice «Debe volver a firmar · cambió el texto del documento»", () => {
    const base = independent();
    const stamped = base.map((block) =>
      block.id === "bk-1" ? { ...block, signature: DRAFT, initials: DRAFT, stamps: { [A]: KEY_A } } : block,
    );
    const edited = stampKeyOf(KEY_A, [makeEdit({ id: "e1", blockId: "p0-b0", text: "nuevo" })]);
    render(<MultiHarness blocks={stamped} stampKeys={{ [A]: edited, [B]: KEY_B }} />);
    expect(statusText(ANA.id)).toBe("Debe volver a firmar · cambió el texto del documento");
    expect(statusText(LUIS.id)).toBe(strings.early.statusNone);
  });

  it("sin la huella de algun documento no se recoge nada", () => {
    render(<MultiHarness blocks={independent()} stampKeys={{ [A]: KEY_A, [B]: null }} />);
    expect(statusText(ANA.id)).toBe(strings.checkingDocument);
    expect((within(card(ANA.id)).getByRole("button", { name: strings.early.collectFor("Ana") }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("la ceremonia lo dice claro cuando todo ya estaba recogido", () => {
  it("el balance de la ronda lleva la frase «ya están recogidas» solo cuando no queda nadie pendiente", async () => {
    // La ceremonia de un documento con Ana ya cubierta: sin turno que pedir.
    const { SigningCeremony } = await import("@/app/sign-pdf/SigningCeremony");
    const fields = [
      { id: "f1", signerId: ANA.id, pageIndex: 0, type: "signature" as const, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } },
    ];
    const done: CaptureMap = { [ANA.id]: { signature: DRAFT, initials: null, stamp: captureStamp(KEY) } };
    const { rerender } = render(
      <SigningCeremony
        signers={[ANA]}
        fields={fields}
        captures={done}
        onCapturesChange={() => {}}
        documentKey={KEY}
        onFinish={() => {}}
        strings={strings}
      />,
    );
    expect(document.querySelector("[data-all-covered]")?.textContent).toBe(strings.early.allCovered);
    expect(screen.getByRole("heading", { name: strings.allSignedTitle })).toBeTruthy();
    expect((screen.getByRole("button", { name: strings.applyAndDownload }) as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      rerender(
        <SigningCeremony
          signers={[ANA]}
          fields={fields}
          captures={{}}
          onCapturesChange={() => {}}
          documentKey={KEY}
          onFinish={() => {}}
          strings={strings}
        />,
      );
    });
    expect(document.querySelector("[data-all-covered]")).toBeNull();
  });
});
