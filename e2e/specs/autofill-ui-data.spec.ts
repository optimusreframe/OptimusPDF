import { test, type Locator, type Page } from "@playwright/test";
import JSZip from "jszip";
import { downloadFile } from "../helpers/downloads";
import {
  CLIENT,
  FAKE_ONLY_REASON,
  OTHER_CLIENT,
  POLICY_SPECS,
  TEST_TIMEOUT,
  USE_REAL_ENGINE,
  addFileSource,
  expect,
  installAutofillFakes,
  makeClaimForm,
  makePolicyPdf,
  openAutofill,
  openSignWith,
  readAndReview,
  sheet,
} from "../helpers/autofill-ui";
import { es } from "../../src/lib/locales/es";

/**
 * Perfil del cliente: «Borrar datos locales» de Ajustes los borra y el respaldo («Respaldo y traslado») los exporta e importa
 * con la interfaz de verdad (cifrado opcional, vista previa sin mostrar valores, fusion). Chromium y `webkit-ipad`. Headless.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(TEST_TIMEOUT * 3);

/** Sin hoja de compartir del sistema: la descarga clasica (en `webkit-ipad` el puntero es tactil y `share` existe y pide un toque mas). */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
      Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    } catch {
      /* no se puede redefinir */
    }
  });
});

const copy = es.settings.backup;
const KEY = "optimuspdf.clientProfiles";
const PASSWORD = "clave-segura-1";

/** La casilla es un input sin apariencia bajo su etiqueta: se alterna pulsando la etiqueta (la hoja se desplaza hasta ella). */
async function setBox(dialog: Locator, name: string | RegExp, wanted: boolean): Promise<void> {
  const box = dialog.getByRole("checkbox", { name });
  if ((await box.isChecked()) !== wanted) await dialog.locator("label").filter({ hasText: name }).first().click();
  await expect(box).toBeChecked({ checked: wanted });
}

const fillButton = (page: Page, count: number) => sheet(page).getByRole("button", { name: `Rellenar ${count} campos` });

/** Crea el perfil de UN cliente desde la interfaz (leer una poliza falsa, «Guardar como perfil», rellenar). */
async function createProfile(page: Page, profileName: string, specs = POLICY_SPECS, count = 3) {
  await openSignWith(page, `reclamo-${profileName.length}.pdf`, await makeClaimForm(`FORM ${profileName}`));
  await openAutofill(page);
  await addFileSource(page, "poliza.pdf", await makePolicyPdf());
  await readAndReview(page);
  await sheet(page).getByRole("checkbox", { name: "Guardar como perfil" }).check({ force: true });
  await sheet(page).getByLabel("Nombre del perfil").fill(profileName);
  await fillButton(page, count).click();
  await expect(page.locator("[data-autofill-status]")).toContainText(`Perfil «${profileName}» guardado.`);
  void specs;
}

const storedProfiles = (page: Page) => page.evaluate((key) => window.localStorage.getItem(key), KEY);

test("«Borrar datos locales» de Ajustes elimina los perfiles guardados", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, { byName: { "poliza.pdf": POLICY_SPECS } });
  await createProfile(page, "Pérez Soto, María");
  expect(await storedProfiles(page)).toContain(CLIENT.name);

  await page.goto("/settings");
  await page.getByRole("button", { name: es.settings.clearData }).click();
  await expect(page.getByText(es.settings.cleared)).toBeVisible();
  expect(await storedProfiles(page)).toBeNull();

  // En Firmar PDF la lista de perfiles queda vacia.
  await openSignWith(page, "reclamo.pdf", await makeClaimForm());
  await openAutofill(page);
  await sheet(page).getByRole("button", { name: /^Usar un perfil guardado/ }).click();
  await expect(sheet(page).locator("[data-autofill-profiles-empty]")).toBeVisible();
});

