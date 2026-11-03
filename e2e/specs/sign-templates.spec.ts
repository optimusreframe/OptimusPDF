import { openOptions, optionsText } from "../helpers/sign-options";
import JSZip from "jszip";
import { expect, test, type Page } from "@playwright/test";
import { embeddedImages, shapeHash } from "../helpers/pdf-images";
import { imagePlacements, type Placement } from "../helpers/pdf-placements";
import { downloadBytes, downloadFile } from "../helpers/downloads";
import { getPageCount } from "../helpers/pdf-inspection";
import { drawInOpenComposer, fileInput, roundCompleteHeading } from "../helpers/sign-flow";
import { finishTurn } from "../helpers/template-session-flow";
import {
  LINE,
  Taps,
  chooseForEditor,
  dragOnSheet,
  openEditorWithFile,
  pickTool,
  placeInitialsLine,
  placeSignatureBlock,
  sheet,
  storedDocuments,
  storedTemplates,
  type StoredField,
} from "../helpers/template-flow";
import { makeContract, reexport } from "../helpers/template-pdfs";
import { SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY } from "../../src/app/sign-pdf/signFeatureFlags";

/**
 * Firma agil · Fase 2 · U2.3 + U2.4: plantillas de documento en Firmar, con contratos SINTETICOS (3-8 paginas, una linea de
 * iniciales repetida en la esquina y un bloque de firma de 1 o de 2 firmantes), en un navegador real, headless.
 *
 *   (i)   configurar la plantilla de 2 firmantes UNA vez -> guardar -> recargar -> subir el MISMO PDF reexportado (bytes
 *         distintos) -> los campos aparecen solos -> recoger firmas e iniciales de 2 firmantes -> el PDF lleva las
 *         iniciales en TODAS las paginas, una al lado de la otra y el firmante 1 a la izquierda (posiciones y trazos);
 *   (ii)  documento desconocido -> automapeo: coloca los de confianza alta y deja sugerencias -> guardar como plantilla;
 *   (iii) cambiar de 2 a 1 firmante re-aplica la variante sin perder el trazo que sigue valiendo;
 *   (iv)  una pagina distinta marca «Revisar» y no se aplica sola;
 *   (v)   traspaso desde la biblioteca (`signHandoff`), firmar y configurar;
 *   (vi)  lo guardado sobrevive a recargar.
 *
 * Chromium por defecto; iPad: `PW_BROWSERS=webkit-ipad ... --project=webkit-ipad` con build de produccion y
 * `CSP_SKIP_UPGRADE_INSECURE=1` (ver docs/COMPATIBILIDAD-NAVEGADORES.md). Headless siempre.
 */

test.use({ locale: "es-ES", acceptDownloads: true });
test.setTimeout(240_000);

const PAGES = 6;
const SIGNER_1_ROLE = "Asegurado";
const SIGNER_2_ROLE = "Co-asegurado";

async function upload(page: Page, name: string, buffer: Buffer): Promise<void> {
  await fileInput(page).setInputFiles({ name, mimeType: "application/pdf", buffer });
}

const notices = (page: Page) => page.locator("[data-template-notices]");

/** Configura la plantilla de 2 firmantes con el editor y la guarda; devuelve lo guardado. */
async function configureTwoSigners(page: Page, original: Buffer, taps?: Taps) {
  await page.goto("/sign-pdf");
  const count = (label: string) => taps && taps.steps.push(label) && (taps.count += 1);
  count("Configurar plantilla (elegir el PDF)");
  await chooseForEditor(page, { name: "Mold Test Agreement.pdf", buffer: original });
  await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toBeVisible();
  await expect(sheet(page)).toBeVisible();
  if (taps) await taps.click(page.getByRole("toolbar").first().getByRole("button", { name: "Iniciales", exact: true }), "herramienta Iniciales");
  else await pickTool(page, "Iniciales");
  if (taps) await taps.drag({ x0: LINE.x0, y0: LINE.y - 0.045, x1: LINE.x1, y1: LINE.y - 0.004 }, "arrastrar la linea de iniciales");
  else await dragOnSheet(page, { x0: LINE.x0, y0: LINE.y - 0.045, x1: LINE.x1, y1: LINE.y - 0.004 });
  const repeat = page.getByRole("button", { name: "Repetir iniciales en todas las páginas" });
  if (taps) await taps.click(repeat, "Repetir iniciales en todas las páginas");
  else await repeat.click();
  await expect(page.locator("[data-template-note]")).toContainText(`Iniciales repetidas en ${PAGES} páginas, una al lado de la otra`);
  // El bloque de firmas, en la ultima pagina: 5 toques de «Página siguiente» + (firmante, herramienta, arrastre) x 2.
  if (taps) taps.count += 5 + 6;
  await placeSignatureBlock(page, 2, PAGES - 1);
  const save = page.getByRole("button", { name: "Guardar plantilla" });
  if (taps) await taps.click(save, "Guardar plantilla");
  else await save.click();
  await expect(page.locator("[data-template-saved]")).toContainText(`Plantilla guardada · aplicada a ${PAGES} páginas`);
  const templates = await storedTemplates(page);
  expect(templates).toHaveLength(1);
  return templates[0];
}

