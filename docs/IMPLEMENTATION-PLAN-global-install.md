# Implementation Plan: Global Installation Support (smolcoder-plus)

## Goal
Enable users to install the tool globally using `npm install -g smolcoder-plus` and run it directly from the terminal using the `smolcoder-plus` command.

## ✅ Status: COMPLETED & PUBLISHED (2026-09-24)

**`smolcoder-plus@1.0.1` is live on npm:** https://www.npmjs.com/package/smolcoder-plus

```bash
npm install -g smolcoder-plus
smolp            # short alias — same command
```

Verified end-to-end: `npm publish` → `npm view` → fresh `npm install` from the
registry → both `smolp --version` and `smolcoder-plus --version` print `1.0.1`.

### 1.1.0 — File Edit 패널 + 사이드바 파일 트리 (2026-09-30)
- 좌측 사이드바에 **Sessions / Files 탭** + 워크스페이스 파일 트리 (dot 파일 노출, 빌드 산출물·`.git` 숨김).
- 우측 패널에 **`file` kind 탭**: 파일을 열고 편집·저장 (`Ctrl/Cmd+S`), mtime 충돌 시 확인 후에만 덮어씀,
  읽기 전용 세션·바이너리·워크스페이스 밖 파일은 **탭을 만들지 않고** 사유를 알림.
- 트리에서 파일 **클릭 = 에디터로 열기**(행 hover `＋` 는 composer 에 경로 삽입).
- `⛶` **전체화면 패널** 수정 — 이전엔 `position: absolute` + `width: var(--fw-panel)` 이라
  절반 폭으로 채팅을 덮고 있었다. 이제 `#main` 을 숨기고 flex 로 확장하므로 진짜 전체 폭이 된다.
- `#paneltabs` 안에 있던 `#panelfull` 버그 수정 — `renderPanel()` 이 스트립을 비우면서 버튼을 파괴.

### 1.0.1 — `smolp` alias (2026-09-24)
- `bin` now ships **two** entries: `smolp` and `smolcoder-plus` (same entry point).
- CLI messages use the command the user actually typed (`CMD` in `src/index.ts`),
  so help/errors/web banner say `smolp` when launched as `smolp`.
- README install section documents both commands.

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
