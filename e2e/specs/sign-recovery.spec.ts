import { expect, test } from "@playwright/test";
import {
  collectAllSignatures,
  createBlockSignature,
  draftedStrokeCount,
  expectCollectedWorkRestored,
  leaveWithBrowserBack,
  makeTwoDocs,
  resumeFromDraftsSheet,
  sessionDraftCount,
  uploadDocs,
} from "../helpers/sign-flow";

/**
 * Firmar PDF · recuperar el trabajo (Fase 0 «Firma agil», U0.1, test-first). `docs/PLAN-FIRMA-AGIL.md` §1.2.
 *
 * El trabajo YA se guarda en un borrador de sesion (IndexedDB, con las firmas incluidas); lo que falta es que alguien lo
 * OFREZCA al volver. Hoy la unica entrada es el boton fantasma «Ver borradores».
 *
 *  - (d) CONTROL, sin etiqueta: recargar a 100 / 400 ms de la ultima firma deja el borrador completo y se retoma
 *    desde «Ver borradores». PASA hoy y debe seguir pasando (corre en la suite por defecto).
 *  - (c) `@f0-pendiente`: el BACK del navegador, volver a `/sign-pdf` y subir los MISMOS PDF debe ofrecer «Retomar lo que
 *    tenias» (U0.3). HOY FALLA: la herramienta empieza vacia y no dice que hay un borrador.
 *  - (c3)/(c4) `test.fixme`: dependen de la URL de sesion `?s=<id>` y de la hoja «¿Salir de la firma?» de U0.3, que aun
 *    no existen; se activan quitando el `fixme` cuando U0.3 las implemente.
 *
 * Para correr las pendientes:
 *   PW_F0=1 CI=1 PW_REUSE_SERVER=1 PW_PORT=3811 npx playwright test sign-recovery --project=chromium
 *
 * Headless siempre (modo por defecto de Playwright).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(180_000);

test.describe("control: recargar justo despues de la ultima firma no pierde el borrador", () => {
  for (const delayMs of [100, 400]) {
    test(`(d) recarga ${delayMs} ms despues de la ultima firma: el borrador esta completo y se retoma desde «Ver borradores»`, async ({
      page,
    }) => {
      const docs = await makeTwoDocs();
      await collectAllSignatures(page, docs, { holdLast: true });
      // Las tres primeras firmas ya estan en el borrador: la cuarta solo puede salvarla el volcado de la recarga.
      await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(3);

      await createBlockSignature(page, 2, 2, 22, { waitClosed: false });
      await page.waitForTimeout(delayMs);
      await page.reload();

      // El borrador esta ahi, con las CUATRO firmas (1 sesion, 4 bloques con trazo).
      expect(await sessionDraftCount(page)).toBe(1);
      await expect.poll(() => draftedStrokeCount(page), { timeout: 10_000 }).toBe(4);

      // Y se retoma desde la hoja «Ver borradores» (el camino que hoy existe).
      await resumeFromDraftsSheet(page);
      await expectCollectedWorkRestored(page, docs);
    });
  }
});

test.describe("el BACK del navegador no debe hacer desaparecer el trabajo", () => {
  test("@f0-pendiente (c) recoger firmas, BACK del navegador, volver a /sign-pdf y subir los MISMOS PDF: ofrece «Retomar lo que tenias»", async ({
    page,
  }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);

    // El borrador YA contiene las 4 firmas (no es un problema de guardado: el trabajo esta a salvo en este navegador).
    await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(4);

    // El usuario toca (o desliza) «Atras» del navegador y despues vuelve a la herramienta.
    await leaveWithBrowserBack(page);
    await page.goto("/sign-pdf");
    await uploadDocs(page, docs);
    expect(await sessionDraftCount(page), "el borrador sigue guardado: lo que falta es ofrecerlo").toBe(1);

    // CORRECTO: al subir los mismos documentos se ofrece retomar lo que habia. HOY: nada lo ofrece (solo «Ver borradores»).
    const offer = page.getByText("Retomar lo que tenías");
    await expect(offer, "al subir los MISMOS PDF debe ofrecerse retomar el borrador").toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /^Retomar/ }).first().click();
    await expectCollectedWorkRestored(page, docs);
  });

  test("@f0-pendiente (c2) al entrar en /sign-pdf con un borrador guardado se avisa «Tienes una firma sin terminar» sin buscar «Ver borradores»", async ({
    page,
  }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(4);

    await leaveWithBrowserBack(page);
    await page.goto("/sign-pdf");

    // CORRECTO (U0.3 punto 1): tarjeta con «Retomar» / «Descartar» / «Ver todos». HOY: la herramienta vacia, sin aviso.
    await expect(
      page.getByText("Tienes una firma sin terminar"),
      "con un borrador guardado, entrar en la herramienta debe avisar de el",
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Retomar" }).first()).toBeVisible();
  });

  // FALTA (U0.3 punto 3): al haber progreso la app hace `history.pushState(null, "", "?s=<idOpaco>")` (sin PII) para que
  // una recarga restaure SOLA. Hoy la URL nunca cambia (`/sign-pdf`), asi que no hay nada que restaurar sin pulsar
  // «Ver borradores». Quitar `.fixme` cuando exista `?s=`.
  test.fixme("@f0-pendiente (c3) recargar con ?s=<id> restaura la sesion entera sin pulsar nada", async ({ page }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(4);

    // La URL de la sesion: un id opaco, sin nombres de archivo ni de firmantes.
    await expect.poll(() => new URL(page.url()).searchParams.get("s")).toMatch(/^[\w-]{8,}$/);
    expect(page.url()).not.toMatch(/Contrato|Anexo|Ana|Luis/);

    await page.reload();
    await expectCollectedWorkRestored(page, docs);
  });

  // FALTA (U0.3 punto 3): el BACK del navegador con progreso vuelve a `/sign-pdf` (sin `s`) SIN desmontar y muestra la
  // hoja «¿Salir de la firma?» con «Seguir firmando» / «Salir». Hoy el BACK sale de la herramienta sin preguntar.
  test.fixme("@f0-pendiente (c4) el BACK del navegador con progreso pregunta «¿Salir de la firma?» y «Seguir firmando» lo conserva todo", async ({
    page,
  }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);

    await page.goBack();
    const sheet = page.getByRole("dialog", { name: /Salir de la firma/ });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Todo está guardado en este dispositivo");
    await sheet.getByRole("button", { name: "Seguir firmando" }).click();
    await expect(sheet).toBeHidden();
    await expectCollectedWorkRestored(page, docs);
  });
});
