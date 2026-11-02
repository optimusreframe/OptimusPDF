import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Header } from "@/components/layout/Header";
import { MobileTabBar } from "@/components/layout/MobileTabBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { SECTIONS_STORAGE_KEY, resetSidebarSectionsForTests } from "@/components/layout/SidebarTree";
import { closeMobileMenu } from "@/components/layout/mobileMenu";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { THEME_STORAGE_KEY, ThemeProvider } from "@/lib/theme";
import { CATEGORY_ORDER, DOWNLOADER_PLATFORMS, GROUP_ORDER } from "@/lib/tools-registry";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

/**
 * Hoja del menu movil/tablet: mismo contenido y orden que la barra lateral, abierta desde la quinta pestaña de la barra
 * inferior o desde el boton «Menu» de la cabecera. El comportamiento de hoja (arrastre, velo, foco atrapado, bloqueo del
 * scroll) es el de `Sheet` y ya tiene sus pruebas; aqui se comprueba lo que esta pantalla anade.
 */

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

/** El idioma vive en un store con cache: se fija por el propio contexto. */
function Lang({ code }: { code: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(code), [code, setLanguage]);
  return null;
}

function renderChrome(language: Language = "es") {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  return render(
    <ThemeProvider>
      <LanguageProvider>
        <Lang code={language} />
        <Sidebar />
        <Header />
        <MobileTabBar />
      </LanguageProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  pathname = "/";
  window.sessionStorage.clear();
  window.localStorage.removeItem("optimuspdf.sidebarCollapsed");
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  resetSidebarSectionsForTests();
});

afterEach(() => {
  act(() => closeMobileMenu());
  cleanup();
});

/** Los dos disparadores: la pestaña (movil) y el boton de la cabecera (tablet). Se distinguen por su contenedor. */
const triggers = (label: string = es.nav.menu) => screen.getAllByRole("button", { name: label });
const tabTrigger = (label?: string) => triggers(label).find((button) => button.closest("[data-chrome='tabbar']"))!;
const headerTrigger = (label?: string) => triggers(label).find((button) => button.closest("header"))!;

async function openFromTab(label?: string): Promise<HTMLElement> {
  const trigger = tabTrigger(label);
  trigger.focus();
  fireEvent.click(trigger);
  return screen.findByRole("dialog");
}

const menuNav = (dialog: HTMLElement, label: string = es.nav.menu) => within(dialog).getByRole("navigation", { name: label });
const sidebarNav = () => document.querySelector("aside nav") as HTMLElement;

