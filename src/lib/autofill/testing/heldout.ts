/**
 * Segundo conjunto SINTETICO, con SINONIMOS de etiqueta que el corpus principal no usa («Homeowner», «Carrier», «Policy ID», «Peril»,
 * «Incident Date», «Domicilio», «Contratante»…) y disposiciones mezcladas por documento. Mide cuanto generalizan las reglas fuera de
 * las etiquetas con las que se afinaron. Datos inventados, igual que el corpus principal.
 */

import { makeRng } from "@/lib/scan/__fixtures__/rng";
import { LAYOUTS, expectedDate, makeCase, pdfSource, typedDate, typedPhone, type CorpusDoc, type Lang, type Pair, type PageSpec } from "@/lib/autofill/testing/corpus";

const ALT: Record<Lang, Record<string, string[]>> = {
  en: {
    name: ["Policyholder Name", "Homeowner", "Owner Name", "Customer", "Claimant Name", "Name of Insured"],
    phone: ["Cell", "Mobile", "Contact Phone", "Telephone No.", "Home Phone"],
    email: ["Email Address", "E-Mail", "Insured Email"],
    address: ["Property Location", "Risk Address", "Mailing Address", "Residence", "Street Address", "Damaged Property"],
    insurer: ["Carrier", "Insurance Co.", "Underwriter", "Insurance Carrier", "Insurer Name"],
    policyNumber: ["Policy ID", "Pol. #", "Policy Number", "Policy No"],
    claimNumber: ["Claim Reference", "Claim ID", "Claim Ref. No.", "Claim Number"],
    claimType: ["Cause of Damage", "Peril", "Nature of Loss", "Reason for Claim"],
    lossDate: ["Incident Date", "Date of Incident", "Date of Damage", "Loss Occurred"],
  },
  es: {
    name: ["Nombre completo", "Propietario", "Contratante", "Titular", "Nombre del titular"],
    phone: ["Celular", "Móvil", "Teléfono de contacto", "Número de celular"],
    email: ["Correo", "E-mail", "Correo electrónico"],
    address: ["Domicilio", "Ubicación de la propiedad", "Dirección del inmueble", "Dirección de la vivienda"],
    insurer: ["Compañía aseguradora", "Empresa aseguradora", "Aseguradora", "Nombre de la aseguradora"],
    policyNumber: ["No. de póliza", "Número de la póliza", "Póliza #", "Póliza No."],
    claimNumber: ["Número de reclamación", "Reclamación No.", "Expediente", "Siniestro No."],
    claimType: ["Causa del daño", "Naturaleza de la pérdida", "Tipo de siniestro", "Daño causado por"],
    lossDate: ["Fecha del incidente", "Fecha de ocurrencia", "Fecha del daño", "Fecha de la pérdida"],
  },
};

const LAYOUT_NAMES = ["inline", "cols", "overlay", "split", "stacked", "headerRow", "dense"] as const;

export function buildHeldOutCorpus(): CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  let seed = 31_000;
  for (const lang of ["en", "es"] as const) {
    for (let n = 0; n < 28; n += 1) {
      const rng = makeRng((seed += 13));
      const layoutName = LAYOUT_NAMES[n % LAYOUT_NAMES.length];
      // Dos nombres largos no caben en una columna estrecha ni en una linea de dos pares: el texto se montaria sobre el vecino.
      const c = makeCase(rng, lang, { second: n % 4 === 1 && layoutName !== "headerRow" && layoutName !== "dense", claimType: true });
      const alt = ALT[lang];
      const style = rng.int(0, 4);
      const caps = n % 7 === 6;
      const shape = (text: string): string => (caps ? text.toUpperCase() : text);
      const fullNames = c.p2 ? `${c.p1.full} ${lang === "es" ? "y" : "and"} ${c.p2.full}` : c.p1.full;
      const pairs: Pair[] = [
        { key: "insuredName1", label: rng.pick(alt.name), value: shape(fullNames), expected: caps ? titleCaseSimple(c.p1.full) : c.p1.full },
        { key: "address", label: rng.pick(alt.address), value: `${c.street}, ${c.city}, ${c.state} ${c.zip}`, expected: c.addressNorm },
        { key: "phone", label: rng.pick(alt.phone), value: typedPhone(c, style), expected: c.phoneNorm },
        { key: "email", label: rng.pick(alt.email), value: c.email, expected: c.email },
        { key: "insurer", label: rng.pick(alt.insurer), value: c.insurer, expected: c.insurer },
        { key: "policyNumber", label: rng.pick(alt.policyNumber), value: c.policy, expected: c.policy },
        { key: "claimNumber", label: rng.pick(alt.claimNumber), value: c.claim, expected: c.claim },
        { key: "claimType", label: rng.pick(alt.claimType), value: c.claimType ?? "Wind", expected: c.claimType ?? "Wind" },
        { key: "lossDate", label: rng.pick(alt.lossDate), value: typedDate(c, style), expected: expectedDate(c, lang) },
      ];
      const high: Record<string, string> = {};
      for (const pair of pairs) high[pair.key] = pair.expected;
      if (c.p2) high.insuredName2 = caps ? titleCaseSimple(c.p2.full) : c.p2.full;
      docs.push({
        id: `heldout-${layoutName}-${lang}-${n}`,
        locale: lang,
        layout: `heldout-${layoutName}`,
        source: async (): Promise<ReturnType<typeof pdfSource> extends Promise<infer S> ? S : never> => pdfSource((await LAYOUTS[layoutName](pairs, c, rng)) as PageSpec[]),
        truth: { high },
      });
    }
  }
  return docs;
}

function titleCaseSimple(text: string): string {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
    .replace(/O'([a-z])/g, (_, c: string) => `O'${c.toUpperCase()}`);
}
