/**
 * Piezas comunes de los E2E de la Fase 0 «Firma agil» (`docs/PLAN-FIRMA-AGIL.md` §3, U0.1): subir PDF sinteticos,
 * definir dos firmantes, colocar huecos, recoger firmas por turnos y leer el borrador guardado en IndexedDB.
 * Los textos son los de la interfaz en espanol (`strings.ts` de Firmar). SIEMPRE headless.
 *
 * Los PDF son sinteticos y DETERMINISTAS (sin fecha ni productor de la libreria): dos llamadas con la misma etiqueta
 * dan los MISMOS bytes, que es lo que hace falta para «subir el mismo PDF» y que la huella de contenido coincida.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { stillBox } from "./engine";

export const DOC_A = "Contrato A.pdf";
export const DOC_B = "Anexo B.pdf";
export const SIGNER_1 = "Ana";
export const SIGNER_2 = "Luis";

export type SyntheticDoc = { name: string; mimeType: "application/pdf"; buffer: Buffer };

/** Un PDF de 2 paginas, siempre con los mismos bytes para la misma etiqueta. */
export async function makeSyntheticPdf(label: string, pages = 2): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= pages; index += 1) {
    const sheet = doc.addPage([400, 300]);
    sheet.drawText(`${label} pagina ${index}`, { x: 40, y: 250, size: 18, font });
  }
  return Buffer.from(await doc.save());
}

/** Los dos documentos de la ronda (Contrato A, Anexo B). */
export async function makeTwoDocs(): Promise<SyntheticDoc[]> {
  return [
    { name: DOC_A, mimeType: "application/pdf", buffer: await makeSyntheticPdf("A") },
    { name: DOC_B, mimeType: "application/pdf", buffer: await makeSyntheticPdf("B") },
  ];
}

export function fileInput(page: Page): Locator {
  return page.locator('input[type="file"][accept*="pdf"]').first();
}

/** Abre `/sign-pdf` y sube los documentos; con varios, espera a sus pestanas «1. nombre», «2. nombre». */
export async function openSignAndUpload(page: Page, docs: readonly SyntheticDoc[]): Promise<void> {
  await page.goto("/sign-pdf");
  await uploadDocs(page, docs);
}

export async function uploadDocs(page: Page, docs: readonly SyntheticDoc[]): Promise<void> {
  await fileInput(page).setInputFiles([...docs]);
  if (docs.length > 1) {
    for (const [index, doc] of docs.entries()) {
      // Holgura de CI: el shell comprueba los archivos antes de pintar la herramienta (`checking`), y con la CPU apretada
      // (2 vCPU, dos trabajadores y el servidor) eso pasa de los 5 s por defecto sin que haya nada roto.
      await expect(page.getByRole("button", { name: `${index + 1}. ${doc.name}` })).toBeVisible({ timeout: 30_000 });
    }
  }
}

