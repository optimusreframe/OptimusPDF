import zlib from "node:zlib";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageText } from "../helpers/pdf-inspection";
import { renderPageToPixels } from "../helpers/pdf-render-inspection";

/**
 * «Editar PDF» de punta a punta (Wave 5 · U5), en escritorio (1280 x 800, raton)
 * y en movil (375 x 812, tactil): subir, editar el texto EXISTENTE, anadir una
 * imagen y una forma, aplanar una pagina (con su confirmacion), exportar y comprobar
 * el PDF descargado (texto con pdf.js, pixeles de lo anadido dentro de la imagen
 * de la pagina aplanada, resumen y avisos de la descarga), recargar y retomar el
 * borrador desde «Ver borradores».
 *
 * Headless siempre (modo por defecto de Playwright).
 */

test.setTimeout(240_000);

const PNG_GREEN: [number, number, number] = [0, 200, 60];

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 3; index += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Contrato pagina ${index + 1}`, { x: 50, y: 770, size: 24, font });
    page.drawText("Total a pagar: 1.250,00", { x: 50, y: 600, size: 14, font, color: rgb(0.8, 0.1, 0.1) });
  }
  return Buffer.from(await doc.save());
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function makePng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sheet = (page: Page) => page.locator("[data-page-index]");
const tool = (page: Page, name: string) => page.getByRole("toolbar").getByRole("button", { name, exact: true });
const block = (page: Page, text: string) => page.getByRole("button", { name: new RegExp(`^Texto: ${text}`) });

async function open(page: Page) {
  await page.goto("/edit-pdf");
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "informe.pdf",
    mimeType: "application/pdf",
    buffer: await makePdf(),
  });
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 30_000 });
}

async function showSheet(page: Page, offset: number) {
  await page.evaluate((top) => {
    const el = document.querySelector("[data-page-index]") as HTMLElement;
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - top);
  }, offset);
  await page.waitForTimeout(120);
}

async function at(page: Page, fx: number, fy: number) {
  const box = (await sheet(page).boundingBox())!;
  return { x: box.x + fx * box.width, y: box.y + fy * box.height };
}

async function mouseDrag(page: Page, from: [number, number], to: [number, number]) {
  const start = await at(page, ...from);
  const end = await at(page, ...to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

async function touchDrag(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps, id: 1 }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function expectNoOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

async function expectFocusNotOnBody(page: Page, label: string) {
  await expect
    .poll(async () => page.evaluate(() => document.activeElement === document.body), { message: label })
    .toBe(false);
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Cuenta pixeles verdes (la imagen anadida) de la pagina renderizada. */
async function greenPixels(bytes: Buffer, pageNumber: number): Promise<number> {
  const rendered = await renderPageToPixels(bytes, pageNumber, 1);
  let total = 0;
  for (let y = 0; y < rendered.height; y += 2) {
    for (let x = 0; x < rendered.width; x += 2) {
      const px = rendered.pixelAt(x, y);
      if (px.g > 150 && px.r < 60 && px.b < 110) total += 1;
    }
  }
  return total;
}

async function run(page: Page, kind: "desktop" | "mobile", cdp?: CDPSession) {
  const touch = kind === "mobile";
  const errors = collectErrors(page);
  await open(page);
  await expectNoOverflow(page, "al abrir");
  // Sin formularios ni paneles de opciones aparte, y sin los avisos fijos del editor antiguo.
  await expect(page.getByText("Añade encima, no reescribe lo que ya hay")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Opciones" })).toHaveCount(0);

  /* 1. Editar el texto EXISTENTE. */
  const total = block(page, "Total a pagar");
  await total.evaluate((el) => el.scrollIntoView({ block: "center" }));
  if (touch) {
    const box = (await total.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await total.dblclick();
  }
  const editor = page.getByRole("textbox", { name: "Editando el texto del bloque" });
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Pagado 99,00");
  await page.keyboard.press("Escape");
  await expect(block(page, "Pagado 99,00")).toBeVisible();
  await expectFocusNotOnBody(page, "tras editar el texto");

  /* 2. Una forma. */
  await showSheet(page, touch ? 150 : 110);
  if (touch) await tool(page, "Rectángulo").tap();
  else await tool(page, "Rectángulo").click();
  // Armar la herramienta suelta la seleccion: la barra del texto sale (con un muelle) antes de dibujar.
  await expect(page.locator("[data-floating-bar]")).toHaveCount(0);
  if (touch) {
    await touchDrag(cdp!, await at(page, 0.12, 0.2), await at(page, 0.5, 0.3));
  } else {
    await mouseDrag(page, [0.12, 0.2], [0.5, 0.3]);
  }
  await expect(page.locator('[role="button"][data-element-kind="shape"]')).toHaveCount(1);

  /* 3. Una imagen. */
  await page.locator("[data-image-input]").setInputFiles({
    name: "verde.png",
    mimeType: "image/png",
    buffer: makePng(120, 60, PNG_GREEN),
  });
  await expect(page.locator("[data-element-image]")).toHaveCount(1);
  await expect(page.locator("[data-workspace-live]")).toContainText("Imagen colocada");

  /* 4. Aplanar la pagina 1 (con confirmacion que explica las consecuencias). */
  const toggle = page.locator("[data-flatten-toggle]:visible");
  await expect(toggle).toHaveCount(1);
  if (touch) await toggle.tap();
  else await toggle.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("¿Aplanar la página 1?");
  await expect(dialog).toContainText("se convierte en una imagen");
  await expect(dialog).toContainText("no se puede deshacer");
  if (touch) await dialog.getByRole("button", { name: "Aplanar página" }).tap();
  else await dialog.getByRole("button", { name: "Aplanar página" }).click();
  await expect(page.locator("[data-flatten-chip]")).toHaveText("Se aplanará al exportar");
  await expect(toggle).toContainText("Quitar aplanado");
  await expectFocusNotOnBody(page, "tras aplanar");
  await expectNoOverflow(page, "tras aplanar");

  /* 5. Exportar: descarga con resumen y avisos. */
  await page.getByRole("button", { name: "Procesar" }).first().click();
  await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("[data-download-summary]")).toHaveText(
    "1 texto editado, 1 imagen añadida, 1 forma añadida, 1 página aplanada.",
  );
  const notices = page.locator("[data-download-notices]");
  await expect(notices).toContainText("Avisos de la exportación");
  await expect(notices).toContainText("Las páginas aplanadas ya no tienen texto seleccionable");
  // La edicion cubre la pagina 1, que se aplana: ya no se avisa de que el original sigue ahi.
  await expect(notices).not.toContainText("conserva el original");
  await expectNoOverflow(page, "descarga");
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Descargar" }).click();
  });
  expect(await getPageCount(bytes)).toBe(3);
  // Pagina 1 aplanada: ni el texto original ni el nuevo se extraen; lo anadido esta en la imagen.
  expect(await getPageText(bytes, 1)).toBe("");
  expect(await greenPixels(bytes, 1)).toBeGreaterThan(100);
  // Las demas paginas conservan su texto.
  expect(await getPageText(bytes, 2)).toContain("Contrato pagina 2");
  expect(await getPageText(bytes, 3)).toContain("Contrato pagina 3");

  /* 6. Recargar y retomar el borrador. */
  await page.reload();
  await page.locator("[data-edit-drafts-button]").click();
  const row = page.locator("[data-draft-id]");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("informe.pdf");
  await expect(row).toContainText("4 cambios");
  await expect(row).toContainText("3 páginas");
  for (const control of await row.getByRole("button").all()) {
    const box = (await control.boundingBox())!;
    expect(box.height, "objetivo tactil del borrador").toBeGreaterThanOrEqual(43.5);
  }
  if (touch) await row.getByRole("button", { name: "Retomar" }).tap();
  else await row.getByRole("button", { name: "Retomar" }).click();
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
  // El trabajo reaparece tal cual: aplanado, forma, imagen y el texto editado.
  await expect(page.locator("[data-flatten-chip]")).toBeVisible();
  await expect(page.locator('[role="button"][data-element-kind="shape"]')).toHaveCount(1);
  await expect(page.locator("[data-element-image]")).toHaveCount(1);
  await expect(page.locator("[data-edit-notices]")).toContainText("Recuperamos tu trabajo anterior");
  await expect(block(page, "Pagado 99,00")).toBeVisible();
  await expectNoOverflow(page, "borrador retomado");

  expect(errors).toEqual([]);
}

test.describe("edit-pdf de punta a punta", () => {
  test.describe("escritorio 1280 x 800", () => {
    test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
    test("subir, editar texto existente, imagen y forma, aplanar, exportar, recargar y retomar", async ({ page }) => {
      await run(page, "desktop");
    });
  });

  test.describe("movil 375 x 812 tactil", () => {
    test.use({ locale: "es-ES", viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    test("subir, editar texto existente, imagen y forma, aplanar, exportar, recargar y retomar", async ({ page, context }) => {
      const cdp = await context.newCDPSession(page);
      await run(page, "mobile", cdp);
    });
  });
});

test.describe("edit-pdf: avisos al abrir", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });

  async function openBuffer(page: Page, buffer: Buffer, name: string) {
    await page.goto("/edit-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/pdf", buffer });
  }

  test("PDF cifrado: hoja de contrasena con reintento claro, y abre con la correcta", async ({ page }) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([400, 300]).drawText("Secreto bien guardado", { x: 40, y: 200, size: 16, font });
    doc.encrypt({ userPassword: "clave-1234", ownerPassword: "owner-1234" });
    await openBuffer(page, Buffer.from(await doc.save()), "cifrado.pdf");

    const dialog = page.getByRole("dialog", { name: "Documento protegido con contraseña" });
    const input = dialog.getByLabel("Contraseña", { exact: true });
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("type", "password");

    await input.fill("equivocada");
    await dialog.getByRole("button", { name: "Abrir documento" }).click();
    await expect(dialog.locator("[data-password-message]")).toHaveText(/La contraseña no es correcta/);
    await expect(input).toBeFocused();

    await input.fill("clave-1234");
    await dialog.getByRole("button", { name: "Abrir documento" }).click();
    await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
    await expect(page.locator("[data-notice='protected']")).toContainText("la copia editada se guarda sin contraseña");
    await expectFocusNotOnBody(page, "tras abrir con contrasena");
    // Un documento protegido NO deja borrador (guardaria el contenido sin su cifrado).
    await expect(page.locator("[data-edit-notices]")).not.toContainText("Recuperamos");
  });

  test("cancelar la contrasena vuelve a la zona de carga", async ({ page }) => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.encrypt({ userPassword: "clave-1234", ownerPassword: "owner-1234" });
    await openBuffer(page, Buffer.from(await doc.save()), "cifrado.pdf");
    const dialog = page.getByRole("dialog", { name: "Documento protegido con contraseña" });
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Seleccionar|Elegir/ }).first()).toBeVisible();
    await expect(page.getByText("cifrado.pdf")).toHaveCount(0);
  });

  test("escaneo: aviso con la accion «Añadir texto»", async ({ page }) => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]);
    await openBuffer(page, Buffer.from(await doc.save()), "escaneo.pdf");
    await expect(page.locator("[data-analysis-status]")).toContainText("parece un escaneo", { timeout: 30_000 });
    await page.locator("[data-scanned-add-text]").click();
    await expect(tool(page, "Añadir texto")).toHaveAttribute("aria-pressed", "true");
  });
});

/* ------------------------------------------------------------------ *
 * Accesibilidad e interfaz (W5-U5, ronda de verificacion)
 * ------------------------------------------------------------------ */

async function makeDense(lines = 60, pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Resumen ejecutivo pagina ${p + 1}`, { x: 50, y: 790, size: 20, font });
    // Separadas lo bastante para que cada linea sea un bloque propio (una interlinea normal las fundiria en un parrafo).
    for (let i = 0; i < lines; i += 1) {
      page.drawText(`Linea numero ${i + 1} de la pagina ${p + 1} con texto`, { x: 50, y: 760 - i * 24, size: 9, font });
    }
  }
  return Buffer.from(await doc.save());
}

