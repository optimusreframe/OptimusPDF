import { describe, expect, it } from "vitest";
import { buildLines, pastedBoxes, type TextBox, type TextPage } from "@/lib/autofill/layout";
import { resolveCandidates } from "@/lib/autofill/resolve";
import { collectPage, findBoilerplate, type Candidate } from "@/lib/autofill/rules";
import type { ExtractedValue } from "@/lib/autofill/types";

/** Pagina a partir de texto pegado (celdas separadas por 3+ espacios) o de cajas con posicion. */
function pasted(text: string): TextPage {
  const lines = buildLines(pastedBoxes(text));
  return { index: 0, width: 100, height: lines.length * 2 + 10, lines, origin: "pasted" };
}

function placed(boxes: TextBox[], origin: TextPage["origin"] = "text-layer", height = 792): TextPage {
  return { index: 0, width: 612, height, lines: buildLines(boxes), origin };
}

function candidates(page: TextPage, locale: "es" | "en" = "en"): Candidate[] {
  return collectPage(page, { sourceIndex: 0, locale, boilerplate: new Set() });
}

function values(text: string, locale: "es" | "en" = "en"): ExtractedValue[] {
  return resolveCandidates(candidates(pasted(text), locale), locale);
}

const pick = (list: ExtractedValue[], key: string): ExtractedValue[] => list.filter((value) => value.key === key);

describe("etiqueta + valor en la misma celda", () => {
  it("lee cada clave con su etiqueta", () => {
    const list = values(
      [
        "Insured: Maria Perez",
        "Phone: 305-555-0142",
        "Email: maria.perez@example.com",
        "Loss Address: 123 Main St, Miami, FL 33166",
        "Insurance Company: State Farm",
        "Policy No. 12-AB-3456",
        "Claim #: CLM-2026-118342",
        "Type of Loss: Wind",
        "Date of Loss: March 14, 2026",
      ].join("\n"),
    );
    const by = Object.fromEntries(list.map((value) => [value.key, value]));
    expect(by.insuredName1.value).toBe("Maria Perez");
    expect(by.phone.value).toBe("(305) 555-0142");
    expect(by.email.value).toBe("maria.perez@example.com");
    expect(by.address.value).toBe("123 Main St, Miami, FL 33166");
    expect(by.insurer.value).toBe("State Farm");
    expect(by.policyNumber.value).toBe("12-AB-3456");
    expect(by.claimNumber.value).toBe("CLM-2026-118342");
    expect(by.claimType.value).toBe("Wind");
    expect(by.lossDate.value).toBe("03/14/2026");
    expect(list.every((value) => value.tier === "high")).toBe(true);
  });

  it("la fecha sale en el formato del idioma", () => {
    expect(pick(values("Fecha de pérdida: 14 de marzo de 2026", "es"), "lossDate")[0].value).toBe("14/03/2026");
    expect(pick(values("Date of Loss: 14 March 2026", "en"), "lossDate")[0].value).toBe("03/14/2026");
  });

  it("dos asegurados en una etiqueta", () => {
    const list = values("Insured(s): Teresa Navarro and Camila Navarro");
    expect(pick(list, "insuredName1")[0].value).toBe("Teresa Navarro");
    expect(pick(list, "insuredName2")[0].value).toBe("Camila Navarro");
  });

  it("varios pares en una linea terminan donde empieza la siguiente etiqueta", () => {
    const list = values("Insured: Maria Perez   Phone: 305-555-0142   Policy No. 12-AB-3456");
    expect(pick(list, "insuredName1")[0].value).toBe("Maria Perez");
    expect(pick(list, "phone")[0].value).toBe("(305) 555-0142");
    expect(pick(list, "policyNumber")[0].value).toBe("12-AB-3456");
  });
});

