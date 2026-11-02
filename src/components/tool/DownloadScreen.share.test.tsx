import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadScreen } from "@/components/tool/DownloadScreen";
import { LanguageProvider, useI18n, type Language } from "@/lib/i18n";

/*
 * Plan B movil de la descarga: «Compartir o guardar…» (hoja de compartir del sistema). Solo con puntero grueso, solo si el navegador
 * puede compartir ESE archivo y solo si se le da el resultado (`blob`). jsdom no tiene `navigator.share`: se simula.
 */

const BLOB = new Blob(["datos"], { type: "image/jpeg" });

function mediaQueries(coarse: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: coarse && query.includes("pointer: coarse"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

function stubShare(impl: (data: ShareData) => Promise<void>) {
  const share = vi.fn(impl);
  Object.defineProperty(navigator, "share", { configurable: true, value: share });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  return share;
}

/** El idioma se guarda en memoria entre pruebas del mismo archivo: se fija con el propio selector de la aplicacion. */
function UseLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(language), [language, setLanguage]);
  return null;
}

function renderScreen(props: Partial<React.ComponentProps<typeof DownloadScreen>> = {}, language: Language = "es") {
  const onDownload = vi.fn();
  render(
    <LanguageProvider>
      <UseLanguage language={language} />
      <DownloadScreen slug="image-converter" filename="foto-convertida.jpg" size={5} onDownload={onDownload} onStartOver={() => {}} blob={BLOB} {...props} />
    </LanguageProvider>,
  );
  return { onDownload };
}

beforeEach(() => {
  mediaQueries(true);
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "canShare");
});

describe("DownloadScreen · hoja de compartir", () => {
  it("con tacto y soporte aparece el boton y comparte el archivo con su nombre y tipo", async () => {
    const share = stubShare(async () => {});
    const { onDownload } = renderScreen();
    const button = await screen.findByRole("button", { name: /Compartir o guardar/ });
    fireEvent.click(button);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const data = share.mock.calls[0][0];
    expect(data.files).toHaveLength(1);
    expect(data.files?.[0].name).toBe("foto-convertida.jpg");
    expect(data.files?.[0].type).toBe("image/jpeg");
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("cerrar la hoja sin elegir destino (AbortError) no descarga ni avisa", async () => {
    const share = stubShare(async () => {
      throw new DOMException("cancelado", "AbortError");
    });
    const { onDownload } = renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /Compartir o guardar/ }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(onDownload).not.toHaveBeenCalled();
    expect(screen.queryByText(/No se pudo abrir la hoja/)).toBeNull();
  });

  it("si el sistema la rechaza, el archivo se descarga y se explica", async () => {
    stubShare(async () => {
      throw new DOMException("no", "NotAllowedError");
    });
    const { onDownload } = renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /Compartir o guardar/ }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/No se pudo abrir la hoja de compartir; se ha descargado el archivo\./)).toBeTruthy();
  });

  it("en ingles", async () => {
    stubShare(async () => {});
    renderScreen({}, "en");
    expect(await screen.findByRole("button", { name: /Share or save/ })).toBeTruthy();
  });

  it("con raton (puntero fino) no hay boton aunque el navegador pueda compartir", async () => {
    mediaQueries(false);
    stubShare(async () => {});
    renderScreen();
    await screen.findByRole("button", { name: "Descargar" });
    expect(screen.queryByRole("button", { name: /Compartir o guardar/ })).toBeNull();
  });

  it("sin soporte de compartir, o sin el resultado, la pantalla es la de siempre", async () => {
    renderScreen();
    await screen.findByRole("button", { name: "Descargar" });
    expect(screen.queryByRole("button", { name: /Compartir o guardar/ })).toBeNull();
    stubShare(async () => {});
    renderScreen({ blob: undefined });
    expect(screen.queryByRole("button", { name: /Compartir o guardar/ })).toBeNull();
  });

  it("la frase bajo «Listo» se puede sustituir (un video no es «un documento»)", () => {
    renderScreen({ subtitle: "Tu video está preparado para descargar." });
    expect(screen.getByText("Tu video está preparado para descargar.")).toBeTruthy();
    expect(screen.queryByText("Tu documento está preparado para descargar.")).toBeNull();
  });
});
