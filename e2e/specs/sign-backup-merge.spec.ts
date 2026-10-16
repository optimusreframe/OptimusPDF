import { expect, test, type Page } from "@playwright/test";
import { isBenignEngineNoise } from "../helpers/engine";
import { FORGERIES, entry, forgedEntry, packageBuffer } from "../helpers/backup-packages";
import { fingerprint, makeColoredPdf, openSignWithPdf, openVault, readVault, startImport } from "../helpers/sign-vault-flow";

/**
 * U4.4-fix en navegador REAL (Chromium y webkit-ipad): lo que decide la interfaz al importar firmas.
 *  - D5: PNG forjados (IDAT corrupto, APNG, texto de 100 KB, 4096x4096) se rechazan con «Imagen no válida» usando el
 *    decodificador del navegador (`DecompressionStream` + `createImageBitmap`); la otra firma del paquete sí entra.
 *  - D2: un firmante renombrado ofrece «Mismos dibujos, datos distintos» y no pierde el cargo.
 *  - D3: un id que coincide con el de OTRA persona no ofrece «Reemplazar».
 *  - D4: otra pestaña cambia la firma entre la vista previa y «Reemplazar» -> aviso y nada escrito.
 * Headless siempre. `PW_PORT=3931`, build de produccion con `CSP_SKIP_UPGRADE_INSECURE=1`.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(120_000);

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !isBenignEngineNoise(message.text())) errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (!isBenignEngineNoise(error.message)) errors.push(error.message);
  });
  return errors;
}

/** Abre Firmar con el PDF y deja el baul con `seed` (importado desde un paquete real). */
async function openWithVault(page: Page, seed: Buffer | null): Promise<void> {
  await openSignWithPdf(page, await makeColoredPdf());
  await openVault(page);
  if (!seed) return;
  const sheet = await startImport(page, { name: "base.optimuspdf.zip", buffer: seed });
  await expect(sheet.getByRole("button", { name: /^Importar \d+ firmas?$/ })).toBeVisible({ timeout: 30_000 });
  await sheet.getByRole("button", { name: /^Importar \d+ firmas?$/ }).click();
  await expect(sheet.getByRole("button", { name: "Listo" })).toBeVisible({ timeout: 30_000 });
  await sheet.getByRole("button", { name: "Listo" }).click();
  await expect(sheet).toBeHidden();
}