describe("valor en la celda de la derecha y debajo", () => {
  it("columna de la derecha", () => {
    const list = values("Insured                    Maria Perez\nPhone                      305-555-0142");
    expect(pick(list, "insuredName1")[0].value).toBe("Maria Perez");
    expect(pick(list, "insuredName1")[0].reason).toMatch(/derecha|right/i);
    expect(pick(list, "phone")[0].value).toBe("(305) 555-0142");
  });

  it("etiqueta encima del valor", () => {
    const list = values("Insured:\nMaria Perez\n\nPhone:\n305-555-0142");
    expect(pick(list, "insuredName1")[0].value).toBe("Maria Perez");
    expect(pick(list, "insuredName1")[0].reason).toMatch(/Below|Debajo/);
    expect(pick(list, "phone")[0].value).toBe("(305) 555-0142");
  });

  it("fila de titulos + fila de datos", () => {
    const list = values("Insured         Phone             Email\nMaria Perez     305-555-0142      m@example.com");
    expect(pick(list, "insuredName1")[0].value).toBe("Maria Perez");
    expect(pick(list, "phone")[0].value).toBe("(305) 555-0142");
    expect(pick(list, "email")[0].value).toBe("m@example.com");
  });

  it("debajo NO cruza un hueco de parrafo ni toma otra etiqueta", () => {
    expect(values("Insured:\n\nMaria Perez")).toHaveLength(0);
    expect(values("Insured:\nPhone: 305-555-0142").filter((value) => value.key === "insuredName1")).toHaveLength(0);
  });

  it("debajo no toma prosa como nombre, aseguradora o tipo de reclamo", () => {
    const list = values("Insured:\nI hereby authorize the company to proceed\nInsurance Company:\nTERMS AND CONDITIONS\nType of Loss:\nSee attachment for details of the damages");
    expect(list).toHaveLength(0);
  });

  it("direccion en varias lineas bajo la etiqueta", () => {
    const list = values("Property Address:\n123 Main St\nApt 4B\nMiami, FL 33166");
    expect(pick(list, "address")[0].value).toBe("123 Main St, Apt 4B, Miami, FL 33166");
  });

  it("direccion con la calle tras la etiqueta y la ciudad en la linea siguiente", () => {
    const list = values("Loss Address: 123 Main St\n              Miami, FL 33166");
    expect(pick(list, "address")[0].value).toBe("123 Main St, Miami, FL 33166");
  });

  it("«City, State, Zip» como etiqueta aparte se une a la direccion", () => {
    const list = values("Loss Address: 123 Main St     City, State, Zip: Miami, FL 33166");
    expect(pick(list, "address")[0].value).toBe("123 Main St, Miami, FL 33166");
  });
});

describe("campos en blanco y basura (precision primero)", () => {
  it("rayas, casillas y N/A no dan nada", () => {
    expect(values("Insured: ________________\nPhone: ________\nPolicy No. ________\nEmail: N/A\nClaim #: TBD\nDate of Loss: ___/___/_____")).toHaveLength(0);
  });

  it("un campo en blanco con raya no lee el valor de la linea de abajo", () => {
    expect(values("Insured: ________________\nMaria Perez")).toHaveLength(0);
  });

  it("una lista de casillas no es un tipo de reclamo", () => {
    expect(values("Claim type: ____ Emergency ____ Non-Emergency ____ Supplemental")).toHaveLength(0);
  });

  it("valor puesto sobre la raya sí se lee", () => {
    expect(pick(values("Insured: ____ Maria Perez ____"), "insuredName1")[0].value).toBe("Maria Perez");
  });

  it("etiqueta sin dos puntos dentro de una frase: nunca nivel alto, y los nombres no se toman", () => {
    const list = values("The insured Maria Perez signed on the date of loss March 14, 2026 and the claim number 12345 is pending");
    expect(list.filter((value) => value.tier === "high")).toHaveLength(0);
    expect(list.filter((value) => value.key === "insuredName1")).toHaveLength(0);
  });

  it("formatos invalidos se descartan", () => {
    expect(values("Phone: 12345\nEmail: maria@\nPolicy No. N/A\nDate of Loss: 31/31/2026\nClaim #: abc")).toHaveLength(0);
  });
});