/** «Varios firmantes», dos firmantes con nombre. */
export async function defineSigners(page: Page, names: readonly [string, string] = [SIGNER_1, SIGNER_2]): Promise<void> {
  await page.getByRole("tab", { name: "Varios firmantes" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByLabel("Nombre del firmante 1").fill(names[0]);
  await page.getByLabel("Nombre del firmante 2").fill(names[1]);
}

/**
 * «Una firma para todos» (antes «Mismas firmas») / «Una firma por documento» (antes «Firmas distintas por documento»):
 * los atajos de la tabla «¿Quién firma qué?» (solo con varios documentos y algún firmante, en el paso Firmantes).
 */
export async function selectSignMode(page: Page, mode: "same" | "independent"): Promise<void> {
  const label = mode === "same" ? "Una firma para todos" : "Una firma por documento";
  await page.getByRole("button", { name: label, exact: true }).click();
  const cells = page.getByRole("grid", { name: /Quién firma cada documento/ }).locator("[data-cell]");
  if (mode === "same") {
    // Todas las celdas son la firma A.
    await expect(cells.first()).toHaveAttribute("data-group", "A");
    await expect(cells.and(page.locator('[data-group]:not([data-group="A"])'))).toHaveCount(0);
  } else {
    // Cada documento lleva la suya: aparece al menos una celda «B».
    await expect(page.locator('[data-cell][data-group="B"]').first()).toBeVisible();
  }
}

/** Coloca un hueco de firma del firmante dado sobre la pagina visible del lienzo (el paso «Documento» ya abierto). */
export async function placeSlot(page: Page, signer: string, offsetY: number): Promise<void> {
  await page.getByRole("radio", { name: signer, exact: true }).click();
  await page.getByRole("toolbar").first().getByRole("button", { name: "Firma" }).click();
  const surface = page.locator('img[alt]:not([alt=""])').first();
  await surface.scrollIntoViewIfNeeded();
  // Quieta: tras cambiar de documento la hoja se repinta y WebKit tarda mas (un arrastre sobre la hoja vieja se pierde).
  const box = await stillBox(surface);
  if (!box) throw new Error("no se encontro la pagina del lienzo");
  await page.mouse.move(box.x + 60, box.y + offsetY);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + offsetY + 40, { steps: 5 });
  await page.mouse.up();
}

/** Un hueco por firmante en cada uno de los dos documentos (4 huecos). */
export async function placeSlotsInBothDocuments(page: Page): Promise<void> {
  await page.getByRole("button", { name: "2. Documento" }).click();
  await placeSlot(page, SIGNER_1, 100);
  await placeSlot(page, SIGNER_2, 200);
  await page.getByRole("button", { name: `2. ${DOC_B}` }).click();
  await expect(page.getByRole("button", { name: `2. ${DOC_B}` })).toHaveAttribute("aria-current", "true");
  await expect(page.locator("[data-sequence-live]")).toContainText(`Documento 2 de 2: ${DOC_B}`);
  await placeSlot(page, SIGNER_1, 100);
  await placeSlot(page, SIGNER_2, 200);
  await expect(page.getByText("En este documento: 2 huecos").first()).toBeVisible();
}

/** Un hueco por firmante en el unico documento (2 huecos). */
export async function placeSlotsInSingleDocument(
  page: Page,
  names: readonly [string, string] = [SIGNER_1, SIGNER_2],
): Promise<void> {
  await page.getByRole("button", { name: "2. Documento" }).click();
  await placeSlot(page, names[0], 100);
  await placeSlot(page, names[1], 200);
}

/** Preparacion comun: 2 documentos, 2 firmantes, modo de firmas elegido, huecos en ambos documentos. */
export async function prepareTwoDocsTwoSigners(
  page: Page,
  docs: readonly SyntheticDoc[],
  mode: "same" | "independent",
): Promise<void> {
  await openSignAndUpload(page, docs);
  await defineSigners(page);
  await selectSignMode(page, mode);
  await placeSlotsInBothDocuments(page);
}

/** Del paso «Documento» al paso «Firmar» con el boton «Continuar». */
export async function continueToSign(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(turnCounter(page)).toBeVisible();
}

/* ------------------------------------------------------------------ *
 * Ceremonia
 * ------------------------------------------------------------------ */

/** «Turno N de M» de la ceremonia. */
export function turnCounter(page: Page): Locator {
  return page.getByText(/^Turno \d+ de \d+$/);
}

/** Encabezado del traspaso: «Pásale el dispositivo a <nombre>». */
export function handoffHeading(page: Page, name: string): Locator {
  return page.getByRole("heading", { name: `Pásale el dispositivo a ${name}` });
}

/**
 * Traza una firma distinta segun `seed` en la hoja de firma abierta y la usa. Con `waitClosed: false` vuelve justo
 * despues del clic en «Usar esta firma», sin esperar a que la hoja termine de cerrarse (para medir plazos de
 * guardado desde el instante exacto de la firma).
 */
export async function drawInOpenComposer(page: Page, seed: number, options: { waitClosed?: boolean } = {}): Promise<void> {
  const dialog = page.getByRole("dialog");
  const canvas = dialog.locator("canvas");
  // La hoja entra con un muelle: se espera a que el recuadro deje de moverse.
  let box = await canvas.boundingBox();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(100);
    const next = await canvas.boundingBox();
    if (box && next && next.x === box.x && next.y === box.y) break;
    box = next;
  }
  if (!box) throw new Error("no se encontro el lienzo de firma");
  const amplitude = 10 + (seed % 5) * 12;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2 - amplitude, { steps: 8 });
  await page.mouse.move(box.x + (2 * box.width) / 3, box.y + box.height / 2 + amplitude, { steps: 8 });
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2 - amplitude / 2, { steps: 8 });
  await page.mouse.up();
  await dialog.getByRole("button", { name: "Usar esta firma" }).click();
  if (options.waitClosed !== false) await expect(dialog).toBeHidden();
}

