/**
 * Documentos SINTETICOS con la ESTRUCTURA de los contratos reales de un ajustador (varias etiquetas por linea con la raya y el valor
 * encima, membrete y pie repetidos con telefono/correo/direccion de la empresa, bloque del ajustador, tabla de titulos + datos, carta
 * de autorizacion a un tercero, bufete con su firma…) pero con datos INVENTADOS. Cada uno trae sus senuelos (`forbidden`): lo que es de
 * la empresa o del ajustador y NO debe salir en ningun nivel.
 */

import { makeRng } from "@/lib/scan/__fixtures__/rng";
import { expectedDate, makeCase, pdfSource, textWidth, typedDate, type Case, type CorpusDoc, type Lang, type Op, type PageSpec, type Truth } from "@/lib/autofill/testing/corpus";

const FOOT = { phone: "305-555-0188", fax: "305-555-0189", email: "info@responsive-example.com", address: "8561 NW Palm Grove Drive, Medley FL 33166" };
const DECOYS = ["(305) 555-0188", "(305) 555-0189", "info@responsive-example.com", "8561 NW Palm Grove Drive", "(689) 555-0111", "claims@pioneer-example.com", "Luis Contreras", "G123456", "4700 Orchard Blvd", "(305) 555-0166", "lawyer@doeroe-example.com", "514 SE 11th Court"];

/** Etiqueta + raya + valor puesto encima de la raya (como un formulario relleno por encima). */
async function overlay(ops: Op[], x: number, y: number, label: string, value: string, underscores: number): Promise<number> {
  const width = await textWidth(label, 9);
  ops.push({ t: "text", x, y, s: label, size: 9 }, { t: "text", x: x + width + 3, y, s: "_".repeat(underscores), size: 9 });
  ops.push({ t: "text", x: x + width + 6, y: y - 2, s: value, size: 9 });
  return x + width + 3 + (await textWidth("_".repeat(underscores), 9));
}

function pageFooter(n: number): Op[] {
  return [
    { t: "text", x: 40, y: 724, s: `Insured(s) (Initials) (______/______) acknowledge receipt of a copy of page ${n}`, size: 8 },
    { t: "text", x: 40, y: 760, s: `•Address: ${FOOT.address} • Office: ${FOOT.phone} • Fax: ${FOOT.fax} • E - mail: ${FOOT.email}`, size: 7 },
  ];
}

/** R1: contrato de ajustador publico con varias etiquetas por linea y pie con datos de la empresa en cada pagina. */
async function multiLabel(c: Case, locale: Lang): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const names = c.p2 ? `${c.p1.full} and ${c.p2.full}` : c.p1.full;
  const header = async (): Promise<Op[]> => {
    const ops: Op[] = [];
    await overlay(ops, 40, 150, "Insured(s):", names, 52);
    await overlay(ops, 395, 150, "Phone#:", c.phoneDigits.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3"), 16);
    await overlay(ops, 40, 176, "Loss Address:", `${c.street}, ${c.city} ${c.state} ${c.zip}`, 60);
    await overlay(ops, 395, 176, "Date of Loss:", typedDate(c, 1), 16);
    await overlay(ops, 40, 202, "Insurance Company:", c.insurer.length > 22 ? "State Farm" : c.insurer, 22);
    await overlay(ops, 285, 202, "Policy#:", c.policy, 14);
    await overlay(ops, 415, 202, "Insured Email:", c.email, 14);
    return ops;
  };
  const insurer = c.insurer.length > 22 ? "State Farm" : c.insurer;
  const p1 = await header();
  await overlay(p1, 40, 228, "Claim type:", "", 4);
  p1.push({ t: "text", x: 150, y: 228, s: "____ Emergency ____ Non-Emergency ____ Supplemental", size: 9 });
  await overlay(p1, 395, 228, "Claim #:", c.claim, 14);
  await overlay(p1, 40, 254, "Type of Loss/ Description:", c.claimType ?? "Wind", 50);
  p1.push({ t: "text", x: 40, y: 300, s: "1. Responsive Claims Group, LLC license #W000000 and insured(s) agree as follows: I/We, the undersigned insured(s) hereby", size: 9 });
  p1.push({ t: "text", x: 40, y: 314, s: "authorize the company to communicate with the carrier for the following limited purposes: to discuss and receive information.", size: 9 });
  const p2: Op[] = [{ t: "text", x: 40, y: 150, s: "2. Fees. The company will receive ten percent of the amount recovered, payable on disbursement.", size: 9 }];
  const p3 = await header();
  const truth: Truth = {
    high: { insuredName1: c.p1.full, phone: c.phoneNorm, address: c.addressNorm.replace(`, ${c.state}`, ` ${c.state}`), lossDate: expectedDate(c, locale), insurer, policyNumber: c.policy, email: c.email, claimNumber: c.claim, claimType: c.claimType ?? "Wind" },
    forbidden: DECOYS,
  };
  if (c.p2) truth.high!.insuredName2 = c.p2.full;
  return { pages: [{ ops: [...p1, ...pageFooter(1)] }, { ops: [...p2, ...pageFooter(2)] }, { ops: [...p3, ...pageFooter(3)] }], truth };
}

