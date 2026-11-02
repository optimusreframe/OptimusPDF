import { describe, expect, it } from "vitest";
import type { FormatCapability, VideoCapabilities } from "@/lib/media/video/capabilities";
import { LIMITS } from "@/lib/media/video/limits";
import { hasIssue, planConversion } from "@/lib/media/video/plan";
import { DEFAULT_CONVERSION_OPTIONS, type ConversionOptions, type VideoInfo } from "@/lib/media/video/types";

const MB = 1024 * 1024;

function capability(format: "mp4" | "webm", overrides: Partial<FormatCapability> = {}): FormatCapability {
  return { format, available: true, videoCodecs: format === "mp4" ? ["avc"] : ["vp9", "vp8"], audioEncodable: true, ...overrides };
}
const FULL: VideoCapabilities = { supported: true, formats: { mp4: capability("mp4"), webm: capability("webm") } };

/** MP4 H.264 1080p30 de 60 s, 10 Mbps en total, con audio AAC estereo. */
const SOURCE: VideoInfo = {
  container: "MP4",
  duration: 60,
  width: 1920,
  height: 1080,
  rotation: 0,
  fps: 30,
  videoCodec: "avc",
  videoBitrate: 9_872_000,
  canDecodeVideo: true,
  hdr: false,
  audio: { codec: "aac", channels: 2, sampleRate: 48000, bitrate: 128_000, canDecode: true },
  fileSize: 75 * MB,
};

function plan(info: Partial<VideoInfo> = {}, options: Partial<ConversionOptions> = {}, caps = FULL, device: "desktop" | "constrained" = "desktop") {
  return planConversion({ ...SOURCE, ...info }, { ...DEFAULT_CONVERSION_OPTIONS, ...options }, caps, device);
}

describe("planConversion · copiar o recodificar", () => {
  it("MP4 H.264 a MP4 con «Conservar» no recodifica ni video ni audio", () => {
    const p = plan();
    expect(p.video.mode).toBe("copy");
    expect(p.audio.mode).toBe("copy");
    expect(p.canConvert).toBe(true);
    // El resultado pesa lo mismo que el original (± contenedor).
    expect(p.estimatedBytes / SOURCE.fileSize).toBeGreaterThan(0.95);
    expect(p.estimatedBytes / SOURCE.fileSize).toBeLessThan(1.1);
  });

  it("MOV de iPhone en HEVC a MP4 hay que recodificar a H.264 (el MP4 prometido es H.264)", () => {
    const p = plan({ videoCodec: "hevc", container: "QuickTime" });
    expect(p.video).toMatchObject({ mode: "transcode", codec: "avc" });
    expect(p.video.bitrate).toBeGreaterThan(0);
  });

  it("cambiar resolucion, ritmo o calidad obliga a recodificar el video", () => {
    expect(plan({}, { resolution: "720p" }).video.mode).toBe("transcode");
    expect(plan({ fps: 60 }, { maxFps: "30" }).video.mode).toBe("transcode");
    expect(plan({}, { quality: "balanced" }).video.mode).toBe("transcode");
  });

  it("un tope de fps que el original ya cumple NO recodifica", () => {
    expect(plan({ fps: 24 }, { maxFps: "30" }).video.mode).toBe("copy");
  });

  it("a WebM un H.264 se recodifica a VP9; un VP9 se copia", () => {
    expect(plan({}, { format: "webm" }).video).toMatchObject({ mode: "transcode", codec: "vp9" });
    expect(plan({ videoCodec: "vp9" }, { format: "webm" }).video).toMatchObject({ mode: "copy", codec: "vp9" });
  });

  it("si el navegador solo codifica VP8, WebM usa VP8", () => {
    const caps: VideoCapabilities = { supported: true, formats: { mp4: capability("mp4"), webm: capability("webm", { videoCodecs: ["vp8"] }) } };
    expect(plan({}, { format: "webm" }, caps).video.codec).toBe("vp8");
  });

  it("un video con rotacion de movil a WebM se recodifica (WebM no guarda la rotacion) y se avisa; a MP4 se copia", () => {
    const inWebm = plan({ videoCodec: "vp9", rotation: 90 }, { format: "webm" });
    expect(inWebm.video.mode).toBe("transcode");
    expect(hasIssue(inWebm, "rotationBaked")).toBe(true);
    expect(plan({ rotation: 90 }).video.mode).toBe("copy");
  });
});

