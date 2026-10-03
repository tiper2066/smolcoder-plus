# 📋 Handoff — Mac 데스크탑 앱 + API Key 설정 UI (SMOL Coder Plus)

**작성일:** 2026-10-03
**최종 업데이트:** 2026-10-03 (Phase 5 완료 — 전 단계 완료, `npm test` 193 pass)
**프로젝트:** smolcoder-plus v1.3.0 (`smolp` / `smolcoder-plus`, `engines: node >= 18`)
**관련 문서:** `docs/web-ui-changes-handoff.md`, `docs/IMPLEMENTATION-PLAN-web-search-integration.md`, `AGENTS.md`

> 이 문서는 새 세션이 작업 시작 전에 **현황을 빠르게 파악**하고 각 단계를 체크할 수 있도록 작성된 것입니다.
> **이 문서의 코드 위치는 2026-10-03에 실제 소스로 검증한 값입니다.** 문서와 코드가 다르면 코드를 먼저 확인하고 이 문서를 고치세요.

---

## 0. 목표와 현재 상태

**목표:** 터미널로 `smolp --web`을 띄우는 단계를 없애고, Mac 데스크탑 앱을 더블클릭하면 서버가 자동 기동 + Web UI가 열리게 한다. 인터넷 검색용 `BRAVE_API_KEY`를 `.env` 파일 대신 앱 내 설정 화면에서 입력받는다.

**확정된 결정 (2026-10-03, 사용자와 합의):**

1. **저장소는 하나.** 이 `smol-test` repo에서 계속한다. 별도 git 프로젝트를 만들지 않는다.
2. **npm 패키지는 두 개.** 루트 `package.json`은 zero-dep 유지, Electron 의존성은 `apps/desktop/` 별도 패키지에 가둔다 (`AGENTS.md` 절대규칙 2 준수).
3. **TUI/Web은 유지.** 데스크탑앱은 얇은 껍데기(자동 기동 + 창 내장)일 뿐, 에이전트 로직은 기존 것을 공유한다.
4. **키 우선순위:** `실제 환경변수 > ~/.smolcoder.json(config) > .env` — 기존 `.env` 동작은 하위호환으로 유지한다.

**현재 상태: 전부 완료.** ✅

| 단계 | 상태 | 검증 |
|---|---|---|
| 1. `Config.braveApiKey` + 키 해석 순서 변경 | ✅ 2026-10-03 | `npm test` 182 pass (신규 6개 포함) |
| 2. Hub `/settings` API (읽기/저장) | ✅ 2026-10-03 | `npm test` 184 pass (신규 2개 포함) |
| 3. Web 설정 화면 (`page.ts`/`styles.ts`/`client.ts`) | ✅ 2026-10-03 | `npm test` 186 pass (신규 2개 포함) + 실서버 실측 |
| 4. Electron 껍데기 `apps/desktop/` | ✅ 2026-10-03 | `npm test` 193 pass (신규 7개 포함) + dmg 실기동 검증 |
| 5. 패키징·서명·문서 마무리 | ✅ 2026-10-03 | 키 누출 검사 + README 반영 (미서명으로 배포 결정) |
| 3. Web 설정 화면 (`page.ts`/`styles.ts`/`client.ts`) | ⬜ | `npm test` (bundle 구문 + id 존재) + headless 실측 |
| 4. Electron 껍데기 `apps/desktop/` | ⬜ | `npm test` (core 회귀 없음) + Mac 실기 `.dmg` 실행 |
| 5. 패키징·서명·문서 마무리 | ⬜ | `npm pack` 키 누출 검사 + README/`docs` 반영 |

**다음 작업 전에는 반드시 읽을 것:**

1. `docs/web-ui-changes-handoff.md` §0.1 — `client.ts`는 `String.raw` 템플릿이라 `tsc`가 JS 문법 오류를 못 잡는다. `test/web.test.js`의 2개 가드가 대신 잡는다.
2. `AGENTS.md` 절대규칙 — `dist/` 직접 수정 금지, 런타임 의존성 추가 전 사용자에게 질문, 비밀값 커밋 금지, 주석·식별자는 영어.
3. 아래 §6 보안 규칙 — hub 인증(`?k=` + same-origin + loopback) 누락 금지, `innerHTML` 금지.

---

## 1. 사전 지식 (2026-10-03 실측 — 반드시 먼저 읽기)

### 1.1 진입점과 Web 기동 (`src/index.ts`)

