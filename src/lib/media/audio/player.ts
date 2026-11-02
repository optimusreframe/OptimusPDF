import { readTrack, type Track } from "@/lib/media/audio/edit";

/**
 * Vista previa del estudio con Web Audio.
 *
 * No se mezcla la pista entera en un `AudioBuffer`: se programan trozos de medio segundo con ~1,5 s de margen por
 * delante del cursor, asi un audio largo suena sin duplicarse en memoria y los cambios de volumen/fundidos se oyen tal
 * como se exportaran (el mismo `readTrack`). La pista se captura al empezar: una edicion detiene la reproduccion.
 */

const CHUNK_SECONDS = 0.5;
const LOOKAHEAD_SECONDS = 1.5;
const TICK_MS = 100;

type ContextLike = Pick<AudioContext, "currentTime" | "destination" | "createBuffer" | "createBufferSource" | "resume" | "close" | "state">;

export type TrackPlayerOptions = {
  /** Fabrica del contexto de audio (las pruebas pasan uno falso). */
  createContext?: () => ContextLike;
  /** Suena hasta el final de lo pedido. */
  onEnded?: () => void;
};

export class TrackPlayer {
  private context: ContextLike | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private track: Track | null = null;
  private startFrame = 0;
  private endFrame = 0;
  private cursor = 0;
  private origin = 0;
  private scheduledUntil = 0;
  private active = false;

  constructor(private readonly options: TrackPlayerOptions = {}) {}

  get playing(): boolean {
    return this.active;
  }

  /** Empieza a sonar `[startFrame, endFrame)` de `track`. */
  play(track: Track, startFrame: number, endFrame: number): void {
    this.halt();
    if (endFrame <= startFrame) return;
    const context = (this.context ??= this.options.createContext ? this.options.createContext() : (new AudioContext() as ContextLike));
    if (context.state === "suspended") void context.resume();
    this.track = track;
    this.startFrame = startFrame;
    this.endFrame = endFrame;
    this.cursor = startFrame;
    this.origin = context.currentTime + 0.06;
    this.scheduledUntil = this.origin;
    this.active = true;
    this.pump();
    this.timer = setInterval(() => this.pump(), TICK_MS);
  }

  /** Fotograma que suena ahora (o el ultimo, si esta parado). */
  position(): number {
    if (!this.active || !this.context || !this.track) return this.startFrame;
    const elapsed = Math.max(0, this.context.currentTime - this.origin);
    return Math.min(this.endFrame, Math.round(this.startFrame + elapsed * this.track.sampleRate));
  }

  /** Detiene y devuelve el fotograma en que se quedo. */
  pause(): number {
    const at = this.position();
    this.halt();
    this.startFrame = at;
    return at;
  }

  dispose(): void {
    this.halt();
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }

  private halt(): void {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Ya habia terminado.
      }
      source.disconnect();
    }
    this.sources = [];
  }

  private pump(): void {
    const context = this.context;
    const track = this.track;
    if (!this.active || !context || !track) return;
    const chunk = Math.round(track.sampleRate * CHUNK_SECONDS);
    while (this.cursor < this.endFrame && this.scheduledUntil - context.currentTime < LOOKAHEAD_SECONDS) {
      const end = Math.min(this.endFrame, this.cursor + chunk);
      const planes = readTrack(track, this.cursor, end);
      const buffer = context.createBuffer(track.channels, end - this.cursor, track.sampleRate);
      planes.forEach((plane, index) => buffer.copyToChannel(plane as Float32Array<ArrayBuffer>, index));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        this.sources = this.sources.filter((candidate) => candidate !== source);
      };
      source.start(this.scheduledUntil);
      this.sources.push(source);
      this.scheduledUntil += (end - this.cursor) / track.sampleRate;
      this.cursor = end;
    }
    if (this.cursor >= this.endFrame && context.currentTime >= this.scheduledUntil) {
      const finished = this.endFrame;
      this.halt();
      this.startFrame = finished;
      this.options.onEnded?.();
    }
  }
}