describe("planConversion · medidas y bitrate", () => {
  it("720p reduce las medidas y el peso estimado", () => {
    const full = plan({}, { quality: "balanced" });
    const small = plan({}, { quality: "balanced", resolution: "720p" });
    expect(small.video).toMatchObject({ width: 1280, height: 720, resize: true });
    expect(small.estimatedBytes).toBeLessThan(full.estimatedBytes);
  });

  it("calidad pequena < equilibrada < alta en peso estimado", () => {
    const sizes = (["small", "balanced", "high"] as const).map((quality) => plan({ videoBitrate: 40_000_000 }, { quality }).estimatedBytes);
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(sizes[1]).toBeLessThan(sizes[2]);
  });

  it("medidas impares se redondean a pares solo si se recodifica", () => {
    const odd = { width: 1081, height: 721, videoCodec: "hevc" } as const;
    expect(plan(odd).video).toMatchObject({ width: 1082, height: 722, resize: true });
    const copy = plan({ width: 1081, height: 721 });
    expect(copy.video).toMatchObject({ mode: "copy", width: 1081, height: 721, resize: false });
  });

  it("un tope de fps entra en el plan como tope y en el calculo", () => {
    const p = plan({ fps: 60 }, { maxFps: "30", quality: "balanced" });
    expect(p.video.fpsCap).toBe(30);
    expect(p.video.outputFps).toBe(30);
    expect(plan({ fps: 60 }, { quality: "balanced" }).video.fpsCap).toBeNull();
  });

  it("un original muy comprimido no se infla sin medida: el bitrate se topa con lo que tenia (con el margen del codec)", () => {
    // HEVC a 1,5 Mbps: H.264 necesita ~1,7 veces mas para verse igual, pero nunca los ~7 Mbps del perfil alto de 1080p.
    const p = plan({ videoCodec: "hevc", videoBitrate: 1_500_000, fileSize: 12 * MB, audio: null }, { quality: "high" });
    expect(p.video.bitrate).toBeLessThan(3_000_000);
    expect(p.estimatedBytes).toBeLessThan(12 * MB * 2);
  });
});

describe("planConversion · audio", () => {
  it("quitar el audio lo deja fuera del plan y del peso", () => {
    const withAudio = plan();
    const without = plan({}, { removeAudio: true });
    expect(without.audio).toEqual({ mode: "none", reason: "removed" });
    expect(without.estimatedBytes).toBeLessThan(withAudio.estimatedBytes);
  });

  it("un video sin audio no lleva pista de audio", () => {
    expect(plan({ audio: null }).audio).toEqual({ mode: "none", reason: "absent" });
  });

  it("MP3 dentro de un MKV a MP4: se recodifica a AAC", () => {
    const p = plan({ audio: { codec: "mp3", channels: 2, sampleRate: 44100, bitrate: 192_000, canDecode: true } });
    expect(p.audio).toMatchObject({ mode: "transcode", codec: "aac" });
  });

  it("5.1 se baja a estereo al recodificar; mono se queda mono", () => {
    const surround = plan({ audio: { codec: "ac3", channels: 6, sampleRate: 48000, bitrate: 384_000, canDecode: true } });
    expect(surround.audio).toMatchObject({ mode: "transcode", channels: 2 });
    const mono = plan({ audio: { codec: "mp3", channels: 1, sampleRate: 44100, bitrate: 96_000, canDecode: true } });
    expect(mono.audio).toMatchObject({ mode: "transcode", channels: 1 });
  });

  it("sin codificador de audio y con un codec que no encaja, sale sin sonido y se avisa (no falla a la mitad)", () => {
    const caps: VideoCapabilities = { supported: true, formats: { mp4: capability("mp4", { audioEncodable: false }), webm: capability("webm") } };
    const p = plan({ audio: { codec: "mp3", channels: 2, sampleRate: 44100, bitrate: 192_000, canDecode: true } }, {}, caps);
    expect(p.audio).toEqual({ mode: "none", reason: "unencodable" });
    expect(hasIssue(p, "audioCannotEncode")).toBe(true);
    expect(p.canConvert).toBe(true);
  });

  it("sin codificador de audio pero con AAC en el original, el audio PASA tal cual", () => {
    const caps: VideoCapabilities = { supported: true, formats: { mp4: capability("mp4", { audioEncodable: false }), webm: capability("webm") } };
    expect(plan({}, {}, caps).audio.mode).toBe("copy");
  });

  it("audio que el navegador no decodifica: se avisa y sale sin sonido", () => {
    const p = plan({ audio: { codec: "dts", channels: 6, sampleRate: 48000, bitrate: 1_500_000, canDecode: false } });
    expect(p.audio).toEqual({ mode: "none", reason: "undecodable" });
    expect(hasIssue(p, "audioUndecodable")).toBe(true);
  });

  it("fuera de «Conservar», un AAC ya ligero se copia y uno pesado se recodifica", () => {
    expect(plan({}, { quality: "balanced" }).audio.mode).toBe("copy");
    const heavy = plan({ audio: { codec: "aac", channels: 2, sampleRate: 48000, bitrate: 320_000, canDecode: true } }, { quality: "small" });
    expect(heavy.audio.mode).toBe("transcode");
  });
});

