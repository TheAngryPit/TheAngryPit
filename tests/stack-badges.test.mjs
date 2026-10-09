import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { badgeUrl, logoDataUri, presentLogo, validateBadge } from '../scripts/fetch-stack-badges.mjs';

test('stack badges use real Shields flat-square source, encoded labels and the approved palette', () => {
  const url = badgeUrl({ label: 'C#', logo: 'dotnet' });
  assert.equal(url.origin, 'https://img.shields.io');
  assert.equal(url.pathname, '/badge/C%23-0D1117');
  assert.equal(url.searchParams.get('style'), 'flat-square');
  assert.equal(url.searchParams.get('logoColor'), 'E6342E');
});

test('badge input excludes active SVG, remote assets and wrong labels', () => {
  const valid = '<svg xmlns="http://www.w3.org/2000/svg"><text>Codex</text></svg>';
  assert.equal(validateBadge(valid, 'Codex'), valid);
  assert.throws(() => validateBadge(valid, 'Python'), /label/);
  assert.throws(() => validateBadge(valid.replace('</svg>', '<script>1</script></svg>'), 'Codex'), /Active SVG/);
  assert.throws(() => validateBadge(valid.replace('</svg>', '<image href="https://example.com/image.png"/></svg>'), 'Codex'), /external assets/);
  assert.throws(() => validateBadge(valid.replace('</svg>', '<image href="//example.com/image.png"/></svg>'), 'Codex'), /external assets/);
  assert.throws(() => validateBadge(valid.replace('</svg>', '<a href="javascript:alert(1)"/></svg>'), 'Codex'), /external assets/);
  assert.throws(() => validateBadge(valid.replace('</svg>', '<style>rect{fill:url(https://example.com/image.svg)}</style></svg>'), 'Codex'), /external assets/);
});

test('official local logo input is validated and encoded for Shields custom-logo support', () => {
  const logo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>';
  const dataUri = logoDataUri(Buffer.from(logo), 'image/svg+xml');
  const url = badgeUrl({ label: 'OpenClaw', logoData: dataUri });
  assert.equal(url.searchParams.get('logo'), dataUri);
  assert.throws(() => logoDataUri(Buffer.from(logo.replace('</svg>', '<image href="https://example.test/logo.svg"/></svg>')), 'image/svg+xml'), /external assets/);
  assert.throws(() => logoDataUri(Buffer.from('not an image'), 'image/png'), /real PNG/);
  assert.throws(() => logoDataUri(Buffer.alloc(6001), 'image/png'), /safe Shields custom-logo limit/);
});

