import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { downloadBytes } from "../helpers/downloads";
import { isBenignEngineNoise } from "../helpers/engine";
import { blankPaper, jpgLargePhoto, jpgSignature, oversizedJpg, pngSignature, svgSignature, type SyntheticImage } from "../helpers/ink-images";
import { colorDistance, renderPageToPixels } from "../helpers/pdf-render-inspection";
import {
  PAGE_BG,
  VAULT_TITLE,
  deleteAllSignatures,
  exportAll,
  fingerprint,
  makeColoredPdf,
  openSignWithPdf,
  openVault,
  readVault,
  startImport,
  uploadAndSave,
  uploadSheet,
  chooseImage,
} from "../helpers/sign-vault-flow";
import { continueToSign, defineSigners, placeSlotsInSingleDocument, startTurn } from "../helpers/sign-flow";
import { hostileCorpus } from "../../src/lib/backup/__fixtures__/hostileCorpus";
import { threeSignatures } from "../helpers/backup-packages";

/**
 * Subir firmas/iniciales como imagen y exportar/importar TODAS las firmas (F6 · U6.2 + U4.4-UI), en navegador real.
 *
 *  - Subir un JPG con fondo blanco (y con sombra, un PNG opaco, un SVG) -> la firma se guarda con el fondo transparente
 *    y `origin: "uploaded"`; se usa en Firmar («Solo yo» y ceremonia de 2 firmantes) y en el PDF descargado NO hay
 *    recuadro blanco alrededor (el fondo de la hoja de prueba es amarillo palido).
 *  - Exportar todas con contrasena -> borrar -> importar: identicas por hash; paquetes dorados; zips hostiles.
 *  - Errores amigables, teclado y objetivos tactiles del recorte, sin tareas largas.
 *
 * Headless siempre. Chromium (`--project=chromium`) y `webkit-ipad` (`PW_BROWSERS=webkit-ipad`, build con
 * `CSP_SKIP_UPGRADE_INSECURE=1`): ver `docs/COMPATIBILIDAD-NAVEGADORES.md`.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(120_000);

const PACKAGES = path.resolve(__dirname, "../../src/lib/backup/__fixtures__/packages");
const GOLDEN_PASSWORD = "dorada-2026";

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

/* ------------------------------------------------------------------ *
 * Analisis del PDF descargado: ¿hay un recuadro blanco alrededor de la firma?
 * ------------------------------------------------------------------ */

type PageScan = { whiteTiles: number; inkTiles: number };

/** Recorre la pagina en teselas de 8 px: cuantas son blancas (un recuadro) y cuantas se apartan del fondo (tinta/texto). */
async function scanPage(bytes: Buffer): Promise<PageScan> {
  const rendered = await renderPageToPixels(bytes, 1, 2);
  let whiteTiles = 0;
  let inkTiles = 0;
  for (let y = 0; y + 8 <= rendered.height; y += 8) {
    for (let x = 0; x + 8 <= rendered.width; x += 8) {
      const color = rendered.averageColor(x, y, 8, 8);
      if (color.r >= 243 && color.g >= 243 && color.b >= 243) whiteTiles += 1;
      else if (colorDistance(color, { ...PAGE_BG, a: 255 }) > 45) inkTiles += 1;
    }
  }
  return { whiteTiles, inkTiles };
}

/** La hoja de partida (sin firma) y la descargada: sin blanco nuevo y con tinta nueva. */
async function expectStampedWithoutBox(base: Buffer, signed: Buffer): Promise<void> {
  const before = await scanPage(base);
  const after = await scanPage(signed);
  expect(before.whiteTiles, "la hoja de prueba no debe tener blanco de por si").toBe(0);
  expect(after.whiteTiles, "un recuadro blanco alrededor de la firma dejaria cientos de teselas blancas").toBeLessThanOrEqual(2);
  expect(after.inkTiles - before.inkTiles, "la firma debe haber dejado tinta en la pagina").toBeGreaterThan(12);
}

