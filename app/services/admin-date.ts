export const ADMIN_TIME_ZONE = "Europe/Paris";

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

const parisPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ADMIN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function calendarDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));

  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) return null;

  return { year, month, day };
}

function partsAt(instant: number) {
  const parts = Object.fromEntries(
    parisPartsFormatter
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function parisOffsetAt(instant: number) {
  const parts = partsAt(instant);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return representedAsUtc - Math.floor(instant / 1_000) * 1_000;
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function parisMidnightUtc(date: CalendarDate) {
  const wallClockUtc = Date.UTC(date.year, date.month - 1, date.day);
  let instant = wallClockUtc;

  // Resolve the IANA-zone offset at the target instant. Repeating handles a
  // different offset between the initial UTC guess and local midnight.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = wallClockUtc - parisOffsetAt(instant);
    if (candidate === instant) break;
    instant = candidate;
  }

  const resolved = partsAt(instant);
  if (
    resolved.year !== date.year ||
    resolved.month !== date.month ||
    resolved.day !== date.day ||
    resolved.hour !== 0 ||
    resolved.minute !== 0 ||
    resolved.second !== 0
  ) throw new Error("EUROPE_PARIS_DATE_CONVERSION_FAILED");

  return new Date(instant).toISOString();
}

export function parseParisCalendarDate(value: string, errorCode: string) {
  const parsed = calendarDate(value);
  if (!parsed) throw new Error(errorCode);
  return parsed;
}

export function parisDateRangeToUtc(
  dateFrom: string,
  dateToInclusive: string,
): { startUtc: string; endUtcExclusive: string } {
  const from = parseParisCalendarDate(dateFrom, "INVALID_DATE_FROM");
  const to = parseParisCalendarDate(dateToInclusive, "INVALID_DATE_TO");
  const fromOrdinal = Date.UTC(from.year, from.month - 1, from.day);
  const toOrdinal = Date.UTC(to.year, to.month - 1, to.day);

  if (fromOrdinal > toOrdinal) throw new Error("INVALID_DATE_RANGE");

  return {
    startUtc: parisMidnightUtc(from),
    endUtcExclusive: parisMidnightUtc(addCalendarDays(to, 1)),
  };
}

/**
 * Converts a Paris calendar month to UTC bounds. Storage remains UTC; only
 * the calendar interpretation belongs to Europe/Paris.
 */
export function parisMonthRangeToUtc(
  value: string,
): { startUtc: string; endUtcExclusive: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new Error("INVALID_MONTH_FILTER");

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error("INVALID_MONTH_FILTER");

  const start = `${match[1]}-${match[2]}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const next = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
  return {
    startUtc: parisMidnightUtc(parseParisCalendarDate(start, "INVALID_MONTH_FILTER")),
    endUtcExclusive: parisMidnightUtc(parseParisCalendarDate(next, "INVALID_MONTH_FILTER")),
  };
}

/** Converts a Paris calendar year to UTC bounds. */
export function parisYearRangeToUtc(
  value: string,
): { startUtc: string; endUtcExclusive: string } {
  if (!/^\d{4}$/.test(value)) throw new Error("INVALID_YEAR_FILTER");
  const year = Number(value);
  const nextYear = String(year + 1).padStart(4, "0");
  return {
    startUtc: parisMidnightUtc(parseParisCalendarDate(`${value}-01-01`, "INVALID_YEAR_FILTER")),
    endUtcExclusive: parisMidnightUtc(
      parseParisCalendarDate(`${nextYear}-01-01`, "INVALID_YEAR_FILTER"),
    ),
  };
}

export function formatAdminDateTime(value: string, locale = "en-GB") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(locale, {
    timeZone: ADMIN_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
