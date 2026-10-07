import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  METRIC_DEFINITIONS,
  USERNAME,
  makeMetrics,
  parseProductionContributionCalendar,
} from './data.mjs';

const DEFAULT_DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const API_SEARCH_URL = 'https://api.github.com/search/issues';
const API_VERSION = '2022-11-28';

async function fetchResponse(fetchImpl, url, { headers, timeoutMs }) {
  const response = await fetchImpl(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${new URL(url).pathname}`);
  if (response.url) {
    const actualHost = new URL(response.url).hostname;
    const expectedHost = new URL(url).hostname;
    if (actualHost !== expectedHost) throw new Error(`GitHub response came from unexpected host ${actualHost}`);
  }
  return response;
}

async function fetchCalendar(fetchImpl, { headers, timeoutMs, username, retrievedAt, now }) {
  const response = await fetchResponse(fetchImpl, `https://github.com/users/${username}/contributions`, { headers, timeoutMs });
  const contentType = response.headers?.get?.('content-type');
  if (contentType && !contentType.toLowerCase().includes('text/html')) throw new Error('GitHub contribution calendar response was not HTML');
  return parseProductionContributionCalendar(await response.text(), { username, retrievedAt, now });
}

async function fetchSearchCount(fetchImpl, definition, { headers, timeoutMs }) {
  const url = new URL(API_SEARCH_URL);
  url.searchParams.set('q', definition.query);
  url.searchParams.set('per_page', '1');
  const response = await fetchResponse(fetchImpl, url.toString(), { headers, timeoutMs });
  const contentType = response.headers?.get?.('content-type');
  if (contentType && !contentType.toLowerCase().includes('application/json')) throw new Error(`GitHub search response for ${definition.id} was not JSON`);
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`GitHub search response for ${definition.id} was malformed`);
  if (payload.incomplete_results !== false) throw new Error(`GitHub search results for ${definition.id} were incomplete`);
  if (!Number.isSafeInteger(payload.total_count) || payload.total_count < 0) throw new Error(`GitHub search count for ${definition.id} was invalid`);
  return payload.total_count;
}

async function readPrevious(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function commitSnapshot(dataDir, files) {
  await mkdir(dataDir, { recursive: true });
  const stagingDir = await mkdtemp(join(dataDir, '.refresh-'));
  const names = Object.keys(files);
  const previous = new Map();
  const published = [];

  try {
    for (const name of names) {
      if (basename(name) !== name || !name.endsWith('.json')) throw new Error(`unsafe snapshot filename: ${name}`);
      const target = join(dataDir, name);
      previous.set(name, await readPrevious(target));
      await writeFile(join(stagingDir, name), `${JSON.stringify(files[name], null, 2)}\n`, 'utf8');
      if (previous.get(name) !== null) await writeFile(join(stagingDir, `${name}.previous`), previous.get(name));
    }

    for (const name of names) {
      await rename(join(stagingDir, name), join(dataDir, name));
      published.push(name);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const name of published.reverse()) {
      const target = join(dataDir, name);
      try {
        const oldContent = previous.get(name);
        if (oldContent === null) await rm(target, { force: true });
        else {
          const restorePath = join(stagingDir, `${name}.restore`);
          await writeFile(restorePath, oldContent);
          await rename(restorePath, target);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'snapshot commit failed and rollback was incomplete');
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export async function refreshProfile({
  fetchImpl = globalThis.fetch,
  dataDir = DEFAULT_DATA_DIR,
  username = USERNAME,
  token = undefined,
  now = () => new Date(),
  timeoutMs = 15_000,
  commit = commitSnapshot,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('built-in fetch is unavailable in this Node.js runtime');
  const timestamp = now().toISOString();
  const calendarHeaders = {
    accept: 'text/html,application/xhtml+xml',
    'user-agent': 'theangrypit-github-profile-refresh',
  };
  const apiHeaders = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'theangrypit-github-profile-refresh',
  };
  if (token) apiHeaders.authorization = `Bearer ${token}`;

  // Fetch and validate every source before touching either last-good data file.
  const [contributions, ...counts] = await Promise.all([
    fetchCalendar(fetchImpl, { headers: calendarHeaders, timeoutMs, username, retrievedAt: timestamp, now: new Date(timestamp) }),
    ...METRIC_DEFINITIONS.map((definition) => fetchSearchCount(fetchImpl, definition, { headers: apiHeaders, timeoutMs })),
  ]);
  const metrics = makeMetrics(Object.fromEntries(METRIC_DEFINITIONS.map((definition, index) => [definition.id, counts[index]])), {
    username,
    retrievedAt: timestamp,
  });

  await commit(dataDir, {
    'contributions.json': contributions,
    'metrics.json': metrics,
  });
  return { contributions, metrics };
}

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  refreshProfile({ token: process.env.GITHUB_TOKEN })
    .then(({ contributions, metrics }) => {
      console.log(`Updated ${contributions.days.length} contribution days (${contributions.from} to ${contributions.to}) and ${metrics.metrics.length} public search counts.`);
    })
    .catch((error) => {
      console.error(`Profile refresh failed; existing data was preserved. ${error.message}`);
      process.exitCode = 1;
    });
}
