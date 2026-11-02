import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import type { PcmAudio } from "@/lib/media/audio/types";
import { audioOf, monoSine, sine } from "@/lib/media/audio/testAudio";
import { AudioStudioClient } from "@/app/audio-studio/AudioStudioClient";

/**
 * Editor de punta a punta en jsdom: `decodeMedia` se sustituye por audio sintetico (senos) y la exportacion a WAV es la
 * REAL. Reproduccion: un `AudioContext` falso. Los codecs reales y el dibujo de la onda se prueban en el E2E.
 */

const decodeMedia = vi.fn<(file: File) => Promise<{ audio: PcmAudio }>>();
vi.mock("@/lib/media/audio/decode", () => ({
  decodeMedia: (file: File) => decodeMedia(file),
  checkMediaFile: vi.fn(),
}));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

const sources: Record<string, PcmAudio> = {};
beforeEach(() => {
  sources["a.wav"] = monoSine(5, 1, 1000, 0.5); // 1 s a 1 kHz
  sources["b.wav"] = monoSine(5, 0.5, 1000, 0.25); // 0,5 s
  decodeMedia.mockImplementation(async (file) => ({ audio: sources[file.name] }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  decodeMedia.mockReset();
});

/** Fija el idioma activo (el estado de i18n vive en el modulo, no en el arbol). */
function UseLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => {
    setLanguage(language);
  }, [language, setLanguage]);
  return null;
}

const WAVE = { name: /^(Forma de onda del audio|Audio waveform)/ };
const waveform = () => screen.getByRole("slider", WAVE);
const wavFile = (name: string) => new File([new Uint8Array([1])], name, { type: "audio/wav" });

async function openEditor(...names: string[]) {
  const view = render(
    <LanguageProvider>
      <AudioStudioClient />
    </LanguageProvider>,
  );
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: names.map(wavFile) } });
  await screen.findByRole("slider", WAVE);
  return view;
}

const summary = () => screen.getByTestId("wave-summary").textContent;
const status = () => screen.getByTestId("studio-status").textContent;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const setField = (label: string, value: string) => {
  fireEvent.change(field(label), { target: { value } });
  fireEvent.blur(field(label));
};
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

describe("Audio Studio: importar y unir", () => {
  it("al abrir sin audio solo hay zona de carga; con varios archivos se unen EN EL ORDEN en que se eligen", async () => {
    const { container } = render(
      <LanguageProvider>
        <AudioStudioClient />
      </LanguageProvider>,
    );
    expect(screen.queryByRole("slider", WAVE)).toBeNull();
    expect(screen.getByRole("heading", { name: "Suelta uno o más audios aquí" })).toBeTruthy();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.multiple).toBe(true);
    fireEvent.change(input, { target: { files: [wavFile("b.wav"), wavFile("a.wav")] } });
    await screen.findByRole("slider", WAVE);
    expect(decodeMedia.mock.calls.map(([file]) => file.name)).toEqual(["b.wav", "a.wav"]);
    expect(summary()).toBe("Duración 0:01.50. Cursor en 0:00.00. Sin selección.");
    const items = screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-label")?.startsWith("Clip"));
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("b.wav"), expect.stringContaining("a.wav")]);
    expect(status()).toBe("2 audios añadidos.");
  });

  it("lo que no es audio se avisa y no entra; un archivo que no se puede abrir se explica sin tirar los demas", async () => {
        decodeMedia.mockImplementation(async (file) => {
      if (file.name === "roto.wav") throw Object.assign(new Error("x"), { name: "EncodingError" });
      return { audio: sources[file.name] };
    });
    const { container } = render(
      <LanguageProvider>
        <AudioStudioClient />
      </LanguageProvider>,
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [wavFile("a.wav"), new File(["x"], "notas.txt", { type: "text/plain" }), wavFile("roto.wav")] } });
    await screen.findByRole("slider", WAVE);
    expect(screen.getByText(/No se añadieron porque no son audio: notas.txt/)).toBeTruthy();
    expect(screen.getByText(/No se pudo abrir roto.wav/)).toBeTruthy();
    expect(summary()).toContain("Duración 0:01.00");
  });

  it("los audios con otra frecuencia o canales se ajustan a los del primero y se avisa", async () => {
    sources["a.wav"] = audioOf([sine(5, 1, 1000)], 1000);
    sources["b.wav"] = audioOf([sine(5, 1, 2000), sine(5, 1, 2000)], 2000);
    await openEditor("a.wav", "b.wav");
    expect(summary()).toContain("Duración 0:02.00");
    expect(screen.getByText(/se ajustaron a la frecuencia y los canales del primero \(1 kHz, mono\)/)).toBeTruthy();
  });
});

