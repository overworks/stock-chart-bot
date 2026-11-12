# Contributing

## 개요

`stock-chart-bot`은 Cloudflare Workers 엣지에서 동작하는 주가 차트 봇이다.
플랫폼에 독립적인 비즈니스 로직(`src/core`), 시세 제공자(`src/providers`), 메신저별 어댑터(`src/platforms`)를 분리해, 새로운 메신저나 데이터 소스를 추가하더라도 `core`를 수정하지 않는 구조를 지향한다.

## 개발 환경 및 명령

- **요구 사항**: Node.js 20.12 이상 (CI는 Node.js 22), Cloudflare Wrangler 인증 (`npx wrangler login`)
- **초기 설정**: `npm install` (`postinstall`에서 `wasm/resvg.wasm` 자동 복사) 후 `cp .dev.vars.example .dev.vars`로 로컬 시크릿을 설정한다. Cloudflare 리소스 생성 및 배포 절차는 [README.md](./README.md)를 참고한다.

| 명령 | 설명 |
|---|---|
| `npm run dev` | 로컬 개발 서버 실행 (`http://localhost:8787`) |
| `npm run typecheck` | TypeScript 타입 검사 (`tsc --noEmit`) |
| `npm test` | `workerd` 런타임에서 전체 테스트 실행 |
| `npm run test:watch` | 테스트 워치 모드 실행 |
| `npm run smoke -- "AAPL:1d,005930.KS:1m:candle"` | 실제 시세 조회 후 로컬 PNG 렌더링 확인 (`dist/smoke/`) |
| `npm run fetch:symbols` | KIND 상장법인 + 네이버 ETF/ETN + 업비트 + 수동 별칭을 합쳐 `scripts/symbols.json` 생성 |
| `npm run seed:symbols` | `scripts/symbols.json`을 원격 KV의 `symbols:v1` 키에 적재 |
| `npm run register` | `.dev.vars`(또는 환경변수)를 읽어 Discord 슬래시 커맨드 등록 |
| `npm run setup:wasm` | `@resvg/resvg-wasm`의 WASM 바이너리를 `wasm/resvg.wasm`으로 복사 |
| `npm run deploy` | 운영 환경 배포 |

## 검증

테스트는 `@cloudflare/vitest-plugin`을 통해 실제 Cloudflare Workers(`workerd`) 런타임 안에서 실행된다(`vitest.config.ts`). 외부 네트워크 호출은 `vi.stubGlobal("fetch", ...)`로 격리하며, `test/keypair.json`은 테스트 전용 Ed25519 키 쌍이다.

