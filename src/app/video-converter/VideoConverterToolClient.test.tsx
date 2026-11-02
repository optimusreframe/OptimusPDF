import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { VideoError } from "@/lib/media/video/errors";
import type { ConversionPlan } from "@/lib/media/video/plan";
import type { VideoInfo } from "@/lib/media/video/types";
import type { VideoEngine } from "@/lib/media/video/videoEngine";
import { STRINGS } from "@/app/video-converter/strings";

const engine = vi.hoisted(() => ({ current: null as VideoEngine | null }));
vi.mock("@/lib/media/video/videoEngine", () => ({ createVideoEngine: () => engine.current }));

import { VideoConverterToolClient } from "@/app/video-converter/VideoConverterToolClient";

const ES = STRINGS.es;
const MB = 1024 * 1024;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

/** WebCodecs simulado: H.264/AAC y VP9/Opus codificables. */
function installCodecs(options: { video?: boolean } = {}) {
  const globals = globalThis as unknown as Record<string, unknown>;
  if (options.video === false) {
    delete globals.VideoEncoder;
    delete globals.VideoDecoder;
    return;
  }
  globals.VideoDecoder = class {};
  globals.VideoEncoder = { isConfigSupported: async () => ({ supported: true }) };
  globals.AudioEncoder = { isConfigSupported: async () => ({ supported: true }) };
}

function removeCodecs() {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ["VideoEncoder", "VideoDecoder", "AudioEncoder"]) delete globals[name];
}

const INFO: VideoInfo = {
  container: "QuickTime",
  duration: 12,
  width: 1920,
  height: 1080,
  rotation: 0,
  fps: 60,
  videoCodec: "hevc",
  videoBitrate: 12_000_000,
  canDecodeVideo: true,
  hdr: false,
  audio: { codec: "aac", channels: 2, sampleRate: 48000, bitrate: 128_000, canDecode: true },
  fileSize: 20 * MB,
};

function makeEngine(overrides: Partial<VideoEngine> & { info?: VideoInfo } = {}) {
  const { info = INFO, ...rest } = overrides;
  const convert = vi.fn<VideoEngine["convert"]>(async () => ({ blob: new Blob(["resultado"], { type: "video/mp4" }), audioDropped: false }));
  const fake: VideoEngine = {
    probe: vi.fn(async () => info),
    convert,
    dispose: vi.fn(),
    ...rest,
  };
  engine.current = fake;
  return { fake, convert };
}

function renderTool() {
  return render(
    <LanguageProvider>
      <VideoConverterToolClient />
    </LanguageProvider>,
  );
}

function pick(container: HTMLElement, name = "viaje.mov") {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([new Uint8Array(8)], name, { type: "video/quicktime" })] } });
}

async function waitForOptions() {
  await screen.findByRole("heading", { name: ES.estimateTitle });
}

const run = () => screen.getAllByRole("button", { name: ES.run })[0];

beforeEach(() => {
  installCodecs();
});

afterEach(() => {
  removeCodecs();
  engine.current = null;
});

