import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  SIGNER_1,
  SIGNER_2,
  beforeUnloadPrevented,
  collectAllSignatures,
  continueToSign,
  createBlockSignature,
  defineSigners,
  draftRows,
  draftedStrokeCount,
  expectCollectedWorkRestored,
  historyLength,
  leaveSheet,
  leaveWithBrowserBack,
  makeOtherDoc,
  makeTwoDocs,
  openSignAndUpload,
  placeSlotsInSingleDocument,
  prepareTwoDocsTwoSigners,
  resumeFromDraftsSheet,
  sessionDraftCount,
  sessionParam,
  signWholeTurn,
  singleDraftCount,
  uploadDocs,
  waitForDraftSettled,
} from "../helpers/sign-flow";

/**
 * Firmar PDF · recuperar el trabajo (Fase 0 «Firma agil», U0.1 test-first -> U0.3 implementada). `docs/PLAN-FIRMA-AGIL.md` §1.2.
 *
 * El trabajo YA se guardaba en un borrador de sesion (IndexedDB, con las firmas incluidas); U0.3 lo OFRECE al volver y
 * avisa antes de perderlo:
 *  - (d) CONTROL: recargar a 100 / 400 ms de la ultima firma deja el borrador completo.
 *  - (c) subir los MISMOS PDF tras el BACK del navegador ofrece «Retomar lo que tenias» (por la huella del contenido).
 *  - (c2) entrar en `/sign-pdf` con un borrador guardado avisa «Tienes una firma sin terminar».
 *  - (c3) la sesion vive en la URL (`?s=<idOpaco>`) y recargar restaura SOLA; (c4) el BACK del navegador pregunta
 *    «¿Salir de la firma?» y «Seguir firmando» lo conserva todo.
 *  - (c5...) recarga 10/10, historial sin entradas de mas, enlaces de la cabecera, aviso al cerrar solo cuando toca, quitar
 *    un documento con «Deshacer», borrador equivocado por huella, URL manipulada, ES/EN, tamanos tactiles y axe.
 *
 * Para correrlas (Chromium y, con `PW_BROWSERS=webkit-ipad`, el iPad):
 *   PW_F0=1 CI=1 PW_REUSE_SERVER=1 PW_PORT=3831 npx playwright test sign-recovery --project=chromium
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
  test("(c) recoger firmas, BACK del navegador, volver a /sign-pdf y subir los MISMOS PDF: ofrece «Retomar lo que tenias»", async ({
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

  test("(c2) al entrar en /sign-pdf con un borrador guardado se avisa «Tienes una firma sin terminar» sin buscar «Ver borradores»", async ({
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

  // U0.3 punto 3: al haber progreso la app hace `history.pushState(..., "?s=<idOpaco>")` (sin PII) y una recarga restaura SOLA.
  test("(c3) recargar con ?s=<id> restaura la sesion entera sin pulsar nada", async ({ page }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(4);

    // La URL de la sesion: un id opaco, sin nombres de archivo ni de firmantes.
    await expect.poll(() => new URL(page.url()).searchParams.get("s")).toMatch(/^[\w-]{8,}$/);
    expect(page.url()).not.toMatch(/Contrato|Anexo|Ana|Luis/);

    await page.reload();
    await expectCollectedWorkRestored(page, docs);
  });

  // U0.3 punto 3: el BACK del navegador con progreso vuelve a `/sign-pdf` (sin `s`) SIN desmontar y muestra la hoja
  // «¿Salir de la firma?» con «Seguir firmando» / «Salir».
  test("(c4) el BACK del navegador con progreso pregunta «¿Salir de la firma?» y «Seguir firmando» lo conserva todo", async ({
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

/* ------------------------------------------------------------------ *
 * U0.3: retomar sin buscar y aviso al salir
 * ------------------------------------------------------------------ */

const AXE_PATH = require.resolve("axe-core/axe.min.js");

