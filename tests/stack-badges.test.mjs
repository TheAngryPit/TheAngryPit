import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { badgeUrl, validateBadge } from '../scripts/fetch-stack-badges.mjs';

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

test('README exposes exactly the source-backed stack and includes the confirmed Nexus description', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const stack = JSON.parse(await readFile(new URL('../config/stack-badges.json', import.meta.url), 'utf8'));
  assert.deepEqual(stack.map(({ label }) => label), ['Codex', 'OpenClaw', 'Hermes Agent', 'TypeScript', 'C#', 'Python', 'Swift', 'Rust', 'HTML', 'SQL', 'JavaScript', 'OpenWhispr', 'Prime Agent', 'Buzz', 'Ghostty', 'llama.cpp', 'Hindsight', 'Honcho', 'Docker', 'E2B', 'ComfyUI', 'macOS', 'Windows', 'Ubuntu', 'Omarchy', 'OpenAI Daybreak access', 'Apple Developer Program member', 'NVIDIA Developer Program', 'SPONSORED BY: E2B FOR STARTUPS']);
  for (const { id, href } of stack) {
    assert.ok(readme.includes(`href="${href}"`));
    assert.ok(readme.includes(`assets/stack-${id}.svg`));
  }
  assert.ok(readme.includes('**Nexus**: agent orchestration, governance and harness infrastructure; in development.'));
  for (const section of ['Tools', 'Languages', 'Operating systems', 'Programs & support']) assert.ok(readme.includes(`### ${section}`));
  assert.ok(!readme.includes('**Vítor Cepeda Lopes** · Founder'));
  const programs = readme.split('### Programs & support')[1].split('## GitHub activity')[0];
  assert.ok(!/certified|certification|partner|\$20,000/i.test(programs));
  assert.ok(readme.includes('Storytelling, creativity and agentic systems.'));
  const languages = readme.split('### Languages')[1].split('### Operating systems')[0];
  assert.deepEqual([...languages.matchAll(/alt="([^"]+)"/g)].map((match) => match[1]), ['TypeScript', 'C#', 'Python', 'Swift', 'Rust', 'HTML', 'SQL', 'JavaScript']);
  assert.ok(!stack.some(({ label }) => label === 'Java'));
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
