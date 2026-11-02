/**
 * Limites de tamano y duracion. El original NO se carga entero (se lee a trozos desde el disco), pero el RESULTADO se arma en
 * memoria: el pico es ~2,4 veces su peso (medido: un MP4 de 559 MB de resultado subio ~1,3 GB sobre el punto de partida, el
 * contenedor se cierra y luego se crea el archivo descargable). Por eso el tope duro se pone sobre el peso ESTIMADO del
 * resultado y no solo sobre el del original, y es mas bajo en moviles y tabletas (Safari/iOS cierra la pestana por memoria
 * mucho antes que un navegador de escritorio).
 *
 * Velocidad medida en Chromium de escritorio (Mac, codificador por hardware): un 1080p30 de contenido sencillo se recodifica a ~5
 * veces el tiempo real, y uno de ruido puro de ~110 Mbps (el peor caso) a ~1,6-2,1 veces; copiar sin recodificar tarda segundos.
 * De ahi el tope de duracion en escritorio (2 h = como mucho ~75 min de espera en el peor caso medido).
 *
 * Las cifras de dispositivos con poca memoria (iPhone, iPad, Android, <= 4 GB) son CONSERVADORAS y NO se han medido en un
 * aparato real: son lo primero que hay que calibrar con las pruebas manuales (ver `docs/PLAN-OPTIMUSTOOLS.md`).
 */

export type DeviceClass = "desktop" | "constrained";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MIN = 60;

export type Limits = {
  /** A partir de aqui se avisa de que puede tardar o quedarse sin memoria. */
  warnInputBytes: number;
  /** Por encima se rechaza el original. */
  maxInputBytes: number;
  /** Por encima se rechaza el resultado estimado (se propone bajar calidad o resolucion). */
  maxOutputBytes: number;
  warnDurationSec: number;
  maxDurationSec: number;
};

export const LIMITS: Record<DeviceClass, Limits> = {
  desktop: {
    warnInputBytes: 500 * MB,
    maxInputBytes: 4 * GB,
    maxOutputBytes: 1024 * MB,
    warnDurationSec: 30 * MIN,
    maxDurationSec: 2 * 60 * MIN,
  },
  constrained: {
    warnInputBytes: 200 * MB,
    maxInputBytes: 1 * GB,
    maxOutputBytes: 250 * MB,
    warnDurationSec: 10 * MIN,
    maxDurationSec: 30 * MIN,
  },
};

export type DeviceEnv = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  /** `navigator.deviceMemory` (GB, solo Chromium; redondeado a potencias de 2 y topado en 8). */
  deviceMemory?: number;
};

/**
 * iPhone, iPad (tambien el que se presenta como Mac: `MacIntel` con pantalla tactil) y Android/otros con 4 GB o menos.
 * Safari de escritorio y los navegadores de PC siguen siendo «desktop».
 */
export function detectDeviceClass(env: DeviceEnv): DeviceClass {
  const ua = env.userAgent ?? "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "constrained";
  if (env.platform === "MacIntel" && (env.maxTouchPoints ?? 0) > 1) return "constrained";
  if (/Android/i.test(ua)) return "constrained";
  if (typeof env.deviceMemory === "number" && env.deviceMemory > 0 && env.deviceMemory <= 4) return "constrained";
  return "desktop";
}

export function browserDeviceClass(): DeviceClass {
  if (typeof navigator === "undefined") return "desktop";
  const nav = navigator as Navigator & { deviceMemory?: number };
  return detectDeviceClass({
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    deviceMemory: nav.deviceMemory,
  });
}
