import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  SIGNER_1,
  SIGNER_2,
  beforeUnloadPrevented,
  collectFirstSigner,
  continueToSign,
  defineSigners,
  draftHealth,
  draftRows,
  draftedStrokeCount,
  failIndexedDb,
  leaveSheet,
  leaveWithBrowserBack,
  makeTwoDocs,
  openSignAndUpload,
  placeSlotsInSingleDocument,
  prepareTwoDocsTwoSigners,
  sessionDraftCount,
  sessionParam,
  setIndexedDbFailure,
  signWholeTurn,
  singleDraftCount,
  startTurn,
  turnCounter,
  uploadDocs,
  waitForDraftSettled,
} from "../helpers/sign-flow";

/**
 * Firmar PDF · el borrador no miente y no se pisa (F0-fix: D1, D2 y D3 de la verificacion independiente de la Fase 0).
 *
 *  - D2: con IndexedDB fallando (cuota llena, o almacenamiento bloqueado como en Safari privado) NADA dice «guardado»:
 *    la hoja de salida avisa de que se perdera, el navegador pregunta al cerrar y un aviso discreto lo dice mientras dure.
 *  - D3: con UN documento y la misma plantilla para otro cliente, «Empezar de nuevo» no pisa el borrador del primero.
 *  - D1: dos pestanas con la misma sesion: la vieja no pisa a la nueva; su copia se guarda aparte y se avisa.
 *
 * Para correrlas (Chromium y, con `PW_BROWSERS=webkit-ipad`, el iPad):
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3861 npx playwright test sign-draft-safety --project=chromium
 *
 * Headless siempre (modo por defecto de Playwright).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(180_000);

const NO_AUTOSAVE = "Sin autoguardado: el navegador no deja guardar aquí. Descarga antes de salir";
const LEAVE_FAILED = "No se pudo guardar tu trabajo en este dispositivo: si sales se perderá";

/** Trazos (firmas e iniciales) guardados en el borrador del documento suelto (-1 = no hay). */
async function draftedDocumentStrokes(page: Page): Promise<number> {
  const row = (await draftRows(page)).find((candidate) => candidate.kind === "document");
  return row ? row.strokes : -1;
}

