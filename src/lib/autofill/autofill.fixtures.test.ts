import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExtract } from "@/lib/autofill/engine";
import { nodeDeps } from "@/lib/autofill/testing/nodeDeps";

/** Los fixtures de `e2e/fixtures/autofill-claim-*.pdf` (sinteticos, los usan las pruebas E2E de la interfaz) dan lo esperado con el motor. */
const EXPECTED = {
  en: {
    insuredName1: "Maria Testwell",
    insuredName2: "John Testwell",
    phone: "(305) 555-0142",
    email: "maria.testwell@example.com",
    address: "1234 Maple Ridge Dr, Miami, FL 33166",
    insurer: "Palmetto Mutual Insurance Company",
    policyNumber: "HO3-0042817",
    claimNumber: "CLM-2026-118342",
    claimType: "Wind",
    lossDate: "03/14/2026",
  },
  es: {
    insuredName1: "María Pérez",
    insuredName2: "José Pérez",
    phone: "(787) 555-0123",
    email: "maria.perez@example.com",
    address: "Calle Luna #123, Urb. Las Flores, San Juan, PR 00901",
    insurer: "Seguros Atlas del Caribe",
    policyNumber: "HO3-0042817",
    claimNumber: "FL26-84705",
    claimType: "Granizo",
    lossDate: "14/03/2026",
  },
} as const;

describe.each(["en", "es"] as const)("fixture autofill-claim-%s.pdf", (locale) => {
  it("el motor lee las diez claves con nivel alto y ningun senuelo del pie", async () => {
    const bytes = fs.readFileSync(path.join(process.cwd(), "e2e", "fixtures", `autofill-claim-${locale}.pdf`));
    const result = await createExtract(nodeDeps())([{ kind: "pdf", file: new File([new Uint8Array(bytes)], "f.pdf"), origin: "file" }], { locale });
    expect(Object.fromEntries(result.values.map((value) => [value.key, value.value]))).toEqual(EXPECTED[locale]);
    expect(result.values.every((value) => value.tier === "high")).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.pagesRead).toBe(2);
  });
});