/** «Listo, es mi turno» del traspaso (el primero de la pagina es el del turno en curso). */
export async function startTurn(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Listo, es mi turno" }).first().click();
}

/**
 * Crea la firma de la fila `n` (1..) del turno en curso. Con mas de un bloque en el turno el boton lleva el contexto
 * («Crear mi firma · Firma B»); con uno solo, no.
 */
export async function createBlockSignature(
  page: Page,
  n: number,
  ofBlocks: number,
  seed: number,
  options: { waitClosed?: boolean } = {},
): Promise<void> {
  const open =
    ofBlocks > 1
      ? page.getByRole("button", { name: `Crear mi firma · Firma ${String.fromCharCode(64 + n)}`, exact: true })
      : page.getByRole("button", { name: "Crear mi firma", exact: true });
  await open.click();
  await drawInOpenComposer(page, seed, options);
}

/** Recoge la firma de cada bloque del turno en curso y llega a la revision («Ver cómo queda» ya pulsado). */
export async function captureAndReview(page: Page, blocks: number, seedBase: number): Promise<void> {
  await startTurn(page);
  for (let n = 1; n <= blocks; n += 1) {
    await createBlockSignature(page, n, blocks, seedBase + n);
  }
  const review = page.getByRole("button", { name: "Ver cómo queda" });
  await expect(review).toBeEnabled();
  await review.click();
}

/** Turno completo de un firmante (recoger + revisar + pasar). `last` = el boton final es «He terminado». */
export async function signWholeTurn(page: Page, blocks: number, seedBase: number, last: boolean): Promise<void> {
  await captureAndReview(page, blocks, seedBase);
  await page.getByRole("button", { name: last ? "He terminado" : "Pasar al siguiente firmante" }).click();
}

/**
 * El recorrido del adjuster: 2 documentos, 2 firmantes, «Una firma por documento» (4 bloques), huecos en ambos
 * y la ceremonia entera hasta «Ya han firmado todos». Empieza desde Inicio para que el BACK del navegador tenga a donde
 * volver. Con `holdLast` se queda justo ANTES de la ultima firma (la Firma B de Luis), para medir plazos de guardado.
 */
export async function collectAllSignatures(
  page: Page,
  docs: readonly SyntheticDoc[],
  options: { holdLast?: boolean } = {},
): Promise<void> {
  await page.goto("/");
  await prepareTwoDocsTwoSigners(page, docs, "independent");
  await continueToSign(page);
  // Turno de Ana: sus dos bloques (uno por documento).
  await signWholeTurn(page, 2, 10, false);
  if (options.holdLast) {
    await startTurn(page);
    await createBlockSignature(page, 1, 2, 21);
    return;
  }
  await signWholeTurn(page, 2, 20, true);
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
}

/* ------------------------------------------------------------------ *
 * Borrador en IndexedDB
 * ------------------------------------------------------------------ */

