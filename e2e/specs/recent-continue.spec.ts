import { expect, test, type Locator, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import {
  collectAllSignatures,
  expectCollectedWorkRestored,
  makeTwoDocs,
  resumeFromDraftsSheet,
} from "../helpers/sign-flow";
import { S as PRO, openProPdf } from "../helpers/pro-flow";

/**
 * Recientes -> «Continuar» tiene que CONTINUAR (Fase 0 «Firma agil», U0.1 test-first, U0.6 lo cumple; plan §1.5 y U0.6).
 *
 * Antes `RecentView` solo leia el historial de `localStorage` (nombre, herramienta y fecha: `src/lib/recent.ts`) y su
 * «Continuar» era un `<Link href="/<herramienta>">` que abria la herramienta VACIA, aunque el trabajo SI estaba guardado
 * en otros almacenes (Firmar: `optimuspdf-sign-drafts`; Editar: `optimuspdf-edit-drafts`; PDF Pro: `optimuspdf-pro-drafts`).
 * Comportamiento que fijan estas pruebas (U0.6):
 *
 *   - una seccion «Sin terminar» alimentada por los borradores reales, con «Continuar» que RESTAURA el trabajo
 *     (`/<herramienta>?resume=<tipo>:<id>`; la herramienta lo lee, lo restaura y limpia la URL);
 *   - borrador desaparecido -> mensaje claro («Este trabajo ya no se puede recuperar en este navegador ...») + «Abrir de nuevo»;
 *   - entradas del historial sin estado -> «Abrir herramienta» (no prometen lo que no hacen);
 *   - el subtitulo deja de decir «Nunca el documento» (los borradores SI guardan el documento);
 *   - `?resume=` con valores manipulados no rompe nada, no restaura nada y se limpia;
 *   - «Descartar» (con confirmacion) borra el borrador; con dos trabajos se restaura el pedido, no otro; ES y EN.
 *
 * Los (e0) son CONTROLES: el mismo trabajo se recupera por la via manual de siempre (Firmar: «Ver borradores»; Editar:
 * «Ver borradores»; PDF Pro: «Documentos recientes»). Prueban que el trabajo esta guardado y que `expectRestored` reconoce
 * un trabajo restaurado: lo que cambia en (e) es que Recientes lo encuentre.
 *
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3811 npx playwright test recent-continue --project=chromium
 *
 * Datos sinteticos y headless siempre (modo por defecto de Playwright).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(240_000);

/* ------------------------------------------------------------------ *
 * Almacenes de borradores (IndexedDB)
 * ------------------------------------------------------------------ */

type DraftDb = "optimuspdf-sign-drafts" | "optimuspdf-edit-drafts" | "optimuspdf-pro-drafts";

/** Filas de un almacen de IndexedDB (-1 = la base o el almacen no existen aun). */
async function storeCount(page: Page, dbName: DraftDb, store: string): Promise<number> {
  return page.evaluate(
    ({ dbName, store }) =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open(dbName);
        request.onerror = () => resolve(-1);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve(-1);
            return;
          }
          const count = db.transaction(store, "readonly").objectStore(store).count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => {
            db.close();
            resolve(-1);
          };
        };
      }),
    { dbName, store },
  );
}

/** Vacia todos los almacenes de la base (como si el borrador se hubiera borrado o caducado en otra pestana). */
async function clearDraftDb(page: Page, dbName: DraftDb): Promise<void> {
  await page.evaluate(
    (name) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const stores = Array.from(db.objectStoreNames);
          if (stores.length === 0) {
            db.close();
            resolve();
            return;
          }
          const tx = db.transaction(stores, "readwrite");
          for (const store of stores) tx.objectStore(store).clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    dbName,
  );
}

/* ------------------------------------------------------------------ *
 * Las tres herramientas: como trabajar, como terminar y como se ve el trabajo restaurado
 * ------------------------------------------------------------------ */

const EDITED_TEXT = "Pagado 99,00";

