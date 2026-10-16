import { expect, test, type Locator, type Page } from "@playwright/test";
import JSZip from "jszip";
import { downloadFile } from "../helpers/downloads";
import { embeddedImages, pngPixels, sameShape, type PixelImage } from "../helpers/pdf-images";
import {
  SIGNER_1,
  SIGNER_2,
  continueToSign,
  draftedStrokeCount,
  handoffHeading,
  makeSyntheticPdf,
  openSignAndUpload,
  placeSlot,
  prepareTwoDocsTwoSigners,
  makeTwoDocs,
  readAssignmentCells,
  readCopies,
  readStoredGroups,
  rewriteSessionMeta,
  sessionParam,
  signWholeTurn,
  startTurn,
  createBlockSignature,
  storedTurnOrder,
  turnCounter,
  waitForDraftSettled,
  type SyntheticDoc,
} from "../helpers/sign-flow";

/**
 * Firma agil · Fase 1 (U1.2 + U1.3): tabla «¿Quien firma que?», copias, ceremonia por grupos, orden de turnos y
 * «Revisar antes de descargar». Navegador real, headless. Escritorio en Chromium y tactil en `webkit-ipad`.
 *
 * El CASO DEL USUARIO (adjuster con iPad): «4 documentos, la misma firma en el 1 y el 2 y otra distinta en el 3 y el 4, y
 * 2 copias». Se configura en pocos toques (se cuentan y se publican como anotacion de la prueba), se recogen 2 trazos en UN
 * turno, y el ZIP lleva 8 PDF, cada uno con SU trazo (se compara la forma del PNG empotrado con la del trazo capturado).
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(240_000);

const NAMES = ["Contrato", "Anexo", "Carta", "Autorización"] as const;

async function fourDocs(): Promise<SyntheticDoc[]> {
  return Promise.all(
    NAMES.map(async (name) => ({
      name: `${name}.pdf`,
      mimeType: "application/pdf" as const,
      buffer: await makeSyntheticPdf(name, 2),
    })),
  );
}

/** Cuenta cada toque de la persona (para medir cuantos hacen falta): un clic = un toque. */
function counter() {
  const taps: string[] = [];
  return {
    taps,
    async tap(locator: Locator, label: string) {
      taps.push(label);
      await locator.click();
    },
  };
}

const cellsOf = async (page: Page) => (await readAssignmentCells(page)).map((row) => row.join(""));

