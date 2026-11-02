import { defaultTreeAdapter, parse } from "parse5";
import { SnapshotError, SNAPSHOT_LIMITS } from "@/lib/htmlSnapshot/types";

/**
 * `parse()` de parse5 con un corte DESDE DENTRO del analizador.
 *
 * Por que: ningun pre-escaner heuristico acota el coste de parse5 con HTML hostil (se evadia con `<div/>`, `<!-->`, `<a x">`,
 * `<svg><title>`, etiquetas de cierre sueltas...) y el analizador es SINCRONO: un temporizador no lo interrumpe. Pero parse5
 * avisa al `treeAdapter` de cada elemento que crea y de cada entrada/salida de la pila de elementos abiertos, asi que se
 * cuenta ahi, que es donde ocurre el coste de verdad:
 *
 *   - profundidad de la pila de elementos abiertos > `maxParseDepth` -> `too-large` (el anidado sin cerrar era cuadratico);
 *   - elementos CREADOS > `maxParseElements` -> `too-large`. `createElement` tambien se llama al RECONSTRUIR los elementos de
 *     formato activos (`<div><b i=1>x</div></x>` repetido clona todos los `<b>` pendientes dentro de cada `<div>` nuevo: coste
 *     y memoria cuadraticos, 9 000 repeticiones = OOM), asi que ese caso se corta tambien.
 * Lo que no pasa por aqui (los atributos de UNA etiqueta, que cuesta el tokenizador) lo acota `preParse.ts`.
 */
export function parseGuarded(html: string) {
  let depth = 0;
  let elements = 0;
  const adapter = {
    ...defaultTreeAdapter,
    createElement(...args: Parameters<typeof defaultTreeAdapter.createElement>) {
      elements += 1;
      if (elements > SNAPSHOT_LIMITS.maxParseElements) throw new SnapshotError("too-large");
      return defaultTreeAdapter.createElement(...args);
    },
    onItemPush() {
      depth += 1;
      if (depth > SNAPSHOT_LIMITS.maxParseDepth) throw new SnapshotError("too-large");
    },
    onItemPop() {
      depth -= 1;
    },
    /**
     * `<html x1>`, `<html x2>`... sueltos: la implementacion por defecto reconstruye un `Set` con TODOS los atributos de
     * `<html>`/`<body>` en cada etiqueta (cuadratico: 30 000 etiquetas = 12,7 s, 60 000 = 56,8 s). Se acota el total al tope de
     * atributos por etiqueta, como si fueran de una sola.
     */
    adoptAttributes(recipient: Parameters<typeof defaultTreeAdapter.adoptAttributes>[0], attrs: Parameters<typeof defaultTreeAdapter.adoptAttributes>[1]) {
      if (recipient.attrs.length + attrs.length > SNAPSHOT_LIMITS.maxAttributesPerTag) throw new SnapshotError("too-large");
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
    },
    /**
     * Foster-parenting (`<table>` con contenido suelto): el adaptador por defecto busca la referencia con `indexOf` DESDE EL
     * PRINCIPIO (O(hermanos): 190 000 comentarios + 99 000 `<img>` tras un `<table>` = 3,6 s). La tabla casi siempre es el ULTIMO hijo:
     * se busca desde el final.
     */
    insertBefore(parent: Parameters<typeof defaultTreeAdapter.insertBefore>[0], node: Parameters<typeof defaultTreeAdapter.insertBefore>[1], reference: Parameters<typeof defaultTreeAdapter.insertBefore>[2]) {
      const index = parent.childNodes.lastIndexOf(reference);
      parent.childNodes.splice(index, 0, node);
      node.parentNode = parent;
    },
    insertTextBefore(parent: Parameters<typeof defaultTreeAdapter.insertTextBefore>[0], text: string, reference: Parameters<typeof defaultTreeAdapter.insertTextBefore>[2]) {
      const index = parent.childNodes.lastIndexOf(reference);
      const previous = parent.childNodes[index - 1];
      if (previous && defaultTreeAdapter.isTextNode(previous)) {
        previous.value += text;
      } else {
        const node = defaultTreeAdapter.createTextNode(text);
        parent.childNodes.splice(index, 0, node);
        node.parentNode = parent;
      }
    },
  };
  return parse(html, { scriptingEnabled: false, treeAdapter: adapter });
}
