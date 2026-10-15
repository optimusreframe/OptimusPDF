import { describe, expect, it } from "vitest";
import { currentSingleDraft, ensureSingleDraft, type SingleDraftIdentity } from "@/app/sign-pdf/singleDraft";

/** La identidad del borrador de UN documento suelto: un id por sesion de trabajo (F0-fix, D3). */

const FP = "a".repeat(64);
const ref = () => ({ current: null as SingleDraftIdentity | null });
let counter = 0;
const mint = () => `id-${(counter += 1)}`;

describe("ensureSingleDraft", () => {
  it("estrena un id la primera vez y lo conserva mientras sea el mismo documento y la misma huella (idempotente)", () => {
    const r = ref();
    const first = ensureSingleDraft(r, "doc-1", FP, mint);
    const again = ensureSingleDraft(r, "doc-1", FP, mint);
    expect(again).toBe(first);
    expect(r.current).toBe(first);
    expect(first).toEqual({ docId: "doc-1", fingerprint: FP, id: expect.stringMatching(/^id-\d+$/) });
  });

  it("el mismo PDF subido OTRA vez (otro documento vivo) es OTRA sesion de trabajo: id nuevo, el anterior no se reutiliza", () => {
    const r = ref();
    const first = ensureSingleDraft(r, "doc-1", FP, mint);
    const second = ensureSingleDraft(r, "doc-2", FP, mint);
    expect(second.id).not.toBe(first.id);
    expect(r.current).toBe(second);
  });

  it("otra huella en el mismo documento vivo tambien es otra sesion", () => {
    const r = ref();
    const first = ensureSingleDraft(r, "doc-1", FP, mint);
    expect(ensureSingleDraft(r, "doc-1", "b".repeat(64), mint).id).not.toBe(first.id);
  });

  it("por defecto los ids son de 64 hexadecimales con la mitad de la huella", () => {
    const r = ref();
    const identity = ensureSingleDraft(r, "doc-1", FP);
    expect(identity.id).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.id).not.toBe(FP);
    expect(identity.id.slice(0, 32)).toBe(FP.slice(0, 32));
  });
});

describe("currentSingleDraft", () => {
  it("devuelve la identidad solo si es de ESTE documento y ESTA huella; si no, null (sin estrenar ninguna)", () => {
    const r = ref();
    expect(currentSingleDraft(r, "doc-1", FP)).toBeNull();
    const made = ensureSingleDraft(r, "doc-1", FP, mint);
    expect(currentSingleDraft(r, "doc-1", FP)).toBe(made);
    expect(currentSingleDraft(r, "doc-2", FP)).toBeNull();
    expect(currentSingleDraft(r, "doc-1", "c".repeat(64))).toBeNull();
    expect(r.current).toBe(made);
  });
});
