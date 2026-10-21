import { expect, test, type Page } from "@playwright/test";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import {
  ALL_PROFILES,
  IPAD_LANDSCAPE,
  IPAD_PORTRAIT,
  isHittable,
  makeContract,
  multiWithTwoSigners,
  openPalette,
  openSign,
  pdfFile,
  rectOf,
  safeSheetY,
  tightButtonPairs,
  waitSheetReady,
  type MobileProfile,
} from "../helpers/mobile-sign";
import { stillBox } from "../helpers/engine";

/**
 * Firmar PDF en movil e iPad · «Varios firmantes» (auditoria `docs/AUDITORIA-MOVIL-IPAD.md`):
 *  - SC-01  al cambiar de paso (stepper, «Continuar», turnos) la vista y el foco empiezan en el paso nuevo, con anuncio;
 *  - ER-02  la accion primaria («Continuar») esta a la vista y al alcance del pulgar sin bajar hasta el final del contenido;
 *  - GE-02 / GE-04  iPad vertical y horizontal: la hoja usa la mayor parte del ancho (el panel «Opciones» pasa a una hoja).
 * Tactil, headless; PDF sintetico. Corre en Chromium (perfiles iOS emulados) y en `webkit-ipad`.
 */
test.setTimeout(180_000);
const SG = SIGN_STRINGS.es;

/** Coloca un hueco de firma del firmante dado sobre la hoja visible (con la paleta abierta si esta plegada). */
async function placeSlot(page: Page, signer: string, fraction: number): Promise<void> {
  await page.getByRole("radio", { name: signer, exact: true }).click();
  const toolbar = await openPalette(page);
  await toolbar.getByRole("button", { name: "Firma", exact: true }).click();
  const host = page.locator('[data-canvas="host"]').first();
  await host.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const box = await stillBox(host.locator("img").first());
  if (!box) throw new Error("no se encontro la hoja");
  // Un punto de la hoja que SI se ve (bajo la barra de zoom y por encima de las barras fijas de abajo).
  const y = await safeSheetY(page, box.y, box.height, fraction);
  await page.mouse.move(box.x + 60, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, y + 40, { steps: 5 });
  await page.mouse.up();
}

async function stepperTop(page: Page): Promise<number> {
  return (await rectOf(page.getByRole("navigation", { name: SG.ceremonyTitle }))).top;
}

async function headerBottom(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector("header")?.getBoundingClientRect().bottom ?? 0);
}

for (const profile of ALL_PROFILES) {
  test.describe(`Firmar · pasos · ${profile.label}`, () => {
    test.use(profile.use);

    test("SC-01 · cada cambio de paso empieza arriba del paso nuevo y se anuncia", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      await multiWithTwoSigners(page);

      // (M6 · N8) Precondicion: se baja hasta el final del paso 1, de modo que en un TELEFONO la barra de pasos sale por arriba. Antes la
      // pagina ya estaba casi en su sitio (tras rellenar los nombres), la prueba no distinguia «se desplaza al paso nuevo» de «se queda
      // donde estaba» y la mutacion que quitaba el desplazamiento sobrevivia en 375 y 393 px (en tablet no: ahi la barra queda mas abajo).
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(300);
      if (profile.phone && (page.viewportSize()?.width ?? 0) < 700) {
        expect(await stepperTop(page), "precondicion: en el telefono la barra de pasos sale por arriba antes de cambiar de paso").toBeLessThan(-100);
      }

      // Paso 1 -> 2 desde el stepper: la barra de pasos queda justo bajo la cabecera.
      await page.getByRole("button", { name: "2. Documento" }).click();
      await waitSheetReady(page);
      await expect
        .poll(async () => {
          const top = await stepperTop(page);
          const header = await headerBottom(page);
          return top >= -1 && top <= header + 40;
        }, { message: "el stepper debe quedar al inicio de la vista tras «2. Documento»" })
        .toBe(true);
      await expect(page.locator("[data-step-announce]")).toContainText("Paso 2 de 3");

      await placeSlot(page, "Ana", 0.3);
      await placeSlot(page, "Luis", 0.5);

      // Al final del paso 2 se pulsa «Continuar»: el traspaso empieza arriba, con su boton a la vista.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.getByRole("button", { name: "Continuar" }).click();
      const handoff = page.getByRole("heading", { name: SG.handoffTitle("Ana") });
      await expect(handoff).toBeVisible();
      await expect
        .poll(async () => {
          const { top, bottom } = await rectOf(handoff);
          const vh = page.viewportSize()?.height ?? 0;
          return top >= 0 && bottom <= vh * 0.6;
        }, { message: "el traspaso «Pásale el dispositivo a Ana» debe verse en la mitad alta tras «Continuar»" })
        .toBe(true);
      const ready = page.getByRole("button", { name: SG.handoffReady }).first();
      await expect.poll(async () => (await isHittable(ready)).ok, { message: "«Listo, es mi turno» a la vista y sin nada encima" }).toBe(true);
      await expect(page.locator("[data-step-announce]")).toContainText("Paso 3 de 3");

      // «Listo, es mi turno»: la captura empieza arriba y el foco esta en su encabezado, a la vista.
      await ready.click();
      await expect(page.getByRole("button", { name: /Crear mi firma/ }).first()).toBeVisible();
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const active = document.activeElement as HTMLElement | null;
            if (!active || active === document.body) return "sin foco";
            const r = active.getBoundingClientRect();
            const vh = window.innerHeight;
            return r.top >= 0 && r.bottom <= vh * 0.6 ? "ok" : `fuera (${Math.round(r.top)}..${Math.round(r.bottom)} de ${vh})`;
          }),
        )
        .toBe("ok");
    });

    test("ER-02 · «Continuar» esta a la vista, al alcance del pulgar, sin bajar hasta el final", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      await multiWithTwoSigners(page);
      const next = page.getByRole("button", { name: "Continuar" });

      // Paso 1 (firmantes): con la barra de pasos arriba (lo que se ve al llegar), sin bajar hasta el final del paso.
      await page.getByRole("navigation", { name: SG.ceremonyTitle }).evaluate((element) => {
        element.scrollIntoView({ block: "start" });
        window.scrollBy(0, -80); // bajo la cabecera, como queda tras un cambio de paso
      });
      await expect.poll(async () => (await isHittable(next)).reason, { message: "paso 1: «Continuar» a la vista y sin nada encima" }).toBe("");
      const vh = page.viewportSize()?.height ?? 0;
      // Con el telefono (< 768 px) el boton esta pegado abajo (mitad baja); en tablet va al final de la barra de pasos (arriba).
      if (profile.phone && (page.viewportSize()?.width ?? 0) < 700) {
        expect((await rectOf(next)).top, "paso 1: «Continuar» en la mitad baja de la pantalla (pulgar)").toBeGreaterThan(vh * 0.5);
      }

      // Paso 2 (documento): la vista ya empieza arriba del paso, sin desplazarse mas.
      await page.getByRole("button", { name: "2. Documento" }).click();
      await waitSheetReady(page);
      await page.waitForTimeout(300);
      await expect.poll(async () => (await isHittable(next)).reason, { message: "paso 2: «Continuar» a la vista y sin nada encima" }).toBe("");
      if (profile.phone && (page.viewportSize()?.width ?? 0) < 700) {
        expect((await rectOf(next)).top, "paso 2: «Continuar» en la mitad baja de la pantalla").toBeGreaterThan(vh * 0.4);
      }
    });
  });
}

