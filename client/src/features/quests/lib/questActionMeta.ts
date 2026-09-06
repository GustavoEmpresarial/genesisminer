/**
 * Action type → short label (legacy `actionHint`).
 */
export function questActionLabel(actionType: string, t: (key: string) => string): string {
  if (actionType === 'checkin') return t('quests.actionCheckin');
  if (actionType === 'merge') return t('quests.actionMerge');
  if (actionType === 'offerwall') return t('quests.actionOfferwall');
  return actionType;
}
