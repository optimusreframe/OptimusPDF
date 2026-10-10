import zlib from "node:zlib";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, degrees } from "@cantoo/pdf-lib";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageOperatorCounts, getPageText } from "../helpers/pdf-inspection";
import { renderPageToPixels, type RenderedPage, type Rgba } from "../helpers/pdf-render-inspection";

/**
 * Imagen, formas, resaltado y marca en el lienzo inline (Wave 5 · U4b) y la
 * navegacion del documento: dibujar cada herramienta con el raton y con el dedo,
 * insertar un PNG, editar un bloque de texto existente, mover/redimensionar,
 * deshacer/rehacer, paginas con miniaturas y zoom, y EXPORTAR comprobando con
 * pdf.js (texto, imagen) y pixel a pixel (cada elemento cae donde se vio).
 * Un PDF de 5 paginas con tamanos distintos y una con /Rotate 90; otro de 300
 * paginas para la memoria y el tiempo.
 *
 * Headless siempre (modo por defecto de Playwright).
 */

test.setTimeout(240_000);

const RED: Rgba = { r: 0xe1, g: 0x1d, b: 0x48, a: 255 };
const PNG_GREEN: [number, number, number] = [0, 160, 90];

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [595, 842],
  [842, 595],
  [400, 300],
  [612, 792], // con /Rotate 90: la vista es 792 x 612
  [300, 500],
];

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  SIZES.forEach(([width, height], index) => {
    const page = doc.addPage([width, height]);
    page.drawText(`Pagina ${index + 1} titulo del documento`, { x: 40, y: height - 60, size: 20, font });
    page.drawText(`Linea de texto editable numero ${index + 1}`, { x: 40, y: height - 100, size: 12, font });
    page.drawText(`Segundo parrafo de la pagina ${index + 1}`, { x: 40, y: height - 140, size: 12, font });
    if (index === 3) page.setRotation(degrees(90));
  });
  return Buffer.from(await doc.save());
}

async function makeLongPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const [width, height] = SIZES[index % SIZES.length];
    const page = doc.addPage([width, height]);
    page.drawText(`Pagina ${index + 1} de ${pages}`, { x: 40, y: height - 60, size: 20, font });
    page.drawText(`Texto de relleno de la pagina ${index + 1}`, { x: 40, y: height - 100, size: 12, font });
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

/** PNG RGB de un solo color (sin dependencias). */
function makePng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // profundidad
  header[9] = 2; // RGB
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

/* ------------------------------------------------------------------ *
 * Ayudantes de pagina
 * ------------------------------------------------------------------ */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function open(page: Page, buffer: Buffer, name = "documento.pdf") {
  await page.goto("/edit-pdf");
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/pdf", buffer });
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 30_000 });
}

const sheet = (page: Page) => page.locator("[data-page-index]");

async function sheetBox(page: Page) {
  const box = await sheet(page).boundingBox();
  if (!box) throw new Error("la hoja no tiene caja");
  return box;
}

/** Desplaza la ventana para que la hoja empiece justo debajo de la barra pegajosa. */
async function showSheet(page: Page, offset = 110) {
  await page.evaluate((top) => {
    const el = document.querySelector("[data-page-index]") as HTMLElement;
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - top);
  }, offset);
  await page.waitForTimeout(80);
}

/** Posicion de pantalla de una fraccion de la hoja (se vuelve a medir en cada llamada). */
async function at(page: Page, fx: number, fy: number) {
  const box = await sheetBox(page);
  return { x: box.x + fx * box.width, y: box.y + fy * box.height };
}

async function dragOnSheet(page: Page, from: [number, number], to: [number, number]) {
  const start = await at(page, ...from);
  const end = await at(page, ...to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

const tool = (page: Page, name: string) => page.getByRole("toolbar").getByRole("button", { name, exact: true });
const elementBar = (page: Page) => page.locator('[data-floating-bar][aria-label="Opciones del elemento"]');
const live = (page: Page) => page.locator("[data-workspace-live]");

async function expectFocusNotOnBody(page: Page, label: string) {
  await expect
    .poll(async () => page.evaluate(() => document.activeElement === document.body), { message: label })
    .toBe(false);
}

async function expectNoOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

function distance(a: Rgba, b: Rgba): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/** Algun pixel a menos de `radius` px del punto es del color esperado (los bordes finos se suavizan). */
function expectColorNear(rendered: RenderedPage, x: number, y: number, expected: Rgba, label: string, radius = 3, tolerance = 40) {
  let best = Number.POSITIVE_INFINITY;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const px = Math.round(x) + dx;
      const py = Math.round(y) + dy;
      if (px < 0 || py < 0 || px >= rendered.width || py >= rendered.height) continue;
      best = Math.min(best, distance(rendered.pixelAt(px, py), expected));
    }
  }
  expect(best, `${label}: ningun pixel cerca de (${Math.round(x)}, ${Math.round(y)}) tiene el color esperado`).toBeLessThanOrEqual(tolerance);
}

