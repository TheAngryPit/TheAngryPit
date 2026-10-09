import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfileData, sixMonthCalendar, validateContributions, validateMetrics } from './data.mjs';

const { createProfile3DCalendarSvg } = await import('./city-addon.mjs');

const ASSET_DIR = fileURLToPath(new URL('../assets/', import.meta.url));

const THEMES = Object.freeze({
  dark: {
    background: '#0d1117',
    foreground: '#f0f6fc',
    muted: '#a6b0bb',
    grid: '#30363d',
    emptyTop: '#42484f',
    emptyLeft: '#252a30',
    emptyRight: '#343a41',
    reds: [null, ['#ff635d', '#c7312c', '#e6342e'], ['#ff4c46', '#a92521', '#cc302a'], ['#f83f39', '#901e1a', '#b32420'], ['#e6342e', '#7d1916', '#9b201c']],
    track: '#252b32',
    rule: '#30363d',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    muted: '#59636e',
    grid: '#d0d7de',
    emptyTop: '#c7cdd4',
    emptyLeft: '#a8b0b8',
    emptyRight: '#b8c0c8',
    reds: [null, ['#ff635d', '#c7312c', '#e6342e'], ['#ff4c46', '#a92521', '#cc302a'], ['#f83f39', '#901e1a', '#b32420'], ['#e6342e', '#7d1916', '#9b201c']],
    track: '#eaeef2',
    rule: '#d8dee4',
  },
});

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function number(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function dateLabel(value, { year = true } = {}) {
  const options = year
    ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
    : { month: 'short', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('en-US', options).format(new Date(`${value}T00:00:00.000Z`));
}

function activitySvg(data, theme) {
  return createProfile3DCalendarSvg(data, theme, THEMES[theme]);
}

function activityMobileSvg(data, theme) {
  return createProfile3DCalendarSvg(data, theme, THEMES[theme], { mobile: true });
}

function metricsSvg(contributions, metrics, theme) {
  const colors = THEMES[theme];
  const left = 28;
  const barStart = 250;
  const barWidth = 260;
  const rowYs = [104, 150, 196];
  const maximum = Math.max(...metrics.metrics.map(({ count }) => count), 1);
  const bars = metrics.metrics.map((metric, index) => {
    const y = rowYs[index];
    const width = Math.round((metric.count / maximum) * barWidth);
    return `<text x="${left}" y="${y}" fill="${colors.foreground}" font-size="15" font-family="Arial, Helvetica, sans-serif">${xml(metric.label)}</text><text x="${barStart + barWidth}" y="${y}" fill="${colors.foreground}" font-size="15" font-weight="700" text-anchor="end" font-family="Arial, Helvetica, sans-serif">${number(metric.count)}</text><rect x="${barStart}" y="${y + 9}" width="${barWidth}" height="8" fill="${colors.track}"/><rect x="${barStart}" y="${y + 9}" width="${width}" height="8" fill="#E6342E"/>`;
  }).join('');

  const graph = { x: 610, y: 91, width: 525, height: 105 };
  const maxDaily = Math.max(...contributions.days.map(({ count }) => count), 1);
  const points = contributions.days.map((day, index) => {
    const x = graph.x + (index / Math.max(contributions.days.length - 1, 1)) * graph.width;
    const y = graph.y + graph.height - (day.count / maxDaily) * graph.height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point}`).join(' ');
  const dividerX = 570;
  const graphTitle = `Daily contributions · ${contributions.days.length} days`;
  const range = `${dateLabel(contributions.from)} to ${dateLabel(contributions.to)}`;
  const description = `All-time public search counts: ${metrics.metrics.map(({ label, count }) => `${label} ${number(count)}`).join(', ')}. The line graph shows daily contributions from the publicly displayed calendar between ${range}. Reviewed PRs means distinct public PRs ever reviewed, not reviews submitted. The calendar may include anonymized private activity.`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1180" height="265" viewBox="0 0 1180 265" role="img" aria-labelledby="title desc">
  <title id="title">Public GitHub activity: pull requests, reviewed pull requests, issues, and daily contributions</title>
  <desc id="desc">${xml(description)}</desc>
  <rect width="1180" height="265" fill="${colors.background}"/>
  <text x="26" y="36" fill="${colors.foreground}" font-size="20" font-weight="700" font-family="Arial, Helvetica, sans-serif">Across the ecosystem</text>
  <text x="26" y="58" fill="${colors.muted}" font-size="11" font-family="Arial, Helvetica, sans-serif">All-time public GitHub search counts</text>
  ${bars}
  <line x1="${dividerX}" y1="58" x2="${dividerX}" y2="224" stroke="${colors.rule}" stroke-width="1"/>
  <text x="${graph.x}" y="57" fill="${colors.foreground}" font-size="14" font-weight="700" font-family="Arial, Helvetica, sans-serif">${xml(graphTitle)}</text>
  <text x="${graph.x}" y="75" fill="${colors.muted}" font-size="11" font-family="Arial, Helvetica, sans-serif">${xml(range)}</text>
  <line x1="${graph.x}" y1="${graph.y + graph.height}" x2="${graph.x + graph.width}" y2="${graph.y + graph.height}" stroke="${colors.rule}" stroke-width="1"/>
  <path d="${path}" fill="none" stroke="#E6342E" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  <text x="${graph.x}" y="221" fill="${colors.muted}" font-size="10" font-family="Arial, Helvetica, sans-serif">${xml(dateLabel(contributions.from))}</text>
  <text x="${graph.x + graph.width}" y="221" fill="${colors.muted}" font-size="10" text-anchor="end" font-family="Arial, Helvetica, sans-serif">${xml(dateLabel(contributions.to))}</text>
  <text x="26" y="245" fill="${colors.muted}" font-size="10" font-family="Arial, Helvetica, sans-serif">PRs reviewed = distinct PRs ever reviewed, not review submissions.</text>
  <text x="1154" y="245" fill="${colors.muted}" font-size="10" text-anchor="end" font-family="Arial, Helvetica, sans-serif">Search source: GitHub public items · all time</text>
</svg>
`;
}

function metricsMobileSvg(contributions, metrics, theme) {
  const colors = THEMES[theme];
  const maximum = Math.max(...metrics.metrics.map(({ count }) => count), 1);
  const barStart = 18;
  const barWidth = 324;
  const rowYs = [100, 158, 216];
  const rows = metrics.metrics.map((metric, index) => {
    const y = rowYs[index];
    const width = Math.round((metric.count / maximum) * barWidth);
    return `<text x="${barStart}" y="${y}" fill="${colors.foreground}" font-size="16" font-family="Arial, Helvetica, sans-serif">${xml(metric.label)}</text><text x="342" y="${y}" fill="${colors.foreground}" font-size="17" font-weight="700" text-anchor="end" font-family="Arial, Helvetica, sans-serif">${number(metric.count)}</text><rect x="${barStart}" y="${y + 8}" width="${barWidth}" height="7" fill="${colors.track}"/><rect x="${barStart}" y="${y + 8}" width="${width}" height="7" fill="#E6342E"/>`;
  }).join('');
  const graph = { x: 18, y: 348, width: 324, height: 76 };
  const maxDaily = Math.max(...contributions.days.map(({ count }) => count), 1);
  const path = contributions.days.map((day, index) => {
    const x = graph.x + (index / Math.max(contributions.days.length - 1, 1)) * graph.width;
    const y = graph.y + graph.height - (day.count / maxDaily) * graph.height;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const dailyRange = `${dateLabel(contributions.from)} through ${dateLabel(contributions.to)}`;
  const description = `All-time public search counts: ${metrics.metrics.map(({ label, count }) => `${label} ${number(count)}`).join(', ')}. The graph shows daily contribution counts from the publicly displayed calendar for ${dailyRange}. Reviewed PRs means distinct PRs ever reviewed, not reviews submitted.`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="500" viewBox="0 0 360 500" role="img" aria-labelledby="title desc">
  <title id="title">Public GitHub activity and rolling contribution trend</title>
  <desc id="desc">${xml(description)}</desc>
  <rect width="360" height="500" fill="${colors.background}"/>
  <text x="18" y="31" fill="${colors.foreground}" font-size="19" font-weight="700" font-family="Arial, Helvetica, sans-serif">Across the ecosystem</text>
  <text x="18" y="55" fill="${colors.muted}" font-size="12" font-family="Arial, Helvetica, sans-serif">All-time public GitHub search counts</text>
  ${rows}
  <line x1="18" y1="271" x2="342" y2="271" stroke="${colors.rule}" stroke-width="1"/>
  <text x="18" y="301" fill="${colors.foreground}" font-size="15" font-weight="700" font-family="Arial, Helvetica, sans-serif">Daily contributions · ${number(contributions.days.length)} days</text>
  <text x="18" y="322" fill="${colors.muted}" font-size="12" font-family="Arial, Helvetica, sans-serif">${xml(dailyRange)}</text>
  <line x1="${graph.x}" y1="${graph.y + graph.height}" x2="${graph.x + graph.width}" y2="${graph.y + graph.height}" stroke="${colors.rule}" stroke-width="1"/>
  <path d="${path}" fill="none" stroke="#E6342E" stroke-width="2.3" stroke-linejoin="round" stroke-linecap="round"/>
  <text x="${graph.x}" y="443" fill="${colors.muted}" font-size="10" font-family="Arial, Helvetica, sans-serif">${xml(dateLabel(contributions.from))}</text>
  <text x="${graph.x + graph.width}" y="443" fill="${colors.muted}" font-size="10" text-anchor="end" font-family="Arial, Helvetica, sans-serif">${xml(dateLabel(contributions.to))}</text>
  <text x="18" y="475" fill="${colors.muted}" font-size="11" font-family="Arial, Helvetica, sans-serif">Reviewed = distinct PRs, not review submissions.</text>
</svg>
`;
}

function badgeSvg(label, width) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="32" viewBox="0 0 ${width} 32" role="img" aria-label="${xml(label)}">
  <rect width="${width}" height="32" fill="#0d1117"/>
  <rect width="5" height="32" fill="#E6342E"/>
  <text x="16" y="21" fill="#ffffff" font-size="13" font-weight="600" font-family="Arial, Helvetica, sans-serif">${xml(label)}</text>
</svg>
`;
}

export function renderProfileAssets({ contributions, metrics }, outputDir = ASSET_DIR) {
  validateContributions(contributions);
  validateMetrics(metrics);
  contributions = sixMonthCalendar(contributions);
  const files = {
    'activity-dark.svg': activitySvg(contributions, 'dark'),
    'activity-light.svg': activitySvg(contributions, 'light'),
    'activity-mobile-dark.svg': activityMobileSvg(contributions, 'dark'),
    'activity-mobile-light.svg': activityMobileSvg(contributions, 'light'),
    'metrics-dark.svg': metricsSvg(contributions, metrics, 'dark'),
    'metrics-light.svg': metricsSvg(contributions, metrics, 'light'),
    'metrics-mobile-dark.svg': metricsMobileSvg(contributions, metrics, 'dark'),
    'metrics-mobile-light.svg': metricsMobileSvg(contributions, metrics, 'light'),
    'badge-github.svg': badgeSvg('GitHub', 91),
    'badge-linkedin.svg': badgeSvg('LinkedIn', 107),
    'badge-portfolio.svg': badgeSvg('Portfolio', 111),
    'badge-writing.svg': badgeSvg('Writing', 96),
  };
  for (const name of Object.keys(files).filter(name => /^(?:activity|metrics)-/.test(name))) {
    files[name.replace('.svg', '-six-months.svg')] = files[name];
  }
  for (const name of ['activity-dark', 'activity-light', 'activity-mobile-dark', 'activity-mobile-light']) {
    files[`${name.replace('activity-', 'activity-isometric-')}-six-months.svg`] = files[`${name}.svg`];
  }
  return mkdir(outputDir, { recursive: true }).then(async () => {
    for (const [name, contents] of Object.entries(files)) await writeFile(join(outputDir, name), contents, 'utf8');
    return files;
  });
}

async function main() {
  await renderProfileAssets(await loadProfileData());
  console.log('Rendered upstream 3D activity calendar, metrics, and link-badge SVGs.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Chart rendering failed: ${error.message}`);
    process.exitCode = 1;
  });
}
