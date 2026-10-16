/**
 * Piezas comunes de los E2E de plantillas (Fase 2 · U2.3/U2.4): abrir el editor, colocar firmas e iniciales sobre la
 * hoja con el puntero (un toque o un arrastre real, como en un iPad), guardar, y leer lo guardado directamente de
 * IndexedDB (sin pasar por la aplicacion). Los textos son los de la interfaz en espanol.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { stillBox } from "./engine";
import { fileInput } from "./sign-flow";

export type Fraction = { x0: number; y0: number; x1: number; y1: number };

/** La hoja visible del lienzo. */
export function sheet(page: Page): Locator {
  return page.locator('img[alt]:not([alt=""])').first();
}

/** Lleva la fraccion `fy` de la hoja al centro de la ventana y devuelve la caja ya quieta. */
async function aim(page: Page, fy: number): Promise<{ x: number; y: number; width: number; height: number }> {
  const surface = sheet(page);
  await expect(surface).toBeVisible();
  let box = await stillBox(surface);
  if (!box) throw new Error("no se encontro la hoja del lienzo");
  const viewport = page.viewportSize();
  const target = box.y + box.height * fy;
  const delta = target - (viewport?.height ?? 720) / 2;
  await page.evaluate((dy) => window.scrollBy(0, dy), delta);
  box = await stillBox(surface);
  if (!box) throw new Error("la hoja se perdio al desplazar");
  return box;
}

/** Arrastra sobre la hoja entre dos puntos dados como fraccion de la pagina. */
export async function dragOnSheet(page: Page, area: Fraction): Promise<void> {
  const box = await aim(page, (area.y0 + area.y1) / 2);
  await page.mouse.move(box.x + box.width * area.x0, box.y + box.height * area.y0);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((area.x0 + area.x1) / 2), box.y + box.height * ((area.y0 + area.y1) / 2), { steps: 4 });
  await page.mouse.move(box.x + box.width * area.x1, box.y + box.height * area.y1, { steps: 4 });
  await page.mouse.up();
}

export async function pickTool(page: Page, name: "Seleccionar" | "Firma" | "Iniciales" | "Texto" | "Casilla" | "Fecha"): Promise<void> {
  await page.getByRole("toolbar").first().getByRole("button", { name, exact: true }).click();
}

/** El toque en «Configurar plantilla» de la barra de Firmar y el PDF que se elige en el selector del sistema. */
export async function chooseForEditor(page: Page, file: { name: string; buffer: Buffer }): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Configurar plantilla", exact: true }).click()]);
  await chooser.setFiles({ name: file.name, mimeType: "application/pdf", buffer: file.buffer });
}

/** Abre el editor de plantillas con un PDF elegido en el boton «Configurar plantilla» de la barra de Firmar. */
export async function openEditorWithFile(page: Page, file: { name: string; buffer: Buffer }): Promise<void> {
  await page.goto("/sign-pdf");
  await chooseForEditor(page, file);
  await expect(page.getByRole("heading", { name: "Configurar plantilla" })).toBeVisible({ timeout: 30_000 });
  await expect(sheet(page)).toBeVisible({ timeout: 30_000 });
}

/** Posiciones (fraccion de pagina) de la linea de iniciales y de las rayas de firma del contrato sintetico. */
export const LINE = { x0: 0.74, x1: 0.87, y: 0.93 };

/** Coloca la linea de iniciales de la pagina 1 con la herramienta Iniciales (queda UN hueco sobre la linea). */
export async function placeInitialsLine(page: Page): Promise<void> {
  await pickTool(page, "Iniciales");
  await dragOnSheet(page, { x0: LINE.x0, y0: LINE.y - 0.045, x1: LINE.x1, y1: LINE.y - 0.004 });
}

/** Coloca las firmas del bloque de 2 firmantes en la ultima pagina (columnas izquierda y derecha, y = 0,55). */
export async function placeSignatureBlock(page: Page, signers: 1 | 2, lastPage: number): Promise<void> {
  const next = page.getByRole("button", { name: "Página siguiente" });
  for (let index = 0; index < lastPage; index += 1) await next.click();
  await expect(page.getByText(`Página ${lastPage + 1} de`)).toBeVisible();
  await page.getByRole("radio", { name: "Asegurado", exact: true }).click();
  await pickTool(page, "Firma");
  await dragOnSheet(page, { x0: 0.1, y0: 0.5, x1: signers === 2 ? 0.42 : 0.5, y1: 0.545 });
  if (signers === 2) {
    await page.getByRole("radio", { name: "Co-asegurado", exact: true }).click();
    await pickTool(page, "Firma");
    await dragOnSheet(page, { x0: 0.55, y0: 0.5, x1: 0.88, y1: 0.545 });
  }
}

export type StoredField = { roleIndex: number; pageIndex: number; type: string; rect: { x: number; y: number; width: number; height: number } };
export type StoredTemplate = {
  id: string;
  name: string;
  version: number;
  documentId: string | null;
  roles: { key: string; label: string }[];
  variants: { "1": { fields: StoredField[]; textFields: unknown[] }; "2": { fields: StoredField[]; textFields: unknown[] } };
};

/** Las plantillas guardadas, leidas directamente de IndexedDB de la pagina. */
export async function storedTemplates(page: Page): Promise<StoredTemplate[]> {
  return page.evaluate(
    () =>
      new Promise<StoredTemplate[]>((resolve, reject) => {
        const open = indexedDB.open("optimuspdf-doc-library");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("templates")) {
            db.close();
            resolve([]);
            return;
          }
          const request = db.transaction("templates", "readonly").objectStore("templates").getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result as StoredTemplate[]);
          };
          request.onerror = () => reject(request.error);
        };
      }),
  );
}

export async function storedDocuments(page: Page): Promise<{ id: string; name: string; byteLength: number; pageCount: number; templateIds: string[] }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("optimuspdf-doc-library");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction("documents", "readonly").objectStore("documents").getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(request.error);
        };
      }),
  );
}

export { fileInput };

/* ------------------------------------------------------------------ *
 * Toques
 * ------------------------------------------------------------------ */

/**
 * Cuenta de «toques» de una persona con un iPad: cada clic en un boton o pestana y cada gesto de arrastre sobre la hoja
 * es UN toque. Escribir un nombre o dibujar el trazo de una firma no se cuentan (como en la medida de la Fase 1).
 */
export class Taps {
  count = 0;
  readonly steps: string[] = [];
  constructor(private readonly page: Page) {}
  reset(): void {
    this.count = 0;
    this.steps.length = 0;
  }
  private note(label: string): void {
    this.count += 1;
    this.steps.push(label);
  }
  async click(target: Locator, label: string): Promise<void> {
    this.note(label);
    await target.click();
  }
  async drag(area: Fraction, label: string): Promise<void> {
    this.note(label);
    await dragOnSheet(this.page, area);
  }
}
