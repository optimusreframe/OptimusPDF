/**
 * Generador de videos SINTETICOS para `video-converter.spec.ts`. Se compila a un IIFE con rolldown dentro de la propia prueba y se
 * inyecta en la pagina: ahi usa los codificadores del navegador (WebCodecs) y escribe el contenedor con mediabunny. Asi las pruebas
 * tienen videos de ritmo constante, con rotacion de movil, medidas impares y audio, sin guardar ningun archivo binario en el repo.
 *
 * Cada fotograma lleva su numero dibujado y una barra que avanza: sirve tanto para contar fotogramas como para mirar una captura.
 */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
} from "mediabunny";

export type FixtureSpec = {
  container: "mp4" | "webm" | "mov";
  codec: "avc" | "vp9" | "vp8";
  width: number;
  height: number;
  fps: number;
  seconds: number;
  rotation?: 0 | 90 | 180 | 270;
  /** Dibuja ruido aleatorio en cada fotograma: obliga al codificador a gastar todo el bitrate (para medir peso y memoria). */
  noise?: boolean;
  /** bits/s del video (por defecto 1,5 Mbps). */
  bitrate?: number;
  /** Codec de audio (con un tono de 440 Hz) o `null` para un video sin audio. */
  audio: "aac" | "opus" | null;
  /** Sin pista de video: un audio dentro de un MP4 (para probar «este archivo no tiene imagen»). */
  audioOnly?: boolean;
};

/** El video como `File` dentro de la pagina (sin pasar por texto: sirve para ficheros grandes). */
export async function makeVideoFile(spec: FixtureSpec, name: string): Promise<File> {
  const bytes = await makeVideoBytes(spec);
  const type = spec.container === "mp4" ? "video/mp4" : spec.container === "mov" ? "video/quicktime" : "video/webm";
  return new File([bytes], name, { type });
}

/** El video como texto base64 (para entregarlo a Playwright con `setInputFiles`). */
export async function makeVideo(spec: FixtureSpec): Promise<string> {
  const bytes = new Uint8Array(await makeVideoBytes(spec));
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function makeVideoBytes(spec: FixtureSpec): Promise<ArrayBuffer> {
  const target = new BufferTarget();
  const format = spec.container === "mp4" ? new Mp4OutputFormat() : spec.container === "mov" ? new MovOutputFormat() : new WebMOutputFormat();
  const output = new Output({ format, target });

  const canvas = new OffscreenCanvas(spec.width, spec.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("sin contexto 2d");
  const video = new CanvasSource(canvas, { codec: spec.codec, quality: new Quality({ bitrate: spec.bitrate ?? 1_500_000 }) });
  if (!spec.audioOnly) output.addVideoTrack(video, { frameRate: spec.fps, ...(spec.rotation ? { rotation: spec.rotation } : {}) });

  let audioSource: AudioBufferSource | null = null;
  if (spec.audio) {
    audioSource = new AudioBufferSource({ codec: spec.audio, quality: new Quality({ bitrate: 96_000 }) });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const frames = spec.audioOnly ? 0 : Math.round(spec.seconds * spec.fps);
  for (let n = 0; n < frames; n += 1) {
    if (spec.noise) {
      const image = context.createImageData(spec.width, spec.height);
      const data = new Uint32Array(image.data.buffer);
      let seed = (n + 1) * 2654435761;
      for (let i = 0; i < data.length; i += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[i] = 0xff000000 | seed;
      }
      context.putImageData(image, 0, 0);
    } else {
      context.fillStyle = `hsl(${(n * 7) % 360} 65% 42%)`;
      context.fillRect(0, 0, spec.width, spec.height);
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, spec.height - 14, Math.round((spec.width * (n + 1)) / frames), 14);
    context.fillRect(((n * 11) % Math.max(1, spec.width - 60)) | 0, Math.round(spec.height * 0.3), 60, 60);
    context.font = `${Math.max(14, Math.round(spec.height / 8))}px sans-serif`;
    context.fillText(String(n), 12, Math.max(24, Math.round(spec.height / 6)));
    await video.add(n / spec.fps, 1 / spec.fps);
  }
  if (!spec.audioOnly) video.close();

  if (audioSource) {
    const sampleRate = 48_000;
    const length = Math.round(spec.seconds * sampleRate);
    const buffer = new AudioBuffer({ length, sampleRate, numberOfChannels: 2 });
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) data[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }
    await audioSource.add(buffer);
    audioSource.close();
  }

  await output.finalize();
  return target.buffer as ArrayBuffer;
}
