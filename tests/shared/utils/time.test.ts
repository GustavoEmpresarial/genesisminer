import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '../../../server/shared/utils/time.js';

describe('shared/utils/time', () => {
  it('MS_PER_SECOND é 1000', () => {
    expect(MS_PER_SECOND).toBe(1000);
  });

  it('MS_PER_MINUTE é 60 segundos', () => {
    expect(MS_PER_MINUTE).toBe(60 * MS_PER_SECOND);
  });

  it('MS_PER_HOUR é 60 minutos', () => {
    expect(MS_PER_HOUR).toBe(60 * MS_PER_MINUTE);
  });

  it('MS_PER_DAY é 24 horas', () => {
    expect(MS_PER_DAY).toBe(24 * MS_PER_HOUR);
  });

  it('valores absolutos batem com o esperado (regressão contra erro de digitação)', () => {
    expect(MS_PER_SECOND).toBe(1000);
    expect(MS_PER_MINUTE).toBe(60_000);
    expect(MS_PER_HOUR).toBe(3_600_000);
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});
