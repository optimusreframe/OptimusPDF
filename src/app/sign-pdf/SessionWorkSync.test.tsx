import { createRef, type MutableRefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SessionWorkSync } from "@/app/sign-pdf/SessionWorkSync";
import { EMPTY_DOC_STATE, docIdOf, type DocState } from "@/app/sign-pdf/docSet";
import type { SessionIdentity } from "@/app/sign-pdf/sessionDraft";
import { DEFAULT_SESSION, viewOf, type SignSession } from "@/app/sign-pdf/signSession";
import type { SingleDraftIdentity } from "@/app/sign-pdf/singleDraft";
import { SOLO_GUARD_ID } from "@/app/sign-pdf/signWork";
import type { SignWork } from "@/app/sign-pdf/useLeaveGuard";
import type { Signer } from "@/lib/pdf/sign";

/**
 * Lo que `SessionWorkSync` le cuenta a la guarda de salida (F0-fix): `saved` solo es verdad con el borrador al dia, con la
 * RAZON de cuando no lo esta (no cabe / el navegador no deja guardar / «Solo yo»), y el id propio de la sesion de trabajo.
 */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const pdf = (name: string, byte: number) => new File([new Uint8Array([37, 80, 68, 70, byte])], name, { type: "application/pdf" });
const FINGERPRINT = "f".repeat(64);

afterEach(cleanup);

function setup(over: {
  files: File[];
  session?: Partial<SignSession>;
  tooBig?: boolean;
  writeFailed?: boolean;
  singleDraftRef?: MutableRefObject<SingleDraftIdentity | null>;
  sealedKey?: string;
}) {
  const ids = over.files.map(docIdOf);
  const session: SignSession = {
    ...DEFAULT_SESSION,
    mode: "multi",
    signers: [ANA],
    docOrder: ids,
    activeDocId: ids[0],
    docs: Object.fromEntries(ids.map((id) => [id, { ...EMPTY_DOC_STATE, sealedKey: over.sealedKey ?? "" } as DocState])),
    ...over.session,
  };
  const identityRef = createRef<SessionIdentity | null>() as MutableRefObject<SessionIdentity | null>;
  identityRef.current = { id: "s-sesion-1", stored: new Map(), saved: true };
  const onWork = vi.fn<(work: SignWork) => void>();
  const options = viewOf(session, ids[0]);
  const view = render(
    <SessionWorkSync
      files={over.files}
      session={session}
      options={options}
      keys={Object.fromEntries(ids.map((id) => [id, "k"]))}
      tooBig={over.tooBig ?? false}
      writeFailed={over.writeFailed}
      singleDraftRef={over.singleDraftRef}
      identityRef={identityRef}
      onWork={onWork}
    />,
  );
  return { onWork, view };
}

const last = (onWork: ReturnType<typeof vi.fn>) => onWork.mock.calls.at(-1)?.[0] as SignWork;

describe("SessionWorkSync · saved y su razon", () => {
  const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];

  it("con el borrador al dia: saved, sin razon, apuntando a la sesion", () => {
    const { onWork } = setup({ files });
    expect(last(onWork)).toEqual({ progress: true, draftId: "s-sesion-1", saved: true, roundOpen: false });
  });

  it("el ultimo guardado FALLO (cuota, bloqueado...): NO esta guardado, con razon `failed`", () => {
    const { onWork } = setup({ files, writeFailed: true });
    expect(last(onWork)).toMatchObject({ progress: true, saved: false, unsaved: "failed" });
  });

  it("no cabe como borrador: `tooBig`, y manda sobre el fallo", () => {
    expect(last(setup({ files, tooBig: true }).onWork)).toMatchObject({ saved: false, unsaved: "tooBig" });
    expect(last(setup({ files, tooBig: true, writeFailed: true }).onWork)).toMatchObject({ saved: false, unsaved: "tooBig" });
  });

  it("«Solo yo» con trabajo: hay progreso que proteger, NO esta guardado (razon `solo`) y `?s=` lleva el valor reservado", () => {
    const { onWork } = setup({ files, session: { mode: "single", signers: [], signaturePng: "data:image/png;base64,AAAA" } });
    expect(last(onWork)).toEqual({ progress: true, draftId: SOLO_GUARD_ID, saved: false, unsaved: "solo", roundOpen: false });
  });

  it("«Solo yo» sin trabajo: nada que proteger", () => {
    const { onWork } = setup({ files, session: { mode: "single", signers: [] } });
    expect(last(onWork)).toMatchObject({ progress: false, draftId: null, saved: true });
  });

  it("un fallo de escritura sin progreso no inventa trabajo que proteger", () => {
    const { onWork } = setup({ files, session: { signers: [] }, writeFailed: true });
    expect(last(onWork)).toMatchObject({ progress: false });
  });
});

describe("SessionWorkSync · el id del borrador de UN documento", () => {
  it("es el de la sesion de trabajo (no la huella del PDF) y se estrena en cuanto hay progreso", () => {
    const single = { current: null as SingleDraftIdentity | null };
    const file = pdf("solo.pdf", 3);
    const { onWork } = setup({ files: [file], singleDraftRef: single, sealedKey: FINGERPRINT });
    const work = last(onWork);
    expect(work.progress).toBe(true);
    expect(work.draftId).toMatch(/^[0-9a-f]{64}$/);
    expect(work.draftId).not.toBe(FINGERPRINT);
    expect(single.current).toEqual({ docId: docIdOf(file), fingerprint: FINGERPRINT, id: work.draftId });
  });

  it("si ya hay identidad (retomado, o estrenada por el autoguardado) usa ESA", () => {
    const file = pdf("solo.pdf", 4);
    const single = { current: { docId: docIdOf(file), fingerprint: FINGERPRINT, id: "e".repeat(64) } as SingleDraftIdentity | null };
    const { onWork } = setup({ files: [file], singleDraftRef: single, sealedKey: FINGERPRINT });
    expect(last(onWork).draftId).toBe("e".repeat(64));
  });

  it("mientras la huella aun se calcula no hay id (y no se estrena ninguno)", () => {
    const single = { current: null as SingleDraftIdentity | null };
    const { onWork } = setup({ files: [pdf("solo.pdf", 5)], singleDraftRef: single, sealedKey: "" });
    expect(last(onWork).draftId).toBeNull();
    expect(single.current).toBeNull();
  });

  it("con varios documentos el id es el de la sesion guardada", () => {
    const single = { current: null as SingleDraftIdentity | null };
    const { onWork } = setup({ files: [pdf("a.pdf", 6), pdf("b.pdf", 7)], singleDraftRef: single, sealedKey: FINGERPRINT });
    expect(last(onWork).draftId).toBe("s-sesion-1");
    expect(single.current).toBeNull();
  });
});
