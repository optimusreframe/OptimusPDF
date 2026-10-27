/**
 * Lista de operadores de pdf.js compartida entre las tres pasadas del orquestador (imagenes, anotaciones y hechos de pagina): cada
 * `getOperatorList()` hace que pdf.js decodifique las imagenes de la pagina en su worker y que el hilo principal reciba (y deserialice)
 * toda la lista, asi que pedirla tres veces triplicaba el trabajo y la memoria. Se guarda hasta un presupuesto de operadores: una pagina
 * patologica (120 000 curvas) no se retiene y las pasadas siguientes la piden de nuevo (como antes).
 */

export type OperatorListLike = { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> };
type OperatorListPage = { getOperatorList(options?: unknown): Promise<unknown> };

/** Operadores que se guardan como mucho en total (unos 100-200 MB de listas de contenido tipico). */
export const OPERATOR_LIST_BUDGET = 400_000;

export class OperatorListCache {
  private readonly entries = new Map<number, OperatorListLike>();
  private used = 0;
  constructor(private readonly budget: number = OPERATOR_LIST_BUDGET) {}

  /** Lista de la pagina SIN anotaciones (`annotationMode: 0`): la de la cache o la que pide ahora. */
  async get(page: OperatorListPage, pageIndex: number): Promise<OperatorListLike> {
    const hit = this.entries.get(pageIndex);
    if (hit) return hit;
    const list = (await page.getOperatorList({ annotationMode: 0 } as never)) as OperatorListLike;
    const size = list.fnArray.length;
    if (this.used + size <= this.budget) {
      this.entries.set(pageIndex, list);
      this.used += size;
    }
    return list;
  }

  /** Libera todo (al terminar la busqueda). */
  clear(): void {
    this.entries.clear();
    this.used = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}
