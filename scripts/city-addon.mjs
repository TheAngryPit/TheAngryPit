import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as d3 from 'd3';
import { JSDOM } from 'jsdom';
import { buildCityAddon } from './build-city-addon.mjs';
import { validateContributions } from './data.mjs';

await buildCityAddon();
const { create3DContrib } = await import('../vendor/github-profile-3d-contrib/runtime/create-3d-contrib.mjs');
const { createCssColors } = await import('../vendor/github-profile-3d-contrib/runtime/create-css-colors.mjs');

const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const CONFIG_PATH = path.join(PACKAGE_DIR, 'config/city-addon.json');
const CONFIG = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const SVG_NS = 'http://www.w3.org/2000/svg';
const DAY_MS = 86_400_000;

export function mapContributionCalendar(data) {
  const contributions = validateContributions(data);
  return contributions.days.map(({ date, count, level }) => ({
    date: new Date(`${date}T00:00:00.000Z`),
    contributionCount: count,
    contributionLevel: level,
  }));
}

function addText(svg, { text, x, y, fill, size, weight = 400, anchor = 'start' }) {
  svg.append('text')
    .attr('x', x)
    .attr('y', y)
    .attr('fill', fill)
    .attr('font-size', size)
    .attr('font-weight', weight)
    .attr('text-anchor', anchor)
    .text(text);
}

export function cityLayout(calendar, plot) {
  const weeks = Math.ceil((calendar.length + calendar[0].date.getUTCDay()) / 7);
  const dx = plot.width / (weeks + 8);
  const dy = dx * Math.tan(Math.PI / 6);
  const maxBar = Math.max(...calendar.map((day) => Math.log10(day.contributionCount / 20 + 1) * 144 + 3));
  const nativeHeight = (weeks + 7) * dy + maxBar + 12;
  return { dx, dy, nativeWidth: dx * 64, nativeHeight, scaleY: plot.height / nativeHeight };
}

function monthAnchors(calendar, plot, viewport, mobile) {
  const first = calendar[0].date;
  const firstSunday = Math.floor(first.getTime() / DAY_MS) * DAY_MS - first.getUTCDay() * DAY_MS;
  const { dx } = cityLayout(calendar, plot);
  const months = [];
  let lastMonth = -1;

  for (const day of calendar) {
    const date = day.date;
    const key = date.getUTCFullYear() * 12 + date.getUTCMonth();
    if (key === lastMonth) continue;
    lastMonth = key;
    const week = Math.floor((date.getTime() - firstSunday) / (7 * DAY_MS));
    const quarterBoundary = date.getUTCMonth() % 3 === 0;
    if (mobile && months.length > 0 && !quarterBoundary) continue;
    const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date);
    const label = date.getUTCMonth() === 9 || date.getUTCMonth() === 0
      ? `${month} ’${String(date.getUTCFullYear()).slice(-2)}`
      : month;
    months.push({ x: plot.x + dx * (7 + week), y: viewport.monthLabelY, label });
  }
  return months;
}

function createSettings(theme, themeColors) {
  const levels = CONFIG.levels;
  return {
    ...CONFIG.settings,
    backgroundColor: themeColors.background,
    foregroundColor: themeColors.foreground,
    weakColor: themeColors.muted,
    radarColor: CONFIG.settings.radarColor,
    contribColors: [0, 1, 2, 3, 4].map((level) => levels[String(level)][theme]),
  };
}

