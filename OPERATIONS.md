# Package operations

This directory is the portable package for the published [TheAngryPit profile](https://github.com/TheAngryPit). Publication and the first automatic refresh were verified on 7 October 2026. The local Node scripts generate files; repository commits and pushes are handled separately or by the narrowly scoped workflow.

## Local commands

- `npm run refresh` fetches GitHub's publicly displayed contribution calendar and three public Search API counts. It uses GitHub's built-in token only for REST API rate limits when `GITHUB_TOKEN` is present; that token is never sent to `github.com`. It validates every source before atomically replacing either JSON snapshot. Failed, malformed, or incomplete responses leave the last-good files intact.
- `npm run render` regenerates deterministic dark/light and mobile/desktop activity SVGs, badges, concise README data notes, and the source links/qualifications inside the collapsed README details block. It makes no network requests.
- `npm run render:assets` uses the pinned upstream `create3DContrib` geometry and `createCssColors` helper from `vendor/github-profile-3d-contrib/`. The wrapper maps only the already-validated public calendar into the upstream `{ date, contributionCount, contributionLevel }` shape; upstream Sunday-first placement, log-scaled bar heights, and face shading remain unchanged. It does not call GraphQL or use the addon’s radar, language, pie, or lifetime-statistic renderers.
- `scripts/build-city-addon.mjs` verifies the upstream TypeScript source and MIT license hashes, then reproducibly strips types with Node's built-in `stripTypeScriptTypes`. The checked-in provenance identifies the exact upstream commit and the two mechanical import rewrites. Runtime dependencies are pinned to `d3@7.9.0` and `jsdom@26.0.0`; use `npm ci --ignore-scripts` for a clean install.
- `npm test` checks date continuity, annual-window freshness at the production refresh boundary, source totals, year boundaries, GitHub's linked-tooltip calendar shape, last-good preservation, credential scope, future mutable snapshots, deterministic rendering, collapsed-source parsing, and cached-preview receipt freshness.
- `npm run preview` writes `preview/index.html` from `README.md`. A saved `preview/github-rendered.html` fragment is reused only when its receipt matches both the current README hash and the fragment hash; the original evidence file remains unchanged. Otherwise, it uses a deliberately small local Markdown renderer.
- `npm run preview:screenshots` captures desktop/mobile and light/dark screenshots using the installed Playwright browser. It checks that source details start collapsed, remain keyboard-operable, and retain their links/qualification notes. It uses a local file URL by default, starts no server, and accepts `PROFILE_PREVIEW_URL` when a different already-running local preview is preferred.
- `npm run render:banner` is an optional, local Playwright-based banner regeneration. The checked-in PNG is the publishable artifact; no font file is included.

## Scheduled refresh

`.github/workflows/profile-refresh.yml` supports a weekly schedule and manual dispatch. The job's only write permission is `contents: write`; it stages an explicit list of JSON, README, and generated chart files, then commits only when their content changes. It does not run for pull requests, use a personal token, or keep the schedule alive with unrelated commits.

The weekly/manual workflow is enabled in the public `TheAngryPit/TheAngryPit` repository. Its [first manual run](https://github.com/TheAngryPit/TheAngryPit/actions/runs/37697543823) completed installation, public-data refresh, chart generation, tests and a generated-data commit successfully. GitHub may disable scheduled workflows after 60 days of repository inactivity; an owner can run `workflow_dispatch` when needed. A successful first run does not guarantee future scheduled runs.

## Verification boundary

The local preview is an approximation and deliberately carries the label **“Local rendering preview — GitHub rendering unverified.”** Separately, the actual published GitHub profile was read back and visually inspected, and the successful Actions run provides operational refresh proof. The optional Markdown API POST was not performed. Current proof covers the inspected desktop profile and local mobile/light/dark variants, not every handset, future cache state or future execution. Avatar, account settings, private repositories, credentials, CV/Sites and domain state were not changed.