/** Cuantos borradores de SESION hay ahora mismo en IndexedDB (lo que ve el navegador). */
export async function sessionDraftCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open("optimuspdf-sign-drafts");
        request.onerror = () => resolve(-1);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("sessionMeta")) {
            db.close();
            resolve(-1);
            return;
          }
          const count = db.transaction("sessionMeta", "readonly").objectStore("sessionMeta").count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => {
            db.close();
            resolve(-1);
          };
        };
      }),
  );
}

/**
 * Cuantos bloques con trazo (firma o iniciales) tiene el borrador de sesion guardado (-1 = no hay borrador legible).
 * Sirve para esperar a que el borrador YA contenga las firmas recogidas antes de abandonar la pagina.
 */
export async function draftedStrokeCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open("optimuspdf-sign-drafts");
        request.onerror = () => resolve(-1);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("sessionMeta")) {
            db.close();
            resolve(-1);
            return;
          }
          const all = db.transaction("sessionMeta", "readonly").objectStore("sessionMeta").getAll();
          all.onsuccess = () => {
            db.close();
            const meta = all.result[0] as { blocks?: Array<{ signature?: unknown; initials?: unknown }> } | undefined;
            if (!meta) return resolve(-1);
            resolve((meta.blocks ?? []).filter((block) => Boolean(block.signature) || Boolean(block.initials)).length);
          };
          all.onerror = () => {
            db.close();
            resolve(-1);
          };
        };
      }),
  );
}

/** Abre «Ver borradores» y reanuda el unico borrador de sesion (retoma desde la hoja, el camino de hoy). */
export async function resumeFromDraftsSheet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Ver borradores" }).click();
  const sheet = page.getByRole("dialog", { name: "Borradores guardados" });
  await expect(sheet.getByRole("button", { name: "Reanudar" })).toBeVisible();
  await sheet.getByRole("button", { name: "Reanudar" }).click();
}

/* ------------------------------------------------------------------ *
 * Navegacion del navegador
 * ------------------------------------------------------------------ */

/**
 * «Atras» del NAVEGADOR (el boton de Safari o el gesto de deslizar desde el borde izquierdo del iPad), no el boton
 * «Atras» de la aplicacion. Espera a estar fuera de la herramienta (ruta `/`). Si la aplicacion pregunta antes
 * («¿Salir de la firma? Todo esta guardado», U0.3), se confirma con «Salir»: la prueba siempre acaba FUERA.
 */
export async function leaveWithBrowserBack(page: Page): Promise<void> {
  await page.goBack();
  const leave = page.getByRole("dialog").getByRole("button", { name: "Salir", exact: true });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (new URL(page.url()).pathname === "/") return;
    if (await leave.isVisible().catch(() => false)) await leave.click().catch(() => undefined);
    await page.waitForTimeout(100);
  }
  throw new Error(`el «Atras» del navegador no salio de la herramienta (URL: ${page.url()})`);
}

/**
 * Lo que hay que ver cuando el trabajo de una ronda con las firmas de AMBOS firmantes ya recogidas esta de vuelta:
 * los dos documentos, los dos firmantes y «Ya han firmado todos» con la descarga habilitada.
 */
export async function expectCollectedWorkRestored(page: Page, docs: readonly SyntheticDoc[]): Promise<void> {
  for (const [index, doc] of docs.entries()) {
    await expect(page.getByRole("button", { name: `${index + 1}. ${doc.name}` })).toBeVisible();
  }
  await page.getByRole("button", { name: "1. Firmantes" }).click();
  await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2);
  await page.getByRole("button", { name: "3. Firmar" }).click();
  await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Firmar y descargar" })).toBeEnabled();
}

/* ------------------------------------------------------------------ *
 * Retomar sin buscar y aviso al salir (Fase 0 «Firma agil», U0.3)
 * ------------------------------------------------------------------ */

/** `?s=` de la URL de ahora (`null` si no hay). */
export function sessionParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get("s");
}

/** Entradas del historial de esta pestana (`history.length`): sube cuando se empuja una entrada nueva. */
export async function historyLength(page: Page): Promise<number> {
  return page.evaluate(() => window.history.length);
}

