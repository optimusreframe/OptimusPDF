import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import type { Page } from "@playwright/test";
import { expect as baseExpect, test } from "../helpers/tool-flow";
import { makePdf } from "../helpers/test-files";
import { es } from "../../src/lib/locales/es";
import { en } from "../../src/lib/locales/en";
import { LANGUAGE_STORAGE_KEY, type Dictionary, type Language } from "../../src/lib/i18n";
import { THEME_STORAGE_KEY } from "../../src/lib/theme";
import { PRO_STRINGS, type ProStrings } from "../../src/app/pdf-pro/proStrings";
import { DOC_TOOL_IDS } from "../../src/app/pdf-pro/tabs/docToolsStrings";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import { SIGN_EMBEDDED_STRINGS } from "../../src/app/sign-pdf/signEmbeddedStrings";
import { FILL_EMBEDDED_STRINGS } from "../../src/app/sign-pdf/fillEmbeddedStrings";

/**
 * PDF Pro · barrido de accesibilidad de TODA la suite (Wave 7), navegador real y headless.
 *
 * Que cubre (todo sobre `/pdf-pro`):
 *  1. Barrido de estados con axe-core (todas las reglas activas, salvo `target-size`, que se mide aparte) + desborde
 *     horizontal + region viva unica + cadenas sin traducir + objetivos tactiles de 44 px (movil), en:
 *       - escenario COMPLETO (todos los estados) en (claro, ES, 1280) y (oscuro, EN, 375 tactil);
 *       - escenario CLAVE (vacio, documento, Convertir con opciones, paleta, menu, hoja «Guardar como…») en las otras
 *         seis combinaciones de tema x idioma x ventana.
 *     Estados: vacio (sin y con recientes), documento abierto, cada herramienta de documento de Inicio, cada pestaña
 *     (Inicio, Páginas, Editar, Anotar, Firmar, Rellenar, Proteger, Convertir), paleta (Ctrl+K), hoja de atajos, menus
 *     «Guardar y exportar» y «Más acciones», hojas «Guardar como…», «Guardar con contraseña…», «Nuevo en blanco»,
 *     «Nuevo desde imágenes», «Insertar desde Word/Excel/HTML», confirmaciones, recientes...
 *  2. Recorrido con Tab (>= 150 pulsaciones) desde el documento abierto y desde el estado vacio: el foco nunca cae a
 *     <body> salvo justo tras el ultimo control tabulable. F6 / Mayus+F6 recorren las regiones sin perder el foco.
 *  3. `prefers-reduced-motion: reduce`: abrir y cerrar hojas y menus funciona y NINGUNA hoja anima `transform`.
 *  4. `forced-colors: active`: botones primarios, pestaña elegida y foco siguen siendo distinguibles; sin desborde.
 *  5. Estados `:hover` (contraste de los controles al pasar el raton) y el selector real ES/EN de la barra lateral.
 *
 * OBJETIVOS TACTILES: se mide `getBoundingClientRect` de cada boton, enlace, pestaña del dock, opcion de menu, radio, casilla e
 * interruptor visibles; si la caja no llega a 44 px se mide el area que de verdad recibe el toque (hit-testing en cruz desde
 * el centro), porque varios controles amplian la zona con un pseudo-elemento. Excepcion admitida: enlaces EN LINEA dentro de
 * texto corrido.
 *
 * DEFECTOS DE PRODUCTO: los nueve hallazgos conocidos (A11Y-1 a A11Y-9) estan CORREGIDOS y NADA se tolera: el barrido
 * falla ante cualquier hallazgo y cada defecto tiene su prueba de regresion activa con la repro minima (A11Y-7, el
 * teclado en «Más acciones», es la prueba de menus con teclado). `KNOWN_DEFECTS` solo documenta que corrigio cada uno.
 *   A11Y-1  hoja «Atajos de teclado»: zona con scroll sin contenido enfocable + etiqueta de region duplicada.
 *   A11Y-2  `hover:text-glow` no llega a 4.5:1 al pasar el raton.
 *   A11Y-3  los modos montan regiones vivas propias ademas de la unica de PDF Pro.
 *   A11Y-4  «Deshacer» de la barra de Páginas (movil): zona tactil efectiva de 40x44.
 *   A11Y-5  muestras de tinta del compositor de firma (movil): 24-26 px (dibujar) y 36-40 px (escribir).
 *   A11Y-6  muestras de color (`ColorSwatches`, compositor de firma): el nombre accesible es un codigo hexadecimal.
 *   A11Y-7  «Más acciones» (escritorio): las flechas no salen de la primera opcion.
 *   A11Y-8  estado vacio a 320 px: desborde horizontal de 2 px (reflujo).
 *   A11Y-9  estado vacio (movil): el foco por teclado queda tapado por la barra de navegacion inferior fija.
 *
 * Uso (build de produccion en un puerto propio):
 *   npx next build && npx next start -p 3673 &
 *   PW_PORT=3673 npx playwright test e2e/specs/pdf-pro-a11y.spec.ts --project=chromium --workers=3
 */

// Con varios navegadores a la vez (y la maquina compartida) los 5 s de `expect` por defecto se quedan cortos en las esperas de hojas.
const expect = baseExpect.configure({ timeout: 12_000 });

const AXE_PATH = require.resolve("axe-core/axe.min.js");

/* ------------------------------------------------------------------ *
 * Tipos y entornos
 * ------------------------------------------------------------------ */

type Theme = "light" | "dark";
type Cell = { theme: Theme; language: Language; width: number };
type Phase = "empty" | "doc" | "dirty" | "recents" | "restored";

type Env = {
  cell: Cell;
  mobile: boolean;
  language: Language;
  S: ProStrings;
  t: Dictionary;
  SG: (typeof SIGN_STRINGS)[Language];
  SE: (typeof SIGN_EMBEDDED_STRINGS)[Language];
  FE: (typeof FILL_EMBEDDED_STRINGS)[Language];
  closeName: RegExp;
  /** Enlaces en linea dentro de texto corrido que la prueba tactil exime (se anotan en el informe). */
  exempt: Set<string>;
};

function makeEnv(cell: Cell): Env {
  const { language } = cell;
  return {
    cell,
    mobile: cell.width < 768,
    language,
    S: PRO_STRINGS[language],
    t: language === "es" ? es : en,
    SG: SIGN_STRINGS[language],
    SE: SIGN_EMBEDDED_STRINGS[language],
    FE: FILL_EMBEDDED_STRINGS[language],
    closeName: /^(Cerrar|Close)$/,
    exempt: new Set<string>(),
  };
}

function cellLabel(cell: Cell): string {
  return `${cell.theme === "light" ? "claro" : "oscuro"} · ${cell.language.toUpperCase()} · ${cell.width}${cell.width < 768 ? " táctil" : ""}`;
}

function cellOptions(cell: Cell) {
  const mobile = cell.width < 768;
  return {
    viewport: { width: cell.width, height: mobile ? 812 : 800 },
    colorScheme: cell.theme,
    locale: cell.language === "es" ? "es-ES" : "en-US",
    hasTouch: mobile,
    isMobile: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
  } as const;
}

/** Fija idioma y tema ANTES de que cargue la pagina (lo mismo que haria el selector de la barra lateral). */
async function presetPrefs(page: Page, cell: Cell): Promise<void> {
  await page.addInitScript(
    ([languageKey, themeKey, language, theme]) => {
      try {
        window.localStorage.setItem(languageKey, language);
        window.localStorage.setItem(themeKey, theme);
      } catch {
        /* storage bloqueado */
      }
    },
    [LANGUAGE_STORAGE_KEY, THEME_STORAGE_KEY, cell.language, cell.theme] as const,
  );
}

/* ------------------------------------------------------------------ *
 * Hallazgos y defectos conocidos
 * ------------------------------------------------------------------ */

type Finding = {
  state: string;
  check: "axe" | "overflow" | "live-regions" | "i18n" | "a11y-name" | "ids" | "touch" | "lang" | "theme" | "pointer" | "forced" | "trap" | "covered" | "spec-error";
  detail: string;
  rule?: string;
  mode?: boolean;
};

const formatFinding = (f: Finding): string => `[${f.state}] ${f.check}${f.rule ? `/${f.rule}` : ""}: ${f.detail}`;

/**
 * Defectos de PRODUCTO identificados (con repro minima en las pruebas del final de este archivo). Todos estan corregidos
 * (`fixed`): un hallazgo que cumple `matches` NO se tolera y hace fallar el barrido.
 */
