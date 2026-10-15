import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import {
  SIGNER_1,
  SIGNER_2,
  beforeUnloadPrevented,
  collectAllSignatures,
  defineSigners,
  draftedStrokeCount,
  expectCollectedWorkRestored,
  handoffHeading,
  leaveWithBrowserBack,
  makeTwoDocs,
  openSignAndUpload,
  placeSlotsInSingleDocument,
  sessionDraftCount,
  sessionParam,
  signWholeTurn,
  singleDraftCount,
  continueToSign,
  turnCounter,
  uploadDocs,
  waitForDraftSettled,
  type SyntheticDoc,
} from "../helpers/sign-flow";
import { downloadBytes } from "../helpers/downloads";

/**
 * Firmar PDF · privacidad del borrador con firmas (Fase 0 «Firma agil», U0.4) y opcion «E-sign» deshabilitada (U0.7).
 * `docs/PLAN-FIRMA-AGIL.md` §3 U0.4 / U0.7 y §10 (decision D3: «sí, guárdalo»).
 *
 *  - (p1) primer uso: el aviso trae el interruptor «Guardar también las firmas recogidas para no perderlas» ENCENDIDO; el
 *    mismo ajuste vive en Ajustes y el texto del aviso lo refleja.
 *  - (p2) APAGADO: ningun trazo llega a IndexedDB (se lee la base) y la recarga recupera campos y firmantes, pero las firmas se piden de nuevo.
 *  - (p3...) ENCENDIDO: trazos guardados con fecha de caducidad a los 7 dias; lo caducado se purga; sin trazos nada caduca.
 *  - (p5...) tras DESCARGAR, la casilla «Borrar el borrador de esta firma» (marcada) borra la sesion / el documento; desmarcada lo conserva.
 *  - (e1...) «E-sign · Pedir firma por email»: deshabilitada, sin accion, accesible, 44 px y sin romper el layout.
 *  - axe y textos ES/EN en claro/oscuro, a 1280 y 375 px.
 *
 * Para correrlas (Chromium y, con `PW_BROWSERS=webkit-ipad`, el iPad):
 *   PW_PORT=3841 npx playwright test sign-privacy --project=chromium
 *
 * Headless siempre (modo por defecto de Playwright).
 */

const AXE_PATH = require.resolve("axe-core/axe.min.js");

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(180_000);

const FLAGS_KEY = "optimuspdf.signPdf.featureFlags";
const ZIP_NAME = "Firmados - 2 documentos.zip";
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Ayudas
 * ------------------------------------------------------------------ */

/** Siembra `localStorage` ANTES de que cargue la pagina y UNA sola vez por pestana (una recarga no vuelve a pisarlo). */
async function seedLocalStorage(page: Page, entries: Record<string, string>): Promise<void> {
  await page.addInitScript((data) => {
    if (window.sessionStorage.getItem("__seeded")) return;
    for (const [key, value] of Object.entries(data)) window.localStorage.setItem(key, value);
    window.sessionStorage.setItem("__seeded", "1");
  }, entries);
}

/** «Guardar tambien las firmas recogidas» apagado ANTES de entrar (lo que haria Ajustes). */
async function signaturesOff(page: Page): Promise<void> {
  await seedLocalStorage(page, { [FLAGS_KEY]: JSON.stringify({ signaturesInDraft: false }) });
}

type RawDrafts = {
  sessions: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  documents: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  files: string[];
};

/** Lo que HAY en IndexedDB (la base real del navegador), saltandose la aplicacion. */
async function readDrafts(page: Page): Promise<RawDrafts> {
  return page.evaluate(
    () =>
      new Promise<RawDrafts>((resolve) => {
        const empty: RawDrafts = { sessions: [], documents: [], files: [] };
        const request = indexedDB.open("optimuspdf-sign-drafts");
        request.onerror = () => resolve(empty);
        request.onsuccess = () => {
          const db = request.result;
          const names = ["sessionMeta", "draftMeta", "draftFiles"].filter((name) => db.objectStoreNames.contains(name));
          if (names.length < 3) {
            db.close();
            resolve(empty);
            return;
          }
          const tx = db.transaction(names, "readonly");
          const sessions = tx.objectStore("sessionMeta").getAll();
          const documents = tx.objectStore("draftMeta").getAll();
          const files = tx.objectStore("draftFiles").getAllKeys();
          tx.oncomplete = () => {
            db.close();
            resolve({ sessions: sessions.result, documents: documents.result, files: files.result as string[] });
          };
          tx.onerror = () => {
            db.close();
            resolve(empty);
          };
        };
      }),
  );
}

/** Reescribe fechas de los borradores guardados (`savedAt` / `expiresAt`), como si hubiera pasado el tiempo. */
async function rewriteDraftDates(page: Page, patch: { savedAt?: string; expiresAt?: string | null }): Promise<void> {
  await page.evaluate(
    (changes) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("optimuspdf-sign-drafts");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["sessionMeta", "draftMeta"], "readwrite");
          for (const name of ["sessionMeta", "draftMeta"]) {
            const store = tx.objectStore(name);
            const all = store.getAll();
            all.onsuccess = () => {
              for (const row of all.result as Array<Record<string, unknown>>) {
                const next: Record<string, unknown> = { ...row };
                if (changes.savedAt !== undefined) next.savedAt = changes.savedAt;
                if (changes.expiresAt === null) delete next.expiresAt;
                else if (changes.expiresAt !== undefined) next.expiresAt = changes.expiresAt;
                store.put(next);
              }
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    patch,
  );
}

/** ¿Algun trazo (imagen de firma) en toda la base? Los trazos son PNG en `data:` URL. */
function hasStrokeImages(raw: RawDrafts): boolean {
  return JSON.stringify([raw.sessions, raw.documents]).includes("data:image");
}

/** axe-core sobre un trozo de la pagina (reglas WCAG 2.x A/AA con contraste real): devuelve las violaciones. */
async function axeViolations(page: Page, selector: string): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
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
}