/** axe-core sobre un trozo de la pagina (reglas WCAG 2.x A/AA con contraste real): devuelve las violaciones. */
async function axeViolations(page: Page, selector: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (scope) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; nodes: unknown[] }> }> } }).axe;
    const result = await axe.run({ include: [scope] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id} x${violation.nodes.length}`);
  }, selector);
}

/** El objetivo mide al menos 44 px de alto (43,5 por el redondeo del muestreo). */
async function expectTouchTarget(locator: Locator, label: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} visible`).not.toBeNull();
  expect(box!.height, `${label} alto`).toBeGreaterThanOrEqual(43.5);
  expect(box!.width, `${label} ancho`).toBeGreaterThanOrEqual(43.5);
}

/** Recoge las firmas, sale por el BACK del navegador y vuelve a `/sign-pdf` (sin subir nada): hay un borrador y la pagina esta vacia. */
async function leaveWithWorkSaved(page: Page, docs: Awaited<ReturnType<typeof makeTwoDocs>>): Promise<void> {
  await collectAllSignatures(page, docs);
  await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(4);
  await leaveWithBrowserBack(page);
  await page.goto("/sign-pdf");
}

test.describe("la sesion en la URL", () => {
  test("(c5) recargar con ?s= restaura 10 de 10 veces: mismas firmas, mismo id, sin entradas de historial de mas", async ({ page }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(4);
    const id = sessionParam(page);
    expect(id).toMatch(/^[\w-]{8,}$/);
    const length = await historyLength(page);

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await page.reload();
      await expectCollectedWorkRestored(page, docs);
      expect(sessionParam(page), `recarga ${attempt}: la sesion sigue en la URL`).toBe(id);
      expect(await historyLength(page), `recarga ${attempt}: ninguna entrada de mas`).toBe(length);
    }
    expect(await sessionDraftCount(page)).toBe(1);
    expect(await draftedStrokeCount(page)).toBe(4);
  });

  test("(c6) con progreso se añade UNA sola entrada de historial, por muchos cambios que haya; sin progreso, ninguna", async ({ page }) => {
    const docs = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, docs);
    expect(sessionParam(page)).toBeNull();
    const before = await historyLength(page);
    // Con dos documentos subidos, sin tocar nada, la URL no cambia.
    await page.waitForTimeout(600);
    expect(sessionParam(page)).toBeNull();
    expect(await historyLength(page)).toBe(before);

    await prepareTwoDocsTwoSigners(page, docs, "independent");
    await expect.poll(() => sessionParam(page)).not.toBeNull();
    await continueToSign(page);
    await signWholeTurn(page, 2, 10, false);
    await signWholeTurn(page, 2, 20, true);
    expect(await historyLength(page)).toBe(before + 1);
  });

  test("(c7) el id de la URL es opaco: sin nombres de archivo ni de firmantes", async ({ page }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    expect(page.url()).not.toMatch(/Contrato|Anexo|Ana|Luis|\.pdf/i);
    expect(sessionParam(page)).toMatch(/^s-[a-z0-9]+-[a-z0-9]+$/);
  });

  test("(c8) «Seguir firmando» conserva TODO y el siguiente «Atras» vuelve a preguntar; «Salir» deja el borrador y llega fuera", async ({
    page,
  }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(4);
    const id = sessionParam(page);

    for (let round = 1; round <= 3; round += 1) {
      await page.goBack();
      await expect(leaveSheet(page), `«Atras» ${round}: pregunta`).toBeVisible();
      await leaveSheet(page).getByRole("button", { name: "Seguir firmando" }).click();
      await expect(leaveSheet(page)).toBeHidden();
      expect(sessionParam(page), `«Atras» ${round}: la sesion vuelve a la URL`).toBe(id);
    }
    await expectCollectedWorkRestored(page, docs);
    // Lo ultimo recogido sigue en el borrador.
    expect(await draftedStrokeCount(page)).toBe(4);

    await page.goBack();
    await expect(leaveSheet(page)).toBeVisible();
    await leaveSheet(page).getByRole("button", { name: "Salir", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
    expect(await sessionDraftCount(page)).toBe(1);
  });

  test("(c9) tras «Salir», volver con ADELANTE o desde Recientes ofrece retomarlo; el borrador no se perdio", async ({ page }) => {
    const docs = await makeTwoDocs();
    await leaveWithWorkSaved(page, docs);
    await expect(page.getByText("Tienes una firma sin terminar")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Retomar" }).first().click();
    await expectCollectedWorkRestored(page, docs);
    // Y restaurado, vuelve a haber sesion en la URL y el «Atras» vuelve a preguntar.
    await expect.poll(() => sessionParam(page)).not.toBeNull();
    await page.goBack();
    await expect(leaveSheet(page)).toBeVisible();
  });

  test("(c10) terminar y descargar retira la sesion de la URL y ya no pregunta ni avisa", async ({ page }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await page.getByRole("button", { name: "Firmar y descargar" }).click();
    await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => sessionParam(page)).toBeNull();
    expect(await beforeUnloadPrevented(page)).toBe(false);
    // La ronda ya esta entregada: UN «Atras» sale de verdad (la entrada base que dejo la sesion se salta) y sin preguntar.
    await page.goBack();
    await expect(leaveSheet(page)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  });

  test("(c11) una URL manipulada no restaura nada, no rompe y se limpia; un id valido de un borrador que no existe avisa", async ({ page }) => {
    const errors: string[] = [];
    // WebKit cuenta como `pageerror` las precargas de Next (`?_rsc=`) que aborta al navegar de golpe: ruido ajeno a la pagina.
    page.on("pageerror", (error) => {
      if (!/[?&]_rsc=/.test(error.message)) errors.push(`pageerror: ${error.message}`);
    });
    const dropzone = page.locator('input[type="file"][accept*="pdf"]').first();
    const HEX = "ab".repeat(32);
    for (const value of ["<img src=x onerror=\"window.__pwned=1\">", "../../etc/passwd", `${HEX}:${HEX}`, "s-<script>", "x".repeat(2000), ""]) {
      await page.goto(`/sign-pdf?s=${encodeURIComponent(value)}`);
      await expect(dropzone).toBeAttached();
      await expect.poll(() => new URL(page.url()).searchParams.has("s")).toBe(false);
      await expect(page.getByText(/ya no se puede recuperar/)).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
      expect(await page.locator("body").innerText()).not.toContain("onerror=");
    }
    await page.goto(`/sign-pdf?s=s-aaaaaaa-bbbbbbb&s=s-ccccccc-ddddddd`);
    await expect(dropzone).toBeAttached();
    await expect.poll(() => new URL(page.url()).searchParams.has("s")).toBe(false);
    await expect(page.getByText(/ya no se puede recuperar/)).toHaveCount(0);

    // Con la forma de un id real pero sin borrador: el aviso de siempre y la URL limpia.
    await page.goto("/sign-pdf?s=s-mgl1abc-1k3v9x2a");
    await expect(page.getByText(/ya no se puede recuperar/)).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.has("s")).toBe(false);
    expect(errors).toEqual([]);
  });
});