/* ------------------------------------------------------------------ *
 * 1. Subir y guardar con fondo transparente
 * ------------------------------------------------------------------ */

test.describe("subir una imagen: se guarda con el fondo transparente", () => {
  const cases: Array<[string, () => SyntheticImage]> = [
    ["JPG con fondo blanco", () => jpgSignature("white")],
    ["JPG con sombra de la mano", () => jpgSignature("shadow")],
    ["PNG con fondo opaco", () => pngSignature()],
    ["SVG", () => svgSignature()],
  ];
  for (const [label, make] of cases) {
    test(label, async ({ page }) => {
      const errors = trackErrors(page);
      await openSignWithPdf(page, await makeColoredPdf());
      await openVault(page);
      await uploadAndSave(page, make(), { name: "Ana Pérez", role: "Directora" });
      await expect(page.getByText("Guardada la firma de Ana Pérez.")).toBeVisible();
      const [row] = await readVault(page);
      expect(row).toMatchObject({ signerName: "Ana Pérez", role: "Directora", origin: "uploaded", sourceDocument: "" });
      expect(row.initialsHash).toBeNull();
      const png = row.signature!;
      // Fondo transparente (el trazo es una fraccion pequeña) y esquinas vacias; la tinta sigue siendo azul oscura.
      expect(png.transparent, "casi todo el fondo es transparente").toBeGreaterThan(0.7);
      expect(png.opaque, "hay tinta").toBeGreaterThan(0.01);
      expect(png.corners).toEqual([0, 0, 0, 0]);
      expect(png.ink!.b - png.ink!.r, "la tinta conserva su color original (azul)").toBeGreaterThan(40);
      expect(row.signatureBytes).toBeLessThanOrEqual(600 * 1024);
      expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(4096);
      expect(errors).toEqual([]);
    });
  }

  test("el color de la tinta (Negro) y «Quitar motas» apagado llegan al resultado", async ({ page }) => {
    await openSignWithPdf(page, await makeColoredPdf());
    await openVault(page);
    await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: "Subir firma o iniciales" }).click();
    const sheet = await chooseImage(page, jpgSignature("white"));
    await sheet.getByRole("radio", { name: "Negro" }).click();
    await sheet.getByRole("switch", { name: /Quitar motas/ }).click();
    await expect(sheet.locator("[data-ink-accept]")).toBeDisabled();
    await expect(sheet.locator("[data-ink-accept]")).toBeEnabled({ timeout: 60_000 });
    await sheet.locator("[data-ink-accept]").click();
    await sheet.getByLabel("Nombre del firmante").fill("Ana Pérez");
    await sheet.getByRole("button", { name: "Guardar en Firmas guardadas" }).click();
    await expect(sheet).toBeHidden();
    const [row] = await readVault(page);
    expect(row.signature!.ink!.b - row.signature!.ink!.r, "negro: ya no hay matiz azul").toBeLessThan(15);
    expect(row.signature!.ink!.r).toBeLessThan(40);
  });

  test("firma e iniciales desde dos imagenes, en UNA entrada", async ({ page }) => {
    await openSignWithPdf(page, await makeColoredPdf());
    await openVault(page);
    const vault = page.getByRole("dialog", { name: VAULT_TITLE });
    await vault.getByRole("button", { name: "Subir firma o iniciales" }).click();
    let sheet = await chooseImage(page, jpgSignature("white"));
    await sheet.locator("[data-ink-accept]").click();
    await expect(sheet.getByRole("heading", { name: "Lo que se guardará" })).toBeVisible();
    await sheet.getByRole("button", { name: "Añadir las iniciales (otra imagen)" }).click();
    sheet = await chooseImage(page, svgSignature("iniciales.svg"));
    await sheet.getByRole("radio", { name: "Iniciales" }).click();
    await expect(sheet.locator("[data-ink-accept]")).toBeEnabled({ timeout: 60_000 });
    await sheet.locator("[data-ink-accept]").click();
    await sheet.getByLabel("Nombre del firmante").fill("Luis Gómez");
    await sheet.getByRole("button", { name: "Guardar en Firmas guardadas" }).click();
    await expect(sheet).toBeHidden();
    const rows = await readVault(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].signatureHash).not.toBeNull();
    expect(rows[0].initialsHash).not.toBeNull();
    expect(rows[0].origin).toBe("uploaded");
  });
});