/** Sin desbordamiento horizontal de la pagina. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "la pagina no se desborda en horizontal").toBeLessThanOrEqual(1);
}

const NOTICE_SWITCH = { es: "Guardar también las firmas recogidas para no perderlas", en: "Also save the signatures collected so they are not lost" } as const;
const DELETE_LABEL = {
  es: "Borrar el borrador de esta firma (incluye las firmas guardadas en él)",
  en: "Delete the draft of this signing (includes the signatures saved in it)",
} as const;

/** Recoge todas las firmas, deja el borrador asentado y llega a la pantalla de resultado (ZIP de 2 documentos). */
async function reachResultScreen(page: Page, docs: readonly SyntheticDoc[]): Promise<void> {
  await collectAllSignatures(page, docs);
  await waitForDraftSettled(page);
  await page.getByRole("button", { name: "Firmar y descargar" }).click();
  await expect(page.getByText(ZIP_NAME)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible();
}

/* ------------------------------------------------------------------ *
 * U0.4 · aviso e interruptor
 * ------------------------------------------------------------------ */

test.describe("el interruptor «Guardar también las firmas recogidas»", () => {
  test("(p1) primer uso: el aviso trae el interruptor ENCENDIDO; apagarlo cambia el texto y queda en Ajustes (y viceversa)", async ({ page }) => {
    await openSignAndUpload(page, await makeTwoDocs());
    await page.getByRole("tab", { name: "Varios firmantes" }).click();

    const toggle = page.getByRole("checkbox", { name: NOTICE_SWITCH.es });
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
    await expect(page.getByText("Solo en este dispositivo; se borran a los 7 días.")).toBeVisible();
    await expect(page.getByText(/Las firmas ya recogidas se guardan también en el borrador/)).toBeVisible();

    await page.getByText(NOTICE_SWITCH.es, { exact: true }).click();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText(/Las firmas ya recogidas no se guardan en el borrador: si lo retomas, se piden de nuevo/)).toBeVisible();
    await expect(page.getByText(/Las firmas ya recogidas se guardan también en el borrador/)).toHaveCount(0);

    // El MISMO ajuste en Ajustes, persistido.
    await page.goto("/settings");
    const setting = page.getByRole("checkbox", { name: "Guardar las firmas recogidas en el borrador" });
    await expect(setting).not.toBeChecked();
    await page.getByText("Guardar las firmas recogidas en el borrador", { exact: true }).click();
    await expect(setting).toBeChecked();
    await page.reload();
    await expect(setting).toBeChecked();

    // Y de vuelta en Firmar el interruptor del aviso (abierto de nuevo con «Cómo usamos tus datos») sigue encendido.
    await openSignAndUpload(page, await makeTwoDocs());
    await page.getByRole("tab", { name: "Varios firmantes" }).click();
    const privacyToggle = page.getByRole("button", { name: "Cómo usamos tus datos" });
    if ((await privacyToggle.getAttribute("aria-expanded")) !== "true") await privacyToggle.click();
    await expect(page.getByRole("checkbox", { name: NOTICE_SWITCH.es })).toBeChecked();
  });

  test("(p1b) en ingles: el interruptor, su nota y Ajustes salen en ingles, sin claves crudas", async ({ page }) => {
    await seedLocalStorage(page, { "optimuspdf.language": "en" });
    await openSignAndUpload(page, await makeTwoDocs());
    await page.getByRole("tab", { name: "Several signers" }).click();
    await expect(page.getByRole("checkbox", { name: NOTICE_SWITCH.en })).toBeChecked();
    await expect(page.getByText("Only on this device; deleted after 7 days.")).toBeVisible();
    await expect(page.getByText(/Signatures already collected are also saved in the draft/)).toBeVisible();
    await page.goto("/settings");
    await expect(page.getByRole("checkbox", { name: "Save collected signatures in the draft" })).toBeChecked();
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/signaturesInDraft|draftPrivacy|noticeSignatures|undefined|\[object/);
  });
});

test.describe("con el interruptor APAGADO el borrador guarda todo menos las firmas", () => {
  test("(p2) no hay trazos en IndexedDB; la recarga recupera documentos, firmantes y huecos, pero las firmas se piden de nuevo", async ({ page }) => {
    await signaturesOff(page);
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await waitForDraftSettled(page);

    const raw = await readDrafts(page);
    expect(raw.sessions).toHaveLength(1);
    const [session] = raw.sessions;
    // La base REAL del navegador: ninguna imagen de firma, en ningun sitio.
    expect(hasStrokeImages(raw), "ningun trazo en IndexedDB").toBe(false);
    expect(await draftedStrokeCount(page)).toBe(0);
    expect(session.blocks.length).toBeGreaterThan(0);
    for (const block of session.blocks) {
      expect(block.signature).toBeNull();
      expect(block.initials).toBeNull();
      expect(block.stamps).toEqual({});
    }
    expect(session.signaturesOmitted).toBe(true);
    expect(session.expiresAt, "sin trazos no hay caducidad").toBeUndefined();
    // Todo lo demas SI se guardo: documentos, firmantes y huecos.
    expect(session.documents.map((doc: { fileName: string }) => doc.fileName)).toEqual(docs.map((doc) => doc.name));
    expect(session.signers.map((signer: { name: string }) => signer.name)).toEqual([SIGNER_1, SIGNER_2]);
    const fieldCounts = Object.values(session.docStates as Record<string, { fields: unknown[] }>).map((state) => state.fields.length);
    expect(fieldCounts).toEqual([2, 2]);
    expect(raw.files.sort()).toEqual([`${session.id}/${session.documents[0].id}`, `${session.id}/${session.documents[1].id}`].sort());

    // Recarga: vuelve el trabajo (documentos, firmantes, huecos) y SE PIDEN LAS FIRMAS de nuevo.
    await page.reload();
    for (const [index, doc] of docs.entries()) {
      await expect(page.getByRole("button", { name: `${index + 1}. ${doc.name}` })).toBeVisible();
    }
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1);
    await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2);
    await page.getByRole("button", { name: "2. Documento" }).click();
    await expect(page.getByText("En este documento: 2 huecos").first()).toBeVisible();
    await page.getByRole("button", { name: "3. Firmar" }).click();
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toHaveCount(0);
    await expect(turnCounter(page)).toHaveText("Turno 1 de 2");
    await expect(handoffHeading(page, SIGNER_1)).toBeVisible();
    // Sin firmas no se puede entregar: el boton existe pero esta apagado.
    await expect(page.getByRole("button", { name: "Firmar y descargar" })).toBeDisabled();
  });

  test("(p2b) la tarjeta de entrada dice «Firmas: se volverán a pedir» y retomar pide las firmas desde el principio", async ({ page }) => {
    await signaturesOff(page);
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await waitForDraftSettled(page);
    await leaveWithBrowserBack(page);
    await page.goto("/sign-pdf");
    const card = page.locator("[data-resume-card]");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("Firmas: se volverán a pedir");
    await expect(card).not.toContainText("pendiente");
    await card.getByRole("button", { name: "Retomar" }).click();
    await page.getByRole("button", { name: "3. Firmar" }).click();
    await expect(turnCounter(page)).toHaveText("Turno 1 de 2");
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toHaveCount(0);
  });

  test("(p2c) apagarlo con las firmas ya guardadas las quita de IndexedDB al instante", async ({ page }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(4);
    expect(hasStrokeImages(await readDrafts(page))).toBe(true);
    // Apaga el ajuste desde el propio aviso de privacidad (abierto con «Cómo usamos tus datos»).
    const privacyToggle = page.getByRole("button", { name: "Cómo usamos tus datos" });
    if ((await privacyToggle.getAttribute("aria-expanded")) !== "true") await privacyToggle.click();
    await page.getByText(NOTICE_SWITCH.es, { exact: true }).click();
    await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(0);
    expect(hasStrokeImages(await readDrafts(page)), "ningun trazo en la base tras apagarlo").toBe(false);
    // El trabajo en pantalla sigue entero (no se pierde nada de lo que ya se ve).
    await expectCollectedWorkRestored(page, docs);
  });

  test("(p2d) con UN documento el borrador del documento tampoco lleva trazos", async ({ page }) => {
    await signaturesOff(page);
    const [only] = await makeTwoDocs();
    await openSignAndUpload(page, [only]);
    await defineSigners(page);
    await placeSlotsInSingleDocument(page);
    await continueToSign(page);
    await signWholeTurn(page, 1, 10, false);
    await signWholeTurn(page, 1, 20, true);
    await expect.poll(() => singleDraftCount(page), { timeout: 15_000 }).toBe(1);
    // Con la ronda entera firmada, «sin escritura pendiente» (el navegador ya no pregunta al cerrar) = el borrador esta al dia.
    await expect.poll(() => beforeUnloadPrevented(page), { timeout: 15_000 }).toBe(false);
    const raw = await readDrafts(page);
    expect(hasStrokeImages(raw), "ningun trazo en IndexedDB").toBe(false);
    expect(raw.documents[0].captures).toEqual({});
    expect(raw.documents[0].signaturesOmitted).toBe(true);
    expect(raw.documents[0].signers.map((signer: { name: string }) => signer.name)).toEqual([SIGNER_1, SIGNER_2]);
  });
});

