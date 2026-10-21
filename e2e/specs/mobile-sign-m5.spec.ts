import { expect, test, type Page } from "@playwright/test";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import {
  IPAD_LANDSCAPE,
  IPAD_MINI_744,
  IPAD_PORTRAIT,
  IPHONE_393,
  isHittable,
  makeContract,
  multiWithTwoSigners,
  openPalette,
  openSign,
  pdfFile,
  rectOf,
  safeSheetY,
  waitSheetReady,
} from "../helpers/mobile-sign";
import { boxOf, cdpOf, host, isChromium, newTouchContext, openSoloCanvasWithSignature, scrollY, touchDrag, visibleBand } from "../helpers/touch-gestures";
import { contrastOf } from "../helpers/touch-measure";
import { stillBox } from "../helpers/engine";

/**
 * M5 · correcciones tras la verificacion independiente movil/iPad (Firmar PDF y lo compartido):
 *  N5 «Continuar» en tablet siempre a la vista, N6 el auto-desplazamiento no saca la firma de la pantalla, N7 el foco tras cambiar
 *  de paso (tambien en WebKit), N9 el nombre del documento en la barra de zoom, N10 «Expandir barra lateral» de 44 px, el
 *  `scroll-padding` bajo la cabecera pegajosa (axe `target-size`) y VI-06 (el paso deshabilitado se lee).
 * Tactil, headless; PDF sintetico. Los gestos reales (CDP) solo en Chromium; el resto corre tambien en `webkit-ipad`.
 */
test.setTimeout(180_000);
const SG = SIGN_STRINGS.es;

async function placeSlot(page: Page, signer: string, fraction: number): Promise<void> {
  await page.getByRole("radio", { name: signer, exact: true }).click();
  const toolbar = await openPalette(page);
  await toolbar.getByRole("button", { name: "Firma", exact: true }).click();
  const host = page.locator('[data-canvas="host"]').first();
  await host.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const box = await stillBox(host.locator("img").first());
  if (!box) throw new Error("no se encontro la hoja");
  const y = await safeSheetY(page, box.y, box.height, fraction);
  await page.mouse.move(box.x + 60, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, y + 40, { steps: 5 });
  await page.mouse.up();
}

/* ------------------------------------------------------------------ *
 * N5 · «Continuar» en tablet
 * ------------------------------------------------------------------ */
for (const profile of [IPAD_MINI_744, IPAD_PORTRAIT, IPAD_LANDSCAPE]) {
  test.describe(`N5 · «Continuar» · ${profile.label}`, () => {
    test.use(profile.use);

    test("tras colocar los huecos (hoja trabajada) «Continuar» sigue a la vista, al borde de abajo y sin nada encima", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      await multiWithTwoSigners(page);
      await page.getByRole("button", { name: "2. Documento" }).click();
      await waitSheetReady(page);
      await placeSlot(page, "Ana", 0.3);
      await placeSlot(page, "Luis", 0.5);
      const next = page.getByRole("button", { name: "Continuar" });
      await expect(next).toHaveCount(1);
      const vh = page.viewportSize()?.height ?? 0;
      const vw = page.viewportSize()?.width ?? 0;

      // En tres desplazamientos distintos —al llegar al paso, en medio de la hoja y al final—: siempre a la vista y pulsable.
      for (const where of ["start", "middle", "end"] as const) {
        await page.evaluate((position) => {
          const max = document.documentElement.scrollHeight - window.innerHeight;
          window.scrollTo(0, position === "start" ? 0 : position === "middle" ? max / 2 : max);
        }, where);
        await page.waitForTimeout(300);
        await expect.poll(async () => (await isHittable(next)).reason, { message: `«Continuar» a la vista y sin nada encima (${where})` }).toBe("");
        const box = await rectOf(next);
        expect(box.height, "objetivo de 44 px").toBeGreaterThanOrEqual(43.5);
        // Con la barra de pasos fuera de la vista se ancla abajo, en el lado derecho (esquina del pulgar); al final del paso queda
        // en su sitio natural, sobre «Procesar».
        const anchored = (await page.locator("[data-step-actions]").count()) > 0;
        if (where === "middle") expect(anchored, "«Continuar» anclado abajo con la barra de pasos fuera de la vista").toBe(true);
        if (where === "middle") expect(box.top, "«Continuar» anclado en la mitad baja").toBeGreaterThan(vh * 0.4);
        expect(box.right, "sin salirse de la pantalla").toBeLessThanOrEqual(vw + 0.5);
      }

      // Con la cabecera de pasos al final del paso tambien se puede pulsar y pasa a la ceremonia.
      await next.click();
      await expect(page.getByRole("heading", { name: SG.handoffTitle("Ana") })).toBeVisible();
    });

    test("en el paso de firmantes tambien esta a la vista y no hay dos «Continuar»", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      await multiWithTwoSigners(page);
      const next = page.getByRole("button", { name: "Continuar" });
      await expect(next).toHaveCount(1);
      await expect.poll(async () => (await isHittable(next)).reason).toBe("");
      // Con la barra de pasos a la vista «Continuar» va en ella (arriba).
      await expect(page.locator("[data-step-actions]")).toHaveCount(0);
    });
  });
}

