import { test, type Page } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { getPageText } from "../helpers/pdf-inspection";
import {
  CLIENT,
  FAKE_ONLY_REASON,
  OTHER_CLIENT,
  POLICY_SPECS,
  TEST_TIMEOUT,
  USE_REAL_ENGINE,
  addFileSource,
  autofillButton,
  engineCalls,
  expect,
  ocrCalls,
  fieldValues,
  installAutofillFakes,
  makeBlankContract,
  makeClaimForm,
  makePolicyPdf,
  openAutofill,
  openSignWith,
  readAndReview,
  sheet,
  textFieldBox,
  tinyJpeg,
} from "../helpers/autofill-ui";

/**
 * Autorrelleno desde documentos · flujo completo contra el motor FALSO (inyectado como el del Escaner): subir -> revisar ->
 * rellenar -> descargar el PDF con los valores estampados; no pisar lo escrito y deshacer; perfil guardado y reutilizado en un
 * segundo documento SIN leer nada; pegar texto y cancelar; foto sin modelo de lectura; error del motor; dos valores seguros;
 * contrato en blanco con rayas. Corre igual en Chromium y en `webkit-ipad`. Headless siempre.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(TEST_TIMEOUT);

// Las casillas y opciones son inputs sin apariencia bajo su etiqueta: se alternan con `force` (la etiqueta cubre toda la fila).
const fillButton = (page: Page, count: number | RegExp = /\d+/) => sheet(page).getByRole("button", { name: typeof count === "number" ? `Rellenar ${count} campo${count === 1 ? "" : "s"}` : new RegExp(`^Rellenar ${count.source} campos?$`) });
const status = (page: Page) => page.locator("[data-autofill-status]");

async function downloadText(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Procesar" }).click();
  await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 60_000 });
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Descargar" }).first().click();
  });
  return getPageText(bytes, 1);
}

async function typeInto(page: Page, label: string, text: string) {
  await textFieldBox(page, label).click();
  const input = page.locator("input[data-canvas-input]");
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press("Enter");
}

test("subir -> revisar -> rellenar -> descargar: el PDF lleva los valores marcados y solo esos", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, { byName: { "poliza.pdf": POLICY_SPECS } });
  await openSignWith(page, "reclamo.pdf", await makeClaimForm());
  await openAutofill(page);
  await addFileSource(page, "poliza.pdf", await makePolicyPdf());
  await readAndReview(page);

  const review = sheet(page).locator("[data-autofill-review]");
  // Por defecto: marcado lo de confianza alta, sin marcar lo de «Revisar».
  await expect(review.locator('[data-autofill-group="insuredName1"] input[type="checkbox"]')).toBeChecked();
  await expect(review.locator('[data-autofill-group="policyNumber"] input[type="checkbox"]')).toBeChecked();
  await expect(review.locator('[data-autofill-group="claimNumber"] input[type="checkbox"]')).not.toBeChecked();
  // La confianza se dice con texto y cada valor trae su evidencia y el por que.
  await expect(review.locator('[data-autofill-group="claimNumber"]')).toContainText("Revisar");
  await expect(review.locator('[data-autofill-group="insuredName1"]')).toContainText("Confianza alta");
  await expect(review.locator('[data-autofill-group="insuredName1"] [data-autofill-evidence]')).toHaveText(`Pág. 1: «Insured: ${CLIENT.name}»`);
  await expect(review.locator('[data-autofill-group="insuredName1"] [data-autofill-why]')).toContainText("junto a «Insured:»");
  // La vista previa dice a que campo va cada valor.
  await expect(review.locator("[data-autofill-row]")).toHaveCount(3);
  await expect(review.locator('[data-autofill-row="acro-1"]')).toContainText(CLIENT.name);
  await fillButton(page, 3).click();

  await expect(sheet(page)).toHaveCount(0);
  // El foco vuelve al boton que abrio la hoja y el resultado se anuncia en una region viva.
  await expect(autofillButton(page)).toBeFocused();
  await expect(status(page)).toHaveText(/Se rellenaron 3 campos\./);
  await expect(status(page)).toHaveAttribute("aria-live", "polite");
  expect(await fieldValues(page)).toMatchObject({ Insured: CLIENT.name, Phone: CLIENT.phone, "Policy Number": CLIENT.policy, "Claim Number": "" });

  const text = await downloadText(page);
  for (const value of [CLIENT.name, CLIENT.phone, CLIENT.policy]) expect(text).toContain(value);
  expect(text).not.toContain(CLIENT.claim);
  // Los valores quedan en el historial de valores como los escritos a mano (tras descargar con exito).
  const history = await page.evaluate(() => window.localStorage.getItem("optimuspdf.valueHistory") ?? "");
  expect(history).toContain(CLIENT.name);
});

test("lo que la persona ya escribio NO se pisa sin que lo acepte; marcarlo lo sustituye y «Deshacer» devuelve el texto", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, { byName: { "poliza.pdf": POLICY_SPECS } });
  await openSignWith(page, "reclamo.pdf", await makeClaimForm());
  await typeInto(page, "Insured", "Escrito a mano");
  await expect.poll(async () => (await fieldValues(page)).Insured).toBe("Escrito a mano");
  await openAutofill(page);
  await addFileSource(page, "poliza.pdf", await makePolicyPdf());
  await readAndReview(page);
  const row = sheet(page).locator('[data-autofill-row="acro-1"]');
  await expect(row).toHaveAttribute("data-overwrites", "");
  await expect(row.locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(row).toContainText("Ya tiene escrito «Escrito a mano»");
  // Solo los campos vacios cuentan: Phone y Policy Number.
  await fillButton(page, 2).click();
  await expect.poll(async () => (await fieldValues(page)).Phone).toBe(CLIENT.phone);
  expect((await fieldValues(page)).Insured).toBe("Escrito a mano");

  // Segunda pasada: aceptar a proposito el que pisa.
  await openAutofill(page);
  await addFileSource(page, "poliza.pdf", await makePolicyPdf());
  await readAndReview(page);
  await sheet(page).locator('[data-autofill-row="acro-1"] input[type="checkbox"]').check({ force: true });
  await fillButton(page, 1).click();
  await expect.poll(async () => (await fieldValues(page)).Insured).toBe(CLIENT.name);
  await status(page).getByRole("button", { name: "Deshacer" }).click();
  await expect.poll(async () => (await fieldValues(page)).Insured).toBe("Escrito a mano");
  await expect(status(page)).toContainText("Se deshizo el relleno.");
});

test("deshacer devuelve todos los campos a lo que tenian", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, { byName: { "poliza.pdf": POLICY_SPECS } });
  await openSignWith(page, "reclamo.pdf", await makeClaimForm());
  await openAutofill(page);
  await addFileSource(page, "poliza.pdf", await makePolicyPdf());
  await readAndReview(page);
  await fillButton(page, 3).click();
  await expect.poll(async () => (await fieldValues(page)).Insured).toBe(CLIENT.name);
  await status(page).getByRole("button", { name: "Deshacer" }).click();
  await expect.poll(async () => Object.values(await fieldValues(page)).join("")).toBe("");
  await expect(status(page).getByRole("button", { name: "Deshacer" })).toHaveCount(0);
});

test("perfil guardado: se guarda al rellenar y se reutiliza en OTRO documento sin leer nada", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, { byName: { "poliza.pdf": POLICY_SPECS } });
  await openSignWith(page, "reclamo-a.pdf", await makeClaimForm("CLAIM FORM A"));
  await openAutofill(page);
  await addFileSource(page, "poliza.pdf", await makePolicyPdf());
  await readAndReview(page);
  const save = sheet(page).getByRole("checkbox", { name: "Guardar como perfil" });
  await save.check({ force: true });
  // Se propone el nombre del asegurado.
  const name = sheet(page).getByLabel("Nombre del perfil");
  await expect(name).toHaveValue(CLIENT.name);
  await name.fill("Pérez Soto, María");
  await fillButton(page, 3).click();
  await expect(status(page)).toContainText("Perfil «Pérez Soto, María» guardado.");

  // Otro documento (otra pagina, otros bytes): el motor NO se llama.
  await openSignWith(page, "reclamo-b.pdf", await makeClaimForm("CLAIM FORM B"));
  expect((await engineCalls(page)).length).toBe(0);
  await openAutofill(page);
  await sheet(page).getByRole("button", { name: /^Usar un perfil guardado/ }).click();
  await expect(sheet(page).locator("[data-autofill-profile]")).toHaveCount(1);
  await expect(sheet(page)).toContainText("Pérez Soto, María");
  await sheet(page).getByRole("button", { name: "Usar el perfil Pérez Soto, María" }).click();
  await expect(sheet(page).locator("[data-autofill-review]")).toBeVisible();
  await expect(sheet(page).locator("[data-autofill-review]")).toContainText("Del perfil guardado «Pérez Soto, María»");
  // Lo de «Revisar» que no se marco no se guardo: solo 3 campos.
  await fillButton(page, 3).click();
  await expect(status(page)).toContainText("Se rellenaron 3 campos con datos de «Pérez Soto, María».");
  expect((await engineCalls(page)).length).toBe(0);
  const text = await downloadText(page);
  for (const value of [CLIENT.name, CLIENT.phone, CLIENT.policy]) expect(text).toContain(value);
  expect(text).toContain("CLAIM FORM B");
});

test("pegar texto: se lee como una fuente mas; cancelar una lectura lenta la corta y no escribe nada", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, { delayMs: 400, steps: 12 });
  await openSignWith(page, "reclamo.pdf", await makeClaimForm());
  await openAutofill(page);
  await sheet(page).getByRole("button", { name: "Pegar texto" }).click();
  await sheet(page).getByLabel("Texto con los datos del cliente").fill(`Insured: ${CLIENT.name}\nPhone: ${CLIENT.phone}\nPolicy: ${CLIENT.policy}`);
  await sheet(page).getByRole("button", { name: "Añadir texto" }).click();
  await expect(sheet(page).locator("[data-autofill-source]")).toHaveCount(1);
  await sheet(page).getByRole("button", { name: "Leer datos" }).click();
  await expect(sheet(page).getByRole("progressbar")).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "Cancelar" })).toBeFocused();
  await sheet(page).getByRole("button", { name: "Cancelar" }).click();
  await expect(sheet(page).locator("[data-autofill-notices]")).toHaveText("Lectura cancelada.");
  await expect(sheet(page).locator("[data-autofill-source]")).toHaveCount(1);
  expect(Object.values(await fieldValues(page)).join("")).toBe("");

  // Reintento sin cancelar: llega a revisar.
  await sheet(page).getByRole("button", { name: "Leer datos" }).click();
  await expect(sheet(page).locator("[data-autofill-review]")).toBeVisible({ timeout: 30_000 });
  await expect(sheet(page).locator('[data-autofill-group="insuredName1"] input[type="checkbox"]')).toBeChecked();
  await fillButton(page, 3).click();
  await expect.poll(async () => (await fieldValues(page)).Insured).toBe(CLIENT.name);
});

test("una foto SIN modelo de lectura: no se lee hasta que la persona lo pide; se descarga (con «Cancelar») y entonces se lee", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, {
    ocr: { available: false, prepare: "ok", delayMs: 700 },
    byName: { "licencia.jpg": [{ key: "insuredName1", value: CLIENT.name, tier: "review", confidence: 0.6, snippet: CLIENT.name }] },
  });
  await openSignWith(page, "reclamo.pdf", await makeClaimForm());
  await openAutofill(page);
  await addFileSource(page, "licencia.jpg", tinyJpeg(), "image/jpeg", "camera");
  await expect(sheet(page).locator("[data-autofill-source]")).toContainText("Foto · Imagen");
  await sheet(page).getByRole("button", { name: "Leer datos" }).click();
  // El motor NUNCA descarga el modelo: antes de leer se explica y se pide con un boton.
  await expect(sheet(page).locator("[data-autofill-model-body]")).toHaveText("Para leer fotos hace falta descargar el modelo una vez; los PDF con texto se leen sin descargar nada.");
  await expect(sheet(page).getByRole("heading", { name: "Hace falta el modelo de lectura" })).toBeFocused();
  expect((await engineCalls(page)).length).toBe(0);
  expect((await ocrCalls(page)).prepares).toBe(0);
  // Solo hay una foto: no se ofrece «Leer sin las fotos».
  await expect(sheet(page).getByRole("button", { name: "Leer sin las fotos" })).toHaveCount(0);

  // Cancelar la descarga vuelve al paso del modelo sin culpar a nadie.
  await sheet(page).getByRole("button", { name: "Descargar el modelo y leer" }).click();
  await expect(sheet(page).locator("[data-autofill-downloading]")).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "Cancelar" })).toBeFocused();
  await sheet(page).getByRole("button", { name: "Cancelar" }).click();
  await expect(sheet(page).locator("[data-autofill-model]")).toBeVisible();
  await expect(sheet(page).locator("[data-autofill-model-failure]")).toHaveCount(0);
  expect((await ocrCalls(page)).available).toBe(false);

  // Descargar de verdad: tras bajarlo se lee y se llega a revisar.
  await sheet(page).getByRole("button", { name: "Descargar el modelo y leer" }).click();
  await expect(sheet(page).locator("[data-autofill-review]")).toBeVisible({ timeout: 30_000 });
  expect(await ocrCalls(page)).toMatchObject({ available: true, prepares: 2 });
  expect((await engineCalls(page)).length).toBe(1);
  // Es un dato de «Revisar»: no viene marcado.
  await expect(sheet(page).locator('[data-autofill-group="insuredName1"] input[type="checkbox"]')).not.toBeChecked();
});

test("sin conexion la descarga del modelo falla con su motivo: se reintenta o se lee solo lo que no son fotos", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, {
    ocr: { available: false, prepare: "offline" },
    byName: { "poliza.pdf": POLICY_SPECS, "licencia.jpg": [{ key: "email", value: CLIENT.email }] },
  });
  await openSignWith(page, "reclamo.pdf", await makeClaimForm());
  await openAutofill(page);
  await addFileSource(page, "poliza.pdf", await makePolicyPdf());
  await addFileSource(page, "licencia.jpg", tinyJpeg(), "image/jpeg", "camera");
  await sheet(page).getByRole("button", { name: "Leer datos" }).click();
  await sheet(page).getByRole("button", { name: "Descargar el modelo y leer" }).click();
  await expect(sheet(page).locator("[data-autofill-model-failure]")).toHaveText("Sin conexión: no se pudo descargar el modelo. Conéctate e inténtalo de nuevo, o lee solo lo que no son fotos.");
  await expect(sheet(page).getByRole("button", { name: "Reintentar la descarga" })).toBeVisible();
  expect((await engineCalls(page)).length).toBe(0);
  // Los PDF con texto se leen igual: el motor recibe SOLO el PDF y la revision lo dice.
  await sheet(page).getByRole("button", { name: "Leer sin las fotos" }).click();
  await expect(sheet(page).locator("[data-autofill-review]")).toBeVisible({ timeout: 30_000 });
  expect((await engineCalls(page)).map((call) => call.sources)).toEqual([["poliza.pdf"]]);
  await expect(sheet(page).locator("[data-autofill-skipped-photos]")).toHaveText("No se leyó 1 foto.");
  await expect(sheet(page).locator('[data-autofill-group="insuredName1"] input[type="checkbox"]')).toBeChecked();
  await expect(sheet(page).locator('[data-autofill-group="email"]')).toHaveCount(0);
});

test("un PDF escaneado se descubre al leer: el aviso ofrece descargar el modelo y volver a leer; un fallo del motor se puede reintentar", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, {
    byName: { "escaneado.pdf": [{ key: "insuredName1", value: CLIENT.name, tier: "review", confidence: 0.6, snippet: CLIENT.name }] },
    warnings: { "escaneado.pdf": ["ocr-unavailable"] },
  });
  await openSignWith(page, "reclamo.pdf", await makeClaimForm());
  await openAutofill(page);
  await addFileSource(page, "escaneado.pdf", await makePolicyPdf());
  await readAndReview(page);
  await expect(sheet(page).locator('[data-autofill-warning="ocr-unavailable"]')).toHaveText(
    "Para leer fotos hace falta descargar el modelo una vez; los PDF con texto se leen sin descargar nada.",
  );
  await sheet(page).getByRole("button", { name: "Descargar el modelo y volver a leer" }).click();
  await expect(sheet(page).locator("[data-autofill-review]")).toBeVisible({ timeout: 30_000 });
  expect((await ocrCalls(page)).prepares).toBe(1);
  expect((await engineCalls(page)).length).toBe(2);
  await sheet(page).getByRole("button", { name: "Volver", exact: true }).click();

  await page.evaluate(() => {
    (globalThis as unknown as { __autofillFakeConfig: { failWith: string | null } }).__autofillFakeConfig.failWith = "motor caido";
  });
  await sheet(page).getByRole("button", { name: "Leer datos" }).click();
  await expect(sheet(page).locator("[data-autofill-failure]")).toHaveText("No se pudo leer. Inténtalo de nuevo o prueba con otra fuente.");
  await expect(sheet(page).locator("[data-autofill-source]")).toHaveCount(1);
  await page.evaluate(() => {
    (globalThis as unknown as { __autofillFakeConfig: { failWith: string | null } }).__autofillFakeConfig.failWith = null;
  });
  await sheet(page).getByRole("button", { name: "Leer datos" }).click();
  await expect(sheet(page).locator("[data-autofill-review]")).toBeVisible();
});

test("dos valores seguros distintos para el mismo dato: nada se marca solo, se elige uno", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, {
    byName: { "poliza.pdf": [{ key: "phone", value: CLIENT.phone }, { key: "phone", value: OTHER_CLIENT.phone, page: 2 }, { key: "insuredName1", value: CLIENT.name }] },
  });
  await openSignWith(page, "reclamo.pdf", await makeClaimForm());
  await openAutofill(page);
  await addFileSource(page, "poliza.pdf", await makePolicyPdf());
  await readAndReview(page);
  const group = sheet(page).locator('[data-autofill-group="phone"]');
  await expect(group).toContainText("Hay varios valores posibles: elige uno.");
  await expect(group.getByRole("radio", { name: "Ninguno" })).toBeChecked();
  await expect(sheet(page).locator('[data-autofill-row="acro-2"]')).toHaveCount(0);
  await group.getByRole("radio", { name: OTHER_CLIENT.phone }).check({ force: true });
  await expect(sheet(page).locator('[data-autofill-row="acro-2"]')).toContainText(OTHER_CLIENT.phone);
  await fillButton(page, 2).click();
  await expect.poll(async () => (await fieldValues(page)).Phone).toBe(OTHER_CLIENT.phone);
});

test("un contrato EN BLANCO con rayas (campos sugeridos, sin formulario): rellenar los convierte en campos con valor", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, { byName: { "poliza.pdf": POLICY_SPECS } });
  await openSignWith(page, "contrato.pdf", await makeBlankContract());
  await openAutofill(page);
  await addFileSource(page, "poliza.pdf", await makePolicyPdf());
  await readAndReview(page);
  const rows = sheet(page).locator("[data-autofill-row]");
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await expect(sheet(page).locator("[data-autofill-review]")).toContainText("sugerido");
  await sheet(page).getByRole("button", { name: /^Rellenar \d+ campos?$/ }).click();
  await expect.poll(async () => Object.values(await fieldValues(page)).filter(Boolean).length).toBeGreaterThanOrEqual(2);
  const text = await downloadText(page);
  expect(text).toContain(CLIENT.name);
});