describe("disparadores del menu", () => {
  it("la barra inferior tiene cinco pestañas: cuatro enlaces y «Menú» como BOTON (no es una pagina)", () => {
    renderChrome();
    const bar = document.querySelector("[data-chrome='tabbar']") as HTMLElement;
    const items = Array.from(bar.querySelectorAll("li > a, li > button"));
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.tagName)).toEqual(["A", "A", "A", "A", "BUTTON"]);
    expect(items.map((item) => item.textContent)).toEqual([es.nav.home, es.nav.documents, es.nav.recent, es.nav.settings, es.nav.menu]);
    expect(items.slice(0, 4).map((item) => item.getAttribute("href"))).toEqual(["/", "/documents", "/recent", "/settings"]);
  });

  it("cerrada: aria-expanded=false, anuncia que abre un dialogo y NO lleva aria-controls (nada controlado todavia)", () => {
    renderChrome();
    for (const trigger of [tabTrigger(), headerTrigger()]) {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
      expect(trigger.hasAttribute("aria-controls")).toBe(false);
    }
  });

  it("abierta: aria-expanded=true y aria-controls apunta a un id que EXISTE dentro del dialogo", async () => {
    renderChrome();
    const dialog = await openFromTab();
    for (const trigger of [tabTrigger(), headerTrigger()]) {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      const id = trigger.getAttribute("aria-controls")!;
      expect(id).toBeTruthy();
      expect(dialog.contains(document.getElementById(id))).toBe(true);
    }
  });

  it("el boton de la cabecera abre la misma hoja", async () => {
    renderChrome();
    fireEvent.click(headerTrigger());
    const dialog = await screen.findByRole("dialog", { name: es.nav.menu });
    expect(within(dialog).getByRole("heading", { name: es.nav.menu })).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("los dos botones llevan icono y etiqueta visible (no solo icono)", () => {
    renderChrome();
    for (const trigger of [tabTrigger(), headerTrigger()]) {
      expect(trigger.textContent).toBe(es.nav.menu);
      expect(trigger.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    }
  });
});

describe("contenido: el mismo que la barra lateral, en el mismo orden", () => {
  it("la secuencia de enlaces y de desplegables es identica a la de la barra lateral", async () => {
    renderChrome();
    const dialog = await openFromTab();
    const sequence = (root: HTMLElement) =>
      Array.from(root.querySelectorAll("a[href], button[aria-expanded]")).map((node) =>
        node.tagName === "A" ? `a:${node.getAttribute("href")}` : `button:${node.getAttribute("aria-label")}`,
      );
    expect(sequence(menuNav(dialog))).toEqual(sequence(sidebarNav()));
  });

  it("arriba Inicio, Recientes y PDF Pro; debajo Documentos y Ajustes; al final Precios, Proyecto y Licencias", async () => {
    renderChrome();
    const hrefs = Array.from((menuNav(await openFromTab())).querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
    expect(hrefs.slice(0, 3)).toEqual(["/", "/recent", "/pdf-pro"]);
    expect(hrefs.slice(-5)).toEqual(["/documents", "/settings", "/pricing", "/about", "/licenses"]);
    // Las cuatro entradas nuevas de la barra lateral tambien son enlaces y, sin elegir seccion, no hay ningun desplegable abierto.
    expect(within(menuNav(await screen.findByRole("dialog"))).getByRole("link", { name: es.nav.licenses }).getAttribute("href")).toBe("/licenses");
  });

  it("las tres suites, en orden, con sus seis categorias y tres grupos como desplegables cerrados", async () => {
    renderChrome();
    const nav = menuNav(await openFromTab());
    const suites = [es.suites.pdf.label, es.suites.scan.label, es.suites.tools.label];
    const lists = suites.map((label) => within(nav).getByRole("list", { name: label }));
    expect(lists[0].compareDocumentPosition(lists[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lists[1].compareDocumentPosition(lists[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const id of [...CATEGORY_ORDER, ...GROUP_ORDER]) {
      const label = id in es.categories ? es.categories[id as keyof typeof es.categories].label : es.groups[id as keyof typeof es.groups].label;
      const toggle = within(nav).getByRole("button", { name: `${es.nav.toggleSection} ${label}` });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.hasAttribute("aria-controls")).toBe(false);
    }
  });

  it("Escanear a PDF es un enlace directo de OptimusSCAN y el Downloader es «Pronto»", async () => {
    renderChrome();
    const nav = menuNav(await openFromTab());
    const scan = within(within(nav).getByRole("list", { name: es.suites.scan.label })).getByRole("link", { name: es.tools["scan-to-pdf"].name });
    expect(scan.getAttribute("href")).toBe("/scan-to-pdf");
    expect(nav.querySelector("a[href='/#downloader']")!.textContent).toContain(es.nav.soonShort);
  });

  it("las plataformas del Downloader son entradas DESHABILITADAS: sin enlace ni foco, con «Pronto»; «Próximamente…» es una nota", async () => {
    renderChrome();
    const nav = menuNav(await openFromTab());
    fireEvent.click(within(nav).getByRole("button", { name: `${es.nav.toggleSection} ${es.groups.downloader.label}` }));
    for (const name of DOWNLOADER_PLATFORMS) {
      const entry = within(nav).getByText(name).closest("[aria-disabled]") as HTMLElement;
      expect(entry.getAttribute("aria-disabled")).toBe("true");
      expect(entry.closest("a[href]")).toBeNull();
      expect(entry.hasAttribute("tabindex")).toBe(false);
      expect(entry.textContent).toContain(es.nav.soonShort);
    }
    const more = within(nav).getByText(es.nav.moreSoon);
    expect(more.closest("a, button")).toBeNull();
  });

  it("desplegar una seccion escribe la misma eleccion que la barra lateral (SECTIONS_STORAGE_KEY) y la hoja la respeta al reabrirse", async () => {
    renderChrome();
    const label = `${es.nav.toggleSection} ${es.categories.security.label}`;
    let nav = menuNav(await openFromTab());
    fireEvent.click(within(nav).getByRole("button", { name: label }));
    expect(JSON.parse(window.sessionStorage.getItem(SECTIONS_STORAGE_KEY)!)).toEqual({ security: true });
    expect(within(nav).getByRole("link", { name: es.tools["protect-pdf"].name })).toBeTruthy();
    act(() => closeMobileMenu());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    nav = menuNav(await openFromTab());
    expect(within(nav).getByRole("button", { name: label }).getAttribute("aria-expanded")).toBe("true");
  });

  it("al pie: idioma ES/EN y tema Claro/Oscuro/Sistema, y el aviso de que todo es local", async () => {
    renderChrome();
    const dialog = await openFromTab();
    expect(within(dialog).getByRole("group", { name: es.common.language })).toBeTruthy();
    const tabs = within(within(dialog).getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([es.common.light, es.common.dark, es.common.system]);
    expect(within(dialog).getByText(es.common.localAndZeroUploads)).toBeTruthy();
  });

  it("cambiar idioma desde la hoja traduce la propia hoja y persiste; cambiar tema persiste", async () => {
    renderChrome();
    const dialog = await openFromTab();
    fireEvent.click(within(dialog).getByRole("button", { name: "EN" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: en.nav.menu })).toBeTruthy());
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
    const nav = menuNav(screen.getByRole("dialog"), en.nav.menu);
    expect(within(nav).getByRole("link", { name: en.nav.licenses }).getAttribute("href")).toBe("/licenses");
    expect(within(nav).getByRole("link", { name: en.nav.home })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("tab", { name: en.common.light }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("en ingles: «Menu», «Close menu» y «Licenses»", async () => {
    renderChrome("en");
    await waitFor(() => expect(tabTrigger(en.nav.menu)).toBeTruthy());
    fireEvent.click(tabTrigger(en.nav.menu));
    const dialog = await screen.findByRole("dialog", { name: en.nav.menu });
    expect(within(dialog).getByRole("button", { name: en.nav.closeMenu })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: en.nav.licenses })).toBeTruthy();
  });

  it("la entrada de la pagina actual se marca como actual (aria-current)", async () => {
    pathname = "/merge-pdf";
    renderChrome();
    const nav = menuNav(await openFromTab());
    expect(within(nav).getByRole("link", { name: es.tools["merge-pdf"].name }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: es.nav.home }).getAttribute("aria-current")).toBeNull();
  });
});

describe("buscador de la hoja", () => {
  it("filtra con el mismo criterio que la barra (sin tildes ni mayusculas) y sustituye al arbol mientras hay texto", async () => {
    renderChrome();
    const dialog = await openFromTab();
    const search = within(dialog).getByRole("searchbox", { name: es.nav.searchPlaceholder });
    fireEvent.change(search, { target: { value: "ESCANEAR" } });
    const nav = menuNav(dialog);
    expect(within(nav).getByRole("status").textContent).toBe(`1 ${es.home.resultOne}`);
    const list = within(nav).getByRole("list", { name: es.nav.searchResults });
    expect(within(list).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/scan-to-pdf"]);
    expect(within(nav).queryByRole("button", { name: /Mostrar u ocultar/ })).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(within(nav).getAllByRole("button", { name: /Mostrar u ocultar/ }).length).toBeGreaterThan(0);
  });

  it("sin coincidencias dice «Sin resultados» y no deja una lista vacia", async () => {
    renderChrome();
    const dialog = await openFromTab();
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "zzzzqq" } });
    expect(within(menuNav(dialog)).getByRole("status").textContent).toBe(es.nav.searchEmpty);
    expect(within(dialog).queryByRole("list", { name: es.nav.searchResults })).toBeNull();
  });

  it("Escape con texto lo borra y NO cierra la hoja; con el campo vacio, si", async () => {
    renderChrome();
    const dialog = await openFromTab();
    const search = within(dialog).getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "unir" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("elegir un resultado cierra la hoja", async () => {
    renderChrome();
    const dialog = await openFromTab();
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "unir" } });
    fireEvent.click(within(menuNav(dialog)).getByRole("link", { name: es.tools["merge-pdf"].name }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("cierre, foco y fondo", () => {
  it("Escape cierra y el foco vuelve al disparador", async () => {
    renderChrome();
    const trigger = tabTrigger();
    await openFromTab();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("Safari no da foco a un boton al pulsarlo: el foco vuelve igualmente al disparador", async () => {
    renderChrome();
    const trigger = tabTrigger();
    fireEvent.click(trigger); // sin `.focus()`: tras el clic el foco sigue en <body>, como en Safari
    expect(document.activeElement).not.toBe(trigger);
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("la X y el velo cierran; el foco vuelve al disparador que abrio", async () => {
    renderChrome();
    const trigger = headerTrigger();
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: es.nav.closeMenu }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);

    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(document.querySelector("[data-sheet-scrim]")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("pulsar un enlace cierra la hoja", async () => {
    renderChrome();
    const nav = menuNav(await openFromTab());
    fireEvent.click(within(nav).getByRole("link", { name: es.nav.settings }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("pulsar una categoria (ancla de Inicio) tambien cierra la hoja", async () => {
    renderChrome();
    const nav = menuNav(await openFromTab());
    fireEvent.click(nav.querySelector("a[href='/#organize']")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cambiar de ruta (Atras/Adelante del navegador) cierra la hoja sin tocar el historial", async () => {
    const before = window.history.length;
    const view = renderChrome();
    await openFromTab();
    expect(window.history.length).toBe(before);
    pathname = "/pricing";
    view.rerender(
      <ThemeProvider>
        <LanguageProvider>
          <Lang code="es" />
          <Sidebar />
          <Header />
          <MobileTabBar />
        </LanguageProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.history.length).toBe(before);
  });

  it("mientras esta abierta el resto de la pagina es inert y el scroll del fondo esta bloqueado; todo vuelve al cerrar", async () => {
    const view = renderChrome();
    const trigger = tabTrigger();
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(view.container.hasAttribute("inert")).toBe(true));
    expect(dialog.closest("[inert]")).toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
    act(() => closeMobileMenu());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.container.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("el foco queda atrapado: Tab desde el ultimo control vuelve al primero y Mayus+Tab desde el primero va al ultimo", async () => {
    renderChrome();
    const dialog = await openFromTab();
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])"),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("al abrirse el foco entra en la hoja (el propio dialogo: no se abre el teclado del telefono)", async () => {
    renderChrome();
    const dialog = await openFromTab();
    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });

  it("el dialogo se llama «Menú» (lo que anuncia un lector de pantalla) y la X tiene nombre propio", async () => {
    renderChrome();
    const dialog = await openFromTab();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe(es.nav.menu);
    expect(within(dialog).getByRole("button", { name: es.nav.closeMenu })).toBeTruthy();
  });
});

describe("misma estructura que la barra lateral: solo el escritorio la muestra", () => {
  it("la barra lateral sigue teniendo su pie con Precios, Proyecto y Licencias", () => {
    renderChrome();
    const links = Array.from(sidebarNav().querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
    expect(links.slice(-3)).toEqual(["/pricing", "/about", "/licenses"]);
  });
});
