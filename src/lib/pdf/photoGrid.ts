/**
 * Composicion de varias fotos por hoja («Fotos por pagina» de Imagenes a PDF). Modulo PURO (sin PDF, sin canvas): recibe
 * las proporciones de las fotos y devuelve, hoja a hoja, donde va cada una. Lo usan `imagesToPdf.ts` (generar el PDF),
 * la estimacion de tamano y la vista previa de hojas, asi que las tres coinciden por construccion.
 *
 * Coordenadas: puntos PDF (1 pt = 1/72"), origen ABAJO a la izquierda (`y` es el borde inferior del rectangulo).
 *
 * Reglas (acordadas con la persona usuaria):
 *  - 1 por hoja: una celda que ocupa todo el area util (el comportamiento de siempre; el motor conserva su ruta propia
 *    para «Ajustar» y la orientacion automatica por foto).
 *  - 2 por hoja: una foto ARRIBA y otra ABAJO, las dos al ANCHO UTIL de la hoja (ajustado a su proporcion si no caben a lo
 *    alto: entonces las dos se reducen por igual), centradas, con el espacio libre repartido por igual (arriba, entre ellas
 *    y abajo; nunca menos que el gutter entre ellas).
 *  - 4, 6, 8 y 10: cuadricula de 2 columnas × N/2 filas (maximo 5 filas), celdas IGUALES y simetricas respecto al eje
 *    vertical, con margen y gutter uniformes. Cada foto se ajusta a su celda SIN recortar ni deformar (contain), centrada.
 *  - Ultima hoja con menos fotos: las celdas conservan EL MISMO tamano que en las demas hojas (no se agranda nada). Si
 *    queda una sola foto en la ultima fila se centra en ella; las filas que faltan quedan vacias (las fotos siguen
 *    arriba, como en las otras hojas). En el modo 2, una foto sola se ajusta a la mitad superior de la hoja.
 *  - Orden: el de la lista, de izquierda a derecha y de arriba abajo.
 *  - La orientacion de la hoja: `auto` = vertical con varias fotos (la cuadricula siempre es de 2 columnas); `landscape`
 *    la gira. «Ajustar al tamano de la imagen» no tiene sentido con varias fotos: se usa A4 (`effectivePageSize`).
 */

export const PHOTOS_PER_PAGE_OPTIONS = [1, 2, 4, 6, 8, 10] as const;
export type PhotosPerPage = (typeof PHOTOS_PER_PAGE_OPTIONS)[number];

export function isPhotosPerPage(value: unknown): value is PhotosPerPage {
  return typeof value === "number" && (PHOTOS_PER_PAGE_OPTIONS as readonly number[]).includes(value);
}

/** Separacion fija entre fotos/celdas, en puntos (~4,2 mm). */
export const GRID_GUTTER = 12;

/** Margenes (puntos) de las tres opciones de «Margen»; los lee el motor, la estimacion y la vista previa. */
export const MARGIN_POINTS = { none: 0, small: 24, large: 56 } as const;

/** Hojas estandar en vertical (puntos PostScript, 1 pt = 1/72"). */
export const SHEET_POINTS = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

export type PhotoSize = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

export type PlacedPhoto = {
  /** Posicion de la foto en la lista (0..n-1). */
  index: number;
  /** Donde se dibuja la foto (ya con su proporcion). */
  rect: Rect;
  /** La celda que se le reservo (en el modo 2, la franja de la hoja que le toca: las dos se reparten el area util). */
  cell: Rect;
};

export type SheetLayout = {
  pageWidth: number;
  pageHeight: number;
  /** Margen aplicado en los cuatro lados. */
  margin: number;
  cols: number;
  rows: number;
  /** Indice de la primera foto de la hoja y cuantas lleva. */
  firstPhoto: number;
  photoCount: number;
  photos: PlacedPhoto[];
};

export type PhotoGridOptions = {
  perPage: PhotosPerPage;
  /** Tamano de hoja en vertical (puntos): ancho y alto. */
  pageSize: { width: number; height: number };
  /** `auto` = vertical. */
  orientation: "portrait" | "landscape" | "auto";
  margin: number;
  gutter?: number;
};

/** Columnas y filas de la cuadricula de un valor de `PhotosPerPage` (el 2 es una columna de dos filas). */
export function gridShape(perPage: PhotosPerPage): { cols: number; rows: number } {
  if (perPage === 1) return { cols: 1, rows: 1 };
  if (perPage === 2) return { cols: 1, rows: 2 };
  return { cols: 2, rows: perPage / 2 };
}

/** Numero de hojas para `count` fotos. */
export function sheetCount(count: number, perPage: PhotosPerPage): number {
  return count <= 0 ? 0 : Math.ceil(count / perPage);
}

/** Rango de fotos [first, last] (ambas incluidas, empezando en 0) de la hoja `sheet` (0..). */
export function sheetRange(sheet: number, count: number, perPage: PhotosPerPage): { first: number; last: number } {
  const first = sheet * perPage;
  return { first, last: Math.min(count, first + perPage) - 1 };
}

function safe(size: PhotoSize): PhotoSize {
  const width = Number.isFinite(size.width) && size.width > 0 ? size.width : 1;
  const height = Number.isFinite(size.height) && size.height > 0 ? size.height : 1;
  return { width, height };
}