for (const profile of ALL_PROFILES) {
  test.describe(`Firmar · separacion de botones · ${profile.label}`, () => {
    test.use(profile.use);

    test("VI-07 · dos documentos: pestanas, pasos, hueco seleccionado y traspaso con botones a >= 8 px", async ({ page }) => {
      const docA = pdfFile(await makeContract("Contrato A"), "contratoA.pdf");
      const docB = pdfFile(await makeContract("Anexo B"), "anexoB.pdf");
      await openSign(page, [docA, docB]);
      await multiWithTwoSigners(page);
      const check = async (where: string) => {
        await page.waitForTimeout(300);
        const bad = (await tightButtonPairs(page, "main")).filter((pair) => !/Subir|Bajar/.test(pair));
        expect(bad, `${where}: pares de botones a menos de 8 px:\n${bad.join("\n")}`).toEqual([]);
      };
      await check("paso 1 (firmantes)");

      await page.getByRole("button", { name: "2. Documento" }).click();
      await waitSheetReady(page);
      await check("paso 2 (documento)");

      // Un hueco colocado y seleccionado: aparece la barra flotante del elemento.
      await placeSlot(page, "Ana", 0.3);
      await placeSlot(page, "Luis", 0.5);
      await check("paso 2 con un hueco seleccionado");

      await page.getByRole("button", { name: "Continuar" }).click();
      await expect(page.getByRole("heading", { name: SG.handoffTitle("Ana") })).toBeVisible();
      await check("paso 3 (traspaso)");
    });
  });
}

for (const profile of [IPAD_PORTRAIT, IPAD_LANDSCAPE] as const satisfies readonly MobileProfile[]) {
  test.describe(`Firmar · hoja grande en iPad · ${profile.label}`, () => {
    test.use(profile.use);

    test("GE-02 / GE-04 · «Solo yo»: la hoja ocupa la mayor parte del ancho y «Opciones» es una hoja", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      const host = await waitSheetReady(page);
      const vw = page.viewportSize()?.width ?? 0;
      const sheet = await rectOf(host);
      // Con la barra lateral global (horizontal) la columna util es el 70 % del ancho: la hoja ocupa >= 55 % de la ventana;
      // sin ella (vertical) >= 75 %.
      const wanted = profile.key === "ipadL" ? 0.55 : 0.75;
      expect(sheet.width / vw, `la hoja mide ${Math.round(sheet.width)} de ${vw} px`).toBeGreaterThanOrEqual(wanted);

      // El panel «Opciones» ya no es una columna fija: es una hoja que se abre con su boton.
      await expect(page.locator('aside[aria-label="Opciones"]')).toHaveCount(0);
      const open = page.getByRole("button", { name: "Opciones", exact: true });
      await expect(open).toBeVisible();
      await open.click();
      const dialog = page.getByRole("dialog", { name: "Opciones" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: SG.createSignature })).toBeVisible();
      await expect(dialog.getByText(SG.legalNote)).toBeVisible();
    });

    test("GE-02 / GE-04 · «Varios firmantes»: «Procesar» sigue a la vista y la hoja es grande", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      await multiWithTwoSigners(page);
      await page.getByRole("button", { name: "2. Documento" }).click();
      const host = await waitSheetReady(page);
      const vw = page.viewportSize()?.width ?? 0;
      const sheet = await rectOf(host);
      const wanted = profile.key === "ipadL" ? 0.55 : 0.75;
      expect(sheet.width / vw, `la hoja mide ${Math.round(sheet.width)} de ${vw} px`).toBeGreaterThanOrEqual(wanted);
      await expect(page.getByRole("button", { name: "Procesar" }).first()).toBeVisible();
    });
  });
}