/** R2: membrete del ajustador arriba a la derecha + filas de celdas «Etiqueta: valor | Etiqueta: valor». */
async function letterheadTable(c: Case, locale: Lang): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const ops: Op[] = [
    { t: "text", x: 400, y: 38, s: "Pioneer Claims Adjusters", size: 11, bold: true },
    { t: "text", x: 380, y: 52, s: "1200 Orchard Street Suite 4, Orlando FL 32801", size: 8 },
    { t: "text", x: 440, y: 64, s: "Phone: (689) 555-0111", size: 8 },
    { t: "text", x: 420, y: 76, s: "claims@pioneer-example.com", size: 8 },
    { t: "text", x: 440, y: 88, s: "License Number: G123456", size: 8 },
    { t: "text", x: 190, y: 120, s: "PUBLIC ADJUSTER CONTRACT", size: 13, bold: true },
    { t: "text", x: 29, y: 146, s: "Public Adjuster: Luis Contreras", size: 9 },
    { t: "text", x: 400, y: 146, s: "License No: G123456", size: 9 },
  ];
  const insurer = c.insurer;
  const row = async (y: number, name: string, phone: string, email: string): Promise<void> => {
    ops.push({ t: "text", x: 29, y, s: "Policyholder:", size: 9 }, { t: "text", x: 92, y, s: name, size: 9 });
    ops.push({ t: "text", x: 270, y, s: "Phone:", size: 9 }, { t: "text", x: 302, y, s: phone, size: 9 });
    ops.push({ t: "text", x: 400, y, s: "E-mail:", size: 9 }, { t: "text", x: 436, y, s: email, size: 9 });
  };
  await row(166, c.p1.full, c.phoneDigits.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3"), c.email);
  if (c.p2) await row(184, c.p2.full, "", "");
  ops.push({ t: "text", x: 29, y: 212, s: "LOSS & INSURANCE CARRIER INFORMATION", size: 9, bold: true });
  ops.push({ t: "text", x: 29, y: 230, s: "Loss Address:", size: 9 }, { t: "text", x: 92, y: 230, s: c.street, size: 9 }, { t: "text", x: 300, y: 230, s: "City, State, Zip:", size: 9 }, { t: "text", x: 372, y: 230, s: `${c.city}, ${c.state} ${c.zip}`, size: 9 });
  ops.push({ t: "text", x: 29, y: 248, s: "Insurance Company:", size: 9 }, { t: "text", x: 112, y: 248, s: insurer, size: 9 }, { t: "text", x: 400, y: 248, s: "Policy No:", size: 9 }, { t: "text", x: 442, y: 248, s: c.policy, size: 9 });
  ops.push({ t: "text", x: 29, y: 266, s: "Date of Loss:", size: 9 }, { t: "text", x: 92, y: 266, s: typedDate(c, 0), size: 9 }, { t: "text", x: 400, y: 266, s: "Claim No:", size: 9 }, { t: "text", x: 442, y: 266, s: c.claim, size: 9 });
  ops.push({ t: "text", x: 29, y: 284, s: "Cause of Loss:", size: 9 }, { t: "text", x: 98, y: 284, s: c.claimType ?? "Wind", size: 9 }, { t: "text", x: 400, y: 284, s: "Claim Type:", size: 9 }, { t: "text", x: 452, y: 284, s: "Residential", size: 9 });
  ops.push({ t: "text", x: 29, y: 320, s: 'The above referenced Policyholder(s) and Pioneer Claims Adjusters ("PUBLIC ADJUSTER") enter into this agreement.', size: 9 });
  const truth: Truth = {
    high: { insuredName1: c.p1.full, phone: c.phoneNorm, email: c.email, address: c.addressNorm, insurer, policyNumber: c.policy, lossDate: expectedDate(c, locale), claimNumber: c.claim, claimType: c.claimType ?? "Wind" },
    forbidden: DECOYS,
  };
  if (c.p2) truth.high!.insuredName2 = c.p2.full;
  return { pages: [{ ops }], truth };
}