/* ------------------------------------------------------------------ *
 * N7 · el foco tras cambiar de paso (Chromium y WebKit)
 * ------------------------------------------------------------------ */
for (const profile of [IPHONE_393, IPAD_PORTRAIT]) {
  test.describe(`N7 · foco al cambiar de paso · ${profile.label}`, () => {
    test.use(profile.use);

    test("el foco va al paso actual de la barra de pasos, no a <main>", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())]);
      await multiWithTwoSigners(page);
      const focused = () =>
        page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return { tag: active?.tagName ?? "", current: active?.getAttribute("aria-current") ?? "", text: (active?.textContent ?? "").trim().slice(0, 30) };
        });
      await page.getByRole("button", { name: "2. Documento" }).click();
      await waitSheetReady(page);
      await expect.poll(focused, { message: "tras «2. Documento»" }).toEqual({ tag: "BUTTON", current: "step", text: "2. Documento" });
      await page.getByRole("button", { name: "1. Firmantes" }).click();
      await expect.poll(focused, { message: "tras «1. Firmantes»" }).toEqual({ tag: "BUTTON", current: "step", text: "1. Firmantes" });
      await expect(page.locator("[data-step-announce]")).toContainText("Paso 1 de 3");
    });
  });
}

/* ------------------------------------------------------------------ *
 * scroll-padding bajo la cabecera pegajosa
 * ------------------------------------------------------------------ */
test.describe("axe target-size · lo enfocado no queda bajo la cabecera pegajosa", () => {
  test.use(IPHONE_393.use);

  test("traer «2. Documento» a la vista (`scrollIntoView`, el teclado) la deja bajo la cabecera, no tapada por ella", async ({ page }) => {
    await openSign(page, [pdfFile(await makeContract())]);
    await multiWithTwoSigners(page);
    const step = page.getByRole("button", { name: "2. Documento" });
    // La barra de pasos queda 24 px por encima de la ventana y se trae con la alineacion minima (la de enfocar con Tab).
    await page.evaluate(() => {
      const nav = document.querySelector('[aria-current="step"]')!;
      window.scrollTo(0, nav.getBoundingClientRect().top + window.scrollY + 24);
    });
    await page.waitForTimeout(300);
    await step.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
    await page.waitForTimeout(300);
    const { top, headerBottom } = await page.evaluate(() => ({
      top: document.querySelector<HTMLElement>('[aria-current="step"]')?.getBoundingClientRect().top ?? -1,
      headerBottom: document.querySelector("header")?.getBoundingClientRect().bottom ?? 0,
    }));
    expect(top, `la barra de pasos (${Math.round(top)}) queda bajo la cabecera (${Math.round(headerBottom)})`).toBeGreaterThanOrEqual(headerBottom - 1);
  });
});

/* ------------------------------------------------------------------ *
 * N9 · nombre del documento en la barra de zoom
 * ------------------------------------------------------------------ */
test.describe("N9 · nombre del documento en la barra de zoom (iPhone 393 px, dos documentos)", () => {
  test.use(IPHONE_393.use);

  test("se recorta por el final con puntos suspensivos y el texto completo va en el título", async ({ page }) => {
    const docA = pdfFile(await makeContract("Contrato A"), "contratoA-arrendamiento.pdf");
    const docB = pdfFile(await makeContract("Anexo B"), "anexoB.pdf");
    await openSign(page, [docA, docB]);
    await multiWithTwoSigners(page);
    await page.getByRole("button", { name: "2. Documento" }).click();
    await waitSheetReady(page);
    const label = page.locator("[data-sequence-doc-label]");
    await expect(label).toBeVisible();
    const info = await label.evaluate((element) => {
      const name = element.querySelector<HTMLElement>("[data-doc-label-name]");
      const cs = name ? getComputedStyle(name) : null;
      return {
        hasName: !!name,
        hasTail: !!element.querySelector("[data-doc-label-tail]"),
        clientWidth: name?.clientWidth ?? 0,
        scrollWidth: name?.scrollWidth ?? 0,
        ellipsis: cs?.textOverflow === "ellipsis",
        text: name?.textContent ?? "",
        title: element.querySelector("[title]")?.getAttribute("title") ?? "",
      };
    });
    expect(info.hasName, "el nombre va en un solo tramo (sin cabeza/cola)").toBe(true);
    expect(info.hasTail).toBe(false);
    expect(info.ellipsis).toBe(true);
    expect(info.text).toBe("contratoA-arrendamiento.pdf");
    expect(info.title).toContain("contratoA-arrendamiento.pdf");
    // Se leen al menos ~5 letras del nombre (antes «c.A.pdf» con 8 px; 34 px con la tipografia ancha de Linux).
    expect(info.clientWidth, "ancho del nombre").toBeGreaterThanOrEqual(28);
  });
});

/* ------------------------------------------------------------------ *
 * N10 · «Expandir barra lateral» con el dedo
 * ------------------------------------------------------------------ */