describe("Audio Studio: seleccion y edicion", () => {
  it("campos de inicio/fin: la seleccion se escribe en segundos (coma o punto) y se resume en texto", async () => {
    await openEditor("a.wav", "b.wav");
    setField("Fin (segundos)", "1,0");
    expect(summary()).toBe("Duración 0:01.50. Selección de 0:00.00 a 0:01.00 (0:01.00).");
    setField("Inicio (segundos)", "0.25");
    expect(summary()).toBe("Duración 0:01.50. Selección de 0:00.25 a 0:01.00 (0:00.75).");
    click("Quitar la marca");
    expect(summary()).toContain("Sin selección");
  });

  it("recortar, quitar, deshacer y rehacer cambian la duracion y se anuncian", async () => {
    await openEditor("a.wav", "b.wav");
    expect((screen.getByRole("button", { name: "Recortar a la selección" }) as HTMLButtonElement).disabled).toBe(true);
    setField("Inicio (segundos)", "0.5");
    setField("Fin (segundos)", "1.0");
    click("Recortar a la selección");
    expect(summary()).toBe("Duración 0:00.50. Cursor en 0:00.00. Sin selección.");
    expect(status()).toBe("Recortado. Ahora dura 0:00.50.");
    click("Deshacer");
    expect(summary()).toContain("Duración 0:01.50");
    expect(status()).toBe("Cambio deshecho.");
    click("Rehacer");
    expect(summary()).toContain("Duración 0:00.50");
    click("Deshacer");
    setField("Inicio (segundos)", "0.5");
    setField("Fin (segundos)", "1.0");
    click("Quitar la selección");
    expect(summary()).toBe("Duración 0:01.00. Cursor en 0:00.50. Sin selección.");
    expect(status()).toBe("Tramo quitado. Ahora dura 0:01.00.");
  });

  it("Ctrl+Z / Ctrl+Mayus+Z deshacen y rehacen desde la onda", async () => {
    await openEditor("a.wav");
    const wave = waveform();
    setField("Fin (segundos)", "0.5");
    click("Recortar a la selección");
    expect(summary()).toContain("Duración 0:00.50");
    fireEvent.keyDown(wave, { key: "z", ctrlKey: true });
    expect(summary()).toContain("Duración 0:01.00");
    fireEvent.keyDown(wave, { key: "z", ctrlKey: true, shiftKey: true });
    expect(summary()).toContain("Duración 0:00.50");
  });

  it("con el teclado: flechas mueven el cursor y Mayus + flecha selecciona", async () => {
    await openEditor("a.wav");
    const wave = waveform();
    fireEvent.keyDown(wave, { key: "ArrowRight" });
    fireEvent.keyDown(wave, { key: "ArrowRight" });
    expect(summary()).toBe("Duración 0:01.00. Cursor en 0:00.20. Sin selección.");
    fireEvent.keyDown(wave, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(wave, { key: "ArrowRight", shiftKey: true });
    expect(summary()).toBe("Duración 0:01.00. Selección de 0:00.20 a 0:00.40 (0:00.20).");
    expect(wave.getAttribute("aria-valuetext")).toBe(summary());
    fireEvent.keyDown(wave, { key: "Escape" });
    expect(summary()).toContain("Sin selección");
  });

  it("dividir en el cursor crea un clip mas sin cambiar la duracion; los clips se pueden reordenar y quitar", async () => {
    await openEditor("a.wav", "b.wav");
    const wave = waveform();
    expect((screen.getByRole("button", { name: "Dividir en el cursor" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(wave, { key: "ArrowUp" }); // +1 s
    expect(summary()).toContain("Cursor en 0:01.00");
    expect((screen.getByRole("button", { name: "Dividir en el cursor" }) as HTMLButtonElement).disabled).toBe(true); // justo en un limite: ya esta dividido
    fireEvent.keyDown(wave, { key: "ArrowLeft", ctrlKey: true }); // -1 s → 0
    fireEvent.keyDown(wave, { key: "ArrowRight" });
    click("Dividir en el cursor");
    expect(summary()).toContain("Duración 0:01.50");
    const clips = () => screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-label")?.startsWith("Clip"));
    expect(clips()).toHaveLength(3);
    click("Subir el clip 3: b.wav");
    expect(clips()[1].textContent).toContain("b.wav");
    click("Quitar el clip 2: b.wav");
    expect(clips()).toHaveLength(2);
    expect(summary()).toContain("Duración 0:01.00");
  });

  it("fundidos y volumen se anuncian; normalizar mide y aplica", async () => {
    await openEditor("a.wav");
    click("Fundido de entrada");
    expect(status()).toBe("Fundido de entrada aplicado.");
    click("Fundido de salida");
    expect(status()).toBe("Fundido de salida aplicado.");
    fireEvent.change(screen.getByRole("slider", { name: "Cambio de volumen" }), { target: { value: "-6" } });
    click("Aplicar volumen");
    expect(status()).toBe("Volumen cambiado -6 dB.");
    click("Normalizar");
    await waitFor(() => expect(status()).toBe("Volumen normalizado."));
  });
});

describe("Audio Studio: reproduccion", () => {
  it("Espacio reproduce y pausa; el boton cambia de nombre y de estado", async () => {
    const created: unknown[] = [];
    vi.stubGlobal(
      "AudioContext",
      class {
        currentTime = 0;
        state = "running";
        destination = {};
        constructor() {
          created.push(this);
        }
        resume() {
          return Promise.resolve();
        }
        close() {
          return Promise.resolve();
        }
        createBuffer(channels: number, length: number) {
          return { numberOfChannels: channels, length, copyToChannel() {} };
        }
        createBufferSource() {
          return { buffer: null, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null };
        }
      },
    );
    await openEditor("a.wav");
    const play = screen.getByRole("button", { name: "Reproducir" });
    expect(play.getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(waveform(), { key: " " });
    const pause = screen.getByRole("button", { name: "Pausa" });
    expect(pause.getAttribute("aria-pressed")).toBe("true");
    expect(created).toHaveLength(1);
    fireEvent.click(pause);
    expect(screen.getByRole("button", { name: "Reproducir" })).toBeTruthy();
  });
});

describe("Audio Studio: exportar", () => {
  it("exporta la pista editada a WAV de verdad: mismo numero de muestras que la duracion y boton para descargar", async () => {
    await openEditor("a.wav", "b.wav");
    setField("Inicio (segundos)", "0.5");
    setField("Fin (segundos)", "1.0");
    click("Quitar la selección");
    click("Exportar audio");
    const done = await screen.findByTestId("export-result", undefined, { timeout: 10_000 });
    expect(done.textContent).toMatch(/Listo: a-editado\.wav \(.*, 0:01\.00\)/);
    expect(within(done).getByRole("button", { name: "Descargar" })).toBeTruthy();
    const size = done.textContent?.match(/\(([\d,.]+) KB/);
    expect(Number((size?.[1] ?? "0").replace(",", "."))).toBeGreaterThan(1.5); // 1000 muestras x 2 bytes + cabecera
  });

  it("cualquier edicion invalida el resultado anterior (no se descarga algo que ya no es lo que se ve)", async () => {
    await openEditor("a.wav");
    click("Exportar audio");
    await screen.findByTestId("export-result", undefined, { timeout: 10_000 });
    click("Fundido de entrada");
    expect(screen.queryByTestId("export-result")).toBeNull();
  });

  it("Empezar de nuevo vacia la pista y vuelve a la zona de carga", async () => {
    await openEditor("a.wav");
    click("Empezar de nuevo");
    expect(screen.queryByRole("slider", WAVE)).toBeNull();
    expect(screen.getByRole("heading", { name: "Suelta uno o más audios aquí" })).toBeTruthy();
  });
});

describe("Audio Studio: ingles", () => {
  it("los textos del editor salen en ingles", async () => {
    const view = render(
      <LanguageProvider>
        <UseLanguage language="en" />
        <AudioStudioClient />
      </LanguageProvider>,
    );
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [wavFile("a.wav")] } });
    await screen.findByRole("slider", WAVE);
    expect(summary()).toBe("Duration 0:01.00. Cursor at 0:00.00. No selection.");
    expect(screen.getByRole("button", { name: "Trim to selection" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export audio" })).toBeTruthy();
    cleanup();
  });
});
