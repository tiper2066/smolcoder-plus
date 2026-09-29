# 📋 Handoff — Web UI: 파일 트리 + File Edit 패널 (SMOL Coder Plus)

**작성자:** smolcoder
**작성일:** 2026-09-23
**최종 업데이트:** 2026-09-30 (파일 트리 단계 1-B 완료 — 탭 전환·트리 렌더·dot 파일·아이콘 크기 반영)
**프로젝트:** smolcoder-plus v1.0.6 (전역 bin: `smolp` / `smolcoder-plus`)
**관련 계획서:** `docs/IMPLEMENTATION-PLAN-web-search-integration.md`, `docs/IMPLEMENTATION-PLAN-global-install.md`, `docs/handoff.md`

> 이 문서는 새 세션이 작업 시작 전에 **현황을 빠르게 파악**하고 각 단계를 체크할 수 있도록 작성된 것입니다.
> **이 문서의 코드 위치는 2026-09-30에 실제 소스로 검증한 값입니다.** 문서와 코드가 다르면 코드를 먼저 확인하고 이 문서를 고치세요.

---

## 0. 목표와 현재 상태

**목표:** `smolp --web` Web UI에 두 가지 기능 추가.

1. **파일 트리** — 좌측 사이드바에 "세션 / 파일" 탭을 두고 워크스페이스 파일 트리 표시. 파일 클릭 시 composer에 경로 삽입(MVP) 또는 편집기에서 열기.
2. **File Edit 패널** — 우상단 panel에 `file` kind 탭을 추가해 파일을 보고 편집·저장.
3. **패널 전체화면 토글** — `⤢` 버튼 한 번으로 패널을 좌측 사이드바만 남는 전체 폭으로 확장. 좁은 기본 폭(최대 60%) 때문에 생기는 불편을 먼저 해소하는 선행 작업(단계 1-C).

**현재 상태: 1(파일 트리)과 3(패널 전체화면)은 완료·검증됨, 2(File Edit 패널)는 미개시.** 2에 필요한 파일 읽기/쓰기 API는 아직 없다(§1.3).

| 단계 | 상태 | 검증 |
|---|---|---|
| 0 groundwork (`client.ts` 구문 안전망) | ✅ | `npm test` |
| 1-A `/fs/tree` API | ✅ | `hub: /fs/tree …` |
| **1-B 사이드바 탭 + 파일 트리** | ✅ **2026-09-30 완료** | headless Chrome 실측 + 회귀 테스트 4개 |
| 1-C 패널 전체화면 | ✅ | 회귀 테스트 1개 |
| 2-A 파일 읽기/쓰기 API | ❌ 미개시 | — |
| 2-B File Edit 패널 | ❌ 미개시 | — |

**다음 세션이 할 일:** 2-A → 2-B. 그 전에 §"이번 세션에서 고친 것"의 표를 읽어 같은 실수를 반복하지 말 것.

---

## 0.1 🛡️ client.ts 구문 검사 안전망 (단계 0에서 완료 — 반드시 알아둘 것)

`client.ts`는 `String.raw` 템플릿이라 **`tsc`는 그 안의 JS를 문자열로만 봅니다.** 즉:

| 실측 결과 | 잡아내는가 |
|---|---|
| `${clientVar}` 보간 | ✅ `tsc`가 `error TS2304: Cannot find name 'a'` 로 잡음 |
| 이스케이프 안 된 백틱 | ✅ `tsc`가 잡음 (unterminated template) |
| **일반 JS 문법 오류(중괄호 누락 등)** | ❌ **`tsc` 통과 → 브라우저에서만 터지고 UI 전체 백 화면** |

그래서 `test/web.test.js`에 가드 2개를 넣어 **이미 반영되어 있습니다**:

```js
test("web: the client bundle compiles as JavaScript", () => {
  assert.doesNotThrow(() => new Function(CLIENT_JS));   // 컴파일만, 실행 안 함 → DOM 불필요
});
test("web: every element the client looks up by id exists in the page", () => {
  const wanted = [...new Set([...CLIENT_JS.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]))];
  const missing = wanted.filter((id) => !PAGE_HTML.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `client.ts looks up ids the page does not define: ${missing.join(", ")}`);
});
```

**작업 규칙: `client.ts`를 건드린 뒤에는 `npm test`가 통과할 때까지 넘어가지 말 것.** 이 두 테스트가 tsc가 못 보는 것을 대신 잡아준다. (역검증 완료: 중괄호 하나 제거 → `SyntaxError: Unexpected token ')'` 검출 / 없는 id 추가 → 두 번째 테스트 실패)

---

## ✅ 파일 트리 사이드바 — 완료 (2026-09-30)

> 이전 문서가 "트리 영역이 비어 있다 / 세션 목록 아래에 쌓인다"고 적었던 문제는 **전부 고쳐졌다.**
> 아래는 실제 코드 위치와 브라우저 실측 결과다.

### 이번 세션에서 고친 것 (증상 → 원인 → 조치) — **읽고 시작할 것**

| 증상 | 원인 | 조치 |
|---|---|---|
| **세션 목록 아래에 파일 트리가 같이 보임** | ① 클릭 핸들러가 `.tab`을 찾는데 실제 클래스는 `.side-tab` → 탭 클릭이 아예 동작 안 함 ② `.side-panel:not(.on) { display: none }` 규칙 부재로 두 패널이 둘 다 `flex: 1` | `client.ts` 셀렉터를 `.side-tab`으로 수정, 패널은 `.on` 클래스로 토글, `styles.ts`에 `.side-panel:not(.on) { display:none }` 추가 |
| **트리 영역이 항상 비어 있음** | `post("/fs/tree")` — 서버는 **GET** 라우트만 존재 → 404 | `fetch("/fs/tree?k=..&sid=..")` 로 변경 |
| **디렉터리를 눌러도 아무Reaction 없음** | `renderTree`가 모든 디렉터리를 평탄화해 한 frag에 넣고, 자식 컨테이너는 **빈 상태**로 row 뒤에 분리 삽입 | `fillTree(host, x)` 재귀 렌더 — 디렉터리 row 아래 `.tree-body`에 그 자식을 직접 넣음 (인덴트는 CSS `.tree-body { padding-left: 12px }`) |
| **화살표 방향 반전** | 닫힌 디렉터리에 `rotate(90deg)` | 문자 자체를 `▸`(닫힘) / `▾`(열림)로 토글 |
| **세션 전환 시 트리가 안 바뀜** | `dataset.loaded` 플래그로 한 번만 로드 | 캐시를 **워크스페이스 경로** 기준(`treeCache`)으로 바꾸고 `show()`에서 `loadTree()` 호출 |
| **`#fsexpandall` 눌러도 반응 없음** | page.ts에 버튼만 있고 핸들러 없음 | `#fsexpandall` → `setTreeExpanded()` 토글, `#fsreload`(`⟳`) → `loadTree(true)` 추가 |
| `node_modules`/`dist`를 트리가 다 씀어먹음 | `walk()`가 dot 디렉터리만 제외 | `TREE_SKIP` 세트 추가(`node_modules` `dist` `build` `out` `target` `__pycache__` `.venv` `venv` `.next` `.cache` `coverage`) |

