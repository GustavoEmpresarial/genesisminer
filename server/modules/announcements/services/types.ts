/**
 * DTOs de avisos no jogo. Renomeado com o módulo em DECISIONS.md #59.
 */
import type { ValidatedCreateAnnouncement, ValidatedUpdateAnnouncement } from './validation.js';

export type AnnouncementDto = {
  id: string;
  title: string;
  message: string;
  link: string | null;
  imageUrl: string | null;
  priority: number;
  createdAt: number;
};

export type AnnouncementAdminDto = AnnouncementDto & {
  isActive: boolean;
  startsAt: number | null;
  endsAt: number | null;
  createdBy: number | null;
  readCount: number;
};

export type CreateAnnouncementInput = ValidatedCreateAnnouncement;
export type UpdateAnnouncementInput = ValidatedUpdateAnnouncement;