describe("nivel y banderas", () => {
  it("fecha ambigua: conserva el texto original y baja a revision", () => {
    const value = pick(values("Date of Loss: 03/04/2026"), "lossDate")[0];
    expect(value.value).toBe("03/04/2026");
    expect(value.tier).toBe("review");
    expect(value.reason).toMatch(/confirm/i);
  });

  it("etiqueta debil («Name:») solo llega a revision", () => {
    const value = pick(values("Name: Maria Perez"), "insuredName1")[0];
    expect(value.tier).toBe("review");
  });

  it("nombre en minusculas o de una sola palabra: revision", () => {
    expect(pick(values("Insured: maria perez"), "insuredName1")[0].tier).toBe("review");
    expect(pick(values("Insured: Perez"), "insuredName1")[0].tier).toBe("review");
  });

  it("aseguradora desconocida con etiqueta: revision; conocida: alto", () => {
    expect(pick(values("Insurance Company: Frontline"), "insurer")[0].tier).toBe("review");
    expect(pick(values("Insurance Company: Allstate"), "insurer")[0].tier).toBe("high");
  });

  it("tipo de reclamo sin causa conocida: revision", () => {
    expect(pick(values("Type of Loss / Description: Kitchen"), "claimType")[0].tier).toBe("review");
  });

  it("direccion solo con calle: revision con etiqueta generica, alto con «Loss Address» y ciudad", () => {
    expect(pick(values("Address: 123 Main St"), "address")[0].tier).toBe("review");
    expect(pick(values("Loss Address: 123 Main St, Miami, FL 33166"), "address")[0].tier).toBe("high");
  });
});

describe("conflictos y repetidos", () => {
  it("el mismo valor en varios sitios es uno solo", () => {
    const list = values("Insured: Maria Perez\nClient: MARIA PEREZ\nPolicyholder: Maria Perez");
    expect(pick(list, "insuredName1")).toHaveLength(1);
    expect(pick(list, "insuredName1")[0].tier).toBe("high");
  });

  it("dos valores distintos -> ambos en revision, el mejor primero", () => {
    const list = pick(values("Policy No. 12-AB-3456\nPolicy Number: 99-ZZ-0001"), "policyNumber");
    expect(list).toHaveLength(2);
    expect(list.every((value) => value.tier === "review")).toBe(true);
    expect(list[0].confidence).toBeGreaterThanOrEqual(list[1].confidence);
    expect(list[0].reason).toMatch(/otro valor|another/);
  });

  it("la direccion completa absorbe a la parcial (no es conflicto)", () => {
    const list = pick(values("Address: 123 Main St, Miami, FL 33166\nLoss Address: 123 Main St"), "address");
    expect(list).toHaveLength(1);
    expect(list[0].value).toBe("123 Main St, Miami, FL 33166");
  });

  it("una etiqueta debil no compite con una clara", () => {
    const list = pick(values("Insured: Maria Perez\nPrint Name: Juan Rivera"), "insuredName1");
    expect(list).toHaveLength(1);
    expect(list[0].value).toBe("Maria Perez");
    expect(list[0].tier).toBe("high");
  });

  it("un formato dudoso no compite con uno solido", () => {
    const list = pick(values("Type of Loss: Wind\nClaim Type: Residential"), "claimType");
    expect(list).toHaveLength(1);
    expect(list[0].value).toBe("Wind");
  });

  it("«Policyholder:» en filas contiguas: la segunda fila es el segundo asegurado", () => {
    const list = values("Policyholder: Maria Perez\nPolicyholder: Jose Perez");
    expect(pick(list, "insuredName1")[0].value).toBe("Maria Perez");
    expect(pick(list, "insuredName2")[0].value).toBe("Jose Perez");
  });
});