async function makeEditPdf(label = "Contrato"): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${label} pagina ${index + 1}`, { x: 50, y: 770, size: 24, font });
    page.drawText("Total a pagar: 1.250,00", { x: 50, y: 600, size: 14, font, color: rgb(0.8, 0.1, 0.1) });
  }
  return Buffer.from(await doc.save());
}

const editBlock = (page: Page, text: string) => page.getByRole("button", { name: new RegExp(`^Texto: ${text}`) });

/** Abre un PDF en Editar, cambia «Total a pagar» por `edited` y espera a que el borrador este guardado (`drafts` en total). */
async function workOnEdit(
  page: Page,
  { name = "informe.pdf", label = "Contrato", edited = EDITED_TEXT, drafts = 1 } = {},
): Promise<void> {
  await page.goto("/edit-pdf");
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: "application/pdf",
    buffer: await makeEditPdf(label),
  });
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 30_000 });
  const total = editBlock(page, "Total a pagar");
  await total.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await total.dblclick();
  await expect(page.getByRole("textbox", { name: "Editando el texto del bloque" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(edited);
  await page.keyboard.press("Escape");
  await expect(editBlock(page, edited)).toBeVisible();
  await expect.poll(() => storeCount(page, "optimuspdf-edit-drafts", "draftMeta"), { timeout: 15_000 }).toBe(drafts);
}

type ToolCase = {
  slug: "sign-pdf" | "edit-pdf" | "pdf-pro";
  label: string;
  /** Nombre que muestra la fila del trabajo en Recientes. */
  rowName: string;
  draftDb: DraftDb;
  /** Trabaja hasta dejar un borrador guardado (sin terminar). */
  work: (page: Page) => Promise<void>;
  /** Termina de verdad (exporta) para que exista la fila del historial. */
  finish: ((page: Page) => Promise<void>) | null;
  /** La via MANUAL que existe hoy para recuperar el trabajo (desde la propia herramienta). */
  manualResume: (page: Page) => Promise<void>;
  /** El trabajo esta de vuelta (y no es la herramienta vacia). */
  expectRestored: (page: Page) => Promise<void>;
};

const TOOLS: ToolCase[] = [
  {
    slug: "sign-pdf",
    label: "Firmar PDF",
    rowName: "Contrato A.pdf",
    draftDb: "optimuspdf-sign-drafts",
    work: async (page) => {
      await collectAllSignatures(page, await makeTwoDocs());
      await expect.poll(() => storeCount(page, "optimuspdf-sign-drafts", "sessionMeta"), { timeout: 15_000 }).toBe(1);
    },
    finish: async (page) => {
      await page.getByRole("button", { name: "Firmar y descargar" }).click();
      await expect(page.getByText("Firmados - 2 documentos.zip")).toBeVisible({ timeout: 60_000 });
    },
    manualResume: async (page) => {
      await page.goto("/sign-pdf");
      await resumeFromDraftsSheet(page);
    },
    expectRestored: async (page) => expectCollectedWorkRestored(page, await makeTwoDocs()),
  },
  {
    slug: "edit-pdf",
    label: "Editar PDF",
    rowName: "informe.pdf",
    draftDb: "optimuspdf-edit-drafts",
    work: (page) => workOnEdit(page),
    finish: async (page) => {
      await page.getByRole("button", { name: "Procesar" }).first().click();
      await expect(page.getByRole("button", { name: "Descargar" })).toBeVisible({ timeout: 120_000 });
    },
    manualResume: async (page) => {
      await page.goto("/edit-pdf");
      await page.locator("[data-edit-drafts-button]").click();
      const row = page.locator("[data-draft-id]");
      await expect(row).toHaveCount(1);
      await row.getByRole("button", { name: "Retomar" }).click();
    },
    expectRestored: async (page) => {
      await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
      await expect(editBlock(page, EDITED_TEXT), "la edicion hecha vuelve").toBeVisible({ timeout: 15_000 });
      await expect(page.locator("[data-edit-notices]")).toContainText("Recuperamos tu trabajo anterior");
    },
  },
  {
    slug: "pdf-pro",
    label: "PDF Pro",
    rowName: "informe.pdf",
    draftDb: "optimuspdf-pro-drafts",
    work: async (page) => {
      await openProPdf(page, { name: "informe.pdf", pages: 2 });
      await page.getByRole("button", { name: PRO.operations.rotateAll90, exact: true }).click();
      await expect(page.getByRole("list", { name: PRO.suite.historyTitle }).getByRole("listitem")).toHaveCount(2);
      await expect.poll(() => storeCount(page, "optimuspdf-pro-drafts", "draftMeta"), { timeout: 15_000 }).toBe(1);
    },
    // PDF Pro apunta el historial al ABRIR el documento: no hay un paso «terminar» antes de salir.
    finish: null,
    manualResume: async (page) => {
      await page.goto("/pdf-pro");
      await page.getByRole("button", { name: PRO.empty.recentOpen("informe.pdf") }).click();
    },
    expectRestored: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: /informe\.pdf/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(PRO.suite.unsaved)).toBeVisible();
    },
  },
];

/* ------------------------------------------------------------------ *
 * Localizadores de la pagina Recientes
 * ------------------------------------------------------------------ */

const CONTINUE = "Continuar";

async function openRecent(page: Page): Promise<void> {
  await page.goto("/recent");
  await expect(page.getByRole("heading", { level: 1, name: "Recientes" })).toBeVisible();
}

/** La lista que sigue al encabezado «Sin terminar» (o su titulo en otro idioma). */
function unfinishedList(page: Page, title = "Sin terminar"): Locator {
  return page.getByRole("heading", { name: title }).locator("xpath=following::ul[1]");
}

/** Todos los «Continuar» de la pagina (enlaces o botones). */
function continueControls(page: Page): Locator {
  return page
    .getByRole("main")
    .getByRole("link", { name: CONTINUE, exact: true })
    .or(page.getByRole("main").getByRole("button", { name: CONTINUE, exact: true }));
}

/* ------------------------------------------------------------------ *
 * (e) por herramienta
 * ------------------------------------------------------------------ */

for (const tool of TOOLS) {
  test.describe(`Recientes -> Continuar · ${tool.label}`, () => {
    test(`(e0) control: el trabajo de ${tool.label} SI se recupera por la via manual que existe hoy`, async ({ page }) => {
      await tool.work(page);
      await tool.manualResume(page);
      await tool.expectRestored(page);
    });

    test(`(e) ${tool.label}: trabajar y salir; Recientes lista el trabajo en «Sin terminar» y «Continuar» lo restaura`, async ({
      page,
    }) => {
      await tool.work(page);

      await openRecent(page);
      // CORRECTO: «Sin terminar» sale de los borradores reales. HOY: Recientes solo lee el historial de localStorage.
      await expect(
        page.getByRole("heading", { name: "Sin terminar" }),
        "Recientes debe listar los trabajos sin terminar (hoy solo lee el historial: nombre, herramienta y fecha)",
      ).toBeVisible();
      const row = unfinishedList(page).getByRole("listitem").filter({ hasText: tool.rowName });
      await expect(row).toBeVisible();
      await row.getByRole("link", { name: CONTINUE }).or(row.getByRole("button", { name: CONTINUE })).click();

      await tool.expectRestored(page);
    });

    test(`(e2) ${tool.label}: ningun «Continuar» de Recientes abre la herramienta vacia`, async ({ page }) => {
      await tool.work(page);
      if (tool.finish) await tool.finish(page);

      await openRecent(page);
      // La pagina ya pinto sus filas (hay algo que continuar o abrir).
      await expect(page.getByRole("main").getByRole("listitem").first()).toBeVisible();
      const count = await continueControls(page).count();
      if (count === 0) {
        // Sin «Continuar» solo vale que cada fila diga con honestidad lo que hace.
        await expect(page.getByRole("main").getByRole("link", { name: "Abrir herramienta" }).first()).toBeVisible();
        return;
      }
      for (let index = 0; index < count; index += 1) {
        if (index > 0) await openRecent(page);
        await continueControls(page).nth(index).click();
        // HOY: lleva a `/<herramienta>` sin nada cargado (la herramienta vacia) y esta comprobacion falla.
        await tool.expectRestored(page);
      }
    });

    test(`(e3) ${tool.label}: si el borrador ya no existe, «Continuar» lo dice claro y ofrece «Abrir de nuevo»`, async ({
      page,
    }) => {
      await tool.work(page);
      await openRecent(page);
      await expect(page.getByRole("heading", { name: "Sin terminar" })).toBeVisible();
      const row = unfinishedList(page).getByRole("listitem").filter({ hasText: tool.rowName });
      await expect(row).toBeVisible();

      // El borrador se borra (o caduca) DESPUES de pintar la lista: la fila sigue ahi pero ya no hay nada que restaurar.
      await clearDraftDb(page, tool.draftDb);
      await row.getByRole("link", { name: CONTINUE }).or(row.getByRole("button", { name: CONTINUE })).click();

      await expect(page.getByText(/Este trabajo ya no se puede recuperar en este navegador/)).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByRole("button", { name: "Abrir de nuevo" }).or(page.getByRole("link", { name: "Abrir de nuevo" })),
      ).toBeVisible();
    });
  });
}

/* ------------------------------------------------------------------ *
 * Historial sin estado y textos honestos
 * ------------------------------------------------------------------ */

test.describe("Recientes: textos honestos", () => {
  test("(e4) una entrada del historial sin trabajo guardado dice «Abrir herramienta», no «Continuar»", async ({ page }) => {
    await page.goto("/recent");
    // Una herramienta sin borradores (Unir PDF): una entrada de historial sin nada que restaurar.
    await page.evaluate(() =>
      localStorage.setItem(
        "optimuspdf.recent",
        JSON.stringify([{ id: "e4", slug: "merge-pdf", fileName: "viejo.pdf", date: new Date().toISOString() }]),
      ),
    );
    await page.reload();

    const row = page.getByRole("main").getByRole("listitem").filter({ hasText: "viejo.pdf" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: "Abrir herramienta" }), "sin estado, la fila no promete continuar nada").toBeVisible();
    await expect(row.getByRole("link", { name: CONTINUE, exact: true })).toHaveCount(0);
  });

  test("(e5) el subtitulo y la descripcion de /recent ya no dicen «Nunca el documento»", async ({ page }) => {
    await openRecent(page);
    await expect(
      page.getByText("Los trabajos sin terminar se guardan solo en este navegador, con el documento, para poder continuarlos"),
    ).toBeVisible();
    await expect(page.getByText(/Nunca el documento/)).toHaveCount(0);
    const description = await page.locator('meta[name="description"]').getAttribute("content");
    expect(description ?? "", "la metadescripcion tampoco debe negar que se guarda el documento").not.toMatch(/Nunca el documento/);
  });
});

/* ------------------------------------------------------------------ *
 * U0.6: la URL de «Continuar» es entrada no confiable, la URL queda limpia, «Descartar», dos trabajos, ES/EN
 * ------------------------------------------------------------------ */

const HEX64 = "ab".repeat(32);

/** Valores de `?resume=` que alguien podria escribir o pegar a mano. Ninguno debe romper nada ni restaurar nada. */
function manipulatedValues(slug: ToolCase["slug"]): string[] {
  const own = slug === "sign-pdf" ? "sign" : slug === "edit-pdf" ? "edit" : "pro";
  const foreign = slug === "pdf-pro" ? "edit" : "pro";
  return [
    `<img src=x onerror="window.__pwned=1">`,
    `</script><script>window.__pwned=1</script>`,
    `javascript:window.__pwned=1`,
    `__proto__:${HEX64}`,
    `constructor:${HEX64}`,
    `${own}:../../etc/passwd`,
    `${own}:${HEX64.slice(0, 63)}`,
    `${own}:${HEX64.toUpperCase()}`,
    `${own}:${HEX64}:${HEX64}`,
    // Un trabajo valido pero de OTRA herramienta: esta no lo restaura ni lo anuncia.
    `${foreign}:${HEX64}`,
    "session:s-<script>",
    "x".repeat(5000),
    "",
  ];
}

/**
 * Errores de pagina y de consola. Se ignoran las precargas de Next (`?_rsc=`) que el navegador aborta al navegar de
 * golpe a otra URL: WebKit las cuenta como `pageerror` («due to access control checks»), no tienen que ver con la pagina.
 */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  const ignorable = /[?&]_rsc=/;
  page.on("pageerror", (error) => {
    if (!ignorable.test(error.message)) errors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !ignorable.test(message.text())) errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

for (const tool of TOOLS) {
  test.describe(`Recientes -> ?resume= · ${tool.label}`, () => {
    test(`(e6) ${tool.label}: un ?resume= manipulado no rompe, no restaura nada, no avisa y se limpia de la URL`, async ({ page }) => {
      const errors = watchPageErrors(page);
      const dropzone = page.locator('input[type="file"][accept*="pdf"]');
      for (const value of manipulatedValues(tool.slug)) {
        await page.goto(`/${tool.slug}?resume=${encodeURIComponent(value)}`);
        await expect(dropzone.first(), `la herramienta abre vacia con resume=${value.slice(0, 40)}`).toBeAttached();
        await expect.poll(() => new URL(page.url()).searchParams.has("resume"), { message: "la URL se limpia" }).toBe(false);
        await expect(page.getByText(/ya no se puede recuperar/)).toHaveCount(0);
        expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
        // El valor nunca se pinta en la pagina.
        expect(await page.locator("body").innerText()).not.toContain("onerror=");
      }
      // Dos `resume=` a la vez tampoco restauran nada.
      await page.goto(`/${tool.slug}?resume=edit:${HEX64}&resume=pro:${HEX64}`);
      await expect(dropzone.first()).toBeAttached();
      await expect.poll(() => new URL(page.url()).searchParams.has("resume")).toBe(false);
      await expect(page.getByText(/ya no se puede recuperar/)).toHaveCount(0);
      expect(errors, "ningun error de pagina ni de consola").toEqual([]);
    });

    test(`(e7) ${tool.label}: tras «Continuar» la URL queda limpia y «Atras» vuelve a Recientes (sin entradas atrapadas)`, async ({
      page,
    }) => {
      await tool.work(page);
      await openRecent(page);
      const row = unfinishedList(page).getByRole("listitem").filter({ hasText: tool.rowName });
      await row.getByRole("link", { name: CONTINUE }).click();
      await tool.expectRestored(page);

      // El parametro ya no esta en la direccion: recargar no vuelve a restaurar ni queda un enlace atrapado.
      expect(new URL(page.url()).pathname).toBe(`/${tool.slug}`);
      if (tool.slug === "sign-pdf") {
        // U0.3 (punto 3): `?resume=` se CONVIERTE en `?s=<idOpaco>` (la sesion en la URL, que SI restaura al recargar y
        // protege el «Atras»). `resume` ya no esta; `s` es un id de sesion sin nombres de archivo.
        await expect.poll(() => new URL(page.url()).searchParams.get("s")).toMatch(/^s-[a-z0-9]+-[a-z0-9]+$/);
        expect(new URL(page.url()).searchParams.has("resume")).toBe(false);
        expect(page.url()).not.toMatch(/\.pdf|Contrato|Anexo/);
        // «Atras» vuelve a /sign-pdf sin `s` (misma pagina): pregunta antes de irse; «Salir» llega a Recientes, a UN paso.
        await page.goBack();
        const leave = page.getByRole("dialog", { name: /Salir de la firma/ });
        await expect(leave).toBeVisible();
        await leave.getByRole("button", { name: "Salir", exact: true }).click();
      } else {
        await expect.poll(() => new URL(page.url()).search).toBe("");
        await page.goBack();
      }
      await expect(page).toHaveURL(/\/recent$/);
      await expect(page.getByRole("heading", { level: 1, name: "Recientes" })).toBeVisible();
    });

    test(`(e8) ${tool.label}: «Descartar» pide confirmacion; «Cancelar» no borra y «Descartar» borra el borrador`, async ({ page }) => {
      await tool.work(page);
      await openRecent(page);
      const row = unfinishedList(page).getByRole("listitem").filter({ hasText: tool.rowName });
      const discard = row.getByRole("button", { name: /^Descartar/ });
      await expect(discard).toBeVisible();

      await discard.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(`¿Descartar «${tool.rowName}»?`)).toBeVisible();
      await dialog.getByRole("button", { name: "Cancelar" }).click();
      await expect(dialog).toBeHidden();
      await expect(row).toBeVisible();
      const store = tool.draftDb === "optimuspdf-sign-drafts" ? "sessionMeta" : "draftMeta";
      expect(await storeCount(page, tool.draftDb, store), "Cancelar no borra nada").toBe(1);

      await discard.click();
      await page.getByRole("dialog").getByRole("button", { name: "Descartar", exact: true }).click();
      await expect(row).toHaveCount(0);
      await expect.poll(() => storeCount(page, tool.draftDb, store), { message: "el borrador se borro" }).toBe(0);
      await expect(page.getByRole("heading", { name: "Sin terminar" })).toHaveCount(0);
      await expect(page.getByText("Trabajo descartado.")).toBeAttached();
      // El foco no cae a <body>.
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
      // Y recargar Recientes confirma que de verdad ya no esta.
      await openRecent(page);
      await expect(page.getByRole("heading", { name: "Sin terminar" })).toHaveCount(0);
    });
  });
}

test.describe("Recientes: con DOS trabajos, «Continuar» restaura el pedido y no otro", () => {
  test("(e9) PDF Pro", async ({ page }) => {
    for (const [name, label] of [
      ["alfa.pdf", "ALFA"],
      ["beta.pdf", "BETA"],
    ] as const) {
      await openProPdf(page, { name, pages: 2, label });
      await page.getByRole("button", { name: PRO.operations.rotateAll90, exact: true }).click();
      await expect(page.getByRole("list", { name: PRO.suite.historyTitle }).getByRole("listitem")).toHaveCount(2);
    }
    await expect.poll(() => storeCount(page, "optimuspdf-pro-drafts", "draftMeta"), { timeout: 15_000 }).toBe(2);

    await openRecent(page);
    const rows = unfinishedList(page).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await rows.filter({ hasText: "alfa.pdf" }).getByRole("link", { name: CONTINUE }).click();
    await expect(page.getByRole("heading", { level: 1, name: /alfa\.pdf/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(PRO.suite.unsaved)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: /beta\.pdf/ })).toHaveCount(0);

    await openRecent(page);
    await unfinishedList(page).getByRole("listitem").filter({ hasText: "beta.pdf" }).getByRole("link", { name: CONTINUE }).click();
    await expect(page.getByRole("heading", { level: 1, name: /beta\.pdf/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1, name: /alfa\.pdf/ })).toHaveCount(0);
  });

  test("(e9) Editar PDF", async ({ page }) => {
    await workOnEdit(page, { name: "uno.pdf", label: "Uno", edited: "Pagado UNO" });
    await workOnEdit(page, { name: "dos.pdf", label: "Dos", edited: "Pagado DOS", drafts: 2 });

    await openRecent(page);
    const rows = unfinishedList(page).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await rows.filter({ hasText: "uno.pdf" }).getByRole("link", { name: CONTINUE }).click();
    await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
    await expect(editBlock(page, "Pagado UNO")).toBeVisible({ timeout: 15_000 });
    await expect(editBlock(page, "Pagado DOS")).toHaveCount(0);

    await openRecent(page);
    await unfinishedList(page).getByRole("listitem").filter({ hasText: "dos.pdf" }).getByRole("link", { name: CONTINUE }).click();
    await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
    await expect(editBlock(page, "Pagado DOS")).toBeVisible({ timeout: 15_000 });
    await expect(editBlock(page, "Pagado UNO")).toHaveCount(0);
  });
});

test.describe("Recientes: iPad y accesibilidad", () => {
  test("(e10) las filas se ven completas y sus controles miden al menos 44 px", async ({ page }) => {
    await TOOLS[2].work(page);
    await openRecent(page);
    const row = unfinishedList(page).getByRole("listitem").first();
    await expect(row).toBeVisible();
    for (const control of [row.getByRole("link", { name: CONTINUE }), row.getByRole("button", { name: /^Descartar/ })]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0, "alto del control").toBeGreaterThanOrEqual(43.5);
      expect(box?.width ?? 0, "ancho del control").toBeGreaterThanOrEqual(43.5);
    }
    const bar = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(bar, "sin desborde horizontal").toBe(true);
  });

  test("(e10b) en un telefono (375 px) la lista cabe sin desborde y los controles siguen midiendo 44 px", async ({ page }) => {
    await TOOLS[2].work(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await openRecent(page);
    const row = unfinishedList(page).getByRole("listitem").first();
    await expect(row).toBeVisible();
    for (const control of [row.getByRole("link", { name: CONTINUE }), row.getByRole("button", { name: /^Descartar/ })]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("(e10c) se llega a «Continuar» y a «Descartar» con el teclado y el foco se ve", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "Safari no enfoca enlaces con Tab por defecto (ver docs/COMPATIBILIDAD-NAVEGADORES.md)");
    await TOOLS[2].work(page);
    await openRecent(page);
    const link = unfinishedList(page).getByRole("link", { name: CONTINUE }).first();
    await expect(link).toBeVisible();
    let focusedLink = false;
    let focusedDiscard = false;
    for (let step = 0; step < 40 && !(focusedLink && focusedDiscard); step += 1) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          text: (el.textContent ?? "").trim(),
          label: el.getAttribute("aria-label") ?? "",
          outline: parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== "none",
        };
      });
      if (info?.text === "Continuar") {
        focusedLink = true;
        expect(info.outline, "«Continuar» muestra el anillo de foco").toBe(true);
      }
      if (info?.label.startsWith("Descartar")) {
        focusedDiscard = true;
        expect(info.outline, "«Descartar» muestra el anillo de foco").toBe(true);
      }
    }
    expect(focusedLink && focusedDiscard).toBe(true);
  });
});

test.describe("Recientes en ingles", () => {
  test("(e11) «Unfinished», «Continue», «Open tool», el aviso de trabajo perdido y la fecha salen en ingles, sin claves crudas", async ({
    page,
  }) => {
    // El trabajo se hace en espanol (los textos de los botones del flujo); despues el idioma pasa a ingles.
    await TOOLS[2].work(page);
    await page.evaluate(() => {
      localStorage.setItem("optimuspdf.language", "en");
      localStorage.setItem(
        "optimuspdf.recent",
        JSON.stringify([{ id: "e11", slug: "merge-pdf", fileName: "old.pdf", date: new Date().toISOString() }]),
      );
    });
    await page.goto("/recent");
    await expect(page.getByRole("heading", { level: 1, name: "Recent" })).toBeVisible();
    await expect(page.getByText("Unfinished jobs are saved only in this browser, with the document, so you can continue them.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Unfinished" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    const row = unfinishedList(page, "Unfinished").getByRole("listitem").filter({ hasText: "informe.pdf" });
    await expect(row.getByRole("link", { name: "Continue" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Discard informe.pdf" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: "Open tool" })).toBeVisible();
    const text = await page.getByRole("main").innerText();
    expect(text).not.toMatch(/recent\.|resume\.|\{n\}|\{name\}|Sin terminar|Continuar|Abrir herramienta/);

    // Continuar restaura y, si el trabajo ya no existe, el aviso tambien sale en ingles.
    await row.getByRole("link", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 1, name: /informe\.pdf/ })).toBeVisible({ timeout: 15_000 });
    await page.goto(`/edit-pdf?resume=edit:${HEX64}`);
    await expect(page.getByText("This work can no longer be recovered in this browser (it was deleted or expired).")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open again" })).toBeVisible();
  });
});

test.describe("Recientes: accesibilidad (axe)", () => {
  test("(e12) la pagina con trabajos sin terminar y con el aviso de trabajo perdido no tiene violaciones", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "axe-core se valida en Chromium (como `a11y-sweep`)");
    await TOOLS[2].work(page);
    await page.evaluate(() =>
      localStorage.setItem(
        "optimuspdf.recent",
        JSON.stringify([{ id: "e12", slug: "merge-pdf", fileName: "viejo.pdf", date: new Date().toISOString() }]),
      ),
    );
    const axePath = require.resolve("axe-core/axe.min.js");
    const rules = ["color-contrast", "aria-valid-attr-value", "label", "button-name", "link-name", "aria-allowed-attr", "list", "listitem"];
    async function scan(): Promise<string[]> {
      // La pagina entra con una animacion: axe mide el contraste con la opacidad a medias y da falsos positivos.
      await page.waitForTimeout(1500);
      await page.addScriptTag({ path: axePath });
      return page.evaluate(async (ids) => {
        const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; nodes: unknown[] }> }> } }).axe;
        const result = await axe.run(document, { runOnly: { type: "rule", values: ids } });
        return result.violations.map((violation) => `${violation.id} x${violation.nodes.length}`);
      }, rules);
    }
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/recent");
      await expect(page.getByRole("heading", { name: "Sin terminar" })).toBeVisible();
      expect(await scan(), `Recientes (${scheme})`).toEqual([]);
      await page.goto(`/edit-pdf?resume=edit:${HEX64}`);
      await expect(page.getByText(/ya no se puede recuperar/)).toBeVisible();
      expect(await scan(), `aviso de trabajo perdido (${scheme})`).toEqual([]);
    }
  });
});
