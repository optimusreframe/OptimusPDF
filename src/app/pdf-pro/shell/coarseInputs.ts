/**
 * (M2 · SC-04) Campos de texto de los paneles de herramienta (Proteger, Convertir, Metadatos, numeros de pagina...) con 16 px
 * o mas cuando el puntero es un dedo: por debajo, Safari de iPhone acerca la pagina al enfocarlos y no la devuelve. Se aplica
 * al CONTENEDOR del panel (los campos vienen de `OptionControls`, compartido con todas las herramientas) y NO al editor de la
 * hoja, cuyo texto en linea debe medir lo que mide el PDF. Casillas, interruptores y selectores de archivo quedan como estan.
 */
export const COARSE_INPUT_CLASSES =
  "pointer-coarse:[&_input:not([type=checkbox],[type=radio],[type=range],[type=file],[type=hidden])]:text-base pointer-coarse:[&_select]:text-base pointer-coarse:[&_textarea]:text-base";