test("gestion de perfiles: renombrar, corregir un dato, quitarlo y borrar el perfil con confirmacion", async ({ page }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  await installAutofillFakes(page, { byName: { "poliza.pdf": POLICY_SPECS } });
  await createProfile(page, "Pérez Soto, María");
  await openSignWith(page, "otro.pdf", await makeClaimForm("OTRO"));
  await openAutofill(page);
  await sheet(page).getByRole("button", { name: /^Usar un perfil guardado/ }).click();
  await sheet(page).getByRole("button", { name: "Editar el perfil Pérez Soto, María" }).click();
  await sheet(page).getByLabel("Nombre del perfil").fill("Pérez Ruiz, María");
  await sheet(page).getByRole("button", { name: "Renombrar" }).click();
  await expect(sheet(page).locator("[data-autofill-profile]")).toContainText("Pérez Ruiz, María");
  const phone = sheet(page).locator('[data-autofill-profile-value="phone"]');
  await phone.getByRole("textbox").fill("555-0777");
  await phone.getByRole("button", { name: "Guardar Teléfono" }).click();
  await expect.poll(async () => (await storedProfiles(page)) ?? "").toContain("555-0777");
  await sheet(page).locator('[data-autofill-profile-value="policyNumber"]').getByRole("button", { name: /^Quitar/ }).click();
  await expect.poll(async () => (await storedProfiles(page)) ?? "").not.toContain(CLIENT.policy);
  await sheet(page).getByRole("button", { name: "Borrar el perfil Pérez Ruiz, María" }).click();
  await page.getByRole("button", { name: "Borrar perfil" }).click();
  await expect(sheet(page).locator("[data-autofill-profiles-empty]")).toBeVisible();
  expect(await storedProfiles(page)).toBeNull();
});

async function seedTwoProfiles(page: Page) {
  await page.goto("/settings");
  await page.evaluate(
    ([key, client, other]) => {
      const at = "2026-10-20T10:00:00.000Z";
      const value = (text: string, source = "extracted") => ({ value: text, updatedAt: at, source });
      window.localStorage.setItem(
        key as string,
        JSON.stringify({
          version: 1,
          profiles: [
            { id: "cp-e2e-ana", name: "Pérez Soto, María", updatedAt: at, values: { insuredName1: value((client as { name: string }).name), phone: value((client as { phone: string }).phone, "typed"), roofMaterial: value("teja demo") } },
            { id: "cp-e2e-luis", name: "Gómez Rivas, Luis", updatedAt: "2026-10-21T10:00:00.000Z", values: { insuredName1: value((other as { name: string }).name), policyNumber: value((other as { policy: string }).policy) } },
          ],
        }),
      );
    },
    [KEY, CLIENT, OTHER_CLIENT] as const,
  );
  await page.reload();
}