* `parseArgs` — `--web [port]` 파싱 (`src/index.ts:103-105`), 기본 포트 `DEFAULT_WEB_PORT = 7433` (`:42`).
* `runWeb` (`:348-386`) — 실행 중인 hub가 있으면 `readHubRecord + pingHub + askHubToOpen`으로 폴더만 추가하고 종료 (`:356-365`). 없으면 `new WebHub({ port, prefs, help, version })` → `hub.start()` → `hub.openSession(workspace)` (`:367-380`).
* 데스크탑앱 Phase 4는 이 `runWeb`을 복제하지 말고, `WebHub` 클래스를 직접 쓴다 (Electron `main`에서 import).

### 1.2 Hub (`src/web/hub.ts`)

* `WebHub` — `authToken = crypto.randomBytes(9).toString("base64url")` (`:333`), `listen(port, "127.0.0.1")` (`:366`), `url()`은 `http://127.0.0.1:<port>/?k=<token>` (`:357-359`).
* 인증 가드 (`:846-853`) — 모든 라우트에서 `?k=<token>` + same-origin 검사, 실패 시 403. **신규 `/settings` 라우트도 이 가드 안쪽에 둔다.**
* `handlePost` (`:1074-1160`) — POST 디스패치 테이블. `/settings/get`, `/settings/save`를 여기에 추가한다.
* 파일 저장용 상태 코드 분기 (`saveWorkspaceFile`, `:574-589`)가 선례 — 설정 저장도 `{ ok }` / `{ error }` 평탄 계약을 따른다.
* 세션 저장 경로 — `SessionStore`/`WorkspaceStore` (`src/web/store.ts`), 데이터 dir `DATA_DIR = ~/.smolcoder` (`src/config.ts:14`).

### 1.3 설정 (`src/config.ts`)

* `CONFIG_PATH = process.env.SMOLCODER_CONFIG || ~/.smolcoder.json` (`:13`), `loadConfig/saveConfig/updateConfig` (`:35-70`).
* `Config` 필드 (`:26-33`): `lastModel, lastModelUrl, lastMode, effort, hosts`. 여기에 `braveApiKey?: string`을 추가한다 (Phase 1).
* `lastMode`는 bypass 상속 금지 정규화가 이미 있음 (`:40-44`) — 키 저장 시에도 평문 노출 최소화(파일 `600`)를 고려한다.

### 1.4 키 로드 현황 (`src/tools/web-search.ts`)

* `loadDotEnv` (`:18-53`) — `process.cwd()`부터 부모로 ascend하며 `.env` 탐색, `key in process.env`면 덮어쓰지 않음 (`:41`).
* `searchBrave` (`:90-107`) — 헤더 `X-Subscription-Token: process.env.BRAVE_API_KEY` (`:95`).
* `webSearch` (`:110-121`) — 키 없으면 `"Error: Missing BRAVE_API_KEY environment variable."` (`:114-115`).
* 도구 설명 (`src/tools/index.ts:70`) — `"Requires BRAVE_API_KEY in .env."` 문구가 있음. Phase 1에서 `"Requires BRAVE_API_KEY (Settings or .env)."`로 갱신한다.
* `.env`는 `.gitignore:3`에 있음. `npm pack` tarball에 키가 들어가지 않는ことは `IMPLEMENTATION-PLAN-web-search-integration.md`에서 검증됨.

### 1.5 Web 페이지 구조 (`src/web/page.ts`, `client.ts`, `styles.ts`)

* `PAGE_HTML` (`src/web/page.ts:23`) — 단일 HTML 문서, 스타일은 `${STYLES}`, 동작은 `${CLIENT_JS}` 인라인. 오프라인 WebView 호환.
* 사이드바 `id="side"`, 패널 `#panel`, composer는 `client.ts`의 `el(tag, cls, text)` 헬퍼(`textContent`만)로 생성 — **설정 화면도 `innerHTML` 없이 이 헬퍼를 쓴다.**
* `client.ts` 직접 `fetch`는 `?k=<token>` 수동 첨부 (`post()`만 자동) — `docs/web-ui-changes-handoff.md` 함정 4가지 참조.

---

## 2. 단계별 계획 + 상태 체크

### Phase 1 — `Config.braveApiKey` + 키 해석 순서 ✅ 2026-10-03 완료

**왜:** `.env` 없이 앱 설정에서 키를 받기 위한 저장소 마련. 기존 `.env` 사용자는 깨지면 안 된다.

**한 일 (코드 검증됨):**