test.describe("edit-pdf: PDF danado y exportacion cancelada", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });

  test("cabecera %PDF con contenido danado: error claro con «Elegir otro archivo», sin spinner perpetuo", async ({ page }) => {
    await page.goto("/edit-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "roto.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ngarbage garbage\n"),
    });
    const failed = page.locator("[data-edit-failed]");
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await expect(failed).toContainText("parece dañado");
    await expect(page.locator("[data-render-state]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Procesar" }).first()).toBeDisabled();
    await failed.getByRole("button", { name: "Elegir otro archivo" }).click();
    await expect(page.getByText("roto.pdf")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Seleccionar|Elegir/ }).first()).toBeVisible();
  });

  test("cancelar la exportacion vuelve al editor con el trabajo intacto y un aviso NEUTRO (sin error ni «recuperamos»)", async ({ page, context }) => {
    await page.goto("/edit-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "largo.pdf",
      mimeType: "application/pdf",
      buffer: await makeDense(25, 30),
    });
    await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 40_000 });
    // Un cambio y una pagina aplanada (rasterizar es lo lento).
    await page.getByRole("button", { name: "Añadir texto" }).first().click();
    // En la zona libre del pie de la pagina (no sobre un bloque existente).
    await page.locator("[data-page-index='0']").click({ position: { x: 300, y: 1120 } });
    await page.keyboard.type("Nota");
    await page.keyboard.press("Escape");
    await page.locator("[data-flatten-toggle]:visible").click();
    await page.getByRole("dialog").getByRole("button", { name: "Aplanar página" }).click();
    await expect(page.locator("[data-flatten-chip]")).toBeVisible();

    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 8 });
    await page.getByRole("button", { name: "Procesar" }).first().click();
    const cancel = page.getByRole("button", { name: "Cancelar" });
    await expect(cancel).toBeVisible();
    // Con la CPU a 1/8 la hoja de procesamiento anima tan despacio que el boton nunca esta «quieto» para Playwright
    // (cada reintento recoloca la pagina): se pulsa el boton tal cual, que es lo que hace un clic real.
    await cancel.evaluate((element) => (element as HTMLButtonElement).click());
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

    await expect(page.locator("[data-flatten-chip]")).toBeVisible({ timeout: 30_000 });
    // (El anunciador de rutas de Next tambien es un role=alert, siempre vacio: se ignora.)
    await expect(page.locator('[role="alert"]:not(next-route-announcer):not(#__next-route-announcer__)').filter({ hasText: /\S/ })).toHaveCount(0);
    await expect(page.getByText("No se pudo completar")).toHaveCount(0);
    await expect(page.getByText("Exportación cancelada")).toBeVisible();
    await expect(page.getByText("Exportación cancelada").locator("xpath=ancestor-or-self::*[@role='status']")).toHaveCount(1);
    await expect(page.locator("[data-notice='restored']")).toHaveCount(0);
    await expect(page.getByText("Recuperamos tu trabajo anterior")).toHaveCount(0);
    // El texto añadido sigue ahí: el trabajo estaba intacto.
    await expect(page.getByRole("button", { name: /^Texto añadido: Nota/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Procesar" }).first()).toBeEnabled();
  });
});

