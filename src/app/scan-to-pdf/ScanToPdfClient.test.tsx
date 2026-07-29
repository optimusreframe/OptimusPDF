import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DetectedQuad } from "@/lib/scan/documentDetection";
import { LanguageProvider, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { STRINGS } from "@/app/scan-to-pdf/strings";
import {
  ScanToPdfClient,
  canGenerate,
} from "@/app/scan-to-pdf/ScanToPdfClient";
import type { ScanCapture } from "@/app/scan-to-pdf/CaptureStrip";

/**
 * Lo que se comprueba aqui es el gate de generacion: mientras queda algun
 * paso asincrono por resolver sobre una captura (`pending`), el PDF no se
 * puede componer — si se compusiera, usaria la foto cruda y lo que
 * termine despues no llegaria nunca al resultado.
 *
 * Los dos pasos —enderezado por EXIF y deteccion de bordes— se sustituyen
 * por promesas que se resuelven a mano, que es la unica forma de mantener
 * una captura en `pending` de forma determinista (ambos motores reales
 * necesitan canvas y WASM del navegador).
 */
const detection = vi.hoisted(() => {
  let settle: (value: DetectedQuad | null) => void = () => {};
  let started = 0;
  return {
    reset() {
      settle = () => {};
      started = 0;
    },
    get started() {
      return started;
    },
    resolveWith(value: DetectedQuad | null) {
      settle(value);
    },
    detect: () =>
      new Promise<DetectedQuad | null>((resolve) => {
        started += 1;
        settle = resolve;
      }),
  };
});

/** Por defecto resuelve al instante; con `hold()` se queda colgado. */
const orientation = vi.hoisted(() => {
  let release: (() => void) | null = null;
  let holdNext = false;
  return {
    reset() {
      release = null;
      holdNext = false;
    },
    hold() {
      holdNext = true;
    },
    release() {
      release?.();
      release = null;
    },
    normalize: (source: Blob) => {
      if (!holdNext) return Promise.resolve(source);
      holdNext = false;
      return new Promise<Blob>((resolve) => {
        release = () => resolve(source);
      });
    },
  };
});

const scanToPdfMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/scan/documentDetection", () => ({
  preloadDocumentDetection: () => {},
  detectDocumentInBlob: () => detection.detect(),
}));

vi.mock("@/lib/pdf/scanToPdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/scanToPdf")>();
  return {
    ...actual,
    scanToPdf: scanToPdfMock,
    normalizeImageOrientation: (source: Blob) => orientation.normalize(source),
  };
});

const s = STRINGS.es;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");

  // Piezas que jsdom no trae y de las que depende esta pantalla.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  URL.createObjectURL ??= () => "blob:scan-test";
  URL.revokeObjectURL ??= () => {};
});

beforeEach(() => {
  scanToPdfMock.mockReset();
  detection.reset();
  orientation.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function photo(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], "pagina.png", {
    type: "image/png",
  });
}

function generateButtons(): HTMLButtonElement[] {
  return screen.getAllByRole("button", {
    name: s.generate,
  }) as HTMLButtonElement[];
}

function nativeInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[type="file"][capture]',
  );
  expect(input).not.toBeNull();
  return input!;
}

/** Añade una foto por el input de archivos del escenario de camara. */
async function addPhoto(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>(
    'input[type="file"]:not([capture])',
  );
  expect(input).not.toBeNull();
  fireEvent.change(input!, { target: { files: [photo()] } });
  await waitFor(() => expect(screen.getByAltText(`${s.captureAlt} 1`)).toBeTruthy());
}

function capture(overrides: Partial<ScanCapture> = {}): ScanCapture {
  return {
    id: "1",
    originalBlob: new Blob(),
    blob: new Blob(),
    url: "blob:x",
    corners: null,
    cornersSource: null,
    pending: false,
    ...overrides,
  };
}

describe("canGenerate — src/app/scan-to-pdf/ScanToPdfClient.tsx", () => {
  it("sin capturas, no se puede generar", () => {
    expect(canGenerate([])).toBe(false);
  });

  it("con una captura todavia en deteccion, no se puede generar", () => {
    expect(canGenerate([capture(), capture({ id: "2", pending: true })])).toBe(
      false,
    );
  });

  it("con todas las capturas resueltas, se puede generar", () => {
    expect(canGenerate([capture(), capture({ id: "2" })])).toBe(true);
  });
});

