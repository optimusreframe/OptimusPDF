import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  SIGNATURE_FONT_TIMEOUT_MS,
  SignatureComposer,
  signatureFontReady,
  withoutMetricFallbacks,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

/*
 * W6-C · N1. Caveat ya no se precarga en todas las paginas (`preload: false`),
 * asi que al guardar una firma escrita la fuente puede no haber llegado. Antes
 * `buildTyped` medía y dibujaba el canvas SIN esperar: la firma exportada usaba
 * la fuente de respaldo mientras la vista previa mostraba Caveat. Contrato:
 * el canvas exportado se mide y dibuja DESPUES de que la fuente este lista; si
 * no llega a tiempo se avisa (role=status) en vez de exportar en silencio.
 *
 * jsdom no tiene canvas ni `document.fonts`: ambos se simulan. La "fuente de
 * respaldo" mide 400 px de texto y Caveat 500, asi que el ancho exportado
 * delata con que fuente se dibujo.
 */
const strings = SIGN_STRINGS.es;
const FAMILY = "CaveatTest";
const CAVEAT_TEXT_WIDTH = 500;
const FALLBACK_TEXT_WIDTH = 400;
const TYPE_FONT_SIZE = 96;
const EXPORT_SCALE = 3;
const exportedWidth = (textWidth: number) => (textWidth + TYPE_FONT_SIZE) * EXPORT_SCALE;

type FakeFonts = {
  loaded: boolean;
  loadCalls: string[];
  release: () => void;
  fail: () => void;
};

let fonts: FakeFonts;
let drawnFonts: string[];
let saved: SignatureDraft | null;

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalMatchMedia = window.matchMedia;

function installFonts(initiallyLoaded: boolean): void {
  let resolveLoad: () => void = () => {};
  let rejectLoad: (error: Error) => void = () => {};
  const state: FakeFonts = {
    loaded: initiallyLoaded,
    loadCalls: [],
    release: () => {
      state.loaded = true;
      resolveLoad();
    },
    fail: () => rejectLoad(new Error("network")),
  };
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      // `check` dice si la fuente ya se puede usar sin caer al respaldo.
      check: (font: string) => (font.includes(FAMILY) ? state.loaded : true),
      load: (font: string) => {
        state.loadCalls.push(font);
        if (state.loaded || !font.includes(FAMILY)) return Promise.resolve([]);
        return new Promise<unknown[]>((resolve, reject) => {
          resolveLoad = () => resolve([]);
          rejectLoad = reject;
        });
      },
      ready: Promise.resolve(),
    },
  });
  fonts = state;
}

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  document.documentElement.style.setProperty("--font-caveat", `'${FAMILY}'`);
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    let font = "";
    const width = this.width;
    const height = this.height;
    return {
      get font() {
        return font;
      },
      set font(value: string) {
        font = value;
      },
      scale: () => {},
      clearRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      setLineDash: () => {},
      setTransform: () => {},
      fillStyle: "",
      textBaseline: "",
      measureText: () => ({
        width: font.includes(FAMILY) && fonts.loaded ? CAVEAT_TEXT_WIDTH : FALLBACK_TEXT_WIDTH,
      }),
      fillText: () => {
        drawnFonts.push(`${font} loaded=${fonts.loaded}`);
      },
      // Todo opaco: el recorte no quita nada y el tamaño exportado es el del lienzo.
      getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) }),
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = function toDataURL(this: HTMLCanvasElement) {
    return `data:image/png;${this.width}x${this.height}`;
  } as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  window.matchMedia = originalMatchMedia;
  document.documentElement.style.removeProperty("--font-caveat");
});

beforeEach(() => {
  drawnFonts = [];
  saved = null;
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as { fonts?: unknown }).fonts;
});

function openTyped(name = "Maria") {
  render(
    <LanguageProvider>
      <SignatureComposer
        open
        onClose={() => {}}
        onSave={(draft) => {
          saved = draft;
        }}
        strings={strings}
      />
    </LanguageProvider>,
  );
  fireEvent.click(screen.getByRole("tab", { name: strings.modeType }));
  fireEvent.change(document.getElementById("signature-typed") as HTMLInputElement, {
    target: { value: name },
  });
}