- [x] `src/config.ts` — `Config`에 `braveApiKey?: string` 추가, load 시 trim·빈값 삭제, `saveConfig` 후 `chmod 600` (실측 `100600`).
- [x] `SMOLCODER_CONFIG`를 호출 시점에 해석 — 테스트가 scratch 파일로 리다이렉트 가능.
- [x] `src/tools/web-search.ts` — `resolveBraveKey()` (env > config > `.env`), 누락 메시지 갱신, `searchBrave(query, n, key)`에 키 전달.
- [x] `src/tools/index.ts:70` description 갱신.
- [x] `test/config.test.js` 3개 + `test/web-search.test.js` 3개 추가, 기존 누락-키 테스트 갱신.
- [x] `npm test` 182 pass (신규 6개 포함, 기존 회귀 없음).

### Phase 2 — Hub `/settings` API ✅ 2026-10-03 완료

**왜:** Web UI(와 나중에 Electron)가 키를 읽고 저장할 통로. 인증·검증은 서버가 담당한다.

**한 일 (코드 검증됨):**

- [x] `src/web/hub.ts` — 순수 함수 `getSettingsStatus()`/`saveSettingsKey()` + `SETTINGS_KEY_CAP = 200`. 평문 반환 금지, hint는 앞 4자 + `••••`. env 설정 시 `envOverride: true`로 설정 화면에 알림.
- [x] `handlePost`에 `/settings/get`, `/settings/save` 추가. 기존 `?k=` + same-origin 가드 안쪽이므로 인증 추가 작업 없음. 입력 오류는 throw → 라우트가 400으로 응답.
- [x] `mode === "ro"`와 무관한 전역 설정이므로 세션 상태와 무관하게 동작.
- [x] `test/web.test.js`에 2개 추가: `hub: settings get/save round-trip` (평문 미반환·빈값 삭제·타입/길이 검증), `hub: settings endpoints require a token and validate input` (토큰 없이 403·입력 오류 400·env shadowing). scratch `dataDir` + scratch `SMOLCODER_CONFIG` 사용, 실제 설정 오염 없음.
- [x] `npm test` 184 pass. 역검증: scratch config로 저장→조회 실측 시 hint만 반환·평문 미포함 확인.

### Phase 3 — Web 설정 화면 ✅ 2026-10-03 완료

**왜:** 사용자가 `.env`를 만지지 않고 브라우저에서 키를 입력·확인하게 한다.

**한 일 (코드 검증됨):**

- [x] `src/web/page.ts` — `sidefoot`에 `id="settings"` 버튼(⚙) 추가. 다이얼로그는 `?` 버튼과 같은 동적 `<dialog>` 방식이라 정적 컨테이너 불필요.
- [x] `src/web/styles.ts` — `.settings-list` 스타일 추가 (행·password input·상태 문구). 중앙 고정 다이얼로그라 narrow/`#panel` 규칙과 무관.
- [x] `src/web/client.ts` — `openSettings()` + `$("settings").onclick`. `el()`로만 DOM 생성, `password` input, 저장/지우기/닫기, 상태 문구는 `textContent`만. `post()` 사용이라 `?k=` 자동 첨부. 저장 후 재시작 없이 즉시 동작 (`resolveBraveKey()`가 매 호출마다 읽음).
- [x] 부수 수정: Esc 핸들러에 `dialog[open]` 가드 — 설정·단축키 다이얼로그가 열려 있을 때 Esc가 에이전트 턴을 취소(`/cancel`)하지 않게 함. 기존 의도(ask 박스 주석 `client.ts:538-539`)와 일치, 기존 테스트와 무관.
- [x] 함정 준수: 백틱·`${}` 없음, `$("settings")`의 id 존재, `innerHTML` 미사용.

**검증:**

- [x] `test/web.test.js` 2개 추가: `web: settings dialog is wired…` (버튼·엔드포인트 연결), `web: settings dialog never puts user input through innerHTML` (다이얼로그 구간 검사).
- [x] `npm test` 186 pass. 역검증: `id="settings"` 제거 시뮬레이션 → id 가드가 `settings` 누락 검출.
- [x] 실서버 실측: `WebHub` 기동 후 페이지에 버튼·스타일 포함 확인, `/settings/save` → hint만 반환·평문 미포함, `/settings/get` 상태 정상.

### Phase 4 — Electron 껍데기 `apps/desktop/` ✅ 2026-10-03 완료

**왜:** 터미널 기동 단계를 없앤다. 코어는 그대로 재사용한다.

**한 일 (코드 검증됨):**

