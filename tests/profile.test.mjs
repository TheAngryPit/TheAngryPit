import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  dateRange,
  loadProfileData,
  parseContributionCalendar,
  parseProductionContributionCalendar,
  sixMonthCalendar,
  validateContributions,
  validateMetrics,
} from '../scripts/data.mjs';
import { buildCityAddon } from '../scripts/build-city-addon.mjs';
import { cityLayout, mapContributionCalendar } from '../scripts/city-addon.mjs';
import { renderProfileAssets } from '../scripts/render.mjs';
import { readmeDataBlock, readmeSourcesBlock, renderReadmeData } from '../scripts/render-readme-data.mjs';
import { renderMarkdownSubset, rewritePreviewAssetPaths, selectPreviewContent } from '../scripts/render-preview.mjs';
import { refreshProfile } from '../scripts/refresh.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixture(name) {
  return readFile(new URL(name, FIXTURES), 'utf8');
}

function annualStart(end, days = 368) {
  return new Date(Date.parse(`${end}T00:00:00.000Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

function annualCalendarHtml({ to, from = annualStart(to), declaredRange = true, omit = [] }) {
  const dates = dateRange(from, to);
  const excluded = new Set(omit);
  const days = dates.map((date, index) => ({
    date,
    count: index > 5 && index % 31 === 0 ? 1 : 0,
    level: index > 5 && index % 31 === 0 ? 1 : 0,
  })).filter((day) => !excluded.has(day.date));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const declaration = declaredRange ? ` data-from="${from} 00:00:00 UTC" data-to="${to} 23:59:59 UTC"` : '';
  const cells = days.map((day) => {
    const id = `contribution-day-component-${day.date}`;
    const tooltip = day.count === 0 ? `No contributions on ${day.date}.` : `1 contribution on ${day.date}.`;
    return `<td id="${id}" data-date="${day.date}" data-level="${day.level}"></td><tool-tip for="${id}">${tooltip}</tool-tip>`;
  }).join('\n');
  return `<html><main${declaration}><h2>${total} contributions in the last year</h2><table>${cells}</table></main></html>`;
}

function mockRefreshFetch(calendarHtml, { incomplete = false, counts = { prs: 148, reviews: 78, issues: 101 } } = {}) {
  return async (url, options) => {
    const parsedUrl = new URL(String(url));
    if (parsedUrl.hostname === 'github.com') {
      assert.equal(options.headers.authorization, undefined);
      return new Response(calendarHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    const query = parsedUrl.searchParams.get('q');
    const key = query.includes('reviewed-by') ? 'reviews' : query.includes('is:issue') ? 'issues' : 'prs';
    return new Response(JSON.stringify({ total_count: counts[key], incomplete_results: incomplete }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('checked-in activity data matches its source totals and full daily window', async () => {
  const { contributions, metrics } = await loadProfileData();
  const receipt = JSON.parse(await fixture('initial-source-receipt.json'));
  assert.equal(receipt.contributions.total, 1964);
  assert.equal(receipt.publicSearchMetrics.pullRequestsOpened, 148);
  assert.equal(receipt.publicSearchMetrics.distinctPullRequestsReviewed, 78);
  assert.equal(receipt.publicSearchMetrics.issuesOpened, 101);
  assert.equal(contributions.days.length, dateRange(contributions.from, contributions.to).length);
  assert.equal(contributions.days[0].date, contributions.from);
  assert.equal(contributions.days.at(-1).date, contributions.to);
  assert.equal(contributions.days.reduce((sum, day) => sum + day.count, 0), contributions.total);
  assert.ok(metrics.metrics.every((metric) => metric.query.includes('is:public')));
  if (contributions.retrievedAt === receipt.contributions.retrievedAt) {
    assert.equal(contributions.total, receipt.contributions.total);
    assert.equal(contributions.from, receipt.contributions.from);
    assert.equal(contributions.to, receipt.contributions.to);
    assert.equal(contributions.days.length, receipt.contributions.days);
  }
  if (metrics.retrievedAt === receipt.publicSearchMetrics.retrievedAt) {
    assert.deepEqual(metrics.metrics.map(({ id, count }) => [id, count]), [
      ['prs', receipt.publicSearchMetrics.pullRequestsOpened],
      ['reviews', receipt.publicSearchMetrics.distinctPullRequestsReviewed],
      ['issues', receipt.publicSearchMetrics.issuesOpened],
    ]);
  }
});

test('date validation rejects impossible days and spans a year boundary without gaps', () => {
  assert.throws(() => dateRange('2026-02-30', '2026-03-01'), /not a real calendar date/);
  assert.deepEqual(dateRange('2025-12-30', '2026-01-02'), [
    '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02',
  ]);
});

test('six-month view rolls across years, clamps month ends, and recalculates only selected daily counts', () => {
  for (const [to, expectedFrom] of [
    ['2026-10-09', '2026-04-09'],
    ['2027-01-04', '2026-07-04'],
    ['2024-08-31', '2024-02-29'],
    ['2025-08-31', '2025-02-28'],
  ]) {
    const source = parseContributionCalendar(annualCalendarHtml({ to }), { retrievedAt: `${to}T12:00:00.000Z` });
    const before = JSON.stringify(source);
    const view = sixMonthCalendar(source);
    assert.equal(view.from, expectedFrom);
    assert.equal(view.to, to);
    assert.deepEqual(view.days.map(({ date }) => date), dateRange(expectedFrom, to));
    assert.equal(view.total, source.days.filter(({ date }) => date >= expectedFrom).reduce((sum, day) => sum + day.count, 0));
    assert.equal(JSON.stringify(source), before, 'annual source must not be mutated');
    assert.deepEqual(sixMonthCalendar(view), view, 'window selection must be idempotent');
  }
});

test('fitted city geometry keeps each bar inside its desktop and mobile plot', async () => {
  const { contributions } = await loadProfileData();
  const calendar = mapContributionCalendar(sixMonthCalendar(contributions));
  const config = JSON.parse(await readFile(new URL('../config/city-addon.json', import.meta.url), 'utf8'));
  const firstSunday = Math.floor(calendar[0].date.getTime() / 86_400_000) - calendar[0].date.getUTCDay();
  for (const { plot } of Object.values(config.viewports)) {
    const { dx, dy, nativeHeight, scaleY } = cityLayout(calendar, plot);
    const weeks = Math.ceil((calendar.length + calendar[0].date.getUTCDay()) / 7);
    for (const day of calendar) {
      const week = Math.floor((Math.floor(day.date.getTime() / 86_400_000) - firstSunday) / 7);
      const weekday = day.date.getUTCDay();
      const x = (7 + week - weekday) * dx;
      const baseY = nativeHeight - (weeks + 7) * dy + (week + weekday) * dy;
      const barHeight = Math.log10(day.contributionCount / 20 + 1) * 144 + 3;
      assert.ok(x >= 0 && x + dx * 1.8 <= plot.width);
      assert.ok((baseY - barHeight) * scaleY >= 0);
      assert.ok((baseY + dy * 1.8) * scaleY <= plot.height);
    }
  }
});

test('refresh workflow schedules every six hours and retains narrow public-refresh behavior', async () => {
  const workflow = await readFile(new URL('../.github/workflows/profile-refresh.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '17 \*\/6 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /node scripts\/refresh\.mjs/);
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(workflow, /secrets\.|pull_request_target|git add -A/);
});

test('calendar parser accepts a complete window across New Year', async () => {
  const parsed = parseContributionCalendar(await fixture('year-boundary.html'), { retrievedAt: '2026-01-05T00:00:00.000Z' });
  assert.equal(parsed.from, '2025-12-29');
  assert.equal(parsed.to, '2026-01-04');
  assert.equal(parsed.total, 3);
  assert.deepEqual(parsed.days.filter((day) => day.count > 0).map(({ date, count }) => [date, count]), [
    ['2025-12-31', 1],
    ['2026-01-02', 2],
  ]);
});

test('calendar parser reads GitHub empty day cells from their linked tool-tip text and checks declared endpoints', async () => {
  const html = await fixture('github-calendar-live-shape.html');
  const parsed = parseContributionCalendar(html, { retrievedAt: '2026-01-05T00:00:00.000Z' });
  assert.equal(parsed.from, '2025-12-29');
  assert.equal(parsed.to, '2026-01-04');
  assert.equal(parsed.total, 3);
  assert.deepEqual(parsed.days.map(({ count }) => count), [0, 0, 1, 0, 2, 0, 0]);
  assert.throws(() => parseContributionCalendar(html.replace('data-to=\'2026-01-04', 'data-to=\'2026-01-03')), /do not match declared range/);
});

test('upstream addon maps every validated day and preserves native Sunday-first geometry', async () => {
  const { contributions } = await loadProfileData();
  const mapped = mapContributionCalendar(contributions);
  assert.equal(mapped.length, contributions.days.length);
  assert.deepEqual(mapped.map(({ date, contributionCount, contributionLevel }) => [date.toISOString().slice(0, 10), contributionCount, contributionLevel]), contributions.days.map(({ date, count, level }) => [date, count, level]));
  for (const index of new Set([0, 1, Math.floor(mapped.length / 2), mapped.length - 1])) {
    assert.equal(mapped[index].contributionCount, contributions.days[index].count);
    assert.equal(mapped[index].contributionLevel, contributions.days[index].level);
    assert.equal(mapped[index].date.toISOString(), `${contributions.days[index].date}T00:00:00.000Z`);
  }

  const fixtureData = JSON.parse(await fixture('sunday-week-boundary.json'));
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'career-profile-sunday-fixture-'));
  try {
    const rendered = await renderProfileAssets({ contributions: validateContributions(fixtureData), metrics: (await loadProfileData()).metrics }, outputDir);
    const transforms = (svg) => [...svg.matchAll(/<g transform="translate\(([-\d.]+) ([-\d.]+)\)">(?=<rect)/g)].map((match) => match.slice(1).map(Number));
    const desktop = transforms(rendered['activity-dark.svg']);
    const mobile = transforms(rendered['activity-mobile-dark.svg']);
    assert.equal(desktop.length, fixtureData.days.length);
    assert.equal(mobile.length, fixtureData.days.length);
    assert.match(rendered['activity-dark.svg'], /<g transform="translate\(0 96\) scale\(1 /);
    assert.match(rendered['activity-mobile-dark.svg'], /<g transform="translate\(0 86\) scale\(1 /);

    for (const [points, plotWidth] of [[desktop, 1120], [mobile, 324]]) {
      const { dx } = cityLayout(mapContributionCalendar(fixtureData), { width: plotWidth, height: 220 });
      const dy = dx * Math.tan(Math.PI / 6);
      const [sunday, monday, , , , , , nextSunday] = points;
      assert.ok(Math.abs(sunday[0] - 7 * dx) < 0.02);
      assert.ok(Math.abs(monday[0] - 6 * dx) < 0.02);
      assert.ok(Math.abs((sunday[0] - monday[0]) - dx) < 0.02);
      assert.ok(Math.abs((monday[1] - sunday[1]) - dy) < 0.02);
      assert.ok(Math.abs((nextSunday[0] - sunday[0]) - dx) < 0.02);
      assert.ok(Math.abs((nextSunday[1] - sunday[1]) - dy) < 0.02);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('pinned upstream TypeScript transforms deterministically from source hashes', async () => {
  const first = await buildCityAddon();
  const second = await buildCityAddon();
  assert.deepEqual([...second], [...first]);
  const geometry = first.get('runtime/create-3d-contrib.mjs');
  const colors = first.get('runtime/create-css-colors.mjs');
  assert.match(geometry, /export const create3DContrib/);
  assert.match(geometry, /Math\.log10\(cal\.contributionCount \/ 20 \+ 1\) \* 144 \+ 3/);
  assert.match(geometry, /cal\.date\.getUTCDay\(\)/);
  assert.match(colors, /darker\(DARKER_RIGHT\)/);
  assert.doesNotMatch(geometry, /from '\.\/type'/);
  assert.doesNotMatch(geometry, /<script|fetch\(|axios|graphql/i);
});

test('empty, malformed, and discontinuous calendar HTML is rejected', async () => {
  const empty = await fixture('empty.html');
  const badHTML = await fixture('badHTML.html');
  const partial = await fixture('partial.html');
  assert.throws(() => parseContributionCalendar(empty), /no dated day cells/);
  assert.throws(() => parseContributionCalendar(badHTML), /no dated day cells/);
  assert.throws(() => parseContributionCalendar(partial), /incomplete or discontinuous/);
});

test('data validators reject count drift and missing daily records', async () => {
  const { contributions, metrics } = await loadProfileData();
  assert.throws(() => validateContributions({ ...contributions, total: contributions.total + 1 }), /does not match daily sum/);
  assert.throws(() => validateContributions({ ...contributions, days: contributions.days.slice(1) }), /every day/);
  assert.throws(() => validateMetrics({ ...metrics, metrics: metrics.metrics.slice(1) }), /all three/);
});

test('valid future annual refreshes remain renderable without freezing mutable snapshot totals or dates', async () => {
  const { contributions, metrics } = await loadProfileData();
  const futureHtml = annualCalendarHtml({ to: '2027-01-04' });
  const futureContributions = parseProductionContributionCalendar(futureHtml, {
    retrievedAt: '2027-01-04T12:00:00.000Z', now: new Date('2027-01-04T12:00:00.000Z'),
  });
  const futureMetrics = {
    ...metrics,
    retrievedAt: '2027-01-04T00:00:00.000Z',
    metrics: metrics.metrics.map((metric) => ({ ...metric, count: metric.count + 1 })),
  };
  assert.equal(validateContributions(futureContributions).total, futureContributions.days.reduce((sum, day) => sum + day.count, 0));
  assert.equal(futureContributions.days.length, 368);
  assert.deepEqual(validateMetrics(futureMetrics).metrics.map(({ count }) => count), metrics.metrics.map(({ count }) => count + 1));
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'career-profile-future-render-test-'));
  try {
    const rendered = await renderProfileAssets({ contributions: futureContributions, metrics: futureMetrics }, outputDir);
    const view = sixMonthCalendar(futureContributions);
    assert.ok(rendered['activity-dark.svg'].includes(view.from));
    assert.ok(rendered['activity-dark.svg'].includes(futureContributions.to));
    assert.ok(rendered['activity-dark.svg'].includes(new Intl.NumberFormat('en-US').format(view.total)));
    assert.ok(rendered['metrics-dark.svg'].includes(String(metrics.metrics[0].count + 1)));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('chart regeneration is deterministic and carries the current source dates and totals', async () => {
  const data = await loadProfileData();
  const view = sixMonthCalendar(data.contributions);
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'career-profile-render-test-'));
  try {
    const first = await renderProfileAssets(data, outputDir);
    const firstBytes = new Map(await Promise.all(Object.keys(first).map(async (name) => [name, await readFile(path.join(outputDir, name), 'utf8')])));
    const second = await renderProfileAssets(data, outputDir);
    for (const name of Object.keys(second)) assert.equal(second[name], firstBytes.get(name), `${name} changed between identical renders`);
    for (const name of Object.keys(second).filter(name => /^(?:activity|metrics)-/.test(name) && !name.includes('-six-months'))) {
      assert.equal(second[name.replace('.svg', '-six-months.svg')], second[name], 'Visible six-month asset alias must refresh with its compatible name');
    }
    assert.match(second['activity-dark.svg'], new RegExp(new Intl.NumberFormat('en-US').format(view.total)));
    assert.ok(second['activity-dark.svg'].includes(view.from));
    assert.ok(second['activity-dark.svg'].includes(data.contributions.to));
    assert.match(second['activity-dark.svg'], /GitHub activity/);
    assert.doesNotMatch(second['activity-dark.svg'], /Open-source activity/);
    assert.ok(second['metrics-dark.svg'].includes(String(data.metrics.metrics[0].count)));
    const rangeStart = new Date(`${view.from}T00:00:00.000Z`);
    const startMonth = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(rangeStart);
    assert.ok(second['activity-mobile-dark.svg'].includes(startMonth));
    assert.match(second['activity-dark.svg'], /log-scaled daily counts/);
    assert.match(second['activity-mobile-dark.svg'], /Bar height: upstream log scale/);
    assert.doesNotMatch(second['activity-dark.svg'], /<animate(?:Transform)?\b/i);
    for (const svg of Object.values(second)) {
      assert.doesNotMatch(svg, /<script\b|<foreignObject\b/i);
      assert.doesNotMatch(svg, /(?:href|src)\s*=\s*["']https?:\/\//i);
      assert.doesNotMatch(svg, /url\(\s*["']?https?:\/\//i);
    }
    const desktopBars = [...second['activity-dark.svg'].matchAll(/<g transform="translate\(([-\d.]+) ([-\d.]+)\)">(?=<rect)/g)];
    const mobileBars = [...second['activity-mobile-dark.svg'].matchAll(/<g transform="translate\(([-\d.]+) ([-\d.]+)\)">(?=<rect)/g)];
    assert.equal(desktopBars.length, view.days.length);
    assert.equal(mobileBars.length, view.days.length);
    assert.match(second['activity-dark.svg'], /height="650"/);
    assert.match(second['activity-mobile-dark.svg'], /height="370"/);
    assert.match(second['activity-dark.svg'], /translate\(0 96\)/);
    assert.match(second['activity-mobile-dark.svg'], /translate\(0 86\)/);
    assert.match(second['activity-mobile-dark.svg'], /Contribution level/);
    assert.match(second['activity-mobile-dark.svg'], /y="361"[^>]*>Bar height: upstream log scale/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('invalid calendar data cannot replace previously rendered addon assets', async () => {
  const data = await loadProfileData();
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'career-profile-last-good-render-'));
  try {
    await renderProfileAssets(data, outputDir);
    const previous = await readFile(path.join(outputDir, 'activity-dark.svg'), 'utf8');
    assert.throws(
      () => renderProfileAssets({ ...data, contributions: { ...data.contributions, total: data.contributions.total + 1 } }, outputDir),
      /does not match daily sum/,
    );
    assert.equal(await readFile(path.join(outputDir, 'activity-dark.svg'), 'utf8'), previous);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('README data notes stay concise while collapsed source notes retain dynamic dates, counts, definitions, and queries', async () => {
  const { contributions, metrics } = await loadProfileData();
  const view = sixMonthCalendar(contributions);
  const block = readmeDataBlock({ contributions, metrics });
  const total = new Intl.NumberFormat('en-US').format(view.total);
  const from = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${view.from}T00:00:00.000Z`));
  const to = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${contributions.to}T00:00:00.000Z`));
  assert.match(block, new RegExp(`${total} publicly displayed contributions · ${from}–${to}`));
  assert.match(block, /Public search counts \(all-time\):/);
  assert.match(block, /rolling six-month window/);
  const sources = readmeSourcesBlock({ contributions, metrics });
  assert.match(sources, /did not access private repositories/);
  assert.match(block, /distinct public PRs ever reviewed/);
  assert.match(sources, /not the number of review submissions/);
  for (const metric of metrics.metrics) {
    assert.ok(block.includes(`${new Intl.NumberFormat('en-US').format(metric.count)} ${metric.id === 'reviews' ? 'distinct public PRs ever reviewed' : metric.id === 'prs' ? 'public pull requests opened' : 'public issues opened'}`));
    assert.ok(sources.includes(metric.source));
  }

  const futureContributions = parseProductionContributionCalendar(annualCalendarHtml({ to: '2027-01-04' }), {
    retrievedAt: '2027-01-04T12:00:00.000Z', now: new Date('2027-01-04T12:00:00.000Z'),
  });
  const future = {
    contributions: futureContributions,
    metrics: { ...metrics, retrievedAt: '2027-01-04T12:00:00.000Z', metrics: metrics.metrics.map((metric) => ({ ...metric, count: metric.count + 1 })) },
  };
  const futureBlock = readmeDataBlock(future);
  assert.match(futureBlock, new RegExp(`${new Intl.NumberFormat('en-US').format(sixMonthCalendar(futureContributions).total)} publicly displayed contributions`));
  assert.match(futureBlock, /4 July 2026–4 January 2027/);
  assert.ok(futureBlock.includes(`${new Intl.NumberFormat('en-US').format(future.metrics.metrics[0].count)} public pull requests opened`));
  assert.doesNotMatch(futureBlock, /1,964/);
});

test('README data renderer replaces only its single bounded marker block deterministically', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'career-profile-readme-test-'));
  const readmePath = path.join(directory, 'README.md');
  const original = 'before\n<!-- PROFILE-DATA:START -->\nstale numbers\n<!-- PROFILE-DATA:END -->\n<details>\n<summary>Sources</summary>\n\n<!-- PROFILE-SOURCES:START -->\nstale sources\n<!-- PROFILE-SOURCES:END -->\n\n</details>\nafter\n';
  try {
    await writeFile(readmePath, original);
    const first = await renderReadmeData(readmePath);
    const second = await renderReadmeData(readmePath);
    assert.equal(second, first);
    assert.ok(first.startsWith('before\n<!-- PROFILE-DATA:START -->'));
    assert.ok(first.endsWith('<!-- PROFILE-SOURCES:END -->\n\n</details>\nafter\n'));
    const { contributions } = await loadProfileData();
    assert.ok(first.includes(`${new Intl.NumberFormat('en-US').format(sixMonthCalendar(contributions).total)} publicly displayed contributions`));
    assert.doesNotMatch(first, /stale numbers/);
    await writeFile(readmePath, '<!-- PROFILE-DATA:END --><!-- PROFILE-DATA:START -->\n<!-- PROFILE-SOURCES:START -->\n<!-- PROFILE-SOURCES:END -->');
    await assert.rejects(renderReadmeData(readmePath), /markers are out of order/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('README-derived preview keeps supported images, links, and root-local asset paths', () => {
  const fragment = renderMarkdownSubset([
    '# Profile',
    '',
    '<picture>',
    '  <source media="(prefers-color-scheme: dark)" srcset="assets/activity-dark.svg">',
    '  <img src="assets/banner.png" alt="Profile banner">',
    '</picture>',
    '',
    '[Portfolio](https://example.test/portfolio)',
    '',
    '<details>',
    '<summary>Data and sources</summary>',
    '',
    '- **Calendar:** [Public calendar](https://example.test/calendar); the public graph can include privacy-obscured activity.',
    '',
    '- **Reviewed PRs:** distinct pull requests ever reviewed, not reviews submitted.',
    '</details>',
  ].join('\n'));
  const rewritten = rewritePreviewAssetPaths(fragment);
  assert.match(rewritten, /srcset="\.\.\/assets\/activity-dark\.svg"/);
  assert.match(rewritten, /src="\.\.\/assets\/banner\.png"/);
  assert.match(rewritten, /href="https:\/\/example\.test\/portfolio"/);
  assert.match(rewritten, /<details>\s*<summary>Data and sources<\/summary>/);
  assert.doesNotMatch(rewritten, /<details[^>]*\sopen(?:\s|>)/i);
  assert.match(rewritten, /href="https:\/\/example\.test\/calendar"/);
  assert.match(rewritten, /privacy-obscured activity/);
  assert.match(rewritten, /distinct pull requests ever reviewed, not reviews submitted/);
  assert.doesNotMatch(rewritten, /<script\b/i);
});

test('cached GitHub Markdown preview is used only when both saved receipt hashes match', async () => {
  const markdown = '# Synthetic profile\n\nA current README fragment.\n';
  const rendered = await fixture('github-rendered-synthetic.html');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const receipt = JSON.stringify({ status: 'passed', readmeSha256: sha(markdown), responseSha256: sha(rendered) });
  const current = selectPreviewContent(markdown, rendered, receipt);
  assert.equal(current.source, 'github-markdown-api');
  assert.equal(current.fragment, rendered);

  const staleReadme = selectPreviewContent(`${markdown}\nchanged`, rendered, receipt);
  assert.equal(staleReadme.source, 'local-readme-renderer');
  assert.match(staleReadme.label, /no matching current receipt/);
  assert.match(staleReadme.fragment, /changed/);
  const staleResponseReceipt = JSON.stringify({ status: 'passed', readmeSha256: sha(markdown), responseSha256: '0'.repeat(64) });
  assert.equal(selectPreviewContent(markdown, rendered, staleResponseReceipt).source, 'local-readme-renderer');
  assert.equal(selectPreviewContent(markdown, rendered, '{bad receipt').source, 'local-readme-renderer');
});

test('refresh fetch failure preserves both last-good files byte for byte', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'career-profile-refresh-test-'));
  const sourceDir = new URL('../data/', import.meta.url);
  const original = new Map();
  for (const name of ['contributions.json', 'metrics.json']) {
    original.set(name, await readFile(new URL(name, sourceDir)));
    await writeFile(path.join(dataDir, name), original.get(name));
  }

  try {
    await assert.rejects(refreshProfile({
      dataDir,
      fetchImpl: async () => new Response('upstream unavailable', { status: 503 }),
      now: () => new Date('2026-10-08T00:00:00.000Z'),
    }), /HTTP 503/);
    for (const [name, bytes] of original) assert.deepEqual(await readFile(path.join(dataDir, name)), bytes);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('incomplete API search results cannot replace checked-in metrics', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'career-profile-incomplete-test-'));
  const original = new Map();
  for (const name of ['contributions.json', 'metrics.json']) {
    const bytes = await readFile(new URL(name, new URL('../data/', import.meta.url)));
    original.set(name, bytes);
    await writeFile(path.join(dataDir, name), bytes);
  }
  const html = annualCalendarHtml({ to: '2026-01-05' });

  try {
    await assert.rejects(refreshProfile({
      dataDir,
      now: () => new Date('2026-01-05T00:00:00.000Z'),
      fetchImpl: async (url) => {
        if (String(url).includes('/contributions')) {
          return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        return new Response(JSON.stringify({ total_count: 9, incomplete_results: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    }), /incomplete/);
    for (const [name, bytes] of original) assert.deepEqual(await readFile(path.join(dataDir, name)), bytes);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('refresh accepts the linked-tooltip calendar shape and sends GITHUB_TOKEN only to the REST API', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'career-profile-auth-scope-test-'));
  const html = annualCalendarHtml({ to: '2026-01-05' });
  const seen = [];
  const counts = { prs: 148, reviews: 78, issues: 101 };

  try {
    const result = await refreshProfile({
      dataDir,
      token: 'test-only-token',
      now: () => new Date('2026-01-05T00:00:00.000Z'),
      fetchImpl: async (url, options) => {
        const parsedUrl = new URL(String(url));
        seen.push({ host: parsedUrl.hostname, authorization: options.headers.authorization });
        if (parsedUrl.hostname === 'github.com') {
          assert.equal(options.headers.authorization, undefined);
          return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        assert.equal(parsedUrl.hostname, 'api.github.com');
        assert.equal(options.headers.authorization, 'Bearer test-only-token');
        const query = parsedUrl.searchParams.get('q');
        const definition = query.includes('reviewed-by') ? 'reviews' : query.includes('is:issue') ? 'issues' : 'prs';
        const count = counts[definition];
        return new Response(JSON.stringify({ total_count: count, incomplete_results: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.equal(result.contributions.days.length, 368);
    assert.equal(result.contributions.to, '2026-01-05');
    assert.equal(result.metrics.metrics[0].count, 148);
    assert.equal(seen.length, 4);
    assert.equal(seen.filter(({ host }) => host === 'github.com').length, 1);
    assert.equal(seen.filter(({ host }) => host === 'api.github.com').length, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('production refresh rejects short, undeclared, partial-edge, and stale calendars without replacing last-good snapshots', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'career-profile-annual-boundary-test-'));
  const original = new Map();
  for (const name of ['contributions.json', 'metrics.json']) {
    const bytes = await readFile(new URL(name, new URL('../data/', import.meta.url)));
    original.set(name, bytes);
    await writeFile(path.join(dataDir, name), bytes);
  }
  const now = new Date('2026-10-08T12:00:00.000Z');
  const standardWindow = annualCalendarHtml({ to: '2026-10-08' });
  const staleWindow = annualCalendarHtml({ to: '2026-10-06' });
  const start = annualStart('2026-10-08');
  const end = '2026-10-08';
  const cases = [
    { name: 'one-day window', html: annualCalendarHtml({ to: '2026-10-08', from: '2026-10-08' }), pattern: /full annual window/ },
    { name: 'missing declared range', html: annualCalendarHtml({ to: '2026-10-08', declaredRange: false }), pattern: /missing its declared/ },
    { name: 'one missing endpoint', html: standardWindow.replace(/ data-from="[^"]+"/, ''), pattern: /only one range endpoint/ },
    { name: 'missing first zero edge day', html: annualCalendarHtml({ from: start, to: end, omit: [start] }), pattern: /do not match declared range/ },
    { name: 'missing last zero edge day', html: annualCalendarHtml({ from: start, to: end, omit: [end] }), pattern: /do not match declared range/ },
    { name: 'stale range end', html: staleWindow, now: new Date('2026-10-08T12:00:00.000Z'), pattern: /is stale or in the future/ },
  ];

  try {
    for (const item of cases) {
      await assert.rejects(refreshProfile({
        dataDir,
        now: () => item.now ?? now,
        fetchImpl: mockRefreshFetch(item.html),
      }), item.pattern, item.name);
      for (const [name, bytes] of original) assert.deepEqual(await readFile(path.join(dataDir, name)), bytes, `${item.name} changed ${name}`);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
