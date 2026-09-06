import { describe, expect, it } from 'vitest';
import {
  AnnouncementValidationError,
  parseAnnouncementId,
  parseCreateInput,
  parseIsActive,
  parseOptionalHttpsLink,
  parseOptionalScheduleMs,
  parseOptionalSelfImagePath,
  parsePlainMessage,
  parsePlainTitle,
  parsePriority,
  parseUpdateInput,
  validateScheduleRange
} from '../../../../server/modules/announcements/services/validation.js';

describe('parsePlainTitle / parsePlainMessage', () => {
  it('remove zero-width/bidi e caracteres de controle, aparam espaços', () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    expect(parsePlainTitle(`  Ola${zeroWidthSpace} mundo  `)).toBe('Ola mundo');
  });

  it('rejeita vazio', () => {
    expect(() => parsePlainTitle('')).toThrow(AnnouncementValidationError);
    expect(() => parsePlainMessage(null)).toThrow(AnnouncementValidationError);
  });

  it('rejeita <script> ou esquema perigoso', () => {
    expect(() => parsePlainTitle('<script>alert(1)</script>')).toThrow();
    expect(() => parsePlainMessage('javascript:alert(1)')).toThrow();
  });

  it('trunca no tamanho máximo', () => {
    const long = 'a'.repeat(200);
    expect(parsePlainTitle(long).length).toBe(120);
  });
});

describe('parseOptionalHttpsLink', () => {
  it('null/vazio devolve null', () => {
    expect(parseOptionalHttpsLink(null)).toBeNull();
    expect(parseOptionalHttpsLink('')).toBeNull();
  });

  it('aceita https válido', () => {
    expect(parseOptionalHttpsLink('https://example.com/x')).toBe('https://example.com/x');
  });

  it('rejeita http (não-https), javascript:, e URL com credenciais', () => {
    expect(() => parseOptionalHttpsLink('http://example.com')).toThrow();
    expect(() => parseOptionalHttpsLink('javascript:alert(1)')).toThrow();
    expect(() => parseOptionalHttpsLink('https://user:pass@example.com')).toThrow();
  });
});

describe('parseOptionalSelfImagePath', () => {
  it('null/vazio devolve null', () => {
    expect(parseOptionalSelfImagePath(null)).toBeNull();
  });

  it('aceita path interno válido (/img/uploads/x.png)', () => {
    expect(parseOptionalSelfImagePath('/img/uploads/abc123.png')).toBe('/img/uploads/abc123.png');
  });

  it('rejeita URL externa, data:, path traversal', () => {
    expect(() => parseOptionalSelfImagePath('https://evil.com/x.png')).toThrow();
    expect(() => parseOptionalSelfImagePath('data:image/png;base64,xx')).toThrow();
    expect(() => parseOptionalSelfImagePath('/img/../etc/passwd')).toThrow();
  });

  it('erro de imagem inválida tem code INVALID_IMAGE_URL', () => {
    try {
      parseOptionalSelfImagePath('https://evil.com/x.png');
      expect.unreachable();
    } catch (e) {
      expect((e as AnnouncementValidationError).code).toBe('INVALID_IMAGE_URL');
    }
  });
});

describe('parsePriority', () => {
  it('clampa em [0, 1000], default 0', () => {
    expect(parsePriority(undefined)).toBe(0);
    expect(parsePriority(-5)).toBe(0);
    expect(parsePriority(99999)).toBe(1000);
    expect(parsePriority(50)).toBe(50);
  });
});

describe('parseIsActive', () => {
  it('interpreta boolean/1/0/string, default quando ausente', () => {
    expect(parseIsActive(undefined, true)).toBe(true);
    expect(parseIsActive(undefined, false)).toBe(false);
    expect(parseIsActive(false)).toBe(false);
    expect(parseIsActive('0')).toBe(false);
    expect(parseIsActive(1)).toBe(true);
  });
});

describe('parseOptionalScheduleMs / validateScheduleRange', () => {
  it('null/vazio devolve null', () => {
    expect(parseOptionalScheduleMs(null)).toBeNull();
  });

  it('rejeita valor fora do intervalo', () => {
    expect(() => parseOptionalScheduleMs(-1)).toThrow();
    expect(() => parseOptionalScheduleMs(1e20)).toThrow();
  });

  it('validateScheduleRange rejeita fim antes do início', () => {
    expect(() => validateScheduleRange(2000, 1000)).toThrow();
  });

  it('validateScheduleRange aceita null/undefined em qualquer lado', () => {
    expect(() => validateScheduleRange(null, null)).not.toThrow();
    expect(() => validateScheduleRange(1000, null)).not.toThrow();
  });
});

describe('parseAnnouncementId', () => {
  it('aceita UUID v4 válido, normaliza pra minúsculas', () => {
    const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    expect(parseAnnouncementId(id.toUpperCase())).toBe(id);
  });

  it('rejeita não-UUID', () => {
    expect(() => parseAnnouncementId('nao-e-uuid')).toThrow(AnnouncementValidationError);
  });
});

describe('parseCreateInput / parseUpdateInput', () => {
  it('parseCreateInput monta o objeto completo com defaults', () => {
    const out = parseCreateInput({ title: 'T', message: 'M' });
    expect(out).toMatchObject({ title: 'T', message: 'M', link: null, imageUrl: null, priority: 0, isActive: true, startsAt: null, endsAt: null });
  });

  it('parseUpdateInput só inclui os campos presentes no body', () => {
    const out = parseUpdateInput({ title: 'Novo título' });
    expect(out).toEqual({ title: 'Novo título' });
  });

  it('parseUpdateInput aceita snake_case como alias', () => {
    const out = parseUpdateInput({ is_active: false });
    expect(out).toEqual({ isActive: false });
  });
});