describe("otra parte (ajustador, abogado, empresa): no es del asegurado", () => {
  it("etiqueta calificada", () => {
    const list = values("Adjuster Phone: 305-555-0100\nCompany Email: info@example.com\nInsured Email: m@example.com");
    expect(pick(list, "phone")).toHaveLength(0);
    expect(pick(list, "email").map((value) => value.value)).toEqual(["m@example.com"]);
  });

  it("encabezado de la parte «Public Adjuster:» y bloque debajo", () => {
    const list = values("Public Adjuster: Dana Whitfield\nPhone: 689-555-0111\nE-mail: dana@example.com\n\nPolicyholder: Maria Perez\nPhone: 305-555-0142");
    expect(pick(list, "phone").map((value) => value.value)).toEqual(["(305) 555-0142"]);
    expect(pick(list, "email")).toHaveLength(0);
  });

  it("encabezado de organizacion (bufete, empresa) sobre el bloque de contacto", () => {
    const list = values("Doe & Roe, P.A.\n514 SE 11th Court\nFort Lauderdale, Florida 33316\nTel: (305) 555-0166\nEmail: lawyer@example.com");
    expect(list.filter((value) => value.key === "phone" || value.key === "email" || value.key === "address")).toHaveLength(0);
  });

  it("la parte autorizada de una tabla de titulos", () => {
    const list = values("Authorized Party      Address\nFair Claims Co        4700 Orchard Blvd, Suite 5, Orlando, FL 32839\nPhone Number: ______ 689-555-0111");
    expect(pick(list, "address")).toHaveLength(0);
    expect(pick(list, "phone")).toHaveLength(0);
  });

  it("una etiqueta del asegurado tras el encabezado de otra parte recupera el contexto", () => {
    const list = values("Acme Restoration LLC\nClient: Maria Perez\nPhone: 305-555-0142");
    expect(pick(list, "phone")[0].value).toBe("(305) 555-0142");
  });

  it("«Loss Address» es del asegurado aunque cuelgue de otra parte", () => {
    const list = values("Mortgage Company     Loan Number\nProperty Address: 123 Main St, Miami, FL 33166");
    expect(pick(list, "address")[0].value).toBe("123 Main St, Miami, FL 33166");
  });
});

describe("patrones libres (sin etiqueta) -> siempre revision", () => {
  it("correo y telefono sueltos", () => {
    const list = values("Maria Perez     305-555-0142     maria@example.com");
    expect(pick(list, "phone")[0]).toMatchObject({ value: "(305) 555-0142", tier: "review" });
    expect(pick(list, "email")[0]).toMatchObject({ value: "maria@example.com", tier: "review" });
  });

  it("no en medio de prosa ni tras una etiqueta que no es de telefono", () => {
    expect(values("Please call (305) 555-0142 any time between nine and five for the status of the claim review process").filter((v) => v.key === "phone")).toHaveLength(0);
    expect(values("Fax: 305-555-0189\nPara consultas: 305-555-0123").filter((v) => v.key === "phone")).toHaveLength(0);
  });

  it("un valor libre cede ante uno con etiqueta", () => {
    const list = values("Phone: 305-555-0142\nOther: 407-555-0199");
    expect(pick(list, "phone").map((value) => value.value)).toEqual(["(305) 555-0142"]);
    expect(pick(list, "phone")[0].tier).toBe("high");
  });

  it("fecha narrada: revision", () => {
    const list = values("Our records show the loss occurred on March 14, 2026 at the insured property.");
    expect(pick(list, "lossDate")[0]).toMatchObject({ value: "03/14/2026", tier: "review" });
    expect(values("Today is March 14, 2026 and the weather is fine.").filter((v) => v.key === "lossDate")).toHaveLength(0);
    expect(pick(values("El siniestro ocurrió el 14 de marzo de 2026 en la vivienda.", "es"), "lossDate")[0].value).toBe("14/03/2026");
  });

  it("bloque de destinatario de una carta: nombre y direccion en revision", () => {
    const list = values("State Farm Insurance Company\n\nMaria Perez\n123 Main Street\nMiami, FL 33166\n\nDear Maria Perez:");
    expect(pick(list, "insuredName1")[0]).toMatchObject({ value: "Maria Perez", tier: "review" });
    expect(pick(list, "address")[0]).toMatchObject({ value: "123 Main Street, Miami, FL 33166", tier: "review" });
    expect(pick(list, "insurer")[0]).toMatchObject({ value: "State Farm Insurance Company", tier: "review" });
  });

  it("un bloque de calle + ciudad SIN nombre encima no se propone", () => {
    expect(values("Some text\n\n123 Main Street\nMiami, FL 33166").filter((v) => v.key === "address")).toHaveLength(0);
  });

  it("el bloque de un bufete o una empresa no es un destinatario", () => {
    expect(values("Vyacheslav Borshchukov, P.A.\n514 SE 11th Court\nFort Lauderdale, Florida 33316").filter((v) => v.key === "address" || v.key === "insuredName1")).toHaveLength(0);
  });
});

