import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const VENDOR_DIR = path.join(PACKAGE_DIR, 'vendor/github-profile-3d-contrib');
const PROVENANCE_PATH = path.join(VENDOR_DIR, 'provenance.json');

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function stripTypeOnlyImport(source, filename) {
  const statement = "import * as type from './type';";
  const occurrences = source.split(statement).length - 1;
  if (occurrences !== 1) throw new Error(`${filename} must contain its single expected type namespace import`);
  return source.replace(`${statement}\n`, '');
}

export function transformUpstreamTypeScript(source, filename) {
  let prepared = source;
  if (filename.endsWith('create-3d-contrib.ts') || filename.endsWith('create-css-colors.ts')) {
    prepared = stripTypeOnlyImport(prepared, filename);
  }
  const stripped = stripTypeScriptTypes(prepared, { mode: 'strip' });
  return stripped.replace("from './utils';", "from './utils.mjs';");
}

export async function buildCityAddon() {
  const provenance = JSON.parse(await readFile(PROVENANCE_PATH, 'utf8'));
  const generated = new Map();

  for (const sourceFile of provenance.sourceFiles) {
    const sourcePath = path.join(VENDOR_DIR, sourceFile.path);
    const source = await readFile(sourcePath, 'utf8');
    const actualHash = sha256(source);
    if (actualHash !== sourceFile.sha256) {
      throw new Error(`pinned upstream source hash mismatch for ${sourceFile.path}: ${actualHash}`);
    }
    const runtimePath = path.join(VENDOR_DIR, sourceFile.runtime);
    const runtime = transformUpstreamTypeScript(source, sourceFile.path);
    await mkdir(path.dirname(runtimePath), { recursive: true });
    await writeFile(runtimePath, runtime, 'utf8');
    generated.set(sourceFile.runtime, runtime);
  }

  const license = await readFile(path.join(VENDOR_DIR, provenance.licenseFile));
  if (sha256(license) !== provenance.sha256.LICENSE) throw new Error('pinned upstream license hash mismatch');
  return generated;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  buildCityAddon()
    .then((outputs) => console.log(`Built ${outputs.size} deterministic upstream addon modules.`))
    .catch((error) => {
      console.error(`Upstream addon build failed: ${error.message}`);
      process.exitCode = 1;
    });
}
