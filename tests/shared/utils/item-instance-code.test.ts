import { describe, expect, it } from 'vitest';
import {
  ITEM_INSTANCE_CATALOG_ID_MAX_LEN,
  ITEM_INSTANCE_CODE_MAX_LEN,
  ITEM_INSTANCE_CODE_SEP,
  instanceCode,
  UUID_HYPHENATED_TEXT_LEN
} from '../../../server/shared/utils/item-instance-code.js';

describe('shared/utils/item-instance-code', () => {
  it('matches Rust instance_code format and max length', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(instanceCode('asic_dolar_f2p', id)).toBe(
      'asic_dolar_f2p:550e8400-e29b-41d4-a716-446655440000'
    );
    expect(UUID_HYPHENATED_TEXT_LEN).toBe(36);
    expect(ITEM_INSTANCE_CODE_SEP).toBe(':');
    expect(ITEM_INSTANCE_CATALOG_ID_MAX_LEN).toBe(200);
    expect(ITEM_INSTANCE_CODE_MAX_LEN).toBe(
      ITEM_INSTANCE_CATALOG_ID_MAX_LEN + ITEM_INSTANCE_CODE_SEP.length + UUID_HYPHENATED_TEXT_LEN
    );
    expect(ITEM_INSTANCE_CODE_MAX_LEN).toBe(237);
    expect(id.length).toBe(UUID_HYPHENATED_TEXT_LEN);
    expect(instanceCode('a'.repeat(ITEM_INSTANCE_CATALOG_ID_MAX_LEN), id).length).toBe(
      ITEM_INSTANCE_CODE_MAX_LEN
    );
  });
});
