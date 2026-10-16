import { describe, expect, it } from "vitest";
import {
  dataKindOfLabel,
  displayLabel,
  fieldTypeForKind,
  findLabelHits,
  foldKeepLength,
  normalizeLabelText,
  roleOf,
  signerHintOf,
  wordCount,
  type LabelKind,
} from "@/lib/pdf/autoMapText";

/** Clases de etiqueta que se encuentran en un texto (en el orden en que aparecen). */
function kinds(text: string): LabelKind[] {
  const folded = foldKeepLength(text);
  return findLabelHits(folded, wordCount(folded)).map((hit) => hit.kind);
}

describe("autoMapText: diccionario ES/EN", () => {
  it.each([
    ["Signature", "signature"],
    ["Signature of Policyholder", "signature"],
    ["(Signature) Owner/Agent", "signature"],
    ["Client Signature:", "signature"],
    ["Sign here", "signature"],
    ["Firma", "signature"],
    ["Firma del cliente", "signature"],
    ["Firma:", "signature"],
    ["Firmante 2", "signature"],
    ["(INITIAL)", "initials"],
    ["(INITIALS)", "initials"],
    ["Initials:", "initials"],
    ["Initials", "initials"],
    ["Iniciales", "initials"],
    ["Iniciales:", "initials"],
    ["Insured(s) (Initials)", "initials"],
    ["Please initial", "initials"],
    ["Init.", "initials"],
    ["Date", "date"],
    ["Date:", "date"],
    ["Fecha", "date"],
    ["Fecha:", "date"],
    ["Dated this", "date"],
    ["Date signed", "date"],
    ["Print Name", "name"],
    ["(Print Name) Owner/Agent", "name"],
    ["Nombre", "name"],
    ["Phone", "phone"],
    ["Teléfono", "phone"],
    ["E-mail", "email"],
    ["Address", "address"],
    ["Dirección:", "address"],
    ["Policy Number", "policy"],
    ["Claim #", "claim"],
  ] as const)("«%s» es una etiqueta de %s", (text, kind) => {
    expect(kinds(text)).toContain(kind);
  });

  it("la fecha de un dato del cliente no es la fecha de firma", () => {
    expect(kinds("Date of Loss")).not.toContain("date");
    expect(kinds("Fecha de pérdida")).not.toContain("date");
    expect(kinds("Date of Birth:")).not.toContain("date");
  });

  it("la prosa no es una etiqueta", () => {
    expect(kinds("You may sign this agreement only after reading every section of the contract carefully today")).toEqual([]);
    expect(kinds("The initial payment is due on the day the work starts and the balance after completion of the work")).toEqual([]);
    expect(kinds("Initial Payment")).toEqual([]);
    expect(kinds("The design of the signature page follows the standard form used by the carrier in all the states")).toEqual([]);
  });

  it("una etiqueta al final de una frase mediana vale; de una frase muy larga, no", () => {
    expect(kinds("Customer acknowledges and agrees to all the terms Signature")).toContain("signature");
    expect(kinds("The undersigned customer acknowledges and agrees to all of the terms and conditions stated in this agreement Signature")).toEqual([]);
  });

  it("una palabra clave entre parentesis o con dos puntos sobrevive dentro de una frase larga", () => {
    expect(kinds("Policyholders (Initials) (_____/_____) acknowledge receipt of a copy of page 4")).toContain("initials");
    expect(kinds("Please read the whole document carefully before you give your Signature: ____")).toContain("signature");
  });

  it("firma e iniciales no se confunden", () => {
    expect(kinds("Initials")).toEqual(["initials"]);
    expect(kinds("Signature")).toEqual(["signature"]);
    expect(kinds("Signature Date")).toEqual(["signature", "date"]);
  });

  it("no encuentra palabras clave dentro de otras palabras", () => {
    expect(kinds("Designate")).toEqual([]);
    expect(kinds("Consignment")).toEqual([]);
    expect(kinds("Updated")).toEqual([]);
  });
});

describe("autoMapText: roles y pistas de firmante", () => {
  it.each([
    ["signature of policyholder", "client"],
    ["client signature", "client"],
    ["(signature) owner/agent", "client"],
    ["firma del cliente", "client"],
    ["insured (1) signature", "client"],
    ["licensed public adjuster signature", "company"],
    ["signature of public adjuster", "company"],
    ["representative", "company"],
    ["acme services, llc representative", "company"],
    ["date", "unknown"],
  ] as const)("«%s» -> %s", (text, role) => {
    expect(roleOf(text)).toBe(role);
  });

  it.each([
    ["insured (1) signature", 0],
    ["insured (2) signature", 1],
    ["client 1", 0],
    ["client 2", 1],
    ["firmante 2", 1],
    ["signer 1 signature", 0],
    ["co-insured signature", 1],
    ["co insured", 1],
    ["coasegurado", 1],
    ["primary insured", 0],
    ["segundo firmante", 1],
    ["signature of policyholder", undefined],
    ["initials", undefined],
  ] as const)("pista de «%s» = %s", (text, hint) => {
    expect(signerHintOf(text)).toBe(hint);
  });
});

describe("autoMapText: utilidades", () => {
  it("normaliza acentos, mayusculas y subrayados", () => {
    expect(normalizeLabelText("  FIRMA   del  Cliente ____ ")).toBe("firma del cliente");
    expect(normalizeLabelText("Teléfono")).toBe("telefono");
  });

  it("conserva una posicion por caracter al plegar", () => {
    const text = "Dirección: ____";
    expect(foldKeepLength(text)).toHaveLength(Array.from(text).length);
  });

  it("limpia la etiqueta para mostrarla", () => {
    expect(displayLabel("(INITIAL)")).toBe("INITIAL");
    expect(displayLabel("Client Signature:")).toBe("Client Signature");
    expect(displayLabel("(Signature) Owner/Agent")).toBe("(Signature) Owner/Agent");
    expect(displayLabel("Name ____")).toBe("Name");
    expect(displayLabel("x".repeat(80))).toHaveLength(60);
  });

  it("tipo de campo segun la clase", () => {
    expect(fieldTypeForKind("signature")).toBe("signature");
    expect(fieldTypeForKind("initials")).toBe("initials");
    expect(fieldTypeForKind("date")).toBe("date");
    expect(fieldTypeForKind("phone")).toBe("text");
    expect(fieldTypeForKind("name")).toBe("text");
  });

  it("clase de un dato por su texto", () => {
    expect(dataKindOfLabel("Phone#")).toBe("phone");
    expect(dataKindOfLabel("Client/Insured")).toBe("name");
    expect(dataKindOfLabel("Date of Loss")).toBe("other");
    expect(dataKindOfLabel("Damage caused by")).toBe("other");
  });

  it("cuenta palabras sin contar subrayados", () => {
    expect(wordCount("name: ____ phone")).toBe(2);
  });
});
