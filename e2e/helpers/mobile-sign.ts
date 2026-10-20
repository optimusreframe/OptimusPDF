/**
 * Piezas comunes de los E2E «Firmar PDF en movil e iPad» (auditoria `docs/AUDITORIA-MOVIL-IPAD.md`, hallazgos de Firmar):
 * perfiles de dispositivo, un contrato SINTETICO de una pagina larga (pdf-lib), el recorrido hasta cada pantalla y las
 * medidas de pantalla (capas fijas, paleta, zona visible, separacion entre botones, tamano de letra de los campos).
 * SIEMPRE headless; los PDF son sinteticos (nunca los del usuario).
 *
 * Los perfiles NO llevan `defaultBrowserType` (Playwright lo prohibe dentro de un `describe`): el mismo spec corre en
 * Chromium y en el WebKit del proyecto `webkit-ipad`. En Chromium se emula iOS (`isMobile`, tactil, agente de usuario);
 * en WebKit el motor ya es el de Safari.
 */
import { devices, expect, type Locator, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";

type DeviceDescriptor = (typeof devices)[string];
const withoutBrowserType = ({ defaultBrowserType: _ignored, ...rest }: DeviceDescriptor) => {
  void _ignored;
  return rest;
};

const IPHONE = withoutBrowserType(devices["iPhone 15 Pro"]);
const IPAD = withoutBrowserType(devices["iPad Pro 11"]);

export type MobileProfile = {
  key: "se375" | "iph393" | "mini744" | "ipadP" | "ipadL";
  label: string;
  /** Telefono (< 768 px de ancho): barra «Opciones/Procesar» fija y tab bar global. */
  phone: boolean;
  /** Tablet con el layout «de escritorio» de antes (768-1279 px): panel «Opciones» a la derecha. */
  desktopLike: boolean;
  use: Record<string, unknown>;
};

export const SE_375: MobileProfile = {
  key: "se375",
  label: "iPhone SE 375x667",
  phone: true,
  desktopLike: false,
  use: { ...IPHONE, viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 },
};
export const IPHONE_393: MobileProfile = {
  key: "iph393",
  label: "iPhone 15 Pro 393x852",
  phone: true,
  desktopLike: false,
  use: { ...IPHONE },
};
export const IPAD_MINI_744: MobileProfile = {
  key: "mini744",
  label: "iPad mini 744x1133",
  phone: true,
  desktopLike: false,
  use: { ...IPAD, viewport: { width: 744, height: 1133 } },
};
export const IPAD_PORTRAIT: MobileProfile = {
  key: "ipadP",
  label: "iPad Pro 834x1194",
  phone: false,
  desktopLike: true,
  use: { ...IPAD },
};
export const IPAD_LANDSCAPE: MobileProfile = {
  key: "ipadL",
  label: "iPad Pro horizontal 1194x834",
  phone: false,
  desktopLike: true,
  use: { ...IPAD, viewport: { width: 1194, height: 834 } },
};

export const ALL_PROFILES: readonly MobileProfile[] = [SE_375, IPHONE_393, IPAD_MINI_744, IPAD_PORTRAIT, IPAD_LANDSCAPE];
export const PHONE_PROFILES: readonly MobileProfile[] = [SE_375, IPHONE_393, IPAD_MINI_744];

export const PRIVACY_KEY = "optimuspdf.sign-pdf.privacyNoticeSeen";

/** Un contrato de 2 paginas A4 con texto de sobra (la hoja es larga, como la de un siniestro). */
export async function makeContract(label = "Contrato", pages = 2): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= pages; index += 1) {
    const sheet = doc.addPage([595, 842]);
    sheet.drawText(`${label} - pagina ${index} de ${pages}`, { x: 50, y: 790, size: 16, font });
    for (let line = 1; line <= 30; line += 1) {
      sheet.drawText(`Linea ${line}: siniestro 2024-001 cobertura, peritaje y presupuesto de reparacion del vehiculo.`, {
        x: 50,
        y: 760 - line * 18,
        size: 9,
        font,
      });
    }
    sheet.drawText("Firma del asegurado:", { x: 50, y: 120, size: 10, font });
  }
  return Buffer.from(await doc.save());
}

