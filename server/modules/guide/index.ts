/**
 * Módulo `guide`: guia in-game público (categorias + páginas HTML sanitizado)
 * + CRUD/reorder admin.
 */
export { registerGuideModuleRoutes } from './controllers/guide.controller.js';
export type { GuideModuleDeps } from './controllers/guide.controller.js';

export { createGuideCategory, createGuidePage, deleteGuideCategory, deleteGuidePage, listGuideAdmin, listPublishedGuide, reorderGuideCategories, reorderGuidePages, updateGuideCategory, updateGuidePage } from './services/guide.js';
export type { CreateGuideCategoryInput, CreateGuidePageInput, GuideCategoryDto, GuidePageDto, UpdateGuideCategoryInput, UpdateGuidePageInput } from './services/guide.js';