/** Abre la hoja de «Atras» y comprueba que NO afirma que todo esta guardado y que se puede seguir firmando. */
async function expectHonestLeaveSheet(page: Page, expected: string): Promise<void> {
  await page.goBack();
  const sheet = leaveSheet(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(expected);
  await expect(sheet).not.toContainText("Todo está guardado");
  // «Seguir firmando» es la accion primaria: recibe el foco al abrirse.
  await expect(sheet.getByRole("button", { name: "Seguir firmando" })).toBeFocused();
}

test.describe("D2 · el borrador no puede decir «guardado» si no se pudo guardar", () => {
  for (const mode of ["quota", "noidb"] as const) {
    test(`(d2-${mode}) con ${mode === "quota" ? "la cuota llena" : "el almacenamiento bloqueado"} la hoja de salida avisa de que se perdera, el navegador pregunta y hay aviso en pantalla`, async ({
      page,
    }) => {
      await failIndexedDb(page, mode);
      const docs = await makeTwoDocs();
      await collectFirstSigner(page, docs);
      await expect(draftHealth(page)).toContainText(NO_AUTOSAVE, { timeout: 10_000 });
      expect(await beforeUnloadPrevented(page)).toBe(true);
      await expectHonestLeaveSheet(page, LEAVE_FAILED);

      // «Seguir firmando» lo conserva todo.
      await leaveSheet(page).getByRole("button", { name: "Seguir firmando" }).click();
      await expect(leaveSheet(page)).toHaveCount(0);
      await expect(turnCounter(page)).toHaveText("Turno 2 de 2");
      await expect(draftHealth(page)).toContainText(NO_AUTOSAVE);
    });
  }

  test("(d2-single) con UN documento (borrador de documento suelto) y la cuota llena tambien avisa", async ({ page }) => {
    await failIndexedDb(page, "quota");
    const [only] = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, [only]);
    await defineSigners(page);
    await placeSlotsInSingleDocument(page);
    await expect(draftHealth(page)).toContainText(NO_AUTOSAVE, { timeout: 10_000 });
    expect(await beforeUnloadPrevented(page)).toBe(true);
    await expectHonestLeaveSheet(page, LEAVE_FAILED);
  });

  test("(d2-retry) el guardado se reintenta en el siguiente cambio y, al volver a funcionar, el aviso se retira y la hoja vuelve a decir «guardado»", async ({
    page,
  }) => {
    await failIndexedDb(page, "quota");
    const docs = await makeTwoDocs();
    await collectFirstSigner(page, docs);
    await expect(draftHealth(page)).toContainText(NO_AUTOSAVE, { timeout: 10_000 });
    expect(await sessionDraftCount(page)).toBe(0);

    // El navegador vuelve a dejar guardar: el siguiente cambio (pasar al turno del segundo firmante) reintenta.
    await setIndexedDbFailure(page, null);
    await startTurn(page);
    await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(1);
    await expect(draftHealth(page)).not.toContainText("Sin autoguardado");
    await expect.poll(() => beforeUnloadPrevented(page), { timeout: 15_000 }).toBe(true); // ronda a medias: sigue preguntando
    await page.goBack();
    await expect(leaveSheet(page)).toContainText("Todo está guardado");
    await expect(leaveSheet(page)).not.toContainText("No se pudo guardar");
  });

  test("(d2-solo) «Solo yo» no guarda borrador: con trabajo, el «Atras» pregunta y dice «Este modo no guarda borrador»", async ({ page }) => {
    const docs = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, docs);
    await createSoloSignature(page);
    await page.waitForTimeout(1500);
    // Nada se guarda en este modo...
    expect(await sessionDraftCount(page)).toBe(0);
    expect(await singleDraftCount(page)).toBe(0);
    // ...y por eso mismo avisa: perder lo hecho no se puede deshacer.
    expect(await beforeUnloadPrevented(page)).toBe(true);
    await expectHonestLeaveSheet(page, "Este modo no guarda borrador");
    await leaveSheet(page).getByRole("button", { name: "Seguir firmando" }).click();
    await expect(leaveSheet(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/sign-pdf");
    // «Salir» deja la herramienta.
    await page.goBack();
    await expect(leaveSheet(page)).toBeVisible();
    await leaveSheet(page).getByRole("button", { name: "Salir", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  });

  test("(d2-solo-vacio) «Solo yo» sin trabajo (solo se subio el PDF) no pregunta nada", async ({ page }) => {
    const docs = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, docs);
    await page.waitForTimeout(800);
    expect(await beforeUnloadPrevented(page)).toBe(false);
    await page.goBack();
    await expect(leaveSheet(page)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  });
});

/** «Solo yo» es el modo por defecto: crea la firma (escrita) y se coloca sola. */
async function createSoloSignature(page: Page): Promise<void> {
  // Un clic justo despues de subir un PDF puede perderse en WebKit (el documento aun se monta): se repite hasta que abre.
  await expect(async () => {
    if ((await page.getByRole("dialog").count()) === 0) await page.getByRole("button", { name: "Crear firma" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 20_000 });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Escribir" }).click();
  await dialog.getByLabel("Nombre", { exact: true }).fill("Ana");
  await dialog.getByRole("button", { name: "Usar esta firma" }).click();
  await expect(dialog).toBeHidden();
}

test.describe("D3 · «Empezar de nuevo» con el mismo PDF no pisa el borrador del primero", () => {
  test("(d3-single) misma plantilla (1 documento) para dos clientes: el borrador del primero sigue INTACTO tras varios segundos de autoguardado del segundo", async ({
    page,
  }) => {
    const [template] = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, [template]);
    await defineSigners(page);
    await placeSlotsInSingleDocument(page);
    await expect.poll(() => singleDraftCount(page), { timeout: 15_000 }).toBe(1);
    await waitForFields(page, 2);
    const [first] = await draftRows(page);
    expect(first.signers).toEqual([SIGNER_1, SIGNER_2]);
    await leaveWithBrowserBack(page);

    // Segundo cliente, MISMO PDF: se ofrece retomar el primero y se elige «Empezar de nuevo».
    await page.goto("/sign-pdf");
    await uploadDocs(page, [template]);
    await expect(page.getByText("Retomar lo que tenías")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await defineSigners(page, ["Maria", "Pedro"]);
    await placeSlotsInSingleDocument(page, ["Maria", "Pedro"]);
    await expect.poll(() => singleDraftCount(page), { timeout: 15_000 }).toBe(2);
    // Varios segundos de autoguardado del cliente B.
    await page.waitForTimeout(4000);

    const rows = await draftRows(page);
    expect(rows).toHaveLength(2);
    const a = rows.find((row) => row.signers.includes(SIGNER_1));
    const b = rows.find((row) => row.signers.includes("Maria"));
    expect(a, "el borrador del cliente A sigue ahi").toBeTruthy();
    expect(b, "el cliente B tiene el suyo").toBeTruthy();
    expect(a!.id).not.toBe(b!.id);
    expect(a!.id).toBe(first.id);
    expect(a!.signers).toEqual([SIGNER_1, SIGNER_2]);
    expect(a!.fields).toBe(2);
    // Los dos son del MISMO PDF (la huella es un campo propio) y el id sigue siendo opaco (64 hex).
    expect(a!.fingerprint ?? a!.id).toBe(b!.fingerprint ?? b!.id);
    expect(a!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(b!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionParam(page)).toBe(b!.id);

    // Al volver a subir el mismo PDF se ofrece el MAS RECIENTE y «Ver todos» lista los dos con fecha y firmantes.
    await leaveWithBrowserBack(page);
    await page.goto("/sign-pdf");
    await uploadDocs(page, [template]);
    const offer = page.locator("[data-resume-offer]");
    await expect(offer).toBeVisible({ timeout: 10_000 });
    await expect(offer).toContainText("Maria");
    await offer.getByRole("button", { name: "Ver todos" }).click();
    const sheet = page.getByRole("dialog", { name: "Borradores guardados" });
    await expect(sheet).toContainText(SIGNER_1);
    await expect(sheet).toContainText("Maria");
    await expect(sheet.getByText(/Guardado el /)).toHaveCount(2);
  });

  test("(d3-multi) con VARIOS documentos cada ronda tiene su propia sesion: «Empezar de nuevo» tampoco pisa", async ({ page }) => {
    const docs = await makeTwoDocs();
    await page.goto("/");
    await prepareTwoDocsTwoSigners(page, docs, "same");
    await waitForDraftSettled(page);
    const [first] = await draftRows(page);
    await leaveWithBrowserBack(page);

    await page.goto("/sign-pdf");
    await uploadDocs(page, docs);
    await expect(page.getByText("Retomar lo que tenías")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await defineSigners(page, ["Maria", "Pedro"]);
    await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(2);
    await page.waitForTimeout(3000);
    const rows = await draftRows(page);
    expect(rows).toHaveLength(2);
    const a = rows.find((row) => row.id === first.id);
    expect(a?.signers).toEqual([SIGNER_1, SIGNER_2]);
    expect(rows.find((row) => row.id !== first.id)?.signers).toEqual(["Maria", "Pedro"]);
  });
});

/** Espera a que el borrador guardado lleve `count` huecos (la huella y los huecos llegan tras el primer guardado). */
async function waitForFields(page: Page, count: number): Promise<void> {
  await expect
    .poll(async () => (await draftRows(page)).reduce((max, row) => Math.max(max, row.fields), 0), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(count);
}

test.describe("D1 · dos pestañas con la misma sesion", () => {
  test("(d1) la pestaña vieja NO pisa lo de la nueva: su copia se guarda aparte y se avisa con un enlace a «Ver borradores»", async ({
    context,
    page,
  }) => {
    const docs = await makeTwoDocs();
    await collectFirstSigner(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await waitForDraftSettledQuietly(page);
    const sessionUrl = page.url();
    expect(sessionParam(page)).toMatch(/^s-/);
    const original = (await draftRows(page))[0];

    // La pestaña nueva abre la MISMA sesion y la termina (firma Luis).
    const fresh = await context.newPage();
    await fresh.goto(sessionUrl);
    await expect(turnCounter(fresh)).toHaveText("Turno 2 de 2", { timeout: 20_000 });
    await signWholeTurn(fresh, 2, 40, true);
    await expect(fresh.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
    await expect.poll(() => draftedStrokeCount(fresh), { timeout: 20_000 }).toBe(4);

    // La pestaña vieja (que sigue en «Turno 2 de 2» con solo las firmas de Ana) hace un cambio trivial: pulsa «Listo, es mi
    // turno». ANTES pisaba el borrador de 4 firmas con el suyo de 2 (la ultima escritura ganaba sin comprobar version).
    await page.bringToFront();
    await startTurn(page);
    await page.waitForTimeout(2500);
    const rows = await draftRows(page);
    const kept = rows.find((row) => row.id === original.id);
    expect(kept?.strokes, "lo de la pestaña nueva sigue entero (4 firmas), la vieja no lo piso").toBe(4);

    // Su copia se guardo APARTE (2 firmas: solo las de Ana), marcada como copia del original, y se avisa en pantalla.
    await expect.poll(async () => (await draftRows(page)).length, { timeout: 15_000 }).toBe(2);
    const copy = (await draftRows(page)).find((row) => row.id !== original.id);
    expect(copy?.strokes, "la copia de la pestaña vieja (2 firmas, solo las de Ana)").toBe(2);
    expect(copy?.copyOf).toBe(original.id);
    await expect(draftHealth(page)).toContainText("Otra pestaña modificó esta firma; esta copia se guardó aparte", { timeout: 10_000 });
    // La pestaña vieja sigue trabajando sobre su copia (la direccion apunta a ella), y la nueva sobre la suya.
    await expect.poll(() => sessionParam(page)).toBe(copy!.id);
    expect(sessionParam(fresh)).toBe(original.id);

    // El enlace del aviso abre «Ver borradores» con las dos versiones, y la copia lleva su etiqueta.
    await draftHealth(page).getByRole("button", { name: "Ver borradores" }).click();
    const sheet = page.getByRole("dialog", { name: "Borradores guardados" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("listitem")).toHaveCount(2);
    await expect(sheet.getByText("Copia aparte")).toHaveCount(1);
  });

  test("(d1-aviso) antes de tocar nada, la pestaña vieja se entera por BroadcastChannel de que hay una version mas nueva", async ({
    context,
    page,
  }) => {
    const docs = await makeTwoDocs();
    await collectFirstSigner(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await waitForDraftSettledQuietly(page);
    const fresh = await context.newPage();
    await fresh.goto(page.url());
    await expect(turnCounter(fresh)).toHaveText("Turno 2 de 2", { timeout: 20_000 });
    await signWholeTurn(fresh, 2, 40, true);
    await expect.poll(() => draftedStrokeCount(fresh), { timeout: 20_000 }).toBe(4);
    await page.bringToFront();
    await expect(draftHealth(page)).toContainText("Otra pestaña modificó esta firma", { timeout: 10_000 });
    await expect(draftHealth(page).getByRole("button", { name: "Ver borradores" })).toBeVisible();
    // Todavia no hay copia: nada se ha pisado ni se ha duplicado.
    expect(await draftRows(page)).toHaveLength(1);
  });

  test("(d1-una) con UNA sola pestaña nada cambia: sin copias, sin avisos y el contador solo sube", async ({ page }) => {
    const docs = await makeTwoDocs();
    await collectFirstSigner(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await waitForDraftSettledQuietly(page);
    const first = (await draftRows(page))[0];
    await signWholeTurn(page, 2, 20, true);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBe(4);
    await page.reload();
    await page.waitForTimeout(2500);
    const rows = await draftRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].copyOf).toBeUndefined();
    expect((rows[0].rev ?? 0)).toBeGreaterThan(first.rev ?? 0);
    await expect(draftHealth(page)).not.toContainText("Otra pestaña");
  });

  test("(d1-abrir) F0-fix2 N3: abrir la MISMA sesion en otra pestaña sin tocar nada NO reescribe el borrador; la pestaña vieja sigue al dia y su siguiente cambio real se guarda SIN «Copia aparte»", async ({
    context,
    page,
  }) => {
    const docs = await makeTwoDocs();
    await collectFirstSigner(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await waitForDraftSettledQuietly(page);
    const original = (await draftRows(page))[0];
    expect(original.rev).toBeGreaterThanOrEqual(1);

    // La pestaña nueva abre y RESTAURA la sesion, y no hace nada. ANTES su autoguardado reescribia el borrador (rev + 1, otro
    // writerId) a los ~2,5 s, y la pestaña vieja quedaba «desactualizada».
    const fresh = await context.newPage();
    await fresh.goto(page.url());
    await expect(turnCounter(fresh)).toHaveText("Turno 2 de 2", { timeout: 20_000 });
    await fresh.waitForTimeout(4500);
    const afterOpen = await draftRows(fresh);
    expect(afterOpen).toHaveLength(1);
    expect(afterOpen[0].rev, "abrir no sube la version").toBe(original.rev);
    expect(afterOpen[0].writerId, "ni cambia de autor").toBe(original.writerId);
    expect(afterOpen[0].savedAt).toBe(original.savedAt);
    await expect(draftHealth(fresh)).not.toContainText("Otra pestaña");

    // La pestaña vieja ni se entera de nada: sin aviso, y su siguiente cambio real se guarda sobre el MISMO borrador.
    await page.bringToFront();
    await expect(draftHealth(page)).not.toContainText("Otra pestaña");
    await startTurn(page);
    await expect.poll(async () => (await draftRows(page))[0]?.rev, { timeout: 15_000 }).toBeGreaterThan(original.rev ?? 0);
    await page.waitForTimeout(1500);
    const rows = await draftRows(page);
    expect(rows, "sin «Copia aparte»").toHaveLength(1);
    expect(rows[0].id).toBe(original.id);
    expect(rows[0].copyOf).toBeUndefined();
    expect(sessionParam(page)).toBe(original.id);
    await expect(draftHealth(page)).not.toContainText("Otra pestaña");
    await expect(draftHealth(page)).not.toContainText("Sin autoguardado");
  });

  test("(d1-abrir-uno) F0-fix2 N3 con UN documento: «Retomar lo que tenias» en otra pestaña sin tocar nada NO reescribe el borrador del documento", async ({
    context,
    page,
  }) => {
    const [only] = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, [only]);
    await defineSigners(page);
    await placeSlotsInSingleDocument(page);
    await continueToSign(page);
    await signWholeTurn(page, 1, 10, false);
    await expect.poll(() => draftedDocumentStrokes(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await waitForDraftSettledQuietly(page);
    const original = (await draftRows(page))[0];
    expect(original.kind).toBe("document");

    const fresh = await context.newPage();
    await fresh.goto("/sign-pdf");
    await uploadDocs(fresh, [only]);
    await expect(fresh.getByText("Retomar lo que tenías")).toBeVisible({ timeout: 15_000 });
    await fresh.getByRole("button", { name: /^Retomar/ }).first().click();
    await expect(turnCounter(fresh)).toBeVisible({ timeout: 20_000 });
    await fresh.waitForTimeout(4500);
    const rows = await draftRows(fresh);
    expect(rows).toHaveLength(1);
    expect(rows[0].rev, "retomar no sube la version").toBe(original.rev);
    expect(rows[0].writerId, "ni cambia de autor").toBe(original.writerId);
    expect(rows[0].savedAt).toBe(original.savedAt);

    // La pestaña vieja hace un cambio real (firma el segundo firmante) y se guarda sobre el MISMO borrador.
    await page.bringToFront();
    await signWholeTurn(page, 1, 20, true);
    await expect.poll(async () => (await draftRows(page))[0]?.rev, { timeout: 15_000 }).toBeGreaterThan(original.rev ?? 0);
    await page.waitForTimeout(1500);
    const after = await draftRows(page);
    expect(after, "sin «Copia aparte»").toHaveLength(1);
    expect(after[0].copyOf).toBeUndefined();
    await expect(draftHealth(page)).not.toContainText("Otra pestaña");
  });

  test("(d1-abrir-real) y con cambios REALES en las dos pestañas D1 sigue igual: la que va por detras guarda su copia aparte y avisa", async ({
    context,
    page,
  }) => {
    const docs = await makeTwoDocs();
    await collectFirstSigner(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await waitForDraftSettledQuietly(page);
    const original = (await draftRows(page))[0];
    const fresh = await context.newPage();
    await fresh.goto(page.url());
    await expect(turnCounter(fresh)).toHaveText("Turno 2 de 2", { timeout: 20_000 });
    await fresh.waitForTimeout(3000);
    // La pestaña nueva firma de verdad (cambio real): escribe el borrador.
    await signWholeTurn(fresh, 2, 40, true);
    await expect.poll(() => draftedStrokeCount(fresh), { timeout: 20_000 }).toBe(4);
    // La vieja hace luego su propio cambio real: va por detras, asi que se guarda aparte.
    await page.bringToFront();
    await startTurn(page);
    await expect.poll(async () => (await draftRows(page)).length, { timeout: 15_000 }).toBe(2);
    const kept = (await draftRows(page)).find((row) => row.id === original.id);
    expect(kept?.strokes, "lo de la pestaña nueva sigue entero").toBe(4);
    await expect(draftHealth(page)).toContainText("Otra pestaña modificó esta firma; esta copia se guardó aparte", { timeout: 10_000 });
  });

  test("(d1-recarga) recargar a distintos plazos tras la ultima firma NO crea copias falsas (la misma pestaña no se compite a si misma)", async ({
    page,
  }) => {
    const docs = await makeTwoDocs();
    await collectFirstSigner(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    for (const delayMs of [0, 100, 400, 1500]) {
      await startTurn(page).catch(() => undefined);
      await page.waitForTimeout(delayMs);
      await page.reload();
      await expect(turnCounter(page)).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      expect((await draftRows(page)).length, `tras recargar a ${delayMs} ms`).toBe(1);
      await expect(draftHealth(page)).not.toContainText("Otra pestaña");
    }
  });
});

/** Espera a que no haya escritura pendiente (el aviso del navegador deja de preguntar por un cambio sin guardar). */
async function waitForDraftSettledQuietly(page: Page): Promise<void> {
  await expect.poll(async () => (await draftRows(page)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1500);
}

/* ------------------------------------------------------------------ *
 * axe: los avisos y hojas nuevas, claro/oscuro, ES/EN, 1280/375
 * ------------------------------------------------------------------ */

const AXE_PATH = require.resolve("axe-core/axe.min.js");

/** axe-core sobre un trozo de la pagina (reglas WCAG 2.x A/AA con contraste real): devuelve las violaciones. */
async function axeViolations(page: Page, selector: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (scope) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run({ include: [scope] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(" | ")}`);
  }, selector);
}

type Combo = { theme: "light" | "dark"; language: "es" | "en"; width: number };

const WORDS = {
  es: { several: "Varios firmantes", add: "Añadir firmante", viewDrafts: "Ver borradores", noAutosave: /Sin autoguardado/, leave: /Salir de la firma/, stay: "Seguir firmando", dialog: "Borradores guardados" },
  en: { several: "Several signers", add: "Add signer", viewDrafts: "View drafts", noAutosave: /No autosave/, leave: /Leave signing/, stay: "Keep signing", dialog: "Saved drafts" },
} as const;

async function newContext(browser: Browser, combo: Combo) {
  const context = await browser.newContext({
    viewport: { width: combo.width, height: combo.width < 600 ? 812 : 900 },
    colorScheme: combo.theme,
    hasTouch: combo.width < 600,
    locale: combo.language === "es" ? "es-ES" : "en-US",
  });
  // UNA sola vez por pestana: una recarga no pisa el idioma ni el tema.
  await context.addInitScript(
    ([theme, language]) => {
      if (window.sessionStorage.getItem("__seeded")) return;
      window.localStorage.setItem("optimuspdf.theme", theme);
      window.localStorage.setItem("optimuspdf.language", language);
      window.sessionStorage.setItem("__seeded", "1");
    },
    [combo.theme, combo.language],
  );
  return context;
}

async function expectNoOverflow(page: Page): Promise<void> {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scrollWidth, "sin desborde horizontal").toBeLessThanOrEqual(clientWidth);
}

async function expectTarget44(locator: ReturnType<Page["locator"]>, label: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} visible`).not.toBeNull();
  expect(box!.height, `${label} alto`).toBeGreaterThanOrEqual(43.5);
}

const COMBOS: Combo[] = [
  { theme: "light", language: "es", width: 1280 },
  { theme: "dark", language: "en", width: 375 },
  { theme: "dark", language: "es", width: 375 },
  { theme: "light", language: "en", width: 1280 },
];

test.describe("axe · avisos y hojas del borrador", () => {
  for (const combo of COMBOS) {
    const words = WORDS[combo.language];
    const name = `${combo.theme} · ${combo.language} · ${combo.width}px`;

    test(`(a1) ${name}: «Sin autoguardado» y la hoja «¿Salir de la firma?» con el texto de fallo no tienen violaciones`, async ({ browser }) => {
      const context = await newContext(browser, combo);
      const page = await context.newPage();
      try {
        await failIndexedDb(page, "quota");
        const docs = await makeTwoDocs();
        await page.goto("/");
        await openSignAndUpload(page, docs);
        await page.getByRole("tab", { name: words.several }).click();
        await page.getByRole("button", { name: words.add }).click();
        await expect(draftHealth(page)).toContainText(words.noAutosave, { timeout: 10_000 });
        expect(await axeViolations(page, "[data-draft-health]"), "aviso «sin autoguardado»").toEqual([]);
        await expectNoOverflow(page);
        await page.goBack();
        const sheet = page.getByRole("dialog", { name: words.leave });
        await expect(sheet).toBeVisible();
        await expect(sheet).not.toContainText(/Todo está guardado|Everything is saved/);
        // La hoja entra con un muelle: se espera a que se asiente antes de medir contraste.
        await page.waitForTimeout(1200);
        expect(await axeViolations(page, "[role=dialog]"), "hoja de salida (no se pudo guardar)").toEqual([]);
        await expectTarget44(sheet.getByRole("button", { name: words.stay }), words.stay);
      } finally {
        await context.close();
      }
    });

    test(`(a2) ${name}: «Solo yo» — la hoja «Este modo no guarda borrador» no tiene violaciones`, async ({ browser }) => {
      const context = await newContext(browser, combo);
      const page = await context.newPage();
      try {
        const docs = await makeTwoDocs();
        await page.goto("/");
        await openSignAndUpload(page, docs);
        const create = combo.language === "es" ? "Crear firma" : "Create signature";
        await expect(async () => {
          if ((await page.getByRole("dialog").count()) === 0) await page.getByRole("button", { name: create }).first().click();
          await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2500 });
        }).toPass({ timeout: 20_000 });
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("tab", { name: combo.language === "es" ? "Escribir" : "Type" }).click();
        await dialog.getByLabel(combo.language === "es" ? "Nombre" : "Name", { exact: true }).fill("Ana");
        await dialog.getByRole("button", { name: combo.language === "es" ? "Usar esta firma" : "Use this signature" }).click();
        await expect(dialog).toBeHidden();
        await page.waitForTimeout(800);
        await page.goBack();
        const sheet = page.getByRole("dialog", { name: words.leave });
        await expect(sheet).toBeVisible();
        await expect(sheet).toContainText(combo.language === "es" ? "Este modo no guarda borrador" : "This mode does not save a draft");
        await page.waitForTimeout(1200);
        expect(await axeViolations(page, "[role=dialog]"), "hoja de salida («Solo yo»)").toEqual([]);
        await expectTarget44(sheet.getByRole("button", { name: words.stay }), words.stay);
      } finally {
        await context.close();
      }
    });

    test(`(a3) ${name}: dos pestañas — el aviso «otra pestaña modificó esta firma» (antes y despues de la copia) y «Ver borradores» no tienen violaciones`, async ({ browser }) => {
      const context = await newContext(browser, combo);
      const page = await context.newPage();
      try {
        const docs = await makeTwoDocs();
        await page.goto("/");
        await openSignAndUpload(page, docs);
        await page.getByRole("tab", { name: words.several }).click();
        await page.getByRole("button", { name: words.add }).click();
        await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(1);
        await expect.poll(() => sessionParam(page), { timeout: 10_000 }).toMatch(/^s-/);
        await page.waitForTimeout(1500);

        // La otra pestaña retoma la misma sesion y la cambia (otro firmante).
        const other = await context.newPage();
        await other.goto(page.url());
        await expect(other.getByRole("button", { name: `1. ${docs[0].name}` })).toBeVisible({ timeout: 20_000 });
        await other.getByRole("button", { name: words.add }).click();
        await expect.poll(async () => (await draftRows(other))[0]?.signers.length ?? 0, { timeout: 15_000 }).toBe(2);

        await page.bringToFront();
        await expect(draftHealth(page)).toContainText(combo.language === "es" ? "Otra pestaña modificó esta firma" : "Another tab changed this signing", { timeout: 10_000 });
        await page.waitForTimeout(500);
        expect(await axeViolations(page, "[data-draft-health]"), "aviso (version mas nueva)").toEqual([]);
        await expectTarget44(draftHealth(page).getByRole("button", { name: words.viewDrafts }), words.viewDrafts);
        await expectNoOverflow(page);

        // Un cambio en la pestaña vieja: su copia se guarda aparte.
        await page.getByRole("button", { name: words.add }).click();
        await expect(draftHealth(page)).toContainText(combo.language === "es" ? "esta copia se guardó aparte" : "this copy was saved separately", { timeout: 10_000 });
        await page.waitForTimeout(500);
        expect(await axeViolations(page, "[data-draft-health]"), "aviso (copia aparte)").toEqual([]);
        await draftHealth(page).getByRole("button", { name: words.viewDrafts }).click();
        const sheet = page.getByRole("dialog", { name: words.dialog });
        await expect(sheet).toBeVisible();
        await expect(sheet.getByRole("listitem")).toHaveCount(2);
        await page.waitForTimeout(1200);
        expect(await axeViolations(page, "[role=dialog]"), "«Ver borradores» con la copia").toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
