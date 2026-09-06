/**
 * Printable per-unit code for `item_instances.code`.
 * Same string as Rust `instance_code(catalog, id)`: `{catalog}{SEP}{uuid-canonical}`.
 * UUID is hyphenated lowercase (RFC 4122 / `crypto.randomUUID()`).
 */

/** Prisma `item_instances.catalog_item_id` `@db.VarChar(200)`. */
export const ITEM_INSTANCE_CATALOG_ID_MAX_LEN = 200;

/** RFC 4122 hyphenated lowercase UUID text length. */
export const UUID_HYPHENATED_TEXT_LEN = 36;

/** Separator between catalog SKU and unit UUID. */
export const ITEM_INSTANCE_CODE_SEP = ':' as const;

/** catalog(200) + sep + uuid(36) = Prisma `@db.VarChar(237)`. */
export const ITEM_INSTANCE_CODE_MAX_LEN =
  ITEM_INSTANCE_CATALOG_ID_MAX_LEN + ITEM_INSTANCE_CODE_SEP.length + UUID_HYPHENATED_TEXT_LEN;

/** `{catalog}:{uuid}` — same format as Rust `instance_code`. */
export function instanceCode(catalog: string, id: string): string {
  return `${catalog}${ITEM_INSTANCE_CODE_SEP}${id}`;
}
