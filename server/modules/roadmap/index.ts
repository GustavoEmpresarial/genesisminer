/**
 * Módulo `roadmap`: etapas públicas do roadmap + CRUD/reorder admin.
 */
export { registerRoadmapModuleRoutes } from './controllers/roadmap.controller.js';
export type { RoadmapModuleDeps } from './controllers/roadmap.controller.js';

export { createRoadmapStep, deleteRoadmapStep, listPublishedRoadmap, listRoadmapAdmin, reorderRoadmapSteps, updateRoadmapStep } from './services/roadmap.js';
export type { CreateRoadmapStepInput, RoadmapStepDto, UpdateRoadmapStepInput } from './services/roadmap.js';