/** Turno completo de un firmante en la ceremonia de UN documento; devuelve los toques que costo. */
async function signTurn(page: Page, seed: number, last: boolean, taps: Taps): Promise<void> {
  await taps.click(page.getByRole("button", { name: "Listo, es mi turno" }).first(), "Listo, es mi turno");
  await taps.click(page.getByRole("button", { name: "Crear mi firma", exact: true }), "Crear mi firma");
  await drawInOpenComposer(page, seed);
  taps.count += 1;
  taps.steps.push("Usar esta firma");
  await taps.click(page.getByRole("button", { name: "Crear mis iniciales", exact: true }), "Crear mis iniciales");
  await drawInOpenComposer(page, seed + 7);
  taps.count += 1;
  taps.steps.push("Usar estas iniciales");
  await taps.click(page.getByRole("button", { name: "Ver cómo queda" }), "Ver cómo queda");
  // Ola 3: con el ultimo firmante la revision y «Firmar y descargar» son UNA pantalla; no hay «He terminado».
  await finishTurn(page, last, taps);
}

const near = (a: number, b: number, tolerance = 0.004) => Math.abs(a - b) <= tolerance;
const center = (p: { x: number; y: number; width: number; height: number }) => ({ x: p.x + p.width / 2, y: p.y + p.height / 2 });
const inside = (p: Placement, f: StoredField, slack = 0.004) => {
  const c = center(p);
  return c.x >= f.rect.x - slack && c.x <= f.rect.x + f.rect.width + slack && c.y >= f.rect.y - slack && c.y <= f.rect.y + f.rect.height + slack;
};

