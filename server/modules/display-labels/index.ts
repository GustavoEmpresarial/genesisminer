export {
  registerDisplayLabelsModuleRoutes,
  type DisplayLabelsModuleDeps
} from './controllers/display-labels.controller.js';
export {
  GAME_NAV_LABEL_SHORT_KEYS,
  UI_DISPLAY_LABEL_KEYS,
  UI_DISPLAY_LABEL_KEY_SET,
  UI_DISPLAY_LABEL_VALUE_MAX,
  type UiDisplayLabelKey
} from './services/keys.js';
export { listAll, upsertBatch } from './services/store.js';
