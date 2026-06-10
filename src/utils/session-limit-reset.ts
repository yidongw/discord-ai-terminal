const USAGE_LIMIT_RE =
  /you(?:'ve| have) hit your (?:session|weekly|opus) limit/i;

// "resets 3:45pm" or "resets Mon 12:00am"
const RESET_RE =
  /resets?\s+(?:(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:rs(?:day)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s+)?(\d{1,2}:\d{2}\s*(?:am|pm))/i;

const DAY_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export interface SessionLimitReset {
  resetAt: number;
  resetLabel: string;
}

/** True when text looks like a Claude subscription usage-limit message. */
export function isUsageLimitMessage(text: string): boolean {
  return USAGE_LIMIT_RE.test(text);
}

/**
 * Parse the reset time from a Claude usage-limit message, e.g.
 * "You've hit your session limit · resets 3:45pm".
 * Returns null when the limit is mentioned but no reset time is found.
 */
export function parseSessionLimitReset(text: string, now = new Date()): SessionLimitReset | null {
  if (!isUsageLimitMessage(text)) return null;

  const resetMatch = text.match(RESET_RE);
  if (!resetMatch) return null;

  const dayToken = resetMatch[1]?.slice(0, 3).toLowerCase();
  const clockToken = resetMatch[2]!;
  const clock = parseClock(clockToken);
  if (!clock) return null;

  const resetDate = dayToken
    ? nextWeekdayAt(dayToken, clock, now)
    : nextTodayOrTomorrowAt(clock, now);

  const resetLabel = resetMatch[0]!.replace(/^resets?\s+/i, "").trim();
  return { resetAt: resetDate.getTime(), resetLabel };
}

/** Pick the earliest ISO reset timestamp from a rate_limit_event payload. */
export function parseRateLimitReset(
  info: { requests_reset?: string; tokens_reset?: string } | undefined,
  now = new Date()
): SessionLimitReset | null {
  if (!info) return null;
  const candidates = [info.requests_reset, info.tokens_reset]
    .filter((v): v is string => !!v)
    .map((iso) => new Date(iso))
    .filter((d) => !Number.isNaN(d.getTime()) && d.getTime() > now.getTime());
  if (candidates.length === 0) return null;
  const resetDate = candidates.reduce((a, b) => (a < b ? a : b));
  return { resetAt: resetDate.getTime(), resetLabel: resetDate.toLocaleString() };
}

function parseClock(token: string): { hours: number; minutes: number } | null {
  const m = token.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  let hours = parseInt(m[1]!, 10);
  const minutes = parseInt(m[2]!, 10);
  const ampm = m[3]!.toLowerCase();
  if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
  if (ampm === "am") {
    if (hours === 12) hours = 0;
  } else if (hours !== 12) {
    hours += 12;
  }
  return { hours, minutes };
}

function nextTodayOrTomorrowAt(clock: { hours: number; minutes: number }, now: Date): Date {
  const candidate = new Date(now);
  candidate.setHours(clock.hours, clock.minutes, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function nextWeekdayAt(dayToken: string, clock: { hours: number; minutes: number }, now: Date): Date {
  const target = DAY_INDEX[dayToken.slice(0, 3).toLowerCase()];
  if (target === undefined) return nextTodayOrTomorrowAt(clock, now);

  const candidate = new Date(now);
  candidate.setHours(clock.hours, clock.minutes, 0, 0);
  let delta = (target - candidate.getDay() + 7) % 7;
  if (delta === 0 && candidate.getTime() <= now.getTime()) delta = 7;
  candidate.setDate(candidate.getDate() + delta);
  return candidate;
}