const KNOWN_DEFECTS: ReadonlyArray<{ id: string; summary: string; matches: (finding: Finding) => boolean; fixed?: boolean }> = [
  {
    id: "A11Y-1",
    fixed: true,
    summary:
      "La hoja «Atajos de teclado» tiene una zona con scroll sin contenido enfocable (scrollable-region-focusable, WCAG 2.1.1) y la seccion «Documento»/«Document» repite la etiqueta de la region del visor (landmark-unique)",
    matches: (f) => f.state === "shortcuts" && f.check === "axe" && (f.rule === "scrollable-region-focusable" || f.rule === "landmark-unique"),
  },
  {
    id: "A11Y-2",
    fixed: true,
    summary:
      "Los controles con `hover:text-glow` (p. ej. «Opciones» de Convertir, «Ver todas las herramientas») no llegan a 4.5:1 al pasar el raton (claro 4.09:1 sobre #eaeaea; oscuro 3.98:1 sobre #0d0d0d y 4.3:1 sobre #000)",
    matches: (f) => f.check === "axe" && f.rule === "color-contrast" && f.state.startsWith("hover:") && f.detail.includes("hover:text-glow"),
  },
  {
    id: "A11Y-3",
    fixed: true,
    summary:
      "Los modos montan regiones vivas propias (role=status) ademas de la unica de PDF Pro (`ProToolClient`): 3 extra en Editar y Anotar, 6 en Firmar y Rellenar (7 con el compositor de firma); un lector de pantalla puede anunciar dos veces el mismo suceso. Corregido: dentro de PDF Pro los avisos de los modos salen por la region unica (`liveRouting`)",
    matches: (f) => f.check === "live-regions" && f.mode === true && f.detail.startsWith("regiones vivas adicionales"),
  },
  {
    id: "A11Y-4",
    fixed: true,
    summary:
      "Barra de «Páginas» en movil: «Deshacer» mide 36x36 y su zona tactil efectiva queda en 40x44 (< 44 de ancho): la ampliacion de 44 px de su derecha la tapa «Rehacer»",
    matches: (f) => f.check === "touch" && /\[(Deshacer|Rehacer|Undo|Redo)\]/.test(f.detail) && /^(tab-pages|pages-)/.test(f.state),
  },
  {
    id: "A11Y-5",
    fixed: true,
    summary:
      "Compositor de firma (movil): las muestras de tinta miden 24-26 px (modo dibujar) o 36-40 px (modo escribir): por debajo de 44 px de zona tactil",
    matches: (f) => f.check === "touch" && f.state === "sign-composer" && /^\[#[0-9a-f]{6}\]/i.test(f.detail),
  },
  {
    id: "A11Y-6",
    fixed: true,
    summary:
      "Las muestras de color (`ColorSwatches` compartido: marca de agua, numerar, encabezado; y las de tinta del compositor de firma) tienen como nombre accesible el codigo hexadecimal («#0b0b0c», «#0d4bff»...): no es un nombre util ni esta traducido",
    matches: (f) => f.check === "a11y-name",
  },
  {
    id: "A11Y-9",
    fixed: true,
    summary:
      "Foco tapado (WCAG 2.4.11) en movil: en el estado vacio, al recorrer la pagina con Tab los controles (herramientas sueltas, «Nuevo desde imagenes» y los enlaces del pie) quedan DETRAS de la barra de navegacion inferior fija, porque la pagina no reserva `scroll-padding-bottom` para ella",
    matches: (f) => f.check === "covered" && f.state === "tab-walk-empty-375",
  },
  {
    id: "A11Y-10",
    fixed: true,
    summary:
      "Firmar a 375 px: «Quitar todo de esta página» y «Borrar todo el documento» medían 36 px de alto y la paleta flotante (`fixed`) los tapaba aun al enfocarlos con el teclado: ahora miden 44 px y, al llevarlos a la vista, quedan POR ENCIMA de la paleta (`scroll-margin`)",
    matches: (f) => f.state === "tab-sign" && (f.check === "touch" || f.check === "covered") && /Quitar todo|Borrar todo/.test(f.detail),
  },
  {
    id: "A11Y-8",
    fixed: true,
    summary:
      "Estado vacio a 320 px en español (reflujo, WCAG 1.4.10): la insignia «Los borradores se guardan solo en este navegador.» no se parte en lineas, mide 306 px en un contenedor de 288 y la pagina desborda 2 px en horizontal",
    matches: (f) => f.check === "overflow" && f.detail.startsWith("a 320 px") && f.state.startsWith("empty"),
  },
];

function knownDefectOf(finding: Finding): string | null {
  // Los defectos ya CORREGIDOS (`fixed`) no se toleran: si reaparecen, el barrido falla.
  return KNOWN_DEFECTS.find((defect) => !defect.fixed && defect.matches(finding))?.id ?? null;
}

/** Separa los hallazgos reales de los defectos conocidos (que se anotan en el informe de la prueba). */
function partitionFindings(findings: Finding[], onTolerated: (id: string, text: string) => void): string[] {
  const real: string[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const known = knownDefectOf(finding);
    if (known) {
      const key = `${known}|${formatFinding(finding)}`;
      if (!seen.has(key)) {
        seen.add(key);
        onTolerated(known, formatFinding(finding));
      }
    } else {
      real.push(formatFinding(finding));
    }
  }
  return real;
}

function annotateTolerated(id: string, text: string): void {
  test.info().annotations.push({ type: `defecto-de-producto ${id}`, description: text });
  console.log(`[a11y] defecto de producto ${id}: ${text.slice(0, 400)}`);
}

/* ------------------------------------------------------------------ *
 * Documentos y ficheros de prueba
 * ------------------------------------------------------------------ */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const DOC_NAME = "report.pdf";

/**
 * Tres paginas A4 con texto editable y un formulario de tres campos (texto, casilla y desplegable). El texto es neutro
 * (ni palabras de la interfaz en español ni en ingles) para no falsear el detector de cadenas sin traducir.
 */
async function buildSuiteDoc(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const first = doc.addPage([595, 842]);
  first.drawText("Quarterly report", { x: 50, y: 770, size: 26, font: bold });
  first.drawText("Total due: 1250.00", { x: 50, y: 700, size: 14, font: regular, color: rgb(0.8, 0.1, 0.1) });
  const form = doc.getForm();
  form.createTextField("fullname").addToPage(first, { x: 50, y: 620, width: 260, height: 26 });
  form.createCheckBox("agree").addToPage(first, { x: 50, y: 580, width: 18, height: 18 });
  const country = form.createDropdown("country");
  country.addOptions(["Spain", "Mexico", "Chile"]);
  country.addToPage(first, { x: 50, y: 530, width: 180, height: 26 });
  for (let n = 2; n <= 3; n += 1) {
    doc.addPage([595, 842]).drawText(`Section ${n}`, { x: 50, y: 770, size: 20, font: regular });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/* ------------------------------------------------------------------ *
 * Sondas dentro de la pagina
 * ------------------------------------------------------------------ */

type AxeViolation = { id: string; impact: string; help: string; nodes: string[] };

async function ensureAxe(page: Page): Promise<void> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
}

type AxeResult = {
  violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown[]; failureSummary?: string }> }>;
};
type AxeApi = { run: (context: unknown, options: unknown) => Promise<AxeResult>; getRules: () => Array<{ ruleId: string }> };

/** Todas las reglas activas de axe (WCAG A/AA y buenas practicas); `target-size` se mide aparte con la prueba tactil. */
async function runAxe(page: Page): Promise<AxeViolation[]> {
  await ensureAxe(page);
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: AxeApi }).axe;
    const result = await axe.run(document, { rules: { "target-size": { enabled: false } }, resultTypes: ["violations"] });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? "",
      help: violation.help,
      nodes: violation.nodes
        .slice(0, 5)
        .map((node) => `${node.target.join(" ")} :: ${(node.failureSummary ?? "").split("\n").slice(0, 2).join(" ").trim().slice(0, 220)}`),
    }));
  });
}

type LiveRegion = { unique: boolean; srOnly: boolean; box: boolean; text: string; tag: string; marker: string; inDialog: boolean };

async function liveRegions(page: Page): Promise<LiveRegion[]> {
  return page.evaluate(() => {
    const hiddenByAttribute = (element: Element) => element.closest('[hidden],[aria-hidden="true"],[inert]') !== null;
    return Array.from(document.querySelectorAll<HTMLElement>('[role="status"],[aria-live]'))
      .filter((element) => element.getAttribute("aria-live") !== "off")
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && !hiddenByAttribute(element);
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          // La region viva UNICA de PDF Pro (`ProToolClient`): un `<p role="status" aria-atomic>` fuera de la suite.
          unique: element.matches('p[role="status"][aria-atomic="true"]') && element.closest("section[data-pro-suite]") === null,
          inDialog: element.closest('[role="dialog"]') !== null,
          srOnly: element.classList.contains("sr-only") || element.closest(".sr-only") !== null,
          box: rect.width > 1 && rect.height > 1,
          text: (element.textContent ?? "").trim().slice(0, 60),
          tag: element.tagName.toLowerCase(),
          // Para localizar la region en el codigo: el primer atributo `data-*` propio o el de un ancestro cercano.
          marker: (() => {
            const own = element.getAttributeNames().find((name) => name.startsWith("data-"));
            if (own) return own;
            const near = element.closest("[data-sign-doc],[data-fill-form],[data-edit-workspace],[data-pro-mode-host],[data-sequence],[data-embedded-chrome]");
            return near ? `en ${near.getAttributeNames().find((name) => name.startsWith("data-")) ?? near.tagName.toLowerCase()}` : (element.id ? `#${element.id}` : "");
          })(),
        };
      });
  });
}

type TouchReport = {
  checked: number;
  small: Array<{ name: string; tag: string; effW: number; effH: number; rectW: number; rectH: number }>;
  exempt: string[];
};

/**
 * Mide el area tactil REAL de cada control visible: primero su caja (`getBoundingClientRect`); si no llega a 44 px, el
 * area que de verdad recibe el toque (hit-testing en cruz desde su centro), porque varios controles amplian la zona con
 * un pseudo-elemento (`HIT_44`). Solo se exime a los enlaces EN LINEA dentro de texto corrido.
 */
async function probeTouchTargets(page: Page): Promise<TouchReport> {
  return page.evaluate(() => {
    const SELECTOR =
      'button, a[href], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="radio"], [role="checkbox"], [role="switch"], select, summary, input:not([type="hidden"]):not([type="file"])';
    const MIN = 43;
    const report: TouchReport = { checked: 0, small: [], exempt: [] };
    const hiddenByAttribute = (element: Element) => element.closest('[hidden],[aria-hidden="true"],[inert]') !== null;
    const visible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        !hiddenByAttribute(element) &&
        !(element.closest(".sr-only") !== null && document.activeElement !== element)
      );
    };
    const hits = (element: HTMLElement, x: number, y: number) => {
      const top = document.elementFromPoint(x, y);
      if (!top) return false;
      if (element === top || element.contains(top)) return true;
      const labels = (element as HTMLInputElement).labels;
      return !!labels && Array.from(labels).some((label) => label === top || label.contains(top));
    };
    const nameOf = (element: HTMLElement) =>
      (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || element.tagName)
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40);
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
      if ((element as HTMLButtonElement).disabled || !visible(element)) continue;
      report.checked += 1;
      const before = element.getBoundingClientRect();
      if (before.width >= 44 && before.height >= 44) continue;
      // Enlace en linea dentro de un parrafo: unica excepcion admitida.
      const style = getComputedStyle(element);
      if (element.tagName === "A" && style.display === "inline") {
        const block = element.parentElement;
        if (block && (block.textContent ?? "").trim().length > (element.textContent ?? "").trim().length + 8) {
          report.exempt.push(nameOf(element));
          continue;
        }
      }
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      // Tapado por una barra fija o una hoja: no se puede tocar sin mover algo, no se mide.
      if (!hits(element, cx, cy)) continue;
      const reach = (dx: number, dy: number) => {
        let steps = 0;
        for (let i = 1; i <= 60; i += 1) {
          const x = cx + dx * i;
          const y = cy + dy * i;
          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight || !hits(element, x, y)) break;
          steps = i;
        }
        return steps;
      };
      const effW = reach(-1, 0) + reach(1, 0) + 1;
      const effH = reach(0, -1) + reach(0, 1) + 1;
      if (effW < MIN || effH < MIN) {
        report.small.push({ name: nameOf(element), tag: element.tagName.toLowerCase(), effW, effH, rectW: Math.round(rect.width), rectH: Math.round(rect.height) });
      }
    }
    return report;
  });
}

async function scanText(page: Page): Promise<{ text: string; names: string[] }> {
  return page.evaluate(() => {
    const names: string[] = [];
    for (const element of Array.from(document.querySelectorAll("[aria-label],[title],[placeholder],[alt]"))) {
      for (const name of ["aria-label", "title", "placeholder", "alt"]) {
        const value = element.getAttribute(name);
        if (value) names.push(value);
      }
    }
    return { text: `${document.body.innerText}\n${names.join("\n")}`, names };
  });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/* ------------------------------------------------------------------ *
 * Cadenas sin traducir
 * ------------------------------------------------------------------ */

/**
 * Una clave de traduccion que se «fuga» a la pantalla: tres o mas segmentos separados por puntos (`tool.errors.notPdf`,
 * `docTools.runner.apply`). Es el patron del encargo, ampliado para que el primer segmento pueda llevar mayusculas (camelCase).
 */
const KEY_LIKE = /\b[a-z][A-Za-z]*(\.[A-Za-z][A-Za-z0-9]*){2,}\b/g;

/** Un nombre accesible que es un codigo de color («#0b0b0c»): no dice nada a quien usa un lector de pantalla. */
const HEX_NAME = /^#[0-9a-f]{3,8}$/i;

/** Palabras que SOLO existen en la interfaz en español (no en ingles) y que no pueden salir en la UI en ingles. */
const SPANISH_ONLY = [
  "Descargar", "Cerrar", "Páginas", "Página", "Aplicar", "Cancelar", "Guardar", "Abrir", "Deshacer", "Rehacer", "Inicio", "Editar",
  "Anotar", "Firmar", "Proteger", "Convertir", "Herramientas", "Herramienta", "Acercar", "Alejar", "Siguiente", "Anterior",
  "Seleccionar", "Atajos", "Miniaturas", "Recortar", "Comprimir", "Reparar", "Exportar", "Insertar", "Elegir", "Quitar", "Cambios",
  "Opciones", "Ajustes", "Buscar", "Privacidad", "Términos", "Recientes", "Contraseña", "Imágenes", "Unir", "Dividir", "Organizar",
  "Cargando", "Preparando", "Archivo", "Arrastra", "Suelta", "Todas", "Ninguna", "Rango", "Desde", "Hasta", "Tamaño", "Orientación",
  "Izquierda", "Derecha", "Arriba", "Abajo", "Borrador", "Descartar", "Continuar", "Volver", "Vista previa", "Marca de agua", "Numerar",
] as const;

/** Lo mismo al reves: palabras inglesas que no pueden salir en la UI en español. */
const ENGLISH_ONLY = [
  "Download", "Close", "Apply", "Cancel", "Save", "Undo", "Redo", "Annotate", "Protect", "Convert", "Tools", "Next", "Previous",
  "Shortcuts", "Thumbnails", "Options", "Settings", "Privacy", "Recent", "Password", "Images", "Merge", "Split", "Loading", "Discard",
  "Continue", "Preview", "Watermark",
] as const;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (text: string, word: string): boolean => new RegExp(`(?<![\\p{L}])${escapeRegExp(word)}(?![\\p{L}])`, "u").test(text);

function foreignWords(text: string, language: Language): string[] {
  const list = language === "en" ? SPANISH_ONLY : ENGLISH_ONLY;
  return list.filter((word) => hasWord(text, word));
}

/** Cuantas palabras de SU idioma aparecen: el control de que el detector no es ciego. */
function ownWords(text: string, language: Language): number {
  const list = language === "en" ? ENGLISH_ONLY : SPANISH_ONLY;
  return list.filter((word) => hasWord(text, word)).length;
}

/* ------------------------------------------------------------------ *
 * Navegacion comun
 * ------------------------------------------------------------------ */

type TabId = "home" | "pages" | "edit" | "annotate" | "sign" | "protect" | "convert";

async function goTab(page: Page, env: Env, id: TabId): Promise<void> {
  if (env.mobile) await page.locator(`[data-dock="${id}"]`).click();
  else await page.locator(`[role="tab"][data-tab="${id}"]`).click();
}

/** Espera a que la hoja superior deje de moverse (muelle de entrada ~1 s) y de cambiar de opacidad. */
async function waitStill(page: Page): Promise<void> {
  const dialogs = page.getByRole("dialog");
  if ((await dialogs.count()) === 0) return;
  const last = dialogs.last();
  let previous = "";
  let same = 0;
  await expect
    .poll(
      async () => {
        const signature = await last
          .evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value)).join(":") + `|${getComputedStyle(element).opacity}`;
          })
          .catch(() => "");
        same = signature !== "" && signature === previous ? same + 1 : 0;
        previous = signature;
        return same;
      },
      { intervals: [70], timeout: 10_000, message: "la hoja no llega a quedarse quieta" },
    )
    .toBeGreaterThanOrEqual(4);
}

