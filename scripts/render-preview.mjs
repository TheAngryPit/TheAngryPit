import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { METRIC_DEFINITIONS, USERNAME } from './data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW_DIR = path.join(ROOT, 'preview');
const README_PATH = path.join(ROOT, 'README.md');
const API_HTML_PATH = path.join(PREVIEW_DIR, 'github-rendered.html');
const OUTPUT_PATH = path.join(PREVIEW_DIR, 'index.html');
const DEFAULT_PREVIEW_URL = pathToFileURL(OUTPUT_PATH).href;

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function isRawBlock(line) {
  return /^\s*<(?:picture|details\b|a\s|img\b|source\b)/i.test(line);
}

function localAssetPath(value) {
  const trimmed = value.trim();
  if (!trimmed || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('./')) return `../${trimmed.slice(2)}`;
  if (trimmed.startsWith('assets/')) return `../${trimmed}`;
  return trimmed;
}

function rewriteSrcset(srcset) {
  return srcset.split(',').map((candidate) => {
    const [url, ...descriptors] = candidate.trim().split(/\s+/);
    return [localAssetPath(url), ...descriptors].filter(Boolean).join(' ');
  }).join(', ');
}

export function rewritePreviewAssetPaths(fragment) {
  return fragment.replace(/\b(src|srcset)=(['"])(.*?)\2/gi, (attribute, name, quote, value) => {
    const rewritten = name.toLowerCase() === 'srcset' ? rewriteSrcset(value) : localAssetPath(value);
    return `${name}=${quote}${rewritten}${quote}`;
  });
}

export function renderMarkdownSubset(markdown) {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    if (/^\s*<details\b/i.test(line)) {
      const block = [line];
      index += 1;
      while (index < lines.length) {
        block.push(lines[index]);
        const done = /<\/details\s*>/i.test(lines[index]);
        index += 1;
        if (done) break;
      }
      const markup = block.join('\n');
      if (!/<\/details\s*>/i.test(markup)) throw new Error('README details block is missing its closing tag');
      const summary = markup.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
      if (!summary) throw new Error('README details block is missing a summary');
      const body = markup
        .slice(summary.index + summary[0].length)
        .replace(/<\/details\s*>/i, '');
      output.push(`<details>\n<summary>${inlineMarkdown(summary[1].trim())}</summary>\n${renderMarkdownSubset(body)}\n</details>`);
      continue;
    }

    if (/^\s*<picture\b/i.test(line)) {
      const block = [line];
      index += 1;
      while (index < lines.length) {
        block.push(lines[index]);
        const done = /<\/picture\s*>/i.test(lines[index]);
        index += 1;
        if (done) break;
      }
      output.push(block.join('\n'));
      continue;
    }

    if (/^\s*<a\s/i.test(line)) {
      output.push(line.trim());
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*-\s+/.test(lines[index])) {
        items.push(`<li>${inlineMarkdown(lines[index].replace(/^\s*-\s+/, ''))}</li>`);
        index += 1;
      }
      output.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^#{1,6}\s+/.test(lines[index]) && !/^\s*-\s+/.test(lines[index]) && !isRawBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
  }

  return output.join('\n');
}

function previewDocument(fragment, sourceLabel) {
  const safeFragment = rewritePreviewAssetPaths(fragment);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Vítor Cepeda Lopes — GitHub profile preview</title>
  <style>
    :root { color-scheme: light dark; --bg: #ffffff; --panel: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d0d7de; --link: #0969da; --soft: #f6f8fa; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --panel: #0d1117; --fg: #f0f6fc; --muted: #a6b0bb; --border: #30363d; --link: #58a6ff; --soft: #161b22; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .preview-note { max-width: 1080px; margin: 22px auto 12px; padding: 12px 16px; border: 1px solid var(--border); background: var(--soft); color: var(--muted); font-size: 13px; }
    .preview-note strong { color: var(--fg); }
    main { max-width: 1080px; margin: 0 auto 38px; padding: 34px 38px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); overflow-wrap: anywhere; }
    h1, h2, h3 { margin: 24px 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--border); line-height: 1.25; }
    h1 { margin-top: 18px; font-size: 2em; }
    h2 { font-size: 1.5em; }
    h3 { font-size: 1.15em; }
    p { margin: 0 0 16px; }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    ul { padding-left: 2em; margin: 0 0 16px; }
    li + li { margin-top: 4px; }
    picture { display: block; margin: 14px 0; }
    picture img { display: block; max-width: 100%; height: auto; }
    main > picture:first-child { margin: -2px 0 20px; }
    main > picture:first-child img { width: 100%; }
    main > a { display: inline-block; margin: 0 8px 18px 0; vertical-align: middle; }
    details { margin: 22px 0 0; }
    details > summary { cursor: pointer; font-weight: 600; }
    details > summary:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
    @media (max-width: 640px) {
      .preview-note { margin: 12px; }
      main { margin: 0 12px 24px; padding: 20px 16px; }
      h1 { font-size: 1.75em; }
      picture { margin: 12px -4px; }
      main > a { margin-right: 4px; }
    }
  </style>
</head>
<body>
  <aside class="preview-note"><strong>Local rendering preview — GitHub rendering unverified.</strong> ${sourceLabel}. This view has no invented profile sidebar and does not prove the live profile page, image proxy/cache, or Actions behavior.</aside>
  <main>${safeFragment}</main>
