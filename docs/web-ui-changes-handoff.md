# 📋 Handoff — Web UI: 파일 트리 + File Edit 패널 (SMOL Coder Plus)

**작성자:** smolcoder
**작성일:** 2026-09-23
**최종 업데이트:** 2026-09-26 (전제 검증 후 재작성 — 기존 `/fs/contents` 전제가 실제로는 없었음)
**프로젝트:** smolcoder-plus v1.0.5 (전역 bin: `smolp` / `smolcoder-plus`)
**관련 계획서:** `docs/IMPLEMENTATION-PLAN-web-search-integration.md`, `docs/IMPLEMENTATION-PLAN-global-install.md`, `docs/handoff.md`

> 이 문서는 새 세션이 작업 시작 전에 **현황을 빠르게 파악**하고 각 단계를 체크할 수 있도록 작성된 것입니다.
> **이 문서의 코드 위치는 2026-09-26에 실제 소스로 검증한 값입니다.** 문서와 코드가 다르면 코드를 먼저 확인하고 이 문서를 고치세요.

---

## 0. 목표와 현재 상태

**목표:** `smolp --web` Web UI에 두 가지 기능 추가.

1. **파일 트리** — 좌측 사이드바에 "세션 / 파일" 탭을 두고 워크스페이스 파일 트리 표시. 파일 클릭 시 composer에 경로 삽입(MVP) 또는 편집기에서 열기.
2. **File Edit 패널** — 우상단 panel에 `file` kind 탭을 추가해 파일을 보고 편집·저장.
3. **패널 전체화면 토글** — `⤢` 버튼 한 번으로 패널을 좌측 사이드바만 남는 전체 폭으로 확장. 좁은 기본 폭(최대 60%) 때문에 생기는 불편을 먼저 해소하는 선행 작업(단계 1-C).

**현재 상태: 셋 다 미개시.** 1·2에 필요한 서버 API도 아직 없다(§1.3).

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
├── #wslist           : renderSidebar()가 그리는 유일한 리스트 컨테이너
│   └── .ws (워크스페이스별 박스)
│       ├── .wshdr    : .wsname + "+"(신규 세션) + "×"(워크스페이스 제거)
│       └── .sessions : .sess 행들 (클릭=선택, 더블클릭=이름변경)
└── .sidefoot         : #ver + #keys
```

- 이전 문서의 "`#sidedrawer` / `#sessions` / `#main` / `#sidefooter`" 중 **`#sidedrawer`, `#sessions`는 존재하지 않는다.** 실제 id는 `#wslist`이고 세션 목록은 `.sessions` 클래스다.
- **"세션 / 파일" 탭 추가 위치:** `#openfolder` 바로 아래, `#wslist` 위에 탭 바를 넣고, `#wslist`를 숨기거나 대체한다. (기존 `#wslist` 렌더링 코드는 손대지 않고 `hidden` 토글만 권장.)
- 접기/펼치기: `setSide()` (client.ts:864), `narrow()` = `matchMedia("(max-width: 1000px)")` (client.ts:869). 좁은 화면 동작을 확인할 것.

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
| `workspace` | **루트 경로.** 트리/파일 API의 기준. client.ts:589 `openDialog()`가 이미 `active.state.workspace`를 씀 |
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
5. **임시/숨김 항목은 기본 제외.** `.git`, `node_modules`, `.DS_Store`, `dist`, `.venv`, `__pycache__` 등. 가능하면 `.gitignore`를 단순 파싱해 적용하되, 파싱에 실패해도 무시하고 계속 진행한다(로컬 앱이므로 규칙이 빡빡해지면 안 됨).
6. **패널 전체화면 중에는 에이전트 승인을 절대 숨기지 않는다.** 전체화면은 `#main`(챗) 전체를 감추므로, 승인 요청이 도착하면 **자동으로 전체화면을 해제**한다(§3 단계 1-C).

---

## 3. 작업 단계 (체크리스트)

### [x] **단계 0 — groundwork**
- [x] `npm run build && npm test` 통과 확인 (baseline 154/154)
- [x] `docs/` 문서에 `/fs` 실체 정정 반영 완료 (본 문서가 그 결과)
- [x] **client bundle 구문 검사 테스트 추가 (2026-09-26 완료)** — 아래 §0.1 참조. 이후 모든 client.ts 작업의 안전망