/* ------------------------------------------------------------------ *
 * U0.4 · caducidad
 * ------------------------------------------------------------------ */

test.describe("caducidad a los 7 dias", () => {
  test("(p3) con el interruptor encendido las firmas se guardan y el borrador caduca 7 dias despues de guardarse", async ({ page }) => {
    await collectAllSignatures(page, await makeTwoDocs());
    await expect.poll(() => draftedStrokeCount(page), { timeout: 15_000 }).toBe(4);
    await waitForDraftSettled(page);
    const raw = await readDrafts(page);
    expect(hasStrokeImages(raw)).toBe(true);
    const [session] = raw.sessions;
    expect(session.signaturesOmitted).toBeUndefined();
    expect(typeof session.expiresAt).toBe("string");
    expect(Date.parse(session.expiresAt) - Date.parse(session.savedAt)).toBe(7 * DAY_MS);
  });

  test("(p4) un borrador con firmas caducado se purga al abrir la herramienta (con todos sus bytes); uno vigente se conserva", async ({ page }) => {
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await waitForDraftSettled(page);
    await leaveWithBrowserBack(page);

    // Vigente: queda un minuto de plazo -> se ofrece.
    await rewriteDraftDates(page, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await page.goto("/sign-pdf");
    await expect(page.locator("[data-resume-card]")).toBeVisible({ timeout: 10_000 });
    expect(await sessionDraftCount(page)).toBe(1);

    // Caducado: paso hace un minuto -> no se ofrece y desaparece de la base, bytes incluidos.
    await rewriteDraftDates(page, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await page.goto("/sign-pdf");
    await expect(page.getByRole("button", { name: "Ver borradores" })).toBeVisible();
    await expect(page.locator("[data-resume-card]")).toHaveCount(0);
    await expect.poll(() => sessionDraftCount(page), { timeout: 10_000 }).toBe(0);
    const raw = await readDrafts(page);
    expect(raw.files, "sin PDF huerfanos").toEqual([]);
    expect(hasStrokeImages(raw)).toBe(false);
    await expect(page.getByRole("button", { name: "Ver borradores" })).not.toContainText(/\d/);
  });

  test("(p4b) un borrador SIN firmas guardadas no caduca por antiguo que sea", async ({ page }) => {
    await signaturesOff(page);
    const docs = await makeTwoDocs();
    await collectAllSignatures(page, docs);
    await waitForDraftSettled(page);
    await leaveWithBrowserBack(page);
    await rewriteDraftDates(page, { savedAt: new Date(Date.now() - 60 * DAY_MS).toISOString() });
    await page.goto("/sign-pdf");
    await expect(page.locator("[data-resume-card]")).toBeVisible({ timeout: 10_000 });
    expect(await sessionDraftCount(page)).toBe(1);
  });

  test("(p4c) Recientes tampoco ofrece lo caducado en «Sin terminar»", async ({ page }) => {
    await collectAllSignatures(page, await makeTwoDocs());
    await waitForDraftSettled(page);
    await leaveWithBrowserBack(page);
    await page.goto("/recent");
    await expect(page.locator("[data-recent-unfinished]")).toBeVisible({ timeout: 10_000 });
    await rewriteDraftDates(page, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await page.goto("/recent");
    await expect(page.getByRole("heading", { name: "Recientes" })).toBeVisible();
    await expect(page.locator("[data-recent-unfinished]")).toHaveCount(0);
    expect(await sessionDraftCount(page)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * U0.4 · borrar el borrador al descargar
 * ------------------------------------------------------------------ */

test.describe("«Borrar el borrador de esta firma» al descargar", () => {
  test("(p5) ZIP de 2 documentos: la casilla sale MARCADA; al descargar se borra la sesion y la tarjeta ya no ofrece la ronda entregada", async ({ page }) => {
    await reachResultScreen(page, await makeTwoDocs());
    const box = page.getByRole("checkbox", { name: DELETE_LABEL.es });
    await expect(box).toBeVisible();
    await expect(box).toBeChecked();
    // Aun no se descargo: el borrador sigue ahi (no se borra al aparecer la pantalla).
    expect(await sessionDraftCount(page)).toBe(1);

    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // F0-fix (D5): el borrado NO es instantaneo (la pagina no puede saber si el archivo llego, sobre todo en iPad): se avisa con
    // «Deshacer» y el borrador sigue ahi unos segundos.
    await expect(page.getByText(/El borrador se borrará en unos segundos/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Deshacer" })).toBeVisible();
    expect(await sessionDraftCount(page)).toBe(1);
    await expect(page.getByText("Borrador borrado de este dispositivo.")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sessionDraftCount(page), { timeout: 10_000 }).toBe(0);
    const raw = await readDrafts(page);
    expect(raw.files, "ni los PDF del borrador quedan").toEqual([]);
    expect(hasStrokeImages(raw)).toBe(false);

    // La tarjeta de entrada no ofrece la ronda ya entregada, ni «Ver borradores» la cuenta, ni Recientes la lista como sin terminar.
    await page.goto("/sign-pdf");
    await expect(page.getByRole("button", { name: "Ver borradores" })).toBeVisible();
    await expect(page.locator("[data-resume-card]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ver borradores" })).not.toContainText(/\d/);
    await page.goto("/recent");
    await expect(page.getByRole("heading", { name: "Recientes" })).toBeVisible();
    await expect(page.locator("[data-recent-unfinished]")).toHaveCount(0);
  });

  test("(p5b) «Deshacer» tras descargar (F0-fix D5): el borrador se conserva aunque pase el plazo, y una descarga posterior ya no lo borra", async ({ page }) => {
    await reachResultScreen(page, await makeTwoDocs());
    await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    const undo = page.getByRole("button", { name: "Deshacer" });
    await expect(undo).toBeVisible();
    const box = await undo.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await undo.click();
    await expect(page.getByText("Listo: el borrador se conserva.")).toBeVisible();
    // Pasado de sobra el plazo de borrado: el borrador sigue y nunca se anuncio «borrado».
    await page.waitForTimeout(9500);
    expect(await sessionDraftCount(page)).toBe(1);
    await expect(page.getByText("Borrador borrado de este dispositivo.")).toHaveCount(0);
    // Descargar otra vez ya no lo borra (la casilla quedo desmarcada).
    await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    await page.waitForTimeout(9500);
    expect(await sessionDraftCount(page)).toBe(1);
  });

  test("(p5c) F0-fix2 N1: DESMARCAR la casilla durante la espera cancela el borrado (sin pulsar «Deshacer»); volver a marcarla empieza la espera de nuevo", async ({ page }) => {
    await reachResultScreen(page, await makeTwoDocs());
    await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    await expect(page.getByText(/El borrador se borrará en unos segundos/)).toBeVisible();
    const box = page.getByRole("checkbox", { name: DELETE_LABEL.es });
    // Durante la espera se desmarca la casilla: se anuncia por la region viva y ya no hay nada que deshacer.
    await page.getByText(DELETE_LABEL.es, { exact: true }).click();
    await expect(box).not.toBeChecked();
    const status = page.locator("[data-delete-draft-status]");
    await expect(status).toHaveText("El borrador se conserva (se borra solo a los 7 días).");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("[data-delete-draft] [role=status]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Deshacer" })).toHaveCount(0);
    // Pasado de sobra el plazo (8 s): el borrador sigue, con sus firmas, y nunca se anuncio «borrado».
    await page.waitForTimeout(9500);
    expect(await sessionDraftCount(page)).toBe(1);
    expect(hasStrokeImages(await readDrafts(page)), "las firmas siguen en el borrador conservado").toBe(true);
    await expect(page.getByText("Borrador borrado de este dispositivo.")).toHaveCount(0);

    // Volver a marcarla: la espera empieza de NUEVO (8 s desde ahora, con «Deshacer») y entonces si se borra.
    await page.getByText(DELETE_LABEL.es, { exact: true }).click();
    await expect(box).toBeChecked();
    await expect(status).toHaveText(/El borrador se borrará en unos segundos/);
    await expect(page.getByRole("button", { name: "Deshacer" })).toBeVisible();
    const remarkedAt = Date.now();
    await page.waitForTimeout(4500);
    expect(await sessionDraftCount(page), "a mitad de la espera nueva aun no se borro").toBe(1);
    await expect(page.getByText("Borrador borrado de este dispositivo.")).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - remarkedAt, "no antes de ~8 s tras volver a marcarla").toBeGreaterThanOrEqual(7000);
    await expect.poll(() => sessionDraftCount(page), { timeout: 10_000 }).toBe(0);
    expect((await readDrafts(page)).files).toEqual([]);
  });

  test("(p5d) F0-fix2 N1: tras desmarcar durante la espera, descargar otra vez NO borra; «Deshacer» sigue funcionando y deja la casilla desmarcada", async ({ page }) => {
    await reachResultScreen(page, await makeTwoDocs());
    await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    await page.getByText(DELETE_LABEL.es, { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: DELETE_LABEL.es })).not.toBeChecked();
    await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    await page.waitForTimeout(9500);
    expect(await sessionDraftCount(page)).toBe(1);

    // Marcar de nuevo y ahora «Deshacer»: se conserva y la casilla queda desmarcada.
    await page.getByText(DELETE_LABEL.es, { exact: true }).click();
    await expect(page.getByRole("button", { name: "Deshacer" })).toBeVisible();
    await page.getByRole("button", { name: "Deshacer" }).click();
    await expect(page.locator("[data-delete-draft-status]")).toHaveText("Listo: el borrador se conserva.");
    await expect(page.getByRole("checkbox", { name: DELETE_LABEL.es })).not.toBeChecked();
    await page.waitForTimeout(9500);
    expect(await sessionDraftCount(page)).toBe(1);
  });

  test("(p6) con la casilla DESMARCADA, descargar conserva el borrador (con su caducidad) y la tarjeta lo sigue ofreciendo", async ({ page }) => {
    await reachResultScreen(page, await makeTwoDocs());
    await page.getByText(DELETE_LABEL.es, { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: DELETE_LABEL.es })).not.toBeChecked();
    await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    await page.waitForTimeout(1500);
    expect(await sessionDraftCount(page)).toBe(1);
    await expect(page.getByText("Borrador borrado de este dispositivo.")).toHaveCount(0);
    const [session] = (await readDrafts(page)).sessions;
    expect(typeof session.expiresAt).toBe("string");
    await leaveWithBrowserBack(page);
    await page.goto("/sign-pdf");
    await expect(page.locator("[data-resume-card]")).toBeVisible({ timeout: 10_000 });
  });

  test("(p6b) irse SIN descargar (Empezar de nuevo) no borra nada: la ronda no se entrego", async ({ page }) => {
    await reachResultScreen(page, await makeTwoDocs());
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await page.waitForTimeout(1500);
    expect(await sessionDraftCount(page)).toBe(1);
  });

  test("(p7) UN documento: al descargar se borra el borrador del documento suelto", async ({ page }) => {
    const [only] = await makeTwoDocs();
    await openSignAndUpload(page, [only]);
    await defineSigners(page);
    await placeSlotsInSingleDocument(page);
    await continueToSign(page);
    await signWholeTurn(page, 1, 10, false);
    await signWholeTurn(page, 1, 20, true);
    await expect.poll(() => singleDraftCount(page), { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => Object.keys((await readDrafts(page)).documents[0]?.captures ?? {}).length, { timeout: 15_000 }).toBe(2);
    await page.getByRole("button", { name: "Firmar y descargar" }).click();
    await page.getByRole("button", { name: "No, dejar el nombre como está" }).click();
    await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("checkbox", { name: DELETE_LABEL.es })).toBeChecked();
    expect(await singleDraftCount(page)).toBe(1);

    await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    await expect(page.getByText("Borrador borrado de este dispositivo.")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => singleDraftCount(page), { timeout: 10_000 }).toBe(0);
    expect((await readDrafts(page)).files).toEqual([]);
    await page.goto("/sign-pdf");
    await expect(page.locator("[data-resume-card]")).toHaveCount(0);
  });

  test("(p8) «Solo yo» no guarda borrador: no hay casilla de borrado en su resultado", async ({ page }) => {
    const [only] = await makeTwoDocs();
    await openSignAndUpload(page, [only]);
    // Por defecto la herramienta arranca en «Solo yo»: se crea una firma escrita y se coloca sola en la pagina visible.
    await page.locator('img[alt]:not([alt=""])').first().waitFor();
    await page.getByRole("button", { name: "Crear firma" }).first().click();
    await page.getByRole("tab", { name: "Escribir" }).click();
    await page.locator("#signature-typed").fill("Ana");
    await page.getByRole("button", { name: "Usar esta firma" }).click();
    await expect(page.getByRole("group", { name: /firma colocada/i }).first()).toBeVisible({ timeout: 15_000 });
    const run = page.getByRole("button", { name: "Procesar" }).first();
    await expect(run).toBeEnabled({ timeout: 15_000 });
    await run.click();
    await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("checkbox", { name: /Borrar el borrador/ })).toHaveCount(0);
    // La opcion «E-sign» SI esta (solo visual).
    await expect(page.locator("[data-download-extras] [data-esign-teaser]")).toBeVisible();
    expect(sessionParam(page)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * F0-fix2 (N2) · «Quitar ahora las firmas de los borradores guardados»
 * ------------------------------------------------------------------ */

const STRIP_BUTTON = {
  es: "Quitar ahora las firmas de los borradores guardados",
  en: "Remove the signatures from saved drafts now",
} as const;
const STRIP_TITLE = { es: "¿Quitar las firmas de los borradores guardados?", en: "Remove the signatures from saved drafts?" } as const;
const STRIP_CONFIRM = { es: "Quitar las firmas", en: "Remove signatures" } as const;
const STRIP_DONE = {
  es: "Listo: ya no queda ninguna firma en los borradores guardados.",
  en: "Done: no signature is left in the saved drafts.",
} as const;

/** TODOS los almacenes del origen (cada base de IndexedDB, localStorage y sessionStorage): donde hay una imagen de firma (`data:image`). */
async function scanAllStores(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const hits: string[] = [];
    const looksLikeStroke = (text: string) => text.includes("data:image/png") || text.includes("data:image/jpeg");
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index) as string;
        if (looksLikeStroke(store.getItem(key) ?? "")) hits.push(`web-storage:${key}`);
      }
    }
    const databases = (await (indexedDB as unknown as { databases?: () => Promise<Array<{ name?: string }>> }).databases?.()) ?? [];
    for (const info of databases) {
      if (!info.name) continue;
      await new Promise<void>((resolve) => {
        const request = indexedDB.open(info.name as string);
        request.onerror = () => resolve();
        request.onsuccess = () => {
          const db = request.result;
          const names = Array.from(db.objectStoreNames);
          let pending = names.length;
          if (pending === 0) {
            db.close();
            resolve();
            return;
          }
          for (const name of names) {
            const all = db.transaction(name, "readonly").objectStore(name).getAll();
            const finish = () => {
              pending -= 1;
              if (pending === 0) {
                db.close();
                resolve();
              }
            };
            all.onsuccess = () => {
              for (const value of all.result) {
                let text = "";
                try {
                  const isBytes = value instanceof Uint8Array || (value && value.bytes instanceof Uint8Array && Object.keys(value).length <= 2);
                  text = isBytes ? "" : JSON.stringify(value);
                } catch {
                  text = "";
                }
                if (looksLikeStroke(text)) hits.push(`idb:${info.name}/${name}`);
              }
              finish();
            };
            all.onerror = finish;
          }
        };
      });
    }
    return Array.from(new Set(hits));
  });
}

/** Un borrador de UN documento con firmas y, aparte, una sesion de dos documentos con las cuatro firmas: ambos con trazos. */
async function seedDocumentAndSessionDrafts(page: Page): Promise<void> {
  const [only] = await makeTwoDocs();
  // Empieza desde Inicio para que el «Atras» del navegador tenga a donde volver.
  await page.goto("/");
  await openSignAndUpload(page, [only]);
  await defineSigners(page);
  await placeSlotsInSingleDocument(page);
  await continueToSign(page);
  await signWholeTurn(page, 1, 10, false);
  await signWholeTurn(page, 1, 20, true);
  await expect.poll(async () => Object.keys((await readDrafts(page)).documents[0]?.captures ?? {}).length, { timeout: 15_000 }).toBe(2);
  await page.waitForTimeout(1500);
  await leaveWithBrowserBack(page);
  await collectAllSignatures(page, await makeTwoDocs());
  await waitForDraftSettled(page);
  await leaveWithBrowserBack(page);
}

test.describe("F0-fix2 N2 · quitar ahora las firmas de los borradores guardados", () => {
  test("(n2-a) en Ajustes, junto al interruptor: apagarlo NO purga lo guardado; el boton, con confirmacion, deja CERO trazos en TODOS los almacenes y conserva el resto", async ({ page }) => {
    await seedDocumentAndSessionDrafts(page);
    const before = await readDrafts(page);
    expect(before.sessions).toHaveLength(1);
    expect(before.documents).toHaveLength(1);
    expect(hasStrokeImages(before)).toBe(true);

    await page.goto("/settings");
    // Apagar el interruptor: el hallazgo original, los borradores ya guardados conservan sus firmas.
    await page.getByText("Guardar las firmas recogidas en el borrador", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Guardar las firmas recogidas en el borrador" })).not.toBeChecked();
    await page.waitForTimeout(800);
    expect(hasStrokeImages(await readDrafts(page)), "apagar el interruptor no purga lo ya guardado").toBe(true);
    await expect(page.getByText(/Los borradores ya guardados conservan sus firmas hasta que caduquen o las quites/)).toBeVisible();

    const button = page.getByRole("button", { name: STRIP_BUTTON.es });
    await expect(button).toBeVisible();
    await expectTouchTarget(button, "boton");
    // Cancelar no toca nada.
    await button.click();
    const dialog = page.getByRole("dialog", { name: STRIP_TITLE.es });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toHaveCount(0);
    expect(hasStrokeImages(await readDrafts(page))).toBe(true);
    // Confirmar quita las firmas.
    await button.click();
    await page.getByRole("dialog", { name: STRIP_TITLE.es }).getByRole("button", { name: STRIP_CONFIRM.es }).click();
    await expect(page.locator("[data-strip-signatures-status]")).toHaveText(STRIP_DONE.es);

    const after = await readDrafts(page);
    expect(hasStrokeImages(after)).toBe(false);
    expect(await scanAllStores(page), "ningun trazo en ningun almacen (IndexedDB de todas las bases, localStorage, sessionStorage)").toEqual([]);
    // El resto del borrador se conserva: documentos, firmantes, huecos, archivos.
    const [sessionBefore] = before.sessions;
    const [sessionAfter] = after.sessions;
    expect(sessionAfter.documents).toEqual(sessionBefore.documents);
    expect(sessionAfter.signers).toEqual(sessionBefore.signers);
    expect(sessionAfter.docStates).toEqual(sessionBefore.docStates);
    expect(sessionAfter.blocks.map((block: { signerId: string; appliesTo: string[] }) => [block.signerId, block.appliesTo])).toEqual(
      sessionBefore.blocks.map((block: { signerId: string; appliesTo: string[] }) => [block.signerId, block.appliesTo]),
    );
    for (const block of sessionAfter.blocks) {
      expect(block.signature).toBeNull();
      expect(block.initials).toBeNull();
      expect(block.stamps).toEqual({});
    }
    expect(sessionAfter.signaturesOmitted).toBe(true);
    expect(sessionAfter.expiresAt).toBeUndefined();
    const [docBefore] = before.documents;
    const [docAfter] = after.documents;
    expect(docAfter.captures).toEqual({});
    expect(docAfter.signaturesOmitted).toBe(true);
    expect(docAfter.expiresAt).toBeUndefined();
    expect(docAfter.signers).toEqual(docBefore.signers);
    expect(docAfter.fields).toEqual(docBefore.fields);
    expect(docAfter.fileName).toBe(docBefore.fileName);
    expect(after.files.sort(), "los PDF no se tocan").toEqual(before.files.sort());
    // Respeta la version: ni rev ni writerId ni fecha de guardado cambian.
    for (const [a, b] of [[sessionBefore, sessionAfter], [docBefore, docAfter]] as const) {
      expect(b.rev).toBe(a.rev);
      expect(b.writerId).toBe(a.writerId);
      expect(b.savedAt).toBe(a.savedAt);
    }
    // Retomarlo pide las firmas de nuevo.
    await page.goto("/sign-pdf");
    await expect(page.locator("[data-resume-card]")).toContainText("Firmas: se volverán a pedir", { timeout: 15_000 });
  });

  test("(n2-b) en el aviso de privacidad de Firmar: mismo boton, misma confirmacion y mismo resultado (EN: textos en ingles)", async ({ page }) => {
    await seedLocalStorage(page, { "optimuspdf.language": "en" });
    // El borrador con firmas se prepara en espanol? No: la ceremonia usa rotulos en espanol, asi que se siembra directo en IndexedDB.
    await page.goto("/sign-pdf");
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("optimuspdf-sign-drafts", 2);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("draftFiles")) db.createObjectStore("draftFiles", { keyPath: "id" });
            if (!db.objectStoreNames.contains("draftMeta")) db.createObjectStore("draftMeta", { keyPath: "id" });
            if (!db.objectStoreNames.contains("sessionMeta")) db.createObjectStore("sessionMeta", { keyPath: "id" });
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(["draftFiles", "draftMeta"], "readwrite");
            tx.objectStore("draftFiles").put({ id: "d-sembrado", bytes: new Uint8Array([37, 80, 68, 70]) });
            tx.objectStore("draftMeta").put({
              id: "d-sembrado",
              fingerprint: "a".repeat(64),
              fileName: "sembrado.pdf",
              fileSize: 4,
              savedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
              mode: "multi",
              signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }],
              fields: [],
              textFields: [],
              textValues: {},
              step: "signers",
              captures: { f: { signature: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 }, initials: null, stamp: "x" } },
              textFieldsDetectedFor: null,
              rev: 3,
              writerId: "t-otra",
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    expect(hasStrokeImages(await readDrafts(page))).toBe(true);
    await page.reload();
    await uploadDocs(page, await makeTwoDocs());
    await page.getByRole("tab", { name: "Several signers" }).click();
    const notice = page.locator(".surface-card:has(input[type=checkbox])");
    await expect(notice).toBeVisible();
    const button = notice.getByRole("button", { name: STRIP_BUTTON.en });
    await expect(button).toBeVisible();
    await expectTouchTarget(button, "boton");
    await button.click();
    const dialog = page.getByRole("dialog", { name: STRIP_TITLE.en });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: STRIP_CONFIRM.en }).click();
    await expect(notice.locator("[data-strip-signatures-status]")).toHaveText(STRIP_DONE.en);
    const raw = await readDrafts(page);
    expect(hasStrokeImages(raw)).toBe(false);
    expect(await scanAllStores(page)).toEqual([]);
    expect(raw.documents[0].rev).toBe(3);
    expect(raw.documents[0].writerId).toBe("t-otra");
    expect(raw.documents[0].fileName).toBe("sembrado.pdf");
    expect(raw.files).toEqual(["d-sembrado"]);
  });

  test("(n2-c) sin firmas guardadas el boton lo dice y no toca nada", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: STRIP_BUTTON.es }).click();
    await page.getByRole("dialog", { name: STRIP_TITLE.es }).getByRole("button", { name: STRIP_CONFIRM.es }).click();
    await expect(page.locator("[data-strip-signatures-status]")).toHaveText("No hay firmas guardadas en los borradores.");
  });
});

