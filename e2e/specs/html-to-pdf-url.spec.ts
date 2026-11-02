import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { downloadFile } from "../helpers/downloads";
import { analyzePdf, hasInk } from "../helpers/html-pdf-lab";
import { articlePage } from "../helpers/html-pdf-pages";

/**
 * «HTML a PDF» · modo «Dirección web». NUNCA hay peticiones a Internet: `POST /api/html-snapshot` se INTERCEPTA con
 * `page.route` y devuelve una pagina sintetica (la ruta real no puede llegar a localhost por diseño, y de todos modos aqui no
 * se prueba la red sino la interfaz). La ruta REAL se prueba aparte, solo con direcciones que rechaza antes de conectar.
 * Cubre: flujo completo hasta la descarga de un PDF Carta, aviso de transparencia visible ANTES de consultar, validacion en
 * vivo, errores por tipo, cancelar, el modo «Archivo HTML» de siempre, axe, 375/320 px con tipografia ancha, claro/oscuro y ES/EN.
 * Headless siempre.
 */

test.setTimeout(120_000);
// Sin esto una espera que no se cumple (un texto que no sale) dura hasta agotar el plazo de la prueba.
test.use({ actionTimeout: 10_000, locale: "es-ES" });
test.beforeEach(async ({ page }) => {
  // Las pruebas de este archivo estan escritas en espanol; las de ingles y las matrices fijan su propio idioma.
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("optimuspdf.language")) window.localStorage.setItem("optimuspdf.language", "es");
  });
});

const NOTICE_ES = "Para leer esta dirección, nuestro servidor la consulta y te devuelve la página; no se guarda nada. El PDF se crea en tu dispositivo.";
const NOTICE_EN = "To read this address, our server looks it up and sends the page back to you; nothing is stored. The PDF is created on your device.";

const SNAPSHOT = {
  html: articlePage({ sections: 4 }),
  finalUrl: "https://ejemplo.com/articulo",
  title: "Un artículo largo de prueba",
  notes: [
    { code: "scripts-ignored", count: 2 },
    { code: "fonts-omitted", count: 1 },
  ],
};

type Responder = (route: Route, call: number) => Promise<void> | void;

/** Intercepta la ruta del servidor. Devuelve las peticiones recibidas (su cuerpo JSON). */
async function mockSnapshot(page: Page, responder: Responder): Promise<Array<{ url?: string }>> {
  const calls: Array<{ url?: string }> = [];
  await page.route("**/api/html-snapshot", async (route) => {
    calls.push(JSON.parse(route.request().postData() ?? "{}"));
    await responder(route, calls.length);
  });
  return calls;
}

const ok: Responder = (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SNAPSHOT) });
const fail =
  (status: number, error: string): Responder =>
  (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error }) });

