import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DownloaderView } from "@/app/downloader/DownloaderView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { DOWNLOADER_PLATFORMS, getTool } from "@/lib/tools-registry";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

/** `/downloader`: honesta (por que no existe), nombra las plataformas, no promete fechas y ofrece alternativas locales. */

vi.mock("next/navigation", () => ({ usePathname: () => "/downloader" }));

function Lang({ code }: { code: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(code), [code, setLanguage]);
  return null;
}

function renderPage(language: Language) {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  return render(
    <LanguageProvider>
      <Lang code={language} />
      <DownloaderView />
    </LanguageProvider>,
  );
}

afterEach(cleanup);

describe("pagina /downloader", () => {
  for (const [code, dictionary] of [
    ["es", es],
    ["en", en],
  ] as const) {
    it(`(${code}) explica por que no esta disponible y que choca con la promesa local`, () => {
      renderPage(code);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(dictionary.tools.downloader.name);
      expect(screen.getByText(dictionary.downloaderPage.lead)).toBeTruthy();
      expect(screen.getByRole("heading", { level: 2, name: dictionary.downloaderPage.whyTitle })).toBeTruthy();
      expect(screen.getByText(dictionary.downloaderPage.whyBody)).toBeTruthy();
      expect(screen.getAllByText(dictionary.soon.badge).length).toBeGreaterThan(0);
    });

    it(`(${code}) nombra las seis plataformas y dice que ninguna esta disponible`, () => {
      renderPage(code);
      const list = screen.getByRole("heading", { name: dictionary.downloaderPage.platformsTitle }).closest("section")!;
      expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([...DOWNLOADER_PLATFORMS]);
      expect(within(list).getByText(dictionary.downloaderPage.platformsBody)).toBeTruthy();
      // las plataformas no son enlaces ni botones
      expect(within(list).queryAllByRole("link")).toHaveLength(0);
      expect(within(list).queryAllByRole("button")).toHaveLength(0);
    });
  }

  it("ofrece como tarjetas las alternativas locales (extraer audio, convertidores, escanear) con su ruta real", () => {
    renderPage("es");
    const section = screen.getByRole("heading", { name: es.downloaderPage.alternativesTitle }).closest("section")!;
    const hrefs = within(section).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs.sort()).toEqual(
      ["/audio-converter", "/audio-extractor", "/image-converter", "/scan-to-pdf", "/video-converter"].sort(),
    );
    // las disponibles van antes que las «Próximamente»
    const live = within(section).getAllByRole("link").map((a) => a.getAttribute("href")!.slice(1));
    const firstSoon = live.findIndex((slug) => getTool(slug as never).status === "soon");
    if (firstSoon >= 0) for (const slug of live.slice(firstSoon)) expect(getTool(slug as never).status).toBe("soon");
  });

  it("no promete fechas ni plazos", () => {
    renderPage("es");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\b(20\d\d|pronto estará|en breve|próxima semana|este mes|trimestre)\b/i);
    cleanup();
    renderPage("en");
    expect(document.body.textContent ?? "").not.toMatch(/\b(20\d\d|coming shortly|next week|this month|quarter)\b/i);
  });

  it("vuelve al catalogo", () => {
    renderPage("es");
    expect(screen.getByRole("link", { name: es.downloaderPage.back }).getAttribute("href")).toBe("/");
  });
});
