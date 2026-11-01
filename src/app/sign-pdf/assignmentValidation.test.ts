import { describe, expect, it } from "vitest";
import {
  ISSUE_KINDS,
  hasBlockingIssue,
  messageKeyOf,
  validateAssignment,
  type Issue,
  type IssueKind,
} from "@/app/sign-pdf/assignmentValidation";
import { captureStamp } from "@/app/sign-pdf/captures";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { SignatureField, Signer } from "@/lib/pdf/sign";
import { MAX_OUTPUT_FILES } from "@/lib/pdf/signCopies";

/*
 * Validaciones para «Revisar antes de descargar» (U1.1): firmante sin hueco, hueco sin firmante, firmante sin documentos,
 * documento sin firmante, campos de texto vacios, grupo sin trazo, solapes y exceso de archivos. Severidad y CLAVE de
 * mensaje (no cadenas fijas).
 */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const SIG = { dataUrl: "data:image/png;base64,SIG1", ratio: 0.3 };
const INI = { dataUrl: "data:image/png;base64,INI1", ratio: 0.5 };

function slot(id: string, signerId: string, type: "signature" | "initials" = "signature"): SignatureField {
  return { id, signerId, pageIndex: 0, type, rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.08 } };
}

function doc(over: Partial<DocState> = {}): DocState {
  return { ...EMPTY_DOC_STATE, ...over };
}

function block(
  id: string,
  signerId: string,
  appliesTo: string[],
  over: Partial<SignerBlock> = {},
): SignerBlock {
  return { id, signerId, appliesTo, signature: null, initials: null, stamps: {}, auto: false, ...over };
}

/** Los trazos de un bloque, con el sello VIGENTE de cada documento (lo que dejaria la ceremonia). */
function signedBlock(
  id: string,
  signer: Signer,
  docIds: string[],
  docs: Record<string, DocState>,
  extra: Partial<SignerBlock> = {},
): SignerBlock {
  return block(id, signer.id, docIds, {
    signature: SIG,
    stamps: Object.fromEntries(docIds.map((d) => [d, captureStamp(docs[d].sealedKey, docs[d].fields, signer.id)])),
    ...extra,
  });
}

function session(over: Partial<SignSession>): SignSession {
  const docs = over.docs ?? {};
  return {
    ...DEFAULT_SESSION,
    mode: "multi",
    signers: [ANA, LUIS],
    docs,
    docOrder: over.docOrder ?? Object.keys(docs),
    ...over,
  };
}

const kinds = (issues: readonly Issue[]) => issues.map((i) => i.kind);
const ofKind = (issues: readonly Issue[], kind: IssueKind) => issues.filter((i) => i.kind === kind);

/** El caso del usuario ya resuelto: 4 documentos, Ana A,A,B,B con sus dos firmas hechas; Luis firma d1 y d2. */
function completeSession(): SignSession {
  const docs: Record<string, DocState> = {};
  ["d1", "d2", "d3", "d4"].forEach((id, index) => {
    const fields = [slot(`fa${index}`, "sg-1"), ...(index < 2 ? [slot(`fl${index}`, "sg-2")] : [])];
    docs[id] = doc({ sealedKey: `key-${id}`, fields });
  });
  return session({
    docs,
    docOrder: ["d1", "d2", "d3", "d4"],
    blocks: [
      signedBlock("bk-1", ANA, ["d1", "d2"], docs),
      signedBlock("bk-2", ANA, ["d3", "d4"], docs),
      signedBlock("bk-3", LUIS, ["d1", "d2"], docs),
    ],
  });
}