describe("VideoConverterToolClient", () => {
  it("sin WebCodecs muestra la pagina informativa (no un error) y ninguna zona de carga", async () => {
    removeCodecs();
    makeEngine();
    const { container } = renderTool();
    await screen.findByRole("heading", { name: ES.unsupportedTitle });
    expect(screen.getByText(ES.unsupported["no-video-encoder"])).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.querySelector("[data-error-banner]")).toBeNull();
  });

  it("al elegir un video lee su cabecera y muestra duracion, medidas, ritmo, codecs y el peso estimado", async () => {
    const { fake } = makeEngine();
    const { container } = renderTool();
    await screen.findByText(ES.idleTitle);
    pick(container);
    await waitForOptions();
    expect(fake.probe).toHaveBeenCalledTimes(1);
    const info = container.querySelector("[data-video-info]") as HTMLElement;
    expect(info.textContent).toContain("0:12");
    expect(info.textContent).toContain("1920 × 1080");
    expect(info.textContent).toContain("60 fps");
    expect(info.textContent).toContain("H.265 (HEVC)");
    expect(info.textContent).toContain("AAC");
    expect(container.querySelector("[data-video-estimate]")?.textContent).toMatch(/aprox\./);
  });

  it("solo ofrece lo que reduce de verdad: resoluciones por debajo del original y fotogramas por debajo de 60", async () => {
    makeEngine();
    const { container } = renderTool();
    await screen.findByText(ES.idleTitle);
    pick(container);
    await waitForOptions();
    const resolution = screen.getAllByRole("tablist", { name: ES.resolutionLabel })[0];
    expect(within(resolution).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([ES.resolutionOriginal, "720p", "480p", "360p"]);
    const fps = screen.getAllByRole("tablist", { name: ES.fpsLabel })[0];
    expect(within(fps).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([ES.fpsOriginal, "30 fps", "24 fps", "15 fps"]);
  });

  it("convierte con el plan elegido: WebM, 720p, calidad equilibrada, 30 fps y sin audio", async () => {
    const { convert } = makeEngine();
    const { container } = renderTool();
    await screen.findByText(ES.idleTitle);
    pick(container);
    await waitForOptions();
    fireEvent.click(screen.getAllByRole("tab", { name: "WebM" })[0]);
    fireEvent.click(screen.getAllByRole("tab", { name: "720p" })[0]);
    fireEvent.click(screen.getAllByRole("radio", { name: ES.qualityBalanced })[0]);
    fireEvent.click(screen.getAllByRole("tab", { name: "30 fps" })[0]);
    fireEvent.click(screen.getAllByRole("switch", { name: ES.removeAudio })[0]);
    fireEvent.click(run());

    await waitFor(() => expect(convert).toHaveBeenCalledTimes(1));
    const plan = convert.mock.calls[0][1] as ConversionPlan;
    expect(plan.format).toBe("webm");
    expect(plan.video).toMatchObject({ mode: "transcode", codec: "vp9", width: 1280, height: 720, resize: true, fpsCap: 30 });
    expect(plan.video.bitrate).toBeGreaterThan(0);
    expect(plan.audio).toEqual({ mode: "none", reason: "removed" });

    // Pantalla de resultado: nombre con la extension nueva, resumen y aviso del audio quitado.
    await screen.findByText("viaje-convertido.webm");
    expect(screen.getByText(/WebM, 1280 × 720, recodificado\./)).toBeTruthy();
    expect(screen.getByText(ES.noticeAudioRemoved)).toBeTruthy();
  });

  it("«Convertir» queda desactivado con el motivo cuando un aviso rojo lo impide", async () => {
    makeEngine({ info: { ...INFO, fileSize: 5 * 1024 * MB } });
    const { container } = renderTool();
    await screen.findByText(ES.idleTitle);
    pick(container);
    await waitForOptions();
    expect(container.querySelector('[data-issue="inputTooLarge"]')?.textContent).toContain("5,0 GB");
    for (const button of screen.getAllByRole("button", { name: ES.run })) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector("[data-run-reason]")?.textContent).toBe(ES.runBlocked);
  });

  it("cancelar durante la conversion vuelve a las opciones con un aviso neutro, sin pantalla de resultado ni error", async () => {
    const convert = vi.fn<VideoEngine["convert"]>(
      (_file, _plan, hooks) => new Promise((_resolve, reject) => hooks.signal.addEventListener("abort", () => reject(new VideoError("cancelled")))),
    );
    makeEngine({ convert });
    const { container } = renderTool();
    await screen.findByText(ES.idleTitle);
    pick(container);
    await waitForOptions();
    fireEvent.click(run());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(ES.cancelled)).toBeTruthy();
    expect(container.querySelector("[data-error-banner]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Descargar" })).toBeNull();
    expect(convert).toHaveBeenCalledTimes(1);
    expect(run()).toBeTruthy();
  });

  it("un fallo del motor se explica con su texto propio y deja volver a intentar", async () => {
    makeEngine({ convert: vi.fn(async () => Promise.reject(new VideoError("outOfMemory"))) });
    const { container } = renderTool();
    await screen.findByText(ES.idleTitle);
    pick(container);
    await waitForOptions();
    fireEvent.click(run());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(ES.errors.outOfMemory.title);
    expect(alert.textContent).toContain(ES.errors.outOfMemory.hint);
    expect(run()).toBeTruthy();
  });

  it("un video sin imagen ofrece el convertidor de audio; uno ilegible, elegir otro archivo", async () => {
    makeEngine({ probe: vi.fn(async () => Promise.reject(new VideoError("noVideoTrack"))) });
    const first = renderTool();
    await screen.findByText(ES.idleTitle);
    pick(first.container, "solo-audio.mp4");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(ES.errors.noVideoTrack.title);
    expect(within(alert).getByRole("link", { name: ES.openAudioConverter }).getAttribute("href")).toBe("/audio-converter");
    first.unmount();

    makeEngine({ probe: vi.fn(async () => Promise.reject(new VideoError("unreadable"))) });
    const second = renderTool();
    await screen.findByText(ES.idleTitle);
    pick(second.container, "roto.mp4");
    const unreadable = await screen.findByRole("alert");
    expect(unreadable.textContent).toContain(ES.errors.unreadable.title);
    expect(within(unreadable).getByRole("button", { name: ES.chooseAnother })).toBeTruthy();
  });

  it("quitar el archivo devuelve la zona de carga y libera el estado", async () => {
    makeEngine();
    const { container } = renderTool();
    await screen.findByText(ES.idleTitle);
    pick(container);
    await waitForOptions();
    fireEvent.click(screen.getByRole("button", { name: ES.removeFile }));
    await screen.findByText(ES.idleTitle);
    expect(container.querySelector("[data-video-card]")).toBeNull();
  });
});