test.describe("retomar al subir los mismos PDF", () => {
  test("(c12) con OTROS PDF (aunque se llamen igual) no se ofrece el borrador equivocado; con los mismos, aunque cambien de nombre u orden, si", async ({
    page,
  }) => {
    const docs = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, docs);
    await defineSigners(page);
    await waitForDraftSettled(page);
    await leaveWithBrowserBack(page);

    // Dos archivos con los MISMOS nombres pero otro contenido: no es el mismo trabajo.
    await page.goto("/sign-pdf");
    const impostors = [
      await makeOtherDoc(docs[0].name, "otro contenido 1"),
      await makeOtherDoc(docs[1].name, "otro contenido 2"),
    ];
    await uploadDocs(page, impostors);
    await page.waitForTimeout(1200);
    await expect(page.getByText("Retomar lo que tenías")).toHaveCount(0);

    // Uno igual y otro distinto: tampoco (seria mezclar trabajos).
    await page.goto("/sign-pdf");
    await uploadDocs(page, [docs[0], await makeOtherDoc("Anexo B.pdf", "otro anexo")]);
    await page.waitForTimeout(1200);
    await expect(page.getByText("Retomar lo que tenías")).toHaveCount(0);

    // Los mismos contenidos con OTROS nombres y en OTRO orden: si.
    await page.goto("/sign-pdf");
    const renamed = [
      { ...docs[1], name: "segundo.pdf" },
      { ...docs[0], name: "primero.pdf" },
    ];
    await uploadDocs(page, renamed);
    await expect(page.getByText("Retomar lo que tenías")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Retomar", exact: true }).click();
    // Se restauran los documentos y firmantes GUARDADOS (con sus nombres originales).
    await expect(page.getByRole("button", { name: `1. ${docs[0].name}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `2. ${docs[1].name}` })).toBeVisible();
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1);
    await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2);
  });

  test("(c13) «Empezar de nuevo» deja el borrador guardado y empieza limpio; con UN documento la oferta tambien funciona", async ({ page }) => {
    const [only] = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, [only]);
    await defineSigners(page);
    await placeSlotsInSingleDocument(page);
    await expect.poll(() => singleDraftCount(page), { timeout: 15_000 }).toBe(1);
    // Con un solo documento la sesion de la URL es el id del borrador de esta sesion de trabajo (64 hex, opaco), sin nombres.
    await expect.poll(() => sessionParam(page)).toMatch(/^[0-9a-f]{64}$/);
    // Recargar con el documento suelto en la URL tambien restaura solo (firmantes y huecos).
    await page.reload();
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1);
    await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2);
    await leaveWithBrowserBack(page);

    await page.goto("/sign-pdf");
    await uploadDocs(page, [only]);
    await expect(page.getByText("Retomar lo que tenías")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await expect(page.getByText("Retomar lo que tenías")).toHaveCount(0);
    expect(await singleDraftCount(page)).toBe(1);
    const [first] = await draftRows(page);

    // F0-fix (D3): el cliente B trabaja sobre el MISMO PDF y su autoguardado NO pisa el borrador del cliente A, ni siquiera
    // tras varios segundos (antes los dos compartian id, la huella del PDF, y el segundo borraba al primero).
    await defineSigners(page, ["Maria", "Pedro"]);
    await placeSlotsInSingleDocument(page, ["Maria", "Pedro"]);
    await expect.poll(() => singleDraftCount(page), { timeout: 15_000 }).toBe(2);
    await page.waitForTimeout(4000);
    const rows = await draftRows(page);
    expect(rows).toHaveLength(2);
    const intact = rows.find((row) => row.id === first.id);
    expect(intact?.signers).toEqual([SIGNER_1, SIGNER_2]);
    expect(intact?.fields).toBe(2);
    expect(rows.find((row) => row.id !== first.id)?.signers).toEqual(["Maria", "Pedro"]);

    // Con DOS borradores del mismo PDF se ofrece el mas reciente y «Ver todos» deja elegir el de Ana y Luis.
    await page.goto("/sign-pdf");
    await uploadDocs(page, [only]);
    await expect(page.getByText("Retomar lo que tenías")).toBeVisible({ timeout: 10_000 });
    await page.locator("[data-resume-offer]").getByRole("button", { name: "Ver todos" }).click();
    const sheet = page.getByRole("dialog", { name: "Borradores guardados" });
    await expect(sheet.getByText(/Guardado el /)).toHaveCount(2);
    await sheet
      .getByRole("listitem")
      .filter({ hasText: SIGNER_1 })
      .getByRole("button", { name: "Reanudar" })
      .click();
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1);
    await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2);
  });
});

test.describe("la tarjeta de entrada y «Ver borradores»", () => {
  test("(c14) la tarjeta cuenta documentos, firmantes y quien ya firmo; «Descartar» confirma y borra; el contador se actualiza", async ({
    page,
  }) => {
    const docs = await makeTwoDocs();
    await leaveWithWorkSaved(page, docs);
    const card = page.locator("[data-resume-card]");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByRole("heading", { name: "Tienes una firma sin terminar" })).toBeVisible();
    await expect(card).toContainText(`Documentos: ${docs[0].name}, ${docs[1].name}`);
    await expect(card).toContainText(`Firmantes: ${SIGNER_1}, ${SIGNER_2}`);
    await expect(card).toContainText(`Firmas recogidas: ${SIGNER_1} ✓, ${SIGNER_2} ✓`);
    await expect(card).toContainText(/Guardado (ahora mismo|hace )/);

    // «Ver borradores»: boton visible de 44 px con el contador (su nombre accesible no cambia).
    const drafts = page.getByRole("button", { name: "Ver borradores", exact: true });
    await expectTouchTarget(drafts, "«Ver borradores»");
    await expect(drafts.locator("[data-drafts-count]")).toHaveText("1");

    // «Descartar» pide confirmacion: «Cancelar» no borra.
    await card.getByRole("button", { name: "Descartar" }).click();
    const dialog = page.getByRole("dialog", { name: /Descartar esta firma sin terminar/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();
    expect(await sessionDraftCount(page)).toBe(1);
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: "Descartar" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Descartar", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => sessionDraftCount(page)).toBe(0);
    await expect(drafts.locator("[data-drafts-count]")).toHaveCount(0);
    // El foco no cae a <body>.
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  });

  test("(c15) «Ver todos» abre la lista de borradores y los controles de la tarjeta miden 44 px", async ({ page }) => {
    const docs = await makeTwoDocs();
    await leaveWithWorkSaved(page, docs);
    const card = page.locator("[data-resume-card]");
    await expect(card).toBeVisible({ timeout: 10_000 });
    for (const name of ["Retomar", "Descartar", "Ver todos"]) {
      await expectTouchTarget(card.getByRole("button", { name, exact: true }), name);
    }
    await card.getByRole("button", { name: "Ver todos" }).click();
    await expect(page.getByRole("dialog", { name: "Borradores guardados" })).toBeVisible();
  });
});

test.describe("avisar antes de salir", () => {
  test("(c16) el navegador solo pregunta al cerrar con algo que perder: ronda a medias o cambio sin guardar; no con todo guardado ni sin progreso", async ({
    page,
  }) => {
    const docs = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, docs);
    // Sin progreso: nunca molesta.
    expect(await beforeUnloadPrevented(page)).toBe(false);

    await prepareTwoDocsTwoSigners(page, docs, "independent");
    // Con progreso y TODO guardado, en reposo: no molesta.
    await waitForDraftSettled(page);

    await continueToSign(page);
    await signWholeTurn(page, 2, 10, false);
    // Ana ya firmo y falta Luis: ronda a medias -> SI pregunta, aunque este todo guardado.
    await expect.poll(() => sessionDraftCount(page)).toBe(1);
    expect(await beforeUnloadPrevented(page)).toBe(true);

    await signWholeTurn(page, 2, 20, true);
    // Firmaron todos: la ronda ya no esta a medias y, con el borrador al dia, deja de preguntar.
    await expect.poll(() => beforeUnloadPrevented(page), { timeout: 15_000 }).toBe(false);
  });

  test("(c17) con la ronda a medias el navegador muestra su aviso REAL al cerrar (Chromium); «Quedarse» deja el trabajo intacto", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "El WebKit de Playwright no completa page.close({ runBeforeUnload }) en una pagina con manejadores: se cubre con (c16)");
    const docs = await makeTwoDocs();
    await page.goto("/");
    await prepareTwoDocsTwoSigners(page, docs, "independent");
    await continueToSign(page);
    await signWholeTurn(page, 2, 10, false);
    const closed = page.waitForEvent("close", { timeout: 8000 }).then(() => null, () => null);
    const dialogEvent = page.waitForEvent("dialog", { timeout: 8000 }).then((dialog) => dialog, () => null);
    await page.close({ runBeforeUnload: true });
    const dialog = await Promise.race([dialogEvent, closed]);
    expect(dialog, "el navegador pregunta").not.toBeNull();
    expect(dialog!.type()).toBe("beforeunload");
    await dialog!.dismiss();
    expect(page.isClosed()).toBe(false);
    await expect(page.getByRole("heading", { name: new RegExp(`Pásale el dispositivo a ${SIGNER_2}`) })).toBeVisible();
  });

  test("(c18) los enlaces de la cabecera/menu preguntan con la misma hoja; «Seguir» se queda; «Salir» navega y «Atras» devuelve la sesion sola", async ({
    page,
  }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(4);
    const id = sessionParam(page);
    const home = page.getByRole("link", { name: "Optimus PDF" }).first();

    await home.click();
    await expect(leaveSheet(page)).toBeVisible();
    await expect(leaveSheet(page)).toContainText("Todo está guardado en este dispositivo");
    expect(new URL(page.url()).pathname).toBe("/sign-pdf");
    await leaveSheet(page).getByRole("button", { name: "Seguir firmando" }).click();
    await expect(leaveSheet(page)).toBeHidden();
    expect(sessionParam(page)).toBe(id);
    await expectCollectedWorkRestored(page, docs);

    await home.click();
    await leaveSheet(page).getByRole("button", { name: "Salir", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
    expect(await sessionDraftCount(page)).toBe(1);

    // «Atras» a la sesion: se restaura SOLA desde el borrador.
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/sign-pdf");
    await expectCollectedWorkRestored(page, docs);
    expect(sessionParam(page)).toBe(id);
  });

  test("(c19) otras herramientas y Firmar sin progreso: los enlaces navegan sin preguntar nada", async ({ page }) => {
    await page.goto("/sign-pdf");
    await page.getByRole("link", { name: "Optimus PDF" }).first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
    await page.goto("/merge-pdf");
    await page.getByRole("link", { name: "Optimus PDF" }).first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
    await expect(leaveSheet(page)).toHaveCount(0);
  });

  test("(c25) «Solo yo» no guarda borrador (nada en IndexedDB) y por eso mismo avisa: con trabajo hecho, el «Atras» pregunta y dice «Este modo no guarda borrador»; sin trabajo no molesta", async ({
    page,
  }) => {
    const docs = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, docs);
    // «Solo yo» es el modo por defecto: se crea la firma (escrita) y se coloca sola.
    // Un clic justo despues de subir un PDF puede perderse en WebKit (el documento aun se monta): se repite hasta que la hoja abre.
    await expect(async () => {
      if ((await page.getByRole("dialog").count()) === 0) await page.getByRole("button", { name: "Crear firma" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2500 });
    }).toPass({ timeout: 20_000 });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "Escribir" }).click();
    await dialog.getByLabel("Nombre", { exact: true }).fill("Ana");
    await dialog.getByRole("button", { name: "Usar esta firma" }).click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(1500);
    // Nada se guarda en este modo (el aviso de privacidad solo promete guardar con varios firmantes)...
    expect(await sessionDraftCount(page)).toBe(0);
    expect(await singleDraftCount(page)).toBe(0);
    // ...y por eso mismo avisa (F0-fix D2): perder lo hecho no se puede deshacer. No promete lo que no hay: no dice «guardado».
    expect(await beforeUnloadPrevented(page)).toBe(true);
    await page.goBack();
    await expect(leaveSheet(page)).toBeVisible();
    await expect(leaveSheet(page)).toContainText("Este modo no guarda borrador");
    await expect(leaveSheet(page)).not.toContainText("Todo está guardado");
    await leaveSheet(page).getByRole("button", { name: "Salir", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  });
});

test.describe("quitar un documento con trabajo hecho", () => {
  async function twoDocsWithSigners(page: Page) {
    const docs = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, docs);
    await defineSigners(page);
    await waitForDraftSettled(page);
    return docs;
  }

  test("(c20) avisa «Quitaste ...» con «Deshacer»; el borrador sigue y deshacer devuelve la ronda entera con sus firmantes", async ({ page }) => {
    const docs = await twoDocsWithSigners(page);
    const id = sessionParam(page);
    await page.getByRole("button", { name: "Quitar" }).nth(1).click();
    const notice = page.locator("[data-resume-live]");
    await expect(notice).toHaveText(`Quitaste «${docs[1].name}» de la ronda.`);
    const undo = page.getByRole("button", { name: "Deshacer" });
    await expectTouchTarget(undo, "«Deshacer»");
    // El borrador de la sesion NO se borra mientras dura el «Deshacer».
    await page.waitForTimeout(1500);
    expect(await sessionDraftCount(page)).toBe(1);

    await undo.click();
    await expect(page.getByRole("button", { name: `1. ${docs[0].name}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `2. ${docs[1].name}` })).toBeVisible();
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1);
    await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2);
    await expect(page.getByRole("button", { name: "Deshacer" })).toHaveCount(0);
    // Sigue siendo LA MISMA sesion, con sus dos documentos, y la URL tambien.
    await expect.poll(() => sessionParam(page)).toBe(id);
    await page.waitForTimeout(1200);
    expect(await sessionDraftCount(page)).toBe(1);
    expect(await singleDraftCount(page)).toBe(0);
  });

  test("(c21) sin deshacer, al expirar el aviso el borrador de la sesion se borra y el del documento que queda toma el relevo", async ({ page }) => {
    await twoDocsWithSigners(page);
    await page.getByRole("button", { name: "Quitar" }).nth(1).click();
    await expect(page.getByRole("button", { name: "Deshacer" })).toBeVisible();
    // Hasta que expira el «Deshacer» (6 s) la sesion sigue guardada.
    await page.waitForTimeout(3000);
    expect(await sessionDraftCount(page)).toBe(1);
    await expect(page.getByRole("button", { name: "Deshacer" })).toHaveCount(0, { timeout: 8000 });
    await expect.poll(() => sessionDraftCount(page), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => singleDraftCount(page), { timeout: 10_000 }).toBe(1);
  });
});

