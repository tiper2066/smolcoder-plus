# Implementation Plan: Global Installation Support (smolcoder-plus)

## Goal
Enable users to install the tool globally using `npm install -g smolcoder-plus` and run it directly from the terminal using the `smolcoder-plus` command.

## ✅ Status: COMPLETED & PUBLISHED (2026-09-24)

**`smolcoder-plus@1.0.0` is live on npm:** https://www.npmjs.com/package/smolcoder-plus

```bash
npm install -g smolcoder-plus
smolcoder-plus
```

Verified end-to-end: `npm publish` → `npm view` → fresh `npm install` from the
registry → `smolcoder-plus --version` prints `1.0.0`.

## Current Status
- ✅ Source code is organized in the root directory.
- ✅ `package.json` has `bin` (`smolcoder-plus` → `dist/index.js`) and `files` (`dist`, `README.md`).
- ✅ TypeScript build pipeline produces an executable `dist/index.js` (shebang + `chmod 0o755`).
- ✅ Published as `smolcoder-plus@1.0.0`; the package also ships the integrated
  `web_search` tool (`dist/tools/web-search.js` — see
  `IMPLEMENTATION-PLAN-web-search-integration.md`).

## Implementation Steps

### 1. Update `package.json`
- [x] Change `name` from current to `smolcoder-plus`.
- [x] Add the `bin` field to map the command name to the compiled entry point.
  ```json
  "bin": {
    "smolcoder-plus": "dist/index.js"
  }
  ```
  (Note: published with `dist/index.js` without the leading `./` — npm warns and
  strips the `./` form.)

### 2. Refine execution entry point (`src/index.ts`)
- [x] Add a proper shebang (`#!/usr/bin/env node`) logic for the compiled output.
- [x] Ensure `src/index.ts` handles command-line arguments correctly.
- [x] Ensure the output is clean for terminal display.

### 3. Verify and optimize build pipeline
- [x] Run `npm run build` and verify that `dist/index.js` is correctly generated.
- [x] Check that the `bin` path in `package.json` points to the correct generated file.
- [x] Verify that the generated file has executable permissions (build script
      `chmod 0o755 dist/index.js`).

### 4. Local link testing (`npm link`)
- [x] Run `npm link` in the project root.
- [x] Test the `smolcoder-plus` command in various directories to ensure it works globally (on the local machine).
- [x] Verify that help menus and basic commands function as expected.

### 5. Final verification and preparation for publication
- [x] Verify that no unnecessary files (like `.env` or `node_modules`) are included in the build.
- [x] Review the `files` field in `package.json` to ensure only necessary files are published.
- [x] Final check of the `README.md` for installation instructions.

## Post-plan work (done during publish)
- Version bumped `0.7.1` → `1.0.0` (first official public release).
- README: added `npm install -g smolcoder-plus` as the primary install method,
  plus the 🌐 Internet Search setup/usage guide (Brave API key via `.env`).
- `.env` added to `.gitignore`.
- **Security incident & remediation**: `.env` (containing the Brave API key) was
  committed and pushed to the public repo before `.gitignore` was in place.
  Fixed with `git filter-repo --path .env --invert-paths` + force-push (verified
  via GitHub API). **Key rotation confirmed by the user (2026-09-24):** the old
  exposed key was replaced in the Brave dashboard, the new key is in the local
  `.env`, and a live `web_search` call with the new key returned normal results.
- npm publishing required a **granular access token with "Bypass two-factor
  authentication"** (the account has 2FA enabled); a plain `npm login` token
  gets `403`.
- Local note: `npm install -g` on this machine needs `sudo` (or
  `chown` of `/usr/local/lib/node_modules`) because the global prefix is
  root-owned.
