/**
 * Punto de entrada que Vite empaqueta (IIFE) para llevar el MOTOR REAL de audio a una pagina de Chromium y probarlo
 * con los codecs de verdad (`AudioEncoder`, `AudioDecoder`, `decodeAudioData`). Deja `globalThis.AudioLab`. Solo para
 * pruebas E2E; no forma parte del producto.
 */
import { detectOutputSupport } from "../../src/lib/media/audio/capabilities";
import { checkMediaFile, decodeMedia } from "../../src/lib/media/audio/decode";
import { encodeAudio } from "../../src/lib/media/audio/encode";
import { readMp4 } from "../../src/lib/media/audio/mp4";
import { sourceOfAudio } from "../../src/lib/media/audio/pcm";
import { probeMedia } from "../../src/lib/media/audio/probe";

(globalThis as Record<string, unknown>).AudioLab = { detectOutputSupport, checkMediaFile, decodeMedia, encodeAudio, readMp4, sourceOfAudio, probeMedia };