export function createProfile3DCalendarSvg(data, theme, themeColors, { mobile = false } = {}) {
  if (theme !== 'dark' && theme !== 'light') throw new Error(`unsupported theme: ${theme}`);
  const calendar = mapContributionCalendar(data);
  const viewport = CONFIG.viewports[mobile ? 'mobile' : 'desktop'];
  const plot = viewport.plot;
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const svgNode = dom.window.document.createElementNS(SVG_NS, 'svg');
  const svg = d3.select(svgNode)
    .attr('xmlns', SVG_NS)
    .attr('width', viewport.width)
    .attr('height', viewport.height)
    .attr('viewBox', `0 0 ${viewport.width} ${viewport.height}`)
    .attr('role', 'img')
    .attr('aria-labelledby', 'calendar-title calendar-description');

  const description = `A three-dimensional GitHub activity calendar showing ${new Intl.NumberFormat('en-US').format(data.total)} publicly displayed contributions in the last six months, from ${data.from} through ${data.to}. Bars use the pinned upstream github-profile-3d-contrib geometry and log-scaled daily counts; face color follows GitHub's contribution level. The presentation fits the selected weeks into the viewport. GitHub's public display may include privacy-obscured activity. No private repositories were accessed.`;
  svg.append('title').attr('id', 'calendar-title').text(`GitHub activity: ${new Intl.NumberFormat('en-US').format(data.total)} publicly displayed contributions`);
  svg.append('desc').attr('id', 'calendar-description').text(description);
  svg.append('rect').attr('width', viewport.width).attr('height', viewport.height).attr('fill', themeColors.background);
  svg.append('style').text(`${createCssColors(createSettings(theme, themeColors))}\ntext { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }`);

  const formatter = new Intl.NumberFormat('en-US');
  if (mobile) {
    addText(svg, { text: 'Last six months', x: 18, y: 27, fill: themeColors.foreground, size: 18, weight: 700 });
    addText(svg, { text: formatter.format(data.total), x: 342, y: 27, fill: themeColors.foreground, size: 17, weight: 700, anchor: 'end' });
    addText(svg, { text: `${data.days.length} days · ${data.from}–${data.to}`, x: 18, y: 49, fill: themeColors.muted, size: 11 });
  } else {
    addText(svg, { text: 'GitHub activity · Last six months', x: 26, y: 34, fill: themeColors.foreground, size: 21, weight: 700 });
    addText(svg, { text: `${data.days.length} days · ${data.from} to ${data.to}`, x: 26, y: 55, fill: themeColors.muted, size: 12 });
    addText(svg, { text: formatter.format(data.total), x: viewport.width - 26, y: 35, fill: themeColors.foreground, size: 20, weight: 700, anchor: 'end' });
    addText(svg, { text: 'publicly displayed contributions', x: viewport.width - 26, y: 55, fill: themeColors.muted, size: 11, anchor: 'end' });
  }

  for (const month of monthAnchors(calendar, plot, viewport, mobile)) {
    addText(svg, { text: month.label, x: month.x, y: month.y, fill: themeColors.muted, size: mobile ? 10 : 12 });
  }

  const userInfo = { contributionCalendar: calendar };
  const layout = cityLayout(calendar, plot);
  const grid = svg.append('g').attr('transform', `translate(${plot.x} ${plot.y}) scale(1 ${layout.scaleY})`);
  create3DContrib(grid, userInfo, 0, 0, layout.nativeWidth, layout.nativeHeight, createSettings(theme, themeColors), false);

  const levels = [0, 1, 2, 3, 4];
  const swatch = mobile ? 10 : 12;
  const gap = mobile ? 38 : 44;
  const legendWidth = gap * 4 + swatch;
  const legendStart = mobile ? 116 : (viewport.width - legendWidth) / 2;
  const labelY = viewport.legendY;
  addText(svg, { text: 'Contribution level', x: mobile ? 18 : 26, y: labelY + 10, fill: themeColors.muted, size: mobile ? 9 : 10 });
  levels.forEach((level, index) => {
    const x = legendStart + index * gap;
    svg.append('rect')
      .attr('x', x)
      .attr('y', labelY)
      .attr('width', swatch)
      .attr('height', swatch)
      .attr('fill', CONFIG.levels[String(level)][theme]);
    addText(svg, { text: String(level), x: x + swatch + 4, y: labelY + (mobile ? 9 : 10), fill: themeColors.muted, size: mobile ? 9 : 10 });
  });
  addText(svg, {
    text: 'Bar height: upstream log scale · color: GitHub level',
    x: mobile ? viewport.width / 2 : viewport.width - 26,
    y: labelY + (mobile ? 27 : 10),
    fill: themeColors.muted,
    size: mobile ? 8 : 10,
    anchor: mobile ? 'middle' : 'end',
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n${svgNode.outerHTML}\n`;
}
