import { expect, test, type Page } from "@playwright/test";
import {
  DOC_A,
  DOC_B,
  SIGNER_1,
  SIGNER_2,
  captureAndReview,
  continueToSign,
  createBlockSignature,
  defineSigners,
  handoffHeading,
  makeSyntheticPdf,
  makeTwoDocs,
  openSignAndUpload,
  placeSlotsInSingleDocument,
  prepareTwoDocsTwoSigners,
  resumeFromDraftsSheet,
  sessionDraftCount,
  signWholeTurn,
  startTurn,
  turnCounter,
} from "../helpers/sign-flow";
import { clickUntil, stillBox } from "../helpers/engine";

/**
 * Firmar PDF · el TURNO de la ceremonia no puede reiniciarse (Fase 0 «Firma agil», U0.1 test-first, corregido en U0.2).
 *
 * Contexto (`docs/PLAN-FIRMA-AGIL.md` §1.3, causa T1): el turno (`turn`) y la etapa (`stage`) de la ceremonia vivian en
 * `useState(0)` de `BlockCeremony` / `SigningCeremony`; si el componente se remontaba (tocar la pestana de otro documento,
 * «Atras» -> «Continuar») volvia a «Turno 1 de 2» con el firmante 1, que ya firmo. U0.2 lo guarda en la SESION
 * (`session.ceremony`, persistido en el borrador) y lo deriva del primer firmante pendiente. Estas pruebas ya no llevan
 * la etiqueta de pendiente: corren en la ejecucion por defecto.
 *
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3811 npx playwright test sign-ceremony-turns --project=chromium
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3811 PW_BROWSERS=webkit-ipad npx playwright test sign-ceremony-turns --project=webkit-ipad
 *
 * (en WebKit la build de produccion se hace con `CSP_SKIP_UPGRADE_INSECURE=1`). Headless siempre (modo por defecto de Playwright).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(180_000);

/**
 * «Continuar» del paso «Documento» hacia «Firmar», tras un «Atras». El paso «Documento» pinta la hoja despues de
 * montarse y «Continuar» baja con ella: en WebKit un clic a mitad del desplazamiento caia sobre el hueco de un firmante
 * (o se perdia) y el paso no cambiaba. Se espera a que el boton este quieto y se repite el clic hasta que aparece el turno.
 */
async function backToSign(page: Page): Promise<void> {
  const next = page.getByRole("button", { name: "Continuar", exact: true });
  await stillBox(next);
  await clickUntil(next, async () => (await turnCounter(page).count()) > 0);
}

/** Dos documentos, dos firmantes, «Firmas distintas por documento»: cada firmante tiene UN BLOQUE POR DOCUMENTO. */
async function independentSetup(page: Page) {
  await prepareTwoDocsTwoSigners(page, await makeTwoDocs(), "independent");
  // Los huecos se acaban de colocar sobre el documento 2 (el activo): se vuelve al 1 para que, mas tarde, tocar la
  // pestana del 2 sea un cambio de documento de verdad (con el 2 ya activo, tocarlo no hace nada).
  await page.getByRole("button", { name: `1. ${DOC_A}` }).click();
  await expect(page.getByRole("button", { name: `1. ${DOC_A}` })).toHaveAttribute("aria-current", "true");
  await continueToSign(page);
  await expect(turnCounter(page)).toHaveText("Turno 1 de 2");
  await expect(handoffHeading(page, SIGNER_1)).toBeVisible();
}