export function pdfFile(buffer: Buffer, name = "contrato.pdf") {
  return { name, mimeType: "application/pdf", buffer } as const;
}

/** Abre `/sign-pdf` con el aviso de privacidad ya visto (salvo `privacySeen: false`) y sube el PDF. */
export async function openSign(
  page: Page,
  files: ReadonlyArray<{ name: string; mimeType: string; buffer: Buffer }>,
  options: { privacySeen?: boolean; language?: "es" | "en"; theme?: "light" | "dark" } = {},
): Promise<void> {
  const { privacySeen = true, language = "es", theme = "light" } = options;
  await page.addInitScript(
    ([seen, lang, mode]) => {
      try {
        if (seen) window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
        window.localStorage.setItem("optimuspdf.language", String(lang));
        window.localStorage.setItem("optimuspdf.theme", String(mode));
      } catch {
        /* sin almacenamiento */
      }
    },
    [privacySeen, language, theme],
  );
  await page.goto("/sign-pdf");
  await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles([...files]);
  if (files.length > 1) {
    await expect(page.getByRole("button", { name: `1. ${files[0].name}` })).toBeVisible({ timeout: 30_000 });
  }
}

/** Espera a que la hoja del lienzo tenga imagen y no se mueva. */
export async function waitSheetReady(page: Page): Promise<Locator> {
  const host = page.locator('[data-canvas="host"]').first();
  await expect(host).toBeVisible({ timeout: 30_000 });
  await expect(host.locator("img").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
  return host;
}

/** «Varios firmantes» con dos nombres, un documento. */
export async function multiWithTwoSigners(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Varios firmantes" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByRole("button", { name: "Añadir firmante" }).click();
  await page.getByLabel("Nombre del firmante 1").fill("Ana");
  await page.getByLabel("Nombre del firmante 2").fill("Luis");
}

/** Alto de la barra de pestanas global + barra «Opciones/Procesar» que el movil deja fijas abajo. */
export type Geometry = { vw: number; vh: number; scrollY: number; scrollHeight: number; safeBottom: number };

export async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => ({
    vw: window.innerWidth,
    vh: window.innerHeight,
    scrollY: Math.round(window.scrollY),
    scrollHeight: document.documentElement.scrollHeight,
    safeBottom: 0,
  }));
}

export type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };

export async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  });
}

/**
 * `true` si el punto central (y los cuatro puntos al 25 % / 75 %) del elemento cae sobre el propio
 * elemento o algo suyo: nada fijo lo tapa. Lo que queda fuera de la ventana cuenta como tapado.
 */
export async function isHittable(locator: Locator): Promise<{ ok: boolean; reason: string }> {
  return locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (r.width === 0 || r.height === 0) return { ok: false, reason: "sin caja" };
    if (r.top < 0 || r.bottom > vh || r.left < 0 || r.right > vw) {
      return { ok: false, reason: `fuera de la ventana (top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)}, vh ${vh})` };
    }
    // Centro y los cuatro puntos al 25 % / 75 % de cada lado (las esquinas redondeadas no cuentan como «tapado»).
    const points: Array<[number, number]> = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + r.width * 0.25, r.top + r.height * 0.25],
      [r.left + r.width * 0.75, r.top + r.height * 0.25],
      [r.left + r.width * 0.25, r.top + r.height * 0.75],
      [r.left + r.width * 0.75, r.top + r.height * 0.75],
    ];
    for (const [x, y] of points) {
      const top = document.elementFromPoint(x, y);
      if (!top || !(element.contains(top) || top.contains(element))) {
        const name = top ? `${top.tagName.toLowerCase()}${top.className && typeof top.className === "string" ? "." + top.className.split(" ").slice(0, 3).join(".") : ""}` : "nada";
        return { ok: false, reason: `tapado por ${name} en (${Math.round(x)}, ${Math.round(y)})` };
      }
    }
    return { ok: true, reason: "" };
  });
}

