/** YouTube partner link helpers (showcase cards). */

export function youtubeThumbUrl(videoId: string): string {
  const v = String(videoId || '').trim();
  if (!v) return '';
  return `https://i.ytimg.com/vi/${v}/hqdefault.jpg`;
}

export function channelOpenUrl(channelUrl: string, displayName: string): string {
  const c = String(channelUrl || '').trim();
  if (c) return c;
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${displayName} channel`)}`;
}

/** Direct channel link with subscribe dialog (youtube.com URLs only). */
export function youtubeSubscribeHref(channelUrl: string, displayName: string): string {
  const base = channelOpenUrl(channelUrl, displayName);
  if (!/^https?:\/\/(www\.)?youtube\.com\//i.test(base)) return base;
  return `${base}${base.includes('?') ? '&' : '?'}sub_confirmation=1`;
}

export function isYoutubeChannelHref(href: string): boolean {
  return /^https?:\/\/(www\.)?youtube\.com\//i.test(href);
}