async function exportPdf(page: Page): Promise<Buffer> {
  await page.getByRole("button", { name: "Procesar" }).first().click();
  await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 90_000 });
  return downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Descargar" }).click();
  });
}

/* ------------------------------------------------------------------ *
 * Escritorio
 * ------------------------------------------------------------------ */

test.describe("edit-pdf: imagen, formas y navegacion (escritorio)", () => {
  test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });

  test("dibujar cada herramienta, imagen, texto existente, mover, deshacer, navegar y exportar", async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, await makePdf());
    await showSheet(page);

    // Pista de herramienta: siempre montada, pero NO es una region viva propia (W5-U5: una sola region viva por editor).
    await expect(page.locator("[data-tool-hint]")).not.toHaveAttribute("role", /.+/);
    await expect(page.locator("[data-workspace-live]")).toHaveAttribute("role", "status");
    await expect(page.locator('[data-edit-workspace] [role="status"]')).toHaveCount(1);

    /* 1. Rectangulo con el raton: vista previa en vivo y elemento seleccionado con su barra. */
    await tool(page, "Rectángulo").click();
    await expect(page.locator("[data-tool-hint]")).toContainText("Arrastra sobre la página");
    const from = await at(page, 0.1, 0.25);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    const mid = await at(page, 0.3, 0.3);
    await page.mouse.move(mid.x, mid.y, { steps: 6 });
    await expect(page.locator('[data-element-draft] [data-shape-visual="rect"]')).toHaveCount(1);
    const to = await at(page, 0.35, 0.31);
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('[data-element-draft]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Rectángulo \(1 de 1\)/ })).toBeFocused();
    await expect(elementBar(page)).toBeVisible();
    await expect(tool(page, "Seleccionar")).toHaveAttribute("aria-pressed", "true");

    /* 2. Relleno desde la barra, sin formulario aparte. */
    await elementBar(page).getByRole("button", { name: "Rellenar la forma" }).click();
    await expect(elementBar(page).getByRole("button", { name: "Opacidad 30 %" })).toHaveAttribute("aria-pressed", "true");
    await expectFocusNotOnBody(page, "tras el relleno");

    /* 3. Resto de herramientas. */
    // Al elegir una herramienta la barra del elemento seleccionado se va: durante su salida NO debe recibir punteros
    // (ahi empieza el arrastre del siguiente dibujo; con la maquina cargada tapaba el punto de partida y no se dibujaba).
    const probe = page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          let leakedPointer = false;
          const end = performance.now() + 500;
          const tick = () => {
            for (const bar of document.querySelectorAll("[data-floating-bar]")) {
              // Solo cuenta una barra que SE VA (sin seleccion no hay ninguna que deba recibir punteros).
              if (!document.querySelector("[data-selected]") && getComputedStyle(bar).pointerEvents !== "none") leakedPointer = true;
            }
            if (performance.now() < end) requestAnimationFrame(tick);
            else resolve(leakedPointer);
          };
          requestAnimationFrame(tick);
        }),
    );
    await tool(page, "Elipse").click();
    expect(await probe, "la barra que se va aun recibia punteros").toBe(false);
    await dragOnSheet(page, [0.1, 0.34], [0.3, 0.42]);
    await tool(page, "Línea").click();
    await dragOnSheet(page, [0.4, 0.34], [0.7, 0.44]);
    await tool(page, "Resaltado").click();
    // El resaltado se dibuja ENCIMA del texto existente (que no capta el puntero mientras la herramienta esta armada).
    await dragOnSheet(page, [0.06, 0.105], [0.55, 0.135]);
    await tool(page, "Marca").click();
    const markAt = await at(page, 0.8, 0.3);
    await page.mouse.click(markAt.x, markAt.y);
    await expect(elementBar(page).getByRole("button", { name: "Aspa" })).toBeVisible();
    await expect(page.locator('[role="button"][data-element-kind="shape"]')).toHaveCount(5);

    /* 4. Cambiar el simbolo de la marca desde su barra. */
    await elementBar(page).getByRole("button", { name: "Aspa" }).click();
    await expect(page.getByRole("button", { name: /^Marca: Aspa/ })).toBeVisible();

    /* 5. Imagen: PNG verde por el selector de archivos; llega centrada, seleccionada, con barra. */
    await page.locator("[data-image-input]").setInputFiles({ name: "verde.png", mimeType: "image/png", buffer: makePng(80, 40, PNG_GREEN) });
    const image = page.locator("[data-element-image]");
    await expect(image).toHaveCount(1);
    await expect(live(page)).toContainText("Imagen colocada");
    await expect(elementBar(page).getByRole("button", { name: "Duplicar" })).toBeVisible();

    /* 6. Mover la imagen con el raton y redimensionarla con un tirador (proporcion fija). */
    const before = (await image.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 - 30, { steps: 5 });
    await page.mouse.up();
    const moved = (await image.boundingBox())!;
    expect(Math.round(moved.x - before.x)).toBe(40);
    expect(Math.round(moved.y - before.y)).toBe(-30);
    const handle = page.locator('[data-resize-handle="se"]');
    const handleBox = (await handle.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 60, handleBox.y + handleBox.height / 2 + 5, { steps: 5 });
    await page.mouse.up();
    const resized = (await image.boundingBox())!;
    expect(resized.width).toBeGreaterThan(moved.width + 40);
    expect(resized.height / resized.width).toBeCloseTo(moved.height / moved.width, 1);

    /* 7. Deshacer y rehacer el redimensionado y el movimiento. */
    await page.getByRole("button", { name: "Deshacer", exact: true }).click();
    expect(Math.round((await image.boundingBox())!.width)).toBe(Math.round(moved.width));
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    expect(Math.round((await image.boundingBox())!.width)).toBe(Math.round(resized.width));
    await expectFocusNotOnBody(page, "tras deshacer y rehacer");

    /* 8. Editar un bloque de texto EXISTENTE (conviven con las formas). */
    const block = page.getByRole("button", { name: /^Texto: Segundo parrafo de la pagina 1/ });
    await block.dblclick();
    const editor = page.getByRole("textbox", { name: "Editando el texto del bloque" });
    await expect(editor).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Parrafo reescrito en vivo");
    await page.keyboard.press("Escape");
    await expectFocusNotOnBody(page, "tras editar el texto");

    /* 9. El resaltado no impide seleccionar el texto que cubre: gana el texto. */
    const line1 = page.getByRole("button", { name: /^Texto: Linea de texto editable numero 1/ });
    await line1.click();
    await expect(line1).toHaveAttribute("aria-pressed", "true");
    await expect(elementBar(page)).toBeHidden();

    /* 10. Duplicar y borrar con teclado. */
    await tool(page, "Elipse").click();
    await dragOnSheet(page, [0.7, 0.2], [0.9, 0.24]);
    await elementBar(page).getByRole("button", { name: "Duplicar" }).click();
    await expect(live(page)).toContainText("Elipse duplicado");
    await page.keyboard.press("Delete");
    await expect(page.locator('[role="button"][data-element-kind="shape"]')).toHaveCount(6);
    await expectFocusNotOnBody(page, "tras borrar");

    /* 11. Navegacion: miniaturas, paginador, ir a la pagina N, zoom. */
    const strip = page.locator("[data-page-strip]");
    await expect(strip).toBeVisible();
    await expect(page.locator("[data-page-thumb]")).toHaveCount(5);
    await expect(page.locator('[data-page-thumb="4"][data-thumb-loaded]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-page-thumb="0"]')).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-page-thumb="0"]')).toHaveAccessibleName(/cambio/);

    await page.getByRole("button", { name: "Página siguiente" }).click();
    await expect(sheet(page)).toHaveAttribute("data-page-index", "1");
    await expect(live(page)).toHaveText("Página 2 de 5. Sin cambios.");
    await page.locator('[data-page-thumb="3"]').click();
    await expect(sheet(page)).toHaveAttribute("data-page-index", "3");
    await expect(page.locator('[data-page-thumb="3"]')).toHaveAttribute("aria-current", "page");
    await expectFocusNotOnBody(page, "tras ir a la miniatura");

    // Pagina 4: /Rotate 90 (la vista es apaisada): dibujar un rectangulo en la vista.
    await showSheet(page);
    const rotatedBox = await sheetBox(page);
    expect(rotatedBox.width).toBeGreaterThan(rotatedBox.height);
    await tool(page, "Rectángulo").click();
    await dragOnSheet(page, [0.2, 0.3], [0.5, 0.6]);

    const goTo = page.getByRole("textbox", { name: "Ir a la página" });
    await goTo.fill("5");
    await goTo.press("Enter");
    await expect(sheet(page)).toHaveAttribute("data-page-index", "4");

    // Zoom con el boton y con Ctrl + rueda.
    await page.getByRole("button", { name: "Acercar" }).click();
    await expect(page.getByText("125 %")).toBeVisible();
    const widthBefore = (await sheetBox(page)).width;
    await sheet(page).hover();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await expect.poll(async () => (await sheetBox(page)).width).toBeGreaterThan(widthBefore);
    // La rueda da un zoom continuo: los botones lo devuelven, paso a paso, al 100 %.
    for (let index = 0; index < 6; index += 1) {
      if ((await page.getByRole("button", { name: "Alejar" }).getAttribute("aria-disabled")) === "true") break;
      await page.getByRole("button", { name: "Alejar" }).click();
    }
    await expect(page.getByText("100 %")).toBeVisible();
    await expectNoOverflow(page, "tras navegar");

    await page.keyboard.press("Escape");
    await page.locator("[data-page-thumb]").nth(0).click();
    await expect(sheet(page)).toHaveAttribute("data-page-index", "0");
    await expectNoOverflow(page, "de vuelta en la pagina 1");

    // Estado del documento antes de exportar: posicion REAL de la imagen en pantalla.
    await showSheet(page);
    const sheetNow = await sheetBox(page);
    const imageNow = (await page.locator("[data-element-image]").boundingBox())!;
    const imageFraction = {
      x: (imageNow.x - sheetNow.x) / sheetNow.width,
      y: (imageNow.y - sheetNow.y) / sheetNow.height,
      width: imageNow.width / sheetNow.width,
      height: imageNow.height / sheetNow.height,
    };

    /* 12. Exportar y comprobar el PDF con pdf.js y pixel a pixel. */
    const bytes = await exportPdf(page);
    expect(await getPageCount(bytes)).toBe(5);
    const text1 = await getPageText(bytes, 1);
    expect(text1).toContain("Parrafo reescrito en vivo");
    expect(text1).toContain("Pagina 1 titulo del documento");
    const counts = await getPageOperatorCounts(bytes, 1);
    expect(counts.imagePaintOps).toBe(1); // la imagen se incrusta (no se rasteriza la pagina)
    expect(counts.textPaintOps).toBeGreaterThan(0);
    expect(await getPageText(bytes, 2)).toContain("Pagina 2 titulo del documento"); // el resto, intacto

    const p1 = await renderPageToPixels(bytes, 1, 1);
    const [w1, h1] = [p1.width, p1.height];
    expect([w1, h1]).toEqual([595, 842]);
    // Rectangulo (relleno azul por defecto al activar el relleno; borde rojo): borde izquierdo.
    expectColorNear(p1, 0.1 * w1, 0.28 * h1, RED, "borde del rectangulo");
    // Elipse: su extremo izquierdo.
    expectColorNear(p1, 0.1 * w1, 0.38 * h1, RED, "extremo de la elipse");
    // Linea: su punto medio.
    expectColorNear(p1, 0.55 * w1, 0.39 * h1, RED, "punto medio de la linea");
    // Resaltado: amarillo translucido sobre blanco, a la derecha del texto.
    expectColorNear(p1, 0.5 * w1, 0.12 * h1, { r: 255, g: 249, b: 200, a: 255 }, "resaltado", 2, 14);
    // Marca (aspa): su centro cae sobre un trazo rojo.
    expectColorNear(p1, 0.8 * w1, 0.3 * h1, RED, "aspa de la marca", 6);
    // Imagen: verde en su centro y en dos esquinas interiores; blanco justo fuera.
    const green: Rgba = { r: PNG_GREEN[0], g: PNG_GREEN[1], b: PNG_GREEN[2], a: 255 };
    const cx = (imageFraction.x + imageFraction.width / 2) * w1;
    const cy = (imageFraction.y + imageFraction.height / 2) * h1;
    expect(distance(p1.pixelAt(Math.round(cx), Math.round(cy)), green)).toBeLessThan(20);
    expect(distance(p1.pixelAt(Math.round(imageFraction.x * w1 + 3), Math.round(imageFraction.y * h1 + 3)), green)).toBeLessThan(20);
    expect(distance(p1.pixelAt(Math.round((imageFraction.x + imageFraction.width) * w1 - 3), Math.round((imageFraction.y + imageFraction.height) * h1 - 3)), green)).toBeLessThan(20);
    expect(distance(p1.pixelAt(Math.round(imageFraction.x * w1 - 4), Math.round(cy)), green)).toBeGreaterThan(60);

    // Pagina 4 (/Rotate 90): el rectangulo cae donde se vio, en la vista apaisada.
    const p4 = await renderPageToPixels(bytes, 4, 1);
    expect([p4.width, p4.height]).toEqual([792, 612]);
    expectColorNear(p4, 0.2 * p4.width, 0.45 * p4.height, RED, "rectangulo de la pagina girada");
    expectColorNear(p4, 0.5 * p4.width, 0.45 * p4.height, RED, "borde derecho en la pagina girada");

    expect(errors).toEqual([]);
  });

  test("soltar una imagen sobre la pagina y los avisos de un archivo no valido", async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, await makePdf());
    await showSheet(page);

    // Archivo que no es una imagen (aunque se llame .png): aviso amable, nada se anade.
    await tool(page, "Imagen").click();
    await page.locator("[data-image-input]").setInputFiles({ name: "falso.png", mimeType: "image/png", buffer: Buffer.from("esto no es un PNG") });
    await expect(page.locator("[data-tool-hint]")).toHaveText("Solo se aceptan imágenes PNG o JPG.");
    await expect(page.locator("[data-element-image]")).toHaveCount(0);
    await expect(tool(page, "Imagen")).toHaveAttribute("aria-pressed", "true");

    // Una firma de PNG con datos dañados: se detecta al descodificar.
    const broken = Buffer.concat([makePng(10, 10, [1, 2, 3]).subarray(0, 40), Buffer.from("roto")]);
    await page.locator("[data-image-input]").setInputFiles({ name: "roto.png", mimeType: "image/png", buffer: broken });
    await expect(page.locator("[data-tool-hint]")).toHaveText("No se pudo leer esa imagen: parece dañada. Prueba con otra.");

    // Soltar un PNG bueno con DataTransfer real sobre la hoja.
    const dataTransfer = await page.evaluateHandle((bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "caida.png", { type: "image/png" }));
      return transfer;
    }, [...makePng(60, 30, PNG_GREEN)]);
    const target = await at(page, 0.5, 0.35);
    await sheet(page).dispatchEvent("dragover", { dataTransfer, clientX: target.x, clientY: target.y });
    await expect(sheet(page)).toHaveClass(/outline-signal/);
    await sheet(page).dispatchEvent("drop", { dataTransfer, clientX: target.x, clientY: target.y });
    const image = page.locator("[data-element-image]");
    await expect(image).toHaveCount(1);
    const box = (await image.boundingBox())!;
    const sheetBoxNow = await sheetBox(page);
    // Centrada en el punto soltado.
    expect(Math.abs(box.x + box.width / 2 - target.x)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - target.y)).toBeLessThan(2);
    expect(box.width / sheetBoxNow.width).toBeCloseTo(0.3, 2);
    await expect(sheet(page)).not.toHaveClass(/outline-signal/);
    await expect(tool(page, "Seleccionar")).toHaveAttribute("aria-pressed", "true");
    expect(errors).toEqual([]);
  });

  test("seleccionar con un clic un elemento ya creado, mover un extremo de la linea, borrar con el teclado y deshacer", async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, await makePdf());
    await showSheet(page);

    await tool(page, "Rectángulo").click();
    await dragOnSheet(page, [0.1, 0.25], [0.4, 0.33]);
    await tool(page, "Línea").click();
    await dragOnSheet(page, [0.5, 0.3], [0.8, 0.3]);
    // Esc suelta la seleccion; el foco pasa a la hoja, no a <body>.
    await page.keyboard.press("Escape");
    await expect(elementBar(page)).toBeHidden();
    await expectFocusNotOnBody(page, "tras soltar la seleccion");

    // Un clic en el BORDE del rectangulo lo selecciona y le da el foco (Supr actua sobre el).
    const edge = await at(page, 0.1, 0.29);
    await page.mouse.click(edge.x, edge.y);
    await expect(page.getByRole("button", { name: /^Rectángulo \(1 de 2\)/ })).toBeFocused();
    await expect(elementBar(page)).toBeVisible();
    // El INTERIOR de un rectangulo sin relleno no capta el puntero: se puede seguir seleccionando lo de debajo.
    const inside = await at(page, 0.25, 0.29);
    const hitTag = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [inside.x, inside.y]);
    expect(hitTag).toBe("CANVAS");

    // Mover el extremo derecho de la linea: queda seleccionada y su extremo sigue al raton.
    const lineMid = await at(page, 0.65, 0.3);
    await page.mouse.click(lineMid.x, lineMid.y);
    const end = page.locator('[data-line-end="p2"]');
    await expect(end).toBeVisible();
    const endBox = (await end.boundingBox())!;
    const lineBefore = (await page.locator('[data-shape-visual="line"]').boundingBox())!;
    await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(endBox.x + endBox.width / 2 - 50, endBox.y + endBox.height / 2 + 80, { steps: 6 });
    await page.mouse.up();
    const lineAfter = (await page.locator('[data-shape-visual="line"]').boundingBox())!;
    expect(lineAfter.height).toBeGreaterThan(lineBefore.height + 60);
    expect(lineAfter.width).toBeLessThan(lineBefore.width - 40);
    await page.keyboard.press("ControlOrMeta+Z");
    const lineUndone = (await page.locator('[data-shape-visual="line"]').boundingBox())!;
    expect(Math.round(lineUndone.width)).toBe(Math.round(lineBefore.width));

    // Borrar con el teclado y recuperar con Ctrl+Z.
    await page.mouse.click(edge.x, edge.y);
    await page.keyboard.press("Delete");
    await expect(page.locator('[role="button"][data-element-kind="shape"]')).toHaveCount(1);
    await expect(live(page)).toContainText("Rectángulo borrado");
    await expectFocusNotOnBody(page, "tras borrar con Supr");
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(page.locator('[role="button"][data-element-kind="shape"]')).toHaveCount(2);
    await expectFocusNotOnBody(page, "tras recuperar con Ctrl+Z");
    expect(errors).toEqual([]);
  });

  test("atajos de teclado: letras de la paleta, Esc, corchetes y zoom, sin chocar con el texto", async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, await makePdf());
    await showSheet(page);
    await sheet(page).evaluate((el) => (el as HTMLElement).focus());

    for (const [key, name] of [["r", "Rectángulo"], ["e", "Elipse"], ["l", "Línea"], ["h", "Resaltado"], ["m", "Marca"], ["t", "Añadir texto"]] as const) {
      await page.keyboard.press(key);
      await expect(tool(page, name)).toHaveAttribute("aria-pressed", "true");
      await expect(tool(page, name)).toHaveAttribute("aria-keyshortcuts", key.toUpperCase());
    }
    await page.keyboard.press("Escape");
    await expect(tool(page, "Seleccionar")).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("]");
    await expect(sheet(page)).toHaveAttribute("data-page-index", "1");
    await page.keyboard.press("[");
    await expect(sheet(page)).toHaveAttribute("data-page-index", "0");
    await page.keyboard.press("+");
    await expect(page.getByText("125 %")).toBeVisible();
    await page.keyboard.press("-");
    await expect(page.getByText("100 %")).toBeVisible();

    // En un campo de texto las letras son letras (no cambian de herramienta).
    const goTo = page.getByRole("textbox", { name: "Ir a la página" });
    await goTo.focus();
    await page.keyboard.type("r");
    await expect(tool(page, "Rectángulo")).toHaveAttribute("aria-pressed", "false");

    // Paleta: patron APG (una parada de Tab, flechas para recorrerla).
    await tool(page, "Seleccionar").focus();
    await page.keyboard.press("ArrowDown");
    await expect(tool(page, "Añadir texto")).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("button", { name: "Rehacer", exact: true })).toBeFocused();
    expect(errors).toEqual([]);
  });

  test("las miniaturas y el paginador con un documento de 300 paginas: fluido y con memoria acotada", async ({ page, context }) => {
    const errors = collectErrors(page);
    const cdp = await context.newCDPSession(page);
    /** Heap de JS en uso tras una recoleccion (CDP da el dato exacto; `performance.memory` lo redondea). */
    const heapMB = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const usage = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
      return Math.round((usage.usedSize / 1e6) * 10) / 10;
    };
    const started = Date.now();
    await open(page, await makeLongPdf(300), "largo.pdf");
    const openMs = Date.now() - started;
    await expect(page.locator("[data-page-thumb]")).toHaveCount(300);

    // Perezoso: al abrir solo las celdas visibles se han rasterizado, no las 300.
    await expect.poll(() => page.locator("[data-page-thumb][data-thumb-loaded]").count()).toBeGreaterThan(3);
    const initialLoaded = await page.locator("[data-page-thumb][data-thumb-loaded]").count();
    expect(initialLoaded).toBeLessThan(40);

    const heapBefore = await heapMB();

    // Recorrer la tira entera desplazandola: nunca mas de MAX_THUMBS (60) miniaturas a la vez.
    const maxSeen = { value: 0 };
    for (let step = 0; step < 40; step += 1) {
      await page.evaluate((index) => {
        const scroller = document.querySelector("[data-page-strip] [role=list]") as HTMLElement;
        scroller.scrollLeft = (scroller.scrollWidth * index) / 40;
      }, step);
      await page.waitForTimeout(60);
      maxSeen.value = Math.max(maxSeen.value, await page.locator("[data-page-thumb][data-thumb-loaded]").count());
    }
    expect(maxSeen.value).toBeLessThanOrEqual(60);

    // Ir a la ultima pagina por el campo, y a la 150 por una miniatura.
    const goTo = page.getByRole("textbox", { name: "Ir a la página" });
    await goTo.fill("300");
    await goTo.press("Enter");
    await expect(sheet(page)).toHaveAttribute("data-page-index", "299");
    await expect(page.locator('[data-page-thumb="299"]')).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-page-thumb="299"][data-thumb-loaded]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Página siguiente" })).toHaveAttribute("aria-disabled", "true");

    const t0 = Date.now();
    await page.evaluate(() => {
      (document.querySelector('[data-page-thumb="149"]') as HTMLElement).scrollIntoView({ inline: "center", block: "nearest" });
    });
    await page.locator('[data-page-thumb="149"]').click();
    await expect(sheet(page)).toHaveAttribute("data-page-index", "149");
    await expect(page.locator('[data-render-state="ready"]')).toBeVisible();
    const navMs = Date.now() - t0;

    const heapAfter = await heapMB();
    const loadedAfter = await page.locator("[data-page-thumb][data-thumb-loaded]").count();
    const tabStops = await page.locator("[data-page-thumb]:not([tabindex='-1'])").count();
    expect(tabStops).toBe(1);

    console.log(JSON.stringify({ openMs, navMs, initialLoaded, maxThumbs: maxSeen.value, loadedAfter, heapMBBefore: heapBefore, heapMBAfter: heapAfter }));
    expect(openMs).toBeLessThan(30_000);
    expect(navMs).toBeLessThan(8_000);
    expect(heapAfter - heapBefore).toBeLessThan(60);
    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Movil, con el dedo
 * ------------------------------------------------------------------ */

