export function parseAllowedUserIds(raw: string | undefined): Set<string> {
  const ids = (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!ids.length) throw new Error('TELEGRAM_ALLOWED_USER_IDS must contain at least one numeric user id');
  if (ids.some((id) => !/^[1-9][0-9]{0,19}$/.test(id))) throw new Error('TELEGRAM_ALLOWED_USER_IDS contains an invalid user id');
  return new Set(ids);
}

export function isAuthorized(allowed: ReadonlySet<string>, userId: number | undefined): boolean {
  return userId !== undefined && Number.isSafeInteger(userId) && allowed.has(String(userId));
}