test.describe("ceremonia de firma: el turno sobrevive a remontajes", () => {
  test("(a) 2 docs x 2 firmantes x firmas distintas: tras el turno 1, tocar la pestana del documento 2 NO vuelve a «Turno 1 de 2»", async ({
    page,
  }) => {
    await independentSetup(page);

    // Turno 1: Ana firma sus DOS bloques (Bloque 1 = Contrato A, Bloque 2 = Anexo B) y pasa el dispositivo.
    await signWholeTurn(page, 2, 10, false);
    await expect(turnCounter(page), "tras el turno de Ana le toca a Luis").toHaveText("Turno 2 de 2");
    await expect(handoffHeading(page, SIGNER_2)).toBeVisible();

    // El firmante 2 quiere «ver» el documento 2: toca su pestana (las pestanas siguen visibles en el paso Firmar).
    await page.getByRole("button", { name: `2. ${DOC_B}` }).click();
    await expect(page.getByRole("button", { name: `2. ${DOC_B}` })).toHaveAttribute("aria-current", "true");

    // CORRECTO: la ceremonia sigue donde estaba (turno de Luis). HOY: se remonta y pide otra vez el Turno 1 a Ana.
    await expect(turnCounter(page), "el turno no puede retroceder al remontar la ceremonia").toHaveText("Turno 2 de 2");
    await expect(handoffHeading(page, SIGNER_2)).toBeVisible();
    await expect(handoffHeading(page, SIGNER_1), "Ana ya firmo: no se le vuelve a pasar el dispositivo").toHaveCount(0);
  });

  test("(a2) con la revision de Ana a medias, tocar la pestana del documento 2 no le vuelve a pedir su turno desde el principio", async ({
    page,
  }) => {
    await independentSetup(page);

    // Ana termina de recoger sus dos firmas y esta en la REVISION (aun no pulso «Pasar al siguiente firmante»).
    await captureAndReview(page, 2, 20);
    await expect(page.getByRole("button", { name: "Pasar al siguiente firmante" })).toBeVisible();

    await page.getByRole("button", { name: `2. ${DOC_B}` }).click();
    await expect(page.getByRole("button", { name: `2. ${DOC_B}` })).toHaveAttribute("aria-current", "true");

    // CORRECTO: Ana ya completo sus firmas; no vuelve al traspaso del turno 1 (el turno se deriva de lo que falta).
    await expect(
      handoffHeading(page, SIGNER_1),
      "Ana ya firmo sus dos bloques: no se le vuelve a pasar el dispositivo desde cero",
    ).toHaveCount(0);
    await expect(turnCounter(page)).toBeVisible();
  });

  test("(b) «Atras» desde Firmar y «Continuar» no devuelve a «Turno 1 de 2» (2 docs, firmas distintas)", async ({
    page,
  }) => {
    await independentSetup(page);
    await signWholeTurn(page, 2, 30, false);
    await expect(turnCounter(page)).toHaveText("Turno 2 de 2");

    await page.getByRole("button", { name: "Atrás", exact: true }).click();
    await expect(page.getByRole("button", { name: "2. Documento" })).toHaveAttribute("aria-current", "step");
    await backToSign(page);

    await expect(turnCounter(page), "al volver a Firmar sigue el turno de Luis").toHaveText("Turno 2 de 2");
    await expect(handoffHeading(page, SIGNER_2)).toBeVisible();
    await expect(handoffHeading(page, SIGNER_1)).toHaveCount(0);
  });

  test("(b2) «Atras» -> «Continuar» con UN documento y dos firmantes tampoco reinicia el turno (SigningCeremony)", async ({
    page,
  }) => {
    await openSignAndUpload(page, [{ name: DOC_A, mimeType: "application/pdf", buffer: await makeSyntheticPdf("A") }]);
    await defineSigners(page);
    await placeSlotsInSingleDocument(page);
    await continueToSign(page);
    await expect(turnCounter(page)).toHaveText("Turno 1 de 2");

    await signWholeTurn(page, 1, 40, false);
    await expect(turnCounter(page)).toHaveText("Turno 2 de 2");

    await page.getByRole("button", { name: "Atrás", exact: true }).click();
    await expect(page.getByRole("button", { name: "2. Documento" })).toHaveAttribute("aria-current", "step");
    await backToSign(page);

    await expect(turnCounter(page), "al volver a Firmar sigue el turno de Luis").toHaveText("Turno 2 de 2");
    await expect(handoffHeading(page, SIGNER_1)).toHaveCount(0);
  });

  test("(a3, causa T2) con firmas distintas, «Ver cómo queda» apagado dice QUE falta (no se queda mudo)", async ({
    page,
  }) => {
    await independentSetup(page);

    // Ana firma solo el Bloque 1; el Bloque 2 (Anexo B) sigue pendiente, bajo el pliegue en un iPad.
    await startTurn(page);
    await createBlockSignature(page, 1, 2, 50);
    await expect(page.getByRole("button", { name: "Ver cómo queda" })).toBeDisabled();

    // CORRECTO: junto al boton apagado una frase nombra lo que falta («Falta: Firma · Bloque 2 ...»). HOY: ninguna.
    const hint = page.getByText(/falta/i).filter({ hasText: /Bloque 2|Anexo B/ });
    await expect(hint.first(), "el boton apagado debe explicar que falta (hoy: ninguna frase lo dice)").toBeVisible();
  });

  test("(a4) lo que falta se VE junto al boton apagado, la lista de progreso marca hecho/falta y «Ir a lo que falta» lleva al bloque pendiente", async ({
    page,
  }) => {
    await independentSetup(page);
    await startTurn(page);
    await createBlockSignature(page, 1, 2, 60);

    const review = page.getByRole("button", { name: "Ver cómo queda" });
    await expect(review).toBeDisabled();

    // La frase VISIBLE (no solo la region viva oculta): la enlaza el boton apagado.
    const hintId = await review.getAttribute("aria-describedby");
    expect(hintId, "el boton apagado apunta a la frase que explica por que").toBeTruthy();
    const hint = page.locator(`[id="${hintId}"]`);
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText("Falta: Firma · Anexo B");

    // Progreso por bloque: Firma · Contrato A hecho, Firma · Anexo B pendiente.
    const progress = page.getByRole("list", { name: "Progreso de Ana" }).getByRole("listitem");
    await expect(progress).toHaveCount(2);
    await expect(progress.nth(0)).toHaveText(/^Firma · Contrato A\s*hecho$/);
    await expect(progress.nth(1)).toHaveText(/^Firma · Anexo B\s*falta$/);

    // «Ir a lo que falta»: objetivo tactil >= 44 px y lleva el foco al «Crear mi firma · Bloque 2».
    const goToMissing = page.getByRole("button", { name: "Ir a lo que falta" });
    await expect(goToMissing).toBeVisible();
    const box = await goToMissing.boundingBox();
    expect(box?.height ?? 0, "objetivo tactil de al menos 44 px").toBeGreaterThanOrEqual(44);
    await goToMissing.click();
    const target = page.getByRole("button", { name: "Crear mi firma · Bloque 2", exact: true });
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();

    // Al recoger lo que faltaba, la frase y el salto desaparecen y «Ver cómo queda» se habilita.
    await createBlockSignature(page, 2, 2, 61);
    await expect(page.locator(`[id="${hintId}"]`)).toHaveCount(0);
    await expect(goToMissing).toHaveCount(0);
    await expect(review).toBeEnabled();
  });

  test("(a5) recarga con el turno de Luis a medias: al retomar el borrador sigue «Turno 2 de 2» con Luis (no vuelve a Ana)", async ({
    page,
  }) => {
    await independentSetup(page);
    await signWholeTurn(page, 2, 70, false);
    await expect(turnCounter(page)).toHaveText("Turno 2 de 2");
    await startTurn(page);
    await expect(page.getByRole("heading", { name: "Firma de Luis" })).toBeVisible();

    // El borrador de sesion YA guarda de quien es el turno y en que etapa (lo que escribio el ultimo clic).
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<string>((resolve) => {
                const request = indexedDB.open("optimuspdf-sign-drafts");
                request.onerror = () => resolve("error");
                request.onsuccess = () => {
                  const db = request.result;
                  if (!db.objectStoreNames.contains("sessionMeta")) {
                    db.close();
                    resolve("sin-borrador");
                    return;
                  }
                  const all = db.transaction("sessionMeta", "readonly").objectStore("sessionMeta").getAll();
                  all.onsuccess = () => {
                    db.close();
                    const meta = all.result[0] as
                      | { signers?: Array<{ id: string; name: string }>; ceremony?: { signerId: string; stage: string } }
                      | undefined;
                    const who = meta?.signers?.find((signer) => signer.id === meta.ceremony?.signerId)?.name;
                    resolve(meta?.ceremony ? `${who}:${meta.ceremony.stage}` : "sin-turno");
                  };
                  all.onerror = () => {
                    db.close();
                    resolve("error");
                  };
                };
              }),
          ),
        { timeout: 15_000 },
      )
      .toBe("Luis:capture");

    await page.reload();
    expect(await sessionDraftCount(page)).toBe(1);
    await resumeFromDraftsSheet(page);

    // Retomado: el paso Firmar abre en el turno de Luis, en su captura, con la firma de Ana intacta.
    await expect(turnCounter(page)).toHaveText("Turno 2 de 2", { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Firma de Luis" })).toBeVisible();
    await expect(handoffHeading(page, SIGNER_1)).toHaveCount(0);
  });
});