test.describe("N10 · barra lateral plegada en el iPad horizontal", () => {
  test.use(IPAD_LANDSCAPE.use);

  test("«Expandir barra lateral» mide al menos 44×44 px (en Firmar y en PDF Pro)", async ({ page }) => {
    await openSign(page, [pdfFile(await makeContract())]);
    await waitSheetReady(page);
    const expand = page.getByRole("button", { name: "Expandir barra lateral" });
    await expect(expand).toBeVisible();
    const box = (await expand.boundingBox())!;
    expect(box.width, "ancho").toBeGreaterThanOrEqual(43.5);
    expect(box.height, "alto").toBeGreaterThanOrEqual(43.5);
    // Con la barra desplegada el boton de plegar sigue siendo de 44 px.
    await expand.click();
    const collapse = page.getByRole("button", { name: "Colapsar barra lateral" });
    await expect(collapse).toBeVisible();
    // La barra se ensancha con una transicion de 200 ms: se mide cuando deja de moverse.
    await expect.poll(async () => (await collapse.boundingBox())?.width ?? 0, { message: "ancho del boton de plegar" }).toBeGreaterThanOrEqual(43.5);
    expect((await collapse.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  });
});

/* ------------------------------------------------------------------ *
 * VI-06 · el paso deshabilitado se lee
 * ------------------------------------------------------------------ */
for (const theme of ["light", "dark"] as const) {
  test.describe(`VI-06 · paso «3. Firmar» deshabilitado · ${theme}`, () => {
    test.use({ ...IPHONE_393.use, colorScheme: theme });

    test("contraste de al menos 3:1, sin opacidad y con aspecto distinto al de un paso activo", async ({ page }) => {
      await openSign(page, [pdfFile(await makeContract())], { theme });
      await page.getByRole("tab", { name: "Varios firmantes" }).click();
      const disabled = page.getByRole("button", { name: "3. Firmar" });
      await expect(disabled).toBeDisabled();
      const reading = await contrastOf(disabled);
      expect(reading.opacity, "sin opacidad que apague el texto").toBe(1);
      expect(reading.ratio, `contraste ${reading.ratio.toFixed(2)}:1 (${reading.fg} sobre ${reading.bg})`).toBeGreaterThanOrEqual(3);
      const style = await disabled.evaluate((element) => ({ border: getComputedStyle(element).borderStyle, cursor: getComputedStyle(element).cursor }));
      expect(style.border, "borde discontinuo: no parece un boton activo").toContain("dashed");
      expect(style.cursor).toBe("not-allowed");
      const active = await page.locator('[aria-current="step"]').evaluate((element) => getComputedStyle(element).borderStyle);
      expect(active).not.toContain("dashed");
    });
  });
}

/* ------------------------------------------------------------------ *
 * N6 · el auto-desplazamiento se detiene en el borde de la hoja
 * ------------------------------------------------------------------ */
test.describe("N6 · arrastrar la firma al borde de abajo", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "El tacto por CDP solo existe en Chromium");

  test("la página deja de desplazarse al llegar al pie de la hoja y la firma no sale de la pantalla", async ({ browser }) => {
    const context = await newTouchContext(browser, "iphone15");
    const page = await context.newPage();
    try {
      const cdp = await cdpOf(page);
      await openSoloCanvasWithSignature(page, cdp, 2);
      await host(page).scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 40));
      await page.waitForTimeout(500);
      const slot = page.locator('.sign-field-box[data-drag-mode="move"]').first();
      const center = async () => {
        const box = await boxOf(slot);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, top: box.y, bottom: box.y + box.height };
      };
      // Se toca la firma para seleccionarla y se arrastra hasta el borde de abajo de la zona libre, sin soltar.
      const start = await center();
      await touchDrag(cdp, start, start, { steps: 1, stepMs: 16 });
      await page.waitForTimeout(400);
      const from = await center();
      const band = await visibleBand(page);
      const edge = { x: from.x, y: band.bottom - 12 };
      const y0 = await scrollY(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
      for (let step = 1; step <= 12; step += 1) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + ((edge.y - from.y) * step) / 12, id: 1 }] });
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(1500);
      const mid = await scrollY(page);
      await page.waitForTimeout(1500);
      const late = await scrollY(page);
      const sig = await center();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(300);
      const vh = page.viewportSize()?.height ?? 0;
      // Hubo desplazamiento (la hoja es mas alta que la zona libre) pero se detuvo: 1,5 s despues no se mueve mas.
      expect(Math.abs(late - mid), `la página siguió desplazándose (${mid - y0} → ${late - y0} px)`).toBeLessThanOrEqual(6);
      expect(sig.top, "la firma no sale por arriba").toBeGreaterThanOrEqual(0);
      expect(sig.bottom, `la firma (${Math.round(sig.bottom)}) no sale por abajo de la pantalla (${vh})`).toBeLessThanOrEqual(vh);
      expect(sig.bottom, "la firma queda en la zona libre (sobre las barras fijas)").toBeLessThanOrEqual(band.bottom + 24);
    } finally {
      await context.close();
    }
  });
});

void isChromium;
