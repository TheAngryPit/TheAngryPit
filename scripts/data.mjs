import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USERNAME = 'TheAngryPit';
export const CONTRIBUTIONS_URL = `https://github.com/users/${USERNAME}/contributions`;
export const CONTRIBUTION_SCOPE = 'Publicly displayed GitHub contribution calendar; no private repository access';
export const METRIC_SCOPE = 'Public repository search counts; all time. Reviewed PRs counts distinct PRs ever reviewed, not reviews submitted.';

export const METRIC_DEFINITIONS = Object.freeze([
  {
    id: 'prs',
    label: 'Pull requests opened',
    query: `is:pr author:${USERNAME} is:public`,
  },
  {
    id: 'reviews',
    label: 'PRs reviewed',
    query: `is:pr reviewed-by:${USERNAME} is:public`,
  },
  {
    id: 'issues',
    label: 'Issues opened',
    query: `is:issue author:${USERNAME} is:public`,
  },
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(value, label = 'date') {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD format`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real calendar date: ${value}`);
  }
  return timestamp;
}

export function dateRange(from, to) {
  const start = parseIsoDate(from, 'from');
  const end = parseIsoDate(to, 'to');
  if (end < start) throw new Error(`date range ends before it starts: ${from}..${to}`);
  if (Math.floor((end - start) / 86_400_000) + 1 > 400) throw new Error('contribution date range is unexpectedly large');

  const dates = [];
  for (let current = start; current <= end; current += 86_400_000) {
    dates.push(new Date(current).toISOString().slice(0, 10));
  }
  return dates;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function plainText(markup) {
  return decodeEntities(markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2];
}

function contributionCount(source, date) {
  const text = plainText(source);
  if (/\bno contributions\b/i.test(text)) return 0;
  const match = text.match(/\b([\d,]+)\s+contributions?\b/i);
  if (!match) throw new Error(`could not read contribution count for ${date}`);
  const count = Number(match[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`invalid contribution count for ${date}`);
  return count;
}

function parseCalendarCell(tag, innerMarkup) {
  const date = attribute(tag, 'data-date');
  parseIsoDate(date, 'calendar day');
  const levelText = attribute(tag, 'data-level');
  if (!/^[0-4]$/.test(levelText ?? '')) throw new Error(`invalid contribution level for ${date}`);

  const declaredCount = attribute(tag, 'data-count');
  const ariaLabel = attribute(tag, 'aria-label');
  const count = declaredCount !== undefined
    ? contributionCount(`${declaredCount} contributions`, date)
    : contributionCount(ariaLabel || innerMarkup, date);

  return { date, count, level: Number(levelText) };
}

export function validateContributions(data, { username = USERNAME } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('contributions data must be an object');
  if (data.schemaVersion !== 1) throw new Error('unsupported contributions schemaVersion');
  if (data.username !== username) throw new Error(`contributions username must be ${username}`);
  if (data.source !== `https://github.com/users/${username}/contributions`) throw new Error('contributions source does not match the public calendar URL');
  if (typeof data.scope !== 'string' || !data.scope.includes('no private repository access')) throw new Error('contributions scope must state that private repositories were not accessed');
  if (!Number.isFinite(Date.parse(data.retrievedAt))) throw new Error('contributions retrievedAt must be an ISO timestamp');

  const expectedDates = dateRange(data.from, data.to);
  if (!Array.isArray(data.days) || data.days.length !== expectedDates.length) {
    throw new Error(`contributions calendar must contain every day from ${data.from} through ${data.to}`);
  }

  let sum = 0;
  for (let index = 0; index < expectedDates.length; index += 1) {
    const day = data.days[index];
    if (!day || day.date !== expectedDates[index]) throw new Error(`contributions calendar has a gap or duplicate at ${expectedDates[index]}`);
    if (!Number.isSafeInteger(day.count) || day.count < 0) throw new Error(`invalid contribution count at ${day.date}`);
    if (!Number.isInteger(day.level) || day.level < 0 || day.level > 4) throw new Error(`invalid contribution level at ${day.date}`);
    sum += day.count;
  }
  if (!Number.isSafeInteger(data.total) || data.total < 0) throw new Error('contributions total must be a non-negative integer');
  if (sum !== data.total) throw new Error(`contributions total ${data.total} does not match daily sum ${sum}`);
  return data;
}

function declaredCalendarRange(html) {
  for (const match of html.matchAll(/<[^>]+>/g)) {
    const tag = match[0];
    if (!/\bdata-(?:from|to)\s*=/i.test(tag)) continue;
    const rawFrom = attribute(tag, 'data-from');
    const rawTo = attribute(tag, 'data-to');
    if ((rawFrom && !rawTo) || (!rawFrom && rawTo)) throw new Error('contribution calendar declared only one range endpoint');
    if (rawFrom && rawTo) {
      const fromMatch = rawFrom.match(/^(\d{4}-\d{2}-\d{2})\b/);
      const toMatch = rawTo.match(/^(\d{4}-\d{2}-\d{2})\b/);
      if (!fromMatch || !toMatch) throw new Error('contribution calendar declared an invalid date range');
      parseIsoDate(fromMatch[1], 'declared range start');
      parseIsoDate(toMatch[1], 'declared range end');
      return { from: fromMatch[1], to: toMatch[1] };
    }
  }
  return null;
}

export function parseContributionCalendar(html, { username = USERNAME, retrievedAt = new Date().toISOString() } = {}) {
  if (typeof html !== 'string' || html.trim().length === 0) throw new Error('contribution calendar response was empty');
  if (!/<(?:html|main|table)\b/i.test(html)) throw new Error('contribution calendar response was not recognizable HTML');

  const tooltipTextById = new Map();
  const tooltipPattern = /<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/gi;
  for (const match of html.matchAll(tooltipPattern)) {
    const id = attribute(match[1], 'for');
    if (id) tooltipTextById.set(id, match[2]);
  }

  const cells = [];
  const cellPattern = /<td\b[^>]*\bdata-date\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/gi;
  for (const match of html.matchAll(cellPattern)) {
    const closeIndex = html.indexOf('</td>', match.index + match[0].length);
    if (closeIndex < 0) throw new Error('contribution calendar response ended inside a day cell');
    const cellId = attribute(match[0], 'id');
    const tooltip = cellId ? tooltipTextById.get(cellId) : undefined;
    cells.push(parseCalendarCell(match[0], tooltip || html.slice(match.index + match[0].length, closeIndex)));
  }
  if (cells.length === 0) throw new Error('contribution calendar contained no dated day cells');

  cells.sort((left, right) => left.date.localeCompare(right.date));
  const uniqueDates = new Set(cells.map((day) => day.date));
  if (uniqueDates.size !== cells.length) throw new Error('contribution calendar contained duplicate dates');

  const dates = dateRange(cells[0].date, cells.at(-1).date);
  if (dates.length !== cells.length || dates.some((date, index) => cells[index].date !== date)) {
    throw new Error('contribution calendar days are incomplete or discontinuous');
  }

  const declaredRange = declaredCalendarRange(html);
  if (declaredRange && (declaredRange.from !== cells[0].date || declaredRange.to !== cells.at(-1).date)) {
    throw new Error(`contribution calendar day cells do not match declared range ${declaredRange.from}..${declaredRange.to}`);
  }

  const pageText = plainText(html);
  const totalMatch = pageText.match(/\b([\d,]+)\s+contributions?\s+in the last year\b/i);
  if (!totalMatch) throw new Error('contribution calendar total was not present in the page heading');
  const total = Number(totalMatch[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('contribution calendar heading had an invalid total');

  return validateContributions({
    schemaVersion: 1,
    username,
    source: `https://github.com/users/${username}/contributions`,
    retrievedAt,
    scope: CONTRIBUTION_SCOPE,
    from: cells[0].date,
    to: cells.at(-1).date,
    total,
    days: cells,
  }, { username });
}

/**
 * Strict boundary used only for network refreshes. The lower-level parser stays
 * useful for short parser fixtures, but fetched profile data must declare and
 * provide a complete, fresh annual calendar.
 */
export function parseProductionContributionCalendar(html, {
  username = USERNAME,
  retrievedAt = new Date().toISOString(),
  now = new Date(),
} = {}) {
  if (typeof html !== 'string') throw new Error('contribution calendar response was not text');
  const declaredRange = declaredCalendarRange(html);
  if (!declaredRange) throw new Error('production contribution calendar is missing its declared data-from/data-to range');

  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error('production contribution calendar freshness clock is invalid');
  const currentUtcDate = current.toISOString().slice(0, 10);
  const currentDay = parseIsoDate(currentUtcDate, 'current UTC date');
  const rangeEnd = parseIsoDate(declaredRange.to, 'declared range end');
  const ageInUtcDays = Math.floor((currentDay - rangeEnd) / 86_400_000);
  if (ageInUtcDays < 0 || ageInUtcDays > 1) {
    throw new Error(`production contribution calendar end ${declaredRange.to} is stale or in the future relative to ${currentUtcDate} UTC`);
  }

  const contributions = parseContributionCalendar(html, { username, retrievedAt });
  if (contributions.from !== declaredRange.from || contributions.to !== declaredRange.to) {
    throw new Error('production contribution calendar day cells do not match the declared endpoints');
  }
  if (contributions.days.length < 365 || contributions.days.length > 371) {
    throw new Error(`production contribution calendar must contain a full annual window (365–371 days); received ${contributions.days.length}`);
  }
  return contributions;
}

export function validateMetrics(data, { username = USERNAME } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('metrics data must be an object');
  if (data.schemaVersion !== 1) throw new Error('unsupported metrics schemaVersion');
  if (data.username !== username) throw new Error(`metrics username must be ${username}`);
  if (!Number.isFinite(Date.parse(data.retrievedAt))) throw new Error('metrics retrievedAt must be an ISO timestamp');
  if (typeof data.scope !== 'string' || !data.scope.includes('all time') || !data.scope.includes('distinct PRs ever reviewed')) {
    throw new Error('metrics scope must explain the all-time and reviewed-PR definitions');
  }
  if (!Array.isArray(data.metrics) || data.metrics.length !== METRIC_DEFINITIONS.length) throw new Error('metrics must contain all three public search counts');

  for (let index = 0; index < METRIC_DEFINITIONS.length; index += 1) {
    const expected = METRIC_DEFINITIONS[index];
    const metric = data.metrics[index];
    if (!metric || metric.id !== expected.id || metric.label !== expected.label || metric.query !== expected.query) {
      throw new Error(`metrics entry ${expected.id} did not match its public-search definition`);
    }
    if (!Number.isSafeInteger(metric.count) || metric.count < 0) throw new Error(`metrics entry ${expected.id} has an invalid count`);
    if (typeof metric.source !== 'string' || !metric.source.startsWith('https://api.github.com/search/issues?')) {
      throw new Error(`metrics entry ${expected.id} has an invalid source URL`);
    }
  }
  return data;
}

export function makeMetrics(counts, { username = USERNAME, retrievedAt = new Date().toISOString() } = {}) {
  const metrics = METRIC_DEFINITIONS.map((definition) => {
    const count = counts[definition.id];
    const url = new URL('https://api.github.com/search/issues');
    url.searchParams.set('q', definition.query);
    url.searchParams.set('per_page', '1');
    return { ...definition, count, source: url.toString() };
  });
  return validateMetrics({
    schemaVersion: 1,
    username,
    retrievedAt,
    scope: METRIC_SCOPE,
    metrics,
  }, { username });
}

export async function loadProfileData(dataDir = fileURLToPath(new URL('../data/', import.meta.url))) {
  const [contributionsText, metricsText] = await Promise.all([
    readFile(join(dataDir, 'contributions.json'), 'utf8'),
    readFile(join(dataDir, 'metrics.json'), 'utf8'),
  ]);
  const contributions = validateContributions(JSON.parse(contributionsText));
  const metrics = validateMetrics(JSON.parse(metricsText));
  return { contributions, metrics };
}