### [ ] **단계 1-A — 서버: 파일 트리 API** (난도 ★★☆)
- [ ] `hub.ts`에 `export function listTree(root, rel, depth)` 순수 함수 작성 (테스트 가능하게 hub 클래스 밖으로)
  - 반환: `{ path, rel, dirs: [{name, rel, children?}], files: [{name, rel, size}] }` — 디렉터리/파일을 분리
  - `depth`로 lazy 로딩 (기본 1). 전체 재귀 한 번에 금지(대용량 repo에서 멈춤)
  - 개수 상한(dirs 500 / files 2000), 심볼릭 링크는 workspace 밖이면 건너뜀
- [ ] `hub.ts:695` GET switch에 `case "/fs/tree":` 추가 — `sid`로 `Live.workspace` lookup 후 `resolveInWorkspace` 검증
- [ ] `test/web.test.js`에 `listTree` 단위 테스트 추가 (§5)
- [ ] 검증: `curl "http://127.0.0.1:7433/fs/tree?sid=<sid>&k=<token>"` → JSON 확인

### [ ] **단계 1-B — 클라이언트: 사이드바 탭 + 트리** (난도 ★★☆)
- [ ] `page.ts`: `#openfolder` 아래에 `#sidetabs`(세션/파일) + `#fstree` 컨테이너 추가, `#wslist`는 기본 표시
- [ ] `styles.ts`: 탭 바 + 트리(들여쓰기, 파일/디렉터리 구분, chevron) 스타일 추가
- [ ] `client.ts`: 탭 전환 함수. localStorage `smol.side.tab` 저장 (`ls.get/set` 사용, client.ts:14)
- [ ] `client.ts`: `loadTree(sid, rel, depth)` → 지연 렌더. 디렉터리 클릭 → 그 디렉터리 `children` 요청 후 펼침
- [ ] `client.ts`: **MVP — 파일 클릭 시 composer에 상대경로 삽입**
  - `input.value += (input.value && !input.endsWith(" ") ? " " : "") + rel` 후 `autoGrow()` (client.ts:907) + 포커스
  - 이게 1단계의 최종 수익. 서버 추가 작업 0줄
- [ ] 좁은 화면(`narrow()`)에서 탭·트리 동작 확인
- [ ] 검증: 사이드바 탭 전환 → 트리 표시 → 파일 클릭 → 입력창에 경로 → Enter로 에이전트에게 전달

### [ ] **단계 1-C — 패널 전체화면 토글 + 폭 정합성** (난도 ★☆☆)
> 파일 트리/에디터가 "좁다"는 불편이 가장 먼저 해결되는 항목. 2-B보다 먼저 구현한다.

- [ ] **폭 상한 불일치 수정 (기존 버그)**
  - `client.ts:857` 드래그 중 상한은 `innerWidth * 0.8`, `client.ts:663` `renderPanel()`은 `innerWidth * 0.6` → **60%를 넘겨 드래그하면 마우스를 놓는 순간 패널이 확 줄어든다**
  - 두 상한을 **0.8로 통일** (챗이 20%까지 압축될 수 있으므로 전체화면 토글과 세트로 의미가 있다). 또는 0.6으로 낮춰 일치시켜도 된다 — **하나로 통일하는 것 자체가 목표**
- [ ] `styles.ts`에 전체화면 스타일 추가
  ```css
  body.panel-full #main        { display: none; }
  body.panel-full #panel       { flex: 1 1 auto; width: auto !important; max-width: none; }
  body.panel-full #panelgrip   { display: none; }  /* 전체화면 중에는 드래그 불가 */
  ```
  - `!important`가 필요한 이유: `client.ts:663`이 inline `style.width`를 박기 때문. `styles.ts:329`의 좁은 화면 오버레이 규칙(`width: 100% !important`)가 같은 이유로 이미 이 패턴을 쓴다 — **그 precedent를 그대로 따라간다**
  - 사이드바(`#side`, `flex: none`)는 남아 있으므로 "좌측 사이드바를 제외한 전체화면"이 된다
- [ ] `client.ts` `renderPanel()` 안에서 `document.body.classList.toggle("panel-full", !!v.panelFull)`
  - `renderPanel()`은 세션 전환·탭 전환마다 이미 호출되므로 여기에 넣으면 별도 호출 sites가 필요 없다