/** R3: carta de autorizacion a un tercero: tabla de titulos + datos y bloque del tercero con telefono y correo (senuelos). */
async function thirdParty(c: Case, locale: Lang): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const ops: Op[] = [
    { t: "text", x: 194, y: 109, s: "Third Party Letter of Authorization", size: 13, bold: true },
    { t: "text", x: 62, y: 143, s: "Mortgage Company", size: 9, bold: true },
    { t: "text", x: 330, y: 143, s: "Loan Number", size: 9, bold: true },
    { t: "text", x: 62, y: 194, s: 'The undersigned Borrower(s) hereby authorize the above Mortgage Company and Fair Resolution Claims ("Third Party") to be the contact.', size: 8 },
    { t: "text", x: 62, y: 300, s: "Property Address", size: 9, bold: true },
    { t: "text", x: 330, y: 300, s: "Insurance Carrier", size: 9, bold: true },
    { t: "text", x: 62, y: 318, s: `${c.street}, ${c.city}, ${c.state} ${c.zip}`, size: 9 },
    { t: "text", x: 330, y: 318, s: c.insurer.length > 28 ? "State Farm" : c.insurer, size: 9 },
    { t: "text", x: 330, y: 345, s: "Claim Number", size: 9, bold: true },
    { t: "text", x: 330, y: 361, s: c.claim, size: 9 },
    { t: "text", x: 62, y: 388, s: "Date of Loss", size: 9, bold: true },
    { t: "text", x: 330, y: 388, s: "Type of Loss", size: 9, bold: true },
    { t: "text", x: 62, y: 404, s: typedDate(c, 0), size: 9 },
    { t: "text", x: 330, y: 404, s: c.claimType ?? "Wind", size: 9 },
    { t: "text", x: 98, y: 446, s: "I HEREBY REQUEST FUNDS BE MAILED TO THE FOLLOWING AUTHORIZED PARTY:", size: 9, bold: true },
    { t: "text", x: 62, y: 479, s: "Authorized Party", size: 9, bold: true },
    { t: "text", x: 330, y: 479, s: "Address", size: 9, bold: true },
    { t: "text", x: 62, y: 496, s: "Fair Resolution Claims", size: 9 },
    { t: "text", x: 330, y: 496, s: "4700 Orchard Blvd, Suite 500, Orlando, FL 32839", size: 9 },
    { t: "text", x: 64, y: 534, s: "Phone Number: ____________________________ 689-555-0111", size: 9 },
    { t: "text", x: 330, y: 534, s: "Email: _________________ claims@pioneer-example.com", size: 9 },
  ];
  const insurer = c.insurer.length > 28 ? "State Farm" : c.insurer;
  const truth: Truth = {
    high: { address: c.addressNorm, insurer, claimNumber: c.claim, lossDate: expectedDate(c, locale), claimType: c.claimType ?? "Wind" },
    noHigh: ["phone", "email"],
    forbidden: DECOYS,
  };
  return { pages: [{ ops }], truth };
}

