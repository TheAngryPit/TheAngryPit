# Upstream addon provenance

This package vendors the 3D calendar geometry and its normal-theme color helper from [`yoshi389111/github-profile-3d-contrib`](https://github.com/yoshi389111/github-profile-3d-contrib/tree/9e3f937195cf840d364388973f73e3c4b3753586), pinned at commit `9e3f937195cf840d364388973f73e3c4b3753586` under the MIT license. The original TypeScript sources are preserved unchanged in `upstream/src/`; `provenance.json` records their SHA-256 hashes and the checked-in runtime transform.

Only `create3DContrib`, `createCssColors`, and `toFixed` are used. `scripts/build-city-addon.mjs` mechanically strips TypeScript types with Node's built-in `stripTypeScriptTypes` and performs the two import-only rewrites listed in `provenance.json`. It does not alter contribution geometry, date placement, height encoding, or color shading.

The local adapter supplies the validated public contribution calendar directly. It does not call the upstream entrypoint, query GraphQL, access private repositories, or render upstream radar, language, pie, lifetime, repository, or other statistics. The three all-time search counts are rendered separately from their own validated snapshot.
