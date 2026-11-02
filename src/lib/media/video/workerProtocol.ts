import type { VideoErrorCode } from "@/lib/media/video/errors";
import type { ConversionPlan } from "@/lib/media/video/plan";
import type { VideoInfo } from "@/lib/media/video/types";

/** Mensajes entre la pagina y `video.worker.ts`. El `File` viaja por referencia (no se copia) y el resultado se TRANSFIERE. */
export type WorkerRequest =
  | { type: "probe"; id: number; file: File }
  | { type: "convert"; id: number; file: File; plan: ConversionPlan }
  | { type: "cancel"; id: number };

export type WorkerResponse =
  | { type: "probed"; id: number; info: VideoInfo }
  | { type: "progress"; id: number; progress: number; seconds: number }
  | { type: "converted"; id: number; buffer: ArrayBuffer; audioDropped: boolean }
  | { type: "failed"; id: number; code: VideoErrorCode; message: string };