- [ ] 토글 버튼: `#paneltabs`의 `+◎` / `+>_` / `»` 버튼 옆(`client.ts:678-682`)에 `⤢` 아이콘 버튼 추가
- [ ] 상태 영속화: `v.panelFull`(세션별) → `savePanel()`(client.ts:636) JSON에 `full: v.panelFull` 추가, `loadPanelState()`(client.ts:639)에서 복원
- [ ] 🔴 **승인 요청 시 자동 해제 (MUST)**
  - 에이전트 승인 박스는 `#logs` 안에 렌더된다(`client.ts:435-438`). 전체화면이면 안 보여서 **에이전트가 멈춘 것처럼 보인다**
  - `phase === "waiting"` 전환을 감지해 `v.panelFull = false` + `renderPanel()` 호출 + 배지로 알림
  - (`renderState()`가 이미 `phase`를 소비하므로 기존 흐름에 끼워 넣을 수 있다)
- [ ] 단축키: `Ctrl+Shift+E` (기존 `Ctrl+B` 사이드바 / ``Ctrl+` `` 터미널 패턴, `client.ts:989-994`) + `#keys` 다이얼로그 목록(`client.ts:985`)에 한 줄 추가
- [ ] 좁은 화면(`narrow()`, client.ts:869)에서는 토글 버튼 숨김 — 이미 `styles.ts:329` 오버레이로 전체화면이므로 중복
- [ ] 전체화면 ↔ 일반 전환 시 이전 폭이 정확히 복원되는지 확인 (toggle이 inline width를 지우면 CSS 기본 520px로 돌아가므로, 복귀 시 `renderPanel()`이 clamp를 다시 적용하게 둔다)
- [ ] 검증: `⤢` 클릭 → 좌측 사이드바만 남고 패널이 전체 폭 → 드래그 grip 사라짐 → `Esc`/토글로 복귀 + 폭 유지 → 에이전트 승인 요청이 오면 자동 복귀

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
- [ ] 패널 폭 제한 유지 (renderPanel이 이미 `Math.min(panelWidth, window.innerWidth * 0.6)` 적용)
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
| 6 | 패널 폭 상한 | 드래그(0.8)와 `renderPanel`(0.6) 중 하나로 통일. **0.8 통일 + 전체화면 토글 제공** 권장 (챗이 좁아지는 것은 전체화면으로 해소) | 미결 |

---

## 5. 성공/실패 기준

| 항목 | ✅ 성공 조건 |
|------|------------|
| 트리 API | `GET /fs/tree`가 workspace 상대경로로 dir/file 구분 목록을 반환, `../` 탈출 차단 |
| 트리 UI | 사이드바 세션/파일 탭 전환 동작, 지연 로딩, 좁은 화면에서 깨지지 않음 |
| MVP | 파일 클릭 → composer에 경로 삽입 → Enter 전송 → 에이전트가 그 파일을 읽음 |
| 파일 읽기/쓰기 | ro 세션 저장 불가, 경로 탈출 불가, 저장 후 실제 파일 반영, 충돌 시 409 |
| File Edit 패널 | 클릭→패널, 편집→저장→반영, 미저장 상태 닫기 confirm, 패널 폭/탭 전환 정상 |
| 패널 전체화면 | `⤢` 토글 → 사이드바만 남고 패널이 전체 폭, grip 사라짐, `Ctrl+Shift+E`, 새로고침 후에도 유지, **승인 요청 시 자동 해제** |
| 폭 정합성 | 60% 초과 드래그 후 놓아도 폭이 되돌아가지 않음 (기존 버그 수정) |
| 회귀 | `npm test` 통과, browser/terminal panel·세션 목록·폴더 피커·첨부 기능 동작 유지 |
| 제약 | client.ts에 리터럴 백틱 없음, 모든 요청에 `?k=` 포함, 모드/경로 검증 통과 |
| 테스트 | `listTree` + 파일 read/write에 `test/web.test.js` 테스트 추가 |
| 안전망 | `client.ts` 작업 후 `npm test` 통과 (구문 검사 2개가 tsc 몫을 대신 잡아준다, §0.1) |

---

## 6. 예상 이슈 및 대체책

- **대용량 repo에서 트리가 느리거나 멈춤** → depth=1 지연 로딩 + 개수 상한 필수. 전체 재귀 금지.
- **`.gitignore` 파싱 실수** → 실패해도 무시하고 진행. 이 앱은 로컬 전용이라 엄격한 무시 규칙 불필요.
- **에이전트와 동시에 같은 파일 수정** → §4 결정 2(mtime 409). 이것이 없으면 사용자의 편집이 에이전트 작업으로 덮어써져 분노만 커진다.
- **화면 좁을 때 트리가 챗을 좁힘** → `narrow()` 분기에서 기본적으로 파일 탭을 닫은 상태로 시작.
- **전체화면 중 승인 요청이 안 보임** → 에이전트가 멈춘 것처럼 보이는 최악의 UX. **자동 해제 MUST** (단계 1-C).
- **전체화면 상태가 세션 전환 후에도 남음** → `v.panelFull`은 세션별이므로 `renderPanel()` 안에서 body class를 갱신하면 자연히 따라간다. localStorage에 값이 없으면 `false`로 시작.
- **backtick 실수** → client.ts에서 리터럴 백틱 금지, `` \` `` escape (기존 §1.2 제약 그대로 유효).
- **`panelviews` DOM 누수** → `closeTab()`에서 `t.el.remove()` 호출 확인 (browser 경로가 이미 하고 있음).
- **writeBody가 escape 안 된 innerHTML로 들어가는지** → 파일 내용을 `el("textarea")`에 `textContent`으로만 넣을 것 (`el()`은 text만 설정, client.ts:31).

---

## 7. 테스트 규칙

- 이 repo는 `node:test` + `scripts/test.cjs` 러너를 쓴다 (`npm test` = `npm run build && node scripts/test.cjs`).
- **hub 서버 함수는 클래스 밖 순수 함수로 빼서** `test/web.test.js`에서 직접 테스트한다. HTTP를 띄우지 않는다.
- 기존 `test/web.test.js` (465줄)는 `SessionChannel` 위주. 여기에 `listTree` + 파일 read/write 테스트를 append.
- `npm run build`를 먼저 돌려 `dist/`를 갱신한 뒤 `npm test` (테스트는 `dist/`를 요구).
- **`client.ts`를 건드린 작업은 `npm test` 통과가 완료 조건이다.** `tsc`는 CLIENT_JS 내부를 검사하지 못하므로(§0.1) 이 테스트가 유일한 안전망이다.
- `page.ts`에 요소를 추가했다면 두 번째 테스트(id 존재 확인)가 자동으로 통과 여부를 알려 준다 — 별도로 확인할 필요 없다.

---

## 8. 빠른 참고 링크

- 라우팅(GET): `src/web/hub.ts:684-705` / (POST): `src/web/hub.ts:874+`
- 인증: `src/web/hub.ts:673` (`?k=` 토큰 + same-origin)
- 세션 맵: `src/web/hub.ts:231` (`this.live`), `Live` 정의 `hub.ts:46`
- 기존 fs API: `src/web/hub.ts:172` (`browseDir`)
- atomic 쓰기 참고: `src/web/store.ts:25` (`writeAtomic`)
- 경로 검증(재사용): `src/sandbox.ts:36` (`resolveInWorkspace`)
- 세션 state: `src/session.ts:396` (`state()` — `workspace`, `mode`, …)
- 사이드바 렌더: `src/web/client.ts:504` (`renderSidebar`)
- panel 시스템: `src/web/client.ts:634-712`
- composer 입력: `src/web/client.ts:893` (`submit`), `client.ts:907` (`autoGrow`)
- DOM 구조: `src/web/page.ts:24-88`
- 패널 리사이즈 grip: `src/web/client.ts:854-860`, `src/web/styles.ts:175-176`
- 패널 폭 clamp(정합성 대상): `src/web/client.ts:663` (0.6) vs `client.ts:857` (0.8)
- 전체화면 precedent: `src/web/styles.ts:329` (좁은 화면 `#panel` absolute 오버레이)
- 단축키 핸들러: `src/web/client.ts:989-994`, `#keys` 목록 `client.ts:985`
- 스타일: `src/web/styles.ts` (`#side`, `#wslist`, `#panel`, `.ptab`)

---

*단계 0~2-B 모두 미개시. 1-C(전체화면)는 난도 ★☆☆로 가장 빠르게 체감되고, 1-B 완료 시점(트리 + 경로 삽입)이 첫 번째 기능 완성 지점이다.*
