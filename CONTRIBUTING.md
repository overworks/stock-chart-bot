# Contributing

## 개요

`stock-chart-bot`은 Cloudflare Workers 엣지에서 동작하는 주가 차트 봇이다.
플랫폼에 독립적인 비즈니스 로직(`src/core`)과 메신저별 어댑터(`src/platforms`)를 엄격히 분리해, 새로운 메신저 플랫폼을 추가하더라도 `core`를 수정하지 않는 구조를 지향한다.

## 요구 사항

- Node.js 20.12 이상 (CI 환경은 Node.js 22 사용)
- npm
- Cloudflare 계정 및 Wrangler 인증 (`npx wrangler login`)

## 로컬 환경 설정

```bash
npm install                                # postinstall에서 wasm/resvg.wasm 자동 복사
npx wrangler kv namespace create stock-chart-bot --binding KV
npx wrangler r2 bucket create stock-chart-bot-charts
cp .dev.vars.example .dev.vars             # 로컬 개발용 시크릿 입력
```

새로운 Cloudflare 계정에 배포할 때는 `wrangler.jsonc`의 `DISCORD_APPLICATION_ID`와 KV 네임스페이스 `id`를 해당 계정의 값으로 교체한다.

## 개발 워크플로

| 명령 | 설명 |
|---|---|
| `npm run dev` | 로컬 개발 서버 실행 (`http://localhost:8787`) |
| `npm run typecheck` | TypeScript 타입 검사 (`tsc --noEmit`) |
| `npm test` | `workerd` 런타임에서 전체 테스트 실행 |
| `npm run test:watch` | 테스트 워치 모드 실행 |
| `npm run smoke -- "AAPL:1d,005930.KS:1m:candle"` | 실제 시세 조회 후 로컬 PNG 렌더링 결과 확인 (`dist/smoke/`) |
| `npm run fetch:symbols` | KIND 상장법인 + 네이버 ETF/ETN + 업비트 + 수동 별칭을 합쳐 `scripts/symbols.json` 생성 |
| `npm run seed:symbols` | `scripts/symbols.json`을 원격 KV의 `symbols:v1` 키에 적재 |
| `npm run register` | `.dev.vars`(또는 환경변수)를 읽어 Discord 슬래시 커맨드 등록 |
| `npm run setup:wasm` | `@resvg/resvg-wasm`의 WASM 바이너리를 `wasm/resvg.wasm`으로 복사 |
| `npm run deploy` | 운영 환경 배포 |

## 검증

테스트는 `@cloudflare/vitest-plugin`을 통해 실제 Cloudflare Workers(`workerd`) 런타임 안에서 실행된다(`vitest.config.ts`).
코어 모듈 단위 테스트부터 어댑터 통합 테스트(`test/discord.test.ts`, `test/slack.test.ts`)까지 서명 검증, PNG 렌더링, 응답 전송 전 구간을 검증한다.
외부 네트워크 호출(Yahoo Finance, 업비트, 한국투자증권, Discord/Slack 웹훅 등)은 `vi.stubGlobal("fetch", ...)`로 격리하며, `test/keypair.json`은 테스트 전용 Ed25519 키 쌍이다.

PR을 올리거나 작업을 마무리하기 전에 다음 세 단계를 반드시 통과해야 한다.

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir dist
```

## 프로젝트 구조

```
src/
├─ index.ts              # 엔트리포인트: 라우팅 (/discord, /slack, /charts/*) 및 AliasWriter export
├─ env.d.ts              # Env 바인딩 및 *.wasm / *.ttf 모듈 타입 선언
├─ core/                 # 플랫폼 중립 코어 (플랫폼 SDK import 금지)
│  ├─ types.ts           #   공통 데이터 타입 (ChartBar, ChartRequest, OutgoingMessage 등)
│  ├─ command.ts         #   커맨드 인자 검증 및 정규화
│  ├─ market.ts          #   시세 조회·원격 검색 파사드 (PROVIDERS 순서대로 폴백)
│  ├─ providers/         #   데이터 소스 구현체 (외부 API 호출은 이 디렉터리에만 작성)
│  │  ├─ types.ts        #     MarketProvider 인터페이스 및 SymbolNotFoundError
│  │  ├─ upbit.ts        #     업비트 원화 마켓 (KRW-*)
│  │  ├─ kis.ts          #     한국투자증권 Open API (.KS, .KQ)
│  │  └─ yahoo.ts        #     Yahoo Finance 차트 및 영문 검색 폴백
│  ├─ symbols.ts         #   종목 목록 로드(KV 캐시), 별칭 해석, 초성·부분 일치 검색
│  ├─ aliases.ts         #   /stock-alias 비즈니스 로직 (add, remove, list, 자동완성)
│  ├─ alias-writer.ts    #   별칭 변경 직렬화 및 KV 복제를 담당하는 SQLite Durable Object
│  ├─ display.ts         #   관행 단위가 다른 심볼(JPYKRW=X → 100엔) 시세 배율·라벨 보정
│  ├─ chart.ts           #   차트 SVG 생성 및 등락률 요약
│  ├─ render.ts          #   resvg-wasm 기반 SVG → PNG 렌더링 (번들 서브셋 폰트 사용)
│  ├─ store.ts           #   R2 이미지 저장 및 /charts/<key> 서빙 (URL 전용 플랫폼용)
│  └─ run.ts             #   차트 생성 오케스트레이션 (runChart)
└─ platforms/            # 메신저 플랫폼별 어댑터
   ├─ discord.ts         #   Ed25519 서명 검증, 자동완성, deferred 응답, multipart 파일 업로드
   └─ slack.ts           #   HMAC-SHA256 서명 검증, 즉시 ack, R2 URL 기반 response_url 전송