/** Un hueco de firma de Ana en cada uno de los documentos (paso «Documento»). */
async function placeSlotInEveryDocument(page: Page, count: number, signer = SIGNER_1): Promise<void> {
  await page.getByRole("button", { name: "2. Documento" }).click();
  for (let index = 0; index < count; index += 1) {
    const tab = page.getByRole("button", { name: `${index + 1}. ${NAMES[index]}.pdf` });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-current", "true");
    if (index > 0) {
      await expect(page.locator("[data-sequence-live]")).toContainText(`Documento ${index + 1} de ${count}: ${NAMES[index]}.pdf`);
    }
    // El arrastre sobre la hoja a veces se pierde (WebKit repinta la hoja tras cambiar de documento): se comprueba y se repite.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await placeSlot(page, signer, 100);
      const placed = await expect(page.getByText(/En este documento: 1 hueco/).first())
        .toBeVisible({ timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      if (placed) break;
      if (attempt === 2) throw new Error(`no se pudo colocar el hueco en ${NAMES[index]}.pdf`);
    }
  }
}

/** Al paso «Firmar» con la barra de pasos (desde cualquier otro paso). */
async function goToSign(page: Page): Promise<void> {
  await page.getByRole("button", { name: "3. Firmar" }).click();
  await expect(turnCounter(page)).toBeVisible();
}

/** El caso del usuario hasta la tabla configurada; devuelve los toques que hizo. */
async function configureUserCase(page: Page): Promise<string[]> {
  await openSignAndUpload(page, await fourDocs());
  const { taps, tap } = counter();
  await tap(page.getByRole("tab", { name: "Varios firmantes" }), "Varios firmantes");
  await tap(page.getByRole("button", { name: "Añadir firmante" }), "Añadir firmante");
  await page.getByLabel("Nombre del firmante 1").fill(SIGNER_1);
  await tap(page.getByRole("button", { name: "Por grupos" }), "Por grupos");
  await tap(page.getByRole("button", { name: "Una copia más en todos los documentos" }), "Copias de todos +1");
  return taps;
}

async function strokeShapes(page: Page): Promise<{ a: PixelImage; b: PixelImage; groups: Awaited<ReturnType<typeof readStoredGroups>> }> {
  await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  const groups = await readStoredGroups(page);
  const withStroke = groups.filter((group) => group.signature);
  expect(withStroke).toHaveLength(2);
  const [a, b] = await Promise.all(withStroke.map((group) => pngPixels(group.signature as string)));
  expect(sameShape(a, b), "las dos firmas del turno son distintas").toBe(false);
  return { a, b, groups: withStroke };
}

test.describe("Firma ágil · el caso del adjuster: 4 documentos, A,A,B,B, 2 copias", () => {
  test("se configura en pocos toques, recoge 2 trazos en UN turno y el ZIP lleva 8 PDF, cada uno con su trazo", async ({ page }) => {
    const taps = await configureUserCase(page);

    // La tabla y el resumen en lenguaje natural.
    expect(await cellsOf(page)).toEqual(["A", "A", "B", "B"]);
    expect(await readCopies(page)).toEqual([2, 2, 2, 2]);
    await expect(
      page.getByText("Ana firma 4 documentos con 2 firmas: A (Contrato, Anexo) y B (Carta, Autorización)."),
    ).toBeVisible();
    await expect(page.getByText("Se descargarán 8 archivos.")).toBeVisible();

    // Cuantos toques hicieron falta para dejar «quien firma que» y las copias desde la carga.
    test.info().annotations.push({ type: "toques-configuracion", description: `${taps.length}: ${taps.join(" > ")}` });
    expect(taps.length, `toques: ${taps.join(" > ")}`).toBeLessThanOrEqual(6);

    await placeSlotInEveryDocument(page, 4);
    await continueToSign(page);

    // UN solo turno (Ana), con DOS firmas: «Firma A — para: Contrato, Anexo» y «Firma B — para: Carta, Autorización».
    await expect(turnCounter(page)).toHaveText("Turno 1 de 1");
    await startTurn(page);
    await expect(page.getByText("Firma A — para: Contrato, Anexo")).toBeVisible();
    await expect(page.getByText("Firma B — para: Carta, Autorización")).toBeVisible();
    await createBlockSignature(page, 1, 2, 11);
    await createBlockSignature(page, 2, 2, 22);
    const progress = page.getByRole("list", { name: "Progreso de Ana" }).getByRole("listitem");
    await expect(progress).toHaveCount(2);
    await expect(progress.nth(0)).toHaveText(/^Firma A\s*hecho$/);
    await expect(progress.nth(1)).toHaveText(/^Firma B\s*hecho$/);
    await page.getByRole("button", { name: "Ver cómo queda" }).click();
    await page.getByRole("button", { name: "He terminado" }).click();

    // Revisar antes de descargar: una miniatura por pagina con marca y contadores por documento.
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Revisar antes de descargar" })).toBeVisible();
    for (const name of NAMES) {
      const section = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: new RegExp(`^${name}`) }) });
      await expect(section.getByText("Firmas: 1 de 1")).toBeVisible();
      await expect(section.getByRole("button", { name: new RegExp(`Ir a la página 1 de ${name}`) })).toBeVisible();
    }
    await expect(page.getByText("Todo listo para descargar. Se descargarán 8 archivos.")).toBeVisible();

    const { a, b, groups } = await strokeShapes(page);
    expect(groups.map((group) => group.fileNames)).toEqual([
      ["Contrato.pdf", "Anexo.pdf"],
      ["Carta.pdf", "Autorización.pdf"],
    ]);

    await page.getByRole("button", { name: "Firmar y descargar" }).click();
    await expect(page.getByText("8 archivos: 4 documentos con 2 copias cada uno.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Firmados - 4 documentos.zip")).toBeVisible();
    const { bytes, filename } = await downloadFile(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    expect(filename).toBe("Firmados - 4 documentos.zip");

    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((entry) => entry.endsWith(".pdf")).sort();
    expect(names).toHaveLength(8);
    for (const base of NAMES) {
      expect(names.filter((entry) => entry.includes(base)), base).toHaveLength(2);
      expect(names.some((entry) => entry.includes(base) && entry.includes("(copia 2)")), `${base} (copia 2)`).toBe(true);
    }

    // Cada PDF (el original y su copia) lleva EXACTAMENTE el trazo de SU grupo y no el del otro.
    for (const entry of names) {
      const images = await embeddedImages(Buffer.from(await zip.file(entry)!.async("uint8array")));
      const inGroupA = entry.includes("Contrato") || entry.includes("Anexo");
      const expected = inGroupA ? a : b;
      const other = inGroupA ? b : a;
      expect(images, entry).toHaveLength(1);
      expect(sameShape(images[0], expected), `${entry} lleva el trazo del grupo ${inGroupA ? "A" : "B"}`).toBe(true);
      expect(sameShape(images[0], other), `${entry} NO lleva el trazo del otro grupo`).toBe(false);
    }
  });

  test("recargar a mitad restaura la tabla A,A,B,B y las copias", async ({ page }) => {
    await configureUserCase(page);
    await placeSlotInEveryDocument(page, 4);
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    expect(await cellsOf(page)).toEqual(["A", "A", "B", "B"]);
    await waitForDraftSettled(page);
    expect(sessionParam(page)).toBeTruthy();

    await page.reload();
    await expect(page.getByRole("button", { name: "1. Contrato.pdf" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await expect(page.getByRole("grid", { name: /Quién firma cada documento/ })).toBeVisible();
    expect(await cellsOf(page)).toEqual(["A", "A", "B", "B"]);
    expect(await readCopies(page)).toEqual([2, 2, 2, 2]);
    await expect(page.getByText("Se descargarán 8 archivos.")).toBeVisible();
  });

  test("un borrador ANTERIOR (modo «distintas», sin copias ni orden) se restaura con su tabla equivalente", async ({ page }) => {
    await configureUserCase(page);
    await placeSlotInEveryDocument(page, 4);
    await waitForDraftSettled(page);
    // Lo que guardaba la version anterior: un bloque por documento, modo «independent», sin `copies` ni `turnOrder`.
    await rewriteSessionMeta(
      page,
      `
      const docs = meta.documents;
      meta.signMode = "independent";
      meta.blocks = docs.map((doc, index) => ({
        id: "bk-old-" + index, signerId: meta.signers[0].id, appliesTo: [doc.id],
        signature: null, initials: null, stamps: {}, auto: false,
      }));
      for (const state of Object.values(meta.docStates)) delete state.copies;
      delete meta.turnOrder;
      return meta;
      `,
    );
    await page.reload();
    await expect(page.getByRole("button", { name: "1. Contrato.pdf" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    expect(await cellsOf(page)).toEqual(["A", "B", "C", "D"]);
    expect(await readCopies(page)).toEqual([1, 1, 1, 1]);
    await expect(page.getByText("Se descargarán 4 archivos.")).toBeVisible();
    // Y se puede volver al caso del usuario con un toque.
    await page.getByRole("button", { name: "Por grupos" }).click();
    expect(await cellsOf(page)).toEqual(["A", "A", "B", "B"]);
  });

  test("cambiar la asignación con trazos ya recogidos pide confirmación (Cancelar no toca nada, Continuar sí, Deshacer lo devuelve)", async ({ page }) => {
    await configureUserCase(page);
    await placeSlotInEveryDocument(page, 4);
    await continueToSign(page);
    await startTurn(page);
    await createBlockSignature(page, 1, 2, 11);
    await createBlockSignature(page, 2, 2, 22);
    await page.getByRole("button", { name: "Ver cómo queda" }).click();
    await page.getByRole("button", { name: "He terminado" }).click();
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
    await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await page.getByRole("button", { name: "Una firma para todos" }).click();
    const dialog = page.getByRole("dialog", { name: "¿Cambiar la asignación?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Esto borrará la firma B de Ana en 2 documentos.")).toBeVisible();
    // Cancelar: nada cambia.
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();
    expect(await cellsOf(page)).toEqual(["A", "A", "B", "B"]);

    // Continuar: todo «Firma A». «Deshacer cambio» lo devuelve tal cual y los dos trazos siguen valiendo.
    await page.getByRole("button", { name: "Una firma para todos" }).click();
    await page.getByRole("dialog", { name: "¿Cambiar la asignación?" }).getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await cellsOf(page)).toEqual(["A", "A", "A", "A"]);
    await page.getByRole("button", { name: "Deshacer cambio" }).click();
    expect(await cellsOf(page)).toEqual(["A", "A", "B", "B"]);
    await page.getByRole("button", { name: "3. Firmar" }).click();
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Firmar y descargar" })).toBeEnabled();

    // Y si de verdad se queda en «una firma para todos», Ana tendrá que volver a firmar lo que no vio.
    await page.getByRole("button", { name: "1. Firmantes" }).click();
    await page.getByRole("button", { name: "Una firma para todos" }).click();
    await page.getByRole("dialog", { name: "¿Cambiar la asignación?" }).getByRole("button", { name: "Continuar" }).click();
    await page.getByRole("button", { name: "3. Firmar" }).click();
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Firmar y descargar" })).toBeDisabled();
  });
});

test.describe("Firma ágil · dos documentos y dos firmantes con firmas distintas", () => {
  test("cada PDF lleva las firmas de SUS dos firmantes, con la forma capturada de cada una", async ({ page }) => {
    await prepareTwoDocsTwoSigners(page, await makeTwoDocs(), "independent");
    await continueToSign(page);
    await signWholeTurn(page, 2, 10, false);
    await signWholeTurn(page, 2, 13, true);
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
    await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBe(4);
    const groups = await readStoredGroups(page);
    expect(groups).toHaveLength(4);
    const shapes = await Promise.all(groups.map((group) => pngPixels(group.signature as string)));

    await page.getByRole("button", { name: "Firmar y descargar" }).click();
    await expect(page.getByText("Firmados - 2 documentos.zip")).toBeVisible({ timeout: 60_000 });
    const { bytes } = await downloadFile(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((entry) => entry.endsWith(".pdf")).sort();
    expect(names).toHaveLength(2);
    for (const entry of names) {
      const fileName = entry.includes("Contrato A") ? "Contrato A.pdf" : "Anexo B.pdf";
      const images = await embeddedImages(Buffer.from(await zip.file(entry)!.async("uint8array")));
      expect(images, entry).toHaveLength(2);
      const expected = groups.map((group, index) => ({ group, shape: shapes[index] })).filter(({ group }) => group.fileNames.includes(fileName));
      expect(expected).toHaveLength(2);
      for (const { shape } of expected) {
        expect(images.some((image) => sameShape(image, shape)), `${entry} lleva la firma de cada firmante`).toBe(true);
      }
    }
    // Las 4 firmas son distintas entre si.
    expect(new Set(shapes.map((shape) => `${shape.width}x${shape.height}:${Buffer.from(shape.alpha).toString("base64")}`)).size).toBe(4);
  });
});

test.describe("Firma ágil · orden de los turnos", () => {
  test("↑↓ de 44 px reordenan los turnos, lo anuncian y el orden sobrevive a una recarga", async ({ page }) => {
    await prepareTwoDocsTwoSigners(page, await makeTwoDocs(), "same");
    await continueToSign(page);
    await expect(handoffHeading(page, SIGNER_1)).toBeVisible();

    const down = page.getByRole("button", { name: `Bajar a ${SIGNER_1}` });
    const up = page.getByRole("button", { name: `Subir a ${SIGNER_1}` });
    await expect(up).toBeDisabled();
    const box = await down.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);

    await down.click();
    await expect(handoffHeading(page, SIGNER_2)).toBeVisible();
    await expect(turnCounter(page)).toHaveText("Turno 1 de 2");
    await expect(page.getByRole("status").filter({ hasText: `${SIGNER_1} pasa al turno 2 de 2.` })).toHaveCount(1);
    await expect.poll(() => storedTurnOrder(page), { timeout: 15_000 }).not.toBeNull();
    await waitForDraftSettled(page);

    await page.reload();
    await expect(handoffHeading(page, SIGNER_2)).toBeVisible({ timeout: 20_000 });
    await expect(turnCounter(page)).toHaveText("Turno 1 de 2");

    // Luis firma primero y luego Ana: el orden se respeta de punta a punta.
    await signWholeTurn(page, 1, 10, false);
    await expect(handoffHeading(page, SIGNER_1)).toBeVisible();
    await expect(turnCounter(page)).toHaveText("Turno 2 de 2");
  });
});

test.describe("Firma ágil · «Revisar antes de descargar» bloquea y deja corregir", () => {
  test("un hueco sin firmante bloquea «Firmar y descargar» con el motivo; «Ir a corregirlo» lleva a la celda y, corregido, se descarga", async ({ page }) => {
    const docs = (await fourDocs()).slice(0, 2);
    await openSignAndUpload(page, docs);
    await page.getByRole("tab", { name: "Varios firmantes" }).click();
    await page.getByRole("button", { name: "Añadir firmante" }).click();
    await page.getByLabel("Nombre del firmante 1").fill(SIGNER_1);
    await placeSlotInEveryDocument(page, 2);
    await page.getByRole("button", { name: "1. Firmantes" }).click();

    // Ana no firma Anexo: dos toques en su celda (A -> B -> no firma).
    await page.getByRole("button", { name: "Ana en Anexo: Firma A" }).click();
    await page.getByRole("button", { name: "Ana en Anexo: Firma B" }).click();
    expect(await cellsOf(page)).toEqual(["A", ""]);
    await expect(page.getByText("Ana tiene un hueco de firma en Anexo, pero no está asignado a ese documento.")).toBeVisible();

    await goToSign(page);
    await signWholeTurn(page, 1, 10, true);
    await expect(page.getByRole("heading", { name: "Revisar antes de descargar" })).toBeVisible();
    const finish = page.getByRole("button", { name: "Firmar y descargar" });
    await expect(finish).toBeDisabled();
    await expect(page.getByText("Corrige primero lo marcado arriba.")).toBeVisible();
    const blocking = page.locator('[data-issue-severity="blocking"]').filter({ hasText: "Anexo" });
    await expect(blocking).toHaveCount(1);
    const box = await blocking.getByRole("button", { name: "Ir a corregirlo" }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);

    await blocking.getByRole("button", { name: "Ir a corregirlo" }).click();
    await expect(page.getByRole("grid", { name: /Quién firma cada documento/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ana en Anexo: no firma" })).toBeFocused();
    await page.getByRole("button", { name: "Ana en Anexo: no firma" }).click();
    // Ana ya firmó Contrato: el grupo crece a un documento que no vio y pide confirmarlo.
    const dialog = page.getByRole("dialog", { name: "¿Cambiar la asignación?" });
    await expect(dialog.getByText(/Ana tendrá que volver a confirmar la firma A/)).toBeVisible();
    await dialog.getByRole("button", { name: "Continuar" }).click();
    expect(await cellsOf(page)).toEqual(["A", "A"]);

    await goToSign(page);
    await signWholeTurn(page, 1, 20, true);
    await expect(page.getByRole("button", { name: "Firmar y descargar" })).toBeEnabled();
    await expect(page.getByText("Corrige primero lo marcado arriba.")).toHaveCount(0);
  });

  test("tocar una miniatura de la revisión lleva a esa página de ese documento", async ({ page }) => {
    await openSignAndUpload(page, (await fourDocs()).slice(0, 2));
    await page.getByRole("tab", { name: "Varios firmantes" }).click();
    await page.getByRole("button", { name: "Añadir firmante" }).click();
    await page.getByLabel("Nombre del firmante 1").fill(SIGNER_1);
    await placeSlotInEveryDocument(page, 2);
    await continueToSign(page);
    await signWholeTurn(page, 1, 10, true);
    await expect(page.getByRole("heading", { name: "Revisar antes de descargar" })).toBeVisible();
    // Las miniaturas llegan de una en una (cola de un documento a la vez).
    const tile = page.getByRole("button", { name: /Ir a la página 1 de Anexo/ });
    await expect(tile).toBeVisible();
    await expect(tile.locator("img")).toBeVisible({ timeout: 20_000 });
    const box = await tile.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await tile.click();
    await expect(page.getByRole("button", { name: "2. Anexo.pdf" })).toHaveAttribute("aria-current", "true");
    await expect(page.locator("[data-sequence-live]")).toContainText("Documento 2 de 2: Anexo.pdf");
  });
});
