import type { Page } from "@playwright/test";
import { expect, openTool, runButton, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { MB, makePhotoSet, removePhotoSet, type PhotoSet } from "../helpers/photo-set";

/**
 * Imagenes a PDF · estimacion previa del tamano y avisos ANTES de generar.
 *
 * Defecto que cubre: con fotos sinteticas, solo 1 de 18 estimaciones caia dentro de +-15 % en Chromium (sobreestimaba hasta
 * +179 %) y 11 de 18 en WebKit; ahora la estimacion codifica 1-2 fotos de muestra con el motor real y extrapola por pixeles
 * (error medido <= 10 %), y da un rango «≈ a-b MB» cuando la incertidumbre es alta. Nada avisaba de > 25 MB antes de generar:
 * ahora avisa de ~20 MB (correo), ~100 MB (WhatsApp) y, con «Original» y mucho peso en iPhone/iPad, del riesgo de memoria.
 *
 * Fotos sinteticas de 48 Mpx (ninguna real).
 */

test.use({ locale: "es-ES" });

const PHOTOS = 22;
let set: PhotoSet;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  set = await makePhotoSet({ name: "estimate", count: PHOTOS, size: (index) => (index % 2 === 0 ? { width: 8064, height: 6048 } : { width: 6048, height: 8064 }), distinct: 3 });
});
test.afterAll(() => removePhotoSet(set));

