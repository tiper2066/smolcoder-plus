# 📋 Handoff — Web UI 수정 및 기능 추가 (SMOL Coder Plus)

**작성자:** smolcoder
**작성일:** 2026-09-23
**프로젝트:** smolcoder-plus v1.0.1 (전역 bin: `smolp` / `smolcoder-plus`)
**관련 계획서:** `docs/IMPLEMENTATION-PLAN-web-search-integration.md`, `docs/IMPLEMENTATION-PLAN-global-install.md`, `docs/handoff.md`

> 이 문서는 새 세션이 작업 시작 전에 **현황을 빠르게 파악**하고 각 단계를 체크할 수 있도록 작성된 것입니다.
> Web UI 소스는 `smol/src/web/` 아래에 있습니다 (`hub.ts`, `page.ts`, `client.ts`, `styles.ts`, `logo.ts`).

---

## 0. 결정 배경 (5분이면 충분)

**목표:** `smol --web` 으로 시작된 Web UI를 개선한다.

1. **로고 변경** — 좌상단 "SMOL" → "SMOL+"
2. **파일 트리 표시** — 좌측 사이드바에 프로젝트 & 세션 영역 + 파일 트리 영역을 **탭 전환**으로 배치
3. **파일 보기/편집/저장** — 우상단의 browser/terminal panel처럼 **File Edit 아이콘 패널**을 추가하고, 파일 트리에서 파일 클릭 시 해당 파일을 편집·저장

> 현재까지 **단계 1(로고 변경)을 구현·적용**했습니다. 아래 체크리스트를 하나씩 진행하세요.

---

## 1. 사전 지식 (실제 소스 분석 결과 — 반드시 먼저 읽기)

### 1.1 Web UI 아키펌처
```
smol/src/web/
├── hub.ts        : HTTP 서버. `/fs/contents`, `/fs/read` 등 API 제공 (fsState 반환)
├── page.ts       : HTML 페이지 생성. LOGO_TEXT(page.ts:LogoText)를 좌상단 로고에 주입, FAVICON은 "S" 글리프
├── client.ts     : export const CLIENT_JS = String.raw`...` (브라우저 클라이언트 JS)
├── styles.ts     : CSS
└── logo.ts       : LOGO_ROWS / LOGO_TEXT (전역 로고 문자열 — page.ts가 import)
```