scripts/
├─ fetch-krx-symbols.ts  # KIND + 네이버 ETF/ETN + 업비트 + 수동 별칭 병합 스크립트
├─ symbols.manual.json   # 수동 관리 별칭 목록 (원본)
├─ symbols.json          # 생성된 전체 종목·별칭 시드 데이터 (직접 수정 금지)
├─ register-commands.ts  # Discord 슬래시 커맨드 등록 스크립트
└─ smoke.ts              # 로컬 차트 PNG 생성 확인 스크립트
```

## 아키텍처 및 내부 설계

### 1. 플랫폼 경계 (`core` vs `platforms`)

- `src/core/**`는 **어떠한 메신저 플랫폼 SDK나 전용 타입도 import하지 않는다.**
- 인자 검증, 종목 검색, 시세 조회, 차트 SVG 생성, PNG 렌더링 등 플랫폼과 무관한 로직은 모두 `core`에 둔다.
- 서명 검증, 플랫폼별 요청/응답 포맷 변환, 3초 이내 초기 응답(ack/deferred), 파일 첨부 또는 이미지 URL 전달은 `src/platforms/<platform>.ts`에서 처리한다.
- 서명 검증은 반드시 파싱 전의 **원본 요청 문자열(`await req.text()`)**로 수행한다.

### 2. 데이터 소스 (`src/core/providers/`)

`MarketProvider` 인터페이스를 구현한 모듈을 `src/core/providers/`에 두고 `market.ts`의 `PROVIDERS` 배열(`[upbit, kis, yahoo]`)에 등록한다.

- **제공자 선택 및 폴백**: `supports(symbol)`가 정의된 제공자는 해당 조건이 참인 심볼만 처리한다. `getPrices`는 심볼을 지원하는 제공자를 순서대로 시도하며, 오류가 발생하면 다음 제공자로 폴백하고 모두 실패하면 첫 번째 오류를 던진다.
- **에러 구분**: 존재하지 않는 심볼은 `SymbolNotFoundError`를 던지고, 그 외 오류(네트워크·HTTP 오류, 데이터 부족, 파싱 실패 등)는 일반 `Error`를 던진다. `runChart`의 영문 검색 재시도는 `SymbolNotFoundError`에만 반응한다.
- **원격 검색 (`search`)**: 자동완성 입력마다 호출되므로 영문 질의에 불필요한 네트워크 호출을 늘리지 않는 것이 원칙이다.
- **제공자별 특징**:
  - **업비트 (`upbit.ts`)**: `KRW-*` 마켓만 전담한다. 24시간 거래 상품이므로 `continuous: true`를 반환해 차트 시각을 KST로 표시한다. 직접 날짜 지정(`from`~`to`) 조회는 시작일과 종료일을 포함해 최대 2,000일까지 허용하며, 초과 시 데이터를 임의로 자르지 않고 한국어 오류 메시지로 안내한다. `search`는 한글 질의나 `KRW-` 접두사일 때만 동작한다.
  - **한국투자증권 (`kis.ts`)**: `KIS_APP_KEY`와 `KIS_APP_SECRET`이 설정된 경우 `.KS`/`.KQ` 종목을 맡고, 실패하면 Yahoo로 폴백한다. 접근 토큰(유효기간 24시간, 발급 제한 1분당 1회)은 워커 메모리와 KV(`kis:token:v1`)에 캐시해 재사용한다. 분봉은 1분봉 데이터를 조회해 `1d`(5분봉)·`1w`(30분봉)로 집계한다. `1d`는 KRX+NXT 통합(`UN`, 08:00~20:00) 시세를 먼저 조회하고, 장중 봉이 없는 종목(ETF·ETN 등)은 KRX 정규장(`J`, 09:00~15:30)으로 재조회한다. `1w`는 KRX 정규장만 사용한다.
  - **Yahoo Finance (`yahoo.ts`)**: 모든 심볼을 지원하며 체인의 마지막 폴백 역할을 한다. 영문 자동완성 보충 및 미등록 영문 티커 검색(`/v1/finance/search`)을 담당한다. `1d`는 `includePrePost=true`로 미국 주식의 프리마켓·애프터마켓 봉을 포함한다(그 외 시장은 응답이 같다). 정규장 전 프리마켓에는 오늘 봉만 오는데 `chartPreviousClose`가 하루 전 기준으로 남아 있으므로, 마지막 봉 날짜가 `regularMarketTime`보다 늦으면 `regularMarketPrice`(직전 정규장 종가)를 전일 종가로 쓴다. `1w`는 정규장만 사용한다.
- **단위 보정 (`display.ts`)**: `JPYKRW=X`(원/엔 환율)처럼 관행적으로 100단위 시세를 쓰는 심볼은 `displayRule`에 정의해 가격에 배율(`×100`)을 곱하고 제목에 단위 라벨(`100엔`)을 붙인다.

### 3. 종목 목록과 검색 (`src/core/symbols.ts`)

- **시드 구성**: `scripts/fetch-krx-symbols.ts`가 KIND 상장법인(KOSPI·KOSDAQ), 네이버 금융 ETF·ETN(`etfItemList.nhn`·`etnItemList.nhn`, EUC-KR), 업비트 원화 마켓, 수동 별칭(`scripts/symbols.manual.json`)을 합쳐 약 4,500개 항목(약 310KB)의 `scripts/symbols.json`을 생성한다. 2025년부터 도입된 영문 혼합 6자리 종목코드(`0167A0` 등)도 그대로 처리한다.
- **KV 단일 키 및 메모리 캐시**: 시드 데이터는 KV(`KV` 바인딩)의 단일 키 `symbols:v1`에 JSON 배열로 저장한다. 워커는 이를 읽어 10분간 메모리에 캐시하며, 무료 플랜 한도(일 1,000회) 보호를 위해 KV `list` 연산은 사용하지 않는다.
- **정식명과 별칭**: 각 항목은 `{ key, value, alias? }` 형태다. 심볼당 정식명(`alias`가 없는 항목)은 하나뿐이며(KRX·업비트 등록명 우선, 없으면 수동 목록의 첫 항목), 나머지는 `alias: true`로 표시된다. 별칭은 검색과 `resolveSymbol` 해석에만 쓰이고, 자동완성 목록과 차트 제목에는 항상 `byValue`의 정식명을 사용한다.
- **검색 우선순위**: 공백과 대소문자를 무시한 **정확 일치 → 접두사 일치 → 부분 일치** 순으로 정렬하며, 한글 초성 검색(`ㅅㅅㅈㅈ`, `삼ㅈ`)도 정규식 음절 범위 변환으로 지원한다. 결과가 25개 미만이고 입력이 2자 이상의 ASCII 문자열이면 원격 검색(`searchRemote`) 결과로 보충한다.

### 4. 사용자 별칭과 동시성 제어 (`src/core/aliases.ts`, `src/core/alias-writer.ts`)

- 채팅에서 `/stock-alias`로 추가한 별칭은 KV의 `aliases:v1` 키에 따로 저장된다. `loadSymbols`가 시드 목록(`symbols:v1`) 뒤에 합치므로 주간 시드 갱신에 덮어써지지 않는다.
- 별칭 추가·삭제는 단일 인스턴스 SQLite Durable Object인 `AliasWriter`(`ALIAS_WRITER` 바인딩)를 통해 직렬화한다.
  - 최초 변경 시 KV의 `aliases:v1` 데이터를 가져와 초기화하고, 이후에는 Durable Object 내부 스토리지를 원본(source of truth)으로 삼는다.
  - KV의 `aliases:v1`은 검색용 복제본이므로 외부에서 직접 `KV.put`으로 수정하지 않는다.
  - KV 동일 키 쓰기 제한(초당 1회)을 준수하기 위해 최소 1.1초 간격을 두어 반영하며, 일시적 오류 시 Durable Object Alarm으로 재시도한다.
  - KV 전파 지연과 워커의 10분 메모리 캐시로 인해 다른 워커 인스턴스에는 반영이 최대 수 분 늦어질 수 있다.

### 5. 렌더링 및 이미지 전달 (`chart.ts`, `render.ts`, `store.ts`)

- **SVG 생성 및 WASM 렌더링**: `chart.ts`가 차트 SVG 문자열을 생성하고, `render.ts`가 `@resvg/resvg-wasm`으로 PNG 바이트를 렌더링한다. Workers 환경에는 시스템 폰트가 없으므로 서브셋 폰트인 `fonts/NanumSquare{R,B}.ttf`를 번들해 사용한다. `wasm/resvg.wasm`은 `postinstall`(`npm run setup:wasm`)에서 생성되는 산출물이므로 커밋하지 않는다.
- **WASM 메모리 해제**: `Resvg` 인스턴스와 `render()` 결과(`RenderedImage`)는 JavaScript GC가 자동으로 해제하지 않으므로, 반드시 `try ... finally` 블록에서 `free()`를 호출해야 한다.
- **이미지 전달 방식**:
  - 파일 업로드를 지원하는 플랫폼(Discord)은 `runChart`가 반환한 PNG 바이트를 multipart 응답으로 직접 첨부한다.
  - 이미지 URL만 지원하는 플랫폼(Slack 등)은 `store.ts`의 `storeChart`로 R2 버킷에 저장한 뒤 `${origin}/charts/<key>` URL을 전달한다. `/charts/*` 라우트가 R2에서 이미지를 서빙하며, R2 버킷 수명 주기 규칙에 따라 7일 후 자동 삭제된다.

## 확장 가이드

### 새 메신저 플랫폼 추가

1. `src/platforms/<name>.ts`에 어댑터를 작성한다(원본 본문 서명 검증 → 커맨드 인자 파싱 → `runChart` / `runAlias` 호출 → 플랫폼 포맷에 맞게 응답 전송).
2. `src/index.ts`에 라우트를 추가한다.
3. `src/core/**`는 수정하지 않는다. 만약 `core` 수정이 필요하다면 플랫폼 종속 개념이 새어 들어가고 있지 않은지 먼저 점검한다.

### 새 데이터 소스 추가

1. `src/core/providers/<name>.ts`에 `MarketProvider` 인터페이스를 구현한다.
2. 특정 심볼 형식만 담당한다면 `supports(symbol)` 메서드를 구현하고, 없는 심볼 조회 시에는 `SymbolNotFoundError`를 던진다.
3. `src/core/market.ts`의 `PROVIDERS` 배열에서 우선순위에 맞는 위치에 추가하고 `test/`에 단위 테스트를 작성한다.

## 코딩 컨벤션 및 보안

- **TypeScript**: `strict` 모드를 유지한다. `any` 타입은 외부 비정형 JSON 응답 파싱 등 불가피한 곳에만 제한적으로 허용한다.
- **코드 스타일**: 들여쓰기는 2칸(2 spaces)을 사용한다. 주석은 코드만으로 의도를 파악하기 어려운 배경 지식이나 제약 조건에만 간결하게 남긴다.
- **메시지 언어**: 사용자에게 노출되는 안내·오류 메시지는 자연스러운 한국어로 작성한다.
- **시크릿 관리**:
  - 로컬 개발: `.dev.vars` (커밋 금지, `.gitignore`에 등록됨)
  - 운영 환경: `npx wrangler secret put <NAME>`
  - CI 환경: GitHub Actions Secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
  - 소스 코드, `wrangler.jsonc`, 콘솔 로그에 시크릿을 절대 노출하지 않는다.

## 커밋 및 버전 관리

- **브랜치 및 커밋**: 기본 브랜치는 `main`이며 PR을 통한 병합을 권장한다. 커밋 메시지는 변경 이유를 중심으로 간결하게 작성하고, 생성물(`node_modules/`, `dist/`, `.dev.vars`, `wasm/*.wasm`)은 커밋하지 않는다.
- **버전 관리 및 롤백**: 엣지 워커 엔드포인트는 클라이언트가 버전을 선택해 호출하지 않으므로 별도의 SemVer 경로(`/v1` 등)를 두지 않는다(`package.json`의 `version`은 내부 메타데이터로만 유지). 배포 버전 관리는 Cloudflare Workers의 불변 버전 및 롤백 기능을 사용한다.

```bash
npx wrangler versions upload                                       # 새 버전 업로드 (미배포)
npx wrangler versions deploy --version-id <id> --percentage 90 ... # 점진 배포
npx wrangler deployments status                                    # 현재 배포 상태 확인
npx wrangler rollback [version-id]                                 # 이전 버전으로 즉시 롤백
```
