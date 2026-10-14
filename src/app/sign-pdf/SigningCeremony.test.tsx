import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  SigningCeremony,
  captureStamp,
  pendingSigners,
  validCapture,
  type CaptureMap,
  type SignerCapture,
} from "@/app/sign-pdf/SigningCeremony";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { CeremonyState } from "@/app/sign-pdf/blockModel";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

const strings = SIGN_STRINGS.es;

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const SIN_HUECOS: Signer = { id: "sg-3", name: "Eva", color: "#e11d48" };

const DOC = "contrato.pdf:2048:1700000000000";
const OTRO_DOC = "contrato-v2.pdf:2600:1700000999999";

const DRAFT: SignatureDraft = {
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  ratio: 0.3,
};

function field(
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

const FIELDS = [
  field("f1", ANA.id),
  field("f2", ANA.id, "initials"),
  field("f3", LUIS.id),
];

/** Trazo ya atado a `{ documento + huecos }`, como lo deja la ceremonia. */
function captured(
  fields: readonly SignatureField[],
  signerId: string,
  parts: Pick<SignerCapture, "signature" | "initials">,
  documentKey = DOC,
): SignerCapture {
  return { ...parts, stamp: captureStamp(documentKey, fields, signerId) };
}

function allSigned(fields: readonly SignatureField[] = FIELDS): CaptureMap {
  return {
    [ANA.id]: captured(fields, ANA.id, {
      signature: DRAFT,
      initials: DRAFT,
    }),
    [LUIS.id]: captured(fields, LUIS.id, {
      signature: DRAFT,
      initials: null,
    }),
  };
}

/** El mismo hueco de Ana desplazado: no es donde ella firmo. */
function moved(fields: readonly SignatureField[]): SignatureField[] {
  return fields.map((item) =>
    item.id === "f1" ? { ...item, rect: { ...item.rect, x: 0.62 } } : item,
  );
}

/**
 * El turno se DERIVA del primer firmante pendiente al montar (Fase 0 · U0.2): con Ana ya firmada, una
 * ronda recien montada arranca en Luis. La prueba que recorre el turno de Ana con sus trazos precargados
 * lo declara con el turno guardado explicito (el que antes era el inicio implicito).
 */
const ANA_TURN: CeremonyState = { signerId: ANA.id, stage: "handoff" };

type HarnessProps = {
  /** Turno guardado inicial; con valor, la ceremonia va CONTROLADA (como en la sesion real). */
  ceremony?: CeremonyState | null;
  captures: CaptureMap;
  onFinish: () => void;
  fields?: SignatureField[];
  documentKey?: string | null;
};

function Harness({
  ceremony: initialCeremony,
  captures,
  onFinish,
  fields = FIELDS,
  documentKey = DOC,
}: HarnessProps) {
  const [current, setCurrent] = useState<CaptureMap>(captures);
  const [turn, setTurn] = useState<CeremonyState | null>(initialCeremony ?? null);
  return (
    <SigningCeremony
      {...(initialCeremony !== undefined ? { ceremony: turn, onCeremonyChange: setTurn } : {})}
      signers={[ANA, LUIS, SIN_HUECOS]}
      fields={fields}
      captures={current}
      onCapturesChange={setCurrent}
      documentKey={documentKey}
      onFinish={onFinish}
      strings={strings}
    />
  );
}

function finishButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: strings.applyAndDownload,
  }) as HTMLButtonElement;
}