test.describe("edit-pdf: teclado y barra flotante (escritorio)", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });

  test("una sola parada de Tab para toda la capa de bloques; flechas, Inicio y Fin recorren; Tab sale del documento", async ({ page }) => {
    await page.goto("/edit-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "denso.pdf", mimeType: "application/pdf", buffer: await makeDense(30) });
    await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 40_000 });
    const total = await page.locator('[data-element-kind="text"]').count();
    expect(total).toBeGreaterThan(10);
    await expect(page.locator('[data-element-kind="text"][tabindex="0"]')).toHaveCount(1);

    const first = page.locator('[data-element-kind="text"]').first();
    await first.focus();
    const idOf = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.elementId ?? null);
    const startId = await idOf();
    await page.keyboard.press("ArrowDown");
    const second = await idOf();
    expect(second).not.toBe(startId);
    await page.keyboard.press("End");
    const last = await idOf();
    await expect(page.locator('[data-element-kind="text"][tabindex="0"]')).toHaveCount(1);
    expect(await page.locator(`[data-element-id="${last}"]`).getAttribute("tabindex")).toBe("0");
    await page.keyboard.press("Home");
    expect(await idOf()).toBe(startId);

    // Tab sale de la capa en UNA pulsacion (no recorre los 60 bloques).
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.elementKind ?? null)).not.toBe("text");
    // La descripcion accesible nombra los atajos, incluido Alt + flechas.
    const describedBy = await first.getAttribute("aria-describedby");
    expect(await page.locator(`[id="${describedBy}"]`).textContent()).toContain("Alt");
  });

  test("la barra de escritorio es UNA fila de ~520 px: no cubre el bloque ni deja a un vecino tapado por completo (D2)", async ({ page }) => {
    await page.goto("/edit-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "denso.pdf", mimeType: "application/pdf", buffer: await makeDense(30) });
    await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 40_000 });
    const total = await page.locator('[data-element-kind="text"]').count();
    let fully = 0;
    let coversSelected = 0;
    let tested = 0;
    for (let index = 2; index < Math.min(total, 22); index += 1) {
      const block = page.locator('[data-element-kind="text"]').nth(index);
      await block.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await block.click();
      const bar = page.locator('[data-floating-bar][aria-label="Opciones del texto"]');
      await expect(bar).toBeVisible();
      const metrics = await page.evaluate((i) => {
        const bar = document.querySelector('[data-floating-bar]')!.getBoundingClientRect();
        const blocks = [...document.querySelectorAll('[data-element-kind="text"]')];
        const area = (a: DOMRect, b: DOMRect) => {
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          return w > 0 && h > 0 ? w * h : 0;
        };
        let full = 0;
        blocks.forEach((el, k) => {
          if (k === i) return;
          const r = el.getBoundingClientRect();
          if (area(bar, r) >= 0.9 * r.width * r.height) full += 1;
        });
        const own = (blocks[i].querySelector("span") as HTMLElement).getBoundingClientRect();
        return { width: bar.width, full, selected: area(bar, own) > 0, rows: document.querySelector("[data-bar-compact]")?.getAttribute("data-bar-layout"), paragraphs: document.querySelectorAll("[data-floating-bar] p").length };
      }, index);
      expect(metrics.rows).toBe("row");
      expect(metrics.width).toBeLessThanOrEqual(560);
      expect(metrics.paragraphs).toBe(0);
      fully += metrics.full > 0 ? 1 : 0;
      coversSelected += metrics.selected ? 1 : 0;
      tested += 1;
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
    expect(tested).toBeGreaterThan(10);
    expect(coversSelected).toBe(0);
    expect(fully / tested).toBeLessThanOrEqual(0.1);
  });

  test("aplanar desde «Más»: cancelar devuelve el foco a «Más»; confirmar lo deja en el control de la pagina aplanada (nunca <body>) (N3)", async ({ page }) => {
    await page.goto("/edit-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "denso.pdf", mimeType: "application/pdf", buffer: await makeDense(8) });
    await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 40_000 });
    const activeKind = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return "body";
        if (el.dataset.barAction === "more") return "more";
        if (el.hasAttribute("data-flatten-toggle")) return "toggle";
        return el.tagName;
      });
    await page.locator('[data-element-kind="text"]').nth(2).click();
    const bar = page.locator('[data-floating-bar][aria-label="Opciones del texto"]');
    await bar.locator('[data-bar-action="more"]').click();
    await page.getByRole("dialog", { name: "Más opciones del texto" }).getByRole("button", { name: "Aplanar página" }).click();
    const confirm = page.getByRole("dialog", { name: /¿Aplanar la página 1\?/ });
    await confirm.getByRole("button", { name: "Cancelar" }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(activeKind, { message: "tras cancelar" }).toBe("more");

    await bar.locator('[data-bar-action="more"]').click();
    await page.getByRole("dialog", { name: "Más opciones del texto" }).getByRole("button", { name: "Aplanar página" }).click();
    await page.getByRole("dialog", { name: /¿Aplanar la página 1\?/ }).getByRole("button", { name: "Aplanar página" }).click();
    await expect(page.locator("[data-flatten-chip]")).toBeVisible();
    await expect.poll(activeKind, { message: "tras confirmar", timeout: 5000 }).not.toBe("body");
  });

  test("Esc suelta la seleccion tras dibujar (30 veces seguidas, sin esperas a ciegas)", async ({ page }) => {
    await page.goto("/edit-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "denso.pdf", mimeType: "application/pdf", buffer: await makeDense(10) });
    await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 40_000 });
    await page.evaluate(() => {
      const el = document.querySelector("[data-page-index]") as HTMLElement;
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 110);
    });
    for (let i = 0; i < 30; i += 1) {
      await tool(page, "Rectángulo").click();
      await mouseDrag(page, [0.6, 0.3 + (i % 5) * 0.02], [0.8, 0.4 + (i % 5) * 0.02]);
      // Sin esperar a que el foco llegue al elemento: justo despues del trazo.
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-floating-bar][aria-label="Opciones del elemento"]')).toBeHidden();
    }
    await expect(page.locator('[role="button"][data-element-kind="shape"]')).toHaveCount(30);
    // Una sola parada de Tab para los 30 elementos.
    await expect(page.locator('[role="button"][data-element-kind="shape"][tabindex="0"]')).toHaveCount(1);
  });
});

