import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { build } from "vite";
import { isBenignEngineNoise } from "../helpers/engine";
import { makeContractPdf, resave } from "../../src/lib/docLibrary/testing/syntheticContracts";

/**
 * «Mis documentos» (U2.5) y Recientes unificado (U2.6) en un navegador real y headless (Chromium y `webkit-ipad`).
 *
 *   - Anadir 3 contratos (PDF sinteticos) -> aparecen con ✗ «Sin plantilla» -> la plantilla se crea con las funciones de
 *     `src/lib/docLibrary/templates.ts` desde la prueba -> ✓ lista / ✓ de 1 firmante -> recargar: persisten.
 *   - «Firmar» / «Configurar plantilla» / «Firmar seleccionados» dejan el traspaso (`optimuspdf.signHandoff`) y navegan a
 *     /sign-pdf. El consumidor lo implementa otra unidad: aqui se registra lo que se ESCRIBIO en sessionStorage (un espia
 *     de `setItem`), no se depende de que Firmar lo recoja.
 *   - Renombrar, reemplazar PDF (aviso si la plantilla ya no coincide) y borrar con confirmacion; miniaturas reales (pdf.js).
 *   - Inicio (seccion) y /documents; Recientes: «Borrar», «Borrar todo», «Abrir de nuevo» con la copia de la biblioteca.
 *   - axe-core: 0 violaciones en claro/oscuro x ES/EN x 1280/375; sin desbordes a 375 y 320 px con fuente ancha.
 *
 * PATRON del paquete de pruebas: igual que `doc-fingerprint.spec.ts` (Vite al vuelo + pagina de la app con su CSP real).
 *   CSP_SKIP_UPGRADE_INSECURE=1 CI=1 PW_REUSE_SERVER=1 PW_PORT=3962 [PW_BROWSERS=webkit-ipad] npx playwright test my-documents
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(240_000);

let libBundle = "";

async function bundle(entry: string, name: string): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    build: { write: false, minify: false, target: "es2022", lib: { entry: path.resolve(process.cwd(), entry), name, formats: ["iife"], fileName: () => `${name}.js` } },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error(`no se pudo empaquetar ${entry}`);
  return chunk.code;
}

type Contract = { name: string; docType: string; pages: number; seed: number; buffer: Buffer };
const CONTRACTS: Contract[] = [];
let resavedFirst: Buffer;

test.beforeAll(async () => {
  libBundle = await bundle("e2e/helpers/documents-entry.ts", "DocsLib");
  const specs = [
    { name: "Remediación de moho", docType: "contrato de servicio", pages: 4, seed: 11 },
    { name: "Mitigación de agua", docType: "autorización", pages: 3, seed: 22 },
    { name: "Prueba de moho", docType: "contrato de servicio", pages: 5, seed: 33 },
  ];
  for (const spec of specs) CONTRACTS.push({ ...spec, buffer: Buffer.from(await makeContractPdf({ seed: spec.seed, pages: spec.pages })) });
  resavedFirst = Buffer.from(await resave(new Uint8Array(CONTRACTS[0].buffer), { useObjectStreams: true }));
});

/* ------------------------------------------------------------------ *
 * Ayudantes
 * ------------------------------------------------------------------ */

type Theme = "light" | "dark";
type Language = "es" | "en";

async function newContext(browser: Browser, theme: Theme = "light", language: Language = "es"): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, locale: language === "es" ? "es-ES" : "en-US" });
  await context.addInitScript(
    ([themeName, lang]) => {
      try {
        if (window.sessionStorage.getItem("__seeded")) return;
        window.localStorage.setItem("optimuspdf.theme", themeName);
        window.localStorage.setItem("optimuspdf.language", lang);
        window.sessionStorage.setItem("__seeded", "1");
      } catch {
        /* almacenamiento bloqueado */
      }
    },
    [theme, language],
  );
  return context;
}

type Handoff = { documentIds: string[]; mode: "sign" | "configure"; createdAt: number };