describe("SigningCeremony — src/app/sign-pdf/SigningCeremony.tsx", () => {
  it("no deja finalizar mientras quede alguien sin firmar", () => {
    const onFinish = vi.fn();
    render(<Harness captures={{}} onFinish={onFinish} />);

    expect(finishButton().disabled).toBe(true);
    expect(screen.getByText(strings.pendingBody(2))).toBeTruthy();

    fireEvent.click(finishButton());
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("un firmante a medias (firma si, iniciales no) sigue contando como pendiente", () => {
    const onFinish = vi.fn();
    render(
      <Harness
        captures={{
          [ANA.id]: captured(FIELDS, ANA.id, {
            signature: DRAFT,
            initials: null,
          }),
        }}
        onFinish={onFinish}
      />,
    );

    expect(finishButton().disabled).toBe(true);
    expect(screen.getByText(strings.pendingBody(2))).toBeTruthy();

    fireEvent.click(finishButton());
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("con todos los huecos cubiertos habilita el boton y avisa a quien corresponde", () => {
    const onFinish = vi.fn();
    render(<Harness captures={allSigned()} onFinish={onFinish} />);

    expect(finishButton().disabled).toBe(false);
    expect(screen.getByText(strings.allSignedTitle)).toBeTruthy();

    fireEvent.click(finishButton());
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("sin ningun hueco reservado no hay nada que finalizar", () => {
    const onFinish = vi.fn();
    render(<Harness captures={{}} onFinish={onFinish} fields={[]} />);

    expect(finishButton().disabled).toBe(true);
    fireEvent.click(finishButton());
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("el traspaso arranca por el primer firmante y avanza al siguiente", () => {
    // Luis aun no ha firmado: es el siguiente turno (a quien ya firmo no se le pasa el dispositivo).
    const { [ANA.id]: ana } = allSigned();
    render(<Harness ceremony={ANA_TURN} captures={{ [ANA.id]: ana }} onFinish={() => {}} />);

    expect(screen.getByText(strings.handoffTitle(ANA.name))).toBeTruthy();
    expect(screen.getByText(strings.turnOf(1, 2))).toBeTruthy();

    fireEvent.click(
      screen.getAllByRole("button", { name: strings.handoffReady })[0],
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.captureContinue }),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.reviewNext }));

    expect(screen.getByText(strings.handoffTitle(LUIS.name))).toBeTruthy();
    expect(screen.getByText(strings.turnOf(2, 2))).toBeTruthy();
  });

  it("rehacer la ronda vacia los trazos y vuelve a bloquear el final", () => {
    render(<Harness captures={allSigned()} onFinish={() => {}} />);

    expect(finishButton().disabled).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: strings.restartCeremony }),
    );

    expect(finishButton().disabled).toBe(true);
  });

  it("mover un hueco despues de firmarlo devuelve a su dueño a pendiente", () => {
    const onFinish = vi.fn();
    const { rerender } = render(
      <Harness captures={allSigned()} onFinish={onFinish} />,
    );
    expect(finishButton().disabled).toBe(false);

    // Alguien vuelve al paso de campos y desplaza el hueco de Ana.
    rerender(
      <Harness
        captures={allSigned()}
        onFinish={onFinish}
        fields={moved(FIELDS)}
      />,
    );

    expect(finishButton().disabled).toBe(true);
    expect(screen.getByText(strings.pendingBody(1))).toBeTruthy();
    expect(screen.getAllByText(strings.statusPending)).toHaveLength(1);

    fireEvent.click(finishButton());
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("cambiar el archivo cargado deja a todo el mundo sin firmar", () => {
    const onFinish = vi.fn();
    render(
      <Harness
        captures={allSigned()}
        onFinish={onFinish}
        documentKey={OTRO_DOC}
      />,
    );

    expect(finishButton().disabled).toBe(true);
    expect(screen.getByText(strings.pendingBody(2))).toBeTruthy();
    expect(screen.getAllByText(strings.statusPending)).toHaveLength(2);
  });

  it("mientras no haya identidad del documento no se abre la ronda", () => {
    const onFinish = vi.fn();
    render(
      <Harness
        captures={allSigned()}
        onFinish={onFinish}
        documentKey={null}
      />,
    );

    expect(screen.getByText(strings.checkingDocument)).toBeTruthy();
    // Ni firmar ni rematar: nada que aplicar sobre un archivo sin comprobar.
    expect(
      screen.queryByRole("button", { name: strings.applyAndDownload }),
    ).toBeNull();
    expect(screen.queryByText(strings.handoffTitle(ANA.name))).toBeNull();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("volver a firmar tras mover el hueco no arrastra el trazo anterior", () => {
    const fields = moved(FIELDS);
    const capture = validCapture(allSigned(), fields, ANA.id, DOC);
    expect(capture.signature).toBeNull();
    expect(capture.initials).toBeNull();
  });
});

describe("pendingSigners — src/app/sign-pdf/SigningCeremony.tsx", () => {
  it("ignora a quien no tiene huecos asignados", () => {
    const pending = pendingSigners(
      [ANA, LUIS, SIN_HUECOS],
      FIELDS,
      allSigned(),
      DOC,
    );
    expect(pending).toHaveLength(0);
  });

  it("devuelve a quien tiene huecos y no ha dejado trazo", () => {
    const pending = pendingSigners(
      [ANA, LUIS],
      FIELDS,
      {
        [ANA.id]: captured(FIELDS, ANA.id, {
          signature: DRAFT,
          initials: DRAFT,
        }),
      },
      DOC,
    );
    expect(pending.map((signer) => signer.id)).toEqual([LUIS.id]);
  });

  it("no invalida nada si no cambia ni el documento ni los huecos", () => {
    const captures = allSigned();
    const igual = FIELDS.map((item) => ({ ...item, rect: { ...item.rect } }));
    expect(pendingSigners([ANA, LUIS], igual, captures, DOC)).toHaveLength(0);
  });

  it("redimensionar un hueco invalida solo el trazo de su dueño", () => {
    const fields = FIELDS.map((item) =>
      item.id === "f3"
        ? { ...item, rect: { ...item.rect, width: 0.45 } }
        : item,
    );
    const pending = pendingSigners([ANA, LUIS], fields, allSigned(), DOC);
    expect(pending.map((signer) => signer.id)).toEqual([LUIS.id]);
  });

  it("cambiar un hueco de pagina invalida el trazo de su dueño", () => {
    const fields = FIELDS.map((item) =>
      item.id === "f1" ? { ...item, pageIndex: 3 } : item,
    );
    const pending = pendingSigners([ANA, LUIS], fields, allSigned(), DOC);
    expect(pending.map((signer) => signer.id)).toEqual([ANA.id]);
  });

  it("cambiar el tipo de un hueco invalida el trazo de su dueño", () => {
    const fields = FIELDS.map((item) =>
      item.id === "f3" ? { ...item, type: "initials" as const } : item,
    );
    const pending = pendingSigners([ANA, LUIS], fields, allSigned(), DOC);
    expect(pending.map((signer) => signer.id)).toEqual([LUIS.id]);
  });

  it("añadir un hueco nuevo invalida el trazo de su dueño", () => {
    const fields = [...FIELDS, field("f4", LUIS.id)];
    const pending = pendingSigners([ANA, LUIS], fields, allSigned(), DOC);
    expect(pending.map((signer) => signer.id)).toEqual([LUIS.id]);
  });

  it("reordenar la lista de huecos no invalida nada", () => {
    const fields = [...FIELDS].reverse();
    expect(pendingSigners([ANA, LUIS], fields, allSigned(), DOC)).toHaveLength(
      0,
    );
  });

  it("cambiar el archivo cargado invalida todas las capturas", () => {
    const pending = pendingSigners([ANA, LUIS], FIELDS, allSigned(), OTRO_DOC);
    expect(pending.map((signer) => signer.id)).toEqual([ANA.id, LUIS.id]);
  });
});