/**
 * ¿Pediria el navegador confirmacion al cerrar o recargar AHORA? Se lanza un `beforeunload` cancelable y se mira si
 * alguien lo cancelo; no cierra nada. (El aviso real lo pone el navegador; Safari en iPhone/iPad lo ignora.)
 */
export async function beforeUnloadPrevented(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

/** Cuantos borradores de UN documento (v1) hay ahora mismo en IndexedDB (-1 = no hay base legible). */
export async function singleDraftCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open("optimuspdf-sign-drafts");
        request.onerror = () => resolve(-1);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("draftMeta")) {
            db.close();
            resolve(-1);
            return;
          }
          const count = db.transaction("draftMeta", "readonly").objectStore("draftMeta").count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => {
            db.close();
            resolve(-1);
          };
        };
      }),
  );
}

/** La hoja «¿Salir de la firma?» (el dialogo, no el boton). */
export function leaveSheet(page: Page): Locator {
  return page.getByRole("dialog", { name: /Salir de la firma|Leave signing/ });
}

/** Un PDF sintetico DISTINTO (otra huella) con el mismo formato que los de la ronda. */
export async function makeOtherDoc(name: string, label: string): Promise<SyntheticDoc> {
  return { name, mimeType: "application/pdf", buffer: await makeSyntheticPdf(label) };
}

/** Espera a que el borrador de sesion este al dia (hay uno y ninguna escritura sigue pendiente). */
export async function waitForDraftSettled(page: Page): Promise<void> {
  await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => beforeUnloadPrevented(page), { timeout: 15_000 }).toBe(false);
}

/* ------------------------------------------------------------------ *
 * F0-fix: borradores en IndexedDB, fallos de almacenamiento y dos pestanas
 * ------------------------------------------------------------------ */

/** Una fila de borrador (sin bytes), tal y como la ve el navegador. */
export type DraftRow = {
  kind: "session" | "document";
  id: string;
  /** Huella del PDF (documento suelto); un borrador anterior no la lleva (su id ES la huella). */
  fingerprint?: string;
  signers: string[];
  /** Bloques/capturas con trazo (firma o iniciales). */
  strokes: number;
  /** Huecos de firma (documento suelto) o suma de huecos de todos los documentos (sesion). */
  fields: number;
  rev?: number;
  writerId?: string;
  copyOf?: string;
  savedAt: string;
  expiresAt?: string;
};

/** Lo minimo que se lee de una fila de IndexedDB (sin bytes). */
type RawMeta = {
  id: string;
  fingerprint?: string;
  signers?: Array<{ name: string }>;
  blocks?: Array<{ signature?: unknown; initials?: unknown }>;
  captures?: Record<string, { signature?: unknown; initials?: unknown } | undefined>;
  docStates?: Record<string, { fields?: unknown[] } | undefined>;
  fields?: unknown[];
  rev?: number;
  writerId?: string;
  copyOf?: string;
  savedAt: string;
  expiresAt?: string;
};