/* ------------------------------------------------------------------ *
 * 2. Usarla al firmar: «Solo yo» y ceremonia de 2 firmantes, sin recuadro blanco
 * ------------------------------------------------------------------ */

test.describe("usar la firma subida", () => {
  test("«Solo yo»: el PDF descargado lleva la firma SIN recuadro blanco", async ({ page }) => {
    const errors = trackErrors(page);
    const base = await makeColoredPdf();
    await openSignWithPdf(page, base);
    await openVault(page);
    await uploadAndSave(page, jpgSignature("white"), { name: "Ana Pérez" });
    await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: "Usar la firma de Ana Pérez" }).click();
    await expect(page.getByRole("group", { name: /firma colocada/i }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Procesar" }).click();
    await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 60_000 });
    const signed = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar" }).click();
    });
    await expectStampedWithoutBox(base, signed);
    expect(errors).toEqual([]);
  });

  test("ceremonia con 2 firmantes: las dos firmas subidas (JPG con sombra y PNG) se estampan sin recuadro blanco", async ({ page }) => {
    const errors = trackErrors(page);
    const base = await makeColoredPdf("Acuerdo");
    await openSignWithPdf(page, base, "acuerdo.pdf");
    await openVault(page);
    await uploadAndSave(page, jpgSignature("shadow"), { name: "Ana" });
    await uploadAndSave(page, pngSignature(), { name: "Luis" });
    await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: "Cerrar" }).first().click();
    await expect(page.getByRole("dialog", { name: VAULT_TITLE })).toBeHidden();

    await defineSigners(page);
    // Los dos huecos van sobre la zona media de la pagina; la ceremonia los recoge uno por firmante.
    await placeSlotsInSingleDocument(page);
    await continueToSign(page);
    for (const [index, name] of ["Ana", "Luis"].entries()) {
      await startTurn(page);
      await page.getByRole("button", { name: /Usar una guardada/ }).first().click();
      await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: `Usar la firma de ${name}` }).click();
      await page.getByRole("button", { name: "Ver cómo queda" }).click();
      await page.getByRole("button", { name: index === 0 ? "Pasar al siguiente firmante" : "He terminado" }).click();
    }
    await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
    await page.getByRole("button", { name: /Firmar y descargar/ }).click();
    await page.getByRole("button", { name: "No, dejar el nombre como está" }).click();
    await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible({ timeout: 60_000 });
    const signed = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    await expectStampedWithoutBox(base, signed);
    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Errores amigables, recorte a mano y rendimiento
 * ------------------------------------------------------------------ */

