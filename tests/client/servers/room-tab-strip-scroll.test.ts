/**
 * Scroll horizontal da strip de abas de sala — centra a aba activa por cálculo
 * directo de `scrollLeft` (sem `scrollIntoView`, que subiria a página).
 */
import { describe, expect, it } from 'vitest';
import { nextHorizontalScrollLeft } from '../../../client/src/features/servers/models/serverRoomModel.js';

const STRIP_CLIENT_WIDTH = 200;
const CHILD_WIDTH = 40;
const SCROLL_IDLE = 0;
const SCROLL_KEPT = 80;

const MID_CHILD_OFFSET = 100;
const MID_CHILD_WIDTH = 50;
/** 100 - (200 - 50) / 2 */
const CENTERED_SCROLL_FOR_MID_CHILD = 25;

const LEFT_CHILD_OFFSET = 20;
const RIGHT_CHILD_OFFSET = 180;
/** 180 - (200 - 40) / 2 */
const CENTERED_SCROLL_FOR_RIGHT_CHILD = 100;

const UNMEASURED_STRIP_WIDTH = 0;
const UNMEASURED_CHILD_OFFSET = 50;
/** 50 - (0 - 40) / 2 */
const CENTERED_SCROLL_UNMEASURED_STRIP = 70;

describe('nextHorizontalScrollLeft', () => {
  it('centra a aba activa, qualquer que seja o scroll actual', () => {
    expect(
      nextHorizontalScrollLeft(SCROLL_IDLE, STRIP_CLIENT_WIDTH, MID_CHILD_OFFSET, MID_CHILD_WIDTH)
    ).toBe(CENTERED_SCROLL_FOR_MID_CHILD);
    expect(
      nextHorizontalScrollLeft(SCROLL_KEPT, STRIP_CLIENT_WIDTH, MID_CHILD_OFFSET, MID_CHILD_WIDTH)
    ).toBe(CENTERED_SCROLL_FOR_MID_CHILD);
  });

  it('aba antes do centro: clamp em 0 (nunca scroll negativo)', () => {
    expect(
      nextHorizontalScrollLeft(SCROLL_KEPT, STRIP_CLIENT_WIDTH, LEFT_CHILD_OFFSET, CHILD_WIDTH)
    ).toBe(SCROLL_IDLE);
  });

  it('aba à direita: alinha ao centro da strip', () => {
    expect(
      nextHorizontalScrollLeft(SCROLL_IDLE, STRIP_CLIENT_WIDTH, RIGHT_CHILD_OFFSET, CHILD_WIDTH)
    ).toBe(CENTERED_SCROLL_FOR_RIGHT_CHILD);
  });

  it('strip ainda sem largura medida: alvo só depende da aba (scroll actual não propaga)', () => {
    expect(
      nextHorizontalScrollLeft(SCROLL_KEPT, UNMEASURED_STRIP_WIDTH, UNMEASURED_CHILD_OFFSET, CHILD_WIDTH)
    ).toBe(CENTERED_SCROLL_UNMEASURED_STRIP);
    expect(
      nextHorizontalScrollLeft(Number.NaN, UNMEASURED_STRIP_WIDTH, UNMEASURED_CHILD_OFFSET, CHILD_WIDTH)
    ).toBe(CENTERED_SCROLL_UNMEASURED_STRIP);
  });
});