/** Cierra menus y hojas (todas las apiladas): Escape y, si la hoja no se va, su boton «Cerrar». */
async function closeOverlays(page: Page, env: Env): Promise<void> {
  const dialogs = page.getByRole("dialog");
  const menus = page.getByRole("menu");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = (await dialogs.count()) + (await menus.count());
    if (before === 0) return;
    await page.keyboard.press("Escape");
    const decreased = await expect
      .poll(async () => (await dialogs.count()) + (await menus.count()), { timeout: 3000, intervals: [100] })
      .toBeLessThan(before)
      .then(
        () => true,
        () => false,
      );
    if (decreased) continue;
    const close = dialogs.last().getByRole("button", { name: env.closeName }).first();
    if ((await close.count()) > 0) await close.click().catch(() => undefined);
  }
  await expect(dialogs).toHaveCount(0);
}

async function waitDraft(page: Page): Promise<void> {
  // El autoguardado (calma de 600 ms) escribe en IndexedDB: se espera a verlo en la base real.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const open = indexedDB.open("optimuspdf-pro-drafts");
              open.onerror = () => resolve(-1);
              open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains("draftMeta")) {
                  db.close();
                  resolve(0);
                  return;
                }
                const count = db.transaction("draftMeta").objectStore("draftMeta").count();
                count.onsuccess = () => {
                  db.close();
                  resolve(count.result);
                };
              };
            }),
        ),
      { timeout: 20_000, message: "el borrador no llega a IndexedDB" },
    )
    .toBeGreaterThanOrEqual(1);
}

async function openDocument(page: Page, bytes: Buffer, name = DOC_NAME): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(escapeRegExp(name)) })).toBeVisible();
  await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 30_000 });
}

/** Un cambio real en el documento (rotar todas las paginas): deja «Cambios sin guardar» y arranca el borrador. */
async function makeDirty(page: Page, env: Env): Promise<void> {
  await toBase(page, env, "doc");
  if (env.mobile) {
    await goTab(page, env, "home");
    await waitStill(page);
  }
  await page.getByRole("button", { name: env.S.operations.rotateAll90, exact: true }).click();
  await expect(page.getByText(env.S.suite.unsaved).first()).toBeVisible();
  if (env.mobile) await closeOverlays(page, env);
}

/** Vuelve al estado base de la fase: sin hojas ni menus, y (con documento) en Inicio sin herramienta abierta. */
async function toBase(page: Page, env: Env, phase: Phase): Promise<void> {
  await closeOverlays(page, env);
  if (phase === "empty" || phase === "recents") {
    const banner = page.locator("[data-error-banner]");
    if ((await banner.count()) > 0) {
      await banner.getByRole("button", { name: env.closeName }).first().click().catch(() => undefined);
    }
    return;
  }
  if (env.mobile) {
    // Un modo (Editar, Anotar, Firmar) ocupa la region central: se sale yendo a Inicio y cerrando su hoja.
    if ((await page.locator("[data-pro-mode-host]").count()) > 0) {
      await goTab(page, env, "home");
      await waitStill(page);
      await closeOverlays(page, env);
    }
    return;
  }
  const home = page.locator('[role="tab"][data-tab="home"]');
  if ((await home.getAttribute("aria-selected")) !== "true") await home.click();
  if ((await page.locator("[data-doc-tool]").count()) > 0) {
    await page.getByRole("button", { name: env.S.docTools.launcher.back, exact: true }).click();
  }
}

/** Abre un menu del documento («Guardar y exportar» en escritorio, «Más acciones» en movil) y elige una opcion. */
async function viaMenu(page: Page, env: Env, which: "save" | "more", item: string): Promise<void> {
  const trigger = page.getByRole("button", { name: which === "save" ? env.S.save.menuLabel : env.S.shell.more, exact: true });
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: item }).click();
}

/* ------------------------------------------------------------------ *
 * Catalogo de estados
 * ------------------------------------------------------------------ */

type StateDef = {
  id: string;
  phase: Phase;
  only?: "desktop" | "mobile";
  /** El estado es un modo de edicion (Editar, Anotar, Firmar, Rellenar). */
  mode?: boolean;
  enter: (page: Page) => Promise<void>;
};