test.describe("errores y ajustes", () => {
  test("una hoja en blanco dice «No se encontró tinta» sin salir de la hoja; luego una buena si pasa", async ({ page }) => {
    await openSignWithPdf(page, await makeColoredPdf());
    await openVault(page);
    await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: "Subir firma o iniciales" }).click();
    const sheet = uploadSheet(page);
    await sheet.locator("[data-ink-file-input]").setInputFiles(blankPaper());
    await expect(sheet.locator("[data-ink-status]")).toContainText("No se encontró tinta", { timeout: 30_000 });
    await expect(sheet).toBeVisible();
    await chooseImage(page, jpgSignature("white"));
    await expect(sheet.locator("[data-ink-status]")).not.toContainText("No se encontró tinta");
  });

  test("formato no admitido y archivo de mas de 10 MB: mensajes claros, la hoja sigue abierta", async ({ page }) => {
    await openSignWithPdf(page, await makeColoredPdf());
    await openVault(page);
    await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: "Subir firma o iniciales" }).click();
    const sheet = uploadSheet(page);
    await sheet.locator("[data-ink-file-input]").setInputFiles({ name: "nota.txt", mimeType: "text/plain", buffer: Buffer.from("no soy una imagen") });
    await expect(sheet.locator("[data-ink-status]")).toContainText("Ese formato no se puede usar", { timeout: 30_000 });
    await sheet.locator("[data-ink-file-input]").setInputFiles(oversizedJpg());
    await expect(sheet.locator("[data-ink-status]")).toContainText("más de 10 MB", { timeout: 30_000 });
    await expect(sheet.getByText("Toma una foto de la firma sobre papel blanco, con buena luz.")).toBeVisible();
    await expect(sheet).toBeVisible();
  });

  test("recorte a mano: las asas se arrastran, se mueven con el teclado y miden al menos 44 px", async ({ page, browserName }) => {
    await openSignWithPdf(page, await makeColoredPdf());
    await openVault(page);
    await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: "Subir firma o iniciales" }).click();
    const sheet = await chooseImage(page, jpgSignature("white"));
    await sheet.getByRole("button", { name: "Recortar a mano" }).click();
    const group = sheet.getByRole("group", { name: "Zona de recorte sobre la imagen original" });
    await expect(group).toBeVisible();
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const handle = sheet.locator(`[data-crop-handle="${corner}"]`);
      await handle.scrollIntoViewIfNeeded();
      const box = await handle.boundingBox();
      expect(box!.width, `asa ${corner} ancho`).toBeGreaterThanOrEqual(43.5);
      expect(box!.height, `asa ${corner} alto`).toBeGreaterThanOrEqual(43.5);
    }
    // Arrastre con el puntero de la esquina inferior derecha hacia dentro.
    const before = await group.getAttribute("data-crop");
    const handle = sheet.locator('[data-crop-handle="se"]');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 20, { steps: 6 });
    await page.mouse.up();
    const dragged = await group.getAttribute("data-crop");
    expect(dragged).not.toBe(before);
    // Teclado (en el WebKit de macOS Tab no llega a los botones: se enfoca a mano, igual que lo haria Opcion+Tab).
    const nw = sheet.locator('[data-crop-handle="nw"]');
    await nw.focus();
    await page.keyboard.press("Shift+ArrowRight");
    expect(await group.getAttribute("data-crop")).not.toBe(dragged);
    // Cada flecha se ANUNCIA (region viva unica con el recorte resultante); el valor cambia con la siguiente.
    const announce = sheet.locator("[data-crop-announce]");
    await expect(announce).toHaveText(/^Recorte: desde \d+ % por la izquierda y \d+ % por arriba, \d+ % de ancho y \d+ % de alto\.$/);
    expect(await announce.getAttribute("aria-live")).toBe("polite");
    const spoken = await announce.textContent();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(announce).not.toHaveText(spoken!);
    // La vista previa se recalcula y se puede volver al recorte automatico.
    await expect(sheet.locator("[data-ink-accept]")).toBeEnabled({ timeout: 60_000 });
    await sheet.getByRole("button", { name: "Volver al recorte automático" }).click();
    await expect(group).toBeHidden();
    expect(browserName).toBeTruthy();
  });

  test("una foto de 5 MP no deja tareas largas: el hilo principal sigue respondiendo", async ({ page, browserName }) => {
    await openSignWithPdf(page, await makeColoredPdf());
    await openVault(page);
    await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: "Subir firma o iniciales" }).click();
    await page.evaluate(() => {
      const w = window as unknown as { __long: number[]; __frames: number[]; __run: boolean };
      w.__long = [];
      w.__frames = [];
      w.__run = true;
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) w.__long.push(entry.duration);
        }).observe({ entryTypes: ["longtask"] });
      } catch {
        /* WebKit no expone longtask */
      }
      let last = performance.now();
      const tick = (now: number) => {
        w.__frames.push(now - last);
        last = now;
        if (w.__run) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sheet = uploadSheet(page);
    await sheet.locator("[data-ink-file-input]").setInputFiles(jpgLargePhoto());
    await expect(sheet.getByRole("heading", { name: "Ajusta la imagen" })).toBeVisible({ timeout: 60_000 });
    await expect(sheet.locator("[data-ink-accept]")).toBeEnabled({ timeout: 90_000 });
    // y al mover «Limpiar fondo» con la foto grande
    await sheet.getByRole("slider", { name: /Limpiar fondo/ }).fill("70");
    await expect(sheet.locator("[data-ink-accept]")).toBeEnabled({ timeout: 90_000 });
    const { long, frames } = await page.evaluate(() => {
      const w = window as unknown as { __long: number[]; __frames: number[]; __run: boolean };
      w.__run = false;
      return { long: w.__long, frames: w.__frames };
    });
    const worstLong = Math.max(0, ...long);
    const worstFrame = Math.max(0, ...frames);
    console.log(`[medido] ${browserName}: tarea larga maxima ${Math.round(worstLong)} ms, hueco maximo entre fotogramas ${Math.round(worstFrame)} ms`);
    test.info().annotations.push({ type: "medido", description: `${browserName}: tarea larga maxima ${Math.round(worstLong)} ms, hueco maximo entre fotogramas ${Math.round(worstFrame)} ms` });
    if (browserName === "chromium") expect(worstLong, "ninguna tarea larga (> 100 ms) mientras se procesa").toBeLessThanOrEqual(100);
    // El runner de CI (2 nucleos compartidos, 2 workers) mide ~330 ms en el peor hueco con la misma foto que en un equipo
  // de desarrollo da < 100 ms: el techo absoluto lleva holgura solo en CI; la regla de «ninguna tarea larga > 100 ms» arriba NO.
    expect(worstFrame, "la pagina nunca se congela mas de 250 ms").toBeLessThan(250 * (process.env.CI ? 2 : 1));
  });
});