- [x] `apps/desktop/package.json` 신설 (`electron ^44`, `electron-builder ^26` — 여기만, 루트 `dependencies`는 계속 비어 있음). `version: 1.2.0`은 루트와 함께 bump. `package-lock.json` 커밋 대상.
- [x] `apps/desktop/main.js` (plain JS, 빌드 단계 없음):
  - `startHub(coreRoot, port, dataDir)` — `dist/web/hub`의 `WebHub`를 main 프로세스에서 기동. 사용 중 포트는 건너뛰고 다음으로 (`EADDRINUSE` 루프, 최대 10개).
  - `run({app, BrowserWindow}, opts)` — Electron 주입(DI)이라 테스트에서 가짜로 검증. 단일 인스턴스 lock, 두 번째 실행은 창 포커스, `window-all-closed` → quit, `before-quit` → `shutdownSync()`.
  - `coreDir()` — dev는 repo `dist/`, 패키징(`isPackaged`)은 `Resources/core` (`extraResources`로 루트 `dist/` 통째로 포함).
  - `resolveVersion()` — 패키징 레이아웃에는 `core/../package.json`이 없어서 조용히 죽던 버그를 수정. fallback은 desktop `package.json`. **이 버그 때문에 첫 빌드분이 무음 종료했음.**
- [x] `test/desktop.test.js` 7개: `coreDir` dev/packaged, `startHub` 서빙+종료정리, busy 포트 스킵, `run` URL 오픈+재실행 포커스+quit 정리, lock 선점 시 종료, 버전 fallback.
- [x] `node_modules/`, `dist/` 빌드 출력은 기존 `.gitignore`(`node_modules/`, `dist/`)로 이미 무시됨. 새로 커밋할 것은 `main.js`, `package.json`, `package-lock.json`뿐.

**검증:**

- [x] `npm test` 193 pass (기존 회귀 없음). 중간에 `run` 테스트 실패 1건 발생 → 원인(`until`이 창 대신 URL 문자열 반환 + 실패 시 hub 누수) 수정 후 통과. 실패한 테스트가 서버를 열어 러너를 붙잡는 현상도 `finally` 정리로 해소.
- [x] `npm install` + `electron --version` (v44.5.1) + `npm run dist` → `smolcoder-plus-1.2.0-arm64.dmg` (122MB) 생성.
- [x] **Mac 실기동:** 패키징된 `.app` 실행 → `~/.smolcoder/web.json` 생성(7433) → 페이지에 `id="settings"` 포함 확인 → `/settings/get` 정상·토큰 없이 403 → SIGTERM 종료 후 프로세스 0개 + hub record 제거 확인.
- [x] 미서명 상태: Developer ID가 없어 서명 스킵됨 (빌드 경고). Gatekeeper 대응은 Phase 5.

### Phase 5 — 패키징·서명·문서 마무리 ✅ 2026-10-03 완료

**왜:** 키 누출 없이 배포하고, 다음 세션이 헤매지 않게 기록한다.

- [x] 루트 `npm pack --dry-run` — `.env`·`apps/` 미포함 확인. 실제 키 값(31자)이 `dist/` 0개 파일에 등장, `BRAVE_API_KEY` 문자열은 코드 참조 6곳뿐 (`tools/index`, `tools/web-search` ×4, `web/hub` env shadowing 판별).
- [x] `apps/desktop`에 top-level `files: [main.js, package.json]` 추가 — `npm pack`이 `dist/`(빌드된 .app 200MB+)를 쓸어 담던 것을 수정. 이제 2KB tarball.
- [x] dmg 내장 core 검사 — 실제 키 값 0개 파일.
- [x] **서명: 미서명 배포로 결정.** `security find-identity` 결과 유효 identity 0개. 빌드는 경고 후 진행됨. 첫 실행은 우클릭 → 열기 → 열기로 Gatekeeper 통과 (README에 안내). 서명 배포 시 순서: `Developer ID Application` 인증서 발급 → `CSC_LINK`/`CSC_KEY_PASSWORD` 설정 후 `npm run dist` → `notarytool` 공증 → staple. 키체인·인증서는 절대 커밋 금지.
- [x] `README.md` 반영: `.env`→Settings 우선 설명 + 조회 순서(env > Settings > `.env`) + 누락 메시지 갱신, Web UI에 ⚙ 버튼 언급, Desktop App 섹션 신설(빌드·설치·미서명 안내).
- [x] 포크 고유 변경점 (업스트림 병합 대비): `Config.braveApiKey`, `resolveBraveKey()`, `/settings/*` API, Web 설정 다이얼로그, `apps/desktop/` 전체, `test/config.test.js`·`test/desktop.test.js`. 업스트림 `leonvanzyl/smolcoder`와 공유하는 파일(`hub.ts`, `client.ts` 등)을 합칠 때는 이 목록과 충돌 여부를 diff로 먼저 확인할 것.

