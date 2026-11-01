import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { TEST_TIMEOUT, addFileSource, expect, fieldValues, makeBlankContract, makeClaimForm, openAutofill, openSignWith, readAndReview, sheet } from "../helpers/autofill-ui";

/**
 * Autorrelleno · flujo completo con el MOTOR REAL (sin motor falso inyectado): un PDF sintetico de reclamo (datos inventados,
 * e2e/fixtures/autofill-claim-en.pdf) se lee en el navegador, se revisa y se rellena un formulario AcroForm. Headless siempre.
 */

test.use({ locale: "es-ES" });
test.setTimeout(TEST_TIMEOUT);

test("motor real: un PDF de reclamo en ingles rellena los campos del formulario tras la revision", async ({ page }) => {
  await openSignWith(page, "reclamo.pdf", await makeClaimForm());
  await openAutofill(page);
  await addFileSource(page, "claim-source.pdf", readFileSync(path.join(process.cwd(), "e2e/fixtures/autofill-claim-en.pdf")));
  await readAndReview(page);

  const review = sheet(page).locator("[data-autofill-review]");
  await expect(review.locator('[data-autofill-group="insuredName1"]')).toContainText("Maria Testwell");
  await expect(review.locator('[data-autofill-group="policyNumber"]')).toContainText("HO3-0042817");
  await expect(review.locator('[data-autofill-group="claimNumber"]')).toContainText("CLM-2026-118342");
  // Los datos de la empresa del pie (senuelos) no se proponen.
  await expect(review).not.toContainText("info@responsive-example.com");
  await expect(review).not.toContainText("555-0188");

  await sheet(page).getByRole("button", { name: /^Rellenar \d+ campos?$/ }).click();
  await expect(sheet(page)).toBeHidden();
  const values = await fieldValues(page);
  expect(values["Insured"]).toContain("Maria Testwell");
  expect(values["Policy Number"]).toBe("HO3-0042817");
  expect(values["Claim Number"]).toBe("CLM-2026-118342");
  expect(values["Observaciones"]).toBe("");
});

test("motor real: un PDF de reclamo en espanol rellena un contrato en blanco con rayas", async ({ page }) => {
  await openSignWith(page, "contrato.pdf", await makeBlankContract());
  await openAutofill(page);
  await addFileSource(page, "reclamo-es.pdf", readFileSync(path.join(process.cwd(), "e2e/fixtures/autofill-claim-es.pdf")));
  await readAndReview(page);

  const review = sheet(page).locator("[data-autofill-review]");
  await expect(review.locator('[data-autofill-group="insuredName1"]')).toContainText("María Pérez");
  await expect(review.locator('[data-autofill-group="policyNumber"]')).toContainText("HO3-0042817");
  await expect(review).not.toContainText("info@responsive-example.com");

  await sheet(page).getByRole("button", { name: /^Rellenar \d+ campos?$/ }).click();
  await expect(sheet(page)).toBeHidden();
  await expect.poll(async () => Object.values(await fieldValues(page)).filter(Boolean).length).toBeGreaterThanOrEqual(3);
  const joined = Object.values(await fieldValues(page)).join(" | ");
  expect(joined).toContain("María Pérez");
  expect(joined).toContain("HO3-0042817");
  expect(joined).toContain("FL26-84705");
});
