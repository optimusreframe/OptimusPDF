/**
 * Contrato de tipos compartido de la Wave 5 (edicion del texto existente).
 *
 * Lo consumen tres modulos que se construyen por separado:
 *  - `textBlocks.ts`  (extrae bloques de texto con pdfjs),
 *  - `editFonts.ts` / `editTextExport.ts` (catalogo de fuentes y exportacion),
 *  - `src/app/edit-pdf/editSession.ts` (operaciones, deshacer/rehacer, borradores).
 *
 * Solo se amplia con cambios ADITIVOS. Todas las coordenadas de bloques y
 * ediciones estan en el ESPACIO DE USUARIO de la pagina PDF (puntos, origen
 * abajo a la izquierda, sin rotar), el mismo que devuelve pdfjs en
 * `getTextContent().items[].transform` y que consume `getPageGeometry` /
 * `viewPointToUser` de `core.ts`.
 */

/** Caja en espacio de usuario PDF: (x, y) es la esquina inferior izquierda. */
export type UserBox = { x: number; y: number; width: number; height: number };

export type FontFamilyKind = "sans" | "serif" | "mono";

/** Lo que se sabe de la fuente original de un bloque (viene de pdfjs). */
export type SourceFontInfo = {
  /** Nombre BaseFont tal cual en el PDF (p. ej. "ABCDEF+LiberationSans-Bold"). */
  pdfName: string;
  family: FontFamilyKind;
  bold: boolean;
  italic: boolean;
  /** Subconjunto embebido (prefijo ABCDEF+): no se pueden anadir glifos nuevos. */
  subset: boolean;
  embedded: boolean;
  symbolic: boolean;
  type3: boolean;
};

export type BlockReadOnlyReason =
  | "no-unicode" // sin ToUnicode fiable: el texto extraido no es legible
  | "type3"
  | "invisible" // capa OCR / render mode 3
  | "symbolic"
  | "vertical";

export type TextAlign = "left" | "center" | "right";

/** Una linea visual dentro de un bloque. */
export type TextLine = {
  text: string;
  /** Caja de la linea en espacio de usuario. */
  box: UserBox;
  /** Linea base (y) en espacio de usuario. */
  baseline: number;
  /**
   * (Adicion W5-U1) Punto de la linea base donde empieza la linea, en
   * espacio de usuario. Para texto girado `box` es la caja envolvente y
   * este punto + `length` + `rotation` del bloque dan la linea exacta.
   */
  origin?: { x: number; y: number };
  /** (Adicion W5-U1) Largo de la linea medido a lo largo del texto, en puntos. */
  length?: number;
};

/**
 * (Adicion W5-U1) Rectangulo ORIENTADO de un bloque: esquina inferior
 * izquierda del texto (antes de girar), ancho a lo largo del texto y alto
 * perpendicular. Con `rotation` = 0 coincide con `box`. Para texto girado,
 * `box` es la caja envolvente (la que se ve y se pincha) y este es el
 * rectangulo real: lo que hace falta para cubrir y redibujar con giro.
 */
export type OrientedBox = {
  origin: { x: number; y: number };
  width: number;
  height: number;
};

/**
 * (Adicion W5-U2 · D1) Rectangulo de cobertura ORIENTADO: como `OrientedBox`
 * mas el giro (grados antihorarios) con el que se dibuja desde `origin`. Solo
 * se usa si el texto original esta girado un angulo que NO es multiplo de 90:
 * la caja envolvente taparia texto vecino.
 */
export type CoverOriented = OrientedBox & { rotation: number };

/** Bloque de texto editable detectado en una pagina. */
export type TextBlock = {
  /** Estable dentro de una sesion: `p<pagina>-b<indice>`. */
  id: string;
  pageIndex: number;
  box: UserBox;
  text: string;
  lines: TextLine[];
  /** Tamano de fuente en puntos. */
  fontSize: number;
  /** Color de relleno "#rrggbb". */
  color: string;
  /** Rotacion del texto en grados (0, 90, 180, 270 o libre). */
  rotation: number;
  align: TextAlign;
  font: SourceFontInfo;
  editable: boolean;
  readOnlyReason?: BlockReadOnlyReason;
  /** Huella corta del texto original para detectar bloques desplazados. */
  origHash: string;
  /** (Adicion W5-U1) Rectangulo orientado exacto; ver `OrientedBox`. */
  orientedBox?: OrientedBox;
  /** (Adicion W5-U1) Interlineado medio como multiplo del tamano (solo con 2+ lineas). */
  lineHeight?: number;
  /** (Adicion W5-U1) Superindice/subindice: va como bloque aparte. */
  script?: "superscript" | "subscript";
  /**
   * (Adicion W5-fix) Hay mas de un estilo (color, negrita, cursiva o
   * fuente) dentro del bloque: `color`/`font` son los del estilo dominante y
   * redibujar el bloque unifica el estilo. Solo existe cuando es `true`.
   */
  mixedStyle?: boolean;
};