const saveButton = () => screen.getByRole("button", { name: strings.save });
const exportedSize = () => {
  const match = /(\d+)x(\d+)$/.exec(saved?.dataUrl ?? "");
  if (!match) throw new Error("no se guardo ninguna firma");
  return { width: Number(match[1]), height: Number(match[2]) };
};
const noticeText = () => document.querySelector("[data-font-notice]")?.textContent ?? "";
const notice = () => document.querySelector("[data-font-notice]") as HTMLElement;

describe("SignatureComposer — la firma escrita espera a su fuente (N1)", () => {
  it("fuente aun sin cargar al guardar: NO exporta con el respaldo; espera, mide y dibuja con Caveat", async () => {
    installFonts(false);
    openTyped();
    fireEvent.click(saveButton());

    // Mientras la fuente baja no se ha exportado nada y el boton avisa que espera.
    expect(saved).toBeNull();
    expect(drawnFonts).toEqual([]);
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    expect(saveButton().getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      fonts.release();
    });

    expect(drawnFonts).toHaveLength(1);
    expect(drawnFonts[0]).toContain(FAMILY);
    expect(drawnFonts[0]).toContain("loaded=true");
    // Las medidas (y por tanto el recorte) son las de Caveat, no las del respaldo.
    expect(exportedSize().width).toBe(exportedWidth(CAVEAT_TEXT_WIDTH));
    expect(exportedSize().width).not.toBe(exportedWidth(FALLBACK_TEXT_WIDTH));
  });

  it("fuente ya lista: guarda al instante (sin esperas) con las medidas de Caveat", () => {
    installFonts(true);
    openTyped();
    fireEvent.click(saveButton());
    expect(exportedSize().width).toBe(exportedWidth(CAVEAT_TEXT_WIDTH));
    expect(noticeText()).toBe("");
  });

  it("la firma retrasada y la de fuente cargada miden lo mismo", async () => {
    installFonts(true);
    openTyped("Ana Perez");
    fireEvent.click(saveButton());
    const reference = exportedSize();
    cleanup();

    saved = null;
    installFonts(false);
    openTyped("Ana Perez");
    fireEvent.click(saveButton());
    await act(async () => {
      fonts.release();
    });
    expect(exportedSize()).toEqual(reference);
  });

  it("precarga la fuente al abrir el compositor (no espera a la pulsacion de guardar)", () => {
    installFonts(false);
    render(
      <LanguageProvider>
        <SignatureComposer open onClose={() => {}} onSave={() => {}} strings={strings} />
      </LanguageProvider>,
    );
    expect(fonts.loadCalls.some((font) => font.includes(FAMILY))).toBe(true);
  });

  it("si la fuente no llega a tiempo avisa (role=status), no exporta en silencio y deja guardar tal cual al pulsar otra vez", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    installFonts(false);
    openTyped();
    fireEvent.click(saveButton());
    expect(saved).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(SIGNATURE_FONT_TIMEOUT_MS + 1);
    });

    expect(saved).toBeNull();
    expect(notice().getAttribute("role")).toBe("status");
    expect(notice().textContent).toMatch(/fuente de respaldo/);
    expect(saveButton().hasAttribute("disabled")).toBe(false);

    // Pulsar de nuevo acepta el respaldo, que es lo mismo que muestra la vista previa.
    fireEvent.click(saveButton());
    expect(exportedSize().width).toBe(exportedWidth(FALLBACK_TEXT_WIDTH));
  });

  it("si la carga de la fuente falla tambien avisa en vez de exportar", async () => {
    installFonts(false);
    openTyped();
    fireEvent.click(saveButton());
    await act(async () => {
      fonts.fail();
    });
    expect(saved).toBeNull();
    expect(notice().textContent).toMatch(/fuente de respaldo/);
  });

  it("editar el texto retira el aviso y vuelve a exigir la fuente", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    installFonts(false);
    openTyped();
    fireEvent.click(saveButton());
    await act(async () => {
      vi.advanceTimersByTime(SIGNATURE_FONT_TIMEOUT_MS + 1);
    });
    expect(noticeText()).not.toBe("");

    fireEvent.change(document.getElementById("signature-typed") as HTMLInputElement, {
      target: { value: "Maria L" },
    });
    expect(noticeText()).toBe("");
    fireEvent.click(saveButton());
    expect(saved).toBeNull(); // vuelve a esperar, no hereda la aceptacion anterior
  });

  it("los modos dibujar y subir no se ven afectados (sin espera de fuente)", () => {
    installFonts(false);
    render(
      <LanguageProvider>
        <SignatureComposer open onClose={() => {}} onSave={() => {}} strings={strings} />
      </LanguageProvider>,
    );
    fireEvent.click(saveButton());
    expect(screen.getByRole("alert").textContent).toBe(strings.emptyWarning);
    expect(saveButton().hasAttribute("disabled")).toBe(false);
  });
});