test("respaldo: exportar con contrasena -> borrar todo -> importar; el paquete cifrado no deja ver los datos y la vista previa no los muestra", async ({ page }) => {
  await seedTwoProfiles(page);
  await page.getByRole("button", { name: copy.exportAction }).click();
  const dialog = page.getByRole("dialog").first();
  const check = dialog.getByRole("checkbox", { name: /^Perfiles de cliente \(2 perfiles de cliente\)$/ });
  await expect(check).toBeChecked();
  // Los datos de clientes recomiendan cifrar: la contrasena viene marcada.
  await expect(dialog.getByRole("checkbox", { name: copy.protect })).toBeChecked();
  await dialog.getByLabel(copy.password, { exact: true }).fill(PASSWORD);
  await dialog.getByLabel(copy.confirmPassword, { exact: true }).fill(PASSWORD);
  const file = await downloadFile(page, async () => {
    await dialog.getByRole("button", { name: copy.exportConfirm }).click();
  });
  const bytes = file.bytes;
  // Cifrado: ni el nombre del cliente ni «client-profiles» salen en claro.
  expect(bytes.includes(Buffer.from(CLIENT.name))).toBe(false);
  expect(bytes.includes(Buffer.from("Pérez Soto"))).toBe(false);
  await page.keyboard.press("Escape");

  // Borrar TODO con la interfaz.
  await page.goto("/settings");
  await page.getByRole("button", { name: es.settings.clearData }).click();
  await expect(page.getByText(es.settings.cleared)).toBeVisible();
  expect(await storedProfiles(page)).toBeNull();

  // Importar: contrasena mala rechazada sin escribir; buena, vista previa sin valores.
  await page.getByRole("button", { name: copy.importAction }).click();
  const importDialog = page.getByRole("dialog").first();
  await importDialog.locator("[data-backup-file-input]").setInputFiles({ name: file.filename, mimeType: "application/zip", buffer: file.bytes });
  await importDialog.getByLabel(copy.passwordLabel).fill("clave-mala-9");
  await importDialog.getByRole("button", { name: copy.passwordOpen }).click();
  await expect(importDialog.getByText(copy.wrongPassword)).toBeVisible();
  expect(await storedProfiles(page)).toBeNull();
  await importDialog.getByLabel(copy.passwordLabel).fill(PASSWORD);
  await importDialog.getByRole("button", { name: copy.passwordOpen }).click();
  const profilesModule = importDialog.locator('[data-backup-module="clientProfiles"]');
  await expect(profilesModule).toBeVisible();
  await expect(profilesModule.locator("[data-backup-item]")).toHaveCount(2);
  await expect(profilesModule.locator('[data-backup-item][data-status="new"]')).toHaveCount(2);
  await expect(profilesModule).toContainText("Pérez Soto, María");
  await expect(profilesModule).not.toContainText(CLIENT.name);
  await expect(profilesModule).not.toContainText(CLIENT.phone);
  await importDialog.locator("[data-backup-confirm]").click();
  await expect(importDialog.locator("[data-backup-result]")).toContainText("Perfiles de cliente: 2 importados.");
  const restored = JSON.parse((await storedProfiles(page)) as string) as { profiles: { id: string; name: string; values: Record<string, { value: string; source: string }> }[] };
  expect(restored.profiles.map((p) => p.id).sort()).toEqual(["cp-e2e-ana", "cp-e2e-luis"]);
  const ana = restored.profiles.find((p) => p.id === "cp-e2e-ana")!;
  expect(ana.values.phone).toMatchObject({ value: CLIENT.phone, source: "typed" });
  // La clave que el registro no conoce se conserva.
  expect(ana.values.roofMaterial.value).toBe("teja demo");
});

test("respaldo en claro de un solo perfil: el paquete lleva `client-profiles/profiles.json`; reimportarlo es «Ya lo tienes»", async ({ page }) => {
  await seedTwoProfiles(page);
  await page.getByRole("button", { name: copy.exportAction }).click();
  const dialog = page.getByRole("dialog").first();
  // Quita a Luis del paquete y la contrasena (en claro).
  await setBox(dialog.getByRole("group", { name: copy.profilesListLegend }), /^Gómez Rivas, Luis/, false);
  await setBox(dialog, copy.protect, false);
  await expect(dialog.locator("[data-backup-summary]")).toContainText("1 perfil de cliente");
  const file = await downloadFile(page, async () => {
    await dialog.getByRole("button", { name: copy.exportConfirm }).click();
  });
  const zip = await JSZip.loadAsync(file.bytes);
  const json = JSON.parse(await zip.file("client-profiles/profiles.json")!.async("string")) as { version: number; profiles: { id: string }[] };
  expect(json.version).toBe(1);
  expect(json.profiles.map((p) => p.id)).toEqual(["cp-e2e-ana"]);
  expect(Object.keys(zip.files).some((name) => name.includes("luis"))).toBe(false);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: copy.importAction }).click();
  const importDialog = page.getByRole("dialog").first();
  await importDialog.locator("[data-backup-file-input]").setInputFiles({ name: file.filename, mimeType: "application/zip", buffer: file.bytes });
  const profilesModule = importDialog.locator('[data-backup-module="clientProfiles"]');
  await expect(profilesModule.locator('[data-backup-item][data-status="identical"]')).toHaveCount(1);
  await expect(importDialog.locator("[data-backup-confirm]")).toBeDisabled();
});
