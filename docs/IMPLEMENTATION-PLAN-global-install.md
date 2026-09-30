# Implementation Plan: Global Installation Support (smolcoder-plus)

## Goal
Enable users to install the tool globally using `npm install -g smolcoder-plus` and run it directly from the terminal using the `smolcoder-plus` command.

## ✅ Status: PUBLISHED — 최신 `smolcoder-plus@1.1.0` (2026-09-30)

<https://www.npmjs.com/package/smolcoder-plus> · <https://github.com/tiper2066/smolcoder-plus/releases>

**`smolp` / `smolcoder-plus` 를 쓰려면:** 아래 "npm 전역 prefix" 절을 먼저 확인. 전역 prefix 가
root 소유면 `npm install -g` 가 `EACCES: rename` 로 실패한다 (버전 문제가 아니라 권한 문제다).

```bash
npm install -g smolcoder-plus
smolp            # short alias — same command
```

Verified end-to-end for every release: `npm publish` → `npm view` → fresh install from the
registry with an empty cache → the installed tarball's shasum matches what the registry
reports, and both `smolp --version` and `smolcoder-plus --version` print the expected version.

### npm 전역 prefix 를 사용자 소유로 이동 (2026-09-30)

`npm install -g smolcoder-plus` 가 `EACCES: rename` 로 실패했다. **버전 문제가 아니었다.**

```
/usr/local/lib/node_modules/  → root:wheel (macOS 공식 Node 설치본의 기본 상태)
/usr/local/lib/node_modules/smolcoder-plus → root 소유 **심볼릭 링크** → 로컬 체크아웃
```

registry 패키지를 설치하려면 그 root 소유 링크를 실제 디렉터리로 **교체(rename)** 해야 하는데
권한이 없어 실패한다. sudo 없이 전역 설치가 되도록 prefix 를 옮겼다.

```
npm config set prefix "$HOME/.npm-global"          # ~/.npmrc 에 기록
# ~/.zshrc 맨 끝에 (나중의 PATH 변경을 이기도록 마지막에 추가)
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g smolcoder-plus
```

`~/.zshrc` 는 수정 전에 백업했다. `/usr/local` 의 root 소유 링크는 `sudo` 가 필요해
지우지 않았고, 새 경로를 PATH **앞** 에 두어 `/usr/local/bin/smolp` 보다 먼저 해석되게 했다
(`which -a smolp` 로 두 경로가 모두 보이는 것을 확인). 완전 제거하려면:

```bash
sudo rm -f /usr/local/bin/smolp /usr/local/bin/smolcoder-plus
sudo rm -f /usr/local/lib/node_modules/smolcoder-plus   # 심볼릭 링크만 지운다
```

### 1.1.0 — File Edit 패널 + 사이드바 파일 트리 (2026-09-30)
- 좌측 사이드바에 **Sessions / Files 탭** + 워크스페이스 파일 트리 (dot 파일 노출, 빌드 산출물·`.git` 숨김).
- 우측 패널에 **`file` kind 탭**: 파일을 열고 편집·저장 (`Ctrl/Cmd+S`), mtime 충돌 시 확인 후에만 덮어씀,
  읽기 전용 세션·바이너리·워크스페이스 밖 파일은 **탭을 만들지 않고** 사유를 알림.
- 트리에서 파일 **클릭 = 에디터로 열기**(행 hover `＋` 는 composer 에 경로 삽입).
- `⛶` **전체화면 패널** 수정 — 이전엔 `position: absolute` + `width: var(--fw-panel)` 이라
  절반 폭으로 채팅을 덮고 있었다. 이제 `#main` 을 숨기고 flex 로 확장하므로 진짜 전체 폭이 된다.
- `#paneltabs` 안에 있던 `#panelfull` 버그 수정 — `renderPanel()` 이 스트립을 비우면서 버튼을 파괴.

### 1.0.6 — LM Studio vision 감지 수정 (2026-09-26, 2026-09-30 소급 등록)
- LM Studio 1.1.x(Bionic) 는 **모든 모델을 `type: "llm"` 로 보고**, 이미지 지원 여부는
  `capabilities.vision` 에 둔다. `type` 만 읽으면 vision 모델이 text-only 로 잡혀
  **첨부한 이미지가 조용히 누락**되고 있었다.
- `capabilities.vision` 을 우선하고, 옛 `type: "vlm"` 라벨은 폴백으로 유지.
  두 값이 어긋나면 capability 를 신뢰. v0 / v1 API 양쪽에 적용.

### 릴리스 기록 규칙 (2026-09-30 확정)

`npm publish` 는 **GitHub Release 를 만들지 않는다.** 둘은 별개 동작이라 자동으로 따라오지 않는다.
npm 게시와 GitHub Release 를 **같은 커밋에서 같이** 처리할 것. 과거에 1.0.6 이 npm 에만 올라가
GitHub Release 가 누락돼 있었고, 2026-09-30 에 소급해 tag `v1.0.6` + 릴리스 를 복원했다.

```
1) npm version <x.y.z> --no-git-tag-version   # package.json / lock
2) npm test                                    # prepublishOnly 도 하지만 미리 확인
3) git commit                                 # 버전 + README
4) git push
5) npm publish
6) gh release create v<버전> --title "..." --notes-file <노트>
7) gh release edit v<버전> --latest           # ★ 나중에 만든 구버전 릴리스가 Latest 를 뺏을 수 있다
```

**★ 7번을 빠뜨리기 쉬움.** 소급 릴리스(1.0.6)를 1.1.0 이후에 만들면 GitHub 가 그 릴리스를
`Latest` 로 지정해버린다. 소급 릴리스 를 만든 뒤에는 항상 `--latest` 를 지정해줄 것.

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