작업을 마무리하기 전에 다음 세 단계를 반드시 통과해야 한다.

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir dist
```

## 프로젝트 구조

```
src/
├─ index.ts              # 엔트리포인트: 라우팅 (/discord, /slack, /charts/*), 제공자 목록 조립, AliasWriter export
├─ env.d.ts              # Env 바인딩 및 *.wasm / *.ttf 모듈 타입 선언
├─ core/                 # 플랫폼 중립 코어 (플랫폼 SDK·providers·platforms import 금지)
│  ├─ types.ts           #   공통 데이터 타입 (ChartBar, ChartRequest, OutgoingMessage 등)
│  ├─ command.ts         #   커맨드 인자 검증 및 정규화
│  ├─ market.ts          #   MarketProvider 인터페이스, SymbolNotFoundError, 시세 조회·원격 검색 폴백
│  ├─ symbols.ts         #   종목 목록 로드(KV 캐시), 별칭 해석, 초성·부분 일치 검색
│  ├─ aliases.ts         #   /stock-alias 비즈니스 로직 (add, remove, list, 자동완성)
│  ├─ alias-writer.ts    #   별칭 변경 직렬화 및 KV 복제를 담당하는 SQLite Durable Object
│  ├─ display.ts         #   관행 단위 보정(JPYKRW=X → 100엔) 및 지수(^) 통화 단위 생략
│  ├─ chart.ts           #   차트 SVG 생성 및 등락률 요약
│  ├─ render.ts          #   resvg-wasm 기반 SVG → PNG 렌더링 (번들 서브셋 폰트 사용)
│  ├─ store.ts           #   R2 이미지 저장 및 /charts/<key> 서빙 (URL 전용 플랫폼용)
│  ├─ log.ts             #   구조화 로그 (logEvent, exceptionAttributes, errorMessage)
│  └─ run.ts             #   차트 생성 오케스트레이션 (runChart)
├─ providers/            # 데이터 소스 구현체 (외부 API 호출 전담, core만 import)
│  ├─ index.ts           #   createProviders: 우선순위 순서로 제공자 목록 조립
│  ├─ upbit.ts           #   업비트 원화 마켓 (KRW-*)
│  ├─ kis.ts             #   한국투자증권 Open API (.KS, .KQ, ^KS11, ^KQ11, ^KS200)
│  └─ yahoo.ts           #   Yahoo Finance 차트 및 영문 검색 폴백
└─ platforms/            # 메신저 플랫폼별 어댑터
   ├─ discord.ts         #   Ed25519 서명 검증, 자동완성, deferred 응답, multipart 파일 업로드
   ├─ slack.ts           #   HMAC-SHA256 서명 검증, 즉시 ack, R2 URL 기반 response_url 전송
   ├─ help.ts            #   /stock-help 공통 문구 및 플랫폼별 사용 예시
   └─ report.ts          #   결과 전송 및 명령 단위 로그(chart.command.done)