test.describe("ingles, tactil y accesibilidad", () => {
  test("(c22) en ingles la tarjeta, la oferta y la hoja salen en ingles, sin claves crudas", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("optimuspdf.language", "en"));
    const docs = await makeTwoDocs();
    // En ingles los rotulos de la ceremonia son otros: se prepara el borrador sin ceremonia (un firmante basta).
    await page.goto("/");
    await openSignAndUpload(page, docs);
    await page.getByRole("tab", { name: "Several signers" }).click();
    await page.getByRole("button", { name: "Add signer" }).click();
    await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(1);
    await page.goBack();
    await expect(leaveSheet(page)).toBeVisible();
    await expect(leaveSheet(page)).toContainText("Everything is saved on this device");
    await expect(leaveSheet(page).getByRole("button", { name: "Keep signing" })).toBeVisible();
    await expect(leaveSheet(page).getByRole("button", { name: "Leave", exact: true })).toBeVisible();
    await leaveSheet(page).getByRole("button", { name: "Leave", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");

    await page.goto("/sign-pdf");
    await expect(page.getByRole("heading", { name: "You have an unfinished signing" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-resume-card]")).toContainText("Documents:");
    await uploadDocs(page, docs);
    await expect(page.getByRole("heading", { name: "Pick up where you left off" })).toBeVisible({ timeout: 10_000 });
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/resume\.|leaveTitle|cardTitle|offerTitle|undefined|\[object/);
  });

  test("(c23) axe: la tarjeta de entrada, la oferta al subir y la hoja «¿Salir de la firma?» no tienen violaciones", async ({ page }) => {
    const docs = await makeTwoDocs();
    await leaveWithWorkSaved(page, docs);
    await expect(page.locator("[data-resume-card]")).toBeVisible({ timeout: 10_000 });
    expect(await axeViolations(page, "[data-resume-card]")).toEqual([]);

    await uploadDocs(page, docs);
    await expect(page.locator("[data-resume-offer]")).toBeVisible({ timeout: 10_000 });
    expect(await axeViolations(page, "[data-resume-offer]")).toEqual([]);

    await page.getByRole("button", { name: "Retomar", exact: true }).click();
    await expectCollectedWorkRestored(page, docs);
    await page.goBack();
    await expect(leaveSheet(page)).toBeVisible();
    // La hoja entra con un muelle: se espera a que se asiente antes de medir contraste.
    await page.waitForTimeout(1200);
    expect(await axeViolations(page, "[role=dialog]")).toEqual([]);
  });

  test("(c23b) axe en tema OSCURO y en ingles: la tarjeta y la hoja mantienen el contraste", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("optimuspdf.theme", "dark");
      window.localStorage.setItem("optimuspdf.language", "en");
    });
    const docs = await makeTwoDocs();
    await page.goto("/");
    await openSignAndUpload(page, docs);
    await page.getByRole("tab", { name: "Several signers" }).click();
    await page.getByRole("button", { name: "Add signer" }).click();
    await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(1);
    await page.goBack();
    await expect(leaveSheet(page)).toBeVisible();
    await page.waitForTimeout(1200);
    expect(await axeViolations(page, "[role=dialog]")).toEqual([]);
    await leaveSheet(page).getByRole("button", { name: "Leave", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
    await page.goto("/sign-pdf");
    await expect(page.locator("[data-resume-card]")).toBeVisible({ timeout: 10_000 });
    expect(await axeViolations(page, "[data-resume-card]")).toEqual([]);
    await uploadDocs(page, docs);
    await expect(page.locator("[data-resume-offer]")).toBeVisible({ timeout: 10_000 });
    expect(await axeViolations(page, "[data-resume-offer]")).toEqual([]);
  });

  test("(c24) la hoja «¿Salir de la firma?»: foco atrapado, foco inicial en «Seguir firmando», Escape se queda y el foco vuelve", async ({
    page,
    browserName,
  }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await page.getByRole("button", { name: "Firmar y descargar" }).focus();
    await page.goBack();
    const sheet = leaveSheet(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Seguir firmando" })).toBeFocused({ timeout: 5000 });
    await expectTouchTarget(sheet.getByRole("button", { name: "Seguir firmando" }), "«Seguir firmando»");
    await expectTouchTarget(sheet.getByRole("button", { name: "Salir", exact: true }), "«Salir»");
    // El foco queda atrapado en la hoja (Tab recorre solo sus controles). El WebKit tactil de Playwright no enfoca botones
    // con Tab (ajuste de Safari «Tab resalta los controles»): alli se comprueba la entrada del foco y el cierre con Escape.
    if (browserName === "chromium") {
      for (let press = 0; press < 6; press += 1) {
        await page.keyboard.press("Tab");
        expect(await sheet.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      }
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    expect(sessionParam(page)).not.toBeNull();
    // El foco vuelve a la pagina (no se pierde en <body>).
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await expectCollectedWorkRestored(page, docs);
  });
});