describe("documento de identidad", () => {
  it("LN/FN + domicilio", () => {
    const text = ["DRIVER LICENSE", "DL S123-456-78-901-0", "LN PEREZ", "FN MARIA", "1234 SW 5TH ST", "MIAMI FL 33166", "DOB 01/02/1980", "EXP 01/02/2030", "SEX F  HGT 5-04  EYES BRN"].join("\n");
    const list = values(text);
    expect(pick(list, "insuredName1")[0]).toMatchObject({ value: "Maria Perez", tier: "review" });
    expect(pick(list, "address")[0]).toMatchObject({ value: "1234 SW 5th St, Miami FL 33166", tier: "review" });
    // La fecha de nacimiento y el numero de licencia no tienen clave.
    expect(list.map((value) => value.key).sort()).toEqual(["address", "insuredName1"]);
  });
});

describe("PDF con posicion: membrete, pie y margenes", () => {
  const b = (text: string, x0: number, y: number, size = 10): TextBox => ({ text, x0, x1: x0 + text.length * size * 0.5, y0: y - size * 0.8, y1: y + size * 0.2 });

  it("telefono, correo y direccion en el pie/membrete no se proponen", () => {
    const page = placed([b("Insured: Maria Perez", 50, 200), b("Office: (305) 555-0188", 50, 40), b("E-mail: info@company-example.com", 50, 52), b("Phone: 305-555-0100", 50, 770), b("Address: 8561 NW Palm Grove Drive, Medley FL 33166", 50, 782)]);
    const list = resolveCandidates(candidates(page), "en");
    expect(list.map((value) => value.key)).toEqual(["insuredName1"]);
  });

  it("lineas de margen que se repiten en varias paginas se ignoran entera", () => {
    const footer = (n: number): TextBox[] => [b(`Phone: 305-555-0188  Page ${n}`, 50, 770)];
    const pages: TextPage[] = [1, 2, 3].map((n) => ({ ...placed([b("Insured: Maria Perez", 50, 200), ...footer(n)]), index: n - 1 }));
    expect(findBoilerplate(pages).size).toBe(1);
    const found = pages.flatMap((page) => collectPage(page, { sourceIndex: 0, locale: "en", boilerplate: findBoilerplate(pages) }));
    expect(found.filter((c) => c.key === "phone")).toHaveLength(0);
    expect(found.filter((c) => c.key === "insuredName1")).toHaveLength(3);
  });

  it("en un PDF, correo y telefono sin etiqueta solo se proponen junto al nombre de una persona", () => {
    const company = placed([b("Questions? write to claims@company-example.com", 50, 300), b("305-555-0188", 50, 330)]);
    expect(resolveCandidates(candidates(company), "en")).toEqual([]);
    const person = placed([b("Maria Perez", 50, 300), b("305-555-0142   maria@example.com", 50, 314)]);
    const list = resolveCandidates(candidates(person), "en");
    expect(list.map((value) => [value.key, value.tier])).toEqual([
      ["phone", "review"],
      ["email", "review"],
    ]);
  });

  it("el margen no se aplica a una foto ni a un texto pegado", () => {
    const photo = placed([b("Phone: 305-555-0100", 50, 20), b("Insured: Maria Perez", 50, 60)], "ocr");
    const list = resolveCandidates(candidates(photo), "en");
    expect(pick(list, "phone")[0].tier).toBe("high");
  });

  it("OCR: palabras de baja confianza bajan el valor a revision", () => {
    const word = (text: string, x0: number, confidence: number): TextBox => ({ text, x0, x1: x0 + text.length * 6, y0: 100, y1: 112, confidence });
    const low = placed([word("Policy", 50, 90), word("No.", 90, 90), word("12-AB-3456", 120, 40)], "ocr");
    const high = placed([word("Policy", 50, 90), word("No.", 90, 90), word("12-AB-3456", 120, 92)], "ocr");
    expect(pick(resolveCandidates(candidates(low), "en"), "policyNumber")[0].tier).toBe("review");
    expect(pick(resolveCandidates(candidates(high), "en"), "policyNumber")[0].tier).toBe("high");
  });
});