async function open(page: Page): Promise<void> {
  await openTool(page, "jpg-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles(set.paths);
  await expect(page.locator("[data-image-quality]")).toBeVisible({ timeout: 60_000 });
}

const UNIT = { KB: 1 / 1024, MB: 1, GB: 1024 } as const;
function parseEstimate(text: string): { low: number; high: number } {
  // «≈ 40,0 MB frente a ≈ 348 MB» o «≈ 35,0-45,0 MB frente a ≈ 348 MB» (el primer «≈» es el del PDF final).
  const match = /≈\s*([\d.,]+)(?:\s*(KB|MB|GB))?(?:-([\d.,]+)\s*(KB|MB|GB))?\s*(?:(KB|MB|GB))?/.exec(text);
  if (!match) throw new Error(`sin estimacion en «${text}»`);
  const num = (value: string): number => Number(value.replace(",", "."));
  const highUnit = (match[4] ?? match[5] ?? match[2] ?? "MB") as keyof typeof UNIT;
  const lowUnit = (match[2] ?? highUnit) as keyof typeof UNIT;
  const low = num(match[1]) * UNIT[lowUnit];
  const high = match[3] ? num(match[3]) * UNIT[highUnit] : low;
  return { low, high };
}

async function pick(page: Page, name: string, value: string): Promise<void> {
  await page.getByRole("tablist", { name }).getByRole("tab", { name: value, exact: true }).click();
}

async function readEstimate(page: Page): Promise<{ low: number; high: number; text: string }> {
  const estimate = page.locator("[data-image-quality-estimate]");
  await expect(estimate).not.toContainText("Calculando", { timeout: 120_000 });
  await expect(estimate).toContainText("≈");
  const text = (await estimate.textContent()) ?? "";
  return { ...parseEstimate(text), text };
}

test("la estimacion cae dentro de +-15 % del PDF real en la gran mayoria de combinaciones y lo que se muestra es honesto (rango que contiene el peso real, o un numero a +-12 %)", async ({ page }) => {
  test.setTimeout(900_000);
  const rows: string[] = [];
  let within = 0;
  let inRange = 0;
  let cases = 0;
  for (const quality of ["Alta", "Equilibrada", "Compacta"]) {
    for (const perPage of ["1", "4", "10"]) {
      await open(page);
      await pick(page, "Calidad de imagen", quality);
      await pick(page, "Fotos por página", perPage);
      const estimate = await readEstimate(page);
      await runButton(page).click();
      const download = page.getByRole("button", { name: "Descargar", exact: true });
      await expect(download).toBeVisible({ timeout: 300_000 });
      const { bytes } = await downloadFile(page, () => download.click());
      const real = bytes.length / MB;
      const center = (estimate.low + estimate.high) / 2;
      const error = (center - real) / real;
      cases += 1;
      if (Math.abs(error) <= 0.15) within += 1;
      // Honestidad de lo que se muestra: con un RANGO («≈ a-b MB») el peso real debe caer dentro (margen de redondeo de la pantalla:
      // 0,1 MB y 3 %); con UN solo numero, a menos de ±12 %.
      const isRange = estimate.high - estimate.low > 0.05;
      if (isRange ? real >= estimate.low * 0.97 - 0.1 && real <= estimate.high * 1.03 + 0.1 : Math.abs(error) <= 0.12) inRange += 1;
      rows.push(`${quality} ${perPage}/hoja: estimado ${estimate.text.replace("Tamaño estimado del PDF: ", "").split(" frente")[0]} real ${real.toFixed(1)} MB (${(error * 100).toFixed(1)} %)`);
    }
  }
  test.info().annotations.push({ type: "estimacion", description: `${within}/${cases} dentro de ±15 %, ${inRange}/${cases} honestas\n${rows.join("\n")}` });
  console.log(`\n[image-optimize-estimate] ${test.info().project.name}\n${rows.join("\n")}\n${within}/${cases} dentro de ±15 %; ${inRange}/${cases} honestos (rango que contiene el peso real, o un numero a ±12 %)\n`);
  expect(within / cases, `estimaciones dentro de ±15 %: ${within}/${cases}`).toBeGreaterThanOrEqual(0.8);
  expect(inRange / cases, `estimaciones honestas (rango que contiene el peso real, o numero a ±12 %): ${inRange}/${cases}`).toBeGreaterThanOrEqual(0.9);
});

test("aviso PREVIO de peso: ~20 MB (correo), ~100 MB (WhatsApp) y, con «Original» en iPhone/iPad, riesgo de memoria", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await open(page);
  const warnings = page.locator("[data-image-quality-warning]");
  // «Compacta»: pocos MB, sin aviso.
  await pick(page, "Calidad de imagen", "Compacta");
  await readEstimate(page);
  await expect(warnings).toHaveCount(0);
  // «Alta» con 22 fotos de 48 Mpx: decenas de MB -> aviso de correo (> 20 MB) antes de generar.
  await pick(page, "Calidad de imagen", "Alta");
  const high = await readEstimate(page);
  expect((high.low + high.high) / 2).toBeGreaterThan(20);
  await expect(page.locator('[data-image-quality-warning="mail"], [data-image-quality-warning="huge"]')).toHaveCount(1);
  // «Original»: ~140 MB (22 fotos de ~6,4 MB) -> aviso de > 100 MB; en WebKit de iPad ademas el de memoria (> 120 MB de fotos).
  await pick(page, "Calidad de imagen", "Original");
  const original = await readEstimate(page);
  expect(original.high).toBeGreaterThan(100);
  await expect(page.locator('[data-image-quality-warning="huge"]')).toContainText("~100 MB");
  const ios = testInfo.project.name === "webkit-ipad" || testInfo.project.name === "webkit-mobile";
  await expect(page.locator('[data-image-quality-warning="memory"]')).toHaveCount(ios ? 1 : 0);
  if (ios) await expect(page.locator('[data-image-quality-warning="memory"]')).toContainText("«Alta» o «Equilibrada»");
  // Estimacion y avisos en UNA region viva.
  await expect(page.locator('[data-image-quality] [role="status"]')).toHaveCount(1);
  await expect(page.locator("[data-image-quality-live]")).toHaveAttribute("aria-live", "polite");
});

test("con fotos de mas de 12 Mpx, «Equilibrada» ofrece la linea «Alta conserva mas detalle al ampliar (≈ X MB)»", async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  await pick(page, "Calidad de imagen", "Equilibrada");
  const line = page.locator("[data-image-quality-high-detail]");
  await expect(line).toContainText("«Alta» conserva más detalle al ampliar (≈", { timeout: 120_000 });
  await pick(page, "Calidad de imagen", "Alta");
  await expect(line).toHaveCount(0);
});
