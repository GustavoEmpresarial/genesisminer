export { registerImageAssetModuleRoutes, type ImageAssetModuleDeps } from './controllers/image-asset.controller.js';
export {
  IMG_ADMIN_TARGET_SUBFOLDERS,
  IMG_ADMIN_TARGET_SUBFOLDER_SET,
  IMG_CANONICAL_SUBFOLDERS,
  IMG_FLAT_NAME_LOOKUP_SUBFOLDERS,
  IMG_LEGACY_FOLDER_ALIASES,
  buildStoredUploadFilename,
  classifyImageSubfolder,
  organizeLooseFilesInImgRoot,
  reclassifyFilesInDirectory,
  resolveLegacyFlatImgFilePath,
  sanitizeOriginalNameBase,
  type ImgAdminTargetSubfolder,
  type ImgCanonicalSubfolder
} from './services/image-asset-model.js';
export { isConvertibleRasterExt, publicPathToWebp, webpSiblingPath } from './services/webp-paths.js';
export { convertRasterFileToWebp, type ConvertRasterFileToWebpResult } from './services/webp-convert.js';
export { compressMediaFileInPlace } from './services/compress-media.js';
export { assertImageFileMagicBytes } from './services/magic-bytes.js';
export { mountImageStaticMiddleware, runImageRootStartupOrganizeIfEnabled } from './services/static-serving.js';