/** Peticiones a algo que no sea la propia app: la prueba no debe hacer ninguna. */
function trackExternal(page: Page): string[] {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return;
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") external.push(request.url());
  });
  return external;
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function openUrlMode(page: Page) {
  await page.goto("/html-to-pdf");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

const addressField = (page: Page) => page.getByLabel("Dirección de la página");

test.describe("flujo completo", () => {
  test("escribir la direccion, consultar, ver el resumen y descargar un PDF Carta bien repartido", async ({ page }) => {
    const external = trackExternal(page);
    const pageErrors = trackPageErrors(page);
    const calls = await mockSnapshot(page, ok);
    await openUrlMode(page);

    // Modos accesibles: «Dirección web» seleccionado por defecto; la zona de carga de archivos no se pinta.
    const tablist = page.getByRole("tablist", { name: "Origen de la página" });
    await expect(tablist.getByRole("tab", { name: "Dirección web" })).toHaveAttribute("aria-selected", "true");
    await expect(tablist.getByRole("tab", { name: "Archivo HTML" })).toHaveAttribute("aria-selected", "false");
    await expect(page.locator('input[type="file"]')).toHaveCount(0);

    // El aviso de transparencia se ve ANTES de consultar.
    await expect(page.getByText(NOTICE_ES)).toBeVisible();
    expect(calls).toHaveLength(0);

    // Validacion en vivo.
    await expect(page.getByText("Escribe o pega la dirección.")).toBeVisible();
    await addressField(page).fill("ejemplo.com/articulo");
    await expect(page.getByText("La dirección tiene buena forma.")).toBeVisible();

    await page.getByRole("button", { name: "Consultar" }).click();

    // Resumen de lo leido y su lista de archivos; la ruta recibio la direccion normalizada y nada mas.
    await expect(page.getByRole("heading", { name: "Página leída" })).toBeVisible();
    expect(calls).toEqual([{ url: "https://ejemplo.com/articulo" }]);
    await expect(page.getByText("https://ejemplo.com/articulo", { exact: true })).toBeVisible();
    await expect(page.getByText("Un artículo largo de prueba", { exact: true })).toBeVisible();
    await expect(page.getByText("La página trae JavaScript. No se ejecuta", { exact: false })).toBeVisible();
    await expect(page.getByText("ejemplo.com-articulo.html")).toBeVisible();

    // Carta es el tamaño por defecto.
    await expect(page.getByRole("tab", { name: "Carta" })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("button", { name: "Procesar", exact: true }).click();
    const { bytes, filename } = await downloadFile(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    expect(filename).toMatch(/^ejemplo\.com-articulo.*\.pdf$/);

    const pages = await analyzePdf(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const sheet of pages) {
      expect(sheet.widthPt).toBeCloseTo(612, 1);
      expect(sheet.heightPt).toBeCloseTo(792, 1);
      expect(hasInk(sheet.image!)).toBe(true);
    }
    expect(external, "ninguna peticion fuera de la propia app").toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("Enter en el campo consulta igual que el boton, y al quitar la pagina se vuelve al campo con el foco", async ({ page }) => {
    const calls = await mockSnapshot(page, ok);
    await openUrlMode(page);
    await addressField(page).fill("https://ejemplo.com/articulo");
    await addressField(page).press("Enter");
    await expect(page.getByRole("heading", { name: "Página leída" })).toBeVisible();
    expect(calls).toHaveLength(1);

    await page.getByRole("button", { name: /Quitar/ }).first().click();
    await expect(addressField(page)).toBeVisible();
    await expect(addressField(page)).toBeFocused();
    await expect(addressField(page)).toHaveValue("https://ejemplo.com/articulo");
  });
});

test.describe("validacion en vivo", () => {
  test("direcciones incompletas, privadas o de otro esquema se avisan sin consultar", async ({ page }) => {
    const calls = await mockSnapshot(page, ok);
    await openUrlMode(page);
    const field = addressField(page);

    for (const [typed, message] of [
      ["javascript:alert(1)", "Todavía no es una dirección completa"],
      ["ftp://ejemplo.com/a", "Todavía no es una dirección completa"],
      ["ejemplo", "Esta dirección no se puede consultar: es privada, local o interna."],
      ["http://127.0.0.1/admin", "Esta dirección no se puede consultar: es privada, local o interna."],
      ["http://169.254.169.254/latest/meta-data/", "Esta dirección no se puede consultar: es privada, local o interna."],
      ["localhost:3000/x", "Esta dirección no se puede consultar: es privada, local o interna."],
      ["https://usuario:clave@ejemplo.com/", "Todavía no es una dirección completa"],
    ] as const) {
      await field.fill(typed);
      await expect(page.getByText(message), typed).toBeVisible();
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await page.getByRole("button", { name: "Consultar" }).click();
      await expect(field).toBeFocused();
    }
    expect(calls, "una direccion invalida no llega a la ruta").toHaveLength(0);

    await field.fill("");
    await expect(field).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Consultar" }).click();
    expect(calls).toHaveLength(0);
  });
});

test.describe("errores por tipo", () => {
  const CASES: Array<[status: number, code: string, title: string]> = [
    [400, "invalid-url", "La dirección no es válida"],
    [403, "blocked-address", "No se puede consultar esa dirección"],
    [502, "unreachable", "No se pudo leer la página"],
    [413, "too-large", "La página es demasiado grande"],
    [415, "unsupported-type", "Eso no es una página web"],
    [504, "timeout", "La consulta tardó demasiado"],
    [429, "rate-limited", "Demasiadas consultas seguidas"],
    [403, "forbidden", "Esta consulta no está permitida desde aquí"],
  ];

  test("cada codigo de la ruta se explica con su propio mensaje claro", async ({ page }) => {
    let next = CASES[0];
    await mockSnapshot(page, (route) => fail(next[0], next[1])(route, 0));
    await openUrlMode(page);
    await addressField(page).fill("https://ejemplo.com/");

    for (const entry of CASES) {
      next = entry;
      await page.getByRole("button", { name: "Consultar" }).click();
      const alert = page.locator("[data-error-banner]").filter({ hasText: entry[2] });
      await expect(alert, entry[1]).toBeVisible();
      await expect(alert).toBeFocused();
      await alert.getByRole("button", { name: "Cerrar" }).click();
      await expect(page.locator("[data-error-banner]")).toHaveCount(0);
      await expect(addressField(page)).toBeFocused();
    }
    await expect(addressField(page)).toHaveValue("https://ejemplo.com/");
  });

  test("sin conexion con el servidor: mensaje propio y Reintentar funciona", async ({ page }) => {
    await mockSnapshot(page, (route, call) => (call === 1 ? route.abort("failed") : ok(route, call)));
    await openUrlMode(page);
    await addressField(page).fill("https://ejemplo.com/articulo");
    await page.getByRole("button", { name: "Consultar" }).click();
    const alert = page.locator("[data-error-banner]").filter({ hasText: "Sin conexión con el servidor" });
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "Reintentar" }).click();
    await expect(page.getByRole("heading", { name: "Página leída" })).toBeVisible();
  });

  test("una respuesta que no es lo esperado no revienta la pagina", async ({ page }) => {
    await mockSnapshot(page, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ html: 5 }) }));
    const pageErrors = trackPageErrors(page);
    await openUrlMode(page);
    await addressField(page).fill("https://ejemplo.com/articulo");
    await page.getByRole("button", { name: "Consultar" }).click();
    await expect(page.locator("[data-error-banner]").filter({ hasText: "Respuesta inesperada" })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("'No se pudo leer' ofrece Reintentar y la salida «Archivo HTML», que cambia de modo", async ({ page }) => {
    await mockSnapshot(page, fail(502, "unreachable"));
    await openUrlMode(page);
    await addressField(page).fill("https://ejemplo.com/");
    await page.getByRole("button", { name: "Consultar" }).click();
    const alert = page.locator("[data-error-banner]").filter({ hasText: "No se pudo leer la página" });
    await expect(alert.getByRole("button", { name: "Reintentar" })).toBeVisible();
    await alert.getByRole("button", { name: "Archivo HTML" }).click();
    await expect(page.getByRole("tab", { name: "Archivo HTML" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('input[type="file"]')).toHaveCount(1);
  });
});

test.describe("cancelar", () => {
  test("cancelar corta la consulta, avisa y no carga nada aunque la respuesta llegue despues", async ({ page }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mockSnapshot(page, async (route) => {
      await gate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SNAPSHOT) }).catch(() => undefined);
    });
    await openUrlMode(page);
    await addressField(page).fill("https://ejemplo.com/articulo");
    await page.getByRole("button", { name: "Consultar" }).click();

    await expect(page.getByText("Consultando la dirección…")).toBeVisible();
    const cancel = page.getByRole("button", { name: "Cancelar consulta" });
    await expect(cancel).toBeFocused();
    await expect(addressField(page)).toHaveJSProperty("readOnly", true);
    await cancel.click();

    await expect(page.getByText("Consulta cancelada. No se guardó nada.")).toBeVisible();
    await expect(addressField(page)).toBeFocused();
    await expect(page.getByRole("button", { name: "Consultar" })).toBeVisible();

    release();
    await page.waitForTimeout(400);
    await expect(page.getByRole("heading", { name: "Página leída" })).toHaveCount(0);
    await expect(addressField(page)).toBeVisible();
  });
});

test.describe("modo «Archivo HTML» (lo de siempre)", () => {
  test("subir un .html convierte a PDF Carta sin tocar la ruta del servidor", async ({ page }) => {
    const calls = await mockSnapshot(page, ok);
    await openUrlMode(page);
    await page.getByRole("tab", { name: "Archivo HTML" }).click();
    await expect(page.getByText(NOTICE_ES)).toHaveCount(0);

    await page.locator('input[type="file"]').setInputFiles({ name: "pagina.html", mimeType: "text/html", buffer: Buffer.from(articlePage({ sections: 3 })) });
    await expect(page.getByText("pagina.html")).toBeVisible();
    // Un archivo subido NO lleva el resumen de «Página leída».
    await expect(page.getByRole("heading", { name: "Página leída" })).toHaveCount(0);
    await page.getByRole("button", { name: "Procesar", exact: true }).click();
    const { bytes } = await downloadFile(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    const pages = await analyzePdf(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages[0].widthPt).toBeCloseTo(612, 1);
    expect(pages[0].heightPt).toBeCloseTo(792, 1);
    expect(calls).toHaveLength(0);
  });
});

test.describe("la ruta REAL del servidor (sin salir a Internet)", () => {
  let counter = 0;
  const headers = () => ({ "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": `198.51.100.${(counter += 1)}` });

  test("rechaza antes de conectar: direcciones privadas, mal formadas y peticiones que no son de la propia web", async ({ request }) => {
    const blocked = await request.post("/api/html-snapshot", { headers: headers(), data: { url: "http://127.0.0.1/" } });
    expect(blocked.status()).toBe(403);
    expect(await blocked.json()).toEqual({ error: "blocked-address" });
    expect(blocked.headers()["cache-control"]).toBe("no-store");

    const metadata = await request.post("/api/html-snapshot", { headers: headers(), data: { url: "http://169.254.169.254/latest/meta-data/" } });
    expect(await metadata.json()).toEqual({ error: "blocked-address" });

    const invalid = await request.post("/api/html-snapshot", { headers: headers(), data: { url: "ftp://ejemplo.com/" } });
    expect(invalid.status()).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid-url" });

    const longUrl = await request.post("/api/html-snapshot", { headers: headers(), data: { url: `https://ejemplo.com/${"a".repeat(3000)}` } });
    expect(longUrl.status()).toBe(400);

    const notJson = await request.post("/api/html-snapshot", { headers: { ...headers(), "content-type": "text/plain" }, data: "https://ejemplo.com/" });
    expect(notJson.status()).toBe(400);

    // Sin las cabeceras de «misma web» (un cliente cualquiera): prohibido.
    const foreign = await request.post("/api/html-snapshot", { headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, data: { url: "https://ejemplo.com/" } });
    expect(foreign.status()).toBe(403);
    expect(await foreign.json()).toEqual({ error: "forbidden" });

    const get = await request.get("/api/html-snapshot");
    expect(get.status()).toBe(405);
  });
});

/* ------------------------------------------------------------------ *
 * Idioma, tema, moviles y tipografia ancha
 * ------------------------------------------------------------------ */

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = [
  "color-contrast",
  "aria-valid-attr-value",
  "aria-valid-attr",
  "aria-allowed-attr",
  "aria-allowed-role",
  "aria-required-attr",
  "aria-required-children",
  "aria-required-parent",
  "label",
  "button-name",
  "link-name",
  "target-size",
  "nested-interactive",
  "list",
  "listitem",
  "heading-order",
  "region",
] as const;

const WIDE_CSS = `html *, html *::before, html *::after {
  font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important;
  letter-spacing: 0.06em !important;
}`;

type Theme = "light" | "dark";
type Language = "es" | "en";

async function runAxe(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    type Axe = { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> };
    const axe = (window as unknown as { axe: Axe }).axe;
    const result = await axe.run(document, { runOnly: { type: "rule", values: [...rules] } });
    return result.violations
      .filter((v) => v.id !== "region") // «region» solo aplica a la pagina completa; las demas reglas son las que importan aqui
      .map((v) => `${v.id} (${v.help}): ${v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`).join(" | ")}`);
  }, AXE_RULES);
}

async function overflowOf(page: Page): Promise<{ overflow: number; offenders: string[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const offenders: string[] = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1.5 || rect.height <= 1.5) continue;
      if (rect.right <= clientWidth + 1 && rect.left >= -1) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      let clipped = false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden" || overflowX === "clip") clipped = true;
      }
      if (!clipped) offenders.push(`${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(rect.left)}..${Math.round(rect.right)}`);
    }
    return { overflow: root.scrollWidth - clientWidth, offenders: offenders.slice(0, 6) };
  });
}

async function cellContext(browser: Browser, cell: { theme: Theme; language: Language; width: number; touch: boolean }): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: cell.width, height: cell.touch ? 812 : 900 },
    deviceScaleFactor: 2,
    hasTouch: cell.touch,
    isMobile: cell.touch,
    colorScheme: cell.theme,
    locale: cell.language === "es" ? "es-ES" : "en-US",
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([theme, language, css]) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      window.localStorage.setItem("optimuspdf.theme", theme);
      window.localStorage.setItem("optimuspdf.language", language);
    },
    [cell.theme, cell.language, WIDE_CSS] as const,
  );
  return context;
}

const CELLS: Array<{ theme: Theme; language: Language; width: number; touch: boolean }> = [
  { theme: "light", language: "es", width: 375, touch: true },
  { theme: "dark", language: "en", width: 375, touch: true },
  { theme: "dark", language: "es", width: 320, touch: true },
  { theme: "light", language: "en", width: 320, touch: true },
  { theme: "light", language: "es", width: 1280, touch: false },
  { theme: "dark", language: "en", width: 1280, touch: false },
];

test.describe("claro/oscuro, ES/EN, 375 y 320 px con tipografia ancha", () => {
  for (const cell of CELLS) {
    test(`${cell.theme} · ${cell.language} · ${cell.width} px · ${cell.touch ? "tactil" : "raton"}: sin desborde, axe limpio y objetivos de 44 px`, async ({ browser }) => {
      const context = await cellContext(browser, cell);
      const page = await context.newPage();
      const external = trackExternal(page);
      await mockSnapshot(page, fail(502, "unreachable"));
      try {
        await page.goto("/html-to-pdf");
        await expect(page.locator("html")).toHaveAttribute("lang", cell.language);
        const es = cell.language === "es";
        await expect(page.getByText(es ? NOTICE_ES : NOTICE_EN)).toBeVisible();

        // Tipografia ancha realmente activa.
        const ratio = await page.evaluate(() => {
          const context2d = document.createElement("canvas").getContext("2d")!;
          const probe = "Sí, firmar otro con los mismos firmantes";
          context2d.font = "16px Arial";
          const narrow = context2d.measureText(probe).width;
          context2d.font = '16px "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif';
          return context2d.measureText(probe).width / narrow;
        });
        expect(ratio).toBeGreaterThan(1.08);

        // 1. Reposo, con una direccion larga y una invalida visible.
        const field = page.getByLabel(es ? "Dirección de la página" : "Page address");
        await field.fill("http://127.0.0.1/una-direccion-privada-muy-larga-para-comprobar-el-desborde-del-campo");
        await expect(page.getByText(es ? "Esta dirección no se puede consultar" : "This address cannot be looked up")).toBeVisible();
        expect((await overflowOf(page)).offenders, "reposo").toEqual([]);
        expect(await runAxe(page), "axe en reposo").toEqual([]);

        // 2. Error de la consulta.
        await field.fill("https://ejemplo.com/articulo");
        await page.getByRole("button", { name: es ? "Consultar" : "Look up" }).click();
        await expect(page.locator("[data-error-banner]")).toBeVisible();
        const measured = await overflowOf(page);
        expect(measured.offenders, "con el error").toEqual([]);
        expect(measured.overflow).toBeLessThanOrEqual(1);
        // El aviso entra con una animacion: se mide cuando ya se asento (a media entrada el contraste sale falso).
        await expect.poll(() => runAxe(page), { timeout: 5000, message: "axe con el error" }).toEqual([]);

        // Objetivos de 44 px con tacto: pestañas, campo, boton de consulta y cierre del aviso.
        if (cell.touch) {
          const targets: Array<[string, ReturnType<Page["locator"]>]> = [
            ["pestaña Dirección web", page.getByRole("tab", { name: es ? "Dirección web" : "Web address" })],
            ["pestaña Archivo HTML", page.getByRole("tab", { name: es ? "Archivo HTML" : "HTML file" })],
            ["campo", field],
            ["boton Consultar", page.getByRole("button", { name: es ? "Consultar" : "Look up" })],
            ["cerrar aviso", page.locator("[data-error-banner]").getByRole("button", { name: es ? "Cerrar" : "Close" })],
            ["resumen de limites", page.locator("summary")],
          ];
          for (const [name, locator] of targets) {
            const box = await locator.boundingBox();
            expect(box, `caja de ${name}`).not.toBeNull();
            expect(box!.height, `alto de ${name}`).toBeGreaterThanOrEqual(43.5);
          }
        }
        expect(external).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test("en ingles el flujo completo (aviso, resumen y descarga) esta traducido", async ({ browser }) => {
    const context = await cellContext(browser, { theme: "light", language: "en", width: 1280, touch: false });
    const page = await context.newPage();
    try {
      await mockSnapshot(page, ok);
      await page.goto("/html-to-pdf");
      await expect(page.getByRole("tablist", { name: "Page source" })).toBeVisible();
      await expect(page.getByText(NOTICE_EN)).toBeVisible();
      await page.getByLabel("Page address").fill("example.com/article");
      await page.getByRole("button", { name: "Look up" }).click();
      await expect(page.getByRole("heading", { name: "Page read" })).toBeVisible();
      await expect(page.getByText("The page contains JavaScript. It is not run", { exact: false })).toBeVisible();
      await expect.poll(() => runAxe(page), { timeout: 5000, message: "axe con la pagina leida" }).toEqual([]);
      await expect(page.getByRole("tab", { name: "Letter" })).toHaveAttribute("aria-selected", "true");
    } finally {
      await context.close();
    }
  });
});