/** Registra TODO lo que se escribe en `optimuspdf.signHandoff` (Firmar podria recogerlo y borrarlo enseguida). */
async function spyHandoff(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __handoffs: unknown[] };
    w.__handoffs = w.__handoffs ?? [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "optimuspdf.signHandoff") w.__handoffs.push(JSON.parse(value));
      return original.call(this, key, value);
    };
  });
}
const handoffs = (page: Page) => page.evaluate(() => (window as unknown as { __handoffs: Handoff[] }).__handoffs);

async function withLib<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  if (!(await page.evaluate(() => "DocsLib" in window))) await page.addScriptTag({ content: libBundle });
  return page.evaluate(
    async ({ code, value }) => {
      const lib = (window as unknown as { DocsLib: Record<string, unknown> }).DocsLib;
      return (new Function("lib", "arg", `return (async () => { ${code} })();`)(lib, value) as Promise<T>);
    },
    { code: fn, value: arg },
  );
}

async function openDocuments(page: Page): Promise<void> {
  await page.goto("/documents");
  await expect(page.getByRole("heading", { level: 1, name: "Mis documentos" })).toBeVisible();
}

async function addContract(page: Page, contract: Contract): Promise<void> {
  await page.getByRole("button", { name: "Añadir contrato" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Añadir contrato" });
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-add-file]").setInputFiles({ name: `${contract.name}.pdf`, mimeType: "application/pdf", buffer: contract.buffer });
  const name = dialog.getByLabel("Nombre");
  await expect(name).toHaveValue(contract.name);
  await dialog.getByLabel("Tipo de documento").fill(contract.docType);
  await dialog.getByRole("button", { name: "Guardar documento" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(card(page, contract.name)).toBeVisible();
}

const card = (page: Page, name: string) => page.locator("[data-document-id]", { has: page.getByRole("heading", { level: 3, name, exact: true }) });
const stateOf = (page: Page, name: string) => card(page, name).locator("[data-template-state]");

async function seedThree(page: Page): Promise<string[]> {
  await openDocuments(page);
  for (const contract of CONTRACTS) await addContract(page, contract);
  const ids = await withLib<string[]>(page, `const { documents } = await lib.listDocuments(); return documents.map((d) => d.name + "|" + d.id);`);
  return CONTRACTS.map((c) => ids.find((entry) => entry.startsWith(`${c.name}|`))!.split("|")[1]);
}

async function makeReady(page: Page, id: string) {
  await withLib(page, `await lib.createTemplate(lib.sampleDraft(arg));`, id);
}
async function makeSingle(page: Page, id: string) {
  await withLib(page, `await lib.createTemplate(lib.sampleDraft(arg, { variants: { "1": lib.variantOf([lib.signField()]), "2": lib.variantOf([]) } }));`, id);
}

/* ------------------------------------------------------------------ *
 * Flujo completo
 * ------------------------------------------------------------------ */

test.describe("Mis documentos · flujo", () => {
  test("añadir 3 contratos (✗) -> crear plantillas (✓) -> recargar: persisten -> Firmar / Configurar / seleccionados", async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await spyHandoff(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      if (!isBenignEngineNoise(error.message)) errors.push(error.message);
    });
    try {
      await openDocuments(page);
      // Estado vacío.
      await expect(page.getByText("Sube tus contratos una vez y configura dónde firma cada quien")).toBeVisible();
      await expect(page.getByText("Se guarda una copia en este navegador; usa contratos en blanco, sin datos de clientes.")).toBeVisible();

      const ids = await seedThree(page);
      for (const contract of CONTRACTS) {
        await expect(stateOf(page, contract.name)).toHaveAttribute("data-template-state", "none");
        await expect(card(page, contract.name).getByText("Sin plantilla")).toBeVisible();
        await expect(card(page, contract.name)).toContainText(`${contract.pages} páginas`);
      }
      // Primer documento guardado: se pidió el almacenamiento persistente y el estado se muestra.
      await expect(page.locator("[data-persist-state]")).toBeVisible();
      // Miniaturas reales (pdf.js) en segundo plano.
      for (const contract of CONTRACTS) await expect(card(page, contract.name).locator("img[data-doc-thumb]")).toBeVisible({ timeout: 30_000 });

      // La plantilla se crea con las funciones de templates.ts: ✗ -> ✓ en vivo (sin recargar).
      await makeReady(page, ids[0]);
      await makeSingle(page, ids[1]);
      await expect(stateOf(page, CONTRACTS[0].name)).toHaveAttribute("data-template-state", "ready");
      await expect(card(page, CONTRACTS[0].name).getByText("Plantilla lista (1 y 2 firmantes)")).toBeVisible();
      await expect(stateOf(page, CONTRACTS[1].name)).toHaveAttribute("data-template-state", "single");
      await expect(card(page, CONTRACTS[1].name).getByText("Plantilla de 1 firmante")).toBeVisible();
      await expect(stateOf(page, CONTRACTS[2].name)).toHaveAttribute("data-template-state", "none");

      // Recargar: todo persiste.
      await page.reload();
      await expect(page.locator("[data-document-id]")).toHaveCount(3);
      await expect(stateOf(page, CONTRACTS[0].name)).toHaveAttribute("data-template-state", "ready");
      await expect(stateOf(page, CONTRACTS[1].name)).toHaveAttribute("data-template-state", "single");
      await expect(stateOf(page, CONTRACTS[2].name)).toHaveAttribute("data-template-state", "none");

      // «Firmar»: deja el traspaso y navega.
      await card(page, CONTRACTS[0].name).getByRole("button", { name: /^Firmar/ }).click();
      await expect(page).toHaveURL(/\/sign-pdf$/);
      expect(await handoffs(page)).toMatchObject([{ documentIds: [ids[0]], mode: "sign" }]);

      // «Configurar plantilla» del tercero.
      await openDocuments(page);
      await card(page, CONTRACTS[2].name).getByRole("button", { name: /^Configurar plantilla/ }).click();
      await expect(page).toHaveURL(/\/sign-pdf$/);
      expect(await handoffs(page)).toMatchObject([{ documentIds: [ids[2]], mode: "configure" }]);

      // «Firmar seleccionados» con los 3 (orden de la lista: más reciente primero).
      await openDocuments(page);
      for (const contract of CONTRACTS) await card(page, contract.name).getByRole("checkbox").check();
      await expect(page.locator("[data-documents-selection]")).toContainText("3 seleccionados");
      await page.getByRole("button", { name: "Firmar seleccionados (3)" }).click();
      await expect(page).toHaveURL(/\/sign-pdf$/);
      const [handoff] = await handoffs(page);
      expect(handoff.mode).toBe("sign");
      expect([...handoff.documentIds].sort()).toEqual([...ids].sort());
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("renombrar, reemplazar PDF (aviso si la plantilla ya no coincide) y borrar con confirmación", async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    try {
      const ids = await seedThree(page);
      await makeReady(page, ids[0]);
      await expect(stateOf(page, CONTRACTS[0].name)).toHaveAttribute("data-template-state", "ready");

      // Renombrar.
      await card(page, CONTRACTS[2].name).getByRole("button", { name: /^Más acciones de/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Renombrar" }).click();
      const rename = page.getByRole("dialog", { name: "Renombrar documento" });
      await rename.getByLabel("Nombre").fill("Prueba de moho 2026");
      await rename.getByRole("button", { name: "Guardar" }).click();
      await expect(card(page, "Prueba de moho 2026")).toBeVisible();
      await expect(page.locator("[data-documents-live]")).toHaveText("Documento renombrado a «Prueba de moho 2026».");

      // Reemplazar por el MISMO contrato re-exportado (bytes distintos): la plantilla sigue valiendo, sin aviso.
      const replaceInput = page.locator("[data-replace-input]");
      await card(page, CONTRACTS[0].name).getByRole("button", { name: /^Más acciones de/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Reemplazar PDF" }).click();
      await replaceInput.setInputFiles({ name: "re-exportado.pdf", mimeType: "application/pdf", buffer: resavedFirst });
      await expect(page.locator("[data-documents-live]")).toHaveText(`Se reemplazó el PDF de «${CONTRACTS[0].name}».`, { timeout: 30_000 });
      await expect(page.locator("[data-documents-warning]")).toHaveCount(0);
      await expect(stateOf(page, CONTRACTS[0].name)).toHaveAttribute("data-template-state", "ready");

      // Reemplazar por OTRO contrato: avisa que la plantilla ya no coincide.
      await card(page, CONTRACTS[0].name).getByRole("button", { name: /^Más acciones de/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Reemplazar PDF" }).click();
      await replaceInput.setInputFiles({ name: "otro.pdf", mimeType: "application/pdf", buffer: CONTRACTS[1].buffer });
      await expect(page.locator("[data-documents-warning]")).toContainText("ya no coincide con su plantilla", { timeout: 30_000 });
      await expect(card(page, CONTRACTS[0].name)).toContainText("3 páginas");

      // Borrar: «Cancelar» no borra; «Borrar» sí.
      await card(page, CONTRACTS[1].name).getByRole("button", { name: /^Más acciones de/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Borrar" }).click();
      const confirm = page.getByRole("dialog", { name: `¿Borrar «${CONTRACTS[1].name}»?` });
      await confirm.getByRole("button", { name: "Cancelar" }).click();
      await expect(confirm).toBeHidden();
      await expect(page.locator("[data-document-id]")).toHaveCount(3);
      await card(page, CONTRACTS[1].name).getByRole("button", { name: /^Más acciones de/ }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Borrar" }).click();
      await page.getByRole("dialog", { name: `¿Borrar «${CONTRACTS[1].name}»?` }).getByRole("button", { name: "Borrar" }).click();
      await expect(page.locator("[data-document-id]")).toHaveCount(2);
      await expect(page.locator("[data-documents-live]")).toHaveText(`«${CONTRACTS[1].name}» borrado.`);
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
      await page.reload();
      await expect(page.locator("[data-document-id]")).toHaveCount(2);
    } finally {
      await context.close();
    }
  });

  test("Inicio muestra la sección (hasta 4, con ✓/✗), 'Ver todos' lleva a /documents y 'Firmar' deja el traspaso", async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await spyHandoff(page);
    try {
      await page.goto("/");
      await expect(page.locator("[data-home-documents-empty]")).toBeVisible();
      const ids = await seedThree(page);
      await makeReady(page, ids[2]);
      for (let index = 0; index < 2; index += 1) {
        await withLib(page, `const { putDocument, listDocuments, getDocumentBytes } = lib; const [first] = (await listDocuments()).documents; const bytes = await getDocumentBytes(first.id); await putDocument({ ...first, id: "extra-${index}", name: "Extra ${index}", fingerprint: { ...first.fingerprint, exact: "${String(index + 1).repeat(64)}" }, templateIds: [] }, bytes);`);
      }
      await page.goto("/");
      const section = page.locator("[data-home-documents]");
      await expect(section.locator("[data-document-id]")).toHaveCount(4);
      await expect(section.getByRole("heading", { level: 2, name: "Mis documentos" })).toBeVisible();
      await expect(section.locator('[data-template-state="ready"]')).toHaveCount(1);
      // Antes de «Más usadas» (si existe) y después del buscador.
      const order = await page.evaluate(() => {
        const home = document.querySelector("[data-home-documents]")!;
        const search = document.querySelector('input[type="search"]')!;
        return Boolean(search.compareDocumentPosition(home) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      expect(order).toBe(true);
      await section.getByRole("button", { name: new RegExp(`^Firmar ${CONTRACTS[2].name}$`) }).click();
      await expect(page).toHaveURL(/\/sign-pdf$/);
      expect(await handoffs(page)).toMatchObject([{ documentIds: [ids[2]], mode: "sign" }]);
      await page.goto("/");
      await page.locator("[data-home-documents]").getByRole("link", { name: "Ver todos" }).click();
      await expect(page).toHaveURL(/\/documents$/);
      await expect(page.locator("[data-document-id]")).toHaveCount(5);
    } finally {
      await context.close();
    }
  });

  test("sin IndexedDB: estado explicativo, sin errores y Inicio no se rompe", async ({ browser }) => {
    const context = await newContext(browser);
    await context.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      if (!isBenignEngineNoise(error.message)) errors.push(error.message);
    });
    try {
      await page.goto("/documents");
      await expect(page.getByRole("heading", { name: "Este navegador no puede guardar documentos" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Añadir contrato" })).toHaveCount(0);
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "Herramientas" })).toBeVisible();
      await expect(page.locator("[data-home-documents]")).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Recientes unificado
 * ------------------------------------------------------------------ */

test.describe("Recientes unificado", () => {
  test("historial: 'Borrar' por fila, 'Borrar todo' con confirmación, aviso fijo y 'Abrir de nuevo' con la copia de la biblioteca", async ({ browser }) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await spyHandoff(page);
    try {
      const ids = await seedThree(page);
      const exact = await withLib<string>(page, `return (await lib.getDocument(arg)).fingerprint.exact;`, ids[0]);
      await page.evaluate(
        ([hash]) =>
          localStorage.setItem(
            "optimuspdf.recent",
            JSON.stringify([
              { id: "r1", slug: "sign-pdf", fileName: "Firmado.pdf", date: new Date().toISOString(), resume: { kind: "sign", id: hash } },
              { id: "r2", slug: "merge-pdf", fileName: "unido.pdf", date: new Date(Date.now() - 1000).toISOString() },
              { id: "r3", slug: "rotate-pdf", fileName: "girado.pdf", date: new Date(Date.now() - 2000).toISOString() },
            ]),
          ),
        [exact],
      );
      await page.goto("/recent");
      await expect(page.getByRole("heading", { level: 1, name: "Recientes" })).toBeVisible();
      await expect(page.locator("[data-recent-local]")).toContainText("Solo en este navegador");
      // Biblioteca: ningún documento aparece como reciente por existir.
      await expect(page.getByText("Remediación de moho")).toHaveCount(0);
      const rows = page.locator("[data-recent-history] li");
      await expect(rows).toHaveCount(3);
      await expect(rows.filter({ hasText: "Terminado" })).toHaveCount(3);
      await expect(page.getByRole("link", { name: "Continuar", exact: true })).toHaveCount(0);

      // «Abrir de nuevo»: la huella coincide con "Remediación de moho".
      const reopen = rows.filter({ hasText: "Firmado.pdf" }).getByRole("button", { name: "Abrir de nuevo" });
      await expect(reopen).toBeVisible();
      await expect(rows.filter({ hasText: "unido.pdf" }).getByRole("button", { name: "Abrir de nuevo" })).toHaveCount(0);
      await expect(rows.filter({ hasText: "unido.pdf" }).getByRole("link", { name: "Abrir herramienta" })).toBeVisible();
      await reopen.click();
      await expect(page).toHaveURL(/\/sign-pdf$/);
      expect(await handoffs(page)).toMatchObject([{ documentIds: [ids[0]], mode: "sign" }]);

      // «Borrar» por fila.
      await page.goto("/recent");
      await page.getByRole("button", { name: "Borrar unido.pdf" }).click();
      await expect(page.locator("[data-recent-history] li")).toHaveCount(2);
      await expect(page.getByText("unido.pdf")).toHaveCount(0);
      await expect(page.getByRole("status")).toHaveText("Entrada borrada.");
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

      // «Borrar todo»: cancelar no borra; confirmar sí, y Mis documentos queda intacto.
      await page.getByRole("button", { name: "Borrar todo" }).click();
      const dialog = page.getByRole("dialog", { name: "¿Borrar todo Recientes?" });
      await dialog.getByRole("button", { name: "Cancelar" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator("[data-recent-history] li")).toHaveCount(2);
      await page.getByRole("button", { name: "Borrar todo" }).click();
      await page.getByRole("dialog", { name: "¿Borrar todo Recientes?" }).getByRole("button", { name: "Borrar todo" }).click();
      await expect(page.getByText("Aún no has procesado nada en este navegador.")).toBeVisible();
      await expect(page.getByRole("status")).toHaveText("Recientes borrado.");
      await openDocuments(page);
      await expect(page.locator("[data-document-id]")).toHaveCount(3);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Accesibilidad (axe) y desbordes
 * ------------------------------------------------------------------ */

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = [
  "color-contrast", "aria-valid-attr-value", "aria-valid-attr", "aria-allowed-attr", "aria-required-attr", "aria-required-children",
  "aria-required-parent", "aria-roles", "aria-hidden-focus", "label", "button-name", "link-name", "image-alt", "nested-interactive",
  "duplicate-id-aria", "tabindex", "list", "listitem", "heading-order", "scrollable-region-focusable", "target-size", "region",
] as const;

type Violation = { id: string; help: string; nodes: string[] };
async function runAxe(page: Page): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
    // `region` se evalua sobre la pagina entera; el resto sobre <main> (como a11y-sweep).
    const result = await axe.run(document.querySelector("main") ?? document, { runOnly: { type: "rule", values: rules.filter((rule) => rule !== "region") } });
    return result.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`) }));
  }, [...AXE_RULES]);
}
const describeViolations = (violations: Violation[]) => violations.map((v) => `${v.id} (${v.help}):\n   ${v.nodes.join("\n   ")}`).join("\n");

async function switchLanguage(page: Page, to: Language): Promise<void> {
  const button = page.locator("button[aria-pressed]:visible").filter({ hasText: new RegExp(`^${to.toUpperCase()}$`) }).first();
  await button.click();
  await expect(page.locator("html")).toHaveAttribute("lang", to);
}

async function axeScreen(page: Page, label: string): Promise<void> {
  const run = async (language: Language, width: number) => {
    await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
    await page.waitForTimeout(700);
    const violations = await runAxe(page);
    expect(violations, `${label} · ${language} · ${width}px\n${describeViolations(violations)}`).toEqual([]);
  };
  for (const width of [1280, 375]) await run("es", width);
  await switchLanguage(page, "en");
  for (const width of [375, 1280]) await run("en", width);
  await switchLanguage(page, "es");
  await page.setViewportSize({ width: 1280, height: 900 });
}

for (const theme of ["light", "dark"] as const) {
  test(`axe: Mis documentos, Inicio y Recientes · ${theme} · ES/EN · 1280/375`, async ({ browser }) => {
    const context = await newContext(browser, theme);
    const page = await context.newPage();
    try {
      await openDocuments(page);
      await axeScreen(page, `/documents vacío · ${theme}`);
      await page.goto("/");
      await expect(page.locator("[data-home-documents-empty]")).toBeVisible();
      await axeScreen(page, `Inicio vacío · ${theme}`);

      const ids = await seedThree(page);
      await makeReady(page, ids[0]);
      await makeSingle(page, ids[1]);
      await expect(stateOf(page, CONTRACTS[0].name)).toHaveAttribute("data-template-state", "ready");
      for (const contract of CONTRACTS) await expect(card(page, contract.name).locator("img[data-doc-thumb]")).toBeVisible({ timeout: 30_000 });
      await card(page, CONTRACTS[0].name).getByRole("checkbox").check();
      await axeScreen(page, `/documents con documentos y selección · ${theme}`);

      await page.goto("/");
      await expect(page.locator("[data-home-documents] [data-document-id]")).toHaveCount(3);
      await axeScreen(page, `Inicio con documentos · ${theme}`);

      const exact = await withLib<string>(page, `return (await lib.getDocument(arg)).fingerprint.exact;`, ids[0]);
      await page.evaluate(
        ([hash]) =>
          localStorage.setItem(
            "optimuspdf.recent",
            JSON.stringify([
              { id: "r1", slug: "sign-pdf", fileName: "Firmado.pdf", date: new Date().toISOString(), resume: { kind: "sign", id: hash } },
              { id: "r2", slug: "merge-pdf", fileName: "unido.pdf", date: new Date(Date.now() - 1000).toISOString() },
            ]),
          ),
        [exact],
      );
      await page.goto("/recent");
      await expect(page.locator("[data-recent-history] li")).toHaveCount(2);
      await axeScreen(page, `Recientes unificado · ${theme}`);
    } finally {
      await context.close();
    }
  });
}

test.describe("sin desbordes con tipografía ancha (375 y 320 px)", () => {
  const WIDE_CSS = `html *, html *::before, html *::after { font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important; letter-spacing: 0.06em !important; }`;

  async function overflow(page: Page) {
    return page.evaluate(() => {
      const root = document.documentElement;
      const width = root.clientWidth;
      const offenders: string[] = [];
      for (const element of document.querySelectorAll("body *")) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 1.5 || rect.height <= 1.5) continue;
        if (rect.right <= width + 1 && rect.left >= -1) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none" || style.display === "contents") continue;
        let clipped = false;
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          const ox = getComputedStyle(parent).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") clipped = true;
        }
        if (!clipped) offenders.push(`${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(rect.left)}..${Math.round(rect.right)}`);
      }
      return { overflow: root.scrollWidth - width, offenders: offenders.slice(0, 6) };
    });
  }

  test("/documents, Inicio y Recientes caben a 375 y 320 px (ES y EN) y los controles de toque miden 44 px", async ({ browser }) => {
    const context = await newContext(browser, "dark");
    await context.addInitScript((css) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }, WIDE_CSS);
    const page = await context.newPage();
    try {
      const ids = await seedThree(page);
      await makeReady(page, ids[0]);
      await makeSingle(page, ids[1]);
      await page.evaluate(
        () =>
          localStorage.setItem(
            "optimuspdf.recent",
            JSON.stringify([{ id: "r1", slug: "merge-pdf", fileName: "un-nombre-de-archivo-bastante-largo-para-probar-el-corte-de-lineas.pdf", date: new Date().toISOString() }]),
          ),
      );
      const screens: Array<[string, string, string]> = [
        ["/documents", "[data-document-id]", "Mis documentos"],
        ["/", "[data-home-documents] [data-document-id]", "Inicio"],
        ["/recent", "[data-recent-history] li", "Recientes"],
      ];
      for (const language of ["es", "en"] as const) {
        for (const [url, probe, label] of screens) {
          await page.goto(url);
          if (language === "en") await switchLanguage(page, "en");
          await expect(page.locator(probe).first()).toBeVisible();
          for (const width of [375, 320]) {
            await page.setViewportSize({ width, height: 812 });
            await page.waitForTimeout(500);
            const measured = await overflow(page);
            expect(measured.overflow, `${label} · ${language} · ${width}px: scroll horizontal`).toBeLessThanOrEqual(1);
            expect(measured.offenders, `${label} · ${language} · ${width}px: elementos fuera`).toEqual([]);
          }
          await page.setViewportSize({ width: 1280, height: 900 });
          if (language === "en") await switchLanguage(page, "es");
        }
      }
      // Objetivos de toque >= 44 px en las tarjetas de /documents a 375 px.
      await page.goto("/documents");
      await page.setViewportSize({ width: 375, height: 812 });
      await expect(page.locator("[data-document-id]").first()).toBeVisible();
      const small = await page.evaluate(() => {
        const bad: string[] = [];
        for (const element of document.querySelectorAll<HTMLElement>("[data-document-id] button, [data-document-id] label, [data-documents-storage] button, [data-documents-list] ~ * button")) {
          const box = element.getBoundingClientRect();
          if (box.width < 1 || box.height < 1) continue;
          if (box.height < 43.5) bad.push(`${element.tagName} ${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)} ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
        return bad;
      });
      expect(small, "objetivos de toque menores de 44 px").toEqual([]);
    } finally {
      await context.close();
    }
  });
});
