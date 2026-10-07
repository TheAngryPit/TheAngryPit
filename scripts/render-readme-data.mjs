import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadProfileData } from './data.mjs';

const README = fileURLToPath(new URL('../README.md', import.meta.url));
const DATA_START = '<!-- PROFILE-DATA:START -->';
const DATA_END = '<!-- PROFILE-DATA:END -->';
const SOURCES_START = '<!-- PROFILE-SOURCES:START -->';
const SOURCES_END = '<!-- PROFILE-SOURCES:END -->';

function formatDate(date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function formatRetrievedAt(timestamp) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(timestamp));
}

function metricLabel(metric) {
  if (metric.id === 'reviews') return 'distinct public PRs ever reviewed';
  if (metric.id === 'prs') return 'public pull requests opened';
  return 'public issues opened';
}

export function readmeDataBlock({ contributions, metrics }) {
  const total = new Intl.NumberFormat('en-US').format(contributions.total);
  const count = new Intl.NumberFormat('en-US');
  const metricSummary = metrics.metrics.map((metric) => `${count.format(metric.count)} ${metricLabel(metric)}`).join(' · ');
  return [
    `- **Calendar:** ${total} publicly displayed contributions · ${formatDate(contributions.from)}–${formatDate(contributions.to)} (${count.format(contributions.days.length)} days).`,
    `- **Public search counts (all-time):** ${metricSummary}; retrieved ${formatRetrievedAt(metrics.retrievedAt)} UTC.`,
    '- GitHub’s displayed calendar is a rolling window that may include privacy-obscured activity; it is not a public-only total. Search counts use a different period.',
  ].join('\n');
}

export function readmeSourcesBlock({ contributions, metrics }) {
  const metricLines = metrics.metrics.map((metric) => {
    const queryLabel = metric.id === 'reviews'
      ? 'PRs matched by the public reviewed-by search'
      : `${metric.label} search`;
    return `- **${metricLabel(metric)}:** [${queryLabel}](${metric.source}); retrieved ${formatRetrievedAt(metrics.retrievedAt)} UTC.`;
  });
  return [
    `- **Contribution calendar:** [public GitHub contribution calendar](${contributions.source}); retrieved ${formatRetrievedAt(contributions.retrievedAt)} UTC. The source reports displayed activity and may include privacy-obscured contributions. This package did not access private repositories.`,
    ...metricLines,
    '- The reviewed count is distinct pull requests ever reviewed, not the number of review submissions.',
    '- Counts come from GitHub’s public Search API queries and are all-time snapshots; they do not share the calendar’s rolling date window.',
  ].join('\n\n');
}

function replaceBlock(source, startMarker, endMarker, rendered, label) {
  if (source.split(startMarker).length - 1 !== 1 || source.split(endMarker).length - 1 !== 1) {
    throw new Error(`README must contain exactly one ${label} start and end marker`);
  }
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (end < start) throw new Error(`README ${label} markers are out of order`);
  return `${source.slice(0, start + startMarker.length)}\n${rendered}\n${source.slice(end)}`;
}

export async function renderReadmeData(readmePath = README) {
  const { contributions, metrics } = await loadProfileData();
  const current = await readFile(readmePath, 'utf8');
  let updated = current;
  updated = replaceBlock(updated, DATA_START, DATA_END, readmeDataBlock({ contributions, metrics }), 'PROFILE-DATA');
  updated = replaceBlock(updated, SOURCES_START, SOURCES_END, readmeSourcesBlock({ contributions, metrics }), 'PROFILE-SOURCES');
  if (updated !== current) await writeFile(readmePath, updated, 'utf8');
  return updated;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  renderReadmeData()
    .then(() => console.log('Updated concise README dates, totals, and collapsed source provenance from checked-in JSON data.'))
    .catch((error) => {
      console.error(`README data rendering failed: ${error.message}`);
      process.exitCode = 1;
    });
}