test("(i) configurar la plantilla de 2 firmantes UNA vez; el mismo PDF reexportado trae los campos solos y el PDF firmado lleva las iniciales en todas las páginas, una al lado de la otra", async ({ page }, testInfo) => {
  // Privacidad: durante TODO el recorrido (configurar, reconocer, firmar) no sale ninguna peticion del dispositivo.
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname) && !["data:", "blob:", "about:"].includes(url.protocol)) external.push(request.url());
  });
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  const configure = new Taps(page);
  const template = await configureTwoSigners(page, original, configure);

  // Lo guardado: roles, 2 firmas, y 6 x 2 iniciales con el firmante 1 a la izquierda y la misma altura.
  expect(template.roles.map((role) => role.label)).toEqual([SIGNER_1_ROLE, SIGNER_2_ROLE]);
  const stored = template.variants["2"].fields;
  expect(stored).toHaveLength(PAGES * 2 + 2);
  for (let pageIndex = 0; pageIndex < PAGES; pageIndex += 1) {
    const left = stored.find((field) => field.type === "initials" && field.pageIndex === pageIndex && field.roleIndex === 0);
    const right = stored.find((field) => field.type === "initials" && field.pageIndex === pageIndex && field.roleIndex === 1);
    expect(left && right, `iniciales de la pagina ${pageIndex + 1}`).toBeTruthy();
    expect(left!.rect.x + left!.rect.width).toBeLessThanOrEqual(right!.rect.x + 1e-9);
    expect(near(left!.rect.y, right!.rect.y, 1e-6)).toBe(true);
  }
  const documents = await storedDocuments(page);
  expect(documents).toHaveLength(1);
  expect(documents[0].byteLength).toBe(original.length);

  // Recargar y subir el MISMO contrato reexportado: bytes distintos, mismo contenido.
  await page.reload();
  const again = await reexport(original);
  expect(again.equals(original)).toBe(false);
  const withTemplate = new Taps(page);
  withTemplate.count = 1;
  withTemplate.steps.push("subir el PDF");
  await upload(page, "Mold Test Agreement (1).pdf", again);
  await expect(notices(page)).toContainText("Plantilla «Mold Test Agreement» aplicada", { timeout: 20_000 });
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2} campos en ${PAGES} páginas`);
  await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1_ROLE);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2_ROLE);

  // Firmas e iniciales de 2 firmantes: el 1 con un trazo, el 2 con otro.
  await withTemplate.click(page.getByRole("button", { name: "Ir a firmar" }), "Ir a firmar");
  const ceremonyStart = withTemplate.count;
  await expect(page.getByRole("heading", { name: `Pásale el dispositivo a ${SIGNER_1_ROLE}` })).toBeVisible();
  // Semillas con amplitudes de trazo distintas (10, 34, 22 y 46): cuatro trazos de formas distintas.
  await signTurn(page, 10, false, withTemplate);
  await expect(page.getByRole("heading", { name: `Pásale el dispositivo a ${SIGNER_2_ROLE}` })).toBeVisible();
  await signTurn(page, 21, true, withTemplate);
  await expect(page.getByRole("heading", { name: "Revisa y descarga" })).toBeVisible();
  const download = page.getByRole("button", { name: "Firmar y descargar" });
  // Ola 3: el PDF se descarga SOLO al llegar al resultado; «Descargar» queda de respaldo (otra descarga, mismos bytes).
  const signedBytes = await downloadBytes(page, async () => {
    await withTemplate.click(download, "Firmar y descargar");
  });
  const backupBytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: /^Descargar/ }).click();
  });
  expect(backupBytes.equals(signedBytes), "«Descargar» de respaldo baja el mismo archivo").toBe(true);

  // El PDF firmado: mismas paginas que el original (sin hoja de certificado) y las imagenes donde dice la plantilla.
  expect(await getPageCount(signedBytes)).toBe(PAGES);
  const placements = await imagePlacements(signedBytes);
  expect(placements).toHaveLength(PAGES * 2 + 2);
  const shapes = await embeddedImages(signedBytes);
  expect(shapes.length).toBeGreaterThanOrEqual(PAGES * 2 + 2);
  const leftSlots = stored.filter((field) => field.type === "initials" && field.roleIndex === 0);
  const rightSlots = stored.filter((field) => field.type === "initials" && field.roleIndex === 1);
  for (let pageIndex = 0; pageIndex < PAGES; pageIndex += 1) {
    const onPage = placements.filter((p) => p.page === pageIndex).sort((a, b) => a.x - b.x);
    const initials = onPage.filter((p) => p.y > 0.8);
    expect(initials, `iniciales de la pagina ${pageIndex + 1}`).toHaveLength(2);
    const left = leftSlots.find((f) => f.pageIndex === pageIndex)!;
    const right = rightSlots.find((f) => f.pageIndex === pageIndex)!;
    expect(inside(initials[0], left), `firmante 1 a la izquierda en la pagina ${pageIndex + 1}`).toBe(true);
    expect(inside(initials[1], right), `firmante 2 a la derecha en la pagina ${pageIndex + 1}`).toBe(true);
    expect(initials[0].x + initials[0].width).toBeLessThanOrEqual(initials[1].x + 1e-6);
  }
  const lastPage = placements.filter((p) => p.page === PAGES - 1 && p.y < 0.7).sort((a, b) => a.x - b.x);
  expect(lastPage).toHaveLength(2);
  const signatureSlots = stored.filter((field) => field.type === "signature").sort((a, b) => a.rect.x - b.rect.x);
  expect(inside(lastPage[0], signatureSlots[0])).toBe(true);
  expect(inside(lastPage[1], signatureSlots[1])).toBe(true);

  // Trazos: el mismo trazo de iniciales de cada firmante en TODAS las paginas, y distinto entre firmantes.
  const distinct = new Set(shapes.map(shapeHash));
  // Firma1, Iniciales1, Firma2, Iniciales2: cuatro trazos distintos en total (cada uno repetido).
  expect(distinct.size).toBe(4);

  expect(external, "ninguna peticion a servidores externos").toEqual([]);

  // Toques.
  testInfo.annotations.push({ type: "toques", description: `configurar una vez (con el editor): ${configure.count}` });
  testInfo.annotations.push({ type: "toques", description: `con plantilla, de la carga a la ceremonia: ${ceremonyStart} (${withTemplate.steps.slice(0, ceremonyStart).join(" > ")})` });
  testInfo.annotations.push({ type: "toques", description: `con plantilla, de la carga a descargar (2 firmantes, ceremonia incluida; la descarga es automatica): ${withTemplate.count}` });
  expect(ceremonyStart, "de la carga a la ceremonia con plantilla").toBeLessThanOrEqual(2);
});

test("(i-b) sin plantilla, el mismo documento de 2 firmantes cuesta muchos más toques antes de la ceremonia", async ({ page }, testInfo) => {
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  await page.addInitScript(
    ([key]) => {
      if (window.sessionStorage.getItem("__flags")) return;
      window.localStorage.setItem(key, JSON.stringify({ autoApplyTemplates: false, autoDetectFields: false }));
      window.sessionStorage.setItem("__flags", "1");
    },
    [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY],
  );
  await page.goto("/sign-pdf");
  const taps = new Taps(page);
  taps.count = 1;
  taps.steps.push("subir el PDF");
  await upload(page, "Mold Test Agreement.pdf", original);
  await taps.click(page.getByRole("tab", { name: "Varios firmantes" }), "Varios firmantes");
  // Sin plantilla y con la deteccion automatica APAGADA: lo que cuesta de verdad hacerlo a mano.
  await taps.click(page.getByRole("button", { name: "Añadir firmante" }), "Añadir firmante");
  await taps.click(page.getByRole("button", { name: "Añadir firmante" }), "Añadir firmante");
  await taps.click(page.getByRole("button", { name: "2. Documento" }), "2. Documento");
  for (let pageIndex = 0; pageIndex < PAGES; pageIndex += 1) {
    for (const [role, offset] of [["Firmante 1", 0.74], ["Firmante 2", 0.81]] as const) {
      await taps.click(page.getByRole("radio", { name: role, exact: true }), `firmante ${role}`);
      await taps.click(page.getByRole("toolbar").first().getByRole("button", { name: "Iniciales", exact: true }), "herramienta Iniciales");
      await taps.drag({ x0: offset, y0: LINE.y - 0.045, x1: offset + 0.065, y1: LINE.y - 0.004 }, `iniciales de ${role} en la pagina ${pageIndex + 1}`);
    }
    if (pageIndex < PAGES - 1) await taps.click(page.getByRole("button", { name: "Página siguiente" }), "Página siguiente");
  }
  for (const [role, x0, x1] of [["Firmante 1", 0.1, 0.42], ["Firmante 2", 0.55, 0.88]] as const) {
    await taps.click(page.getByRole("radio", { name: role, exact: true }), `firmante ${role}`);
    await taps.click(page.getByRole("toolbar").first().getByRole("button", { name: "Firma", exact: true }), "herramienta Firma");
    await taps.drag({ x0, y0: 0.5, x1, y1: 0.545 }, `firma de ${role}`);
  }
  await taps.click(page.getByRole("button", { name: "Continuar" }), "Continuar");
  await expect(page.getByRole("heading", { name: "Pásale el dispositivo a Firmante 1" })).toBeVisible();
  testInfo.annotations.push({ type: "toques", description: `SIN plantilla, de la carga a la ceremonia: ${taps.count}` });
  expect(taps.count).toBeGreaterThan(40);
});

test("(ii) documento desconocido: el automapeo coloca los de confianza alta, deja sugerencias y, tras firmar, ofrece guardarlo como plantilla", async ({ page }) => {
  const unknown = await makeContract({ label: "Zulu Unknown Agreement", pages: 5, signers: 2, extras: true });
  await page.goto("/sign-pdf");
  await upload(page, "Zulu Unknown.pdf", unknown);
  await expect(page.getByText("Zulu Unknown.pdf").first()).toBeVisible();
  // En «Solo yo» no se cambia de modo por un documento desconocido.
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-template-notice]")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Solo yo" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("tab", { name: "Varios firmantes" }).click();
  await expect(notices(page)).toContainText("Detectamos", { timeout: 20_000 });
  const title = (await notices(page).locator("[data-template-notice]").first().locator("p").first().innerText()).trim();
  const placed = Number(/Detectamos (\d+) campos/.exec(title)?.[1]);
  // 5 paginas x 2 iniciales + 2 firmas + fecha + nombre (los de confianza alta).
  expect(placed).toBeGreaterThanOrEqual(12);
  await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1_ROLE);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2_ROLE);

  // Sugerencias: dos rayas con poco sitio (de cada firmante) y las firmas «sin firmante claro» / de la otra parte.
  const suggestions = page.getByRole("button", { name: /^Sugerencias \(\d+\)$/ });
  await expect(suggestions).toBeVisible();
  const total = Number(/\((\d+)\)/.exec(await suggestions.innerText())?.[1]);
  expect(total).toBeGreaterThanOrEqual(4);
  await suggestions.click();
  const pending = page.locator("[data-template-pending]");
  // «Añadir todas» solo añade las que tienen firmante; las firmas sin firmante claro (p. ej. la de la otra parte) van de una en una.
  await pending.getByRole("button", { name: "Añadir todas" }).click();
  await expect(page.getByRole("button", { name: "Sugerencias (2)" })).toBeVisible();
  await expect(pending.locator("li")).toHaveCount(2);
  await expect(pending.locator("li").first()).not.toContainText(" de Asegurado");
  await pending.locator("li").first().getByRole("button", { name: /^Añadir:/ }).click();
  await expect(page.getByRole("button", { name: "Sugerencias (1)" })).toBeVisible();

  // Firmar y descargar.
  const slots = /(\d+) huecos en total/.exec(await optionsText(page))?.[1] ?? "NaN";
  const slotCount = Number(slots);
  expect(slotCount).toBeGreaterThanOrEqual(placed - 2);
  await page.getByRole("button", { name: "Ir a firmar" }).click();
  const taps = new Taps(page);
  await signTurn(page, 3, false, taps);
  await signTurn(page, 17, true, taps);
  await expect(roundCompleteHeading(page)).toBeVisible();
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Firmar y descargar" }).click();
  });
  expect(await getPageCount(bytes)).toBe(5);
  expect((await imagePlacements(bytes)).length).toBe(slotCount);

  // Oferta de la pantalla final: guardar como plantilla para la proxima vez.
  const offer = page.locator("[data-template-offer]");
  await expect(offer).toContainText("¿Guardar «Zulu Unknown.pdf» como plantilla para la próxima vez?");
  // m1: el texto no promete una «copia en blanco»: se guarda el PDF tal cual se subio y se avisa de los datos de un cliente.
  await expect(offer).toContainText("Se guardará una copia de este PDF en este navegador");
  await expect(offer).toContainText("Si este PDF contiene datos de un cliente, no lo guardes");
  await expect(offer).not.toContainText("copia en blanco");
  await expect(offer.getByRole("button", { name: "No guardar" })).toBeVisible();
  await offer.getByRole("button", { name: "Guardar como plantilla" }).click();
  await expect(offer).toContainText("plantilla guardada · aplicada a 5 páginas");
  const templates = await storedTemplates(page);
  expect(templates).toHaveLength(1);
  const saved = templates[0].variants["2"];
  // 4 paginas de cuerpo x 2 iniciales + 2 firmas + 2 rayas con poco sitio + la sugerencia sin firmante que se anadio.
  expect(saved.fields).toHaveLength(slotCount);
  // Nada de lo firmado ni de los nombres se guarda: solo posiciones y el PDF en blanco.
  const raw = JSON.stringify(templates);
  expect(raw).not.toContain("data:image");
  const documents = await storedDocuments(page);
  expect(documents).toHaveLength(1);
  expect(documents[0].byteLength).toBe(unknown.length);

  // La proxima vez: el mismo documento reexportado se reconoce y se aplica la plantilla.
  await page.reload();
  await upload(page, "Zulu Unknown (copia).pdf", await reexport(unknown));
  await expect(notices(page)).toContainText("Plantilla «Zulu Unknown» aplicada", { timeout: 20_000 });
});

test("(iii) cambiar de 2 a 1 firmante re-aplica la variante y el trazo que sigue siendo válido no se pierde", async ({ page }) => {
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  const template = await configureTwoSigners(page, original);
  await page.reload();
  await upload(page, "Mold Test.pdf", await reexport(original));
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2} campos`, { timeout: 20_000 });

  // El firmante 1 firma (firma e iniciales) y pasa el turno al 2.
  await page.getByRole("button", { name: "Ir a firmar" }).click();
  const taps = new Taps(page);
  await signTurn(page, 5, false, taps);
  await expect(page.getByRole("heading", { name: `Pásale el dispositivo a ${SIGNER_2_ROLE}` })).toBeVisible();

  // Con 1 firmante la plantilla se re-aplica: el segundo firmante y sus campos se van; los del primero no se tocan.
  await page.getByRole("button", { name: "1. Firmantes" }).click();
  await notices(page).getByRole("tab", { name: "1 firmante" }).click();
  await expect(notices(page)).toContainText(`1 firmante · ${PAGES + 1} campos en ${PAGES} páginas`);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveCount(0);
  await page.getByRole("button", { name: "3. Firmar" }).click();
  // El trazo del firmante 1 sigue valiendo (sus huecos no se movieron): no hay nadie mas que firmar.
  await expect(roundCompleteHeading(page)).toBeVisible();
  const bytes = await downloadBytes(page, async () => {
    await page.getByRole("button", { name: "Firmar y descargar" }).click();
  });
  const placements = await imagePlacements(bytes);
  expect(placements).toHaveLength(PAGES + 1);
  const left = template.variants["2"].fields.filter((field) => field.type === "initials" && field.roleIndex === 0);
  for (const field of left) {
    expect(placements.some((p) => p.page === field.pageIndex && inside(p, field)), `iniciales del firmante 1 en la pagina ${field.pageIndex + 1}`).toBe(true);
  }
  expect(new Set((await embeddedImages(bytes)).map(shapeHash)).size).toBe(2);

  // Y de vuelta a 2 firmantes: vuelven los campos del segundo (sin trazo) y el primero sigue hecho.
  await page.reload();
  await upload(page, "Mold Test (2).pdf", await reexport(original));
  await expect(notices(page)).toContainText("2 firmantes", { timeout: 20_000 });
  await notices(page).getByRole("tab", { name: "1 firmante" }).click();
  await expect(notices(page)).toContainText("1 firmante · ");
  await notices(page).getByRole("tab", { name: "2 firmantes" }).click();
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2} campos`);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveValue(SIGNER_2_ROLE);
});

test("(iv) una página distinta marca «Revisar»: se pregunta, no se aplica sola y se puede añadir", async ({ page }) => {
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  await configureTwoSigners(page, original);
  await page.reload();
  const revised = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2, tweakedPages: [2] });
  await upload(page, "Mold Test revisado.pdf", revised);
  await expect(notices(page)).toContainText(/Parece la plantilla «Mold Test Agreement» \(\d+ %\)/, { timeout: 20_000 });
  await expect(page.getByRole("tab", { name: "Solo yo" })).toHaveAttribute("aria-selected", "true");
  await notices(page).getByRole("button", { name: "Usar", exact: true }).click();
  await expect(notices(page)).toContainText("Plantilla «Mold Test Agreement» aplicada");
  // La pagina 3 (indice 2) no se aplico sola: 2 iniciales menos.
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2 - 2} campos en ${PAGES - 1} páginas`);
  const review = notices(page).getByRole("button", { name: "Revisar la página 3 (2)" });
  await expect(review).toBeVisible();
  await review.click();
  await expect(notices(page).locator("[data-template-pending] li")).toHaveCount(2);
  await expect(notices(page).locator("[data-template-pending]")).toContainText("Esta página cambió respecto a la plantilla");
  await notices(page).getByRole("button", { name: "Añadir todas" }).click();
  await expect(notices(page)).not.toContainText("Revisar la página 3");
  expect(await optionsText(page)).toContain(`${PAGES * 2 + 2} huecos en total`);
});

