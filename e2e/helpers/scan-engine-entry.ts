/**
 * Punto de entrada que Vite empaqueta (IIFE) para inyectar el motor del Escaner (E1) en una pagina REAL de la app y probarlo en
 * Chromium y WebKit sin la interfaz definitiva: el motor real (`realEngine`), la cola de procesado con su Web Worker, la
 * sesion persistente (IndexedDB) y el OCR sustituible (sin red). Solo para las pruebas E2E; no forma parte del producto.
 */
export { realEngine } from "../../src/lib/scan/realEngine";
export { setOcrRecognizerFactory } from "../../src/lib/scan/ocr";
export { renderStats, setScanWorkerFactory, disposeScanWorker } from "../../src/lib/scan/renderBrowser";
export { analyzeLiveFrame, createFrameTracker } from "../../src/lib/scan/liveFrame";
export { quadIoU } from "../../src/lib/scan/geometry";
export { DEFAULT_SCAN_SETTINGS } from "../../src/lib/scan/types";
export {
  SCAN_DB_NAME,
  SCAN_SESSION_TTL_MS,
  __resetScanStoreMemoryForTests,
  __setScanTabIdForTests,
  clearScanSessions,
  isValidScanSessionId,
  listScanSessionSummaries,
  newScanSessionId,
  scanSessionStore,
  subscribeToScanSessions,
} from "../../src/lib/scan/sessionStore";
export { areDuplicates, comparePages, computeSignature } from "../../src/lib/scan/similarity";
export { enqueueTask } from "../../src/lib/scan/renderBrowser";
export { __analysisCacheForTests } from "../../src/lib/scan/realEngine";
export { chooseCorners, detectDocumentCorners, edgeSupport } from "../../src/lib/scan/documentDetection";
export { detectLiveQuad } from "../../src/lib/scan/liveDetect";