describe("ScanToPdfClient — src/app/scan-to-pdf/ScanToPdfClient.tsx", () => {
  it("no genera el PDF mientras el recorte automatico sigue en curso, y si lo hace en cuanto termina", async () => {
    scanToPdfMock.mockReturnValue(new Promise<Blob>(() => {}));

    const { container } = render(
      <LanguageProvider>
        <ScanToPdfClient />
      </LanguageProvider>,
    );

    await addPhoto(container);

    // La deteccion sigue viva: la captura esta `pending`.
    expect(screen.getByLabelText(s.cropping)).toBeTruthy();
    for (const button of generateButtons()) expect(button.disabled).toBe(true);

    for (const button of generateButtons()) fireEvent.click(button);
    expect(scanToPdfMock).not.toHaveBeenCalled();

    // Sin documento detectado: la captura queda sin recorte, pero resuelta.
    detection.resolveWith(null);
    await waitFor(() => expect(screen.queryByLabelText(s.cropping)).toBeNull());
    for (const button of generateButtons()) expect(button.disabled).toBe(false);

    fireEvent.click(generateButtons()[0]);
    expect(scanToPdfMock).toHaveBeenCalledTimes(1);
  });

  it("no genera el PDF mientras la foto importada se esta enderezando por su EXIF", async () => {
    scanToPdfMock.mockReturnValue(new Promise<Blob>(() => {}));
    orientation.hold();

    const { container } = render(
      <LanguageProvider>
        <ScanToPdfClient />
      </LanguageProvider>,
    );

    await addPhoto(container);

    // Antes se publicaba la captura solo despues del enderezado: hasta
    // entonces no habia nada `pending` y el boton quedaba abierto.
    expect(detection.started).toBe(0);
    expect(screen.getByLabelText(s.cropping)).toBeTruthy();
    for (const button of generateButtons()) expect(button.disabled).toBe(true);

    for (const button of generateButtons()) fireEvent.click(button);
    expect(scanToPdfMock).not.toHaveBeenCalled();

    // Enderezada, pero encadena con la deteccion: el gate sigue cerrado.
    orientation.release();
    await waitFor(() => expect(detection.started).toBe(1));
    expect(screen.getByLabelText(s.cropping)).toBeTruthy();
    for (const button of generateButtons()) expect(button.disabled).toBe(true);

    detection.resolveWith(null);
    await waitFor(() => expect(screen.queryByLabelText(s.cropping)).toBeNull());
    for (const button of generateButtons()) expect(button.disabled).toBe(false);
  });
});

/**
 * La rafaga existe porque abrir la app de Camara una vez por pagina es
 * demasiado lento: cada foto que vuelve tiene que reabrirla sola, y el
 * bucle solo lo corta "Terminar" —el `change` del input nunca avisa de un
 * "cancelar"—.
 */
describe("rafaga con la camara del sistema — src/app/scan-to-pdf/CameraStage.tsx", () => {
  it("reabre la camara tras cada foto y para al pulsar Terminar", async () => {
    const openCamera = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});

    const { container } = render(
      <LanguageProvider>
        <ScanToPdfClient />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: s.nativeCamera }));
    expect(openCamera).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(s.burstCount.replace("{count}", "0")),
    ).toBeTruthy();

    fireEvent.change(nativeInput(container), { target: { files: [photo()] } });
    await waitFor(() =>
      expect(screen.getByAltText(`${s.captureAlt} 1`)).toBeTruthy(),
    );
    expect(openCamera).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(s.burstCount.replace("{count}", "1")),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: s.burstDone }));
    expect(screen.queryByText(s.burstTitle)).toBeNull();

    // Fuera del modo, una foto tardia se guarda pero ya no reabre nada.
    fireEvent.change(nativeInput(container), { target: { files: [photo()] } });
    await waitFor(() =>
      expect(screen.getByAltText(`${s.captureAlt} 2`)).toBeTruthy(),
    );
    expect(openCamera).toHaveBeenCalledTimes(2);
  });
});
