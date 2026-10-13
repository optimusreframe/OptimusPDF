import { expect, test, type Page } from "@playwright/test";
import { engineOf } from "./engine";

/**
 * Descripcion accesible de un boton tal como la calcula Chromium (arbol de accesibilidad real, por CDP), no tal como la
 * adivinan las pruebas de jsdom: `aria-describedby` apuntando a un elemento lo describe con TODO su contenido, asi que
 * referenciar un contenedor y ademas sus hijos repite el texto. Solo un navegador de verdad lo ve.
 */
export async function accessibleDescriptionOf(page: Page, buttonName: string): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Accessibility.enable");
    const { nodes } = await session.send("Accessibility.getFullAXTree");
    const node = nodes.find((candidate) => !candidate.ignored && candidate.role?.value === "button" && candidate.name?.value === buttonName);
    return String(node?.description?.value ?? "");
  } finally {
    await session.detach();
  }
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * La descripcion del boton «Descargar» lee el resumen, el titulo de los avisos y CADA aviso exactamente una vez.
 * Devuelve la descripcion (ya sin espacios sobrantes) para quien quiera mirar mas.
 */
export async function expectDescriptionWithoutRepeats(page: Page, buttonName = "Descargar"): Promise<string> {
  const notices = page.locator("[data-download-notices]");
  await expect(notices).toBeVisible();
  const summary = (await page.locator("[data-download-summary]").count()) > 0 ? squash(await page.locator("[data-download-summary]").innerText()) : null;
  const title = squash(await notices.getByRole("heading").first().innerText());
  const items = (await notices.locator("li").allInnerTexts()).map(squash);
  expect(items.length, "la pantalla trae al menos un aviso (si no, la prueba no mide nada)").toBeGreaterThan(0);
  if (engineOf(page) !== "chromium") {
    // El arbol de accesibilidad solo se puede pedir por CDP (Chromium): fuera de el solo se comprueba la parte de DOM.
    test.info().annotations.push({ type: "sin-cobertura", description: "descripcion accesible del boton (CDP): solo Chromium" });
    return "";
  }
  const description = squash(await accessibleDescriptionOf(page, buttonName));
  expect(description, "el boton tiene descripcion accesible").not.toBe("");
  const occurrences = (needle: string) => description.split(needle).length - 1;
  for (const piece of [...(summary ? [summary] : []), title, ...items]) {
    expect(occurrences(piece), `«${piece.slice(0, 60)}» sale exactamente una vez en la descripcion`).toBe(1);
  }
  // Y no hay nada mas que sus piezas: la descripcion no es mas larga que ellas juntas (con sus separadores).
  const parts = [...(summary ? [summary] : []), title, ...items];
  const total = parts.reduce((sum, part) => sum + part.length, 0) + parts.length;
  expect(description.length, "la descripcion no repite texto").toBeLessThanOrEqual(total + 8);
  return description;
}