/** Claves del catalogo de fuentes con las que se REDIBUJA el texto. */
export type CatalogFontKey =
  | "helvetica"
  | "times"
  | "courier"
  | "liberation-sans"
  | "liberation-serif"
  | "liberation-mono";

/** Como se cubre el texto original antes de redibujar. */
export type CoverSpec = {
  /** "#rrggbb" muestreado del fondo, o null para no cubrir (texto nuevo). */
  color: string | null;
  /** Margen extra (puntos) alrededor de la caja a cubrir. */
  padding: number;
  /**
   * ADITIVO (W5-U5). `false` si el fondo muestreado NO era de un solo color
   * (degradado, foto, tabla): la exportacion avisa `background-not-uniform`.
   * Ausente = liso o elegido a mano (al elegir el color se descarta).
   */
  uniform?: false;
};

/**
 * Edicion de texto lista para exportar. Si `blockId` esta definido reemplaza
 * un bloque existente (cubre y redibuja); si no, es texto nuevo.
 */
export type TextEdit = {
  id: string;
  blockId?: string;
  pageIndex: number;
  /** Caja destino en espacio de usuario (el texto se ajusta a su ancho). */
  box: UserBox;
  /** Caja del texto ORIGINAL a cubrir (solo si reemplaza un bloque). */
  coverBox?: UserBox;
  /**
   * ADITIVO (W5-U2 · D1). Cobertura orientada del texto original girado un
   * angulo libre. Si esta, la exportacion y la vista previa cubren ESTE
   * rectangulo girado y no `coverBox` (que sigue siendo su caja envolvente).
   */
  coverOriented?: CoverOriented;
  text: string;
  fontSize: number;
  color: string;
  align: TextAlign;
  fontKey: CatalogFontKey;
  bold: boolean;
  italic: boolean;
  rotation: number;
  cover: CoverSpec;
  /** Interlineado como multiplo del tamano (por defecto 1.2). */
  lineHeight?: number;
  /**
   * ADITIVO (W5-U2 · N4 de B3). Franjas de BORDE FINO (<= 3 pt, bordes de celda de
   * tabla) alrededor del bloque, con 0,5 pt de holgura: la cobertura no entra en
   * ellas (si no, borraria tramos del borde). Las anota quien muestrea el fondo.
   */
  coverClip?: UserBox[];
  /**
   * ADITIVO (W5-U2 · B-mayor 2). Cajas de los bloques vecinos (espacio de
   * usuario) que el texto nuevo NO debe pisar. Las anota quien crea la edicion
   * (conoce los bloques de la pagina); la exportacion avisa `overlap` si el
   * texto dibujado las invade.
   */
  obstacles?: Array<{ id: string; box: UserBox }>;
  /**
   * ADITIVO (W5-U2). Fuente del bloque original; la exportacion la usa para
   * avisar `font-substituted` cuando la fuente elegida es una sustitucion
   * aproximada de ella (`mapSourceFont(...).exact === false`). Si falta, no
   * se emite ese aviso.
   */
  sourceFont?: SourceFontInfo;
  /**
   * ADITIVO (W5-U5 · N4). El bloque original mezclaba estilos (color, negrita, fuente...) y la edicion los unifica: el
   * editor lo avisa y la lista de descarga debe contarlo igual. Solo existe cuando es `true`.
   */
  mixedStyle?: true;
};

/** Un aviso no bloqueante que la interfaz muestra junto al bloque. */
export type EditWarning =
  | { kind: "font-substituted"; from: string; to: CatalogFontKey }
  | { kind: "glyph-missing"; chars: string[]; fallbackKey?: CatalogFontKey }
  | { kind: "background-not-uniform" }
  | { kind: "original-text-remains" }
  /** ADITIVO (W5-U2 · B-mayor 2): el texto nuevo invade a otro bloque de texto. */
  | { kind: "overlap"; with?: string }
  /**
   * ADITIVO (W5-U2 · N3): el texto original girado cruza la caja de OTRO bloque.
   * La cobertura no lo borra (se deja un hueco), asi que bajo ese hueco queda
   * visible un resto del texto original.
   */
  | { kind: "cover-overlaps-neighbor"; with: string }
  /** ADITIVO (W5-U2 · D14): aplanar la pagina descarta formularios o marcadores. */
  | { kind: "flatten-drops-forms"; forms: boolean; outlines: boolean }
  /** ADITIVO (W5-U2 · N8): la edicion no se pudo dibujar y se omitio (numeros no finitos, pagina inexistente...). */
  | { kind: "edit-skipped"; reason: "page" | "font-size" | "text" | "geometry" };