/** La foto de proporcion `size` ajustada DENTRO de `cell` (sin ampliar mas que la celda), centrada. */
export function containInCell(size: PhotoSize, cell: Rect): Rect {
  const photo = safe(size);
  const scale = Math.min(cell.width / photo.width, cell.height / photo.height);
  const width = photo.width * scale;
  const height = photo.height * scale;
  return { x: cell.x + (cell.width - width) / 2, y: cell.y + (cell.height - height) / 2, width, height };
}

export function pageDimensions(
  pageSize: { width: number; height: number },
  orientation: "portrait" | "landscape" | "auto",
): { width: number; height: number } {
  const short = Math.min(pageSize.width, pageSize.height);
  const long = Math.max(pageSize.width, pageSize.height);
  return orientation === "landscape" ? { width: long, height: short } : { width: short, height: long };
}

/** Composicion de UNA hoja con las fotos `sizes` (entre 1 y `perPage`), cuya primera es la numero `firstPhoto`. */
function layoutSheet(sizes: PhotoSize[], firstPhoto: number, options: PhotoGridOptions): SheetLayout {
  const gutter = options.gutter ?? GRID_GUTTER;
  const { width: pageWidth, height: pageHeight } = pageDimensions(options.pageSize, options.orientation);
  const margin = Math.max(0, Math.min(options.margin, Math.min(pageWidth, pageHeight) / 4));
  const boxWidth = pageWidth - margin * 2;
  const boxHeight = pageHeight - margin * 2;
  const boxX = margin;
  const boxTop = pageHeight - margin;
  const { cols, rows } = gridShape(options.perPage);
  const photos: PlacedPhoto[] = [];
  const count = sizes.length;

  if (options.perPage === 1) {
    const cell: Rect = { x: boxX, y: margin, width: boxWidth, height: boxHeight };
    photos.push({ index: firstPhoto, rect: containInCell(sizes[0], cell), cell });
  } else if (options.perPage === 2) {
    const cellHeight = (boxHeight - gutter) / 2;
    const topCell: Rect = { x: boxX, y: boxTop - cellHeight, width: boxWidth, height: cellHeight };
    if (count === 1) {
      photos.push({ index: firstPhoto, rect: containInCell(sizes[0], topCell), cell: topCell });
    } else {
      const first = safe(sizes[0]);
      const second = safe(sizes[1]);
      const ratioSum = first.height / first.width + second.height / second.width;
      // Las dos al mismo ancho: el util si caben a lo alto; si no, el que hace que quepan (mismo factor para las dos).
      const width = Math.min(boxWidth, (boxHeight - gutter) / ratioSum);
      const firstHeight = (width * first.height) / first.width;
      const secondHeight = (width * second.height) / second.width;
      const free = boxHeight - firstHeight - secondHeight;
      const middle = Math.max(gutter, free / 3);
      const outer = Math.max(0, (free - middle) / 2);
      const x = boxX + (boxWidth - width) / 2;
      const firstY = boxTop - outer - firstHeight;
      const secondY = firstY - middle - secondHeight;
      // Franjas que se reparten la hoja (la linea de corte esta a mitad del espacio entre las dos fotos).
      const cut = firstY - middle / 2;
      photos.push({
        index: firstPhoto,
        rect: { x, y: firstY, width, height: firstHeight },
        cell: { x: boxX, y: cut, width: boxWidth, height: boxTop - cut },
      });
      photos.push({
        index: firstPhoto + 1,
        rect: { x, y: secondY, width, height: secondHeight },
        cell: { x: boxX, y: margin, width: boxWidth, height: cut - margin },
      });
    }
  } else {
    const cellWidth = (boxWidth - gutter) / 2;
    const cellHeight = (boxHeight - gutter * (rows - 1)) / rows;
    for (let position = 0; position < count; position += 1) {
      const row = Math.floor(position / cols);
      const column = position % cols;
      const alone = column === 0 && position === count - 1; // unica de su fila: se centra
      const x = alone ? boxX + (boxWidth - cellWidth) / 2 : boxX + column * (cellWidth + gutter);
      const cell: Rect = { x, y: boxTop - (row + 1) * cellHeight - row * gutter, width: cellWidth, height: cellHeight };
      photos.push({ index: firstPhoto + position, rect: containInCell(sizes[position], cell), cell });
    }
  }

  return { pageWidth, pageHeight, margin, cols, rows, firstPhoto, photoCount: count, photos };
}

/**
 * Compone TODAS las hojas. `photos` son las proporciones (alto y ancho YA girados por la orientacion EXIF) en el orden de
 * la lista; cada hoja toma `perPage` fotos seguidas.
 */
export function layoutPhotoGrid(photos: readonly PhotoSize[], options: PhotoGridOptions): SheetLayout[] {
  const sheets: SheetLayout[] = [];
  const total = sheetCount(photos.length, options.perPage);
  for (let sheet = 0; sheet < total; sheet += 1) {
    const { first, last } = sheetRange(sheet, photos.length, options.perPage);
    sheets.push(layoutSheet(photos.slice(first, last + 1), first, options));
  }
  return sheets;
}

/** Pixeles que necesita una foto para verse a `ppi` puntos por pulgada dentro de `rect` (lado largo). */
export function pixelsNeededForRect(rect: Rect, ppi: number): number {
  return Math.ceil((Math.max(rect.width, rect.height) / 72) * ppi);
}