test('presentation tint changes only near-black paint and preserves logo paths', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#1A1C1E" d="M0 0h24v24H0z"/><path fill="#fff" stroke="black" d="M2 2h20v20H2z"/></svg>';
  const presented = presentLogo(Buffer.from(source), 'image/svg+xml', 'e6342e').toString();
  assert.ok(presented.includes('fill="#E6342E"'));
  assert.ok(presented.includes('stroke="#E6342E"'));
  assert.ok(presented.includes('fill="#fff"'));
  assert.deepEqual([...presented.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((match) => match[1]), [...source.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((match) => match[1]));
  const inherited = presentLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'), 'image/svg+xml', 'E6342E').toString();
  assert.match(inherited, /<svg[^>]*fill="#E6342E"/);
  assert.throws(() => presentLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ff0000" d="M0 0h1v1z"/></svg>'), 'image/svg+xml', 'E6342E'), /unrecognized explicit/);
});

test('every tool badge has an embedded official logo with source URL and SHA-256 provenance', async () => {
  const stack = JSON.parse(await readFile(new URL('../config/stack-badges.json', import.meta.url), 'utf8'));
  const receipt = JSON.parse(await readFile(new URL('../assets/stack-badges.provenance.json', import.meta.url), 'utf8'));
  const toolBadges = stack.filter(({ group }) => !['language', 'os', 'program'].includes(group));
  for (const item of toolBadges) {
    assert.ok(item.logoSource, `${item.id} is missing an official logo source`);
    const badge = await readFile(new URL(`../assets/stack-${item.id}.svg`, import.meta.url), 'utf8');
    validateBadge(badge, item.label);
    assert.match(badge, /<image\b[^>]*\bhref="data:image\//, `${item.id} rendered without an embedded mark`);
    const provenance = receipt.badges.find(({ id }) => id === item.id);
    const alias = await readFile(new URL(`../assets/stack-${item.id}-logo.svg`, import.meta.url), 'utf8');
    assert.equal(alias, badge, `${item.id} publication alias must match the canonical badge`);
    assert.equal(provenance?.publishedAsset, `assets/stack-${item.id}-logo.svg`);
    assert.equal(provenance?.publishedAssetSha256, provenance?.sha256);
    assert.equal(provenance?.logoAsset?.sourceUrl, item.logoSource);
    assert.match(provenance?.logoAsset?.sha256 || '', /^[a-f0-9]{64}$/);
    const logoBytes = await readFile(new URL(`../${provenance.logoAsset.path}`, import.meta.url));
    assert.equal(createHash('sha256').update(logoBytes).digest('hex'), provenance.logoAsset.sha256);
    if (item.logoTint) {
      assert.equal(provenance.logoAsset.presentation.color, `#${item.logoTint}`);
      const presentation = await readFile(new URL(`../${provenance.logoAsset.presentation.path}`, import.meta.url));
      assert.equal(createHash('sha256').update(presentation).digest('hex'), provenance.logoAsset.presentation.sha256);
      assert.ok(presentation.toString().includes(`#${item.logoTint}`));
      assert.ok(!logoBytes.equals(presentation), `${item.id} source snapshot was overwritten by its presentation tint`);
      const encoded = badge.match(/<image\b[^>]*\bhref="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/);
      assert.ok(encoded, `${item.id} should use the tinted SVG presentation in its badge`);
      assert.equal(Buffer.from(encoded[1], 'base64').toString(), presentation.toString());
    }
  }
});

test('README exposes exactly the source-backed stack and includes the confirmed Nexus description', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const stack = JSON.parse(await readFile(new URL('../config/stack-badges.json', import.meta.url), 'utf8'));
  assert.deepEqual(stack.map(({ label }) => label), ['Codex', 'OpenClaw', 'Hermes Agent', 'TypeScript', 'C#', 'Python', 'Swift', 'Rust', 'HTML', 'SQL', 'JavaScript', 'OpenWhispr', 'Prime Agent', 'Buzz', 'Ghostty', 'llama.cpp', 'Hindsight', 'Honcho', 'Docker', 'E2B', 'ComfyUI', 'macOS', 'Windows', 'Ubuntu', 'Omarchy', 'OpenAI Daybreak · Defensive security access', 'Apple Developer Program member', 'NVIDIA Developer Program', 'SPONSORED BY: E2B FOR STARTUPS']);
  for (const { id, href, group } of stack) {
    assert.ok(readme.includes(`href="${href}"`));
    const imageAsset = ['language', 'os', 'program'].includes(group) ? `assets/stack-${id}.svg` : `assets/stack-${id}-logo.svg`;
    assert.ok(readme.includes(imageAsset));
  }
  assert.ok(readme.includes('**Nexus**: agent orchestration, governance and harness infrastructure; in development.'));
  for (const section of ['Tools', 'Languages', 'Operating systems', 'Programs & support']) assert.ok(readme.includes(`### ${section}`));
  assert.ok(!readme.includes('**Vítor Cepeda Lopes** · Founder'));
  const programs = readme.split('### Programs & support')[1].split('## GitHub activity')[0];
  assert.equal((programs.match(/href="https:\/\/openai\.com\/daybreak\/"/g) || []).length, 1);
  assert.ok(programs.includes('alt="OpenAI Daybreak · Defensive security access"'));
  assert.ok(!programs.includes('Daybreak access for defensive security work.'));
  assert.ok(!/certified|certification|partner|\$20,000/i.test(programs));
  assert.ok(readme.includes('Storytelling, creativity and agentic systems.'));
  const languages = readme.split('### Languages')[1].split('### Operating systems')[0];
  assert.deepEqual([...languages.matchAll(/alt="([^"]+)"/g)].map((match) => match[1]), ['TypeScript', 'C#', 'Python', 'Swift', 'Rust', 'HTML', 'SQL', 'JavaScript']);
  assert.ok(!stack.some(({ label }) => label === 'Java'));
  assert.match(readme, /\[Writing\]\([^\n]+\) · \[X\]\(https:\/\/x\.com\/TheAngryPit\)/);
});

test('E2B uses the exact official Startups sponsorship badge, not an invented grant seal', async () => {
  const stack = JSON.parse(await readFile(new URL('../config/stack-badges.json', import.meta.url), 'utf8'));
  const grant = stack.find(({ id }) => id === 'egrant');
  assert.equal(badgeUrl(grant).href, 'https://img.shields.io/badge/SPONSORED%20BY-E2B%20FOR%20STARTUPS-ff3001?style=for-the-badge&labelColor=black');
  assert.equal(grant.href, 'https://e2b.dev/startups');
  assert.throws(() => badgeUrl({ label: 'E2B', badgeSource: 'https://example.test/badge.svg' }), /Unreviewed/);
  const svg = await readFile(new URL('../assets/stack-egrant.svg', import.meta.url), 'utf8');
  validateBadge(svg, grant.label);
  assert.ok(svg.includes('#ff3001'));
});