### 현재 구현 (실제 코드 위치)

- **DOM** — `page.ts:37-45`: `.side-tabs`(`.side-tab[data-tab]`) + `#sessions-panel.side-panel.on` / `#tree-panel.side-panel`(내부 `#fshdr` `#fslabel` `#fsreload` `#fsexpandall` + `#fstree`).
- **CSS** — `styles.ts:81-99`: `.side-panel:not(.on){display:none}`, `.fsbtn`, `.tree-body{padding-left:12px}`, `.tree-empty`, `.tri`/`.tri .arrow`/`.tri .fname`.
- **클라이언트** — `client.ts` `switchTab`(탭 클래스/`on` 토글 + localStorage `smol.side.tab`) / `loadTree(force)`(GET, 워크스페이스별 캐시) / `renderTree`(헤더 라벨 + 루트 자식 렌더) / `fillTree`(재귀) / `setTreeExpanded` / `insertFile`. `show()` 마지막에 `if (sideTab === "tree") loadTree();`.
- **서버** — 변경 없음. `hub.ts` `GET /fs/tree?sid=` → `live.tree()` → `fsTree()` → `walk()`. `TREE_SKIP`만 추가.
- **경로 삽입** — `insertFile`는 워크스페이스 prefix를 벗겨 **상대경로**를 composer에 넣는다. 공백이 있으면 **따옴표로 감싼다**(`"a b.txt"`). ~~`encodeURI`~~ 는 쓰지 않는다 — 퍼센트 인코딩된 문자열을 에이전트 `read_file`에 넘기면 실제 파일을 못 찾는다.

### 검증 (2026-09-30, headless Chrome + CDP로 실측)

- `npm test` **162/162 통과**.
- 탭 전환: 트리 탭 활성 시 `#sessions-panel` 높이 0 / `#tree-panel` 591px, 반대도 동일. 새로고침 후에도 localStorage로 Files 탭 복원(12행 렌더).
- 트리: `docs/`, `sessions/`, `src/web/hub.ts` 3단계 중첩 정상. `⟳`/`▸` 토글 동작.
- 파일 클릭 → composer에 `src/web/hub.ts` 삽입. 공백 경로는 `"a file with spaces.txt"`.
- dot 항목(§"트리 표시 정책") 4개 노출 + `.git`·`.DS_Store`·`node_modules`·`dist` 미노출, 헤더 아이콘 20px 확인.
- **회귀 테스트 4개 추가** (`test/web.test.js`): "the sidebar tab switch matches .side-tab and hides the other panel", "the file tree is fetched over GET and rendered as a nested tree", "the file tree never depends on state.workspace to find the folder", "the relative path the composer gets is derived from the server's root". `hub: /fs/tree …` 테스트에 `node_modules`/`dist`/`.git`/`.DS_Store` 제외 + dot 노출 assertion 추가. **전부 역검증 완료**(옛 코드로 되돌리면 실패).

### ⚠️ 이 기능을 처음 만졌다면 (실수 재발 방지)

1. **`post()` 로 트리를 부르면 안 된다.** `/fs/tree` 는 GET 이다. POST 하면 조용히 빈 트리가 된다(404 를 `post()` 가 빈 객체로 삼킨다).
2. **클라이언트 상태(`active.state.workspace`)는 세션이 뜬 뒤에만 온다.** 트리·폴더피커가 필요한 워크스페이스는 `sessInfo`(hub 스냅샷)에서 읽거나, 아예 서버에 맡긴다.
3. **상대경로는 서버가 resolve 한 `tree.path` 로 만든다.** 저장된 경로는 `~` Prefix / 미해결일 수 있다.
4. **헤드리스 하네스가 "정상 경로"만 돌면 사용자가 본 버전을 못 잡는다.** factory 를 throw 시켜 세션이 뜨지 않는 시나리오까지 돌 것(이번에 실제로 이걸 놓쳤다).

### 추가 수정: 워크스페이스를 `state.workspace`에서 읽지 말 것 (2026-09-30)

Files 탭이 **"This session has no workspace folder."** 만 띄우는 문제가 있었다.

원인은 **워크스페이스를 `active.state.workspace`에서 읽었던 것**이다.

- `state()` 의 `workspace`(`session.ts:412`)는 **세션이 실제로 뜬 뒤에야** SSE `state` 이벤트로 도착한다.
  시작 중이거나 백엔드 연결에 실패한 세션에는 이 필드가 아예 없다 → 트리가 영영 비었다.
- 반면 **hub 스냅샷은 첫 프레임부터** 각 세션의 `workspace`를 실어준다 — `client.ts` `onHub()` 의
  `sessInfo.set(s.id, Object.assign({ workspace: w.path, wsname: w.name }, s))`.
- 게다가 워크스페이스 경로는 `~` Prefix / 미해결 상태로 저장돼 있을 수 있다. **서버가 실제로 resolve 한 값**(`tree.path`)이 진짜 기준이다.

조치 (`client.ts`):

