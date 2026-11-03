/*
 * Gestos del lienzo de Firmar (W3-A3): piezas puras y sin React que usa `DocumentCanvas`.
 *
 *  - Rechazo de palma: mientras el lapiz esta en contacto, o lo estuvo hace menos de `PALM_REJECT_MS`, los toques de DEDO no
 *    crean, no dibujan ni deseleccionan (si el lapiz esta en contacto, ni siquiera cuentan para el pellizco).
 *  - Toque con dedo o lapiz: un dedo que dibuja de inmediato no clava el pulso; el temblor se mide en PIXELES de pantalla
 *    (`TAP_MOVE_THRESHOLD_PX`), no en fraccion de hoja (a 320 px de hoja, 0,4 % son 1,3 px y casi ningun toque lo cumple).
 *  - Dos dedos mueven la pagina: cuanto debe desplazarse la pagina con lo que la hoja ampliada no absorbio.
 *  - Preferencias de interfaz (localStorage, con try/catch: sin almacenamiento todo sigue funcionando).
 */

/** Tiempo (ms) tras soltar el lapiz durante el que un toque de dedo se toma por la palma de la mano. */
export const PALM_REJECT_MS = 500;

/** Un contacto de lapiz sin ninguna actividad durante tanto tiempo se da por perdido (no bloquea los dedos para siempre). */
const PEN_CONTACT_STALE_MS = 3000;

export type PenPhase = "down" | "move" | "up" | "cancel";

export type PenGuard = {
  /** Anota un evento de puntero DE LAPIZ (`pointerType === "pen"`). El movimiento sin contacto (hover) no cuenta. */
  pen: (phase: PenPhase, pointerId: number) => void;
  /** El lapiz toca la pantalla ahora mismo. */
  penInContact: () => boolean;
  /** Un toque de dedo debe ignorarse para crear/dibujar: lapiz en contacto o soltado hace menos de `PALM_REJECT_MS`. */
  rejectsFinger: () => boolean;
};

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createPenGuard(now: () => number = defaultNow): PenGuard {
  /** Contactos de lapiz vivos: id -> ultimo instante con actividad. */
  const down = new Map<number, number>();
  let lastAt = Number.NEGATIVE_INFINITY;

  const dropStale = (t: number) => {
    for (const [id, at] of down) {
      if (t - at > PEN_CONTACT_STALE_MS) down.delete(id);
    }
  };

  return {
    pen(phase, pointerId) {
      const t = now();
      if (phase === "down") {
        down.set(pointerId, t);
        lastAt = t;
      } else if (phase === "move") {
        // Solo el trazo con contacto: un lapiz que se acerca sin tocar no rechaza dedos.
        if (down.has(pointerId)) {
          down.set(pointerId, t);
          lastAt = t;
        }
      } else {
        down.delete(pointerId);
        lastAt = t;
      }
    },
    penInContact() {
      dropStale(now());
      return down.size > 0;
    },
    rejectsFinger() {
      const t = now();
      dropStale(t);
      return down.size > 0 || t - lastAt < PALM_REJECT_MS;
    },
  };
}

/**
 * ¿El recuadro que se acaba de dibujar es en realidad un TOQUE (colocar el elemento por defecto)? Con raton, por la
 * fraccion de hoja de siempre (`clickSlop`). Con dedo o lapiz, ademas, si no se movieron mas de `tapPx` pixeles de pantalla
 * desde donde empezaron: el temblor de un dedo es una cantidad de pixeles constante, sea cual sea el tamano de la hoja.
 */
export function isDraftTap(input: {
  pointerType: string;
  /** Distancia (px de pantalla) entre donde empezo el gesto y donde se solto; `null` si no se sabe. */
  movedPx: number | null;
  /** Lado del recuadro dibujado, en fracciones de la hoja. */
  spanX: number;
  spanY: number;
  clickSlop: number;
  tapPx: number;
}): boolean {
  const byFraction = input.spanX < input.clickSlop && input.spanY < input.clickSlop;
  if (byFraction) return true;
  const touchLike = input.pointerType === "touch" || input.pointerType === "pen";
  return touchLike && input.movedPx !== null && input.movedPx <= input.tapPx;
}

/** Un arrastre de dedo de al menos esta longitud (px), casi vertical, se toma por un intento de desplazar la pagina. */
export const SCROLL_SWIPE_MIN_PX = 48;
const SCROLL_SWIPE_RATIO = 4;

/**
 * Con «Un dedo dibuja» el habito de desplazar la pagina con un dedo dibujaria un campo estrecho y alto. Un arrastre de DEDO
 * largo y casi vertical (el doble de alto que de ancho, cuatro veces) no es un campo que nadie quiera: no se crea y se
 * recuerda que la pagina se mueve con dos dedos. El lapiz y el raton nunca pasan por aqui (son deliberados).
 */
export function isScrollLikeSwipe(input: { pointerType: string; dxPx: number; dyPx: number }): boolean {
  if (input.pointerType !== "touch") return false;
  const dx = Math.abs(input.dxPx);
  const dy = Math.abs(input.dyPx);
  return dy >= SCROLL_SWIPE_MIN_PX && dy >= SCROLL_SWIPE_RATIO * dx;
}

/**
 * Cuanto debe desplazarse la PAGINA (px; positivo = hacia abajo, como `scrollVerticallyBy`) cuando dos dedos se mueven
 * `fingersDy` px en vertical: lo que la hoja ampliada absorbe con su `pan` (`panDy`) se descuenta y el resto, con el dedo
 * subiendo, baja la pagina. Con 1x la hoja no se mueve (`panDy` 0) y la pagina sigue a los dedos. Si en ese mismo gesto
 * cambio el zoom, el `pan` incluye el desplazamiento del foco del pellizco y no se encadena nada.
 */
export function pageScrollForTwoFingers(input: {
  fingersDy: number;
  panDy: number;
  zoomChanged: boolean;
}): number {
  if (input.zoomChanged) return 0;
  const scroll = -(input.fingersDy - input.panDy);
  return scroll === 0 ? 0 : scroll;
}

/* ------------------------------------------------------------------ *
 * Preferencias de interfaz (sin datos personales)
 * ------------------------------------------------------------------ */

/** «Un dedo dibuja»: `"0"` = apagado; cualquier otro valor o ausente = encendido (el modo por defecto). */
export const FINGER_DRAW_PREF_KEY = "optimuspdf.sign.fingerDraw";
/** La pista «Un dedo dibuja · dos dedos mueven la pagina» ya se mostro. */
export const FINGER_HINT_SEEN_KEY = "optimuspdf.sign.fingerDrawHint";
/** Cuanto dura en pantalla la pista de la primera vez (ms). */
export const FINGER_HINT_MS = 6000;

export function readFingerDrawPref(): boolean {
  try {
    return window.localStorage.getItem(FINGER_DRAW_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeFingerDrawPref(on: boolean): void {
  try {
    window.localStorage.setItem(FINGER_DRAW_PREF_KEY, on ? "1" : "0");
  } catch {
    // Sin almacenamiento: la preferencia dura lo que dure la pantalla.
  }
}

export function readFingerHintSeen(): boolean {
  try {
    return window.localStorage.getItem(FINGER_HINT_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markFingerHintSeen(): void {
  try {
    window.localStorage.setItem(FINGER_HINT_SEEN_KEY, "1");
  } catch {
    // Sin almacenamiento: la pista puede volver a salir; no pasa nada.
  }
}
