# B 방안 — 소스 코드에 인터넷 검색 도구 통합 (구현 계획서)

**상태:** 계획 중 / 구현 전
**결정일:** 2026-09-23
**관련 결정:** 사용자 선택 **(A)** Brave 유지 + **B** 소스 통합

---

## 1. 배경 및 목적

### 1.1 왜 통합하는가
현재 인터넷 검색은 프로젝트 루트 `scripts/search.js`라는 별개 스크립트로 제공된다(A 방안).
그런데 smolcoder의 샌드박스는 파일 접근을 프로젝트 폴더로 제한하고, **명령 실행도 워크스페이스 바깥 절대경로를 edit 모드에서 승인 요청**한다.
그래서 "매 프로젝트마다 `scripts/search.js` + `AGENTS.md`를 직접 복사"하는 A 방안이 불편하다.

따라서 검색 도구 자체를 **smol 폴더의 소스 코드(`src/tools/`)에 통합**하여,
새로운 프로젝트에서는 아무것도 복사하지 않아도 검색 도구가 항상 사용 가능하게 한다.

### 1.2 핵심 설계 원칙 (이미 확정됨)
- **Brave Search API 유지**: 무료·키 없는 엔드포인트는 이 환경에서 신뢰할 수 없음(봇 차단 확인). Brave 키 품질이 우수함.
- **.env 는 빌드에 절대 주입되지 않음**: `npm run build`는 오직 `tsc`(순수 코드 변환)만 실행 → `.env` 내용은 dist产物에 들어가지 않는다.
- **.env 위치 정책은 변경 없음**: 여전히 **각 프로젝트 폴더의 `./.env`** 로 로드 (통합 후 동일). 보안상 dist에 키 절대 저장 안 됨.

---

## 2. 기술적 사실 기반 (실제 소스 분석 결과)

### 2.1 도구 등록 구조 (`smol/src/tools/index.ts`)
- `buildToolSpecs(mode)` 함수가 read/write/exec 3개 배열로 도구를 정의.
- 각 툴은 `{ name, description, parameters }` 형태. **flat 파라미터** 강제 (작은 모델이 nested를 못 만듦).
  - 설명에는 반드시 예제 호출 포함 (small models imitate better than infer).
  - `mode === "ro"`이면 read만, 그 외는 `[...read, ...write, ...exec]` 전체.
- `executeTool(name, args, ctx, signal)`이 switch로 실행 분기.
- `commandOf(name, args)`가 exec 툴의 명령문 반환 (edit 모드 게이트용).

### 2.2 샌드박스 (명령 승인 로직) — `smol/src/sandbox.ts` + `agent.ts:659`
```typescript
const reason = commandEscapesWorkspace(command, this.toolCtx.workspace);
if (reason !== null && !isAutoApproved(command, this.alwaysAllowed)) { ... 승인 요청 ... }
```
- **상대경로**(`./scripts/x.js`) → `null`(바로 실행)
- **절대경로**(`/abs/...`) → "reaches outside the workspace" → edit 모드 승인 요청

### 2.3 `.env` 로드 방식 (`scripts/search.js`의 `loadDotEnv`)
```javascript
const content = readFileSync(join(process.cwd(), ".env"), "utf8");
if (!(key in process.env)) process.env[key] = value; // 이미 설정된 값은 유지 (우선순위)
```
- 실행 시 **실행 폴더의 `./.env`** 로드. 실제 export된 env 변수가 있으면 우선.

### 2.4 현재 Brave 검색 로직 (`scripts/search.js`)
- 엔드포인트: `https://api.search.brave.com/res/v1/web/search?q=&count=`
- 헤더: `Accept: application/json`, `X-Subscription-Token: process.env.BRAVE_API_KEY`
- 타임아웃: 10초 (AbortController)
- 출력 캡처: 3000자, 결과 최대 5개(옵션으로 1~8)

---

## 3. 구현 범위

### 3.1 신규 파일 (2개)
| 파일 | 역할 | 참고 |
|------|------|------|
| `smol/src/tools/web-search.ts` | Brave 검색 실행체 (.env 로드, fetch, 포맷팅) | `scripts/search.js` 로직 TS화 |
| `smol/src/tools/web-search.test.js`(옵션) | 단위 테스트 | 기존 test 스타일 참조 |

### 3.2 수정 파일 (1개)
| 파일 | 변경 내용 |
|------|----------|
| `smol/src/tools/index.ts` | import 추가 + read 배열에 `web_search` 툴 spec 등록 + executeTool switch case 추가 |

### 3.3 제거/보관
- `scripts/search.js`: 통합 후 **삭제 또는 보관**. (현재 동작 유지용 백업은 git history로 존재.)
- `.env`: 루트에 그대로 유지. dist에 절대 복사하지 않는다.

---

## 4. 상세 단계별 구현 계획

### 📌 단계 1 — 도구 실행체 작성 (`src/tools/web-search.ts`)
`scripts/search.js`의 핵심 로직을 TypeScript로 이전한다.