| 위치 | 변경 |
|---|---|
| `currentWorkspace()` | `sessInfo.get(sid).workspace` 우선, `state.workspace` 는 폴백 |
| `loadTree(force)` | 워크스페이스를 **가지고 있는지로 fetch를 막지 않는다.** 서버가 `sid`로 워크스페이스를 resolve 한다. `tree === null`(미지의 sid)이면 그때 "no workspace folder" |
| `renderTree()` | `treeRoot = x.path` — 응답이 준 resolve된 루트를 보관 |
| `insertFile(p)` | prefix 제거 기준을 `treeRoot`(서버 값)로. 클라이언트가 경로를 재추측하지 않는다 |
| `openDialog()` | 폴더 피커의 기본 경로도 `currentWorkspace()` 경유 (같은 잠재 버그) |

검증: **세션이 아예 시작되지 않는**(factory throw) 시나리오에서 headless Chrome 확인 →
`state`가 `{commands:[], busy:null, title:""}`(workspace 없음)인 상태에서도 트리 5행 정상 렌더,
`src/a.ts` 클릭 → composer에 `src/a.ts`. 회귀 테스트 "web: the file tree never depends on
state.workspace to find the folder" 추가(역검증 완료).

### 트리 표시 정책 변경: dot 파일/폴더를 모두 표시 (2026-09-30)

`walk()` 이 **모든 깊이에서** `!e.name.startsWith(".")` 로 필터링해 `.github` `.vscode` `.env` 가 전부 안 보였다.
문서 §2 규칙 5(숨김 항목 제외)에서 온 것이고, 목적은 `.git`/`node_modules`/`.DS_Store` 회피였다.
하지만 프로젝트 파일 탐색기로는 너무 넓었다 — `.github/workflows` 나 `.env.example` 을 볼 수 없다.

조치 (`src/web/hub.ts`):

```ts
const TREE_SKIP = new Set(["node_modules", "dist", "build", "out", "target", "__pycache__", ".venv", "venv", ".next", ".cache", "coverage"]);
const TREE_HIDE = new Set([".git", ".DS_Store"]);   // ← 새로 추가

const dirs  = children.filter((e) => e.isDirectory() && !TREE_HIDE.has(e.name) && !TREE_SKIP.has(e.name));
const files = children.filter((e) => e.isFile()       && !TREE_HIDE.has(e.name)).map((e) => e.name).sort();
```

- **보이는 것:** `.github` `.vscode` `.env` `.gitignore` `.editorconfig` …
- **숨는 것:** `.git` (히스토리 노드가 수만 개 — 트리를 파묻고 walk 를 느리게 만든다), `.DS_Store` (Finder 쓰레기), `TREE_SKIP` 목록.
- `.git` 까지 보고 싶으면 `TREE_HIDE` 에서 `".git"` 을 빼면 된다(단, 대형 저장소에서 `/fs/tree` 응답이 급격히 커진다).

검증: `hub: /fs/tree …` 테스트 픽스처에 `.github/ci.yml` `.vscode/settings.json` `.git/HEAD`
`.gitignore` `.env.example` `.DS_Store` 를 추가하고 — dot 항목 노출 / `.git`·`.DS_Store` 은 숨김
/ `node_modules`·`dist` 는 숨김 — 을 각각 assert. headless Chrome 실측으로 dot 항목 4개가 트리에 뜨는 것 확인.

### 트리 헤더 아이콘 크기 (2026-09-30)

`#fsreload`(⟳) / `#fsexpandall`(▸▾) 이 12px 헤더 폰트를 그대로 따라가 사실상 안 보였다.

- `styles.ts` `.fsbtn`: `font-size: 20px; line-height: 1; padding: 2px 6px;` + hover 배경 추가.
- `styles.ts` `.tri .arrow`: `10px → 13px` (행의 폴더 chevron 도 같은 complaint 라 같이 키움).
  20px 로 키우면 행 높이가 과해지므로 **헤더만 2배**로 갔다.

> ⚠️ client.ts는 String.raw — 백틱/`${}` 금지, 문자열 이어붙이기만. `npm test`가 통과해도 브라우저 확인은 별도로 필요(§0.1 번들 문법 검사는 tsc가 못 보는 것만 잡는다).

---

## 1. 사전 지식 (실제 소스 분석 — 구현 전 반드시 읽을 것)

### 1.1 `src/web/` 파일 구성 (7개)

```
src/web/
├── hub.ts        (953줄) HTTP 서버. 라우팅 + 세션/터미널/업로드 API. fsState 반환
├── page.ts       ( 93줄) PAGE_HTML 템플릿. DOM 구조가 정의된 곳
├── client.ts     (1008줄) export const CLIENT_JS = String.raw`...` (브라우저 클라이언트 JS)
├── styles.ts     (333줄) export const STYLES (CSS)
├── channel.ts    (305줄) SessionChannel — 세션 입출력 adapter (readInput, handleMessage, SSE 이벤트)
├── store.ts      (197줄) SessionStore / WorkspaceStore — ~/.smolcoder/ 아래 JSON 영속화
└── terminal.ts   (188줄) 터미널(pty) 관리
```

### 1.2 ⚠️ 구현 시 반드시 지켜야 할 제약 3가지

