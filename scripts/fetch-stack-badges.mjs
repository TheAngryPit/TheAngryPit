import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

const E2B_STARTUPS_BADGE = 'https://img.shields.io/badge/SPONSORED%20BY-E2B%20FOR%20STARTUPS-ff3001?style=for-the-badge&labelColor=black';

export function badgeUrl({ label, logo, logoData, badgeSource }) {
  if (badgeSource) {
    assert.equal(badgeSource, E2B_STARTUPS_BADGE, 'Unreviewed official badge source');
    return new URL(badgeSource);
  }
  const url = new URL(`https://img.shields.io/badge/${encodeURIComponent(label.replaceAll('-', '--'))}-0D1117`);
  url.searchParams.set('style', 'flat-square');
  if (logoData) {
    url.searchParams.set('logo', logoData);
  } else if (logo) {
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
    assert(/^data:image\/(?:svg\+xml|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(uri), 'Badge must not load external assets');
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

export function logoDataUri(bytes, contentType) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const type = contentType.split(';', 1)[0].trim().toLowerCase();
  assert(data.length > 0 && data.length <= 6000, 'Logo source exceeds the safe Shields custom-logo limit');
  if (type === 'image/svg+xml') {
    const svg = data.toString('utf8');
    validateSvgContent(svg);
    assert(/\bviewBox\s*=|\bwidth\s*=/.test(svg), 'Logo SVG must have an intrinsic size');
  } else if (type === 'image/png') {
    assert(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Logo source must be a real PNG');
  } else if (type === 'image/jpeg') {
    assert(data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff, 'Logo source must be a real JPEG');
  } else {
    assert.fail(`Unsupported logo image type: ${type}`);
  }
  return `data:${type};base64,${data.toString('base64')}`;
}

export function presentLogo(bytes, contentType, color) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!color) return data;
  assert(/^[A-Fa-f0-9]{6}$/.test(color), 'Presentation color must be a six-digit hex value');
  assert.equal(contentType.split(';', 1)[0].trim().toLowerCase(), 'image/svg+xml', 'Only SVG marks can use monochrome presentation tint');
  const source = data.toString('utf8');
  validateSvgContent(source);
  const tint = `#${color.toUpperCase()}`;
  let changed = 0;
  let svg = source
    .replace(/(fill\s*=\s*["'])black(["'])/gi, (_match, before, after) => { changed += 1; return `${before}${tint}${after}`; })
    .replace(/(stroke\s*=\s*["'])black(["'])/gi, (_match, before, after) => { changed += 1; return `${before}${tint}${after}`; })
    .replace(/((?:fill|stroke)\s*=\s*["'])#(?:000|000000|1a1c1e)(["'])/gi, (_match, before, after) => { changed += 1; return `${before}${tint}${after}`; })
    .replace(/(fill\s*:\s*)#(?:000|000000|1a1c1e)\b/gi, (_match, before) => { changed += 1; return `${before}${tint}`; })
    .replace(/(stroke\s*:\s*)#(?:000|000000|1a1c1e)\b/gi, (_match, before) => { changed += 1; return `${before}${tint}`; });
  if (changed === 0) {
    svg = svg.replace(/<svg\b([^>]*)>/i, (tag, attrs) => {
      assert(!/(?:fill|stroke)\s*=|(?:fill|stroke)\s*:/i.test(svg), 'Tint target SVG has an unrecognized explicit fill or stroke');
      changed += 1;
      return `<svg${attrs} fill="${tint}">`;
    });
  }
  assert(changed > 0, 'No monochrome fill or stroke was available to tint');
  validateSvgContent(svg);
  return Buffer.from(svg);
}

async function fetchLogo(item) {
  const url = new URL(item.logoSource);
  assert.equal(url.protocol, 'https:', `Logo source for ${item.id} must use HTTPS`);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  assert(response.ok, `Logo ${item.id}: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  const bytes = Buffer.from(await response.arrayBuffer());
  logoDataUri(bytes, contentType);
  const ext = contentType.includes('svg') ? 'svg' : contentType.includes('png') ? 'png' : 'jpg';
  return { contentType: contentType.split(';', 1)[0].toLowerCase(), bytes, ext };
}

async function loadLogo(item, priorAsset) {
  let original;
  let fetched;
  if (priorAsset?.sourceUrl === item.logoSource && priorAsset.path) {
    original = Buffer.from(await readFile(path.join(root, priorAsset.path)));
    assert.equal(createHash('sha256').update(original).digest('hex'), priorAsset.sha256, `Stored source logo hash changed for ${item.id}`);
  } else {
    fetched = await fetchLogo(item);
    original = fetched.bytes;
  }
  const contentType = priorAsset?.sourceUrl === item.logoSource ? priorAsset.mimeType : fetched.contentType;
  logoDataUri(original, contentType);
  const presentation = presentLogo(original, contentType, item.logoTint);
  return { original, presentation, contentType, originalExt: contentType.includes('svg') ? 'svg' : contentType.includes('png') ? 'png' : 'jpg' };
}

export async function fetchStackBadges({ onlyIds = [] } = {}) {
  const stack = JSON.parse(await readFile(path.join(root, 'config/stack-badges.json'), 'utf8'));
  const previous = JSON.parse(await readFile(path.join(root, 'assets/stack-badges.provenance.json'), 'utf8'));
  const previousBadges = new Map(previous.badges.map((badge) => [badge.id, badge]));
  const selected = onlyIds.length ? stack.filter((item) => onlyIds.includes(item.id)) : stack;
  if (onlyIds.length) assert.equal(selected.length, new Set(onlyIds).size, 'Unknown or duplicate --only badge id');
  const fetched = await Promise.all(selected.map(async (item) => {
    assert(/^[a-z]+$/.test(item.id));
    const priorAsset = previousBadges.get(item.id)?.logoAsset;
    const logo = item.logoSource ? await loadLogo(item, priorAsset) : null;
    const source = badgeUrl({ ...item, logoData: logo ? logoDataUri(logo.presentation, logo.contentType) : undefined });
    assert(source.href.length < 8000, `Badge ${item.id}: custom logo exceeds Shields request limit`);
    const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
    assert(response.ok, `Badge ${item.id}: HTTP ${response.status}`);
    const svg = validateBadge(await response.text(), item.label);
    if (item.group !== 'language' && item.group !== 'os' && item.group !== 'program' && item.id !== 'egrant') {
      assert(logo, `Tool badge ${item.id} needs a local official logo asset`);
      assert(/<image\b[^>]*\bhref="data:image\//.test(svg), `Tool badge ${item.id} did not embed its logo`);
    }
    return { item, source: source.href, svg, logo };
  }));
  const logoSourceDir = path.join(root, 'assets', 'stack-logo-sources');
  await mkdir(logoSourceDir, { recursive: true });
  const logoPresentationDir = path.join(root, 'assets', 'stack-logo-presentations');
  await mkdir(logoPresentationDir, { recursive: true });
  const sourceAssets = new Map();
  for (const { item, logo } of fetched) {
    if (!logo) continue;
    const priorAsset = previousBadges.get(item.id)?.logoAsset;
    const relativePath = priorAsset?.sourceUrl === item.logoSource && priorAsset.path
      ? priorAsset.path
      : `assets/stack-logo-sources/${item.id}.${logo.originalExt}`;
    if (!priorAsset?.path) await writeFile(path.join(root, relativePath), logo.original);
    const sourceSha256 = createHash('sha256').update(logo.original).digest('hex');
    const logoAsset = {
      sourceUrl: item.logoSource,
      mimeType: logo.contentType,
      path: relativePath,
      sha256: sourceSha256,
    };
    if (item.logoTint) {
      const presentationPath = `assets/stack-logo-presentations/${item.id}.svg`;
      await writeFile(path.join(root, presentationPath), logo.presentation);
      logoAsset.presentation = {
        path: presentationPath,
        color: `#${item.logoTint.toUpperCase()}`,
        sha256: createHash('sha256').update(logo.presentation).digest('hex'),
      };
    }
    sourceAssets.set(item.id, logoAsset);
  }
  for (const { item, svg } of fetched) {
    await writeFile(path.join(root, 'assets', `stack-${item.id}.svg`), svg);
  }
  const generatedBadges = fetched.map(({ item, source, svg }) => ({ id: item.id, label: item.label, group: item.group || 'stack', source, href: item.href, officialProgramBadge: item.id === 'egrant', logoAsset: sourceAssets.get(item.id) || null, sha256: createHash('sha256').update(svg).digest('hex') }));
  const badgeMap = new Map(previous.badges.map((badge) => [badge.id, badge]));
  for (const badge of generatedBadges) badgeMap.set(badge.id, badge);
  for (const item of stack.filter(({ group }) => !['language', 'os', 'program'].includes(group))) {
    const canonicalPath = path.join(root, 'assets', `stack-${item.id}.svg`);
    const canonical = Buffer.from(await readFile(canonicalPath));
    const badge = badgeMap.get(item.id);
    assert(badge, `Missing provenance for tool badge ${item.id}`);
    assert.equal(createHash('sha256').update(canonical).digest('hex'), badge.sha256, `Canonical badge hash mismatch for ${item.id}`);
    validateBadge(canonical.toString('utf8'), item.label);
    const publishedAsset = `assets/stack-${item.id}-logo.svg`;
    await writeFile(path.join(root, publishedAsset), canonical);
    badgeMap.set(item.id, { ...badge, publishedAsset, publishedAssetSha256: badge.sha256 });
  }
  const receipt = {
    ...previous,
    provider: 'Shields.io', style: 'flat-square; E2B official for-the-badge exception', retrievedAt: new Date().toISOString(),
    scope: 'Static tool/OS badges and confirmed access/membership labels, not certifications or proficiency ratings. Tool marks are embedded from local snapshots of official repo/site assets or verified Simple Icons; original source URLs and SHA-256 hashes are retained separately from any presentation-tinted SVG snapshot. E2B uses its official Startups sponsorship badge; other program labels are custom Shields badges, not official credentials.',
    badges: stack.map(({ id }) => badgeMap.get(id)).filter(Boolean),
  };
  await writeFile(path.join(root, 'assets/stack-badges.provenance.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Saved ${fetched.length} Shields.io badges including the official E2B for Startups badge; no credentials used.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
  await fetchStackBadges({ onlyIds: onlyArg ? onlyArg.slice('--only='.length).split(',').filter(Boolean) : [] });
}