describe("validateAssignment", () => {
  it("una ronda completa (el caso del usuario con todo firmado) no tiene problemas", () => {
    const issues = validateAssignment(completeSession(), { strict: true });
    expect(issues).toEqual([]);
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it("cada problema lleva una CLAVE i18n `assignment.issue.<tipo>`, nunca un texto", () => {
    expect(ISSUE_KINDS.map(messageKeyOf)).toEqual(ISSUE_KINDS.map((k) => `assignment.issue.${k}`));
    const broken = completeSession();
    broken.blocks = [];
    const issues = validateAssignment(broken);
    expect(issues.length).toBeGreaterThan(0);
    for (const found of issues) {
      expect(found.messageKey).toBe(`assignment.issue.${found.kind}`);
      expect(found.messageKey).toMatch(/^assignment\.issue\.[a-zA-Z]+$/);
      expect((found as Record<string, unknown>).message).toBeUndefined();
    }
  });

  it("hueco sin firmante (BLOQUEANTE): Luis tiene hueco en d3 pero ningun grupo lo cubre", () => {
    const s = completeSession();
    s.docs = { ...s.docs, d3: { ...s.docs.d3, fields: [...s.docs.d3.fields, slot("fl3", "sg-2")] } };
    const issues = validateAssignment(s);
    expect(ofKind(issues, "slotWithoutSigner")).toEqual([
      expect.objectContaining({ severity: "blocking", signerId: "sg-2", docId: "d3", messageKey: "assignment.issue.slotWithoutSigner" }),
    ]);
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it("firmante sin hueco (aviso hoy, BLOQUEANTE en modo estricto): Luis tiene grupo en d3 sin hueco ahi", () => {
    const s = completeSession();
    s.blocks = [...s.blocks, block("bk-4", "sg-2", ["d3"])];
    const lax = ofKind(validateAssignment(s), "signerWithoutSlot");
    expect(lax).toEqual([
      expect.objectContaining({ severity: "warning", signerId: "sg-2", docId: "d3", blockId: "bk-4", group: "B" }),
    ]);
    const strict = ofKind(validateAssignment(s, { strict: true }), "signerWithoutSlot");
    expect(strict.map((i) => i.severity)).toEqual(["blocking"]);
  });

  it("«Mismas» no es un problema por si mismo: el grupo de Luis cubre d3 y d4 sin hueco -> solo avisos, no bloquea", () => {
    const s = completeSession();
    s.blocks = [signedBlock("bk-1", ANA, ["d1", "d2", "d3", "d4"], s.docs), signedBlock("bk-3", LUIS, ["d1", "d2", "d3", "d4"], s.docs)];
    const issues = validateAssignment(s);
    expect(ofKind(issues, "signerWithoutSlot").map((i) => [i.docId, i.severity])).toEqual([
      ["d3", "warning"], ["d4", "warning"],
    ]);
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it("firmante sin ningun documento (aviso)", () => {
    const s = completeSession();
    s.docs = Object.fromEntries(
      Object.entries(s.docs).map(([id, state]) => [id, { ...state, fields: state.fields.filter((f) => f.signerId !== "sg-2") }]),
    );
    s.blocks = s.blocks.filter((b) => b.signerId !== "sg-2");
    const found = ofKind(validateAssignment(s), "signerWithoutDocuments");
    expect(found).toEqual([expect.objectContaining({ severity: "warning", signerId: "sg-2" })]);
  });

  it("documento sin firmante: bloquea si ademas esta vacio (nada que entregar) y solo avisa si tiene huecos/campos", () => {
    const s = completeSession();
    s.docs = { ...s.docs, d5: doc({ sealedKey: "key-d5" }) };
    s.docOrder = [...s.docOrder, "d5"];
    const empty = ofKind(validateAssignment(s), "documentWithoutSigner");
    expect(empty).toEqual([expect.objectContaining({ severity: "blocking", docId: "d5" })]);

    const textField: DetectedField = { id: "t1", pageIndex: 0, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 }, source: "manual", confidence: "high" };
    s.docs = { ...s.docs, d5: doc({ sealedKey: "key-d5", textFields: [textField], textValues: { t1: "Ana" } }) };
    expect(ofKind(validateAssignment(s), "documentWithoutSigner")).toEqual([
      expect.objectContaining({ severity: "warning", docId: "d5" }),
    ]);
  });

  it("campos de texto sin rellenar: cuenta por documento, no cuenta las casillas ni las sugerencias; aviso hoy / bloqueante en estricto", () => {
    const s = completeSession();
    const text = (id: string, over: Partial<DetectedField> = {}): DetectedField => ({
      id, pageIndex: 0, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 }, source: "manual", confidence: "high", ...over,
    });
    s.docs = {
      ...s.docs,
      d1: {
        ...s.docs.d1,
        textFields: [
          text("empty-1"),
          text("empty-2"),
          text("filled"),
          text("check", { type: "checkbox" }),
          text("suggested", { source: "heuristic-vector", confidence: "low" }),
        ],
        textValues: { filled: "Hola" },
      },
    };
    const lax = ofKind(validateAssignment(s), "requiredFieldEmpty");
    expect(lax).toEqual([expect.objectContaining({ severity: "warning", docId: "d1", params: { count: 2 } })]);
    expect(ofKind(validateAssignment(s, { strict: true }), "requiredFieldEmpty")[0].severity).toBe("blocking");
  });

  it("grupo sin trazo (BLOQUEANTE): dice que grupo, de quien y que tipos faltan", () => {
    const s = completeSession();
    // La firma B de Ana aun no esta hecha.
    s.blocks = s.blocks.map((b) => (b.id === "bk-2" ? { ...b, signature: null, stamps: {} } : b));
    const found = ofKind(validateAssignment(s), "groupWithoutStroke");
    expect(found).toEqual([
      expect.objectContaining({
        severity: "blocking", signerId: "sg-1", blockId: "bk-2", group: "B",
        params: { types: ["signature"], docIds: ["d3", "d4"] },
      }),
    ]);
  });

  it("un hueco de iniciales nuevo pide SOLO las iniciales (la firma ya hecha se conserva); un trazo de otro documento cuenta como falta", () => {
    const s = completeSession();
    s.docs = { ...s.docs, d1: { ...s.docs.d1, fields: [...s.docs.d1.fields, slot("fa-init", "sg-1", "initials")] } };
    // La firma de bk-1 sigue vigente (los huecos no entran en el sello): solo faltan las iniciales nuevas.
    const issues = ofKind(validateAssignment(s), "groupWithoutStroke").filter((i) => i.blockId === "bk-1");
    expect(issues).toHaveLength(1);
    expect(issues[0].params).toEqual({ types: ["initials"], docIds: ["d1", "d2"] });
    // Con trazos y sellos nuevos, vuelve a estar bien.
    s.blocks = s.blocks.map((b) =>
      b.id === "bk-1"
        ? {
            ...b,
            initials: INI,
            stamps: Object.fromEntries(["d1", "d2"].map((d) => [d, captureStamp(s.docs[d].sealedKey, s.docs[d].fields, "sg-1")])),
          }
        : b,
    );
    expect(ofKind(validateAssignment(s), "groupWithoutStroke")).toEqual([]);
  });

  it("sin la huella de algun documento aun no se puede saber: no se acusa a nadie de no haber firmado", () => {
    const s = completeSession();
    s.docs = { ...s.docs, d2: { ...s.docs.d2, sealedKey: "" } };
    s.blocks = s.blocks.map((b) => ({ ...b, signature: null, stamps: {} }));
    const found = ofKind(validateAssignment(s), "groupWithoutStroke");
    // bk-1 y bk-3 cubren d2 (sin huella) y se saltan; bk-2 (d3, d4) si se evalua.
    expect(found.map((i) => i.blockId)).toEqual(["bk-2"]);
  });

  it("grupos solapados (dato corrupto, BLOQUEANTE): dos grupos del mismo firmante reclaman un documento", () => {
    const s = completeSession();
    s.blocks = [...s.blocks, block("bk-9", "sg-1", ["d2", "d3"])];
    const found = ofKind(validateAssignment(s), "overlappingGroups");
    expect(found).toEqual([
      expect.objectContaining({ severity: "blocking", signerId: "sg-1", docId: "d2", blockId: "bk-9", params: { keptBlockId: "bk-1" } }),
      expect.objectContaining({ severity: "blocking", signerId: "sg-1", docId: "d3", blockId: "bk-9", params: { keptBlockId: "bk-2" } }),
    ]);
  });

  it("demasiados archivos (BLOQUEANTE): mas de 50 contando las copias, tambien en «Solo yo»", () => {
    const s = completeSession();
    const withCopies = (copies: number): SignSession => ({
      ...s,
      docs: Object.fromEntries(Object.entries(s.docs).map(([id, state]) => [id, { ...state, copies }])),
    });
    // 4 documentos x 5 copias = 20: bien.
    expect(ofKind(validateAssignment(withCopies(5)), "tooManyFiles")).toEqual([]);
    // 11 x 5 = 55: no cabe.
    const many = withCopies(5);
    for (let i = 5; i <= 11; i += 1) {
      many.docs[`x${i}`] = doc({ sealedKey: `k${i}`, copies: 5 });
      many.docOrder = [...many.docOrder, `x${i}`];
    }
    const found = ofKind(validateAssignment(many), "tooManyFiles");
    expect(found).toEqual([
      expect.objectContaining({ severity: "blocking", params: { count: 55, max: MAX_OUTPUT_FILES } }),
    ]);
    const solo = validateAssignment({ ...many, mode: "single" });
    expect(kinds(solo)).toEqual(["tooManyFiles"]);
    // «Solo yo» sin exceso: nada que decir.
    expect(validateAssignment({ ...s, mode: "single" })).toEqual([]);
  });

  it("el limite es exacto: 50 archivos caben; 51 no", () => {
    const build = (copies: number[]): SignSession => {
      const docs: Record<string, DocState> = {};
      copies.forEach((n, i) => {
        docs[`x${i}`] = doc({ sealedKey: `k${i}`, ...(n > 1 ? { copies: n } : {}) });
      });
      return session({ docs, docOrder: Object.keys(docs), mode: "single" });
    };
    expect(validateAssignment(build(Array(10).fill(5)))).toEqual([]);
    const over = validateAssignment(build([...Array(10).fill(5), 1]));
    expect(over.map((i) => [i.kind, i.params])).toEqual([["tooManyFiles", { count: 51, max: 50 }]]);
  });

  it("orden estable: huecos sin firmante, sin hueco, sin documentos, documento sin firmante, campos, trazos, solapes, archivos", () => {
    const s = completeSession();
    s.docs = {
      ...s.docs,
      d3: { ...s.docs.d3, fields: [...s.docs.d3.fields, slot("fl3", "sg-2")] },
      d5: doc({ sealedKey: "k5" }),
    };
    s.docOrder = [...s.docOrder, "d5"];
    s.blocks = [...s.blocks.map((b) => (b.id === "bk-2" ? { ...b, signature: null, stamps: {} } : b)), block("bk-4", "sg-2", ["d4"]), block("bk-9", "sg-1", ["d1"])];
    s.docs.d1 = { ...s.docs.d1, textFields: [{ id: "t", pageIndex: 0, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, source: "manual", confidence: "high" }] };
    const order = kinds(validateAssignment(s));
    const first = (kind: IssueKind) => order.indexOf(kind);
    expect(first("slotWithoutSigner")).toBeLessThan(first("signerWithoutSlot"));
    expect(first("signerWithoutSlot")).toBeLessThan(first("documentWithoutSigner"));
    expect(first("documentWithoutSigner")).toBeLessThan(first("requiredFieldEmpty"));
    expect(first("requiredFieldEmpty")).toBeLessThan(first("groupWithoutStroke"));
    expect(first("groupWithoutStroke")).toBeLessThan(first("overlappingGroups"));
  });

  it("hasBlockingIssue distingue avisos de bloqueos", () => {
    const warn: Issue = { kind: "signerWithoutDocuments", severity: "warning", messageKey: "assignment.issue.signerWithoutDocuments", params: {} };
    const block_: Issue = { ...warn, kind: "tooManyFiles", severity: "blocking", messageKey: "assignment.issue.tooManyFiles" };
    expect(hasBlockingIssue([])).toBe(false);
    expect(hasBlockingIssue([warn])).toBe(false);
    expect(hasBlockingIssue([warn, block_])).toBe(true);
  });
});