export type FixedLayer = { label: string; top: number; bottom: number; width: number; painted: boolean };

/**
 * Las superficies PINTADAS (fondo, material, sombra) de al menos el 60 % del ancho que una capa `fixed`/`sticky` mantiene
 * pegadas abajo AHORA (la capa puede ser un contenedor transparente: cuenta lo que pinta dentro). Los botones sueltos no
 * llegan al 60 % del ancho y no cuentan.
 */
export async function bottomLayers(page: Page): Promise<FixedLayer[]> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const out: Array<{ label: string; top: number; bottom: number; width: number; painted: boolean }> = [];
    /** La capa fija/pegajosa (el propio elemento o un ancestro) que lo mantiene en la ventana ahora mismo, o `null`. */
    const layerOf = (element: HTMLElement): HTMLElement | null => {
      for (let node: HTMLElement | null = element; node && node !== document.body; node = node.parentElement) {
        const cs = getComputedStyle(node);
        if (cs.position === "fixed") return node;
        if (cs.position === "sticky") {
          const bottom = parseFloat(cs.bottom);
          const r = node.getBoundingClientRect();
          // Un sticky que aun no esta pegado (o pegado arriba) no tapa lo de abajo.
          if (!Number.isNaN(bottom) && Math.abs(vh - r.bottom - bottom) <= 2) return node;
        }
      }
      return null;
    };
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      const cs = getComputedStyle(element);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const r = element.getBoundingClientRect();
      if (r.width < vw * 0.6 || r.height < 8) continue;
      if (r.bottom < vh * 0.5 || r.top < vh * 0.5 || r.top > vh) continue;
      if (!layerOf(element)) continue;
      const bg = cs.backgroundColor;
      const alpha = bg.startsWith("rgba") ? Number(bg.split(",")[3]?.replace(")", "")) : bg === "transparent" ? 0 : 1;
      const painted = alpha > 0.05 || (cs.backdropFilter && cs.backdropFilter !== "none") || (cs.boxShadow && cs.boxShadow !== "none");
      if (!painted) continue;
      const label = (element.getAttribute("aria-label") || element.getAttribute("data-chrome") || element.className?.toString().slice(0, 40) || element.tagName).toString();
      out.push({ label, top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), painted: true });
    }
    return out;
  });
}

/** Alto (px) que las capas pintadas pegadas abajo tapan en conjunto (la union de sus franjas). */
export function coveredHeight(layers: readonly FixedLayer[], vh: number): number {
  const painted = layers.filter((layer) => layer.painted).sort((a, b) => a.top - b.top);
  let covered = 0;
  let edge = vh;
  for (const layer of painted.reverse()) {
    const top = Math.max(0, layer.top);
    const bottom = Math.min(edge, layer.bottom);
    if (bottom > top) covered += bottom - top;
    edge = Math.min(edge, top);
  }
  return covered;
}