test.describe("D5 — imagenes que el navegador no puede decodificar", () => {
  for (const [label, forge] of FORGERIES) {
    test(`${label}: «Imagen no válida», no se importa y la otra firma sí`, async ({ page }) => {
      const errors = trackErrors(page);
      await openWithVault(page, null);
      const buffer = await packageBuffer([forgedEntry("vault-bad", "Mala", forge), entry("vault-ok", "Buena", { sig: 4 })]);
      const sheet = await startImport(page, { name: "forjado.optimuspdf.zip", buffer });
      await expect(sheet.getByText("No se puede importar", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(sheet.getByText("Imagen no válida: está dañada o no es un PNG normal.")).toBeVisible();
      await expect(sheet.getByText("Nuevo", { exact: true })).toHaveCount(1);
      await sheet.getByRole("button", { name: "Importar 1 firma" }).click();
      await expect(sheet.getByText("1 importada, 1 omitida.").first()).toBeVisible({ timeout: 30_000 });
      expect((await readVault(page)).map((row) => row.signerName)).toEqual(["Buena"]);
      expect(errors).toEqual([]);
    });
  }

  test("el mismo paquete con la imagen SIN forjar entra entero (contraste: el rechazo es por la imagen, no por el paquete)", async ({ page }) => {
    await openWithVault(page, null);
    const buffer = await packageBuffer([entry("vault-bad", "Mala", { sig: 3 }), entry("vault-ok", "Buena", { sig: 4 })]);
    const sheet = await startImport(page, { name: "sano.optimuspdf.zip", buffer });
    await expect(sheet.getByText("Nuevo", { exact: true })).toHaveCount(2, { timeout: 30_000 });
    await sheet.getByRole("button", { name: "Importar 2 firmas" }).click();
    await expect(sheet.getByText("2 importadas, 0 omitidas.").first()).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("D2 — firmante renombrado, mismos dibujos", () => {
  test("«Mismos dibujos, datos distintos»: se conserva la que ya tienes por defecto; «Reemplazar» cambia el nombre y NO pierde el cargo", async ({ page }) => {
    const errors = trackErrors(page);
    await openWithVault(page, await packageBuffer([entry("vault-a", "Anita Pérez", { sig: 1, ini: 2, role: "Directora" })]));
    const before = await readVault(page);
    const file = await packageBuffer([entry("vault-a", "Ana Pérez", { sig: 1, ini: 2 })]);
    const sheet = await startImport(page, { name: "ana.optimuspdf.zip", buffer: file });
    await expect(sheet.getByText("Mismos dibujos, datos distintos")).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByText("Ya tienes estos mismos dibujos guardados como «Anita Pérez». Lo que cambia: el nombre.")).toBeVisible();
    await expect(sheet.getByText("con otra imagen")).toHaveCount(0);
    await expect(sheet.getByRole("radio", { name: "Conservar la que ya tienes" })).toHaveAttribute("aria-checked", "true");
    await expect(sheet.getByRole("button", { name: "No hay nada que importar" })).toBeDisabled();
    expect(fingerprint(await readVault(page))).toEqual(fingerprint(before)); // la vista previa no toca nada
    await sheet.getByRole("radio", { name: "Reemplazar" }).click();
    await expect(sheet.getByText(/No se pierde ninguna imagen ni el cargo/)).toBeVisible();
    await sheet.getByRole("button", { name: "Importar 1 firma" }).click();
    await expect(sheet.getByText("1 importada, 0 omitidas (1 reemplazada).").first()).toBeVisible({ timeout: 30_000 });
    const [after] = await readVault(page);
    expect(after).toMatchObject({ id: "vault-a", signerName: "Ana Pérez", role: "Directora" });
    expect([after.signatureHash, after.initialsHash]).toEqual([before[0].signatureHash, before[0].initialsHash]);
    expect(errors).toEqual([]);
  });
});

test.describe("D3 — un id que coincide con el de OTRA persona", () => {
  test("no se ofrece «Reemplazar»; «Conservar ambos» guarda a Ana con id nuevo y Luis queda intacto", async ({ page }) => {
    await openWithVault(page, await packageBuffer([entry("vault-l", "Luis", { sig: 5 })]));
    const luisBefore = (await readVault(page))[0];
    const file = await packageBuffer([entry("vault-l", "Ana", { sig: 1, ini: 2 })]);
    const sheet = await startImport(page, { name: "ana.optimuspdf.zip", buffer: file });
    await expect(sheet.getByText("Distinto", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByText("Ya hay otra firma guardada con el mismo identificador interno, la de «Luis».", { exact: false })).toBeVisible();
    await expect(sheet.getByRole("radio", { name: "Reemplazar" })).toHaveCount(0);
    await expect(sheet.getByRole("radio", { name: "Conservar ambos" })).toHaveAttribute("aria-checked", "true");
    await expect(sheet.getByRole("radio", { name: "Omitir" })).toBeVisible();
    await sheet.getByRole("button", { name: "Importar 1 firma" }).click();
    await expect(sheet.getByText("1 importada, 0 omitidas.").first()).toBeVisible({ timeout: 30_000 });
    const rows = await readVault(page);
    expect(rows.map((row) => row.signerName)).toEqual(["Ana", "Luis"]);
    const luisAfter = rows.find((row) => row.signerName === "Luis")!;
    expect([luisAfter.id, luisAfter.signatureHash]).toEqual([luisBefore.id, luisBefore.signatureHash]);
    expect(rows.find((row) => row.signerName === "Ana")!.id).not.toBe("vault-l");
  });
});

test.describe("D4 — otra pestaña cambia la firma mientras decides", () => {
  test("«Reemplazar» no descarta lo que otra pestaña añadio: avisa, no escribe y deja decidir de nuevo", async ({ page, context }) => {
    const errors = trackErrors(page);
    await openWithVault(page, await packageBuffer([entry("vault-a", "Ana Pérez", { sig: 1, ini: null })]));
    const file = await packageBuffer([entry("vault-a", "Ana Pérez", { sig: 1, ini: 2 })]);
    const sheet = await startImport(page, { name: "ana.optimuspdf.zip", buffer: file });
    await expect(sheet.getByRole("radio", { name: "Reemplazar" })).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });

    // «otra pestaña»: misma base de IndexedDB, le pone un cargo a la entrada
    const other = await context.newPage();
    await other.goto("/sign-pdf");
    await other.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("optimuspdf-signature-vault");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("signatures", "readwrite");
        const store = tx.objectStore("signatures");
        const get = store.get("vault-a");
        get.onsuccess = () => store.put({ ...get.result, role: "Cargo de otra pestaña" });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await other.close();
    const afterOtherTab = fingerprint(await readVault(page));

    await sheet.getByRole("button", { name: "Importar 1 firma" }).click();
    await expect(sheet.getByRole("status")).toContainText("Esta firma cambió mientras decidías; revisa de nuevo.", { timeout: 30_000 });
    expect(fingerprint(await readVault(page))).toEqual(afterOtherTab);
    expect((await readVault(page))[0].role).toBe("Cargo de otra pestaña");
    // la vista previa sigue y ahora SI vale
    await sheet.getByRole("button", { name: "Importar 1 firma" }).click();
    await expect(sheet.getByText("1 importada, 0 omitidas (1 reemplazada).").first()).toBeVisible({ timeout: 30_000 });
    const [after] = await readVault(page);
    expect(after.role).toBe("Cargo de otra pestaña"); // el cargo no se pierde
    expect(after.initialsHash).not.toBeNull();
    expect(errors).toEqual([]);
  });
});