```typescript
// smol/src/tools/web-search.ts

const MAX_OUTPUT_CHARS = 3000;
const DEFAULT_MAX_RESULTS = 5;
const FETCH_TIMEOUT_MS = 10000;

export interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
}

/** .env 파일 로드 (실제 export된 env 변수는 우선). scripts/search.js의 loadDotEnv 재현 */
async function loadDotEnv(): Promise<void> { ... }

async function fetchWithTimeout(url: string, options = {}): Promise<Response> { ... 10s 타임아웃 ... }

export function formatWebSearchResults(results: WebSearchResult[]): string { ... }

export async function searchBrave(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY } });
  if (!res.ok) throw new Error(`Brave API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const items = (data.web && data.web.results) || [];
  return items.slice(0, maxResults).map((r) => ({ title: r.title, snippet: r.description, url: r.url }));
}

export function webSearch(query: string, maxResults?: number): Promise<string> {
  const limit = Math.max(1, Math.min(8, maxResults ?? DEFAULT_MAX_RESULTS));
  if (!process.env.BRAVE_API_KEY) return Promise.resolve("Error: Missing BRAVE_API_KEY environment variable.");
  return searchBrave(query, limit).then((results) => truncate(formatWebSearchResults(results), MAX_OUTPUT_CHARS)).catch((e) => `Error: ${e.message}`);
}
```

**주의사항:**
- smol은 CommonJS 출력 (`module: commonjs`) → `export async function`도 OK하나, import 시 주의.
- `.env` 로드에서 `process.cwd()` 기준 (smol이 프로젝트 루트 cwd로 실행됨).
- 에러 메시지는 에이전트가 이해하기 쉬운 형태로 반환.

### 📌 단계 2 — 툴 스펙 등록 (`index.ts`의 read 배열)
`read_file`, `list_files`, `search`(로컬) 다음에 `web_search`를 추가한다.
**description은 small-model 친화적으로**: flat 파라미터 + 예제 호출 포함.

```typescript
{
  name: "web_search",
  description:
    'Search the internet using Brave Search API (no local files). Example: {"query": "2026 Asian Games medal table"}. Max results 1-8 via {"query": "...", "maxResults": 3}. Requires BRAVE_API_KEY in .env. Returns numbered titles, snippets and URLs.',
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", description: "Max results (1-8, default 5)", default: 5 },
    },
    required: ["query"],
  },
}
```

**mode 조건 확인**: read 배열이 `ro` 모드에도 포함되므로, `web_search`는 ro 모드에서도 동작한다.
(원하지 않으면 read 배열 대신 write/exec 배열로 옮기거나 mode별 필터링 추가.)

### 📌 단계 3 — 실행 분기 추가 (`executeTool`)
switch에 case를 추가한다.

```typescript
case "web_search": {
  if (!args.query || typeof args.query !== "string") return 'Error: query is required. Example: {"query": "..."}';
  const maxResults = Number(args.maxResults) || DEFAULT_MAX_RESULTS;
  result = await webSearch(args.query, maxResults);
  break;
}
```

### 📌 단계 4 — 빌드 및 검증
```bash
cd smol
npm install            # 로컬 devDependencies (typescript 등)
npm run build          # tsc → dist/
node scripts/test.cjs  # 기존 테스트 통과 확인
```
- TypeScript 에러가 없어야 함.
- `.env`가 dist에 들어가지 않았는지 확인 (`grep BRAVE_API_KEY dist/`).

### 📌 단계 5 — 통합 후 동작 검증 (스탠드alone)
새 프로젝트 폴더(`test-project/`)를 만들어서:
```bash
node <dist/bin> --workspace test-project   # 또는 실제 실행 경로 확인
# web_search 툴이 show되는지, BRAVE_API_KEY 없이 에러가 맞는지도 확인
```

---

## 5. 보안 및 주의사항 (검토 완료)

| 항목 | 결론 |
|------|------|
| **dist에 키 주입됨?** | ❌ 안 됨. `npm run build`는 tsc만 → `.env` 내용 없음 |
| **.env 위치** | 각 프로젝트 폴더의 `./.env`. 통합 후 동일 유지 |
| **절대경로 실행 승인** | edit 모드에서 워크스페이스 바깥 절대경로는 여전히 승인 요청. 따라서 dist 경로도 상대경로로 참조 필요 |
| **bypass 모드** | `--mode bypass`면 승인 없이 실행 (비권장). |

---

## 6. 성공/실패 기준

### ✅ 완료 기준
1. `web_search` 툴이 `ro`/`edit`/`bypass` 모드에서 모두 등록됨.
2. BRAVE_API_KEY가 `.env`(루트)에 있으면 검색 결과 반환.
3. 키 없을 때 명시적 에러 메시지로 반환.
4. 기존 8개 도구 동작 유지 (regression 없음).
5. dist产物에 `.env`/키 값이 없음.

### ⚠️ 실패 시 대체책
- TypeScript 빌드 환경 문제 → `npm install` 후 재시도.
- `.env` 로드 경로는 smol의 실제 cwd가 프로젝트 루트인지 확인 필요 (실행 방식에 따라 조정).
- DuckDuckGo 등 무료 엔드포인트는 신뢰할 수 없으므로 **Brave 유지** (본 계획의 전제).

---

## 7. 다음 단계 (구현 시작 시)
1. `smol/src/tools/web-search.ts` 작성 (단계 1).
2. `index.ts` 수정 (단계 2, 3).
3. 빌드 + 검증 (단계 4, 5).
4. `scripts/search.js` 보관/삭제 결정.

---

*이 계획서는 구현 전 검토용입니다. 각 단계마다 빌드로 검증을 진행합니다.*