scripts/
├─ fetch-krx-symbols.ts  # KIND + 네이버 ETF/ETN + 업비트 + 수동 별칭 병합 스크립트
├─ symbols.manual.json   # 수동 관리 별칭 목록 (원본)
├─ symbols.json          # 생성된 전체 종목·별칭 시드 데이터 (직접 수정 금지)
├─ register-commands.ts  # Discord 슬래시 커맨드 등록 스크립트
└─ smoke.ts              # 로컬 차트 PNG 생성 확인 스크립트
```

## 아키텍처 및 내부 설계

### 1. 플랫폼 경계 (`core` vs `platforms`)

- `src/core/**`는 메신저 플랫폼 SDK나 전용 타입, `src/providers/**`, `src/platforms/**`를 절대 import하지 않는다.
- 서명 검증(반드시 파싱 전의 원본 문자열 `await req.text()` 사용), 플랫폼별 요청·응답 포맷 변환, 3초 이내 초기 응답(ack/deferred), 파일 첨부 또는 이미지 URL 전달은 `src/platforms/<platform>.ts`에서 처리한다.
- Discord 요청은 서명 시각이 현재 시각과 5분 이내일 때만 허용한다. 별칭 변경에는 interaction ID와 만료 시각을 전달해 DO에서 중복 변경을 차단한다. Slack 별칭 목록도 초기 응답 후 `response_url`로 실행자에게만 전송한다.
- `/stock-help`는 외부 호출이나 저장소 접근 없이 서명 검증 후 실행자에게만 즉시 응답한다(Discord `type: 4`, `flags: 64`; Slack `ephemeral`). Discord 본문은 2,000자 이내로 유지한다.
- 긴 Discord 별칭 목록은 어댑터에서 줄 단위로 나눠 각 메시지가 2,000자를 넘지 않도록 원본 응답과 후속 메시지로 전송한다.

### 2. 데이터 소스 (`src/providers/`)

`MarketProvider` 인터페이스(`src/core/market.ts`)를 구현한 모듈을 `src/providers/index.ts`의 `createProviders`가 `[upbit, kis, yahoo]` 순서로 조립한다. `src/index.ts`는 KIS 토큰 메모리 캐시가 유지되도록 동일 `env`에서 조립 결과를 재사용해 어댑터에 주입한다.

- **선택·폴백 및 에러 구분**: `getPrices`는 `supports(symbol)`가 참(또는 미정의)인 제공자를 순서대로 시도하며, 실패 시 다음 제공자로 넘어간다. 존재하지 않는 심볼은 `SymbolNotFoundError`를, 그 외 오류는 일반 `Error`를 던진다. `runChart`의 영문 검색 재시도는 `SymbolNotFoundError`에만 반응한다.
- **업비트 (`upbit.ts`)**: `KRW-*` 마켓만 전담한다. 24시간 거래 상품이므로 `continuous: true`(KST 표시)를 반환하며, 커스텀 날짜(`from`~`to`) 조회는 최대 2,000일까지 허용한다. `search`는 한글 질의나 `KRW-` 접두사일 때만 동작한다.
  - `max` 외의 기간은 요청 시각 기준 시간 범위로 제한하고, 페이지 조회도 시작 시각에 도달하면 멈춘다. 월 단위 기간은 30·90·180일, 연 단위 기간은 365·1,825일을 사용한다.
- **한국투자증권 (`kis.ts`)**: `KIS_APP_KEY`·`KIS_APP_SECRET`이 설정된 경우 `.KS`·`.KQ` 종목과 국내 지수(`^KS11`, `^KQ11`, `^KS200`)를 맡는다. 접근 토큰은 워커 메모리와 KV(`kis:token:v1`)에 캐시한다. 주식 `1d`는 KRX+NXT 통합(`UN`, 08:00~20:00) 시세를 먼저 조회하고 장중 봉이 부족하면 KRX 정규장(`J`, 09:00~15:30)으로 재조회하며, 개장 직후 등 당일 봉이 2개 미만이면 직전 거래일 세션을 사용한다.
- **Yahoo Finance (`yahoo.ts`)**: 모든 심볼을 지원하며 마지막 폴백과 영문 원격 검색(`/v1/finance/search`)을 담당한다. `1d`는 `includePrePost=true`로 미국 주식의 시간외 봉을 포함하며, 새 거래일 직후 당일 봉이 부족하면 5일 데이터에서 마지막 세션을 잘라 쓴다.
- **단위 보정 (`display.ts`)**: `JPYKRW=X`는 100엔 기준으로 배율(`×100`)과 라벨을 적용하고(`displayRule`), 지수(`^` 접두사)는 통화 단위를 표시하지 않는다(`displayCurrency`).

### 3. 종목 목록과 검색 (`src/core/symbols.ts`)

- **시드 및 캐시**: `scripts/fetch-krx-symbols.ts`가 KIND 상장법인(KOSPI·KOSDAQ), 네이버 금융 ETF·ETN, 업비트 원화 마켓, 수동 별칭(`scripts/symbols.manual.json`)을 병합해 `scripts/symbols.json`을 생성한다(영문 혼합 6자리 종목코드 포함). 시드 데이터는 KV 단일 키 `symbols:v1`에 저장하고 워커 메모리에 10분간 캐시하며, 무료 플랜 한도 보호를 위해 KV `list`는 사용하지 않는다.
- **정식명과 별칭**: 심볼당 정식명(`alias`가 없는 항목)은 하나뿐이며(KRX·업비트 등록명 우선, 없으면 수동 목록 첫 항목), 나머지는 `alias: true`로 표시된다. 자동완성 목록과 차트 제목에는 항상 정식명을 사용한다.
- **검색**: 공백·대소문자를 무시한 **정확 일치 → 접두사 일치 → 부분 일치** 순으로 정렬하며 한글 초성 검색도 지원한다. 결과가 25개 미만이고 2자 이상의 ASCII 질의면 원격 검색(`searchRemote`)으로 보충한다.

### 4. 사용자 별칭과 동시성 제어 (`src/core/aliases.ts`, `src/core/alias-writer.ts`)

- 채팅에서 `/stock-alias`로 추가한 별칭은 KV의 `aliases:v1`에 저장되며 `loadSymbols`가 시드 목록 뒤에 합친다.
- 별칭 대상은 정확히 일치하는 등록명을 먼저 확인하고, 영문 입력은 직접 시세 조회를 우선한다. 없는 심볼일 때만 부분 이름 검색으로 폴백하며, 시세 제공자 장애를 다른 종목으로 대체하지 않는다.
- 별칭 추가·삭제는 단일 인스턴스 SQLite Durable Object인 `AliasWriter`(`ALIAS_WRITER` 바인딩)를 통해 직렬화한다. DO 내부 스토리지를 원본(source of truth)으로 삼고, KV 동일 키 쓰기 제한(초당 1회)을 준수하기 위해 최소 1.1초 간격으로 `aliases:v1`에 복제하며 실패 시 DO Alarm으로 재시도한다. 외부에서 `KV.put`으로 `aliases:v1`을 직접 수정하지 않는다.

- 중복 방지 키가 주어진 변경은 처리 기록과 별칭을 같은 트랜잭션에 저장한다. 기록은 DO 재시작 후에도 유지하며 만료되면 알람으로 정리한다. KV 복제 실패의 재시도와 기록 정리를 같은 알람에서 구분한다.

### 5. 렌더링 및 이미지 전달 (`chart.ts`, `render.ts`, `store.ts`)

- **SVG 및 WASM 렌더링**: `chart.ts`가 SVG를 생성하고 `render.ts`가 `@resvg/resvg-wasm`으로 PNG를 렌더링한다. 서브셋 폰트 `fonts/NanumSquare{R,B}.ttf`를 번들하며, 굵은 글씨는 `font-family`(`FONT_BOLD = "NanumSquare Bold"`)로 지정한다. `Resvg` 인스턴스와 `RenderedImage`는 GC 대상이 아니므로 반드시 `try ... finally`에서 `free()`를 호출한다.
- **시간외 구간 음영**: `PriceSeries.regularHours`가 주어지면 `extendedRuns`가 정규장 밖의 연속된 봉 구간에 회색 음영과 `프리마켓`·`애프터마켓` 라벨을 넣는다.
- **제목과 기간**: `buildSvg`에 제목과 `period`를 나눠 전달한다. 날짜 지정 기간은 헤더 아래 별도 줄에 표시하고, 제목은 심볼 접미사가 길어도 현재가 영역을 넘지 않도록 말줄임한다.
- **이미지 전달**: Discord는 PNG 바이트를 multipart 응답으로 직접 첨부하고, Slack은 `storeChart`로 R2에 저장한 뒤 `${origin}/charts/<key>` URL을 전달한다.

### 6. 관측 (`log.ts`, `platforms/report.ts`, `run.ts`)

Workers Logs와 Traces가 활성화되어 있으며, `logEvent(level, name, attributes)`로 JSON 한 줄을 남긴다(사용자 ID·토큰·웹훅 URL 제외). 이벤트 이름(`message`)과 속성 키는 [OpenTelemetry 시맨틱 컨벤션](https://opentelemetry.io/docs/specs/semconv/)을 따른다(점 구분 소문자 `snake_case`, 표준 속성 `error.type`·`exception.*`·`http.response.status_code` 우선, 앱 고유 속성은 `chart.*`).

| `message` | 레벨 | 주요 속성 | 시점 |
|---|---|---|---|
| `chart.command.done` | log / warn / error | `chart.platform`, `chart.command.name`, `chart.command.action`, `chart.command.outcome`(`ok`·`failed`·`delivery_failed`), `chart.duration_ms`, `http.response.status_code`, `exception.*`, `chart.command.delivery_detail`, `chart.command.fallback`(`sent`·`failed`) | 명령 처리 및 결과 전송 완료 시 |
| `chart.served` | log | `chart.ticker`, `chart.symbol`, `chart.range`, `chart.source`, `chart.bars`, `chart.last_bar`, `chart.resolved`(`direct`·`alias`·`search`), `chart.duration_ms`, `chart.image.size` | 차트 생성 성공 |
| `chart.failed` | warn / error | `error.type`(`invalid_args`·`not_found`·`upstream`), `chart.ticker`, `chart.symbol`, `chart.range`, `chart.from`, `chart.to`, `exception.*`, `chart.duration_ms` | 차트 생성 실패 (`upstream`만 error) |
| `chart.provider.failed` | warn | `chart.provider.name`, `chart.symbol`, `chart.range`, `error.type`(`not_found`·`upstream`), `exception.*` | 제공자 실패 후 다음 제공자로 폴백할 때 |
| `chart.search.failed` | warn | `chart.provider.name`, `http.response.status_code` 또는 `exception.*` | 원격 종목 검색 실패 |
| `chart.session.fallback`, `chart.market.fallback` | log | `chart.provider.name`, `chart.symbol`/`chart.kis.code`, `chart.bars`, `chart.session.date`, `chart.session.ok` | `1d`에서 직전 세션이나 KRX 정규장 시세로 폴백할 때 |
| `chart.kis.token.issued`, `chart.kis.token.cache_failed`, `chart.kis.rate_limited` | log / warn / warn | `chart.kis.token.ttl` · `chart.kis.token.cache_operation`(`get`·`put`), `exception.*` · `chart.kis.tr_id`, `chart.kis.attempt` | KIS 토큰 발급, KV 캐시 실패, 호출 한도 재시도 |
| `chart.symbols.missing` | error | `chart.symbols.key` | KV `symbols:v1`이 비어 있을 때 |
| `chart.alias.changed`, `chart.alias.denied` | log / warn | `chart.alias.action`, `chart.alias.name`, `chart.symbol` · `chart.platform`, `chart.alias.action` | 별칭 추가·삭제 성공, 권한 없는 변경 시도 |
| `chart.alias.publish_deferred`, `chart.alias.publish_failed` | warn / error | `exception.*` | 별칭 KV 복제 지연 또는 알람 재시도 실패 |

- **커스텀 스팬**: `run.ts`가 `cloudflare:workers`의 `tracing.enterSpan`으로 `chart` 아래에 `chart.resolve`, `chart.prices`, `chart.render` 스팬을 기록한다. `scripts/smoke.ts`가 Node에서 `src/core/market.ts`와 `src/providers/*`를 직접 불러오므로 이 파일들에는 `cloudflare:workers`를 import하지 않는다.
- **자동완성**: 입력마다 호출되므로 성공 경로에는 로그를 남기지 않는다.

## 확장 가이드

### 새 메신저 플랫폼 추가

1. `src/platforms/<name>.ts`에 어댑터를 작성한다(원본 본문 서명 검증 → 인자 파싱 → `runChart` / `runAlias` 호출 → 응답 전송). 결과 전송은 `reportCommand`로 감싼다.
2. `src/index.ts`에 라우트를 추가한다(`src/core/**`는 수정하지 않는다).

### 새 데이터 소스 추가

1. `src/providers/<name>.ts`에 `MarketProvider` 인터페이스를 구현한다(`core`의 타입과 `log`만 import). 특정 심볼만 담당하면 `supports(symbol)`를 구현하고, 없는 심볼은 `SymbolNotFoundError`를 던진다.
2. `src/providers/index.ts`의 `createProviders`에 우선순위에 맞게 추가하고 `test/`에 단위 테스트를 작성한다.

## 코딩 컨벤션 및 보안

- **스타일 및 타입**: TypeScript `strict` 모드와 2칸 들여쓰기를 사용한다. 주석은 코드만으로 파악하기 어려운 배경 지식이나 제약 조건에만 간결하게 남기며, 사용자 노출 메시지는 한국어로 작성한다.
- **시크릿 및 생성물**: 시크릿은 `.dev.vars`(로컬), `wrangler secret`(운영), GitHub Actions Secrets(CI)만 사용하며 코드·설정·로그에 노출하지 않는다. 생성물(`node_modules/`, `dist/`, `.dev.vars`, `wasm/*.wasm`)은 커밋하지 않는다.
