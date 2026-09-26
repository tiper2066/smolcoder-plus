# AGENTS.md — smolcoder-plus

**SMOL Coder Plus** = [leonvanzyl/smolcoder](https://github.com/leonvanzyl/smolcoder)의 포크 (MIT, 원 저작자 © Leon van Zyl).
로컬 모델(Ollama / LM Studio)용 CLI 코딩 에이전트. TypeScript → `dist/`로 컴파일되는 **단일 npm 패키지**.

## 🚨 명령어

```bash
npm run build     # tsc → dist/ (clean + postbuild 포함)
npm test          # = npm run build && node scripts/test.cjs  ← 이걸 쓸 것
npm run dev       # tsc -w
```

- **`npm test`가 빌드를 포함한다.** `node --test test/foo.test.js`를 단독으로 돌리면 `dist/`가 오래되어 엉뚱한 결과가 나온다. 테스트는 항상 `dist/`를 본다.
- 헤드리스 확인: `smolp -p "프롬프트"`, 웹 UI: `smolp --web`.
- GitHub Actions(`.github/workflows/test.yml`)는 ubuntu/macos/windows × Node 18·22에서 `npm test`를 돌린다. **Node 18에서 깨지는 문법·API 금지** (`fetch`는 내장, 그 외는 `node:` 내장 모듈만).

## 🚨 절대 규칙

1. **`dist/`를 직접 수정하지 않는다.** 생성물이며 `.gitignore` 대상. 고치려면 `src/`를 고치고 `npm run build`.
2. **런타임 의존성을 추가하지 않는다.** `package.json`에 `dependencies`가 없는 것이 의도된 설계다(zero-config·오프라인·단일 배포). 새 functionality는 `node:` 내장 모듈과 기존 코드로 구현한다. 외부 패키지가 꼭 필요하면 **먼저 사용자에게 물어본다.**
3. **비밀값을 커밋하지 않는다.** `.env`는 `.gitignore`에 있음. `BRAVE_API_KEY` 같은 값을 코드·로그·테스트 픽스처에 하드코딩하지 않는다.
4. **주석과 코드 식별자는 영어로 쓴다.** `src/`의 기존 주석은 전부 영어 — 한국어 주석을 섞지 않는다. (`docs/` 문서만 한국어)
5. **기존 스타일을 따른다.** 2칸 들여쓰기, double quote, 세미콜론, `const`, `let`(재할당 시), 화살표 함수, `c.red()` 같은 색상 유틸(`src/util.ts`), 조용한 실패는 `try {} catch { /* already gone */ }`.
6. **주석은 "왜"를 설명한다.** 코드가 무엇을 하는지는 obvious하므로. 업스트림 코드의 기존 한국어→영어 주석은 원 author's Voice를 유지한다.
7. **사용자에게 물어보기 전 추측하지 않는다.** API·엔드포인트·옵션을 지어내지 말 것. 확실하지 않으면 소스를 읽거나 확인한다.

## 구조

```
src/
├── index.ts        CLI 엔트리. 인자 파싱, runInteractive / runWeb / headless
├── session.ts      Session 클래스 — 워크스페이스+에이전트+UI 1개. model 선택/슬래시 명령
├── agent.ts        턴 루프. 도구 호출, 검증, 압축 트리거
├── prompt.ts       시스템 프롬프트 빌드
├── context.ts      토큰 예산·압축· evict
├── detect.ts       Ollama / LM Studio 탐지, 컨텍스트 윈도우 해석
├── config.ts       ~/.smolcoder/ 설정
├── sandbox.ts      경로·커맨드 승인 규칙 (resolveInWorkspace 등)
├── verification.ts 파일 편집 후 검증
├── attachments.ts  첨부 파일(이미지 base64, 텍스트 인라인)
├── network.ts hosts.ts netscan.ts   다른 머신의 모델 서버 탐색
├── plan.ts tasks.ts ui.ts tui/ util.ts events.ts verification.ts
├── providers/      ollama.ts · lmstudio.ts · transport.ts · scheduler.ts · types.ts
├── tools/          index.ts(도구 레지스트리+디스패치) · fs-tools · shell · tasks
│                   check · search-worker · web-search
└── web/            hub.ts(HTTP) · page.ts(HTML) · client.ts(브라우저 JS) · styles.ts(CSS)
                    channel.ts · store.ts · terminal.ts
```

- **에이전트가 쓰는 도구 9개** (`src/tools/index.ts`의 `buildToolSpecs(mode)`): `read_file` `list_files` `search` `web_search` `plan` `write_file` `edit_file` `run_command` `task`. `ro` 모드는 앞의 5개(읽기)만, `edit`/`bypass`는 9개.
- `session.ts` ↔ `tui/`(터미널) ↔ `web/`(브라우저)는 **같은 루프를 공유**한다. 로직을 한쪽에만 넣지 말고 양쪽 UI가 함께 쓸 수 있게 `Session`/`SessionUI`(`ui.ts`) 경계에 둔다.

## 🌐 web_search (Brave Search)

필요할 때 인터넷 검색: agent의 `web_search` 도구 사용 ({"query": "..."}). BRAVE_API_KEY가 루트 .env에 있으면 동작하며, 기존 8개 도구와 함께 ro/edit/bypass 모든 모드에서 등록됨.

> 현재 도구는 `web_search`를 포함해 **9개**다(위 참조).

## 🔒 보안 규칙

- **파일 접근은 항상 workspace 안으로 제한.** `src/sandbox.ts`의 `resolveInWorkspace(root, userPath)`를 **재사용**한다(최심 existing ancestor를 realpath 처리해 심볼릭 링크 탈출을 막는다). `path.resolve`만 쓰지 않는다.
- **커맨드는 모드에 따라 게이트된다.** `bypass` 모드가 예외 경로를 만들지만, 기본은 승인 요청이다(`commandEscapesWorkspace`). 승인을 무시하는 지름길을 새로 만들지 않는다.
- **웹 UI API는 세션 컨텍스트를 검증한다.** GET 라우트는 세션 workspace를 모르므로 `sid`를 받아 검증한다. 쓰기 API는 `mode === "ro"`에서 거부하고, 저장은 atomic(`store.ts`의 `writeAtomic` 참고).
- **인증 토큰 필수.** `hub.ts`는 모든 라우트에서 `?k=<token>` + same-origin을 검사한다(403). 새 라우트를 추가할 때 빠뜨리지 않는다. 서버는 loopback에만 바인딩된다.
- **사용자 입력을 HTML에 삽입할 때 `innerHTML`을 쓰지 않는다.** DOM은 `client.ts`의 `el(tag, cls, text)` 헬퍼(`textContent`만 설정)로 만든다.

## 🧪 테스트 규칙

- 러너는 `node:test`. `npm test` = build 후 `scripts/test.cjs`가 `test/*.test.js`를 전부 수집.
- **hub·provider·sandbox 같은 서버 로직은 클래스 밖 순수 함수로 빼서** 테스트에서 HTTP 없이 직접 검증한다.
- 버그를 고칠 때 **그 버그를 재현하는 테스트를 먼저 추가**한다. 테스트 이름은 `영역: 동작` 형식(`"hub: sessions start, echo, save, close"`).
- 회귀 시나리오는 `scripts/regtest.js` 템플릿을 따른다.
- 테스트가 실제로 실패하는지 **역검증**한다(테스트를 임의로 깨뜨려 보고 messages가 맞는지 본 뒤 원복).

## 🖥 Web UI 작업 규칙 (가장 함정 많은 영역)

1. **`src/web/client.ts`는 `String.raw` 템플릿이다.** 그 안의 JS는 `tsc`에 **문자열로만** 보인다.
   - 리터럴 백틱 금지 → `` \` `` 로 escape. `${...}` 쓰면 **빌드 시점에 보간**되므로 쓰지 않는다(문자열 이어붙이기를 쓴다).
   - **일반 문법 오류(괄호 누락 등)는 `tsc`를 통과한다** → 브라우저에서 UI 전체가 죽는다.
2. **따라서 `client.ts`를 건드린 뒤에는 `npm test`가 통과할 때까지 진행하지 않는다.** `test/web.test.js`의 client bundle 구문 검사 + id 존재 검사가 tsc가 못 보는 것을 잡아준다(`docs/web-ui-changes-handoff.md` §0.1).
3. **DOM·CSS는 `page.ts`(구조)와 `styles.ts`(스타일)에서 함께 추가**한다. `client.ts`가 `$("id")`로 찾으면 `page.ts`에 그 id가 있어야 테스트가 통과한다.
4. **클라이언트 요청에 `?k=<token>`을 붙인다** — `post()`는 자동, 직접 `fetch`는 수동.
5. 좁은 화면(`narrow()`, 1000px)과 `#panel` 오버레이 규칙(`styles.ts`)을 고려한다.
6. Web UI 작업의 계획·검토는 `docs/web-ui-changes-handoff.md`를 따른다(단계 0~2-B, 서버 API 계약 포함).

## 📄 문서 규칙

- `docs/`는 한국어. 계획(`IMPLEMENTATION-PLAN-*.md`)과 핸드오프(`*-handoff.md`)를 쓰고, 작업을 마치면 **완료 상태와 검증 결과를 문서에 반영**한다.
- **코드에서 검증한 사실만 쓴다.** 문서의 코드 위치(라인·엔드포인트)를 옮겨 적을 때는 실제 소스로 확인한다. 추측으로 채운 문서는 다음 세션을 오도한다.
- 업스트림과 다른 지점(포크 고유 기능)을 문서에 남긴다.

## 🔀 포크 유지 규칙

- 업스트림 `leonvanzyl/smolcoder`와 공유하는 코드를 임의로 바꾸지 않는다. 기능 추가 시 업스트림 방식(기존 패턴 확장)을 따른다.
- 업스트림에서 고친 내용을 포크에 합칠 때는 **포크 고유 변경과 충돌하지 않는지 먼저 diff로 확인**한다.