test("(v) traspaso desde «Mis documentos»: firmar con su plantilla y configurarla", async ({ page }) => {
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  await configureTwoSigners(page, original);
  const [entry] = await storedDocuments(page);

  const handoff = async (mode: "sign" | "configure", ids: string[]) => {
    await page.evaluate(([value]) => window.sessionStorage.setItem("optimuspdf.signHandoff", value), [JSON.stringify({ documentIds: ids, mode, createdAt: Date.now() })]);
    await page.goto("/sign-pdf");
  };

  await handoff("sign", [entry.id]);
  await expect(notices(page)).toContainText("Plantilla «Mold Test Agreement» aplicada", { timeout: 20_000 });
  await expect(notices(page)).toContainText(`2 firmantes · ${PAGES * 2 + 2} campos`);
  await expect(page.getByText("Mold Test Agreement.pdf").first()).toBeVisible();
  // Se recoge UNA vez: recargar no vuelve a abrir el documento.
  expect(await page.evaluate(() => window.sessionStorage.getItem("optimuspdf.signHandoff"))).toBeNull();

  await handoff("sign", [entry.id, "ya-no-existe"]);
  await expect(page.getByText("Un documento ya no está en Mis documentos y no se pudo abrir.")).toBeVisible();
  await expect(notices(page)).toContainText("Plantilla «Mold Test Agreement» aplicada", { timeout: 20_000 });

  await handoff("configure", [entry.id]);
  await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Nombre de la plantilla")).toHaveValue("Mold Test Agreement");
  await expect(page.getByRole("button", { name: "Guardar cambios" })).toBeVisible();
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByText(`En este documento: ${PAGES * 2 + 2} huecos`).first()).toBeVisible();
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toHaveCount(0);

  await handoff("configure", ["ya-no-existe"]);
  await expect(page.getByText("Un documento ya no está en Mis documentos y no se pudo abrir.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toHaveCount(0);
});

test("(vi) lo guardado sobrevive a recargar; editarlo guarda una versión nueva y la copia del PDF no lleva datos", async ({ page }) => {
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  const first = await configureTwoSigners(page, original);
  await page.reload();
  const [reloaded] = await storedTemplates(page);
  expect(reloaded.id).toBe(first.id);
  expect(reloaded.variants["2"].fields).toHaveLength(first.variants["2"].fields.length);
  expect((await storedDocuments(page))).toHaveLength(1);

  // Con el documento cargado, «Configurar plantilla de este documento» abre la guardada (version nueva al guardar).
  await upload(page, "Mold Test.pdf", await reexport(original));
  await expect(notices(page)).toContainText("aplicada", { timeout: 20_000 });
  const options = await openOptions(page);
  await options.root.getByRole("button", { name: "Configurar plantilla de este documento" }).click();
  await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toBeVisible();
  await expect(page.getByText(`En este documento: ${PAGES * 2 + 2} huecos`).first()).toBeVisible();
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.locator("[data-template-saved]")).toBeVisible();
  const [same] = await storedTemplates(page);
  // Sin cambios no se crea version nueva; con un cambio, si.
  expect(same.version).toBe(first.version);
  await page.getByRole("radio", { name: SIGNER_1_ROLE, exact: true }).click().catch(() => undefined);
  await pickTool(page, "Texto");
  await dragOnSheet(page, { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.23 });
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect.poll(async () => (await storedTemplates(page))[0].version).toBe(first.version + 1);
  const [edited] = await storedTemplates(page);
  expect(edited.variants["2"].textFields).toHaveLength(1);
  // El PDF base guardado son los bytes ORIGINALES (no el que se cargo despues), sin ninguna firma.
  const [stored] = await storedDocuments(page);
  expect(stored.byteLength).toBe(original.length);
});