describe("planConversion · bloqueos y avisos", () => {
  it("sin decodificador para el video no hay conversion", () => {
    const p = plan({ canDecodeVideo: false });
    expect(hasIssue(p, "cannotDecodeVideo")).toBe(true);
    expect(p.canConvert).toBe(false);
  });

  it("formato no disponible en este navegador bloquea ese formato, no el otro", () => {
    const caps: VideoCapabilities = {
      supported: true,
      formats: { mp4: capability("mp4", { available: false, videoCodecs: [] }), webm: capability("webm") },
    };
    expect(plan({}, { format: "mp4" }, caps).canConvert).toBe(false);
    expect(plan({}, { format: "webm" }, caps).canConvert).toBe(true);
  });

  it("original de mas de 500 MB: aviso; por encima del tope: bloqueo", () => {
    const big = plan({ fileSize: 600 * MB });
    expect(hasIssue(big, "bigFile")).toBe(true);
    expect(big.canConvert).toBe(true);
    const huge = plan({ fileSize: LIMITS.desktop.maxInputBytes + 1 });
    expect(hasIssue(huge, "inputTooLarge")).toBe(true);
    expect(huge.canConvert).toBe(false);
  });

  it("en un movil los umbrales son mas bajos (y 45 min ya no caben)", () => {
    const long = { duration: 45 * 60, videoBitrate: 500_000, fileSize: 100 * MB };
    expect(plan(long, {}, FULL, "constrained").canConvert).toBe(false);
    expect(plan(long, {}, FULL, "desktop").canConvert).toBe(true);
    expect(hasIssue(plan({ fileSize: 300 * MB }, {}, FULL, "constrained"), "bigFile")).toBe(true);
    expect(hasIssue(plan({ fileSize: 300 * MB }, {}, FULL, "desktop"), "bigFile")).toBe(false);
    expect(plan({ fileSize: 2 * 1024 * MB }, {}, FULL, "constrained").canConvert).toBe(false);
  });

  it("duracion: aviso a los 30 min y bloqueo a las 2 h en escritorio", () => {
    expect(hasIssue(plan({ duration: 40 * 60 }), "longVideo")).toBe(true);
    const tooLong = plan({ duration: 3 * 3600 });
    expect(hasIssue(tooLong, "tooLong")).toBe(true);
    expect(tooLong.canConvert).toBe(false);
  });

  it("un resultado estimado por encima del tope se bloquea con su propio aviso (y bajar calidad lo arregla)", () => {
    const info = { duration: 100 * 60, width: 3840, height: 2160, videoCodec: "hevc", videoBitrate: 50_000_000, fileSize: 3 * 1024 * MB };
    const heavy = plan(info, { quality: "high" });
    expect(hasIssue(heavy, "outputTooLarge")).toBe(true);
    expect(heavy.canConvert).toBe(false);
    expect(plan(info, { quality: "small", resolution: "480p" }).canConvert).toBe(true);
  });

  it("recodificar HEVC a H.264 puede pesar mas que el original y se avisa; copiar nunca", () => {
    const hevc = plan({ videoCodec: "hevc", videoBitrate: 1_500_000, fileSize: 12 * MB, audio: null }, { quality: "high" });
    expect(hevc.video.mode).toBe("transcode");
    expect(hasIssue(hevc, "outputLarger")).toBe(true);
    expect(hasIssue(plan(), "outputLarger")).toBe(false);
  });

  it("HDR recodificado avisa de que saldra en SDR; copiado no", () => {
    expect(hasIssue(plan({ hdr: true }, { quality: "balanced" }), "hdr")).toBe(true);
    expect(hasIssue(plan({ hdr: true }), "hdr")).toBe(false);
  });

  it("sin fps medido y con un tope pedido, solo informa", () => {
    const p = plan({ fps: null }, { maxFps: "30" });
    expect(p.issues).toContainEqual({ code: "fpsUnknown", level: "info" });
    expect(p.video.fpsCap).toBeNull();
  });

  it("el nombre de extension y el tipo MIME salen del formato", () => {
    expect(plan({}, { format: "webm" })).toMatchObject({ extension: "webm", mime: "video/webm" });
    expect(plan()).toMatchObject({ extension: "mp4", mime: "video/mp4" });
  });
});
