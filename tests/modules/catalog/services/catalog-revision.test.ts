/**
 * OCC do catálogo upgrades — revision lock / compare / bump.
 */
import { describe, expect, it } from 'vitest';
import { HttpControlledError } from '../../../../server/shared/errors/http-controlled-error.js';
import {
  CATALOG_VERSION_CONFLICT,
  assertCatalogRevisionMatches,
  parseExpectedCatalogRevision
} from '../../../../server/modules/catalog/services/catalog-revision.js';

describe('catalog-revision', () => {
  it('parseExpectedCatalogRevision aceita número', () => {
    expect(parseExpectedCatalogRevision(42)).toBe(42);
    expect(parseExpectedCatalogRevision('7')).toBe(7);
  });

  it('parseExpectedCatalogRevision rejeita ausente', () => {
    expect(() => parseExpectedCatalogRevision(undefined)).toThrow(HttpControlledError);
    try {
      parseExpectedCatalogRevision(null);
    } catch (e) {
      expect((e as HttpControlledError).jsonBody.code).toBe('CATALOG_REVISION_REQUIRED');
    }
  });

  it('assertCatalogRevisionMatches: match OK', () => {
    expect(() => assertCatalogRevisionMatches(42, 42)).not.toThrow();
  });

  it('assertCatalogRevisionMatches: stale → CATALOG_VERSION_CONFLICT', () => {
    try {
      assertCatalogRevisionMatches(43, 42);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpControlledError);
      expect((e as HttpControlledError).statusCode).toBe(409);
      expect((e as HttpControlledError).jsonBody.code).toBe(CATALOG_VERSION_CONFLICT);
      expect((e as HttpControlledError).jsonBody.forceReload).toBe(true);
      expect((e as HttpControlledError).jsonBody.catalogRevision).toBe(43);
    }
  });
});