/* ------------------------------------------------------------------ *
 * U0.7 · «E-sign» deshabilitada
 * ------------------------------------------------------------------ */

const TEASER = { es: "E-sign · Pedir firma por email Próximamente", en: "E-sign · Request signature by email Soon" } as const;

function teaserIn(page: Page, scope: string): Locator {
  return page.locator(`${scope} [data-esign-teaser] button`);
}

test.describe("«E-sign» deshabilitada y sin accion", () => {
  test("(e1) en la cabecera de Firmar: deshabilitada para el lector, enfocable, 44 px, y tocarla no hace nada", async ({ page }) => {
    // Peticiones de datos (fetch / XHR / ping / documento): las de carga de recursos del PDF no cuentan.
    const requests: string[] = [];
    page.on("request", (request) => {
      if (["fetch", "xhr", "ping", "document", "websocket", "eventsource"].includes(request.resourceType())) requests.push(request.url());
    });
    await openSignAndUpload(page, await makeTwoDocs());
    await page.locator('img[alt]:not([alt=""])').first().waitFor();
    await page.waitForLoadState("networkidle");
    const teaser = page.getByRole("button", { name: TEASER.es });
    await expect(teaser).toBeVisible();
    await expect(teaser).toHaveAttribute("aria-disabled", "true");
    await expect(teaser).toContainText("E-sign · Pedir firma por email");
    await expect(teaser).toContainText("Próximamente");
    await expect(teaser).toHaveAccessibleDescription("Disponible próximamente");
    await expectTouchTarget(teaser, "E-sign");

    const before = page.url();
    const countBefore = requests.length;
    const domBefore = await page.locator("[data-esign-teaser]").first().evaluate((node) => node.outerHTML);
    // `aria-disabled` hace que Playwright espere a que se «habilite»: se toca igual, como lo haria un dedo.
    await teaser.click({ force: true });
    await teaser.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await page.waitForTimeout(500);
    expect(page.url(), "no navega").toBe(before);
    expect(requests.length, "no hace ninguna peticion de red").toBe(countBefore);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.locator("[data-esign-teaser]").first().evaluate((node) => node.outerHTML)).toBe(domBefore);
    await expect(teaser).toBeFocused();
  });

  test("(e2) con el teclado se alcanza con Tab (esta en el orden de tabulacion) y muestra el foco", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "el WebKit tactil de Playwright no enfoca botones con Tab (ajuste de Safari «Tab resalta los controles»)");
    await openSignAndUpload(page, await makeTwoDocs());
    const teaser = page.getByRole("button", { name: TEASER.es });
    let focused = false;
    for (let press = 0; press < 60 && !focused; press += 1) {
      await page.keyboard.press("Tab");
      focused = await teaser.evaluate((node) => node === document.activeElement);
    }
    expect(focused, "Tab alcanza la opcion").toBe(true);
    const outline = await teaser.evaluate((node) => getComputedStyle(node).outlineStyle);
    expect(outline).not.toBe("none");
  });

  test("(e3) en la pantalla de resultado: dentro de la tarjeta, junto a «Descargar» y la casilla, y sin desbordar", async ({ page }) => {
    await reachResultScreen(page, await makeTwoDocs());
    const teaser = teaserIn(page, "[data-download-extras]");
    await expect(teaser).toBeVisible();
    await expect(teaser).toHaveAttribute("aria-disabled", "true");
    await expect(teaser).toContainText("Próximamente");
    await expectTouchTarget(teaser, "E-sign (resultado)");
    // Orden en la tarjeta: Descargar -> casilla -> E-sign.
    const order = await page.evaluate(() => {
      const download = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Descargar");
      const extras = document.querySelector("[data-download-extras]");
      const box = extras?.querySelector('input[type="checkbox"]');
      const esign = extras?.querySelector("[data-esign-teaser]");
      const before = (a: Element | null | undefined, b: Element | null | undefined) =>
        Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { downloadThenBox: before(download, box), boxThenEsign: before(box, esign) };
    });
    expect(order).toEqual({ downloadThenBox: true, boxThenEsign: true });
    // Tocarla no descarga, no navega ni cambia el borrador.
    const before = page.url();
    await teaser.click({ force: true });
    await page.waitForTimeout(400);
    expect(page.url()).toBe(before);
    expect(await sessionDraftCount(page)).toBe(1);
    await expectNoHorizontalOverflow(page);
  });

  test("(e4) en ingles: «E-sign · Request signature by email» + «Soon»", async ({ page }) => {
    await seedLocalStorage(page, { "optimuspdf.language": "en" });
    await openSignAndUpload(page, await makeTwoDocs());
    const teaser = page.getByRole("button", { name: TEASER.en });
    await expect(teaser).toBeVisible();
    await expect(teaser).toHaveAttribute("aria-disabled", "true");
    await expect(teaser).toHaveAccessibleDescription("Coming soon");
    expect(await page.locator("body").innerText()).not.toMatch(/esign\.|\.soon|undefined/);
  });

  test("(e5) a 375 x 812 el layout no se rompe: sin desbordamiento horizontal y el texto y la insignia caben", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, locale: "es-ES" });
    const page = await context.newPage();
    try {
      await openSignAndUpload(page, await makeTwoDocs());
      const teaser = page.getByRole("button", { name: TEASER.es });
      await expect(teaser).toBeVisible();
      await expectTouchTarget(teaser, "E-sign 375");
      await expectNoHorizontalOverflow(page);
      const box = await teaser.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      // La insignia no se sale del boton.
      const badge = teaser.locator("span", { hasText: "Próximamente" });
      const badgeBox = await badge.boundingBox();
      expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * axe + textos ES/EN, claro/oscuro, 1280 / 375
 * ------------------------------------------------------------------ */

type Theme = "light" | "dark";
type Language = "es" | "en";

async function newContext(browser: Browser, opts: { width: number; theme: Theme; language: Language }) {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.width < 600 ? 812 : 900 },
    colorScheme: opts.theme,
    hasTouch: opts.width < 600,
    locale: opts.language === "es" ? "es-ES" : "en-US",
  });
  // UNA sola vez por pestana: una recarga no pisa el idioma que la prueba cambie despues.
  await context.addInitScript(
    ([theme, language]) => {
      if (window.sessionStorage.getItem("__seeded")) return;
      window.localStorage.setItem("optimuspdf.theme", theme);
      window.localStorage.setItem("optimuspdf.language", language);
      window.sessionStorage.setItem("__seeded", "1");
    },
    [opts.theme, opts.language],
  );
  return context;
}

