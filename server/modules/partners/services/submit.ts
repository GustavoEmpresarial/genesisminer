/** Migrado de legacy/backend/modules/partners/partnersSubmit.service.ts (verbatim). */
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { countPartnerYoutubeActiveDuplicateVideo, getPartnerAccessLevelIdsLower, insertPartnerYoutubeSubmission, isPartnerYoutubeManualAllowlisted } from './model.js';
import { partnerYoutubeUtcDayKeyYYYYMMDD, userAccessSetHasPartnerLevel } from './helpers.js';
import { validateAndCanonicalYoutubeUrl } from './youtube-url.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const TITLE_MIN_LENGTH = 3;
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 2000;
const PRISMA_UNIQUE_CONSTRAINT_CODE = 'P2002';

function trimTitle(raw: unknown): string {
  return raw != null ? String(raw).trim().slice(0, TITLE_MAX_LENGTH) : '';
}

function trimDescription(raw: unknown): string {
  return raw != null ? String(raw).trim().slice(0, DESCRIPTION_MAX_LENGTH) : '';
}

export async function runPartnerYoutubeSubmitVideo(params: { userId: number; titleRaw: unknown; youtubeUrlRaw: unknown; descriptionRaw: unknown }): Promise<{ id: string }> {
  const title = trimTitle(params.titleRaw);
  if (title.length < TITLE_MIN_LENGTH) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid title (min. 3 characters).', code: 'VALIDATION' });
  }

  const parsed = validateAndCanonicalYoutubeUrl(String(params.youtubeUrlRaw ?? ''));
  if (!parsed) {
    throw new HttpControlledError(HTTP_UNPROCESSABLE, { error: 'Invalid YouTube URL (use only youtube.com, m.youtube.com, or youtu.be).', code: 'INVALID_URL' });
  }

  const idSet = await getPartnerAccessLevelIdsLower(params.userId);
  const manualListed = await isPartnerYoutubeManualAllowlisted(params.userId);
  if (!userAccessSetHasPartnerLevel(idSet) && !manualListed) {
    throw new HttpControlledError(HTTP_FORBIDDEN, { error: 'Only accounts with Partners level or added by admin in YouTube Partners can submit videos.', code: 'NOT_PARTNER' });
  }

  const dup = await countPartnerYoutubeActiveDuplicateVideo(parsed.videoId);
  if (dup > 0) {
    throw new HttpControlledError(HTTP_CONFLICT, { error: 'This video is already in the review queue or showcase. Choose another link.', code: 'DUPLICATE_VIDEO' });
  }

  const description = trimDescription(params.descriptionRaw);
  const dayKey = partnerYoutubeUtcDayKeyYYYYMMDD(Date.now());
  const id = crypto.randomUUID();
  const now = Date.now();

  try {
    await insertPartnerYoutubeSubmission({ id, userId: params.userId, title, youtubeUrl: parsed.canonicalUrl, youtubeVideoId: parsed.videoId, description, createdAt: now, submitUtcDay: dayKey });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === PRISMA_UNIQUE_CONSTRAINT_CODE) {
      throw new HttpControlledError(HTTP_CONFLICT, { error: 'Daily limit of 1 submission (UTC) reached or submission conflict. Try again in a moment.', code: 'DAILY_LIMIT_OR_CONFLICT' });
    }
    throw e;
  }

  return { id };
}
