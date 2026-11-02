import { expect, test, type Page } from "@playwright/test";
import { audioLabBundle } from "../helpers/audio-engine-bundle";
import { recordWebm } from "../helpers/audio-flow";

/**
 * Motor de audio con los CODECS REALES de Chromium (headless): lo que las pruebas unitarias solo pueden simular.
 *  - Codificar a Opus con `AudioEncoder` y comprobar que el archivo que EMPAQUETAMOS (Ogg) lo lee el navegador de verdad.
 *  - M4A (AAC): si este Chromium sabe crearlo, estructura valida; si no, que se declare `encoderUnavailable`.
 *  - Decodificar un WebM REAL de `MediaRecorder` (segmento y clusters de tamano desconocido) por las dos vias: Web Audio y
 *    nuestro lector de contenedor + `AudioDecoder`.
 *  - Video sin audio, cancelacion y cifras de tiempo.
 * Los audios son senos generados en la propia prueba. Se abre `/` solo para tener un origen seguro (localhost).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(180_000);

async function lab(page: Page): Promise<void> {
  await page.addInitScript({ content: await audioLabBundle() });
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test.describe("motor de audio en Chromium", () => {
  test("Opus: lo que codificamos y empaquetamos en Ogg lo decodifica el navegador con la duracion, canales y tonos correctos", async ({ page }) => {
    await lab(page);
    const result = await page.evaluate(async () => {
      type Lab = {
        encodeAudio: (source: unknown, options: unknown) => Promise<Blob>;
        sourceOfAudio: (audio: unknown) => unknown;
        probeMedia: (blob: Blob) => Promise<unknown>;
      };
      const lab = (globalThis as unknown as { AudioLab: Lab }).AudioLab;
      const rate = 44100;
      const frames = Math.round(1.5 * rate);
      const left = Float32Array.from({ length: frames }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
      const right = Float32Array.from({ length: frames }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 880 * i) / rate));
      const blob = await lab.encodeAudio(lab.sourceOfAudio({ sampleRate: rate, channels: [left, right] }), { format: "opus", bitrateKbps: 96, sampleRate: "original", channels: "original" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const context = new OfflineAudioContext(2, 1, 48000);
      const decoded = await context.decodeAudioData(bytes.slice().buffer);
      const freq = (samples: Float32Array, from: number, to: number) => {
        let crossings = 0;
        for (let i = from + 1; i < to; i += 1) if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
        return (crossings * decoded.sampleRate) / (to - from);
      };
      const l = decoded.getChannelData(0);
      const r = decoded.getChannelData(1);
      const mid = Math.round(decoded.length / 2);
      return {
        magic: String.fromCharCode(...bytes.subarray(0, 4)),
        head: String.fromCharCode(...bytes.subarray(28, 36)),
        size: bytes.length,
        probe: await lab.probeMedia(blob),
        duration: decoded.duration,
        rate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        left: freq(l, mid - 4800, mid + 4800),
        right: freq(r, mid - 4800, mid + 4800),
      };
    });
    expect(result.magic).toBe("OggS");
    expect(result.head).toBe("OpusHead");
    expect(result.probe).toMatchObject({ kind: "ogg", sampleRate: 48000, channels: 2 });
    expect(result.size).toBeGreaterThan(5_000);
    expect(result.size).toBeLessThan(40_000); // ~96 kbps x 1,5 s = 18 KB
    expect(result.rate).toBe(48000);
    expect(result.channels).toBe(2);
    expect(result.duration).toBeGreaterThan(1.45);
    expect(result.duration).toBeLessThan(1.56);
    expect(result.left).toBeGreaterThan(425);
    expect(result.left).toBeLessThan(455);
    expect(result.right).toBeGreaterThan(850);
    expect(result.right).toBeLessThan(910);
  });

  test("M4A (AAC): si este navegador sabe crearlo, el MP4 es valido (lector propio) con la duracion correcta; si no, se declara con su motivo", async ({ page }) => {
    await lab(page);
    const result = await page.evaluate(async () => {
      type Lab = {
        detectOutputSupport: () => Promise<Record<string, { available: boolean; reason?: string }>>;
        encodeAudio: (source: unknown, options: unknown) => Promise<Blob>;
        sourceOfAudio: (audio: unknown) => unknown;
        probeMedia: (blob: Blob) => Promise<{ kind: string; hasAudio?: boolean; durationSec?: number; sampleRate?: number; channels?: number }>;
        readMp4: (blob: Blob) => Promise<{ structure: { audioTracks: Array<{ codec: string | null; trackId: number }> }; packets: (id: number) => AsyncGenerator<{ data: Uint8Array }> } | null>;
      };
      const lab = (globalThis as unknown as { AudioLab: Lab }).AudioLab;
      const support = await lab.detectOutputSupport();
      const rate = 44100;
      const samples = Float32Array.from({ length: rate * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
      const audio = { sampleRate: rate, channels: [samples, samples] };
      if (!support.m4a.available) {
        const error = await lab.encodeAudio(lab.sourceOfAudio(audio), { format: "m4a", bitrateKbps: 128, sampleRate: "original", channels: "original" }).then(() => null, (caught: { code?: string }) => caught.code ?? "otro");
        return { support, error };
      }
      const blob = await lab.encodeAudio(lab.sourceOfAudio(audio), { format: "m4a", bitrateKbps: 128, sampleRate: "original", channels: "original" });
      const probe = await lab.probeMedia(blob);
      const mp4 = await lab.readMp4(blob);
      let packets = 0;
      for await (const packet of mp4!.packets(mp4!.structure.audioTracks[0].trackId)) if (packet.data.length > 0) packets += 1;
      const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      return { support, probe, packets, codec: mp4!.structure.audioTracks[0].codec, ftyp: String.fromCharCode(...head.subarray(4, 12)), size: blob.size };
    });
    expect(result.support.wav).toEqual({ available: true });
    expect(result.support.mp3).toEqual({ available: false, reason: "license" });
    if ("error" in result) {
      expect(result.support.m4a.available).toBe(false);
      expect(["noWebCodecs", "codecUnsupported"]).toContain(result.support.m4a.reason);
      expect(result.error).toBe("encoderUnavailable");
      test.info().annotations.push({ type: "m4a", description: `este Chromium no crea AAC (${result.support.m4a.reason}): rama de «no disponible» comprobada` });
      return;
    }
    expect(result.ftyp).toBe("ftypM4A ");
    expect(result.codec).toBe("mp4a.40.2");
    expect(result.probe).toMatchObject({ kind: "mp4", hasAudio: true, sampleRate: 44100, channels: 2 });
    expect(result.probe.durationSec).toBeGreaterThan(1.95);
    expect(result.probe.durationSec).toBeLessThan(2.15);
    expect(result.packets).toBeGreaterThan(80);
    test.info().annotations.push({ type: "m4a", description: `AAC creado: ${result.size} bytes, ${result.packets} paquetes` });
  });

  test("WebM REAL de MediaRecorder (clusters de tamano desconocido): se decodifica por Web Audio y, forzando el fallo de Web Audio, por nuestro lector + AudioDecoder", async ({ page }) => {
    await lab(page);
    const webm = await recordWebm(page, { audio: true, video: true, ms: 1500 });
    expect(webm.length).toBeGreaterThan(2_000);
    const result = await page.evaluate(async (base64) => {
      type Decoded = { via: string; audio: { sampleRate: number; channels: Float32Array[] }; probe: { kind: string; hasAudio?: boolean; hasVideo?: boolean } };
      const lab = (globalThis as unknown as { AudioLab: { decodeMedia: (blob: Blob) => Promise<Decoded>; probeMedia: (blob: Blob) => Promise<{ kind: string; hasAudio?: boolean; hasVideo?: boolean; sampleRate?: number; channels?: number }> } }).AudioLab;
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "video/webm" });
      const summarize = (decoded: Decoded) => {
        const samples = decoded.audio.channels[0];
        const mid = Math.floor(samples.length / 2);
        let crossings = 0;
        for (let i = mid - 9600; i < mid + 9600; i += 1) if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
        let sum = 0;
        for (let i = mid - 9600; i < mid + 9600; i += 1) sum += samples[i] * samples[i];
        return { via: decoded.via, seconds: samples.length / decoded.audio.sampleRate, rate: decoded.audio.sampleRate, freq: (crossings * decoded.audio.sampleRate) / 19200, rms: Math.sqrt(sum / 19200) };
      };
      const probe = await lab.probeMedia(blob);
      const direct = summarize(await lab.decodeMedia(blob));
      const NativeContext = OfflineAudioContext;
      (globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = class {
        decodeAudioData() {
          return Promise.reject(new DOMException("forzado por la prueba", "EncodingError"));
        }
      };
      let fallback;
      try {
        fallback = summarize(await lab.decodeMedia(blob));
      } finally {
        (globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = NativeContext;
      }
      return { probe, direct, fallback };
    }, webm.toString("base64"));
    expect(result.probe).toMatchObject({ kind: "webm", hasAudio: true, hasVideo: true, sampleRate: 48000 });
    expect(result.direct.via).toBe("web-audio");
    expect(result.fallback.via).toBe("webcodecs");
    for (const decoded of [result.direct, result.fallback]) {
      expect(decoded.seconds).toBeGreaterThan(1.0);
      expect(decoded.seconds).toBeLessThan(2.2);
      expect(decoded.freq).toBeGreaterThan(425);
      expect(decoded.freq).toBeLessThan(455);
      expect(decoded.rms).toBeGreaterThan(0.15); // 0,4 de amplitud => ~0,28 de RMS
    }
    expect(Math.abs(result.direct.seconds - result.fallback.seconds)).toBeLessThan(0.15);
  });

  test("un video SIN pista de audio (WebM real) se distingue de un archivo danado: noAudioTrack", async ({ page }) => {
    await lab(page);
    const mute = await recordWebm(page, { audio: false, video: true, ms: 800 });
    const result = await page.evaluate(async (base64) => {
      const lab = (globalThis as unknown as { AudioLab: { checkMediaFile: (blob: Blob) => Promise<unknown>; decodeMedia: (blob: Blob) => Promise<unknown>; probeMedia: (blob: Blob) => Promise<unknown> } }).AudioLab;
      const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "video/webm" });
      const decode = await lab.decodeMedia(blob).then(() => "sin error", (error: { code?: string }) => error.code);
      return { probe: await lab.probeMedia(blob), check: await lab.checkMediaFile(blob), decode };
    }, mute.toString("base64"));
    expect(result.probe).toMatchObject({ kind: "webm", hasVideo: true, hasAudio: false });
    expect(result.check).toMatchObject({ ok: false, code: "noAudioTrack" });
    expect(result.decode).toBe("noAudioTrack");
  });

  test("cancelar una codificacion larga la detiene enseguida (y deja el codificador cerrado); cifras de tiempo", async ({ page }) => {
    await lab(page);
    const result = await page.evaluate(async () => {
      type Lab = { encodeAudio: (source: unknown, options: unknown, context?: unknown) => Promise<Blob>; sourceOfAudio: (audio: unknown) => unknown };
      const lab = (globalThis as unknown as { AudioLab: Lab }).AudioLab;
      const rate = 44100;
      const make = (seconds: number) => {
        const frames = seconds * rate;
        const a = Float32Array.from({ length: frames }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 330 * i) / rate));
        const b = Float32Array.from({ length: frames }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 550 * i) / rate));
        return lab.sourceOfAudio({ sampleRate: rate, channels: [a, b] });
      };
      const controller = new AbortController();
      const started = performance.now();
      const pending = lab.encodeAudio(make(600), { format: "opus", bitrateKbps: 64, sampleRate: "original", channels: "original" }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 300);
      const code = await pending.then(() => "terminó", (error: { code?: string }) => error.code);
      const cancelMs = performance.now() - started;

      const timeOf = async (options: unknown, seconds: number) => {
        const t0 = performance.now();
        const blob = await lab.encodeAudio(make(seconds), options);
        return { ms: Math.round(performance.now() - t0), bytes: blob.size };
      };
      return {
        code,
        cancelMs: Math.round(cancelMs),
        wav22: await timeOf({ format: "wav", bitrateKbps: 128, sampleRate: 22050, channels: 1 }, 60),
        wavOriginal: await timeOf({ format: "wav", bitrateKbps: 128, sampleRate: "original", channels: "original" }, 60),
        opus: await timeOf({ format: "opus", bitrateKbps: 96, sampleRate: "original", channels: "original" }, 60),
      };
    });
    expect(result.code).toBe("cancelled");
    expect(result.cancelMs).toBeLessThan(5_000);
    expect(result.wavOriginal.bytes).toBe(44 + 60 * 44100 * 4);
    expect(result.wav22.bytes).toBe(44 + 60 * 22050 * 2);
    expect(result.opus.bytes).toBeLessThan(900_000);
    test.info().annotations.push({
      type: "cifras",
      description: `60 s estéreo 44,1 kHz: WAV original ${result.wavOriginal.ms} ms; WAV 22,05 kHz mono (con remuestreo) ${result.wav22.ms} ms; Opus 96 kbps (remuestreo a 48 kHz) ${result.opus.ms} ms (${result.opus.bytes} B); cancelar tardó ${result.cancelMs} ms`,
    });
  });
});