/** TODOS los borradores guardados (sesiones y documentos sueltos), el mas reciente primero. */
export async function draftRows(page: Page): Promise<DraftRow[]> {
  return page.evaluate(
    () =>
      new Promise<DraftRow[]>((resolve) => {
        const request = indexedDB.open("optimuspdf-sign-drafts");
        request.onerror = () => resolve([]);
        request.onsuccess = () => {
          const db = request.result;
          const rows: DraftRow[] = [];
          const names = ["draftMeta", "sessionMeta"].filter((name) => db.objectStoreNames.contains(name));
          let pending = names.length;
          const finish = () => {
            db.close();
            resolve(rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
          };
          if (pending === 0) return finish();
          for (const name of names) {
            const all = db.transaction(name, "readonly").objectStore(name).getAll();
            all.onsuccess = () => {
              for (const meta of all.result as RawMeta[]) {
                const isSession = name === "sessionMeta";
                const strokeCount = isSession
                  ? (meta.blocks ?? []).filter((block) => block.signature || block.initials).length
                  : Object.values(meta.captures ?? {}).filter((capture) => capture && (capture.signature || capture.initials)).length;
                const fieldCount = isSession
                  ? Object.values(meta.docStates ?? {}).reduce((sum, state) => sum + (state?.fields?.length ?? 0), 0)
                  : (meta.fields ?? []).length;
                rows.push({
                  kind: isSession ? "session" : "document",
                  id: meta.id,
                  fingerprint: meta.fingerprint,
                  signers: (meta.signers ?? []).map((signer) => signer.name),
                  strokes: strokeCount,
                  fields: fieldCount,
                  rev: meta.rev,
                  writerId: meta.writerId,
                  copyOf: meta.copyOf,
                  savedAt: meta.savedAt,
                  expiresAt: meta.expiresAt,
                });
              }
              if (--pending === 0) finish();
            };
            all.onerror = () => {
              if (--pending === 0) finish();
            };
          }
        };
      }),
  );
}

export type IndexedDbFailure = "quota" | "noidb" | null;

/**
 * Hace que IndexedDB falle como en un navegador con la cuota llena (`QuotaExceededError` al escribir un borrador) o con
 * el almacenamiento bloqueado (Safari en navegacion privada: `SecurityError` al abrir la base). Solo toca la base de
 * borradores de Firmar. Se instala en TODA carga de pagina (`addInitScript`); `setIndexedDbFailure` lo enciende y apaga
 * sin recargar.
 */
export async function failIndexedDb(page: Page, mode: IndexedDbFailure): Promise<void> {
  await page.addInitScript((initial) => {
    const w = window as unknown as { __idbFail: IndexedDbFailure };
    w.__idbFail = initial as IndexedDbFailure;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function patchedPut(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (w.__idbFail === "quota" && (this.name === "sessionMeta" || this.name === "draftMeta")) {
        throw new DOMException("QuotaExceededError (simulado)", "QuotaExceededError");
      }
      return originalPut.apply(this, args);
    };
    const originalOpen = indexedDB.open.bind(indexedDB);
    (indexedDB as unknown as { open: unknown }).open = (name: string, version?: number) => {
      if (w.__idbFail === "noidb" && name.includes("sign-drafts")) {
        throw new DOMException("almacenamiento bloqueado (simulado)", "SecurityError");
      }
      return version === undefined ? originalOpen(name) : originalOpen(name, version);
    };
  }, mode);
}

/** Enciende o apaga el fallo simulado de `failIndexedDb` en la pagina que ya esta abierta. */
export async function setIndexedDbFailure(page: Page, mode: IndexedDbFailure): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __idbFail: IndexedDbFailure }).__idbFail = value as IndexedDbFailure;
  }, mode);
}

/** El aviso persistente de borradores de Firmar (sin autoguardado, otra pestana...). */
export function draftHealth(page: Page): Locator {
  return page.locator("[data-draft-health]");
}

/** Recoge todo lo del primer firmante (2 documentos, firmas distintas) y se queda en el traspaso del segundo. */
export async function collectFirstSigner(page: Page, docs: readonly SyntheticDoc[]): Promise<void> {
  await page.goto("/");
  await prepareTwoDocsTwoSigners(page, docs, "independent");
  await continueToSign(page);
  await signWholeTurn(page, 2, 10, false);
  await expect(page.getByText("Turno 2 de 2")).toBeVisible();
}

/* ------------------------------------------------------------------ *
 * Firma agil · Fase 1: tabla «¿Quien firma que?», copias, orden de turnos y revision
 * ------------------------------------------------------------------ */

/** Un grupo de firma tal como lo guarda el borrador de sesion: de quien es, a que documentos aplica y sus trazos. */
export type StoredGroup = {
  signerId: string;
  /** Nombres de archivo de los documentos del grupo, en el orden de la cola. */
  fileNames: string[];
  signature: string | null;
  initials: string | null;
};