## 6. 유지보수 메모 (다음 릴리스 때)

- 루트와 `apps/desktop`의 `version`은 함께 bump (`1.3.0` 동기화). `main.js`의 `resolveVersion()`이 어긋나면 사이드바 버전 표기만 달라질 뿐 동작은 그대로.
- `dist/`를 다시 빌드한 뒤에 `apps/desktop`에서 `npm run dist` (dmg에 들어가는 core가 루트 `dist/` 복사본).
- 2026-10-03 후속: `web_fetch` 도구 추가 후 dist + dmg 재빌드·실기동 검증 완료 (번들 내 메달 테이블 판독 확인).
- 2026-10-03 후속: 단일 서버로 변경. 앱 시작 시 살아 있는 hub(`web.json` + ping)가 있으면 새 서버 없이 그 URL로 창만 열고 안내 다이얼로그 표시, 종료해도 남의 서버는 안 끔 (`ownHub` 플래그). 없을 때만 7433 고정 1회 시도, 타인 점유면 에러 박스 + 종료. `npm test` 204 pass, dmg 재빌드 후 터미널 서버 합류 실측 (기록 불변·앱 종료 후 터미널 서버 생존).
- 2026-10-03 후속: 전역 지시문. `~/.smolcoder/AGENTS.md`를 설정 화면 textarea에서 편집, 매 세션 시스템 프롬프트에 항상 주입 (전역→프로젝트 순, 상한 4000+8000자). `resolveAgentsMd()` + `/settings` 확장 + `test/prompt.test.js` 6개. `npm test` 212 pass.
- 2026-10-03 후속: 터미널 stdin 전달 (B안). posix 셸을 5-fd 듀얼 파이프로 기동 — 명령은 fd 3, 완료 보고는 fd 4, fd 0은 순수 대화형 stdin. 구형 in-band sentinel + `</dev/null` 조합은 stdin 읽기 명령이 sentinel을 먹어버려서 폐기. 명령 실행 중 입력은 stdin으로 (`sudo -S` 동작), 🔒 토글 1회성 마스킹(고정 `••••••••`, 히스토리 미기록, 마스킹은 echo 한정). 전체화면 프로그램은 여전히 불가(PTY 없음). `test/web.test.js` 4개 추가. `npm test` 216 pass.
- 2026-10-04 후속: 앱 아이콘. 흰 바탕 검정 `S+` (Menlo Bold, `apps/desktop/assets/make-icon.swift`로 렌더 → sips/iconutil로 `icon.icns`). `build.mac.icon` 지정, dmg 재빌드·실기동 확인.
- 기본 앱 아이콘 상태 (`electron.icns` 미지정) — 교체 시 `build.mac.icon` 지정.

---

## 3. 보안 규칙 (매 단계 적용)

1. 파일 접근은 `resolveInWorkspace` 재사용. `path.resolve` 단독 사용 금지 (`src/sandbox.ts`).
2. Hub 신규 라우트는 `?k=` + same-origin 검사를 빠뜨리지 않는다 (`src/web/hub.ts:846-853`).
3. 서버는 loopback 전용. `0.0.0.0` 바인딩 금지.
4. 키 평문을 GET 응답·로그·테스트 픽스처에 남기지 않는다. 마스크 힌트만 반환.
5. `~/.smolcoder.json`은 `600` 권장. Electron much `safeStorage`(키체인) 적용은 Phase 4 stretch goal.
6. 비밀값 커밋 금지 — `.env`는 `.gitignore` 유지.

## 4. 테스트 규칙 (매 단계 적용)

* 러너는 `node:test`, `npm test = build + scripts/test.cjs`. `dist/`를 보고 테스트하므로 단독 `node --test` 금지.
* 서버 로직은 HTTP 없이 직접 검증できる 순수 함수로 분리.
* 버그 수정 시 재현 테스트를 먼저 추가, 테스트 이름은 `영역: 동작` 형식.
* 역검증: 테스트를 일부러 깨뜨려 실패 메시지 확인 후 원복.

## 5. 다음 세션 시작 체크리스트

- [ ] `git status`, `git diff`, `git log --oneline -10` 확인.
- [ ] 본 문서 상태표에서 첫 `⬜` 단계부터 시작.
- [ ] `client.ts`를 건드리면 `npm test` 통과 전까지 커밋하지 말 것.
- [ ] 완료한 단계는 본 문서 체크박스 + 상태표 + 검증란을 즉시 갱신할 것.
