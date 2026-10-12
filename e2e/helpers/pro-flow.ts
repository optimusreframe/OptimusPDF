/**
 * Piezas comunes de los E2E de PDF Pro (Wave 7 · U8): abrir un PDF por arrastre, abrir menus y pestañas en
 * escritorio y en movil, y comprobaciones transversales (desborde, foco, peticiones con contenido).
 * SIEMPRE headless (valor por defecto de Playwright).
 */
import type { Locator, Page, Request } from "@playwright/test";
import { expect } from "./tool-flow";
import { makePdf } from "./test-files";
import { es } from "../../src/lib/locales/es";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";

export const S = PRO_STRINGS.es;

/** Suelta un PDF en la zona de carga del estado vacio (o la de «Abrir otro»). */
export async function dropPdf(page: Page, bytes: Buffer, name: string): Promise<void> {
  const zone: Locator = page.locator("div.surface-card", { has: page.getByRole("button", { name: es.tool.dropButton }) });
  const transfer = await page.evaluateHandle(
    ({ base64, fileName }) => {
      const data = new DataTransfer();
      const binary = atob(base64);
      const array = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      data.items.add(new File([array], fileName, { type: "application/pdf" }));
      return data;
    },
    { base64: bytes.toString("base64"), fileName: name },
  );
  await zone.dispatchEvent("dragenter", { dataTransfer: transfer });
  await zone.dispatchEvent("dragover", { dataTransfer: transfer });
  await zone.dispatchEvent("drop", { dataTransfer: transfer });
}

/** Abre `/pdf-pro` y un PDF generado (o el que se pase). */
export async function openProPdf(
  page: Page,
  options: { name?: string; pages?: number; label?: string; bytes?: Buffer } = {},
): Promise<Buffer> {
  const name = options.name ?? "informe.pdf";
  const bytes = options.bytes ?? (await makePdf({ pages: options.pages ?? 3, label: options.label ?? "PRO" }));
  await page.goto("/pdf-pro");
  await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name.replace(/[.()]/g, "\\$&")) })).toBeVisible();
  return bytes;
}

export const isMobile = (page: Page): boolean => (page.viewportSize()?.width ?? 1280) < 768;

/** Abre el menu «Guardar y exportar» (escritorio) o «Más acciones» (movil, donde viven sus opciones). */
export async function openSaveMenu(page: Page): Promise<Locator> {
  const trigger = page.getByRole("button", { name: isMobile(page) ? S.shell.more : S.save.menuLabel });
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Va a una pestaña de la suite (en movil, por la barra inferior). */
export async function goToTab(page: Page, tab: "home" | "pages" | "edit" | "annotate" | "sign" | "protect" | "convert"): Promise<void> {
  if (isMobile(page)) {
    await page.locator(`[data-dock="${tab}"]`).click();
  } else {
    await page.locator(`[role="tab"][data-tab="${tab}"]`).click();
  }
}

export async function noHorizontalOverflow(page: Page): Promise<void> {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scrollWidth, "sin desborde horizontal").toBeLessThanOrEqual(clientWidth);
}

/**
 * Registra las peticiones que SALEN con contenido (cuerpo POST/PUT o un blob/data en la URL): PDF Pro nunca sube
 * nada. Devuelve la lista (vacia si todo fue local). Las peticiones de la propia pagina (GET de recursos) no cuentan.
 */
export function watchUploads(page: Page): { requests: string[] } {
  const requests: string[] = [];
  page.on("request", (request: Request) => {
    const method = request.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const body = request.postData();
    // Las peticiones de Next (prefetch RSC) no llevan cuerpo de usuario; solo se vigilan las que lo llevan.
    if (body && body.length > 0) requests.push(`${method} ${request.url()} (${body.length} bytes)`);
  });
  return { requests };
}

/** Elemento con el foco (descripcion corta) o `<body>`. */
export async function focusedDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || active === document.documentElement) return "<body>";
    return `${active.tagName.toLowerCase()} ${(active.getAttribute("aria-label") ?? active.textContent ?? "").trim().slice(0, 40)}`;
  });
}

/** Cierra la hoja modal (panel de herramienta, miniaturas...) si hay una abierta; en escritorio no hace nada. */
export async function closeSheetIfOpen(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
}
