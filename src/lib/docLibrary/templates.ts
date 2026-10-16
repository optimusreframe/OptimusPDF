/**
 * Punto de entrada de las PLANTILLAS DE CAMPOS por documento (Fase 2, U2.2). Reexporta todo:
 *
 *   templatesStore   CRUD en IndexedDB, versiones, estado para «Mis documentos», duplicados, reconocimiento por huella
 *   templateTypes    tipos y límites (`DocTemplate`, `Variant`, `TEMPLATE_LIMITS`…)
 *   templateSchema   validación estricta (`parseTemplate`…)
 *   templateRepeat   `repeatInitials`, `applyPageAdjust`
 *   templateApply    `applyTemplate`, `selectVariant`, `cloneTemplate`
 *   templateAuto     `templateFromAutoMap`, `mergeTemplateDrafts`, `reconcileSources`
 *   templateLegacy   `migrateLocalTemplates`, `markMigrated`
 *   dataKeys         registro de orígenes de dato
 */
export * from "./dataKeys";
export * from "./templateTypes";
export { parseContent, parseRect, parseRoles, parseStoredTemplate, parseTemplate, parseVariant } from "./templateSchema";
export * from "./templateRepeat";
export * from "./templateApply";
export * from "./templateAuto";
export * from "./templateLegacy";
export * from "./templatesStore";