/** Los grupos (bloques) del unico borrador de sesion en IndexedDB, con los trazos tal como se capturaron. */
export async function readStoredGroups(page: Page): Promise<StoredGroup[]> {
  return page.evaluate(
    () =>
      new Promise<StoredGroup[]>((resolve, reject) => {
        const request = indexedDB.open("optimuspdf-sign-drafts");
        request.onerror = () => reject(new Error("no se pudo abrir IndexedDB"));
        request.onsuccess = () => {
          const db = request.result;
          const all = db.transaction("sessionMeta", "readonly").objectStore("sessionMeta").getAll();
          all.onsuccess = () => {
            db.close();
            const meta = all.result[0] as
              | {
                  documents: Array<{ id: string; fileName: string }>;
                  blocks: Array<{
                    signerId: string;
                    appliesTo: string[];
                    signature?: { dataUrl: string } | null;
                    initials?: { dataUrl: string } | null;
                  }>;
                }
              | undefined;
            if (!meta) return resolve([]);
            resolve(
              meta.blocks.map((block) => ({
                signerId: block.signerId,
                fileNames: meta.documents.filter((doc) => block.appliesTo.includes(doc.id)).map((doc) => doc.fileName),
                signature: block.signature?.dataUrl ?? null,
                initials: block.initials?.dataUrl ?? null,
              })),
            );
          };
          all.onerror = () => reject(new Error("no se pudo leer sessionMeta"));
        };
      }),
  );
}

/** Reescribe el unico borrador de sesion (para simular uno ANTERIOR a la tabla: sin copias, sin orden, en «distintas»). */
export async function rewriteSessionMeta(page: Page, rewrite: string): Promise<void> {
  await page.evaluate(
    (source) =>
      new Promise<void>((resolve, reject) => {
        const edit = new Function("meta", source) as (meta: Record<string, unknown>) => Record<string, unknown>;
        const request = indexedDB.open("optimuspdf-sign-drafts");
        request.onerror = () => reject(new Error("no se pudo abrir IndexedDB"));
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("sessionMeta", "readwrite");
          const store = tx.objectStore("sessionMeta");
          const all = store.getAll();
          all.onsuccess = () => {
            const meta = all.result[0] as Record<string, unknown> | undefined;
            if (meta) store.put(edit(meta));
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(new Error("no se pudo escribir sessionMeta"));
        };
      }),
    rewrite,
  );
}

/** El orden de turnos guardado en el borrador de sesion (`null` = el de siempre). */
export async function storedTurnOrder(page: Page): Promise<string[] | null> {
  return page.evaluate(
    () =>
      new Promise<string[] | null>((resolve) => {
        const request = indexedDB.open("optimuspdf-sign-drafts");
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const db = request.result;
          const all = db.transaction("sessionMeta", "readonly").objectStore("sessionMeta").getAll();
          all.onsuccess = () => {
            db.close();
            const meta = all.result[0] as { turnOrder?: string[] } | undefined;
            resolve(meta?.turnOrder ?? null);
          };
          all.onerror = () => {
            db.close();
            resolve(null);
          };
        };
      }),
  );
}

/** La tabla «¿Quien firma que?»: la letra (o `null`) de cada celda, fila a fila (un documento) y columna a columna (un firmante). */
export async function readAssignmentCells(page: Page): Promise<(string | null)[][]> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[role="grid"] [role="row"]')].filter((row) => row.querySelector("[data-cell]"));
    return rows.map((row) =>
      [...row.querySelectorAll<HTMLElement>("[data-cell]")].map((cell) => (cell.dataset.group ? cell.dataset.group : null)),
    );
  });
}

/** Copias de cada documento segun el texto accesible de la tabla («Contrato: 2 copias»). */
export async function readCopies(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[role="grid"] [role="row"]')].filter((row) => row.querySelector("[data-cell]"));
    return rows.map((row) => {
      const text = row.querySelector('[role="gridcell"]:last-child .sr-only')?.textContent ?? "";
      const match = /(\d+)\s+cop/.exec(text);
      return match ? Number(match[1]) : 1;
    });
  });
}