test("(vii) varios documentos: cada uno con SU plantilla, un solo juego de firmantes y un ZIP con las iniciales en todas las páginas de cada uno", async ({ page }) => {
  const mold = await makeContract({ label: "Mold Test Agreement", pages: 5, signers: 2 });
  const pa = await makeContract({ label: "Responsive PA Agreement", pages: 4, signers: 2 });
  // Cada contrato se configura una vez (dos plantillas, dos documentos).
  for (const [name, buffer] of [["Mold Test Agreement.pdf", mold], ["Responsive PA Agreement.pdf", pa]] as const) {
    await openEditorWithFile(page, { name, buffer });
    await placeInitialsLine(page);
    await page.getByRole("button", { name: "Repetir iniciales en todas las páginas" }).click();
    const pages = name.startsWith("Mold") ? 5 : 4;
    await placeSignatureBlock(page, 2, pages - 1);
    await page.getByRole("button", { name: "Guardar plantilla" }).click();
    await expect(page.locator("[data-template-saved]")).toBeVisible();
  }
  expect(await storedTemplates(page)).toHaveLength(2);

  await page.goto("/sign-pdf");
  await fileInput(page).setInputFiles([
    { name: "uno.pdf", mimeType: "application/pdf", buffer: await reexport(mold) },
    { name: "dos.pdf", mimeType: "application/pdf", buffer: await reexport(pa) },
  ]);
  await expect(notices(page).locator("[data-template-notice]")).toHaveCount(2, { timeout: 25_000 });
  await expect(notices(page)).toContainText("uno.pdf: Plantilla «Mold Test Agreement» aplicada");
  await expect(notices(page)).toContainText("dos.pdf: Plantilla «Responsive PA Agreement» aplicada");
  await expect(notices(page)).toContainText(`2 firmantes · ${5 * 2 + 2} campos en 5 páginas`);
  await expect(notices(page)).toContainText(`2 firmantes · ${4 * 2 + 2} campos en 4 páginas`);
  // Un solo juego de firmantes para toda la ronda.
  await expect(page.getByLabel("Nombre del firmante 1")).toHaveCount(1);
  await expect(page.getByLabel("Nombre del firmante 2")).toHaveCount(1);

  await notices(page).getByRole("button", { name: "Ir a firmar" }).first().click();
  const taps = new Taps(page);
  for (const [seed, last] of [[10, false], [21, true]] as const) {
    await page.getByRole("button", { name: "Listo, es mi turno" }).first().click();
    await page.getByRole("button", { name: "Crear mi firma", exact: true }).click();
    await drawInOpenComposer(page, seed);
    await page.getByRole("button", { name: "Crear mis iniciales", exact: true }).click();
    await drawInOpenComposer(page, seed + 7);
    await page.getByRole("button", { name: "Ver cómo queda" }).click();
    await finishTurn(page, last);
  }
  void taps;
  await expect(roundCompleteHeading(page)).toBeVisible();
  // Ola 3: el ZIP se descarga SOLO al terminar; «Descargar» queda de respaldo en la pantalla de resultado.
  const { bytes } = await downloadFile(page, async () => {
    await page.getByRole("button", { name: "Firmar y descargar" }).click();
  });
  await expect(page.getByText("Firmados - 2 documentos.zip", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Se ha descargado «Firmados - 2 documentos.zip»")).toBeVisible();
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible();
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.keys(zip.files).filter((entry) => entry.endsWith(".pdf")).sort();
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    const pdf = Buffer.from(await zip.file(entry)!.async("uint8array"));
    const pageCount = entry.includes("uno") ? 5 : 4;
    expect(await getPageCount(pdf)).toBe(pageCount);
    const placements = await imagePlacements(pdf);
    expect(placements, entry).toHaveLength(pageCount * 2 + 2);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const initials = placements.filter((p) => p.page === pageIndex && p.y > 0.8).sort((a, b) => a.x - b.x);
      expect(initials, `${entry}: iniciales de la pagina ${pageIndex + 1}`).toHaveLength(2);
      expect(initials[0].x + initials[0].width).toBeLessThanOrEqual(initials[1].x + 1e-6);
    }
  }
});

test("(viii) un borrador restaurado manda: recargar la sesión no vuelve a aplicar la plantilla ni duplica los campos", async ({ page }) => {
  const original = await makeContract({ label: "Mold Test Agreement", pages: PAGES, signers: 2 });
  await configureTwoSigners(page, original);
  await page.reload();
  await upload(page, "Mold Test.pdf", await reexport(original));
  await expect(notices(page)).toContainText("aplicada", { timeout: 20_000 });
  expect(await optionsText(page)).toContain(`${PAGES * 2 + 2} huecos en total`);
  // El autoguardado guarda lo aplicado; la direccion lleva la sesion (`?s=`): recargar la restaura.
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain("s=");
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByLabel("Nombre del firmante 1")).toHaveValue(SIGNER_1_ROLE, { timeout: 20_000 });
  await page.waitForTimeout(2500);
  expect(await optionsText(page)).toContain(`${PAGES * 2 + 2} huecos en total`);
  await expect(page.locator("[data-template-notice]")).toHaveCount(0);
});