/* ------------------------------------------------------------------ *
 * 4. Exportar todas mis firmas / Importar firmas
 * ------------------------------------------------------------------ */

async function seedTwoSignatures(page: Page): Promise<void> {
  await openSignWithPdf(page, await makeColoredPdf());
  await openVault(page);
  await uploadAndSave(page, jpgSignature("white"), { name: "Ana Pérez", role: "Directora" });
  await uploadAndSave(page, pngSignature("luis.png"), { name: "Luis Gómez" });
  await uploadAndSave(page, svgSignature("iniciales.svg"), { name: "Marta Ruiz", kind: "Iniciales" });
}

test.describe("exportar e importar todas las firmas", () => {
  test("con contraseña: exportar -> borrar el baul -> importar = IDENTICAS por hash", async ({ page }) => {
    const errors = trackErrors(page);
    await seedTwoSignatures(page);
    const before = await readVault(page);
    expect(before).toHaveLength(3);

    const exported = await exportAll(page, { password: "una-clave-larga-1" });
    expect(exported.filename).toMatch(/^firmas-optimuspdf-\d{4}-\d{2}-\d{2}\.optimuspdf\.zip$/);
    expect(exported.bytes.subarray(0, 2).toString()).toBe("PK");
    expect(exported.bytes.includes(Buffer.from("envelope.json"))).toBe(true);
    expect(exported.bytes.includes(Buffer.from("signatures/index.json"))).toBe(false);
    await expect(page.getByText(/3 firmas exportadas \(cifradas con contraseña\)/).first()).toBeVisible();
    await page.getByRole("dialog", { name: "Exportar todas mis firmas" }).getByRole("button", { name: "Listo" }).click();

    await deleteAllSignatures(page);
    const sheet = await startImport(page, { name: exported.filename, buffer: exported.bytes });
    // contraseña mala: mensaje claro y se puede reintentar
    await sheet.getByLabel("Contraseña").fill("clave-equivocada");
    await sheet.getByRole("button", { name: "Abrir archivo" }).click();
    await expect(sheet.getByRole("status")).toContainText("La contraseña no es correcta, o el archivo está dañado.");
    await sheet.getByLabel("Contraseña").fill("una-clave-larga-1");
    await sheet.getByRole("button", { name: "Abrir archivo" }).click();
    await expect(sheet.getByText("El archivo trae 3 firmas (estaba cifrado)", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByText("Nuevo", { exact: true })).toHaveCount(3);
    expect(await readVault(page)).toHaveLength(0); // la vista previa no escribe
    await sheet.getByRole("button", { name: "Importar 3 firmas" }).click();
    await expect(sheet.getByText("3 importadas, 0 omitidas.").first()).toBeVisible({ timeout: 30_000 });

    const after = await readVault(page);
    expect(fingerprint(after)).toEqual(fingerprint(before));
    expect(after.map((row) => row.origin).sort()).toEqual(["uploaded", "uploaded", "uploaded"]);
    expect(errors).toEqual([]);
  });

  test("sin contraseña: el zip va en claro y se importa igual; importarlo otra vez no duplica", async ({ page }) => {
    await seedTwoSignatures(page);
    const before = await readVault(page);
    const exported = await exportAll(page);
    expect(exported.bytes.includes(Buffer.from("signatures/index.json"))).toBe(true);
    await page.getByRole("dialog", { name: "Exportar todas mis firmas" }).getByRole("button", { name: "Listo" }).click();

    // Importar sobre lo MISMO: todo «Ya lo tienes (idéntico)» y nada que importar.
    let sheet = await startImport(page, { name: exported.filename, buffer: exported.bytes });
    await expect(sheet.getByText("Ya lo tienes (idéntico)")).toHaveCount(3, { timeout: 30_000 });
    await expect(sheet.getByRole("button", { name: "No hay nada que importar" })).toBeDisabled();
    await sheet.getByRole("button", { name: "Cerrar" }).first().click();
    expect(await readVault(page)).toHaveLength(3);

    await deleteAllSignatures(page);
    sheet = await startImport(page, { name: exported.filename, buffer: exported.bytes });
    await sheet.getByRole("button", { name: "Importar 3 firmas" }).click();
    await expect(sheet.getByText("3 importadas, 0 omitidas.").first()).toBeVisible({ timeout: 30_000 });
    expect(fingerprint(await readVault(page))).toEqual(fingerprint(before));
  });

  test("fusionar: lo nuevo se añade y lo que ya estaba no se duplica", async ({ page }) => {
    await seedTwoSignatures(page);
    const exported = await exportAll(page);
    await page.getByRole("dialog", { name: "Exportar todas mis firmas" }).getByRole("button", { name: "Listo" }).click();
    // Se borra solo UNA firma y se añade otra distinta: al importar, 1 nueva + 2 identicas.
    await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: "Borrar la firma de Luis Gómez" }).click();
    await expect.poll(async () => (await readVault(page)).length).toBe(2);
    const sheet = await startImport(page, { name: exported.filename, buffer: exported.bytes });
    await expect(sheet.getByText("Nuevo", { exact: true })).toHaveCount(1, { timeout: 30_000 });
    await expect(sheet.getByText("Ya lo tienes (idéntico)")).toHaveCount(2);
    await sheet.getByRole("button", { name: "Importar 1 firma" }).click();
    await expect(sheet.getByText("1 importada, 2 omitidas.").first()).toBeVisible({ timeout: 30_000 });
    expect(await readVault(page)).toHaveLength(3);
  });

  // Los dorados llevan imagenes SINTETICAS (cabecera de PNG + relleno): el FORMATO se lee y se lista, pero la interfaz ya
  // no importa imagenes que el navegador no puede decodificar (U4.4-fix · D5). La importacion de los dorados, con sus
  // PNG exactos, la prueba la libreria (`goldenPackages.test.ts`); aqui se prueba lo mismo con imagenes REALES.
  for (const golden of ["signatures-v1.optimuspdf.zip", "signatures-v1-encrypted.optimuspdf.zip"]) {
    test(`paquete dorado ${golden}: el formato se lee; sus imagenes sinteticas se rechazan como «Imagen no válida»`, async ({ page }) => {
      await openSignWithPdf(page, await makeColoredPdf());
      await openVault(page);
      const sheet = await startImport(page, { name: golden, buffer: readFileSync(path.join(PACKAGES, golden)) });
      if (golden.includes("encrypted")) {
        await sheet.getByLabel("Contraseña").fill(GOLDEN_PASSWORD);
        await sheet.getByRole("button", { name: "Abrir archivo" }).click();
      }
      await expect(sheet.getByText("El archivo trae 3 firmas", { exact: false })).toBeVisible({ timeout: 30_000 });
      for (const name of ["Ana Pérez", "Luis Gómez", "Marta Ruiz"]) await expect(sheet.getByText(name, { exact: true })).toBeVisible();
      await expect(sheet.getByText("No se puede importar", { exact: true })).toHaveCount(3);
      await expect(sheet.getByText("Imagen no válida: está dañada o no es un PNG normal.")).toHaveCount(3);
      await expect(sheet.getByRole("button", { name: "No hay nada que importar" })).toBeDisabled();
      expect(await readVault(page)).toHaveLength(0);
    });
  }

  for (const password of [undefined, GOLDEN_PASSWORD]) {
    test(`equivalente REAL del dorado v1 (${password ? "cifrado" : "en claro"}): se lee, se importa con sus imagenes exactas y la cuenta cuadra`, async ({ page }) => {
      await openSignWithPdf(page, await makeColoredPdf());
      await openVault(page);
      const sheet = await startImport(page, { name: "real.optimuspdf.zip", buffer: await threeSignatures(password) });
      if (password) {
        await sheet.getByLabel("Contraseña").fill(password);
        await sheet.getByRole("button", { name: "Abrir archivo" }).click();
      }
      await expect(sheet.getByText("El archivo trae 3 firmas", { exact: false })).toBeVisible({ timeout: 30_000 });
      for (const name of ["Ana Pérez", "Luis Gómez", "Marta Ruiz"]) await expect(sheet.getByText(name, { exact: true })).toBeVisible();
      await expect(sheet.getByText("Nuevo", { exact: true })).toHaveCount(3);
      await sheet.getByRole("button", { name: "Importar 3 firmas" }).click();
      await expect(sheet.getByText("3 importadas, 0 omitidas.").first()).toBeVisible({ timeout: 30_000 });
      const rows = await readVault(page);
      expect(rows.map((row) => row.signerName)).toEqual(["Ana Pérez", "Luis Gómez", "Marta Ruiz"]);
      expect(rows.find((row) => row.signerName === "Ana Pérez")?.role).toBe("Directora");
    });
  }

  test("zips hostiles del corpus de la libreria: rechazo claro, sin colgar y sin escribir nada", async ({ page }) => {
    await openSignWithPdf(page, await makeColoredPdf());
    await openVault(page);
    await uploadAndSave(page, pngSignature(), { name: "Ana Pérez" });
    const before = fingerprint(await readVault(page));
    await page.getByRole("dialog", { name: VAULT_TITLE }).getByRole("button", { name: "Importar firmas", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Importar firmas" });
    const expectedText: Record<string, RegExp> = {
      badZip: /no es un paquete de firmas/,
      bomb: /no es seguro de abrir/,
      unsafePath: /no es seguro de abrir/,
      duplicateEntry: /no es seguro de abrir/,
      tooLarge: /demasiado grande/,
      tooManyEntries: /demasiado grande/,
    };
    for (const hostile of hostileCorpus()) {
      const started = Date.now();
      await sheet.locator("[data-backup-file-input]").setInputFiles({
        name: "hostil.optimuspdf.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(hostile.bytes),
      });
      await expect(sheet.getByRole("status"), hostile.name).toContainText(expectedText[hostile.code], { timeout: 10_000 });
      expect(Date.now() - started, `${hostile.name} tardo demasiado`).toBeLessThan(8_000);
      await expect(sheet.getByRole("button", { name: "Elegir archivo .zip" })).toBeVisible();
    }
    expect(fingerprint(await readVault(page))).toEqual(before);
  });

  test("paquete creado con una version mas nueva: «actualiza la página»", async ({ page }) => {
    await seedTwoSignatures(page);
    const exported = await exportAll(page);
    await page.getByRole("dialog", { name: "Exportar todas mis firmas" }).getByRole("button", { name: "Listo" }).click();
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(exported.bytes);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    manifest.modules.signatures.schemaVersion = 99;
    zip.file("manifest.json", JSON.stringify(manifest));
    const newer = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
    const sheet = await startImport(page, { name: "nuevo.optimuspdf.zip", buffer: newer });
    await expect(sheet.getByRole("status")).toContainText("actualiza la página", { timeout: 30_000 });
  });
});

/* ------------------------------------------------------------------ *
 * 5. iPad: navigator.share({files})
 * ------------------------------------------------------------------ */

test.describe("tactil: compartir el archivo con la hoja del sistema", () => {
  test.use({ hasTouch: true });

  test("con share({files}) disponible: «Compartir…» entrega el archivo y se puede importar", async ({ page }) => {
    await page.addInitScript(() => {
      const shared: Array<{ name: string; type: string; base64: string }> = [];
      (window as unknown as { __shared: typeof shared }).__shared = shared;
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data: { files?: File[] }) => {
          for (const file of data.files ?? []) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            shared.push({ name: file.name, type: file.type, base64: btoa(binary) });
          }
        },
      });
    });
    await seedTwoSignatures(page);
    const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
    test.skip(!coarse, "este navegador no reporta puntero tactil: la ruta de compartir solo existe con dedo");
    const before = await readVault(page);
    const vault = page.getByRole("dialog", { name: VAULT_TITLE });
    await vault.getByRole("button", { name: "Exportar todas mis firmas" }).click();
    const sheet = page.getByRole("dialog", { name: "Exportar todas mis firmas" });
    await sheet.getByLabel("Contraseña", { exact: true }).fill("una-clave-larga-2");
    await sheet.getByLabel("Repite la contraseña").fill("una-clave-larga-2");
    await sheet.getByRole("button", { name: "Exportar", exact: true }).click();
    // primero «listo»; compartir pide un toque propio
    await expect(sheet.getByText(/Archivo listo: firmas-optimuspdf-/)).toBeVisible({ timeout: 60_000 });
    await sheet.getByRole("button", { name: "Compartir o guardar en Archivos" }).click();
    await expect(sheet.getByText(/3 firmas exportadas \(cifradas con contraseña\)/).first()).toBeVisible();
    const shared = await page.evaluate(() => (window as unknown as { __shared: Array<{ name: string; type: string; base64: string }> }).__shared);
    expect(shared).toHaveLength(1);
    expect(shared[0].name).toMatch(/\.optimuspdf\.zip$/);
    expect(shared[0].type).toBe("application/zip");
    const bytes = Buffer.from(shared[0].base64, "base64");
    await sheet.getByRole("button", { name: "Listo" }).click();

    await deleteAllSignatures(page);
    const restore = await startImport(page, { name: shared[0].name, buffer: bytes });
    await restore.getByLabel("Contraseña").fill("una-clave-larga-2");
    await restore.getByRole("button", { name: "Abrir archivo" }).click();
    await restore.getByRole("button", { name: "Importar 3 firmas" }).click();
    await expect(restore.getByText("3 importadas, 0 omitidas.").first()).toBeVisible({ timeout: 30_000 });
    expect(fingerprint(await readVault(page))).toEqual(fingerprint(before));
  });
});