1. **`client.ts`는 raw template literal이다.** `export const CLIENT_JS = String.raw\`...\`` (client.ts:1 부근).
   클라이언트 JS 안에 **리터럴 백틱(`)을 쓸 수 없다**. 필요하면 반드시 `` \` `` 로 escape. `page.ts`도 동일 제약.
2. **모든 요청에 `?k=<token>` 이 붙는다.** 서버는 `url.searchParams.get("k") !== this.authToken` 이면 403 (hub.ts:673).
   클라이언트에는 이미 `const k = ...` (client.ts:12)와 `post()` (client.ts:32, 자동으로 `?k=` append)가 있다.
   **`fetch()`를 직접 쓰면 `k`를 빠뜨리기 쉽다** → `post()`를 쓰거나 `"path?k=" + k` 형태로 작성.
3. **HTML 구조는 `page.ts`에서 고쳐야 한다.** 버튼·컨테이너를 추가하려면 `page.ts`의 `PAGE_HTML`과 `styles.ts`를 함께 손댄다.

### 1.3 ⚠️ 기존 `/fs` API의 실체 (이전 문서의 오해 — 재사용 불가)

`GET /fs?path=<p>` → `browseDir()` (hub.ts:172, 라우트 hub.ts:695).

```ts
// 반환 형태 (실제)
{ path, display, home, roots, parent, dirs: [{ name, path, project }], error? }
```

| 이전 문서의 주장 | 실제 |
|---|---|
| `/fs/contents`endpoint 존재 | **없음.** `/fs` 하나뿐 |
| `fsState`에 `projectFiles` / `absPaths` 존재 | **없음.** 위 반환값이 전부 |
| 재사용 가능한 파일 트리 데이터 | **아님.** `dirs`는 `e.isDirectory()` 필터만 (hub.ts:189) → **파일이 하나도 안 나온다** |
| `/fs/read` endpoint | **없음** |
| `/fs/contents`는 읽기 전용이라 쓰기 API만 추가 | 읽기/쓰기 API **둘 다** 새로 만들어야 함 |

**추가로 `/fs`는 "워크스페이스 열기" 폴더 픽커 전용이다.**
- 홈/루트 전체를 탐색한다 (`home`, `roots`). **workspace 범위 제한이 없다.**
- `.`으로 시작하는 항목만 숨긴다. **`.gitignore`를 적용하지 않는다** → `node_modules`는 `SKIP_DIRS`(hub.ts:170)로 제외될 뿐, `.venv`, `dist`, `target` 등은 그대로 노출된다.
- `slice(0, 500)`으로 잘라버린다.

→ **결론: 단계 1-A에서 `/fs/tree`를 새로 만든다. `/fs`는 손대지 않는다.**

### 1.4 좌측 사이드바 실제 DOM (`page.ts` / `client.ts`)

```
#side
├── .sidehdr          : .brand(로고) + #sidecollapse
├── #openfolder       : "+ Open folder…" 버튼
├── .side-tabs        : .side-tab[data-tab=sessions|tree]  (클래스는 반드시 .side-tab)
├── #sessions-panel   : .side-panel.on — #wslist
│   └── .ws (워크스페이스별 박스)
│       ├── .wshdr    : .wsname + "+"(신규 세션) + "×"(워크스페이스 제거)
│       └── .sessions : .sess 행들 (클릭=선택, 더블클릭=이름변경)
├── #tree-panel       : .side-panel — #fshdr(#fslabel #fsreload #fsexpandall) + #fstree
└── .sidefoot         : #ver + #keys
```

- 이전 문서의 "`#sidedrawer` / `#sessions` / `#main` / `#sidefooter`" 중 **`#sidedrawer`, `#sessions`는 존재하지 않는다.** 실제 id는 `#wslist`이고 세션 목록은 `.sessions` 클래스다.
- **"세션 / 파일" 탭:** 이미 `#openfolder` 아래에 들어가 있다(단계 1-B 완료). `#wslist`는 `#sessions-panel` 안에 있고, 트리는 `#tree-panel`. 두 패널의 표시 전환은 **`hidden` 속성이 아니라 `.on` 클래스**로 한다 — `styles.ts`의 `.side-panel:not(.on) { display: none }`이 담당한다(`.side-panel`에 `display`를 주면 `hidden` 규칙을 이긴다).
- 접기/펼치기: `setSide()` (client.ts:994), `narrow()` = `matchMedia("(max-width: 1000px)")` (client.ts:999). 좁은 화면 동작을 확인할 것.

### 1.5 우상단 panel 시스템 (`client.ts`)

- DOM: `#top` 안의 `#btnbrowser` / `#btnterm` 버튼, `#panel > #panelgrip / #paneltabs / #panelviews` (page.ts).
- 상태: 세션별 view 객체 `v` (`views` Map, client.ts:25). `v.tabs`(배열), `v.activeTab`, `v.panelOpen`, `panelWidth`(localStorage `smol.panel.w`, client.ts:634).
- 렌더: `renderPanel()` (client.ts:653) — 탭 버튼 라벨/아이콘은 `t.kind === "browser" ? "◎" : ">_"` 로 **2분기로 되어 있어 `file` kind 추가 시 반드시 3분기 이상으로 바꿔야 한다**.
- 탭 만들기: `openBrowserTab()` (client.ts:719) / `openTerminalTab()` (client.ts:844) 를 참고. 각각 `t.el` DOM을 만들어 `panelviews`에 붙인다.
- 토글: `togglePanelKind(kind)` (client.ts:691) — kind별 "기존 탭 재사용 or 새로 열기" 분기. `file`은 다중 탭이 자연스럽다.
- 닫기: `closeTab()` (client.ts:683) — `term`은 서버에 `/term/close`를 알리고, `browser`는 그냥 splice.
- **저장/복원:** `savePanel()` (client.ts:636) 은 **`kind === "browser"` 탭만** localStorage에 저장한다. `loadPanelState()` (client.ts:639) 도 `browser`만 복원.
  → `file` 탭을 복원하려면 **저장/복원 양쪽에 `file` 분기를 추가**해야 하며, 복원 시 파일이 이미 없었을 처리가 필요하다(§4 결정 3).

### 1.6 세션 state에서 얻을 수 있는 값 (`session.ts` `state()`)

클라이언트 `v.state` (= `state()` 반환, client.ts `renderState`가 소비):

| 필드 | 용도 |
|---|---|
| `workspace` | **루트 경로.** 트리/파일 API의 기준. 단 **`state`로 오기까지 세션이 뜰 때까지 기다려야 한다** — 시작 중이거나 백엔드 실패 세션에는 없다. 트리는 `currentWorkspace()`(`sessInfo` 우선)로 읽고, 상대경로는 서버가 resolve 한 `tree.path`(`treeRoot`)를 쓴다. |
| `mode` | `"ro"` / `"edit"` / `"bypass"`. **`ro`에서 저장 금지** (§2) |
| `model`, `backend`, `host` | 상태 표시 |
| `commands` | 슬래시 명령 목록 |

hub 서버 쪽에서는 `this.live: Map<sid, Live>` (hub.ts:231) 있고 `Live.workspace` (hub.ts:48), `Live.session` 가 있다.

### 1.7 폴더 피커 모달 (`#modal`, client.ts:585~635)

`browse()` → `GET /fs` → `renderFs()` → `openFolder()` → `POST /workspaces/add`.
**재사용하지 않는다**(사전 §1.5 결정을 유지). 다만 `el()` 헬퍼와 `esc()` 등 UI 유틸은 재사용한다.

---

## 2. 🔒 MUST 규칙 (안전 — skim하면 안 됨)

1. **모든 파일 접근은 세션 workspace 안으로 제한한다.**
   `src/sandbox.ts:36`의 `resolveInWorkspace(root, userPath)` 를 **재사용**하라. 심볼릭 링크 탈출을 realpath로 막아준다(`SandboxError` 던짐). 새로 `path.resolve`만 쓰지 말 것.
2. **`mode === "ro"` 세션에서는 저장을 막는다.** `v.state.mode === "ro"`면 저장 버튼 비활성 + 서버도 거부.
3. **GET 라우트에는 세션 컨텍스트가 없다.** `GET /fs`는 `sid`를 받지 않으므로 어떤 workspace 기준인지 알 수 없다.
   → 새 API는 **`?sid=<sid>&k=<token>`** 을 받아 hub가 `this.live.get(sid).workspace` 를 기준으로 검증한다. 검증 실패는 403/400.
4. **저장은 atomic하게.** `store.ts`의 `writeAtomic()` (store.ts:25) 패턴 — 임시 파일에 쓰고 `fs.renameSync`. 편집 중 Interrupted로 파일이 깨지지 않도록.
5. **빌드 산출물·잡음만 제외한다 (2026-09-30 정책 변경).** `.git` `.DS_Store` `node_modules` `dist` `build` `__pycache__` `.venv` 등만 숨기고, **`.github` `.vscode` `.env` `.gitignore` 같은 dot 항목은 모두 노출한다** — 프로젝트 파일 탐색기에서 가려지면 안 된다. 실제 목록은 `hub.ts` 의 `TREE_SKIP` / `TREE_HIDE`. `.gitignore` 파싱은 하지 않는다(로컬 앱이므로 엄격한 무시 규칙 불필요).
6. **패널 전체화면 중에는 에이전트 승인을 절대 숨기지 않는다.** 전체화면은 `#main`(챗) 전체를 감추므로, 승인 요청이 도착하면 **자동으로 전체화면을 해제**한다(§3 단계 1-C).

---

## 3. 작업 단계 (체크리스트)

### [x] **단계 0 — groundwork**
- [x] `npm run build && npm test` 통과 확인 (baseline 154/154)
- [x] `docs/` 문서에 `/fs` 실체 정정 반영 완료 (본 문서가 그 결과)
- [x] **client bundle 구문 검사 테스트 추가 (2026-09-26 완료)** — 아래 §0.1 참조. 이후 모든 client.ts 작업의 안전망

### [x] **단계 1-A — 서버: 파일 트리 API** (난도 ★★☆) — 완료 (구현은 `listTree` 가 아니라 `WebHub.walk`)
- [x] `hub.ts`에 `fsTree(workspace)` (private, hub.ts:474) + `walk(dir, depth)` (hub.ts:485) 작성
  - 반환 `FsTree { path, name, children: FsTree[], files: string[] }` (hub.ts:47). **파일은 이름 문자열 배열**이다 — 상대경로가 아니다. 클라이언트가 `node.path + "/" + name` 으로 합쳐야 한다
  - `walk` 는 **한 번에 전체 재귀**한다(depth ≤ 6, 디렉터리당 200 상한). lazy 로딩 없음 → 펼칠 때 refetch 도 없다. 대용량 repo 에서는 응답이 클 수 있으니 감안
  - `TREE_SKIP`(빌드 산출물) + `TREE_HIDE`(`.git` `.DS_Store`) 만 필터. **dot 항목은 노출**(§2 규칙 5)
  - ⚠️ **계획서의 `export function listTree(root, rel, depth)`(hub 클래스 밖, 단위 테스트 가능)는 만들지 않았다.** 대신 HTTP 레벨 테스트(`hub: /fs/tree …`)로 검증한다
- [x] `hub.ts:757` GET switch에 `case "/fs/tree"` — `sid` → `this.live.get(sid)` → `live.tree()`. 미지의 sid 면 `tree: null`
- [x] `test/web.test.js` `hub: /fs/tree …` — 중첩 구조 / dot 노출 / `.git`·`.DS_Store`·`node_modules`·`dist` 제외 / 미지 sid
- [x] 검증: headless Chrome + CDP (`node --test` 로는 라우팅까지만 잡힌다)

### [x] **단계 1-B — 클라이언트: 사이드바 탭 + 트리** (난도 ★★☆) — 완료 (2026-09-30 재작업)
- [x] `page.ts`: `.side-tabs`(`.side-tab[data-tab]`) + `#sessions-panel` / `#tree-panel`. `#wslist` 는 sessions 패널 안에
- [x] `styles.ts`: 탭 바 + 트리. **`.side-panel:not(.on) { display: none }` 이 핵심** — 이것이 없으면 두 패널이 동시에 보인다
- [x] `client.ts:605 switchTab(t)` — `.side-tab` 의 `on` 토글, 패널 `on` 토글, localStorage `smol.side.tab`, tree 탭이면 `loadTree()`
- [x] `client.ts:616 loadTree(force)` — **GET** `/fs/tree?k=..&sid=..`, 워크스페이스 경로 기준 캐시, 세션 바뀌었으면 응답 버림
- [x] `client.ts:654 renderTree` / `:670 fillTree` — 재귀. 디렉터리 row 아래 `.tree-body` 에 자식 직접 삽입. chevron 은 `▸`/`▾` 문자 토글
- [x] `client.ts:691 setTreeExpanded` — `#fsexpandall` 전체 펼침/접기. `#fsreload`(⟳) → `loadTree(true)`
- [x] `client.ts:707 insertFile` — `treeRoot`(서버가 resolve 한 `x.path`) 기준 상대경로 → composer. 공백 있으면 따옴표
- [x] `show()` 마지막에 `if (sideTab === "tree") loadTree();` — 세션 전환 시 트리 갱신
- [x] 빈/오류 상태는 `.tree-empty`(`#fsempty` 같은 별도 요소 없음 — `renderTreeMessage`)

**구현 요약 (2026-09-30 기준):**

- **API** — `hub.ts:757` `case "/fs/tree"` → `live.tree()` → `fsTree()` → `walk()`. `sid` 만으로 워크스페이스를 서버가 resolve 한다(클라이언트가 경로를 넘기지 않는다).
- **클라이언트** — `client.ts` `switchTab` / `loadTree` / `renderTree` / `fillTree` / `setTreeExpanded` / `insertFile` / `currentWorkspace`. 캐시는 `treeCache`(workspace → FsTree) + `treeRoot`(현재 렌더된 루트).
- **`narrow()` (client.ts:1053)** — 사이드바를 `position: fixed; width: 280px; z-index: 20;` 으로 chat 위에 오버레이. `#panel` 은 `!important` 로 방어. `setSide()` (client.ts:1048).
- ⚠️ **이전 문서에 있던 `listTree` / `renderFsPath` / `#fsempty` / `loadNode` / `.gitignore` 파싱 / "GET `/fs` 재사용"은 실제 코드에 없다.** 읽지 말 것.

### [x] **단계 1-C — 패널 전체화면 토글 + 폭 정합성** (난도 ★☆☆) — 완료
> 파일 트리/에디터가 "좁다"는 불편이 가장 먼저 해결되는 항목. 2-B보다 먼저 구현한다.

- [x] **폭 상한 불일치 수정 (기존 버그, 단계 1-D)**
  - `client.ts:857` 드래그 중 상한은 `innerWidth * 0.8`, `client.ts:663` `renderPanel()`은 `innerWidth * 0.6` → **60%를 넘겨 드래그하면 마우스를 놓는 순간 패널이 줄어든다** — **0.8 로 통일 완료**
  - 두 상한을 **0.8로 통일** — `renderPanel()`(client.ts:783)과 드래그 핸들러(client.ts:981) 모두 `innerWidth * 0.8` 적용. 챗이 20%까지 압축될 수 있으므로 전체화면 토글과 세트로 의미 일치
  ```css
  body.panel-full #main        { display: none; }
  body.panel-full #panel       { flex: 1 1 auto; width: auto !important; max-width: none; }
  body.panel-full #panelgrip   { display: none; }  /* 전체화면 중에는 드래그 불가 */
  ```
  - `!important`가 필요한 이유: `client.ts:663`이 inline `style.width`를 박기 때문. `styles.ts:329`의 좁은 화면 오버레이 규칙(`width: 100% !important`)가 같은 이유로 이미 이 패턴을 쓴다 — **그 precedent를 그대로 따라간다**
  - 사이드바(`#side`, `flex: none`)는 남아 있으므로 "좌측 사이드바를 제외한 전체화면"이 된다
- [x] `client.ts` `renderPanel()`(client.ts:788) 안에서 `document.body.classList.toggle("panel-full", v.panelFull)` — `renderPanel()`은 세션 전환·탭 전환마다 이미 호출되므로 별도 sites 없음
- [x] 토글 버튼: `#paneltabs`의 `+◎` / `+>_` / `»` 버튼 옆(`client.ts:678-682`)에 `⤢` 아이콘 버튼 `#panelfull` 추가. `renderPanel()`(client.ts:790) 가 `on` 클래스 토글, 핸들러(client.ts:687-693) 가 `active.panelFull` 토글 + `renderPanel()`
- [x] 상태 영속화: `v.panelFull`(세션별) → `savePanel()`(client.ts:756) JSON 에 `full: v.panelFull` 추가, `loadPanelState()`(client.ts:768) 에서 복원
- [x] **승인 요청 시 자동 해제 (MUST)** — **구현 완료 (client.ts:396)**
  - 에이전트 승인 박스는 `client.ts:389` `case "confirm"` 에서 `#logs` 안에 렌됨 (`el("div", "ask")`)
  - `case "confirm"` 끝에 추가: `if (v === active && v.panelFull) { v.panelFull = false; renderPanel(); }`
    - `v` = 이벤트가 속한 세션, `active` = 현재 포커스된 세션 — 승인 박스가 보이는 chat(`v.logEl`)에 놓이므로 **이 세션이 active일 때만** 전체화면을 해제한다
    - `renderPanel()` 안의 `document.body.classList.toggle("panel-full", v.panelFull)` 이 body 클래스 + `#panelfull` on 토글 + inline width 복원을 한 번에 처리 → 별도 site 없음
  - 검증: 전체화면 상태에서 승인 요청 → 패널이 일반 너비로 복귀하고 승인 박스가 chat에 보임
- [x] 단축키: `Ctrl+Shift+b` (client.ts:696). 기존 `Ctrl+B` 사이드바 / ``Ctrl+` `` 터미널 패턴 (`client.ts:989-994`)과 동일
- [x] 좁은 화면(`narrow()`, client.ts:996)에서 토글 동작 — 사이드바를 `position: fixed; width: 280px; z-index: 20` 으로 chat 위에 오버레이, `#panel` 은 `!important` 로 방어
- [x] 전체화면 ↔ 일반 전환 시 폭 복원 — toggle 이 inline width 를 지우면 CSS 기본 520px 로 돌아가므로, 복귀 시 `renderPanel()`(client.ts:787) 이 clamp(`pw = Math.min(Math.max(innerWidth * 0.8, 320), ...)` ) 를 다시 적용
- [x] 검증: `⤢` 클릭 → 좌측 사이드바만 남고 패널이 전체 폭 → 드래그 grip 사라짐 (`styles.ts` `body.panel-full #panelgrip { display: none }`) → 토글로 복귀 + 폭 유지
- [x] 회귀 테스트: `test/web.test.js` "web: an approval in full-screen drops the panel back so the chat shows" — compiled bundle 에서 `case "confirm"` 뒤 `panelFull = false` + `v === active` 조건을 검증 (fix 제거 시 실패 확인)

### [ ] **단계 2-A — 서버: 파일 읽기/쓰기 API** (난도 ★★☆)
- [ ] `GET /fs/file?path=<rel>&sid=<sid>&k=<token>` → `{ rel, mtimeMs, size, binary, content }`
  - `binary`(이미지/binary)는 `content`를 주지 않고 `binary: true`만 (클라이언트에서 "이진 파일은 미리보기가 없습니다" 표시)
  - 크기 상한 512KB 초과 시 잘라서 반환 + `truncated: true`
- [ ] `POST /fs/file` body `{ sid, path, content, mtimeMs? }`
  - `resolveInWorkspace` 검증, `mode === "ro"`면 403
  - **`mtimeMs`가 실disk와 다르면 409 반환** (다른 곳에서 바뀐 파일 덮어쓰기 방지, §4 결정 2)
  - `writeAtomic` 로 저장
- [ ] `test/web.test.js`에 읽기/쓰기 테스트 (경로 탈출 `../`, ro 모드 거부, atomic 후 내용 일치) 추가
- [ ] 검증: curl로 읽기/쓰기, `../` 탈출 시도 → 403

### [ ] **단계 2-B — 클라이언트: File Edit 패널** (난도 ★★★)
- [ ] `page.ts`: `#top`에 `#btnfiles` 버튼 추가 (ICON inline — `ICON_BROWSER`/`ICON_TERMINAL` 스타일, page.ts:13~15)
- [ ] `client.ts` `openFileTab(v, rel)`: `GET /fs/file` → `panelviews`에 textarea 붙인 tab 생성. `t.el`, `t.rel`, `t.mtimeMs` 보관
- [ ] `renderPanel()` (client.ts:653)의 아이콘/라벨 2분기를 3분기로 확장 (`file` → "📄" + 파일명)
- [ ] `togglePanelKind("file")` 분기 추가 — 기존 file 탭 중 마지막 것 재사용 or 새로 열기
- [ ] `closeTab()` (client.ts:683): `file` 탭은 "저장 안 한 변경 있음?" confirm 후 닫기
- [ ] 저장 버튼/`cmd+s`: `POST /fs/file`. 409 응답 시 "파일이 변경되었습니다" 확인 후 새로고침/강제 덮어쓰기
- [ ] `savePanel()`/`loadPanelState()` (client.ts:636/639)에 `file` 분기 추가
  - 복원 시 `GET /fs/file` 재요청, 404면 "삭제된 파일" 탭으로 표시 후 닫기 버튼만 남기기
- [x] 패널 폭 상한 통일 (단계 1-D): `renderPanel()`과 드래그 핸들러 모두 `innerWidth * 0.8` 적용 — 두 상한 일치
- [ ] 검증: 파일 클릭 → 패널에 열림 → 편집 → 저장 → 실제 파일 반영 → 파일 목록(에이전트 read_file)에도 반영

---

## 4. 설계 결정 (구현 전에 선택 필요 — 위 기본안 권장)

| # | 결정 | 권장안 | 상태 |
|---|---|---|---|
| 1 | 트리 표시 정책 | `.gitignore` 단순 파싱(없으면 규칙 무시하고 계속) + `.git`/`node_modules`/`.DS_Store`/숨김 파일 제외. 디렉터리/파일 개수 상한 | 미결 |
| 2 | 저장 충돌 | 저장 전 mtime 비교, 불일치 시 409 + UI 확인 후 진행 | 미결 |
| 3 | `file` 탭 복원 | localStorage에 `{kind:"file", rel}` 저장. 복원 시 GET 재요청, 없으면 "삭제됨" 탭 | 미결 |
| 4 | 모드 정책 | `ro` 세션: 트리는 보이지만 편집/저장 불가(읽기 전용 뷰). `edit`/`bypass`: 저장 가능 | 미결 |
| 5 | 큰/이진 파일 | 512KB 초과 잘라서 표시 + "전체 보기" 없음(이진은 미리보기 불가) | 미결 |
| 6 |panel 상한 | **0.8 로 통일** — `renderPanel()`(client.ts:783)과 드래그 핸들러(client.ts:981) 모두 `innerWidth * 0.8` 적용. 두 상한 일치, 전체화면 토글과 세트 의미 일치 | 완료 (단계 1-D) |

---

## 5. 성공/실패 기준

| 항목 | ✅ 성공 조건 |
|------|------------|
| 트리 API | ✅ `GET /fs/tree`가 `FsTree`(중첩 디렉터리 + 파일 이름 배열)를 반환. sid 로 워크스페이스를 서버가 resolve |
| 트리 UI | ✅ 세션/파일 탭 전환 동작, 재귀 중첩, 펼침/접기, 새로고침, 세션 전환 동기화, 좁은 화면 |
| MVP | 파일 클릭 → composer에 경로 삽입 → Enter 전송 → 에이전트가 그 파일을 읽음 |
| 파일 읽기/쓰기 | ro 세션 저장 불가, 경로 탈출 불가, 저장 후 실제 파일 반영, 충돌 시 409 |
| File Edit 패널 | 클릭→패널, 편집→저장→반영, 미저장 상태 닫기 confirm, 패널 폭/탭 전환 정상 |
| 패널 전체화면 | `⤢` 토글 → 사이드바만 남고 패널이 전체 폭, grip 사라짐, `Ctrl+Shift+E`, 새로고침 후에도 유지, **승인 요청 시 자동 해제** |
| 폭 정합성 | 60% 초과 드래그 후 놓아도 폭이 되돌아가지 않음 (기존 버그 수정) |
| 회귀 | `npm test` 통과, browser/terminal panel·세션 목록·폴더 피커·첨부 기능 동작 유지 |
| 제약 | client.ts에 리터럴 백틱 없음, 모든 요청에 `?k=` 포함, 모드/경로 검증 통과 |
| 테스트 | `/fs/tree`(이미 있음) + 파일 read/write에 `test/web.test.js` 테스트 추가 |
| 안전망 | `client.ts` 작업 후 `npm test` 통과 (구문 검사 2개가 tsc 몫을 대신 잡아준다, §0.1) |

---

## 6. 예상 이슈 및 대체책

- **대용량 repo에서 트리가 느리거나 멈춤** → 현재는 `walk()` 가 **한 번에 전체 재귀**한다(depth ≤ 6, 디렉터리당 200 상한). `node_modules`/`dist` 계열을 `TREE_SKIP` 으로 빼는 것이 실질적인 방어선이다. `.git` 도 `TREE_HIDE` 대상. 응답이 크면 지연 로딩으로 전환 필요.
- **`.gitignore`는 파싱하지 않는다** (의도적 결정). 규칙이 빡빡해지면 사용자가 자기 파일을 못 보게 되므로, 숨기는 건 위 상수 두 개뿐.
- **에이전트와 동시에 같은 파일 수정** → §4 결정 2(mtime 409). 이것이 없으면 사용자의 편집이 에이전트 작업으로 덮어써져 분노만 커진다.
- **화면 좁을 때 트리가 챗을 좁힘** → `narrow()` 분기에서 기본적으로 파일 탭을 닫은 상태로 시작.
- **전체화면 중 승인 요청이 안 보임** → 에이전트가 멈춘 것처럼 보이는 최악의 UX. **자동 해제 구현 완료** (client.ts:396, `case "confirm"` 뒤 `v === active && v.panelFull` 으로 해제). 회귀: `test/web.test.js`.
- **전체화면 상태가 세션 전환 후에도 남음** → `v.panelFull`은 세션별이므로 `renderPanel()` 안에서 body class를 갱신하면 자연히 따라간다. localStorage에 값이 없으면 `false`로 시작.
- **backtick 실수** → client.ts에서 리터럴 백틱 금지, `` \` `` escape (기존 §1.2 제약 그대로 유효).
- **`panelviews` DOM 누수** → `closeTab()`에서 `t.el.remove()` 호출 확인 (browser 경로가 이미 하고 있음).
- **writeBody가 escape 안 된 innerHTML로 들어가는지** → 파일 내용을 `el("textarea")`에 `textContent`으로만 넣을 것 (`el()`은 text만 설정, client.ts:31).

---

## 7. 테스트 규칙

- 이 repo는 `node:test` + `scripts/test.cjs` 러너를 쓴다 (`npm test` = `npm run build && node scripts/test.cjs`).
- **hub 서버 함수는 클래스 밖 순수 함수로 빼서** `test/web.test.js`에서 직접 테스트한다. HTTP를 띄우지 않는다.
- `test/web.test.js` 는 `SessionChannel` 위주. `/fs/tree` HTTP 테스트는 이미 있다. 여기에 파일 read/write 테스트를 append.
- `npm run build`를 먼저 돌려 `dist/`를 갱신한 뒤 `npm test` (테스트는 `dist/`를 요구).
- **`client.ts`를 건드린 작업은 `npm test` 통과가 완료 조건이다.** `tsc`는 CLIENT_JS 내부를 검사하지 못하므로(§0.1) 이 테스트가 유일한 안전망이다.
- `page.ts`에 요소를 추가했다면 두 번째 테스트(id 존재 확인)가 자동으로 통과 여부를 알려 준다 — 별도로 확인할 필요 없다.

---

## 8. 빠른 참고 링크 (2026-09-30 기준 — 옮기기 전 실제 소스로 확인)

- 라우팅(GET): `src/web/hub.ts:742` / (POST): `src/web/hub.ts:773` · **`/fs/tree`: `hub.ts:757`**
- 인증: `src/web/hub.ts:732` (`?k=` 토큰 + same-origin)
- 세션 맵: `src/web/hub.ts:254` (`this.live`), `Live` 정의 `hub.ts:62`
- 트리 walk: `src/web/hub.ts:474` (`fsTree`) · `:485` (`walk`) · 필터 상수 `TREE_SKIP` / `TREE_HIDE`
- 기존 fs API: `src/web/hub.ts:197` (`browseDir`)
- atomic 쓰기 참고: `src/web/store.ts:29` (`writeAtomic`)
- 경로 검증(재사용): `src/sandbox.ts:36` (`resolveInWorkspace`)
- 세션 state: `src/session.ts:396` (`state()` — `workspace`, `mode`, …)
- 사이드바 렌더: `src/web/client.ts:510` (`renderSidebar`)
- **파일 트리**: `client.ts:600` `currentWorkspace` · `:605` `switchTab` · `:616` `loadTree` · `:654` `renderTree` · `:670` `fillTree` · `:691` `setTreeExpanded` · `:707` `insertFile`
- panel 시스템: `src/web/client.ts:830` (`renderPanel`) — 아이콘/라벨 2분기, `file` kind 추가 시 3분기로 확장
- composer 입력: `src/web/client.ts:1077` (`submit`), `client.ts:1091` (`autoGrow`)
- DOM 구조: `src/web/page.ts:30-47`(사이드바) / `page.ts:81-85`(패널)
- 패널 리사이즈 grip: `src/web/client.ts:1038`, `src/web/styles.ts:203`
- 패널 폭 clamp(통일 완료): `client.ts:843`(`renderPanel`)와 `client.ts:1041`(드래그 핸들러) 모두 `innerWidth * 0.8`
- 전체화면 precedent: `src/web/styles.ts:245` (좁은 화면 `#panel` absolute 오버레이)
- 스타일: `src/web/styles.ts` — 사이드바/트리 블록 `:76-100`(`.side-panel:not(.on)` 이 핵심)
- 트리 관련 회귀 테스트: `test/web.test.js` — "the sidebar tab switch matches .side-tab…", "the file tree is fetched over GET…", "…never depends on state.workspace…", "…derived from the server's root", "hub: /fs/tree …"

---

*2026-09-30 기준: 단계 0 · 1-A · 1-B(트리) · 1-C(전체화면) 완료, `npm test` 162/162. 남은 것은 단계 2-A(파일 읽기/쓰기 API)와 2-B(File Edit 패널)다. §"이 기능을 처음 만졌다면"의 4가지 금지 사항을 먼저 읽을 것.*