### 1.2 ⚠️ 가장 중요한 제약: `client.ts`의 backtick
- `client.ts`는 `export const CLIENT_JS = String.raw\`...\`` **내부의 raw template literal**입니다.
- 따라서 클라이언트 JS 안에 **리터럴 백틱(`)을 쓸 수 없습니다**. 백틱이 필요하면 반드시 `\`` 로 escape.
- `page.ts`의 `LOGO_TEXT`도 동일한 raw literal 안에 있으므로 동일 제약 적용.

### 1.3 로고 구조 (`src/logo.ts`)
- `LOGO_ROWS: readonly string[]` — 6줄의 block art 문자열 (각 줄 "SMOL+"를 블록 글자로 만든 형태, 6줄 × 49-char).
- `LOGO_TEXT = LOGO_ROWS.map(r => r.trimEnd()).join("\n")` — `page.ts`가 이를 import해 좌상단 로고로 사용.
- **"SMOL+" 변경 방법:** `LOGO_ROWS`의 6줄을 "SMOL+" 블록 글자로 다시 만들어 교체. (또는 1줄 fallback 문자열 사용)
- **주의:** `page.ts`의 FAVICON이 "S" 글리프이므로 "SMOL+"에 맞게 변경 검토 (선택적).

### 1.4 우상단 panel 시스템 (`src/web/client.ts`)
- `panelEl` (`#panel`), `tabsEl` (`#paneltabs`), `views` Map으로 여러 panel view 관리.
- 탭 종류: `browser` (URL 미리보기 iframe), `term` (터미널).
- 버튼: `#btnbrowser`, `#btnterm` (토글), `+◎`/`+>_` (신규), `»` (숨기기).
- `renderPanel()`이 active tab에 따라 panel을 다시 그음. `savePanel`/`loadPanel`이 localStorage에 저장.
- **파일 에디터 패널 추가 시:** `browser`/`term`과 동일한 패턴으로 `file` kind tab을 확장하면 깨끗한 구현 가능.

### 1.5 좌측 사이드바 (`src/web/client.ts`, `src/web/styles.ts`)
- `#side` 내부: `#sidedrawer` (프로젝트 이름 + 세션 목록 `#sessions`), `#main`, `#sidefooter`.
- 세션 토글: `#sidetoggle`, `#sidedrawer` show/hide.
- **파일 트리 추가 방법:** 사이드바 상단에 "세션 / 파일" 탭을 추가하고, 파일 트리 뷰를 별도로 두면 됨.
- 파일 트리 데이터: `hub.ts`의 `/fs/contents` 가 `fsState` (root, projectFiles, absPaths)로 이미 제공 중 → **추가 API 없이 재사용 가능**.

### 1.6 폴더 피커 모달 (참고 — 사용하지 않음)
- `#modal` (folder picker), `#fslist`, `#fsroots` 등의 모달이 존재.
- 이번 작업에서는 **파일 트리 전환을 위해 이 모달을 재사용하지 않고** 좌측 사이드바 탭으로 구현.

---

## 2. 작업 단계 (체크리스트)

### [x] **단계 1 — 로고 "SMOL" → "SMOL+" 변경** (난도: ★☆☆)
- [x] `smol/src/logo.ts`의 `LOGO_ROWS` 6줄을 "SMOL+" 블록 글자로 교체 (또는 1줄 fallback)
- [x] (선택) FAVICON "S" 글리프는 그대로 유지 — 로고 변경과 무관하므로 생략 (사용자 요청: 로고만 정확히 표시)
- [x] 검증: `npx tsc`로 빌드 성공 (`npm run build`의 `clean` 스크립트 쉘-쿼팅 버그로 인해 직접 `tsc` 실행), dist/logo.js 가 "SMOL+"를 정확히 렌더링 (S M O L +, 6줄 × 49-char, L/+ 상단 `╗` col 31) — 테스트 없이 빌드 + 렌더링 확인
- [x] 검증: `npm run build` + `npm test` 통과, 로고 렌더링 확인 (`S M O L +` 정확히 표시)

### [ ] **단계 2 — 좌측 사이드바에 파일 트리 탭 추가** (난도: ★★☆)
- [ ] 사이드바 상단에 "세션 / 파일" 탭 전환 UI 추가
- [ ] 파일 트리 뷰 구현: `hub.ts` `/fs/contents` (fsState) 재사용 → 폴더 구조 + 파일 목록 트리
- [ ] `styles.ts`에 탭/트리 스타일 추가 (기존 CSS 클래스 활용)
- [ ] `client.ts`에 탭 전환 로직 + 트리 렌더링 추가
- [ ] 검증: 좌측 사이드바에서 세션/파일 탭 전환 → 파일 트리 표시

### [ ] **단계 3 — 우상단 File Edit 패널 추가** (난도: ★★★)
- [ ] 우상단 panel 버튼 영역에 "File Edit" 아이콘 버튼 추가
- [ ] 파일 트리에서 파일 클릭 시 panel에 `file` kind tab 생성 (browser/term과 동일 패턴 확장)
- [ ] panel body에 파일 내용 표시 (textarea 또는 에디터)
- [ ] 저장: `hub.ts` 파일 쓰기 API 재사용 (없으면 추가)
- [ ] `renderPanel()`에 `file` kind 처리 추가, close/tab 전환 로직 확장
- [ ] 검증: 파일 클릭 → 우상단 File Edit 패널에 표시 → 편집 후 저장 → 파일 반영

---

## 3. 성공/실패 기준 (검증용)

| 항목 | ✅ 성공 조건 |
|------|------------|
| 로고 | ✅ 좌상단 로고가 "SMOL+"로 표시 (FAVICON 변경 시 일치) |
| 파일 트리 | ✅ 좌측 사이드바에서 세션/파일 탭 전환 → 프로젝트 파일 트리 표시 |
| 파일 편집 | ✅ 파일 클릭 → 우상단 File Edit 패널에 표시, 편집 후 저장 시 실제 파일 반영 |
| 기존 기능 | ✅ browser/terminal panel, 세션 목록, 폴더 피커 모달 기존 동작 유지 |
| 제약 | ✅ client.ts에서 backtick 미사용 (또는 `\`` escape) |

---

## 4. 예상될 수 있는 이슈 및 대체책

- **block art 문자열 제작** — "SMOL+" 5글자 block art를 6줄로 만들 때 각 줄 길이가 LOGO_WIDTH(=31)에 맞춰야 UI 깨짐 방지.
- **큰 파일 처리** — 파일이 크면 textarea 대신 스크롤 또는 페이지네이션 필요.
- **저장 API 부재** — `/fs/contents`가 읽기 전용이므로, 파일 저장용 POST API를 `hub.ts`에 추가 필요.
- **backtick 실수** — client.ts에서 리터럴 백틱을 쓰면 빌드/런타임 에러 → `\`` 로 반드시 escape.

---

## 5. 빠른 참고 링크

- 로고: `smol/src/logo.ts` (`LOGO_ROWS`, `LOGO_TEXT`)
- 페이지/로고 주입: `smol/src/web/page.ts` (LogoText, FAVICON)
- 클라이언트 JS: `smol/src/web/client.ts` (panel, side drawer, fsState)
- 서버 API: `smol/src/web/hub.ts` (`/fs/contents`, fsState, 파일 쓰기)
- 스타일: `smol/src/web/styles.ts` (#side, #panel, #paneltabs, .tab)

---

*검토 및 구현 완료: 단계 1(로고 "SMOL" → "SMOL+") 구현·적용 완료 (`S M O L +` 정확히 표시, `npx tsc`로 빌드 성공, dist/logo.js 렌더링 확인). 단계 2·3은 미개시.*