test.describe("edit-pdf: imagen, formas y navegacion (movil 375 x 812, toque)", () => {
  test.use({ locale: "es-ES", viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

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

  async function pinch(cdp: CDPSession, center: { x: number; y: number }, from: number, to: number, steps = 8) {
    const points = (gap: number) => [
      { x: center.x - gap / 2, y: center.y, id: 1 },
      { x: center.x + gap / 2, y: center.y, id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(from + ((to - from) * step) / steps) });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  test("dibujar con un dedo, seleccionar, mover, pellizcar, miniaturas y barra dentro de la pantalla", async ({ page, context }) => {
    const errors = collectErrors(page);
    await open(page, await makePdf());
    const cdp = await context.newCDPSession(page);
    await expectNoOverflow(page, "al abrir");

    // Barra pegajosa de UNA fila y objetivos de 44 px.
    const nav = (await page.locator("[data-canvas-sticky]").boundingBox())!;
    expect(nav.height).toBeLessThan(70);
    for (const name of ["Alejar", "Acercar", "Página anterior", "Página siguiente", "Miniaturas de las páginas"]) {
      const box = (await page.getByRole("button", { name }).boundingBox())!;
      expect(box.height, name).toBeGreaterThanOrEqual(43.5);
      expect(box.width, name).toBeGreaterThanOrEqual(43.5);
    }

    // Paleta fija abajo, en dos filas de cinco, con botones de 44 px.
    const palette = page.getByRole("toolbar");
    const items = await palette.getByRole("button").all();
    expect(items).toHaveLength(10);
    for (const item of items) {
      const box = (await item.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375.5);
    }

    // Miniaturas: cerradas por defecto en movil, con interruptor.
    await expect(page.locator("[data-page-strip]")).toHaveCount(0);
    await page.getByRole("button", { name: "Miniaturas de las páginas" }).tap();
    await expect(page.locator("[data-page-strip]")).toBeVisible();
    await expect(page.locator('[data-page-thumb="2"][data-thumb-loaded]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-page-thumb="1"]').tap();
    await expect(sheet(page)).toHaveAttribute("data-page-index", "1");
    await page.locator('[data-page-thumb="0"]').tap();
    await expect(sheet(page)).toHaveAttribute("data-page-index", "0");
    await page.getByRole("button", { name: "Miniaturas de las páginas" }).tap();
    await expect(page.locator("[data-page-strip]")).toHaveCount(0);

    // Dibujar un rectangulo con un dedo.
    await sheet(page).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.evaluate(() => window.scrollBy(0, -120));
    await page.waitForTimeout(150);
    await tool(page, "Rectángulo").tap();
    const start = await at(page, 0.15, 0.3);
    const end = await at(page, 0.7, 0.42);
    await touchDrag(cdp, start, end);
    await expect(page.locator('[role="button"][data-element-kind="shape"]')).toHaveCount(1);
    await expect(elementBar(page)).toBeVisible();

    // La barra queda DENTRO de la pantalla y por encima de la paleta fija (se espera a que termine su entrada con muelle).
    await page.waitForTimeout(600);
    const barBox = (await elementBar(page).boundingBox())!;
    expect(barBox.x).toBeGreaterThanOrEqual(0);
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(375.5);
    expect(barBox.y).toBeGreaterThanOrEqual(0);
    const paletteBox = (await palette.boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(paletteBox.y + 1);
    for (const control of await elementBar(page).getByRole("button").all()) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
    await expectNoOverflow(page, "tras dibujar");

    // Mover con un dedo: la figura seleccionada se arrastra (no desplaza la pagina).
    const rectBefore = (await page.locator('[data-shape-visual="rect"]').boundingBox())!;
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const handle = { x: rectBefore.x + rectBefore.width, y: rectBefore.y + rectBefore.height / 2 };
    await touchDrag(cdp, handle, { x: handle.x - 30, y: handle.y + 20 });
    // El borde derecho esta en la zona de puntero del borde: mueve la figura.
    const rectAfter = (await page.locator('[data-shape-visual="rect"]').boundingBox())!;
    expect(Math.round(rectAfter.x - rectBefore.x)).toBe(-30);
    expect(Math.round(rectAfter.y - rectBefore.y)).toBe(20);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

    // Pellizco: acerca con dos dedos sobre la hoja.
    await expect(page.getByText("100 %")).toBeVisible();
    const emptyAt = await at(page, 0.5, 0.75);
    await touchDrag(cdp, emptyAt, emptyAt, 1); // toque en un hueco de la hoja: deselecciona
    await expect(elementBar(page)).toBeHidden();
    const sheetCenter = await at(page, 0.5, 0.5);
    await pinch(cdp, { x: 187, y: Math.min(Math.max(sheetCenter.y, 200), 500) }, 60, 180);
    await expect.poll(async () => Number((await page.locator("[data-canvas-sticky]").innerText()).match(/(\d+) %/)?.[1] ?? 100)).toBeGreaterThan(150);
    await expectNoOverflow(page, "tras el pellizco");
    await page.getByRole("button", { name: "Alejar" }).tap();
    await page.getByRole("button", { name: "Alejar" }).tap();
    await page.getByRole("button", { name: "Alejar" }).tap();
    await page.getByRole("button", { name: "Alejar" }).tap();
    await expect(page.getByText("100 %")).toBeVisible();

    // Doble toque en un bloque de texto: lo edita.
    const block = page.getByRole("button", { name: /^Texto: Segundo parrafo de la pagina 1/ });
    // Al centro de la pantalla: la paleta y la barra de accion fijas tapan el borde inferior.
    await block.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const blockBox = (await block.boundingBox())!;
    await page.touchscreen.tap(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
    await page.touchscreen.tap(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
    await expect(page.getByRole("textbox", { name: "Editando el texto del bloque" })).toBeFocused();
    await page.keyboard.type("x");
    await page.keyboard.press("Escape");
    await expectFocusNotOnBody(page, "tras editar con el dedo");

    expect(errors).toEqual([]);
  });
});
