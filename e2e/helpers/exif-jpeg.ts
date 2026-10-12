import { createCanvas } from "@napi-rs/canvas";

/**
 * JPEG sintetico con etiqueta EXIF de orientacion (0x0112) para probar que las paginas respetan como se VE la foto.
 * La mitad IZQUIERDA de la imagen GUARDADA es roja y la DERECHA azul: asi, tras aplicar la orientacion, el color de
 * cada borde de la foto vista dice cuanto se giro (6 = girada 90° a la derecha: el rojo queda ARRIBA).
 */
export function makeExifJpeg(options: { width: number; height: number; orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 }): Buffer {
  const { width, height, orientation } = options;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, Math.floor(width / 2), height);
  context.fillStyle = "#0000ff";
  context.fillRect(Math.floor(width / 2), 0, width - Math.floor(width / 2), height);
  const jpeg = canvas.toBuffer("image/jpeg", 95);
  // APP1/Exif minimo (little endian, una entrada) justo despues de SOI.
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, 42, offset de la IFD
    0x01, 0x00, // una entrada
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // 0x0112 SHORT x1
    0x00, 0x00, 0x00, 0x00, // sin otra IFD
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = body.length + 2;
  const segment = Buffer.from([0xff, 0xe1, length >> 8, length & 255, ...body]);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}
