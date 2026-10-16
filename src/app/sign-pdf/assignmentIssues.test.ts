import { describe, expect, it } from "vitest";
import { fixTargetOf, issueText } from "@/app/sign-pdf/assignmentIssues";
import { messageKeyOf, ISSUE_KINDS, type Issue } from "@/app/sign-pdf/assignmentValidation";
import type { SignerBlock } from "@/app/sign-pdf/docSet";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";

const ANA = { id: "sg-1", name: "Ana", color: "#000" };
const DOCS = [{ id: "d1", name: "Contrato.pdf" }, { id: "d2", name: "Anexo.pdf" }];
const BLOCKS: SignerBlock[] = [
  { id: "b1", signerId: "sg-1", appliesTo: ["d1"], signature: null, initials: null, stamps: {}, auto: false },
  { id: "b2", signerId: "sg-1", appliesTo: ["d2"], signature: null, initials: null, stamps: {}, auto: false },
];
const names = { signers: [ANA], docs: DOCS, blocks: BLOCKS };
const make = (kind: Issue["kind"], rest: Partial<Issue> = {}): Issue => ({
  kind, severity: "blocking", messageKey: messageKeyOf(kind), params: {}, ...rest,
});

describe("fixTargetOf", () => {
  it("campos de texto vacios -> el paso Documento de ese documento", () => {
    expect(fixTargetOf(make("requiredFieldEmpty", { docId: "d2" }))).toEqual({ step: "document", docId: "d2" });
    expect(fixTargetOf(make("requiredFieldEmpty"))).toEqual({ step: "signers" });
  });
  it("trazo que falta -> el turno de ese firmante", () => {
    expect(fixTargetOf(make("groupWithoutStroke", { signerId: "sg-1" }))).toEqual({ step: "turn", signerId: "sg-1" });
    expect(fixTargetOf(make("groupWithoutStroke"))).toEqual({ step: "signers" });
  });
  it("lo demas se arregla en la tabla, con la celda del problema", () => {
    expect(fixTargetOf(make("slotWithoutSigner", { signerId: "sg-1", docId: "d2" }))).toEqual({ step: "signers", docId: "d2", signerId: "sg-1" });
    expect(fixTargetOf(make("tooManyFiles"))).toEqual({ step: "signers", docId: undefined, signerId: undefined });
  });
});

describe("issueText", () => {
  const es = SIGN_STRINGS.es;
  const en = SIGN_STRINGS.en;

  it("nombra al firmante, el documento (sin .pdf) y la firma", () => {
    expect(issueText(make("slotWithoutSigner", { signerId: "sg-1", docId: "d2" }), names, es)).toBe(
      "Ana tiene un hueco de firma en Anexo, pero no está asignado a ese documento.",
    );
    expect(issueText(make("documentWithoutSigner", { docId: "d1" }), names, es)).toBe("Nadie firma Contrato.");
    expect(issueText(make("signerWithoutDocuments", { signerId: "sg-1" }), names, es)).toBe("Ana no firma ningún documento.");
  });
  it("la letra del grupo sale del bloque o del propio problema", () => {
    expect(issueText(make("signerWithoutSlot", { signerId: "sg-1", docId: "d2", blockId: "b2" }), names, es)).toContain("la firma B");
    expect(issueText(make("signerWithoutSlot", { signerId: "sg-1", docId: "d1", group: "C" }), names, es)).toContain("la firma C");
  });
  it("trazos que faltan: firma, iniciales o las dos", () => {
    const text = (types: string[]) => issueText(make("groupWithoutStroke", { signerId: "sg-1", blockId: "b1", params: { types } }), names, es);
    expect(text(["signature"])).toBe("A Ana le falta la firma de la firma A.");
    expect(text(["initials"])).toBe("A Ana le falta las iniciales de la firma A.");
    expect(text(["signature", "initials"])).toBe("A Ana le falta la firma y las iniciales de la firma A.");
  });
  it("sin la lista de trazos que faltan se dice la firma", () => {
    expect(issueText(make("groupWithoutStroke", { signerId: "sg-1", blockId: "b1" }), names, es)).toBe("A Ana le falta la firma de la firma A.");
  });
  it("cuenta y maximo de archivos y campos", () => {
    expect(issueText(make("tooManyFiles", { params: { count: 55, max: 50 } }), names, es)).toContain("55 archivos");
    expect(issueText(make("requiredFieldEmpty", { docId: "d1", params: { count: 1 } }), names, es)).toContain("1 campo de texto sin rellenar");
    expect(issueText(make("requiredFieldEmpty", { docId: "d1", params: { count: 3 } }), names, es)).toContain("3 campos de texto sin rellenar");
  });
  it("todos los tipos de problema tienen frase en ES y EN, sin claves crudas", () => {
    for (const kind of ISSUE_KINDS) {
      const issue = make(kind, { signerId: "sg-1", docId: "d1", blockId: "b1", params: { count: 2, max: 50, types: ["signature"] } });
      for (const strings of [es, en]) {
        const text = issueText(issue, names, strings);
        expect(text.length, kind).toBeGreaterThan(10);
        expect(text, kind).not.toContain("assignment.issue");
        expect(text, kind).not.toContain("undefined");
      }
    }
  });
  it("en ingles", () => {
    expect(issueText(make("documentWithoutSigner", { docId: "d1" }), names, en)).toBe("Nobody signs Contrato.");
  });
});
