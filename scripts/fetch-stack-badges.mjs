import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

export function badgeUrl({ label, logo }) {
  const url = new URL(`https://img.shields.io/badge/${encodeURIComponent(label.replaceAll('-', '--'))}-0D1117`);
  url.searchParams.set('style', 'flat-square');
  if (logo) {
    url.searchParams.set('logo', logo);
    url.searchParams.set('logoColor', 'E6342E');
  }
  return url;
}

function validateSvgContent(svg, depth = 0) {
  assert(depth < 4, 'Nested badge assets exceed safety limit');
  assert(/<svg\b/i.test(svg) && /<\/svg>/.test(svg), 'Badge response must be SVG');
  assert(!/<(?:script|foreignObject|iframe)\b|\son\w+\s*=|<!DOCTYPE|<!ENTITY/i.test(svg), 'Active SVG is not allowed');
  assert(!/@import\b/i.test(svg), 'Badge must not load external assets');
  for (const match of svg.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)["']/gi)) {
    const uri = match[1];
    if (uri.startsWith('#')) continue;
    assert(/^data:image\/(?:svg\+xml|png);base64,[A-Za-z0-9+/=]+$/.test(uri), 'Badge must not load external assets');
    if (uri.startsWith('data:image/svg+xml;')) validateSvgContent(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'), depth + 1);
  }
  for (const match of svg.matchAll(/url\(\s*['"]?([^\s)'"\s]+)['"]?\s*\)/gi)) assert(match[1].startsWith('#'), 'Badge must not load external assets');
}

export function validateBadge(svg, label) {
  validateSvgContent(svg);
  assert(svg.includes(label.replaceAll('&', '&amp;')), 'Badge label does not match requested stack item');
  assert(!/invalid|not found|rate limit/i.test(svg), 'Badge provider returned an error');
  return svg;
}

export async function fetchStackBadges() {
  const stack = JSON.parse(await readFile(path.join(root, 'config/stack-badges.json'), 'utf8'));
  const fetched = await Promise.all(stack.map(async (item) => {
    assert(/^[a-z]+$/.test(item.id));
    const source = badgeUrl(item);
    const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
    assert(response.ok, `Badge ${item.id}: HTTP ${response.status}`);
    const svg = validateBadge(await response.text(), item.label);
    return { item, source: source.href, svg };
  }));
  for (const { item, svg } of fetched) {
    await writeFile(path.join(root, 'assets', `stack-${item.id}.svg`), svg);
  }
  const receipt = {
    provider: 'Shields.io', style: 'flat-square', retrievedAt: new Date().toISOString(),
    scope: 'Static badges indicating source-backed tools/languages, not proficiency, certifications or measurements',
    badges: fetched.map(({ item, source, svg }) => ({ id: item.id, label: item.label, source, href: item.href, sha256: createHash('sha256').update(svg).digest('hex') })),
  };
  await writeFile(path.join(root, 'assets/stack-badges.provenance.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Saved ${fetched.length} real Shields.io flat-square badges; no credentials used.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fetchStackBadges();
}
