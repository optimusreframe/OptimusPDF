import { finishCrop, pickCrop } from "@/lib/scan/cropGate";
import { detectDocumentCorners } from "@/lib/scan/documentDetection";
import { detectLiveQuad } from "@/lib/scan/liveDetect";
import type { Rgba } from "@/lib/scan/pixels";
import type { QuadCorners } from "@/lib/scan/perspective";
import type { ScanMode } from "@/lib/scan/types";

/**
 * Busca el documento en una copia reducida: scanic (preciso) + detector ligero, combinados y pasados por la puerta del recorte
 * (solo se recorta si es MUY fiable) y por el ajuste de los lados. Es CPU pura: corre dentro del Web Worker del procesado (la
 * primera hoja costaba una tarea de ~160 ms en el hilo principal) y, si no hay worker, en el hilo principal cediendo el hilo
 * (`yieldNow`) entre fases. Nunca lanza: un fallo del detector es «sin documento».
 */
export async function findDocumentCorners(image: Rgba, mode: ScanMode, yieldNow: () => Promise<void> | void = () => undefined): Promise<QuadCorners | null> {
  // El detector recibe una copia: la imagen decodificada queda intacta para la tarea de render que la reutiliza.
  const found = await detectDocumentCorners(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height));
  await yieldNow();
  const live = detectLiveQuad(image);
  const picked = pickCrop(found ? found.corners : null, live && live.confidence >= 0.9 && live.touchesBorder < 0.05 ? live.quad : null, image, mode, live?.confidence ?? 0);
  if (!picked.candidate || !picked.verdict?.accept) return null;
  await yieldNow();
  return finishCrop(image, picked.candidate, picked.verdict, mode).quad;
}