/*
 * Equipo sin Arial (Linux, Android, ChromeOS, el runner de CI): `next/font` declara junto a Caveat la cara de ajuste
 * de metricas «Caveat Fallback» (`src: local(Arial)`), que sin Arial queda en estado "error" para siempre y hace que
 * `document.fonts.check()` devuelva false para TODA la pila aunque Caveat este cargada. El aviso de «la fuente no
 * cargo» salia siempre. La disponibilidad se comprueba solo sobre las familias reales.
 */
describe("SignatureComposer — la cara de ajuste de metricas de next/font no cuenta como fuente de la firma", () => {
  const FAMILY_STACK = `'${FAMILY}', '${FAMILY} Fallback'`;

  function installFontsWithBrokenMetricFace(caveatLoaded: boolean): FakeFonts {
    let resolveLoad: () => void = () => {};
    // Mismo objeto que lee el lienzo simulado (`fonts.loaded`) para medir con Caveat o con el respaldo.
    const state: FakeFonts = {
      loaded: caveatLoaded,
      loadCalls: [],
      release: () => {
        state.loaded = true;
        resolveLoad();
      },
      fail: () => {},
    };
    fonts = state;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        // La cara «… Fallback» esta en error: cualquier pila que la nombre da false, este Caveat cargada o no.
        check: (font: string) => (font.includes("Fallback") ? false : font.includes(FAMILY) ? state.loaded : true),
        load: (font: string) => {
          if (font.includes("Fallback")) return Promise.reject(new Error("NetworkError"));
          if (state.loaded) return Promise.resolve([]);
          return new Promise<unknown[]>((resolve) => {
            resolveLoad = () => resolve([]);
          });
        },
        ready: Promise.resolve(),
      },
    });
    return state;
  }

  beforeEach(() => {
    document.documentElement.style.setProperty("--font-caveat", FAMILY_STACK);
  });
  afterEach(() => {
    document.documentElement.style.setProperty("--font-caveat", `'${FAMILY}'`);
  });

  it("withoutMetricFallbacks quita solo las familias «X Fallback» y respeta el resto", () => {
    expect(withoutMetricFallbacks('96px "Caveat", "Caveat Fallback", cursive')).toBe('96px "Caveat", cursive');
    expect(withoutMetricFallbacks("96px 'Caveat', 'Caveat Fallback'")).toBe("96px 'Caveat'");
    expect(withoutMetricFallbacks('12px "Segoe Script", "Bradley Hand", cursive')).toBe('12px "Segoe Script", "Bradley Hand", cursive');
    // Si solo hubiera esa cara no se deja la lista vacia.
    expect(withoutMetricFallbacks('96px "Caveat Fallback"')).toBe('96px "Caveat Fallback"');
    expect(withoutMetricFallbacks("cursive")).toBe("cursive");
  });

  it("Caveat cargada + cara de ajuste en error: la fuente se considera lista y se guarda al instante sin aviso", () => {
    installFontsWithBrokenMetricFace(true);
    openTyped();
    fireEvent.click(saveButton());
    expect(noticeText()).toBe("");
    expect(saved).not.toBeNull();
    expect(drawnFonts[0]).toContain(FAMILY);
  });

  it("Caveat aun sin cargar + cara de ajuste en error: SIGUE esperando y nunca exporta con el respaldo", async () => {
    const font = installFontsWithBrokenMetricFace(false);
    openTyped();
    fireEvent.click(saveButton());
    expect(saved).toBeNull();
    expect(drawnFonts).toEqual([]);
    expect(saveButton().getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      font.release();
    });
    expect(noticeText()).toBe("");
    expect(saved).not.toBeNull();
    expect(exportedSize().width).toBe(exportedWidth(CAVEAT_TEXT_WIDTH));
  });

  it("signatureFontReady: false si Caveat misma no esta (aunque la pila lleve la cara de ajuste)", () => {
    installFontsWithBrokenMetricFace(false);
    expect(signatureFontReady(`96px ${FAMILY_STACK}, cursive`, "Maria")).toBe(false);
    installFontsWithBrokenMetricFace(true);
    expect(signatureFontReady(`96px ${FAMILY_STACK}, cursive`, "Maria")).toBe(true);
  });
});
