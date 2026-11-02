import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { AboutLicensesCard, LicensesView } from "@/app/licenses/LicensesView";
import { LAME } from "@/app/licenses/lame";
import { PACKAGES } from "@/app/licenses/packages";
import { STRINGS } from "@/app/licenses/strings";

/** Pagina de licencias: cada dependencia de ejecucion aparece, con su version y licencia; el aviso de LAME y los enlaces al codigo existen en ES y EN. */

beforeAll(() => window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es"));
afterEach(cleanup);

function UseLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => {
    setLanguage(language);
  }, [language, setLanguage]);
  return null;
}

function renderPage(language: Language, node = <LicensesView />) {
  return render(
    <LanguageProvider>
      <UseLanguage language={language} />
      {node}
    </LanguageProvider>,
  );
}

describe.each(["es", "en"] as const)("LicensesView (%s)", (language) => {
  const s = STRINGS[language];

  it("un titulo (h1), las secciones en h2 y el MP3 con ancla #mp3", async () => {
    renderPage(language);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(s.title);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([s.mp3.title, s.packagesTitle, s.assetsTitle, s.modelsTitle, s.contactTitle]);
    expect(document.getElementById("mp3")?.getAttribute("aria-labelledby")).toBe("mp3-title");
  });

  it("lista CADA dependencia de ejecucion con su version y licencia, y su para-que-se-usa", async () => {
    renderPage(language);
    await screen.findByRole("heading", { level: 1 });
    const cards = Array.from(document.querySelectorAll("[data-packages] > li"));
    expect(cards).toHaveLength(PACKAGES.length);
    for (const entry of PACKAGES) {
      const card = document.querySelector(`[data-package="${CSS.escape(entry.name)}"]`) as HTMLElement;
      expect(card, entry.name).not.toBeNull();
      expect(within(card).getByRole("heading", { level: 3 }).textContent).toBe(entry.name);
      expect(card.textContent).toContain(`v${entry.version}`);
      expect(card.textContent).toContain(entry.license);
      expect(card.textContent).toContain(s.purposes[entry.name]);
      const hrefs = within(card).getAllByRole("link").map((a) => a.getAttribute("href"));
      expect(hrefs).toContain(entry.repo);
      expect(hrefs.some((href) => href?.startsWith("https://www.npmjs.com/package/"))).toBe(true);
    }
    // jszip ofrece MIT o GPL: la pagina dice cual se usa. parse5 corre en el servidor.
    expect((document.querySelector('[data-package="jszip"]') as HTMLElement).textContent).toContain(language === "es" ? "se usa bajo MIT" : "used under MIT");
    expect((document.querySelector('[data-package="parse5"]') as HTMLElement).textContent).toContain(s.fields.onServer);
    expect(document.querySelectorAll("[data-package]:not([data-package=parse5])").length).toBe(PACKAGES.length - 1);
  });

  it("el aviso «MP3 encoding by LAME» va en ingles, con enlace a lame.sourceforge.io", async () => {
    renderPage(language);
    await screen.findByRole("heading", { level: 1 });
    const notice = document.querySelector("[data-lame-notice]") as HTMLElement;
    const line = notice.querySelector("p[lang=en]") as HTMLElement;
    expect(line.textContent?.replace(/\s*\(opens in a new tab\)/, "")).toBe(LAME.notice);
    const link = within(notice).getByRole("link", { name: /LAME/ });
    expect(link.getAttribute("href")).toBe("https://lame.sourceforge.io/");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("MP3: tres componentes con version exacta, cumplimiento de MPL-2.0 y LGPL, codigo fuente por version exacta y como sustituir LAME", async () => {
    renderPage(language);
    await screen.findByRole("heading", { level: 1 });
    const section = document.getElementById("mp3") as HTMLElement;
    expect(Array.from(section.querySelectorAll("[data-mp3-component]")).map((li) => li.getAttribute("data-mp3-component"))).toEqual(["mediabunny", "@mediabunny/mp3-encoder", "LAME"]);
    expect((section.querySelector('[data-mp3-component="mediabunny"]') as HTMLElement).textContent).toMatch(/v1\.65\.0.*MPL-2\.0/);
    expect((section.querySelector('[data-mp3-component="@mediabunny/mp3-encoder"]') as HTMLElement).textContent).toMatch(/v1\.65\.0.*MPL-2\.0/);
    expect((section.querySelector('[data-mp3-component="LAME"]') as HTMLElement).textContent).toContain(`v${LAME.version}`);
    expect((section.querySelector('[data-mp3-component="LAME"]') as HTMLElement).textContent).toContain(s.mp3.lameLicense);

    const hrefs = within(section).getAllByRole("link").map((a) => a.getAttribute("href"));
    for (const expected of [
      "https://github.com/Vanilagy/mediabunny/tree/v1.65.0",
      "https://github.com/Vanilagy/mediabunny/tree/v1.65.0/packages/mp3-encoder",
      "https://www.npmjs.com/package/mediabunny/v/1.65.0",
      "https://www.npmjs.com/package/@mediabunny/mp3-encoder/v/1.65.0",
      "https://registry.npmjs.org/@mediabunny/mp3-encoder/-/mp3-encoder-1.65.0.tgz",
      LAME.site,
      LAME.sourceUrl,
      "https://www.mozilla.org/en-US/MPL/2.0/",
      "https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html",
      "https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html",
    ]) {
      expect(hrefs, expected).toContain(expected);
    }
    // Sin marcas de plantilla sin rellenar y con los hashes verificables a la vista.
    expect(section.textContent).not.toMatch(/\{\w+\}/);
    expect(section.textContent).toContain(LAME.wasmSha256);
    expect(section.textContent).toContain(LAME.tarballSha256);
    expect(section.textContent).toContain(`Emscripten ${LAME.emscripten}`);
    expect(section.textContent).toContain(s.mp3.replaceTitle);
  });

  it("todo enlace externo se abre en otra pestana con rel seguro y avisa de ello a los lectores de pantalla; ninguno pega textos largos de licencia", async () => {
    const { container } = renderPage(language);
    await screen.findByRole("heading", { level: 1 });
    const external = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="http"]'));
    expect(external.length).toBeGreaterThan(80);
    for (const a of external) {
      expect(a.getAttribute("target"), a.href).toBe("_blank");
      expect(a.getAttribute("rel"), a.href).toBe("noopener noreferrer");
      expect(a.querySelector(".sr-only")?.textContent, a.href).toMatch(/pestaña|new tab/);
    }
    expect(container.textContent?.length ?? 0).toBeLessThan(40_000);
  });

  it("las fuentes y decodificadores incluidos se listan con su licencia y la pagina no promete mas: modelos fuera", async () => {
    renderPage(language);
    await screen.findByRole("heading", { level: 1 });
    const assets = Array.from(document.querySelectorAll("[data-assets] > li"));
    expect(assets).toHaveLength(s.assets.length);
    for (const asset of s.assets) expect(document.querySelector("[data-assets]")?.textContent).toContain(asset.license);
    expect(screen.getByRole("link", { name: s.modelsLinkLabel }).getAttribute("href")).toBe("/privacy");
  });
});

describe("AboutLicensesCard", () => {
  it.each(["es", "en"] as const)("enlaza a /licenses (%s)", async (language) => {
    renderPage(language, <AboutLicensesCard />);
    const link = await screen.findByRole("link", { name: STRINGS[language].aboutLinkLabel });
    expect(link.getAttribute("href")).toBe("/licenses");
  });
});