/** Pares de botones visibles, contiguos y mas juntos de 8 px (ignora los de una misma barra segmentada y los anidados). */
export async function tightButtonPairs(page: Page, scope = "main"): Promise<string[]> {
  return page.evaluate((scopeSelector) => {
    const root = document.querySelector(scopeSelector) ?? document.body;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visible = (element: Element) => {
      const cs = getComputedStyle(element);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      const r = element.getBoundingClientRect();
      return r.width >= 24 && r.height >= 24 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const buttons = [...root.querySelectorAll<HTMLElement>('button, [role="button"], a[href], [role="radio"], [role="tab"], select, input:not([type=hidden]):not([type=file])')].filter(
      (element) => visible(element) && !element.closest('[role="radiogroup"], [role="tablist"], [data-segmented]'),
    );
    const inLayer = (element: HTMLElement) => {
      for (let node: HTMLElement | null = element; node && node !== document.body; node = node.parentElement) {
        const position = getComputedStyle(node).position;
        if (position === "fixed" || position === "sticky") return true;
      }
      return false;
    };
    const name = (element: HTMLElement) =>
      (element.getAttribute("aria-label") || element.textContent || element.getAttribute("name") || element.tagName).trim().replace(/\s+/g, " ").slice(0, 32);
    const bad: string[] = [];
    for (let i = 0; i < buttons.length; i += 1) {
      for (let j = i + 1; j < buttons.length; j += 1) {
        const a = buttons[i];
        const b = buttons[j];
        if (a.contains(b) || b.contains(a)) continue;
        // Una capa fija/pegajosa (barra de zoom, barra «Opciones/Procesar», «Continuar») pasa por encima del contenido al
        // desplazarse: un boton suyo junto a uno del contenido no es una pareja de botones contiguos.
        if (inLayer(a) !== inLayer(b)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const hGap = Math.max(rb.left - ra.right, ra.left - rb.right);
        const vGap = Math.max(rb.top - ra.bottom, ra.top - rb.bottom);
        const overlapV = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        const overlapH = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const sideBySide = hGap > -1 && hGap < 8 && overlapV > 8;
        const stacked = vGap > -1 && vGap < 8 && overlapH > 8;
        if (sideBySide || stacked) bad.push(`${name(a)} | ${name(b)} (h ${Math.round(hGap)}, v ${Math.round(vGap)})`);
      }
    }
    return bad;
  }, scope);
}

/** Tamano de letra calculado de cada campo de texto visible (px). */
export async function inputFontSizes(page: Page, scope = "body"): Promise<Array<{ label: string; px: number }>> {
  return page.evaluate((scopeSelector) => {
    const root = document.querySelector(scopeSelector) ?? document.body;
    const out: Array<{ label: string; px: number }> = [];
    for (const element of root.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea, select')) {
      const cs = getComputedStyle(element);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = element.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const label = element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("name") || element.id || element.tagName;
      out.push({ label: label.slice(0, 40), px: parseFloat(cs.fontSize) });
    }
    return out;
  }, scope);
}

/** Abre la paleta del lienzo en movil si esta plegada (en tablet y escritorio siempre esta abierta). */
export async function openPalette(page: Page): Promise<Locator> {
  const toolbar = page.getByRole("toolbar", { name: "Herramientas del documento" });
  if (!(await toolbar.isVisible())) {
    await page.getByRole("button", { name: /Herramientas del documento/ }).click();
  }
  await expect(toolbar).toBeVisible();
  return toolbar;
}

/**
 * Un punto de la hoja donde arrastrar para colocar un hueco: la fraccion `fraction` del alto de la hoja, pero siempre por
 * debajo de la barra de zoom pegajosa (a 320 px mide dos filas) y por encima de las barras de abajo.
 */
export async function safeSheetY(page: Page, sheetTop: number, sheetHeight: number, fraction: number): Promise<number> {
  const bar = await page.evaluate(() => document.querySelector("[data-canvas-sticky]")?.getBoundingClientRect().bottom ?? 0);
  const vh = page.viewportSize()?.height ?? 700;
  return Math.max(bar + 24, Math.min(sheetTop + sheetHeight * fraction, vh * 0.55));
}

/**
 * En un telefono la paleta del lienzo llega PLEGADA en un boton con la herramienta activa (SC-02, auditoria movil/iPad):
 * si esta plegada, la abre; en tablet y escritorio no hace nada. Para las pruebas que pulsan una herramienta en un movil.
 */
export async function unfoldPalette(page: Page): Promise<void> {
  const fab = page.locator("[data-palette-fab]");
  if (await fab.isVisible().catch(() => false)) await fab.click();
}