test.describe("edit-pdf: barra flotante junto a la barra de navegacion (375 x 812 tactil)", () => {
  test.use({ locale: "es-ES", viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("con el bloque a media pantalla y la nav sin fijar, ningun control de la barra queda bajo la nav ni la paleta", async ({ page }) => {
    await page.goto("/edit-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "denso.pdf", mimeType: "application/pdf", buffer: await makeDense(25) });
    await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 40_000 });
    const block = page.getByRole("button", { name: /^Texto: Resumen ejecutivo/ });
    for (const target of [200, 320, 450, 560]) {
      await page.evaluate((top) => {
        const el = [...document.querySelectorAll('[data-element-kind="text"]')].find((e) => (e.getAttribute("aria-label") ?? "").startsWith("Texto: Resumen"))!;
        window.scrollBy(0, el.getBoundingClientRect().top - top);
      }, target);
      await page.waitForTimeout(250);
      await block.tap();
      const bar = page.locator('[data-floating-bar][aria-label="Opciones del texto"]');
      await expect(bar).toBeVisible();
      await page.waitForTimeout(450); // la barra entra con un muelle
      const covered = await page.evaluate(() => {
        const bar = document.querySelector('[data-floating-bar][aria-label="Opciones del texto"]')!;
        const out: string[] = [];
        for (const control of bar.querySelectorAll("button, select, input")) {
          const r = control.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (!(hit === control || control.contains(hit))) out.push(`${control.getAttribute("aria-label") ?? control.tagName} <- ${hit?.tagName}`);
        }
        return out;
      });
      expect(covered, `bloque a ${target}px`).toEqual([]);
      await page.keyboard.press("Escape");
    }
  });
});

/* ------------------------------------------------------------------ *
 * Barra compacta en movil y un solo Ctrl+Z por texto (W5-U5, ronda 2)
 * ------------------------------------------------------------------ */

async function makeGradientDoc(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Resumen ejecutivo", { x: 50, y: 790, size: 20, font });
  // Degradado horizontal fuerte detras de la linea: el fondo NO es de un solo color.
  for (let i = 0; i < 60; i += 1) {
    page.drawRectangle({ x: 40 + i * 8, y: 600, width: 8.5, height: 34, color: rgb(i / 60, 0.4, 1 - i / 60) });
  }
  page.drawText("Texto sobre un degradado de colores", { x: 60, y: 612, size: 14, font, color: rgb(1, 1, 1) });
  for (let i = 0; i < 6; i += 1) page.drawText(`Linea suelta ${i + 1}`, { x: 50, y: 500 - i * 40, size: 12, font });
  return Buffer.from(await doc.save());
}

for (const size of [
  { w: 375, h: 812 },
  { w: 360, h: 640 },
]) {
  test.describe(`edit-pdf: barra compacta en ${size.w} x ${size.h} tactil`, () => {
    test.use({ locale: "es-ES", viewport: { width: size.w, height: size.h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

    test("el centro del bloque seleccionado sigue siendo el bloque, la barra mide una fraccion y los avisos van a una hoja", async ({ page }) => {
      await page.goto("/edit-pdf");
      await page.locator('input[type="file"]').first().setInputFiles({ name: "grad.pdf", mimeType: "application/pdf", buffer: await makeGradientDoc() });
      await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 40_000 });
      const names = await page.locator('[data-element-kind="text"]').evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
      expect(names.length).toBeGreaterThan(4);
      for (const [index, name] of names.entries()) {
        for (const keyboard of [0, 260]) {
          if (keyboard) {
            await page.evaluate((kb) => {
              const h = window.innerHeight - kb;
              Object.defineProperty(window.visualViewport!, "height", { configurable: true, get: () => h });
              Object.defineProperty(window.visualViewport!, "offsetTop", { configurable: true, get: () => 0 });
              window.visualViewport!.dispatchEvent(new Event("resize"));
            }, keyboard);
          }
          const visible = size.h - keyboard;
          await page.evaluate(
            ({ i, top }) => {
              const el = document.querySelectorAll('[data-element-kind="text"]')[i];
              window.scrollBy(0, el.getBoundingClientRect().top - top);
            },
            { i: index, top: Math.round(visible * 0.35) },
          );
          await page.waitForTimeout(200);
          const center = await page.evaluate((i) => {
            const r = document.querySelectorAll('[data-element-kind="text"]')[i].getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }, index);
          const reachable = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-element-kind="text"]'), center);
          if (!reachable || center.y < 80 || center.y > visible - 110) continue; // otro elemento fijo lo cubre antes de seleccionarlo
          await page.touchscreen.tap(center.x, center.y);
          const bar = page.locator('[data-floating-bar][aria-label="Opciones del texto"]');
          await expect(bar).toBeVisible();
          await page.waitForTimeout(500);
          const result = await page.evaluate((i) => {
            const bar = document.querySelector('[data-floating-bar][aria-label="Opciones del texto"]')!;
            const block = document.querySelectorAll('[data-element-kind="text"]')[i].getBoundingClientRect();
            const hit = document.elementFromPoint(block.x + block.width / 2, block.y + block.height / 2);
            const small: string[] = [];
            const hidden: string[] = [];
            for (const control of bar.querySelectorAll("button, select, input")) {
              const r = control.getBoundingClientRect();
              if (r.width < 2 || control.closest(".sr-only")) continue;
              if (r.width < 43.5 || r.height < 43.5) small.push(control.getAttribute("aria-label") ?? control.tagName);
              const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              if (!(top === control || control.contains(top))) hidden.push(control.getAttribute("aria-label") ?? control.tagName);
            }
            // (D1) Los tiradores (externos o interiores) siguen siendo alcanzables: su centro no lo tapa la barra.
            const handlesCovered: string[] = [];
            for (const handle of document.querySelectorAll("[data-resize-handle]")) {
              const r = handle.getBoundingClientRect();
              const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              if (!(top === handle || handle.contains(top))) handlesCovered.push(handle.getAttribute("data-resize-handle") ?? "?");
            }
            return {
              blockHit: !!hit?.closest('[data-element-kind="text"]'),
              barHeight: bar.getBoundingClientRect().height,
              small,
              hidden,
              handlesCovered,
            };
          }, index);
          const label = `${name.slice(0, 30)} (${size.w}x${size.h}${keyboard ? " + teclado" : ""})`;
          expect(result.blockHit, `centro tapado: ${label}`).toBe(true);
          expect(result.barHeight, `barra alta: ${label}`).toBeLessThan(130);
          expect(result.small, `controles pequenos: ${label}`).toEqual([]);
          expect(result.hidden, `controles tapados: ${label}`).toEqual([]);
          expect(result.handlesCovered, `tiradores tapados: ${label}`).toEqual([]);
          await page.keyboard.press("Escape");
        }
      }
    });

    test("el aviso de fondo no uniforme esta en la hoja «Más opciones», no dentro de la barra", async ({ page }) => {
      await page.goto("/edit-pdf");
      await page.locator('input[type="file"]').first().setInputFiles({ name: "grad.pdf", mimeType: "application/pdf", buffer: await makeGradientDoc() });
      const grad = page.getByRole("button", { name: /^Texto: Texto sobre un degradado/ });
      await expect(grad).toBeVisible({ timeout: 40_000 });
      await grad.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const box = (await grad.boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      const bar = page.locator('[data-floating-bar][aria-label="Opciones del texto"]');
      await expect(bar).toBeVisible();
      await expect(bar).not.toContainText("fondo no es de un solo color");
      await bar.locator('[data-bar-action="more"]').tap();
      const dialog = page.getByRole("dialog", { name: "Más opciones del texto" });
      await expect(dialog).toContainText("El fondo no es de un solo color");
      await expect(dialog).toContainText("El texto original puede seguir existiendo");
      await dialog.getByRole("button", { name: "Cerrar" }).first().tap();
      await expect(dialog).toHaveCount(0);
    });
  });
}

test.describe("edit-pdf: un texto escrito = un solo Ctrl+Z (N2)", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });

  test("escribir varios caracteres y deshacer UNA vez devuelve el bloque al original; rehacer, a lo ultimo escrito", async ({ page }) => {
    await page.goto("/edit-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "p.pdf", mimeType: "application/pdf", buffer: await makeDense(5) });
    const block = page.getByRole("button", { name: /^Texto: Resumen ejecutivo/ });
    await expect(block).toBeVisible({ timeout: 40_000 });
    await block.dblclick();
    const editor = page.getByRole("textbox", { name: "Editando el texto del bloque" });
    await expect(editor).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Titulo nuevo", { delay: 20 });
    await expect(editor).toHaveText("Titulo nuevo");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /^Texto: Titulo nuevo/ })).toBeVisible();
    // UN Ctrl+Z: nada de «T» a medias ni de un primer Ctrl+Z invisible.
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(page.getByRole("button", { name: /^Texto: Resumen ejecutivo/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Texto: Titulo/ })).toHaveCount(0);
    await expect(page.locator("[data-workspace-live]")).toContainText("Deshecho");
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(page.getByRole("button", { name: /^Texto: Titulo nuevo/ })).toBeVisible();
    await expect(page.locator("[data-workspace-live]")).toContainText("Rehecho");
  });
});