</body>
</html>
`;
}

export function selectPreviewContent(markdown, rendered, receiptText) {
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  let receipt;
  try { receipt = receiptText ? JSON.parse(receiptText) : null; } catch { receipt = null; }
  const isCurrentGitHubFragment = rendered !== null
    && receipt?.status === 'passed'
    && receipt.readmeSha256 === digest(markdown)
    && receipt.responseSha256 === digest(rendered);
  if (isCurrentGitHubFragment) {
    return {
      fragment: rendered,
      source: 'github-markdown-api',
      label: 'Using the saved GitHub-rendered fragment whose receipt hashes match README.md and the preserved response',
    };
  }
  return {
    fragment: renderMarkdownSubset(markdown),
    source: 'local-readme-renderer',
    label: rendered !== null
      ? 'A saved GitHub-rendered fragment is present but has no matching current receipt; showing the local README-derived fallback'
      : 'Derived directly from README.md with a small local Markdown renderer',
  };
}

export async function renderPreview() {
  const [markdown, rendered, receiptText] = await Promise.all([
    readFile(README_PATH, 'utf8'),
    readFile(API_HTML_PATH, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)),
    readFile(path.join(PREVIEW_DIR, 'github-render-receipt.json'), 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)),
  ]);
  const selected = selectPreviewContent(markdown, rendered, receiptText);
  await mkdir(PREVIEW_DIR, { recursive: true });
  await writeFile(OUTPUT_PATH, previewDocument(selected.fragment, selected.label), 'utf8');
  return { path: OUTPUT_PATH, source: selected.source };
}

async function captureScreenshots() {
  const { chromium } = await import('playwright');
  const previewUrl = process.env.PROFILE_PREVIEW_URL || DEFAULT_PREVIEW_URL;
  const screenshotDir = path.join(PREVIEW_DIR, 'screenshots');
  await mkdir(screenshotDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [device, viewport] of [
      ['desktop', { width: 1440, height: 1000 }],
      ['mobile', { width: 390, height: 844 }],
    ]) {
      for (const colorScheme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.goto(previewUrl, { waitUntil: 'networkidle', timeout: 15_000 });
        await page.locator('img').evaluateAll((images) => Promise.all(images.map((image) => image.decode().catch(() => undefined))));
        const note = await page.locator('.preview-note').innerText();
        if (!note.includes('GitHub rendering unverified')) throw new Error('preview disclaimer is missing');
        if (await page.locator('aside').count() !== 1) throw new Error('preview should show only its disclaimer, not a profile sidebar');
        const details = page.locator('main details');
        if (await details.count() !== 1) throw new Error('preview must preserve the collapsed data/source details block');
        if (await details.evaluate((element) => element.open)) throw new Error('source details should be collapsed by default');
        const sourceLinks = await details.locator('a').evaluateAll((anchors) => anchors.map((anchor) => anchor.href));
        if (!sourceLinks.includes(`https://github.com/users/${USERNAME}/contributions`)) throw new Error('collapsed details must retain the calendar source');
        for (const definition of METRIC_DEFINITIONS) {
          if (!sourceLinks.some((href) => {
            const url = new URL(href);
            return url.origin === 'https://api.github.com' && url.pathname === '/search/issues' && url.searchParams.get('q') === definition.query;
          })) throw new Error(`collapsed details must retain the ${definition.id} search source`);
        }
        const detailsText = await details.evaluate((element) => element.textContent);
        for (const required of ['privacy-obscured', 'distinct pull requests ever reviewed', 'review submissions', 'all-time snapshots']) {
          if (!detailsText.includes(required)) throw new Error(`collapsed sources are missing required note: ${required}`);
        }
        const summary = details.locator('summary');
        await summary.focus();
        await page.keyboard.press('Enter');
        if (!(await details.evaluate((element) => element.open))) throw new Error('source summary did not open from the keyboard');
        const visibleDetailsText = await details.innerText();
        for (const required of ['privacy-obscured', 'distinct pull requests ever reviewed', 'review submissions', 'all-time snapshots']) {
          if (!visibleDetailsText.includes(required)) throw new Error(`opened sources are missing visible note: ${required}`);
        }
        await page.keyboard.press('Enter');
        if (await details.evaluate((element) => element.open)) throw new Error('source summary did not collapse from the keyboard');
        await summary.evaluate((element) => element.blur());
        const visualChecks = await page.evaluate(() => ({
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          images: Array.from(document.images, (image) => ({ alt: image.alt, loaded: image.complete && image.naturalWidth > 0, source: image.currentSrc })),
        }));
        if (visualChecks.documentWidth > visualChecks.width) throw new Error(`${device}-${colorScheme} preview overflows horizontally`);
        if (visualChecks.images.some((image) => !image.alt || !image.loaded)) throw new Error(`${device}-${colorScheme} preview has an image without alt text or a loaded local asset`);
        const chartSources = visualChecks.images.filter(({ alt }) => /^(Three-dimensional contribution calendar|Public GitHub search counts)/.test(alt)).map(({ source }) => source);
        if (chartSources.length !== 2) throw new Error('preview must include the contribution calendar and metrics chart');
        if (device === 'mobile' && chartSources.some((source) => !source.includes(`mobile-${colorScheme}.svg`))) {
          throw new Error(`${device}-${colorScheme} preview did not select mobile theme-specific SVGs`);
        }
        if (device === 'desktop' && chartSources.some((source) => !source.includes(`-${colorScheme}.svg`) || source.includes('-mobile-'))) {
          throw new Error(`${device}-${colorScheme} preview did not select desktop theme-specific SVGs`);
        }
        const destination = path.join(screenshotDir, `${device}-${colorScheme}.png`);
        await page.screenshot({ path: destination, fullPage: true });
        console.log(`${device}-${colorScheme}: ${destination}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  renderPreview()
    .then(async (result) => {
      console.log(`Generated ${result.path} from ${result.source}.`);
      if (process.argv.includes('--screenshots')) await captureScreenshots();
    })
    .catch((error) => {
      console.error(`Preview generation failed: ${error.message}`);
      process.exitCode = 1;
    });
}