describe("variantes de redaccion (no vistas al afinar)", () => {
  it.each([
    ["Name of Insured(s) (please print): Maria Perez", "insuredName1", "Maria Perez"],
    ["Insured (print): Maria Perez", "insuredName1", "Maria Perez"],
    ["Policy Number (if known): 12-AB-3456", "policyNumber", "12-AB-3456"],
    ["Insured: Maria Perez, Phone: 305-555-0100", "insuredName1", "Maria Perez"],
    ["Insured: Maria Perez - Policy: 12-AB-3456", "insuredName1", "Maria Perez"],
    ["Insured: Maria Perez (Owner)", "insuredName1", "Maria Perez"],
    ["Asegurado(a): María Pérez", "insuredName1", "María Pérez"],
    ["Insured’s Phone #: 305.555.0100", "phone", "(305) 555-0100"],
    ["Claim Number 2026-0042 Date of Loss 03/14/2026", "claimNumber", "2026-0042"],
    ["Claim Number 2026-0042 Date of Loss 03/14/2026", "lossDate", "03/14/2026"],
    ["POL# HO3-0042817", "policyNumber", "HO3-0042817"],
    ["Pol. No. 8812-4403", "policyNumber", "8812-4403"],
    ["Loss Location: 123 Main St, Miami, FL 33166", "address", "123 Main St, Miami, FL 33166"],
    ["Cell: +52 55 1234 5678", "phone", "+52 55 1234 5678"],
    ["Dirección de la propiedad: Calle Luna #123, San Juan, PR 00901", "address", "Calle Luna #123, San Juan, PR 00901"],
    ["Compañía aseguradora: Seguros Monterrey", "insurer", "Seguros Monterrey"],
    ["Causa de la pérdida: Granizo", "claimType", "Granizo"],
    ["Número de póliza: 4400-77", "policyNumber", "4400-77"],
  ])("%s", (text, key, expected) => {
    expect(pick(values(text, "en"), key)[0]?.value).toBe(expected);
  });

  it("dos telefonos etiquetados distintos: conflicto, ambos en revision", () => {
    const list = pick(values("Home Phone: 305-555-0100\nWork Phone: 407-555-0199"), "phone");
    expect(list).toHaveLength(2);
    expect(list.every((value) => value.tier === "review")).toBe(true);
  });

  it("prosa con las palabras de las etiquetas no produce nada", () => {
    const text = [
      "Insured: Is the person or entity named in the policy.",
      "Policy Number: See the declarations page",
      "Policy Limit: $300,000",
      "Date: March 14, 2026",
      "Address: To be determined",
      "Phone: Call the office",
      "Claim: any claim must be filed within sixty days",
    ].join("\n");
    expect(values(text)).toEqual([]);
  });
});
