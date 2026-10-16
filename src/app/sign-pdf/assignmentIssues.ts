import type { Issue } from "@/app/sign-pdf/assignmentValidation";
import { blockGroups } from "@/app/sign-pdf/assignment";
import { docLabel, signerLabel } from "@/app/sign-pdf/blockModel";
import type { DocId, SignerBlock } from "@/app/sign-pdf/docSet";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { SignatureFieldType, Signer } from "@/lib/pdf/sign";

/*
 * Textos y destinos de los problemas de `validateAssignment` (Firma agil · U1.2/U1.3). Puro: lo usan la tabla «¿Quien
 * firma que?» (paso Firmantes) y «Revisar antes de descargar» (paso Firmar), que ensenan el MISMO problema con la misma
 * frase y el mismo «Ir a corregirlo».
 */

/** A donde lleva «Ir a corregirlo». */
export type FixTarget =
  | { step: "signers"; docId?: DocId; signerId?: string }
  | { step: "document"; docId: DocId }
  | { step: "turn"; signerId: string };

export function fixTargetOf(issue: Issue): FixTarget {
  switch (issue.kind) {
    case "requiredFieldEmpty":
      return issue.docId ? { step: "document", docId: issue.docId } : { step: "signers" };
    case "groupWithoutStroke":
      return issue.signerId ? { step: "turn", signerId: issue.signerId } : { step: "signers" };
    default:
      return { step: "signers", docId: issue.docId, signerId: issue.signerId };
  }
}

export type IssueNames = {
  signers: readonly Signer[];
  docs: readonly { id: DocId; name: string }[];
  blocks: readonly SignerBlock[];
};

/** La frase del problema, en el idioma de `strings`. */
export function issueText(issue: Issue, names: IssueNames, strings: SignStrings): string {
  const letters = blockGroups(names.blocks, names.docs.map((doc) => doc.id), names.signers);
  const letter = issue.group ?? (issue.blockId ? letters[issue.blockId] : undefined) ?? "A";
  const types = Array.isArray(issue.params.types) ? (issue.params.types as readonly SignatureFieldType[]) : [];
  return strings.assignment.issue[issue.kind]({
    signer: issue.signerId ? signerLabel(names.signers, issue.signerId, strings) : "",
    doc: issue.docId ? docLabel(names.docs.find((doc) => doc.id === issue.docId)?.name ?? issue.docId) : "",
    group: strings.assignment.group(letter),
    count: typeof issue.params.count === "number" ? issue.params.count : 0,
    max: typeof issue.params.max === "number" ? issue.params.max : 0,
    strokes: types,
  });
}