/** R5: acuerdo con «Named Insured's Name(s)», telefono y correo en la misma linea y dos direcciones (postal y de la perdida). */
async function moldAgreement(c: Case, locale: Lang): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const ops: Op[] = [];
  const names = c.p2 ? `${c.p1.full} and ${c.p2.full}` : c.p1.full;
  const mailing = `${c.street} Apt 4, ${c.city}, ${c.state} ${c.zip}`;
  await overlay(ops, 40, 150, "Named Insured’s Name(s):", names, 40);
  await overlay(ops, 40, 176, "Mailing Address :", mailing, 50);
  await overlay(ops, 40, 202, "Phone Number(s):", c.phoneDigits, 14);
  await overlay(ops, 300, 202, "Email Address:", c.email, 22);
  await overlay(ops, 40, 228, "Insurance Company:", c.insurer.length > 24 ? "Mapfre" : c.insurer, 24);
  await overlay(ops, 300, 228, "Policy #", c.policy, 14);
  await overlay(ops, 40, 254, "Loss Address:", `${c.street}, ${c.city}, ${c.state} ${c.zip}`, 50);
  await overlay(ops, 40, 280, "Type of Loss / Description:", "Kitchen", 40);
  await overlay(ops, 40, 306, "Date of Loss:", typedDate(c, 0), 16);
  const insurer = c.insurer.length > 24 ? "Mapfre" : c.insurer;
  const truth: Truth = {
    high: { insuredName1: c.p1.full, phone: c.phoneNorm, email: c.email, insurer, policyNumber: c.policy, lossDate: expectedDate(c, locale) },
    // Dos direcciones distintas (postal y de la perdida): conflicto -> las dos quedan en revision. «Kitchen» no es una causa conocida.
    review: { address: [c.addressNorm, mailing.replace(" Apt 4", " Apt 4")], claimType: "Kitchen" },
    noHigh: ["address", "claimType"],
    forbidden: DECOYS,
  };
  if (c.p2) truth.high!.insuredName2 = c.p2.full;
  return { pages: [{ ops: [...ops, ...pageFooter(1)] }], truth };
}

/** R6: «Etiqueta:_______» (raya pegada a los dos puntos) con el valor encima; contrato de servicio de una pagina. */
async function serviceAuthorization(c: Case, locale: Lang): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const ops: Op[] = [{ t: "text", x: 196, y: 124, s: "SERVICE AUTHORIZATION CONTRACT", size: 13, bold: true }];
  const rows: Array<[string, string]> = [
    ["Client/Insured:", c.p2 ? `${c.p1.full} and ${c.p2.full}` : c.p1.full],
    ["Policy Number:", c.policy],
    ["Address:", `${c.street}, ${c.city}, ${c.state} ${c.zip}`],
    ["Claim Number:", c.claim],
    ["Insurer:", c.insurer],
    ["Damage caused by:", c.claimType ?? "Wind"],
    ["Date of Loss:", typedDate(c, 0)],
  ];
  for (const [i, [label, value]] of rows.entries()) {
    const y = 159 + i * 22;
    const width = await textWidth(label);
    ops.push({ t: "text", x: 78, y, s: `${label}${"_".repeat(64)}` }, { t: "text", x: 78 + width + 4, y: y - 2, s: value });
  }
  ops.push({ t: "text", x: 71, y: 335, s: "LOSS RECKON SERVICES and Client named above agree as follows:", size: 10 });
  const truth: Truth = {
    high: { insuredName1: c.p1.full, policyNumber: c.policy, address: c.addressNorm, claimNumber: c.claim, insurer: c.insurer, claimType: c.claimType ?? "Wind", lossDate: expectedDate(c, locale) },
    forbidden: DECOYS,
  };
  if (c.p2) truth.high!.insuredName2 = c.p2.full;
  return { pages: [{ ops }], truth };
}