function buildStates(env: Env): StateDef[] {
  const { S, SG, SE, FE } = env;
  const T = S.docTools;
  const E = S.export;
  const C = S.create;
  const states: StateDef[] = [];
  const add = (state: StateDef) => states.push(state);

  /* ---- estado vacio ---- */
  add({ id: "empty", phase: "empty", enter: async () => undefined });
  add({
    id: "empty-error",
    phase: "empty",
    enter: async (page) => {
      await page.locator('input[type="file"]').first().setInputFiles({ name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("this is not a pdf") });
      await expect(page.locator("[data-error-banner]")).toBeVisible();
    },
  });
  add({
    id: "empty-new-blank",
    phase: "empty",
    enter: async (page) => {
      await page.locator('[data-pro-new="blank"]').click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });
  add({
    id: "empty-new-images",
    phase: "empty",
    enter: async (page) => {
      await page.locator("[data-pro-create-input]").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG_1X1 });
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });
  add({
    id: "empty-password",
    phase: "empty",
    enter: async (page) => {
      const locked = await makePdf({ pages: 2, label: "LOCK", userPassword: "secret1" });
      await page.locator('input[type="file"]').first().setInputFiles({ name: "locked.pdf", mimeType: "application/pdf", buffer: locked });
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });

  /* ---- documento abierto: Inicio ---- */
  add({ id: "doc", phase: "doc", enter: async () => undefined });
  add({
    id: "tab-home",
    phase: "doc",
    only: "mobile",
    enter: async (page) => {
      await goTab(page, env, "home");
      await waitStill(page);
    },
  });
  // «Quitar protección» (`unlock`) no esta en Inicio: vive dentro de la pestaña Proteger (estado `tab-protect`).
  for (const id of DOC_TOOL_IDS.filter((tool) => tool !== "unlock")) {
    add({
      id: `doc-tool-${id}`,
      phase: "doc",
      enter: async (page) => {
        if (env.mobile) {
          await goTab(page, env, "home");
          await waitStill(page);
        }
        await page.getByRole("button", { name: T.launcher.open(T.tools[id].title), exact: true }).click();
        await expect(page.getByRole("heading", { level: 2, name: T.tools[id].title, exact: true })).toBeVisible();
        // La vista previa real (pdf.js) llega despues: se espera a que el aviso de carga se vaya.
        await expect(page.getByText(T.runner.previewLoading)).toHaveCount(0, { timeout: 20_000 });
      },
    });
  }

  /* ---- Paginas ---- */
  add({
    id: "tab-pages",
    phase: "doc",
    enter: async (page) => {
      await goTab(page, env, "pages");
      await expect(page.locator("[data-pages-grid]")).toBeVisible();
      await expect(page.locator('[data-pages-grid] [role="option"]').first()).toBeVisible();
      if (env.mobile) await waitStill(page);
    },
  });
  add({
    id: "pages-selected",
    phase: "doc",
    enter: async (page) => {
      await goTab(page, env, "pages");
      await expect(page.locator('[data-pages-grid] [role="option"]').nth(1)).toBeVisible();
      if (env.mobile) await waitStill(page);
      await page.locator('[data-pages-grid] [role="option"]').nth(1).click();
      await expect(page.locator('[data-pages-grid] [role="option"][aria-selected="true"]')).toHaveCount(1);
    },
  });
  add({
    id: "pages-more",
    phase: "doc",
    enter: async (page) => {
      await goTab(page, env, "pages");
      await expect(page.locator('[data-pages-grid] [role="option"]').first()).toBeVisible();
      if (env.mobile) await waitStill(page);
      await page.locator('[data-action="more"]').click();
      await expect(page.getByRole("dialog")).toHaveCount(env.mobile ? 2 : 1);
      await waitStill(page);
    },
  });
  add({
    id: "pages-blank-sheet",
    phase: "doc",
    enter: async (page) => {
      await goTab(page, env, "pages");
      await expect(page.locator('[data-pages-grid] [role="option"]').first()).toBeVisible();
      if (env.mobile) await waitStill(page);
      await page.locator('[data-action="more"]').click();
      await expect(page.getByRole("dialog")).toHaveCount(env.mobile ? 2 : 1);
      await waitStill(page);
      await page.getByRole("dialog").last().getByRole("button", { name: S.pages.actions.insertBlank, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(env.mobile ? 2 : 1);
      await waitStill(page);
    },
  });

  /* ---- modos ---- */
  add({
    id: "tab-edit",
    phase: "doc",
    mode: true,
    enter: async (page) => {
      await goTab(page, env, "edit");
      await expect(page.locator("[data-pro-mode-host]")).toBeVisible();
      await expect(page.locator('[data-render-state="ready"]').first()).toBeVisible({ timeout: 30_000 });
    },
  });
  add({
    id: "tab-annotate",
    phase: "doc",
    mode: true,
    enter: async (page) => {
      await goTab(page, env, "annotate");
      await expect(page.locator("[data-pro-mode-host]")).toBeVisible();
      await expect(page.locator('[data-render-state="ready"]').first()).toBeVisible({ timeout: 30_000 });
    },
  });
  add({
    id: "tab-sign",
    phase: "doc",
    mode: true,
    enter: async (page) => {
      await goTab(page, env, "sign");
      await expect(page.getByRole("region", { name: SE.regionLabel })).toBeVisible();
    },
  });
  add({
    id: "sign-composer",
    phase: "doc",
    mode: true,
    enter: async (page) => {
      await goTab(page, env, "sign");
      await expect(page.getByRole("region", { name: SE.regionLabel })).toBeVisible();
      await page.getByRole("button", { name: SG.createSignature }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });
  add({
    id: "tab-fill",
    phase: "doc",
    mode: true,
    enter: async (page) => {
      await goTab(page, env, "sign");
      await expect(page.getByRole("region", { name: SE.regionLabel })).toBeVisible();
      await page.getByRole("tab", { name: SE.switchFill }).click();
      await expect(page.getByRole("region", { name: FE.regionLabel })).toBeVisible();
    },
  });

  /* ---- Proteger y Convertir ---- */
  add({
    id: "tab-protect",
    phase: "doc",
    enter: async (page) => {
      await goTab(page, env, "protect");
      await expect(page.getByRole("heading", { name: T.protect.saveTitle })).toBeVisible();
      if (env.mobile) await waitStill(page);
    },
  });
  add({
    id: "tab-convert",
    phase: "doc",
    enter: async (page) => {
      await goTab(page, env, "convert");
      await expect(page.locator('[data-doc-tab="convert"]')).toBeVisible();
      if (env.mobile) await waitStill(page);
    },
  });
  add({
    id: "convert-options",
    phase: "doc",
    enter: async (page) => {
      await goTab(page, env, "convert");
      await expect(page.locator('[data-doc-tab="convert"]')).toBeVisible();
      if (env.mobile) await waitStill(page);
      const card = page.locator('[data-export="images"]');
      await card.scrollIntoViewIfNeeded();
      await card.getByRole("button", { name: E.card.showOptions, exact: true }).click();
      await expect(card.locator("[data-export-options]")).toBeVisible();
      // El raton se queda sobre el boton: se aparta para medir el estado en reposo (el `:hover` se prueba aparte).
      await page.mouse.move(1, 1);
    },
  });
  add({
    id: "convert-all-options",
    phase: "doc",
    enter: async (page) => {
      await goTab(page, env, "convert");
      await expect(page.locator('[data-doc-tab="convert"]')).toBeVisible();
      if (env.mobile) await waitStill(page);
      const closed = page.locator('[data-export] button[aria-expanded="false"][aria-controls]');
      // Cada boton pasa a «expandido» al pulsarlo: siempre se pulsa el primero que queda.
      for (let remaining = await closed.count(); remaining > 0; remaining = await closed.count()) {
        await closed.first().scrollIntoViewIfNeeded();
        await closed.first().click();
      }
      await page.mouse.move(1, 1);
    },
  });

  /* ---- paleta, atajos, menus ---- */
  add({
    id: "palette",
    phase: "doc",
    enter: async (page) => {
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("combobox")).toBeFocused();
      await waitStill(page);
    },
  });
  add({
    id: "shortcuts",
    phase: "doc",
    enter: async (page) => {
      await viaMenu(page, env, "more", S.shell.shortcutsItem);
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });
  add({
    id: "menu-save",
    phase: "doc",
    only: "desktop",
    enter: async (page) => {
      await page.getByRole("button", { name: S.save.menuLabel, exact: true }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.mouse.move(1, 1);
    },
  });
  add({
    id: "menu-more",
    phase: "doc",
    enter: async (page) => {
      await page.getByRole("button", { name: S.shell.more, exact: true }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.mouse.move(1, 1);
    },
  });

  /* ---- hojas del menu ---- */
  add({
    id: "sheet-save-as",
    phase: "doc",
    enter: async (page) => {
      await viaMenu(page, env, env.mobile ? "more" : "save", S.save.saveAs);
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });
  add({
    id: "sheet-save-password",
    phase: "doc",
    enter: async (page) => {
      await viaMenu(page, env, env.mobile ? "more" : "save", S.save.saveWithPassword);
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });
  add({
    id: "sheet-new-blank",
    phase: "doc",
    enter: async (page) => {
      await viaMenu(page, env, "more", C.menu.newBlank);
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });
  add({
    id: "sheet-new-images",
    phase: "doc",
    enter: async (page) => {
      await page.locator("[data-pro-create-input]").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG_1X1 });
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });
  for (const [kind, file] of [
    ["word", { name: "note.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("not a real docx") }],
    ["excel", { name: "sheet.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("not a real xlsx") }],
    ["html", { name: "page.html", mimeType: "text/html", buffer: Buffer.from("<html><body><h1>Hello</h1></body></html>") }],
    ["unsupported", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plain text") }],
  ] as const) {
    add({
      id: `sheet-insert-${kind}`,
      phase: "doc",
      enter: async (page) => {
        await page.locator("[data-pro-import-input]").setInputFiles(file);
        await expect(page.getByRole("dialog")).toBeVisible();
        await waitStill(page);
      },
    });
  }
  add({
    id: "sheet-recents",
    phase: "doc",
    enter: async (page) => {
      await viaMenu(page, env, "more", C.menu.recents);
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });
  add({
    id: "mobile-thumbs",
    phase: "doc",
    only: "mobile",
    enter: async (page) => {
      await page.getByRole("button", { name: S.viewer.openThumbs, exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });

  /* ---- documento con cambios: confirmaciones ---- */
  add({
    id: "confirm-close",
    phase: "dirty",
    enter: async (page) => {
      if (env.mobile) await viaMenu(page, env, "more", S.shell.closeItem);
      else await page.getByRole("button", { name: S.suite.close, exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });
  add({
    id: "confirm-replace",
    phase: "dirty",
    enter: async (page) => {
      await page.locator("[data-pro-open-input]").setInputFiles({ name: "other.pdf", mimeType: "application/pdf", buffer: await makePdf({ pages: 1, label: "OTHER" }) });
      await expect(page.getByRole("dialog")).toBeVisible();
      await waitStill(page);
    },
  });

  /* ---- recientes (tras recargar con un borrador guardado) ---- */
  add({
    id: "empty-recents",
    phase: "recents",
    enter: async (page) => {
      await expect(page.getByRole("button", { name: S.empty.recentOpen(DOC_NAME) })).toBeVisible();
      // La miniatura de la primera pagina de cada reciente se dibuja despues: se espera a que llegue.
      await expect(page.locator("[data-recent-thumb]").first()).toBeVisible({ timeout: 15_000 });
    },
  });
  add({
    id: "doc-restored",
    phase: "restored",
    enter: async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: new RegExp(escapeRegExp(DOC_NAME)) })).toBeVisible();
      if (env.mobile) {
        await goTab(page, env, "home");
        await waitStill(page);
      }
    },
  });
  add({
    id: "sheet-recents-list",
    phase: "restored",
    enter: async (page) => {
      await viaMenu(page, env, "more", C.menu.recents);
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.locator("[data-recent-list]")).toBeVisible();
      await waitStill(page);
    },
  });

  return states;
}

/** Estados del escenario CLAVE (las seis combinaciones restantes de tema x idioma x ventana). */
const KEY_STATES: readonly string[] = ["empty", "doc", "convert-options", "palette", "menu-more", "sheet-save-as"];

/* ------------------------------------------------------------------ *
 * Comprobaciones por estado
 * ------------------------------------------------------------------ */

async function audit(page: Page, env: Env, state: StateDef): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (check: Finding["check"], detail: string, rule?: string) => findings.push({ state: state.id, check, detail, rule, mode: state.mode });

  for (const violation of await runAxe(page)) {
    add("axe", `${violation.help} (${violation.impact}) → ${violation.nodes.join(" | ")}`, violation.id);
  }

  const overflow = await horizontalOverflow(page);
  if (overflow > 0) add("overflow", `la pagina desborda ${overflow}px en horizontal`);

  // Dos elementos con el mismo `id` rompen `aria-labelledby`, `aria-controls` y las etiquetas `for`.
  const duplicateIds = await page.evaluate(() => {
    const counts = new Map<string, number>();
    for (const element of Array.from(document.querySelectorAll("[id]"))) counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
    return Array.from(counts)
      .filter(([id, count]) => id !== "" && count > 1)
      .map(([id, count]) => `${id} x${count}`);
  });
  if (duplicateIds.length > 0) add("ids", `ids duplicados en el documento: ${duplicateIds.join(", ")}`);

  const language = await page.evaluate(() => document.documentElement.lang);
  if (language !== env.language) add("lang", `<html lang="${language}"> en una interfaz en «${env.language}»`);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
  if (theme !== env.cell.theme) add("theme", `data-theme="${theme}" y se esperaba «${env.cell.theme}»`);

  // Region viva unica: PDF Pro lleva UNA (sr-only). Ademas de ella cabe, como mucho, otra region viva en todo el
  // arbol de accesibilidad (p. ej. la de una hoja modal, que la region unica de fuera no alcanza).
  const live = await liveRegions(page);
  const unique = live.filter((region) => region.unique);
  const others = live.filter((region) => !region.unique);
  if (unique.length !== 1) add("live-regions", `la region viva unica de PDF Pro aparece ${unique.length} veces (debe ser 1)`);
  const describeRegion = (region: (typeof live)[number]) =>
    `${region.tag}${region.srOnly ? ".sr-only" : ""}${region.marker ? `[${region.marker}]` : ""}${region.text ? `«${region.text.slice(0, 28)}»` : ""}`;
  if (others.length > 1) {
    add("live-regions", `regiones vivas adicionales a la unica: ${others.length} (maximo 1): ${others.map(describeRegion).join(", ")}`);
  }
  // Un modo NO monta regiones vivas propias en la pagina: todo suceso se anuncia por la region unica de PDF Pro (una region
  // por suceso). Solo las hojas modales, que la region de fuera no alcanza, llevan la suya.
  const outsideDialogs = others.filter((region) => !region.inDialog);
  if (state.mode === true && outsideDialogs.length > 0) {
    add(
      "live-regions",
      `regiones vivas adicionales a la unica fuera de las hojas en un modo: ${outsideDialogs.length} (maximo 0): ${outsideDialogs.map(describeRegion).join(", ")}`,
    );
  }

  // Cadenas sin traducir: claves que se fugan y palabras del otro idioma.
  const { text, names } = await scanText(page);
  const keys = [...new Set(text.match(KEY_LIKE) ?? [])];
  if (keys.length > 0) add("i18n", `claves de traduccion visibles: ${keys.join(", ")}`);
  const foreign = foreignWords(text, env.language);
  if (foreign.length > 0) add("i18n", `palabras de otro idioma en la interfaz «${env.language}»: ${foreign.join(", ")}`);

  const hexNames = [...new Set(names.map((name) => name.trim()).filter((name) => HEX_NAME.test(name)))];
  if (hexNames.length > 0) add("a11y-name", `nombres accesibles que son un codigo de color: ${hexNames.join(", ")}`);

  if (env.mobile) {
    const touch = await probeTouchTargets(page);
    for (const name of touch.exempt) env.exempt.add(name);
    for (const small of touch.small) {
      add("touch", `[${small.name}] ${small.tag} ${small.rectW}x${small.rectH} (zona tactil efectiva ${small.effW}x${small.effH}) < 44`);
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * Barrido
 * ------------------------------------------------------------------ */

async function sweep(
  page: Page,
  env: Env,
  only: readonly string[] | null,
  check: (page: Page, env: Env, state: StateDef) => Promise<Finding[]> = audit,
): Promise<{ findings: Finding[]; visited: string[] }> {
  const findings: Finding[] = [];
  const visited: string[] = [];
  const states = buildStates(env);
  const bytes = await buildSuiteDoc();
  // Solo para depurar un estado suelto: `PRO_A11Y_ONLY=tab-pages,pages-selected`.
  const forced = process.env.PRO_A11Y_ONLY?.split(",").filter(Boolean);
  if (forced && forced.length > 0) only = forced;
  let phase: Phase = "empty";

  await page.goto("/pdf-pro");
  await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
  // La emulacion tactil tiene que ser real: sin puntero grueso las reglas `pointer-coarse:` (zonas de 44 px) no se aplican.
  const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  if (coarse !== env.mobile) findings.push({ state: "sweep", check: "pointer", detail: `(pointer: coarse) = ${coarse} en una ventana ${env.mobile ? "tactil" : "de escritorio"}` });

  const ensurePhase = async (target: Phase): Promise<void> => {
    if (target === phase) return;
    if (target !== "empty" && phase === "empty") await openDocument(page, bytes);
    if (target === "dirty" || target === "recents" || target === "restored") {
      if (phase === "empty" || phase === "doc") await makeDirty(page, env);
    }
    if ((target === "recents" || target === "restored") && phase !== "recents" && phase !== "restored") {
      await waitDraft(page);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    }
    if (target === "restored" && phase !== "restored") {
      // Se retoma el borrador desde «Documentos recientes»: queda el documento restaurado.
      await page.getByRole("button", { name: env.S.empty.recentOpen(DOC_NAME) }).click();
      await expect(page.getByRole("heading", { level: 1, name: new RegExp(escapeRegExp(DOC_NAME)) })).toBeVisible();
      await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 30_000 });
    }
    phase = target;
  };

  for (const state of states) {
    if (only && !only.includes(state.id)) continue;
    if (state.only && state.only !== (env.mobile ? "mobile" : "desktop")) continue;
    await test.step(state.id, async () => {
      const started = Date.now();
      try {
        await ensurePhase(state.phase);
        await toBase(page, env, state.phase);
        await state.enter(page);
        await page.waitForTimeout(150);
        findings.push(...(await check(page, env, state)));
        visited.push(state.id);
      } catch (error) {
        findings.push({ state: state.id, check: "spec-error", detail: String(error).split("\n").slice(0, 4).join(" | ") });
        await toBase(page, env, state.phase).catch(() => undefined);
      }
      if (process.env.PRO_A11Y_VERBOSE === "1") console.log(`[a11y] ${cellLabel(env.cell)} · ${state.id}: ${Date.now() - started} ms`);
    });
  }
  if (env.exempt.size > 0) {
    test.info().annotations.push({ type: "excepcion-tactil", description: `enlaces en linea dentro de texto corrido eximidos: ${[...env.exempt].join(" | ")}` });
  }
  return { findings, visited };
}

/* ------------------------------------------------------------------ *
 * 1 · Barrido de estados: axe, desborde, region viva, cadenas y tactil
 * ------------------------------------------------------------------ */

const FULL_CELLS: Cell[] = [
  { theme: "light", language: "es", width: 1280 },
  { theme: "dark", language: "en", width: 375 },
];
const KEY_CELLS: Cell[] = [
  { theme: "dark", language: "es", width: 1280 },
  { theme: "light", language: "en", width: 1280 },
  { theme: "dark", language: "en", width: 1280 },
  { theme: "light", language: "es", width: 375 },
  { theme: "dark", language: "es", width: 375 },
  { theme: "light", language: "en", width: 375 },
];

// Sin limite de accion (valor por defecto de la configuracion) un clic sobre algo que no se deja pulsar cuelga la prueba entera.
test.use({ actionTimeout: 20_000, navigationTimeout: 30_000 });
test.describe.configure({ mode: "parallel" });

for (const cell of FULL_CELLS) {
  test.describe(`barrido completo · ${cellLabel(cell)}`, () => {
    test.use(cellOptions(cell));
    test.setTimeout(900_000);

    test("todos los estados: axe, desborde, region viva unica, cadenas sin traducir y objetivos tactiles", async ({ page }) => {
      const env = makeEnv(cell);
      await presetPrefs(page, cell);
      const { findings, visited } = await sweep(page, env, null);
      console.log(`[a11y] ${cellLabel(cell)}: ${visited.length} estados revisados: ${visited.join(", ")}`);
      expect(visited.length, "se revisaron los estados esperados").toBeGreaterThanOrEqual(env.mobile ? 40 : 38);
      const real = partitionFindings(findings, annotateTolerated);
      expect(real, `hallazgos en ${cellLabel(cell)}:\n${real.join("\n")}`).toEqual([]);
    });
  });
}

for (const cell of KEY_CELLS) {
  test.describe(`barrido de estados clave · ${cellLabel(cell)}`, () => {
    test.use(cellOptions(cell));
    test.setTimeout(300_000);

    test("vacio, documento, Convertir con opciones, paleta, menu y «Guardar como…»", async ({ page }) => {
      const env = makeEnv(cell);
      await presetPrefs(page, cell);
      const { findings, visited } = await sweep(page, env, KEY_STATES);
      expect(visited, "estados clave revisados").toEqual([...KEY_STATES]);
      const real = partitionFindings(findings, annotateTolerated);
      expect(real, `hallazgos en ${cellLabel(cell)}:\n${real.join("\n")}`).toEqual([]);
    });
  });
}


/* ------------------------------------------------------------------ *
 * 2 · Las reglas de axe del encargo se evaluan de verdad
 * ------------------------------------------------------------------ */

const BRIEF_RULES = [
  "color-contrast",
  "aria-valid-attr-value",
  "aria-required-attr",
  "aria-required-children",
  "aria-required-parent",
  "label",
  "button-name",
  "link-name",
  "aria-allowed-attr",
  "aria-roles",
  "nested-interactive",
  "region",
  "scrollable-region-focusable",
] as const;

const LIGHT_ES_DESKTOP: Cell = { theme: "light", language: "es", width: 1280 };

test.describe("axe · cobertura de reglas", () => {
  test.use(cellOptions(LIGHT_ES_DESKTOP));

  test("la configuracion del barrido evalua todas las reglas del encargo (no hay reglas inertes)", async ({ page }) => {
    await presetPrefs(page, LIGHT_ES_DESKTOP);
    await page.goto("/pdf-pro");
    await openDocument(page, await buildSuiteDoc());
    await ensureAxe(page);
    const evaluated = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<Record<string, Array<{ id: string; nodes: unknown[] }>>> } }).axe;
      // La MISMA configuracion que usa el barrido, pero pidiendo tambien lo que pasa: asi se ve que cada regla encontro nodos.
      const result = await axe.run(document, { rules: { "target-size": { enabled: false } } });
      const applied = (key: string) => (result[key] ?? []).map((rule) => ({ id: rule.id, nodes: rule.nodes.length }));
      return { passes: applied("passes"), violations: applied("violations"), incomplete: applied("incomplete"), inapplicable: applied("inapplicable") };
    });
    const seen = new Set([...evaluated.passes, ...evaluated.violations, ...evaluated.incomplete, ...evaluated.inapplicable].map((rule) => rule.id));
    expect([...BRIEF_RULES].filter((id) => !seen.has(id)), "reglas del encargo que axe no llego a evaluar").toEqual([]);
    // Y las que importan de verdad se aplican a muchos elementos (no pasan «por vacio»).
    const nodes = (id: string) => evaluated.passes.find((rule) => rule.id === id)?.nodes ?? 0;
    expect(nodes("color-contrast"), "elementos con contraste comprobado").toBeGreaterThan(15);
    expect(nodes("button-name"), "botones con nombre comprobado").toBeGreaterThan(10);
    expect(nodes("aria-valid-attr-value"), "atributos ARIA comprobados").toBeGreaterThan(5);
    expect(evaluated.violations.map((rule) => rule.id), "el documento abierto no tiene violaciones").toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · Recorrido con Tab: el foco nunca cae a <body>
 * ------------------------------------------------------------------ */

type TabStop = { name: string; body: boolean; last: boolean; hidden: boolean; zero: boolean; hiddenBehind: string; offscreen: boolean };

async function tabStop(page: Page): Promise<TabStop> {
  return page.evaluate(() => {
    const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';
    const tabbable = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((element) => {
      if (element.tabIndex < 0) return false;
      if ((element as HTMLButtonElement).disabled || element.closest("[inert]")) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && (rect.width > 0 || rect.height > 0 || element.matches(".sr-only"));
    });
    const active = document.activeElement as HTMLElement | null;
    const body = !active || active === document.body || active === document.documentElement;
    const rect = active ? active.getBoundingClientRect() : null;
    // Foco oculto (WCAG 2.4.11): el centro del control que tiene el foco queda tapado por OTRO elemento (barra fija, hoja...).
    let hiddenBehind = "";
    let offscreen = false;
    if (!body && rect && (rect.width > 0 || rect.height > 0)) {
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
      offscreen = rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth;
      const top = document.elementFromPoint(cx, cy);
      if (!offscreen && top && top !== active && !active!.contains(top) && !top.contains(active!)) {
        hiddenBehind = `${top.tagName.toLowerCase()}${top.getAttribute("data-pro-region") ? `[${top.getAttribute("data-pro-region")}]` : ""} ${(top.getAttribute("aria-label") ?? top.textContent ?? "").trim().slice(0, 24)}`;
      }
    }
    return {
      name: body ? "<body>" : `${active!.tagName.toLowerCase()} ${(active!.getAttribute("aria-label") ?? active!.textContent ?? "").trim().slice(0, 28)}`,
      body,
      last: !!active && active === tabbable[tabbable.length - 1],
      hidden: !body && active!.closest('[aria-hidden="true"],[inert]') !== null,
      zero: !body && !!rect && rect.width === 0 && rect.height === 0,
      hiddenBehind,
      offscreen,
    };
  });
}

/** Pulsa Tab `presses` veces y devuelve donde se perdio el foco (<body> fuera de la salida natural) y los controles raros. */
async function tabWalk(
  page: Page,
  presses: number,
): Promise<{ lost: string[]; hidden: string[]; zero: string[]; covered: string[]; offscreen: string[]; distinct: number; cycles: number }> {
  const trail: TabStop[] = [];
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press("Tab");
    trail.push(await tabStop(page));
  }
  const lost = trail.flatMap((step, i) => (step.body && !(i > 0 && trail[i - 1].last) ? [`#${i + 1} tras «${trail[i - 1]?.name ?? "inicio"}»`] : []));
  return {
    lost,
    hidden: trail.filter((step) => step.hidden).map((step) => step.name),
    zero: trail.filter((step) => step.zero).map((step) => step.name),
    covered: [...new Set(trail.filter((step) => step.hiddenBehind !== "").map((step) => `${step.name} (tapado por ${step.hiddenBehind})`))],
    offscreen: [...new Set(trail.filter((step) => step.offscreen).map((step) => step.name))],
    distinct: new Set(trail.map((step) => step.name)).size,
    // Cuantas veces el recorrido salio por el final y volvio a empezar: prueba de que se cubrio TODA la pagina.
    cycles: trail.filter((step) => step.body).length,
  };
}

const PRESSES = 170;

for (const width of [1280, 375] as const) {
  const cell: Cell = { theme: "light", language: "es", width };
  test.describe(`recorrido con Tab · ${width === 375 ? "móvil 375 táctil" : "escritorio 1280"}`, () => {
    test.use(cellOptions(cell));
    test.setTimeout(180_000);

    test(`desde el documento abierto: ${PRESSES} Tab sin foco en <body> salvo tras el ultimo control`, async ({ page }) => {
      await presetPrefs(page, cell);
      await page.goto("/pdf-pro");
      await openDocument(page, await buildSuiteDoc());
      await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
      const walk = await tabWalk(page, PRESSES);
      expect(walk.lost, `foco perdido en <body>:\n${walk.lost.join("\n")}`).toEqual([]);
      expect(walk.hidden, "foco dentro de algo aria-hidden/inert").toEqual([]);
      const covered = partitionFindings(
        walk.covered.map((detail) => ({ state: `tab-walk-doc-${width}`, check: "covered" as const, detail })),
        annotateTolerated,
      );
      expect(covered, "controles con foco tapados por otro elemento (WCAG 2.4.11)").toEqual([]);
      expect(walk.offscreen, "controles con foco fuera de la ventana").toEqual([]);
      expect(walk.distinct, "paradas distintas del recorrido").toBeGreaterThanOrEqual(width === 375 ? 12 : 20);
      expect(walk.cycles, "el recorrido dio al menos una vuelta completa a la pagina").toBeGreaterThanOrEqual(1);
    });

    test(`desde el estado vacio: ${PRESSES} Tab sin foco en <body> salvo tras el ultimo control`, async ({ page }) => {
      await presetPrefs(page, cell);
      await page.goto("/pdf-pro");
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
      const walk = await tabWalk(page, PRESSES);
      expect(walk.lost, `foco perdido en <body>:\n${walk.lost.join("\n")}`).toEqual([]);
      expect(walk.hidden, "foco dentro de algo aria-hidden/inert").toEqual([]);
      const covered = partitionFindings(
        walk.covered.map((detail) => ({ state: `tab-walk-empty-${width}`, check: "covered" as const, detail })),
        annotateTolerated,
      );
      expect(covered, "controles con foco tapados por otro elemento (WCAG 2.4.11)").toEqual([]);
      expect(walk.offscreen, "controles con foco fuera de la ventana").toEqual([]);
      expect(walk.distinct, "paradas distintas del recorrido").toBeGreaterThanOrEqual(width === 375 ? 10 : 15);
      expect(walk.cycles, "el recorrido dio al menos una vuelta completa a la pagina").toBeGreaterThanOrEqual(1);
    });

    test("el detector de foco perdido es sensible: un control que se retira del DOM deja el foco en <body>", async ({ page }) => {
      await presetPrefs(page, cell);
      await page.goto("/pdf-pro");
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
      await page.evaluate(() => {
        const probe = document.createElement("button");
        probe.id = "focus-probe";
        probe.textContent = "probe";
        document.body.appendChild(probe);
        probe.focus();
      });
      expect((await tabStop(page)).name).toBe("button probe");
      await page.evaluate(() => document.getElementById("focus-probe")?.remove());
      expect((await tabStop(page)).body, "tras retirar el control con foco, el foco vuelve a <body>").toBe(true);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 4 · F6 / Mayus+F6 recorren las regiones
 * ------------------------------------------------------------------ */

/** Region (`data-pro-region`) que contiene el foco, o `<body>`. */
async function focusRegion(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return "<body>";
    return active.closest("[data-pro-region]")?.getAttribute("data-pro-region") ?? `?(${active.tagName.toLowerCase()})`;
  });
}

async function pressF6(page: Page, times: number, shift: boolean): Promise<string[]> {
  const visited: string[] = [];
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press(shift ? "Shift+F6" : "F6");
    visited.push(await focusRegion(page));
  }
  return visited;
}

for (const width of [1280, 375] as const) {
  const cell: Cell = { theme: "light", language: "es", width };
  const mobile = width < 768;
  test.describe(`F6 y Mayús+F6 · ${mobile ? "móvil 375 táctil" : "escritorio 1280"}`, () => {
    test.use(cellOptions(cell));

    test("recorren las regiones en orden, dan la vuelta y el foco nunca cae a <body>", async ({ page }) => {
      await presetPrefs(page, cell);
      await page.goto("/pdf-pro");
      await openDocument(page, await buildSuiteDoc());
      await page.locator('[data-pro-region="top"] h1').focus();
      expect(await focusRegion(page)).toBe("top");
      // Escritorio: barra, pestañas, miniaturas, visor y panel. Movil: barra, barra de herramientas inferior y visor.
      const order = mobile ? ["tabs", "viewer", "top"] : ["tabs", "thumbs", "viewer", "context", "top"];
      const forward = await pressF6(page, order.length * 2 + 1, false);
      expect(forward, "F6").toEqual([...order, ...order, order[0]]);
      // Hacia atras desde la barra: el recorrido inverso.
      await page.locator('[data-pro-region="top"] h1').focus();
      const backward = await pressF6(page, order.length * 2 + 1, true);
      // Desde la barra, Mayus+F6 va a la ultima region y recorre el ciclo al reves hasta volver a la barra.
      const reversed = [...order.slice(0, -1).reverse(), order[order.length - 1]];
      expect(backward, "Mayus+F6").toEqual([...reversed, ...reversed, reversed[0]]);
    });

    test("tambien dentro de un modo (Editar): el foco va a la region del modo, no a <body>", async ({ page }) => {
      await presetPrefs(page, cell);
      await page.goto("/pdf-pro");
      await openDocument(page, await buildSuiteDoc());
      await goTab(page, makeEnv(cell), "edit");
      await expect(page.locator("[data-pro-mode-host]")).toBeVisible();
      await expect(page.locator('[data-render-state="ready"]').first()).toBeVisible({ timeout: 30_000 });
      await page.locator('[data-pro-region="top"] h1').focus();
      const visited = await pressF6(page, 6, false);
      expect(visited.filter((region) => region === "<body>" || region.startsWith("?")), `regiones: ${visited.join(" → ")}`).toEqual([]);
      expect(new Set(visited).size, "al menos tres regiones distintas").toBeGreaterThanOrEqual(3);
      const back = await pressF6(page, 6, true);
      expect(back.filter((region) => region === "<body>" || region.startsWith("?")), `regiones (Mayus+F6): ${back.join(" → ")}`).toEqual([]);
    });
  });
}


/* ------------------------------------------------------------------ *
 * 5 · prefers-reduced-motion: reduce
 * ------------------------------------------------------------------ */

type MotionObservation = {
  transforms: string[];
  firstOpacity: string;
  finalOpacity: string;
  finalTop: number;
  cssBad: string[];
  transformAnimations: string[];
};

/**
 * Observa la hoja superior fotograma a fotograma mientras `trigger` la abre: su `transform` calculado, su opacidad, y al
 * final las transiciones y animaciones CSS de toda la hoja (con `reduce` ninguna puede mover `transform` mas de 0.05 s).
 */
async function observeSheet(page: Page, trigger: () => Promise<void>): Promise<MotionObservation> {
  const sampling = page.evaluate(
    () =>
      new Promise<MotionObservation>((resolve) => {
        const transforms = new Set<string>();
        let firstOpacity = "";
        let finalOpacity = "";
        let finalTop = 0;
        const started = performance.now();
        const tick = () => {
          const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
          const dialog = dialogs[dialogs.length - 1];
          if (dialog) {
            const style = getComputedStyle(dialog);
            transforms.add(style.transform);
            if (firstOpacity === "") firstOpacity = style.opacity;
            finalOpacity = style.opacity;
            finalTop = Math.round(dialog.getBoundingClientRect().top);
          }
          if (performance.now() - started < 1500) {
            requestAnimationFrame(tick);
            return;
          }
          const seconds = (value: string) =>
            Math.max(0, ...value.split(",").map((part) => (part.trim().endsWith("ms") ? parseFloat(part) / 1000 : parseFloat(part) || 0)));
          const cssBad: string[] = [];
          const root = dialog?.parentElement;
          for (const element of root ? [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))] : []) {
            const style = getComputedStyle(element);
            const movesTransform = /(^|,\s*)(all|transform|scale|translate|rotate)(\s*,|$)/.test(style.transitionProperty);
            if (movesTransform && seconds(style.transitionDuration) > 0.05) {
              cssBad.push(`${element.tagName.toLowerCase()} transition ${style.transitionProperty} ${style.transitionDuration}`);
            }
            if (style.animationName !== "none" && seconds(style.animationDuration) > 0.05) {
              cssBad.push(`${element.tagName.toLowerCase()} animation ${style.animationName} ${style.animationDuration}`);
            }
          }
          const transformAnimations = document
            .getAnimations()
            .filter((animation) => {
              const effect = animation.effect as KeyframeEffect | null;
              if (!effect || typeof effect.getKeyframes !== "function") return false;
              return effect.getKeyframes().some((frame) => ["transform", "translate", "scale", "rotate"].some((property) => property in frame));
            })
            .map((animation) => animation.constructor.name);
          resolve({ transforms: [...transforms], firstOpacity, finalOpacity, finalTop, cssBad, transformAnimations });
        };
        requestAnimationFrame(tick);
      }),
  );
  await trigger();
  return sampling;
}

const IDENTITY = new Set(["none", "matrix(1, 0, 0, 1, 0, 0)"]);

for (const width of [1280, 375] as const) {
  const cell: Cell = { theme: "light", language: "es", width };
  const mobile = width < 768;
  test.describe(`movimiento reducido · ${mobile ? "móvil 375 táctil" : "escritorio 1280"}`, () => {
    test.use({ ...cellOptions(cell), contextOptions: { reducedMotion: "reduce" } });
    test.setTimeout(120_000);

    test("abrir y cerrar hojas y menus funciona y ninguna hoja anima transform", async ({ page }) => {
      const env = makeEnv(cell);
      await presetPrefs(page, cell);
      await page.goto("/pdf-pro");
      await openDocument(page, await buildSuiteDoc());
      expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

      const triggers: Array<{ name: string; open: () => Promise<void> }> = [
        {
          name: "paleta de comandos",
          open: async () => {
            await page.keyboard.press("Control+k");
            await expect(page.getByRole("combobox")).toBeFocused();
          },
        },
        {
          name: "hoja «Atajos de teclado»",
          open: async () => {
            await viaMenu(page, env, "more", env.S.shell.shortcutsItem);
            await expect(page.getByRole("dialog")).toBeVisible();
          },
        },
        {
          name: "hoja «Guardar como…»",
          open: async () => {
            await viaMenu(page, env, mobile ? "more" : "save", env.S.save.saveAs);
            await expect(page.getByRole("dialog")).toBeVisible();
          },
        },
        {
          name: mobile ? "hoja de la herramienta (barra inferior)" : "hoja «Nuevo en blanco»",
          open: async () => {
            if (mobile) await goTab(page, env, "protect");
            else await viaMenu(page, env, "more", env.S.create.menu.newBlank);
            await expect(page.getByRole("dialog")).toBeVisible();
          },
        },
      ];
      for (const trigger of triggers) {
        await toBase(page, env, "doc");
        const observed = await observeSheet(page, trigger.open);
        const where = `${trigger.name}: ${JSON.stringify(observed)}`;
        expect(
          observed.transforms.filter((transform) => !IDENTITY.has(transform)),
          `transform animado en ${where}`,
        ).toEqual([]);
        expect(observed.cssBad, `transiciones o animaciones con transform > 0.05 s en ${where}`).toEqual([]);
        expect(observed.transformAnimations, `animaciones (Web Animations) de transform en ${where}`).toEqual([]);
        // Aparece visible y operable: sin desplazamiento, con un fundido que acaba en opacidad 1.
        expect(observed.finalOpacity, `la hoja acaba visible: ${where}`).toBe("1");
        expect(observed.finalTop, `la hoja esta dentro de la ventana: ${where}`).toBeGreaterThanOrEqual(0);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 4000 });
      }

      // Menus: se abren con el foco en la primera opcion, se recorren con flechas y Escape devuelve el foco al boton.
      // («Más acciones» en escritorio no se recorre con flechas: defecto A11Y-7, con su prueba aparte.)
      const trigger = page.getByRole("button", { name: mobile ? env.S.shell.more : env.S.save.menuLabel, exact: true });
      await trigger.click();
      const items = page.getByRole("menuitem");
      await expect(items.first()).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(items.nth(1)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    test("control: con movimiento normal la misma hoja SI anima transform (el detector no es ciego)", async ({ page }) => {
      const env = makeEnv(cell);
      await presetPrefs(page, cell);
      await page.goto("/pdf-pro");
      await openDocument(page, await buildSuiteDoc());
      await page.emulateMedia({ reducedMotion: "no-preference" });
      expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
      const observed = await observeSheet(page, async () => {
        await page.keyboard.press("Control+k");
        await expect(page.getByRole("combobox")).toBeFocused();
      });
      expect(observed.transforms.filter((transform) => !IDENTITY.has(transform)).length, `transforms observados: ${observed.transforms.length}`).toBeGreaterThan(5);
      await toBase(page, env, "doc");
    });
  });
}

/* ------------------------------------------------------------------ *
 * 6 · forced-colors: active
 * ------------------------------------------------------------------ */

type ForcedAudit = { controls: number; indistinct: string[] };

/**
 * Cada control visible debe distinguirse con los colores del sistema: borde, contorno o fondo propios, estar dentro de un
 * contenedor con borde o, si es solo texto/icono, tener contraste suficiente con el lienzo (mismo criterio que
 * `a11y-sweep.spec.ts`).
 */
async function forcedAudit(page: Page): Promise<ForcedAudit> {
  return page.evaluate(() => {
    const px = (value: string) => parseFloat(value) || 0;
    const visible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && element.closest(".sr-only") === null && element.closest("[inert]") === null;
    };
    const hasBorder = (style: CSSStyleDeclaration) =>
      (["Top", "Right", "Bottom", "Left"] as const).some((side) => px(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== "none");
    const hasOutline = (style: CSSStyleDeclaration) => px(style.outlineWidth) > 0 && style.outlineStyle !== "none";
    const canvas = getComputedStyle(document.body).backgroundColor;
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const context = probe.getContext("2d", { willReadFrequently: true })!;
    const rgb = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const luminance = (color: string) => {
      const [r, g, b] = rgb(color);
      const channel = (value: number) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (a: string, b: string) => {
      const la = luminance(a);
      const lb = luminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const borderedAncestor = (element: HTMLElement) => {
      let parent = element.parentElement;
      for (let i = 0; parent && i < 4; i += 1, parent = parent.parentElement) if (hasBorder(getComputedStyle(parent))) return true;
      return false;
    };
    const out: ForcedAudit = { controls: 0, indistinct: [] };
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('button, [role="tab"], [role="radio"], [role="switch"], [role="menuitem"], input, select'))) {
      if (!visible(element)) continue;
      out.controls += 1;
      const style = getComputedStyle(element);
      const inner = element.querySelector('[class*="border"], [class*="ring"]');
      const own =
        hasBorder(style) ||
        hasOutline(style) ||
        (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== canvas) ||
        (inner !== null && hasBorder(getComputedStyle(inner)));
      if (own || borderedAncestor(element)) continue;
      if (contrast(style.color, canvas) >= 4.5) continue;
      out.indistinct.push((element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 30));
    }
    return out;
  });
}

type ForcedFacts = { primaryBorder: string; selected: string; others: string[]; tabs: number };

async function forcedFacts(page: Page, mobile: boolean): Promise<ForcedFacts> {
  return page.evaluate((isMobile) => {
    const style = (element: Element | null) => (element ? getComputedStyle(element) : null);
    const primary = Array.from(document.querySelectorAll<HTMLElement>('[data-pro-region="top"] button')).find((button) => /\S/.test(button.textContent ?? "") && !button.matches("[aria-haspopup]"));
    const primaryStyle = style(primary ?? null);
    const border = primaryStyle ? `${primaryStyle.borderTopWidth} ${primaryStyle.borderTopStyle}` : "ninguno";
    if (isMobile) {
      const dock = Array.from(document.querySelectorAll<HTMLElement>("[data-dock]"));
      const active = dock.find((button) => button.getAttribute("aria-expanded") === "true");
      return { primaryBorder: border, selected: active ? (style(active)?.color ?? "") : "", others: dock.filter((button) => button !== active).map((button) => style(button)?.color ?? ""), tabs: dock.length };
    }
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"][data-tab]'));
    const indicator = (tab: Element) => style(tab.querySelector('span[aria-hidden="true"]'))?.backgroundColor ?? "";
    const selectedTab = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    return {
      primaryBorder: border,
      selected: selectedTab ? indicator(selectedTab) : "",
      others: tabs.filter((tab) => tab !== selectedTab).map((tab) => indicator(tab) || "sin indicador"),
      tabs: tabs.length,
    };
  }, mobile);
}

async function forcedCheck(page: Page, env: Env, state: StateDef): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (detail: string) => findings.push({ state: state.id, check: "forced", detail });
  expect(await page.evaluate(() => window.matchMedia("(forced-colors: active)").matches), "forced-colors activo").toBe(true);
  const audit = await forcedAudit(page);
  if (audit.controls === 0) add("no hay ningun control visible que comprobar");
  if (audit.indistinct.length > 0) add(`controles sin borde, contorno, fondo ni contraste propio: ${audit.indistinct.join(", ")}`);
  const overflow = await horizontalOverflow(page);
  if (overflow > 0) add(`la pagina desborda ${overflow}px en horizontal`);

  if (state.id === "doc" || state.id === "tab-home") {
    const facts = await forcedFacts(page, env.mobile);
    // El boton primario («Descargar») tiene borde propio: sin el seria un rectangulo de texto mas.
    if (!env.mobile && !/^[1-9]/.test(facts.primaryBorder)) add(`el boton primario no tiene borde: ${facts.primaryBorder}`);
    if (env.mobile ? state.id === "tab-home" : true) {
      if (facts.selected === "" || facts.selected === "rgba(0, 0, 0, 0)") add(`la pestaña elegida no se distingue (${facts.selected || "sin indicador"})`);
      if (facts.others.some((other) => other === facts.selected)) add(`hay pestañas sin elegir con el mismo aspecto que la elegida: ${facts.selected}`);
      if (facts.tabs !== 7) add(`se esperaban 7 pestañas y hay ${facts.tabs}`);
    }
  }
  return findings;
}

const FORCED_STATES = ["empty", "doc", "tab-home", "tab-pages", "tab-protect", "convert-options", "palette", "menu-more", "sheet-save-as", "tab-edit"] as const;

for (const width of [1280, 375] as const) {
  const cell: Cell = { theme: "dark", language: "es", width };
  const mobile = width < 768;
  test.describe(`colores forzados · ${mobile ? "móvil 375 táctil" : "escritorio 1280"}`, () => {
    test.use({ ...cellOptions(cell), contextOptions: { forcedColors: "active" } });
    test.setTimeout(300_000);

    test("controles distinguibles, pestaña elegida y boton primario visibles y sin desborde", async ({ page }) => {
      const env = makeEnv(cell);
      await presetPrefs(page, cell);
      const { findings, visited } = await sweep(page, env, FORCED_STATES, forcedCheck);
      expect(visited.length, `estados revisados: ${visited.join(", ")}`).toBeGreaterThanOrEqual(mobile ? 9 : 8);
      expect(findings.map(formatFinding)).toEqual([]);
    });

    test("el foco sigue visible: cada parada del teclado tiene contorno del sistema", async ({ page }) => {
      await presetPrefs(page, cell);
      await page.goto("/pdf-pro");
      await openDocument(page, await buildSuiteDoc());
      const missing: string[] = [];
      for (let i = 0; i < 45; i += 1) {
        await page.keyboard.press("Tab");
        const facts = await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          if (!active || active === document.body) return null;
          const style = getComputedStyle(active);
          return {
            name: `${active.tagName.toLowerCase()} ${(active.getAttribute("aria-label") ?? active.textContent ?? "").trim().slice(0, 28)}`,
            outline: `${style.outlineWidth} ${style.outlineStyle}`,
            visible: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1,
            programmatic: active.getAttribute("tabindex") === "-1",
          };
        });
        if (facts && !facts.programmatic && !facts.visible) missing.push(`${facts.name} (${facts.outline})`);
      }
      expect([...new Set(missing)], "paradas del teclado sin contorno de foco con colores forzados").toEqual([]);
    });
  });
}


/* ------------------------------------------------------------------ *
 * 7 · Estados :hover (contraste al pasar el raton)
 * ------------------------------------------------------------------ */

async function hoverCheck(page: Page, _env: Env, state: StateDef): Promise<Finding[]> {
  await ensureAxe(page);
  const count = await page.evaluate(() => {
    const scope = document.querySelector("section[data-pro-suite]") ?? document.querySelector("main") ?? document.body;
    const candidates = Array.from(scope.querySelectorAll<HTMLElement>('button, a[href], [role="tab"], [role="menuitem"]')).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && element.closest('[hidden],[aria-hidden="true"],.sr-only') === null && getComputedStyle(element).visibility !== "hidden";
    });
    candidates.forEach((element, index) => element.setAttribute("data-hover-probe", String(index)));
    return candidates.length;
  });
  const findings: Finding[] = [];
  for (let index = 0; index < count; index += 1) {
    const target = page.locator(`[data-hover-probe="${index}"]`);
    try {
      await target.scrollIntoViewIfNeeded({ timeout: 2000 });
      await target.hover({ timeout: 2000 });
    } catch {
      continue; // tapado o fuera de pantalla: no se puede pasar el raton por encima
    }
    // Las transiciones de color duran ~120-200 ms: se mide el color ya asentado.
    await page.waitForTimeout(260);
    const result = await page.evaluate(async (probe) => {
      const axe = (window as unknown as { axe: AxeApi }).axe;
      const run = await axe.run({ include: [[`[data-hover-probe="${probe}"]`]] }, { runOnly: ["color-contrast"], resultTypes: ["violations"] });
      const element = document.querySelector<HTMLElement>(`[data-hover-probe="${probe}"]`);
      return {
        failing: run.violations.length > 0,
        name: (element?.getAttribute("aria-label") ?? element?.textContent ?? "").trim().slice(0, 40),
        glow: String(element?.className ?? "").includes("hover:text-glow"),
        summary: run.violations.flatMap((violation) => violation.nodes.map((node) => (node.failureSummary ?? "").split("\n")[1]?.trim() ?? "")).join(" ").slice(0, 160),
      };
    }, index);
    if (result.failing) {
      const detail = `«${result.name}»${result.glow ? " [hover:text-glow]" : ""}: ${result.summary}`;
      // Varias tarjetas repiten el mismo control: un solo hallazgo por texto.
      if (!findings.some((finding) => finding.detail === detail)) findings.push({ state: `hover:${state.id}`, check: "axe", rule: "color-contrast", detail });
    }
  }
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.querySelectorAll("[data-hover-probe]").forEach((element) => element.removeAttribute("data-hover-probe")));
  return findings;
}

for (const theme of ["light", "dark"] as const) {
  const cell: Cell = { theme, language: "es", width: 1280 };
  test.describe(`estados hover · ${cellLabel(cell)}`, () => {
    test.use(cellOptions(cell));
    test.setTimeout(300_000);

    test("los controles mantienen 4.5:1 al pasar el raton (vacio, Inicio, Páginas, Proteger y Convertir)", async ({ page }) => {
      const env = makeEnv(cell);
      await presetPrefs(page, cell);
      const { findings, visited } = await sweep(page, env, ["empty", "doc", "tab-pages", "tab-protect", "convert-all-options"], hoverCheck);
      expect(visited.length, `estados revisados: ${visited.join(", ")}`).toBe(5);
      const real = partitionFindings(findings, annotateTolerated);
      expect(real, `hallazgos con el raton encima:\n${real.join("\n")}`).toEqual([]);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 8 · Idioma: el selector real ES/EN y el detector de cadenas sin traducir
 * ------------------------------------------------------------------ */

test.describe("idioma ES/EN · selector de la barra lateral", () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: "es-ES", colorScheme: "light" });
  test.setTimeout(120_000);

  test("cambiar de idioma traduce toda la suite, sin claves ni palabras del otro idioma, y el detector no es ciego", async ({ page }) => {
    await page.goto("/pdf-pro");
    await expect(page.getByRole("heading", { level: 2, name: PRO_STRINGS.es.empty.title })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("es");

    // Control del detector: en la interfaz en español ve MUCHAS palabras españolas y ninguna inglesa ni clave suelta.
    const spanishUi = (await scanText(page)).text;
    expect(ownWords(spanishUi, "es"), "palabras españolas detectadas en la UI en español").toBeGreaterThanOrEqual(10);
    expect(foreignWords(spanishUi, "es"), "palabras inglesas en la UI en español").toEqual([]);
    expect(spanishUi.match(KEY_LIKE) ?? []).toEqual([]);
    // Y el detector de claves reconoce una clave de verdad.
    expect("rotulo docTools.runner.apply visible".match(KEY_LIKE)).toEqual(["docTools.runner.apply"]);
    expect("informe.pdf, optimuspdf.app y v1.2.3 no son claves".match(KEY_LIKE)).toBeNull();

    // Selector real de la barra lateral (visible desde 1024 px).
    const toggle = page.getByRole("group", { name: es.common.language }).getByRole("button", { name: "EN", exact: true });
    await toggle.click();
    await expect(page.getByRole("heading", { level: 2, name: PRO_STRINGS.en.empty.title })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");
    expect(await page.evaluate((key) => window.localStorage.getItem(key), LANGUAGE_STORAGE_KEY)).toBe("en");
    const englishUi = (await scanText(page)).text;
    expect(foreignWords(englishUi, "en"), "palabras españolas en la UI en ingles (estado vacio)").toEqual([]);
    expect(ownWords(englishUi, "en"), "palabras inglesas detectadas en la UI en ingles").toBeGreaterThanOrEqual(3);

    // Con un documento abierto: pestañas y barra en ingles; y al volver a ES, de nuevo en español.
    await openDocument(page, await buildSuiteDoc());
    await expect(page.getByRole("tab", { name: PRO_STRINGS.en.suite.tabs.home })).toBeVisible();
    await expect(page.getByRole("tab", { name: PRO_STRINGS.en.suite.tabs.convert })).toBeVisible();
    expect(foreignWords((await scanText(page)).text, "en"), "palabras españolas en la UI en ingles (documento abierto)").toEqual([]);
    await page.getByRole("group", { name: en.common.language }).getByRole("button", { name: "ES", exact: true }).click();
    await expect(page.getByRole("tab", { name: PRO_STRINGS.es.suite.tabs.home })).toBeVisible();
    expect(foreignWords((await scanText(page)).text, "es"), "palabras inglesas en la UI en español (documento abierto)").toEqual([]);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("es");
  });
});


/* ------------------------------------------------------------------ *
 * 9 · Menus: recorrido completo con el teclado
 * ------------------------------------------------------------------ */

const MENU_CASES = [
  { width: 1280, which: "save" },
  { width: 1280, which: "more" },
  { width: 375, which: "more" },
] as const;

for (const { width, which } of MENU_CASES) {
  const cell: Cell = { theme: "light", language: "es", width };
  test.describe(`menus con teclado · ${width === 375 ? "móvil 375 táctil" : "escritorio 1280"} · ${which === "save" ? "«Guardar y exportar»" : "«Más acciones»"}`, () => {
    test.use(cellOptions(cell));

    test("flechas, Inicio, Fin y Escape recorren todas las opciones visibles y devuelven el foco al boton", async ({ page }) => {
      const env = makeEnv(cell);
      await presetPrefs(page, cell);
      await page.goto("/pdf-pro");
      await openDocument(page, await buildSuiteDoc());
      const trigger = page.getByRole("button", { name: which === "save" ? env.S.save.menuLabel : env.S.shell.more, exact: true });
      // ArrowDown sobre el boton cerrado abre el menu (patron WAI-ARIA de boton de menu).
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menu")).toBeVisible();
      const items = page.locator('[role="menu"] [role^="menuitem"]:visible');
      const count = await items.count();
      expect(count, "opciones visibles del menu").toBeGreaterThanOrEqual(4);
      const label = (index: number) => items.nth(index).getAttribute("data-menu-item");
      const focusedId = () => page.evaluate(() => document.activeElement?.getAttribute("data-menu-item") ?? "<fuera>");
      expect(await focusedId(), "al abrir, el foco va a la primera opcion").toBe(await label(0));
      for (let i = 1; i < count; i += 1) {
        await page.keyboard.press("ArrowDown");
        expect(await focusedId(), `ArrowDown #${i}`).toBe(await label(i));
      }
      await page.keyboard.press("ArrowDown");
      expect(await focusedId(), "ArrowDown desde la ultima da la vuelta").toBe(await label(0));
      await page.keyboard.press("ArrowUp");
      expect(await focusedId(), "ArrowUp desde la primera va a la ultima").toBe(await label(count - 1));
      await page.keyboard.press("Home");
      expect(await focusedId(), "Inicio").toBe(await label(0));
      await page.keyboard.press("End");
      expect(await focusedId(), "Fin").toBe(await label(count - 1));
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  });
}

/* ------------------------------------------------------------------ *
 * 10 · Defectos de producto: repro minima de cada uno (A11Y-1 a A11Y-9 estan CORREGIDOS y corren siempre como regresion)
 * ------------------------------------------------------------------ */

test.describe("defecto de producto A11Y-9", () => {
  const cell: Cell = { theme: "light", language: "es", width: 375 };
  test.use(cellOptions(cell));

  test("A11Y-9 · en movil el foco por teclado del estado vacio queda tapado por la barra de navegacion inferior", async ({ page }) => {
    await presetPrefs(page, cell);
    await page.goto("/pdf-pro");
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    const walk = await tabWalk(page, 120);
    expect(walk.covered, "controles con foco tapados por la barra inferior").toEqual([]);
  });
});

const DEFECT_REPROS: ReadonlyArray<{ id: string; cell: Cell; states: readonly string[]; check?: (page: Page, env: Env, state: StateDef) => Promise<Finding[]> }> = [
  { id: "A11Y-1", cell: { theme: "light", language: "es", width: 1280 }, states: ["shortcuts"] },
  { id: "A11Y-2", cell: { theme: "light", language: "es", width: 1280 }, states: ["convert-all-options"], check: hoverCheck },
  { id: "A11Y-3", cell: { theme: "light", language: "es", width: 1280 }, states: ["tab-edit", "tab-annotate", "tab-sign", "tab-fill"] },
  { id: "A11Y-4", cell: { theme: "light", language: "es", width: 375 }, states: ["tab-pages"] },
  { id: "A11Y-5", cell: { theme: "light", language: "es", width: 375 }, states: ["sign-composer"] },
  { id: "A11Y-6", cell: { theme: "light", language: "es", width: 1280 }, states: ["doc-tool-watermark", "sign-composer"] },
  { id: "A11Y-8", cell: { theme: "light", language: "es", width: 320 }, states: ["empty"], check: reflowCheck },
  { id: "A11Y-10", cell: { theme: "light", language: "es", width: 375 }, states: ["tab-sign"], check: signClearControlsCheck },
  { id: "A11Y-10", cell: { theme: "light", language: "es", width: 320 }, states: ["tab-sign"], check: signClearControlsCheck },
];

for (const repro of DEFECT_REPROS) {
  const defect = KNOWN_DEFECTS.find((entry) => entry.id === repro.id)!;
  test.describe(`defecto de producto ${repro.id} · ${repro.cell.width} px`, () => {
    test.use(cellOptions(repro.cell));
    test.setTimeout(180_000);

    test(`${repro.id} · ${defect.summary.slice(0, 110)}…`, async ({ page }) => {
      const env = makeEnv(repro.cell);
      await presetPrefs(page, repro.cell);
      const { findings } = await sweep(page, env, repro.states, repro.check);
      expect(findings.filter((finding) => finding.check === "spec-error").map(formatFinding), "la repro no pudo ejecutarse").toEqual([]);
      const mine = findings.filter(defect.matches).map(formatFinding);
      expect(mine, `${defect.id}: ${defect.summary}`).toEqual([]);
    });
  });
}


/* ------------------------------------------------------------------ *
 * 11 · Hojas: el foco queda atrapado dentro y nunca cae a <body>
 * ------------------------------------------------------------------ */

async function trapCheck(page: Page, _env: Env, state: StateDef): Promise<Finding[]> {
  const findings: Finding[] = [];
  const outside = new Set<string>();
  const inspect = () =>
    page.evaluate(() => {
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
      const dialog = dialogs[dialogs.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!dialog || !active || active === document.body || active === document.documentElement) return "<body>";
      return dialog.contains(active) ? "" : `${active.tagName.toLowerCase()} ${(active.getAttribute("aria-label") ?? active.textContent ?? "").trim().slice(0, 28)}`;
    });
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const where = await inspect();
    if (where !== "") outside.add(`Tab #${i + 1}: ${where}`);
  }
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press("Shift+Tab");
    const where = await inspect();
    if (where !== "") outside.add(`Mayus+Tab #${i + 1}: ${where}`);
  }
  if (outside.size > 0) findings.push({ state: state.id, check: "trap", detail: `el foco sale de la hoja: ${[...outside].slice(0, 4).join(" | ")}` });
  return findings;
}

const TRAP_STATES = ["palette", "shortcuts", "sheet-save-as", "sheet-save-password", "sheet-new-blank", "sheet-new-images", "sheet-insert-html", "pages-blank-sheet", "sign-composer"] as const;

for (const width of [1280, 375] as const) {
  const cell: Cell = { theme: "light", language: "es", width };
  test.describe(`foco atrapado en las hojas · ${width === 375 ? "móvil 375 táctil" : "escritorio 1280"}`, () => {
    test.use(cellOptions(cell));
    test.setTimeout(240_000);

    test("Tab y Mayús+Tab dan vueltas dentro de cada hoja abierta y el foco no sale ni cae a <body>", async ({ page }) => {
      const env = makeEnv(cell);
      await presetPrefs(page, cell);
      const { findings, visited } = await sweep(page, env, TRAP_STATES, trapCheck);
      expect([...visited].sort(), "hojas revisadas").toEqual([...TRAP_STATES].sort());
      expect(findings.map(formatFinding)).toEqual([]);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 12 · Reflujo a 320 px (WCAG 1.4.10): sin desplazamiento horizontal
 * ------------------------------------------------------------------ */

async function reflowCheck(page: Page, _env: Env, state: StateDef): Promise<Finding[]> {
  const overflow = await horizontalOverflow(page);
  return overflow > 0 ? [{ state: state.id, check: "overflow", detail: `a 320 px la pagina desborda ${overflow}px en horizontal` }] : [];
}

/**
 * Firmar en movil: los dos botones de borrado de la barra del lienzo miden >= 44 px y, al llevarlos a la vista (lo que hace
 * el navegador al enfocarlos), quedan por encima de la paleta flotante en vez de detras de ella.
 */
async function signClearControlsCheck(page: Page, env: Env, state: StateDef): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const name of [env.SG.clearPageAll, env.SG.clearAllAll]) {
    const button = page.getByRole("button", { name, exact: true });
    if ((await button.count()) === 0) {
      findings.push({ state: state.id, check: "spec-error", detail: `no se encontro el boton «${name}»` });
      continue;
    }
    const probe = await button.evaluate((element, paletteLabel) => {
      const palette = document.querySelector<HTMLElement>(`[role="toolbar"][aria-label="${paletteLabel}"]`);
      const before = element.getBoundingClientRect();
      // Lo que hace el navegador al enfocar: situar el control respetando el `scroll-margin` (y el `scroll-padding`).
      element.scrollIntoView({ block: "end" });
      return new Promise<{ height: number; buttonBottom: number; paletteTop: number | null; fixed: boolean }>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const after = element.getBoundingClientRect();
            const box = palette?.getBoundingClientRect();
            resolve({
              height: Math.round(before.height),
              buttonBottom: Math.round(after.bottom),
              paletteTop: box ? Math.round(box.top) : null,
              fixed: palette ? getComputedStyle(palette).position === "fixed" : false,
            });
          }),
        ),
      );
    }, env.SG.paletteLabel);
    if (probe.height < 44) findings.push({ state: state.id, check: "touch", detail: `[${name}] button ${probe.height} px de alto (< 44)` });
    if (probe.fixed && probe.paletteTop !== null && probe.buttonBottom > probe.paletteTop) {
      findings.push({ state: state.id, check: "covered", detail: `[${name}] queda detras de la paleta flotante (base ${probe.buttonBottom} > tope de la paleta ${probe.paletteTop})` });
    }
  }
  return findings;
}

const REFLOW_STATES = ["empty", "empty-new-blank", "doc", "tab-home", "tab-pages", "tab-edit", "tab-sign", "tab-protect", "tab-convert", "convert-options", "palette", "menu-more", "sheet-save-as"] as const;

for (const language of ["es", "en"] as const) {
  test.describe(`reflujo a 320 px · ${language.toUpperCase()}`, () => {
    const cell: Cell = { theme: "light", language, width: 320 };
    test.use({ ...cellOptions(cell), viewport: { width: 320, height: 568 } });
    test.setTimeout(240_000);

    test("sin desplazamiento horizontal en los estados principales", async ({ page }) => {
      const env = makeEnv(cell);
      await presetPrefs(page, cell);
      const { findings, visited } = await sweep(page, env, REFLOW_STATES, reflowCheck);
      expect(visited.length, `estados revisados: ${visited.join(", ")}`).toBe(REFLOW_STATES.length);
      const real = partitionFindings(findings, annotateTolerated);
      expect(real, `hallazgos a 320 px:\n${real.join("\n")}`).toEqual([]);
    });
  });
}
