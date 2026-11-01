import { describe, expect, it } from "vitest";
import { buildLines, pastedBoxes } from "@/lib/autofill/layout";
import { scanLabels } from "@/lib/autofill/labels";

function hitsOf(text: string) {
  const [line] = buildLines(pastedBoxes(text));
  return { line, hits: scanLabels(line) };
}

describe("etiquetas por clave (ES/EN)", () => {
  it.each([
    ["Insured: x", "insuredName1"],
    ["Insured(s ): x", "insuredName1"],
    ["Named Insured's Name(s): x", "insuredName1"],
    ["Client/Insured: x", "insuredName1"],
    ["Policyholder: x", "insuredName1"],
    ["Asegurado: x", "insuredName1"],
    ["Nombre del asegurado: x", "insuredName1"],
    ["Titular de la póliza: x", "insuredName1"],
    ["Co-Insured: x", "insuredName2"],
    ["Segundo asegurado: x", "insuredName2"],
    ["Cónyuge: x", "insuredName2"],
    ["Phone: x", "phone"],
    ["Phone# : x", "phone"],
    ["Phone Number(s): x", "phone"],
    ["Cell Phone: x", "phone"],
    ["Teléfono: x", "phone"],
    ["Celular: x", "phone"],
    ["E - mail: x", "email"],
    ["Email Address: x", "email"],
    ["Correo electrónico: x", "email"],
    ["Loss Address: x", "address"],
    ["Property Address: x", "address"],
    ["Address of Loss: x", "address"],
    ["Dirección de la pérdida: x", "address"],
    ["Domicilio: x", "address"],
    ["Insurance Company: x", "insurer"],
    ["Insurer: x", "insurer"],
    ["Aseguradora: x", "insurer"],
    ["Compañía de seguros: x", "insurer"],
    ["Policy No. x", "policyNumber"],
    ["Policy #: x", "policyNumber"],
    ["Policy#: x", "policyNumber"],
    ["Póliza: x", "policyNumber"],
    ["N.º de póliza: x", "policyNumber"],
    ["Nro. de póliza: x", "policyNumber"],
    ["Núm. de reclamo: x", "claimNumber"],
    ["Nro. de siniestro: x", "claimNumber"],
    ["Claim No.: x", "claimNumber"],
    ["Supplemental Claim #: x", "claimNumber"],
    ["Número de reclamo: x", "claimNumber"],
    ["N.º de siniestro: x", "claimNumber"],
    ["Type of Loss: x", "claimType"],
    ["Type of Loss / Description: x", "claimType"],
    ["Cause of Loss: x", "claimType"],
    ["Damage caused by: x", "claimType"],
    ["Tipo de pérdida: x", "claimType"],
    ["Date of Loss: x", "lossDate"],
    ["DOL: x", "lossDate"],
    ["Fecha de pérdida: x", "lossDate"],
    ["Fecha del siniestro: x", "lossDate"],
    ["City, State, Zip: x", "csz"],
    ["Public Adjuster: x", "party"],
    ["Contractor: x", "party"],
    ["Fax: x", "stop"],
    ["Office: x", "stop"],
    ["License No: x", "stop"],
  ])("%s -> %s", (text, kind) => {
    const { hits } = hitsOf(text);
    expect(hits[0]?.kind).toBe(kind);
  });
});

describe("separadores", () => {
  it("dos puntos, celda entera o valor pegado (claves tipadas)", () => {
    expect(hitsOf("Insured: Maria").hits[0].sep).toBe("colon");
    expect(hitsOf("Policy No. 12-AB-3456").hits[0].sep).toBe("free");
    expect(hitsOf("Insured").hits[0].sep).toBe("cell");
    expect(hitsOf("Insured   Maria Perez").hits[0].sep).toBe("cell");
  });

  it("un nombre sin dos puntos NO es etiqueta (evita prosa)", () => {
    expect(hitsOf("The insured Maria Perez signed").hits).toHaveLength(0);
    expect(hitsOf("Insured Maria Perez").hits).toHaveLength(0);
  });

  it("una palabra de etiqueta al FINAL de un valor no es etiqueta", () => {
    const { hits } = hitsOf("Insurance Company: Gulfshore Indemnity Company");
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("insurer");
  });

  it("la etiqueta no se encuentra dentro de otra palabra", () => {
    expect(hitsOf("Uninsured: x").hits).toHaveLength(0);
    expect(hitsOf("Telephony: x").hits).toHaveLength(0);
  });
});

describe("varias etiquetas en una linea y calificadores", () => {
  it("el valor de cada una llega hasta la siguiente", () => {
    const { line, hits } = hitsOf("Insured: Maria Perez Phone: 305-555-0100 Email: m@x.com");
    expect(hits.map((hit) => hit.kind)).toEqual(["insuredName1", "phone", "email"]);
    expect(line.text.slice(hits[0].valueStart, hits[0].valueEnd).trim()).toBe("Maria Perez");
    expect(line.text.slice(hits[1].valueStart, hits[1].valueEnd).trim()).toBe("305-555-0100");
  });

  it("«Insured Email» es un correo del asegurado; «Adjuster Phone», de otra parte", () => {
    const email = hitsOf("Insured Email: m@x.com").hits[0];
    expect(email.kind).toBe("email");
    expect(email.party).toBe("insured");
    const phone = hitsOf("Adjuster Phone: 305-555-0100").hits[0];
    expect(phone.kind).toBe("phone");
    expect(phone.party).toBe("other");
  });

  it("el calificador no se cuenta como parte del valor del campo anterior", () => {
    const { line, hits } = hitsOf("Policy#: 12345 Insured Email: m@x.com");
    expect(line.text.slice(hits[0].valueStart, hits[0].valueEnd).trim()).toBe("12345");
  });

  it("gana la etiqueta mas larga", () => {
    expect(hitsOf("Email Address: x").hits.map((hit) => hit.kind)).toEqual(["email"]);
    expect(hitsOf("Date of Loss: x").hits.map((hit) => hit.kind)).toEqual(["lossDate"]);
    expect(hitsOf("Co-insured: x").hits.map((hit) => hit.kind)).toEqual(["insuredName2"]);
  });

  it("etiquetas sueltas en celdas distintas (fila de titulos)", () => {
    const { hits } = hitsOf("Policy    Claim    DOL");
    expect(hits.map((hit) => hit.kind)).toEqual(["policyNumber", "claimNumber", "lossDate"]);
    expect(hits.every((hit) => hit.sep === "cell")).toBe(true);
  });
});