/** R4: contrato de un bufete: membrete y bloque de firma del abogado (telefono, correo, direccion) alrededor de los datos del cliente. */
async function lawRetainer(c: Case, locale: Lang): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const ops: Op[] = [
    { t: "text", x: 400, y: 36, s: "Doe & Roe, P.A.", size: 11, bold: true },
    { t: "text", x: 400, y: 49, s: "T: 305-555-0166", size: 9 },
    { t: "text", x: 400, y: 61, s: "E: lawyer@doeroe-example.com", size: 9 },
    { t: "text", x: 150, y: 120, s: "CONTINGENT FEE RETAINER AGREEMENT", size: 13, bold: true },
    { t: "text", x: 60, y: 170, s: `Client Name: ${c.p1.full}` },
    { t: "text", x: 60, y: 190, s: `Property Address: ${c.street}, ${c.city}, ${c.state} ${c.zip}` },
    { t: "text", x: 60, y: 210, s: `Insurance Company: ${c.insurer}` },
    { t: "text", x: 60, y: 230, s: `Claim No.: ${c.claim}` },
    { t: "text", x: 60, y: 250, s: `Policy No.: ${c.policy}` },
    { t: "text", x: 60, y: 270, s: `Date of Loss: ${typedDate(c, 0)}` },
    { t: "text", x: 60, y: 310, s: "1. Charges for Legal Services - Contingent Fee Basis: thirty percent of any recovery.", size: 10 },
    { t: "text", x: 60, y: 600, s: "Doe & Roe, P.A.", size: 10 },
    { t: "text", x: 60, y: 613, s: "514 SE 11th Court", size: 10 },
    { t: "text", x: 60, y: 626, s: "Fort Lauderdale, Florida 33316", size: 10 },
    { t: "text", x: 60, y: 639, s: "Tel: (305) 555-0166", size: 10 },
    { t: "text", x: 60, y: 652, s: "Email: lawyer@doeroe-example.com", size: 10 },
  ];
  const truth: Truth = {
    high: { insuredName1: c.p1.full, address: c.addressNorm, insurer: c.insurer, claimNumber: c.claim, policyNumber: c.policy, lossDate: expectedDate(c, locale) },
    noHigh: ["phone", "email"],
    forbidden: DECOYS,
  };
  return { pages: [{ ops }], truth };
}

type Builder = (c: Case, locale: Lang) => Promise<{ pages: PageSpec[]; truth: Truth }>;

const BUILDERS: Record<string, Builder> = { multiLabel, letterheadTable, thirdParty, moldAgreement, serviceAuthorization, lawRetainer };

/** Documentos realistas (inventados): 3 variantes por estructura (la segunda con dos asegurados). Se construye cada uno para conocer su verdad. */
export async function buildRealisticCorpusWithTruth(): Promise<CorpusDoc[]> {
  const out: CorpusDoc[] = [];
  let seed = 9000;
  for (const [name, build] of Object.entries(BUILDERS)) {
    for (let variant = 0; variant < 3; variant += 1) {
      const rng = makeRng((seed += 11));
      const c = makeCase(rng, "en", { second: variant === 1, claimType: variant !== 2 });
      const built = await build(c, "en");
      out.push({ id: `real-${name}-${variant}`, locale: "en", layout: `real-${name}`, source: () => pdfSource(built.pages), truth: built.truth });
    }
  }
  return out;
}