test.describe("axe: el boton «Quitar ahora las firmas» (F0-fix2, N2)", () => {
  for (const combo of [
    { theme: "light", language: "es", width: 1280 },
    { theme: "dark", language: "es", width: 375 },
    { theme: "dark", language: "en", width: 1280 },
    { theme: "light", language: "en", width: 375 },
  ] as const) {
    test(`(a3) ${combo.theme} · ${combo.language} · ${combo.width}px: en Ajustes y en el aviso, el boton y su confirmacion sin violaciones, 44 px y sin desbordar`, async ({ browser }) => {
      const context = await newContext(browser, { width: combo.width, theme: combo.theme, language: combo.language });
      const page = await context.newPage();
      try {
        // Aviso de privacidad de Firmar.
        await openSignAndUpload(page, await makeTwoDocs());
        await page.getByRole("tab", { name: combo.language === "es" ? "Varios firmantes" : "Several signers" }).click();
        const notice = page.locator(".surface-card:has(input[type=checkbox])");
        const noticeButton = notice.getByRole("button", { name: STRIP_BUTTON[combo.language] });
        await expect(noticeButton).toBeVisible();
        await expectTouchTarget(noticeButton, "boton del aviso");
        expect(await axeViolations(page, ".surface-card:has(input[type=checkbox])"), "aviso con el boton").toEqual([]);
        await expectNoHorizontalOverflow(page);
        await noticeButton.click();
        const noticeDialog = page.getByRole("dialog", { name: STRIP_TITLE[combo.language] });
        await expect(noticeDialog).toBeVisible();
        await page.waitForTimeout(600);
        expect(await axeViolations(page, "[role=dialog]"), "confirmacion").toEqual([]);
        await noticeDialog.getByRole("button", { name: STRIP_CONFIRM[combo.language] }).click();
        await expect(notice.locator("[data-strip-signatures-status]")).toHaveText(/.+/);
        expect(await axeViolations(page, ".surface-card:has(input[type=checkbox])"), "aviso con el resultado").toEqual([]);

        // Ajustes.
        await page.goto("/settings");
        const settingsButton = page.getByRole("button", { name: STRIP_BUTTON[combo.language] });
        await expect(settingsButton).toBeVisible();
        await expectTouchTarget(settingsButton, "boton de Ajustes");
        await page.waitForTimeout(600);
        expect(await axeViolations(page, "main"), "Ajustes").toEqual([]);
        await expectNoHorizontalOverflow(page);
        const text = await page.locator("body").innerText();
        expect(text).not.toMatch(/clearStrokes|draftPrivacy|undefined|\[object/);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe("axe: el aviso, el interruptor y la opcion «E-sign»", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["es", "en"] as const) {
      for (const width of [1280, 375] as const) {
        test(`(a1) ${theme} · ${language} · ${width}px: aviso con interruptor y teaser de la cabecera sin violaciones`, async ({ browser }) => {
          const context = await newContext(browser, { width, theme, language });
          const page = await context.newPage();
          try {
            await openSignAndUpload(page, await makeTwoDocs());
            await page.getByRole("tab", { name: language === "es" ? "Varios firmantes" : "Several signers" }).click();
            const toggle = page.getByRole("checkbox", { name: NOTICE_SWITCH[language] });
            await expect(toggle).toBeVisible();
            await expectTouchTarget(toggle.locator("xpath=ancestor::div[contains(@class,'min-h-11')][1]"), "interruptor");
            // El aviso es el primer bloque con tarjeta tras la fila de pasos.
            expect(await axeViolations(page, ".surface-card:has(input[type=checkbox])"), "el aviso").toEqual([]);
            await expect(teaserIn(page, "section")).toBeVisible();
            expect(await axeViolations(page, "[data-esign-teaser]"), "teaser").toEqual([]);
            // Apagado tambien (otro texto y otro estado del interruptor).
            await toggle.evaluate((node) => (node as HTMLInputElement).click());
            await expect(toggle).not.toBeChecked();
            expect(await axeViolations(page, ".surface-card:has(input[type=checkbox])"), "el aviso, apagado").toEqual([]);
            await expectNoHorizontalOverflow(page);
          } finally {
            await context.close();
          }
        });
      }
    }
  }

  for (const combo of [
    { theme: "light", language: "es", width: 1280 },
    { theme: "dark", language: "es", width: 375 },
    { theme: "dark", language: "en", width: 1280 },
    { theme: "light", language: "en", width: 375 },
  ] as const) {
    test(`(a2) ${combo.theme} · ${combo.language} · ${combo.width}px: la casilla de borrado y el teaser de la pantalla de resultado sin violaciones`, async ({ browser }) => {
      // La ronda se prepara en espanol y a 1280 px (los rotulos de la ceremonia y el lienzo de colocacion de huecos de las
      // ayudas son de escritorio); la pantalla de resultado se mira despues en el idioma y el ancho pedidos.
      const context = await newContext(browser, { width: 1280, theme: combo.theme, language: "es" });
      const page = await context.newPage();
      try {
        await collectAllSignatures(page, await makeTwoDocs());
        await waitForDraftSettled(page);
        if (combo.language === "en") {
          await page.evaluate(() => window.localStorage.setItem("optimuspdf.language", "en"));
          await page.reload();
          await page.getByRole("button", { name: "3. Sign" }).click();
          await expect(page.getByRole("heading", { name: "Everyone has signed" })).toBeVisible({ timeout: 20_000 });
          await page.getByRole("button", { name: "Sign and download" }).click();
        } else {
          await page.getByRole("button", { name: "Firmar y descargar" }).click();
        }
        await page.setViewportSize({ width: combo.width, height: combo.width < 600 ? 812 : 900 });
        const download = page.getByRole("button", { name: combo.language === "es" ? "Descargar" : "Download", exact: true });
        await expect(download).toBeVisible({ timeout: 60_000 });
        const box = page.getByRole("checkbox", { name: DELETE_LABEL[combo.language] });
        await expect(box).toBeChecked();
        // Deja que se asiente la animacion de entrada de la tarjeta antes de medir contraste.
        await page.waitForTimeout(900);
        expect(await axeViolations(page, "[data-download-extras]"), "casilla + teaser").toEqual([]);
        expect(await axeViolations(page, "section[aria-labelledby=download-title]"), "tarjeta de resultado").toEqual([]);
        await expectTouchTarget(box.locator("xpath=ancestor::div[contains(@class,'min-h-11')][1]"), "casilla");
        await expectTouchTarget(teaserIn(page, "[data-download-extras]"), "teaser");
        await expectNoHorizontalOverflow(page);
        // F0-fix (D5): al descargar, el borrado espera unos segundos con «Deshacer»: ese aviso tambien pasa axe y mide 44 px.
        await download.click();
        const undo = page.getByRole("button", { name: combo.language === "es" ? "Deshacer" : "Undo" });
        await expect(undo).toBeVisible();
        await page.waitForTimeout(400);
        expect(await axeViolations(page, "[data-delete-draft]"), "aviso de borrado con «Deshacer»").toEqual([]);
        await expectTouchTarget(undo, "Deshacer");
        await expectNoHorizontalOverflow(page);
        // F0-fix2 (N1): desmarcar la casilla durante la espera tambien cancela, y ese aviso pasa axe, mide 44 px y no desborda.
        await page.getByText(DELETE_LABEL[combo.language], { exact: true }).click();
        await expect(box).not.toBeChecked();
        await expect(page.locator("[data-delete-draft-status]")).toHaveText(
          combo.language === "es" ? "El borrador se conserva (se borra solo a los 7 días)." : "The draft is kept (it deletes itself after 7 days).",
        );
        await page.waitForTimeout(400);
        expect(await axeViolations(page, "[data-delete-draft]"), "aviso de borrador conservado").toEqual([]);
        await expectTouchTarget(box.locator("xpath=ancestor::div[contains(@class,'min-h-11')][1]"), "casilla desmarcada");
        await expectNoHorizontalOverflow(page);
        const text = await page.locator("body").innerText();
        expect(text).not.toMatch(/draftPrivacy|deleteLabel|esign\.|undefined|\[object/);
      } finally {
        await context.close();
      }
    });
  }
});
