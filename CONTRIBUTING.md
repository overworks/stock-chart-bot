# Contributing

## 개요

`stock-chart-bot`은 Cloudflare Workers 엣지에서 동작하는 주가 차트 봇이다.
플랫폼에 독립적인 비즈니스 로직(`src/core`), 시세 제공자(`src/providers`), 메신저별 어댑터(`src/platforms`)를 분리해, 새로운 메신저나 데이터 소스를 추가하더라도 `core`를 수정하지 않는 구조를 지향한다.

## 개발 환경 및 명령

- **요구 사항**: Node.js 20.12 이상 (CI는 Node.js 22), Cloudflare Wrangler 인증 (`npx wrangler login`)
- **초기 설정**: `npm install` (`postinstall`에서 `wasm/resvg.wasm` 자동 복사) 후 `cp cloudflare/wrangler.jsonc.example cloudflare/wrangler.jsonc`로 로컬 설정을 만들고, `cp cloudflare/.dev.vars.example cloudflare/.dev.vars`로 로컬 시크릿을 설정한다. 예시 설정 그대로 로컬 테스트와 빌드 검증이 가능하며, 실제 배포·원격 KV 적재 전에는 본인의 리소스 값을 입력한다. Cloudflare 리소스 생성 및 기존 루트 설정의 이동 절차는 [README.md](./README.md)를 참고한다.

| 명령 | 설명 |
|---|---|
| `npm run dev` | 로컬 개발 서버 실행 (`http://localhost:8787`) |
| `npm run typecheck` | TypeScript 타입 검사 (`tsc --noEmit`) |
| `npm test` | `workerd` 런타임에서 전체 테스트 실행 |
| `npm run test:watch` | 테스트 워치 모드 실행 |
| `npm run smoke -- "AAPL:1d,005930.KS:1m:candle"` | 실제 시세 조회 후 로컬 PNG 렌더링 확인 (`dist/smoke/`) |
| `npm run fetch:symbols` | KIND 상장법인 + 네이버 ETF/ETN + 업비트 + 수동 별칭을 합쳐 `scripts/symbols.json` 생성 |
| `npm run seed:symbols` | `scripts/symbols.json`을 원격 KV의 `symbols:v1` 키에 적재 |
| `npm run register` | `cloudflare/.dev.vars`(또는 환경변수)를 읽어 Discord 슬래시 커맨드 등록 |
| `npm run setup:wasm` | `@resvg/resvg-wasm`의 WASM 바이너리를 `wasm/resvg.wasm`으로 복사 |
| `npm run deploy` | 운영 환경 배포 |
| `npm run build:cloudflare` | 예시 또는 로컬 설정으로 배포 dry-run (`dist/`) |

`dev`, `deploy`, `test`, `register`, `seed:symbols`는 각각 같은 이름의 `:cloudflare` 명령을 호출한다. 추가 인자는 `npm run dev -- --port 8788`처럼 전달한다. `dev:cloudflare`는 로컬 저장소 경로를 루트 `.wrangler/state`로 지정한다. 커맨드 등록 스크립트는 `--vars-file <경로>`로 파일을 선택하며, 옵션이 없거나 파일이 없으면 환경변수만 사용한다.

## 검증

테스트는 `@cloudflare/vitest-plugin`을 통해 실제 Cloudflare Workers(`workerd`) 런타임 안에서 실행된다(`cloudflare/vitest.config.ts`). 설정에서 테스트 루트를 저장소 루트로 고정하고, Wrangler 설정은 `cloudflare/wrangler.jsonc`의 절대 경로로 지정한다. 외부 네트워크 호출은 `vi.stubGlobal("fetch", ...)`로 격리하며, `test/keypair.json`은 테스트 전용 Ed25519 키 쌍이다.

작업을 마무리하기 전에 다음 세 단계를 반드시 통과해야 한다.

```bash
npm run typecheck
npm test
npm run build:cloudflare
```

## 프로젝트 구조

```
cloudflare/
├─ index.ts              # Workers 진입점, 설정·의존성 조립, AliasWriter export
├─ env.d.ts              # 명시적으로 import하는 Workers 바인딩 타입
├─ assets.ts             # Wrangler 바이너리 import 및 지연 초기화 렌더러
├─ modules.d.ts          # WASM·TTF import 선언
├─ images.ts             # R2 이미지 공개 및 /charts/ 서빙
├─ tracing.ts            # Cloudflare tracing 어댑터
├─ http.ts               # MarketFetch 캐시 힌트를 Cloudflare 옵션으로 변환
├─ storage.ts            # SymbolStore·TokenCache의 KV/DO 어댑터, KV 키 정의
├─ alias-writer.ts       # 별칭 변경 직렬화·중복 방지 및 KV 복제 Durable Object
├─ wrangler.jsonc.example # Cloudflare 리소스·번들 설정 예시 (실제 wrangler.jsonc는 Git 제외)
├─ .dev.vars.example     # 로컬 시크릿 예시 (실제 .dev.vars는 Git 제외)
└─ vitest.config.ts      # workerd 테스트 설정
src/
├─ app.ts                # 공통 라우팅과 설정·기능 주입
├─ config.ts             # BotConfig (메신저 설정)
├─ core/                 # 플랫폼 중립 코어 (플랫폼 SDK·providers·platforms import 금지)
│  ├─ types.ts           #   공통 데이터 타입 (ChartBar, ChartRequest, OutgoingMessage 등)
│  ├─ command.ts         #   커맨드 인자 검증 및 정규화
│  ├─ market.ts          #   MarketProvider 인터페이스, SymbolNotFoundError, 시세 조회·원격 검색 폴백
│  ├─ http.ts            #   MarketFetch 전송 계약 (표준 옵션 + 캐시 시간 힌트)
│  ├─ storage.ts         #   SymbolReader·SymbolStore·TokenCache 및 공통 저장 타입
│  ├─ symbols.ts         #   저장소별 종목 캐시, 별칭 해석, 초성·부분 일치 검색
│  ├─ aliases.ts         #   /stock-alias 비즈니스 로직 (add, remove, list, 자동완성)
│  ├─ display.ts         #   관행 단위 보정(JPYKRW=X → 100엔) 및 지수(^) 통화 단위 생략
│  ├─ chart.ts           #   차트 SVG 생성 및 등락률 요약
│  ├─ runtime.ts         #   렌더러·tracer·백그라운드·이미지 공개 계약
│  ├─ log.ts             #   구조화 로그 (logEvent, exceptionAttributes, errorMessage)
│  └─ run.ts             #   차트 생성 오케스트레이션 (runChart)
├─ rendering/resvg.ts    # 자산을 주입받는 공통 SVG → PNG 렌더러
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

- `src/core/**`는 메신저 플랫폼 SDK나 전용 타입, `src/providers/**`, `src/platforms/**`를 절대 import하지 않는다. `src/core/**`와 `src/platforms/**`는 Cloudflare 바인딩·런타임 타입에도 의존하지 않는다.
- `src/app.ts`의 `createApp(BotConfig, BotServices)`가 공통 라우터를 만든다. `cloudflare/index.ts`가 설정을 변환하고 제공자·저장소·렌더러·이미지 공개·tracer를 조립한다. 요청별 `BackgroundTasks`는 `ctx.waitUntil`을 메서드로 호출하는 래퍼로 연결한다.
- 서명 검증(반드시 파싱 전의 원본 문자열 `await req.text()` 사용), 플랫폼별 요청·응답 포맷 변환, 3초 이내 초기 응답(ack/deferred), 파일 첨부 또는 이미지 URL 전달은 `src/platforms/<platform>.ts`에서 처리한다.
- Discord 요청은 서명 시각이 현재 시각과 5분 이내일 때만 허용한다. 별칭 변경에는 interaction ID와 만료 시각을 전달해 DO에서 중복 변경을 차단한다. Slack 별칭 목록도 초기 응답 후 `response_url`로 실행자에게만 전송한다.
- `/stock-help`는 외부 호출이나 저장소 접근 없이 서명 검증 후 실행자에게만 즉시 응답한다(Discord `type: 4`, `flags: 64`; Slack `ephemeral`). Discord 본문은 2,000자 이내로 유지한다.
- 긴 Discord 별칭 목록은 어댑터에서 줄 단위로 나눠 각 메시지가 2,000자를 넘지 않도록 원본 응답과 후속 메시지로 전송한다.

### 2. 데이터 소스 (`src/providers/`)

`MarketProvider` 인터페이스(`src/core/market.ts`)를 구현한 모듈을 `src/providers/index.ts`의 `createProviders`가 `[upbit, kis, yahoo]` 순서로 조립한다. `cloudflare/index.ts`는 동일 `env`에서 앱·제공자·종목 저장소 인스턴스를 재사용해 각 메모리 캐시를 유지한다. KIS에는 `cloudflare/storage.ts`가 구현한 `TokenCache`를 주입하고, 제공자는 KV 타입이나 저장 키를 알지 않는다.

Yahoo·Upbit는 `createYahoo`·`createUpbit` 팩토리에서 HTTP 전송 함수를 받으며, `createProviders`의 선택적인 `marketFetch`로 함께 지정할 수 있다. `src/core/http.ts`의 `MarketFetch(input, init?, cacheTtlSeconds?)`는 표준 요청 옵션과 캐시 시간 힌트만 전달한다. 기본 전송은 호출 시점의 표준 `fetch`를 사용하고 힌트를 요청 옵션에 추가하지 않는다. Cloudflare 진입점은 `cloudflare/http.ts`의 전송 함수를 주입해 힌트가 있을 때 `cf.cacheTtl`·`cacheEverything: true`를 적용한다. API 주소·페이지 조회·응답 해석은 제공자에 유지한다.

| 요청 | Cloudflare 캐시 시간 |
|---|---|
| Yahoo 차트 (직전 세션 재조회 포함) | 300초 |
| Yahoo 검색 | 3,600초 |
| Upbit 캔들 (페이지 조회·전일 종가 포함) | 60초 |
| Upbit 마켓 검색 | 3,600초 |

KIS의 인증·시세 요청은 기존 `fetch` 경로를 사용해 강제 캐시 대상에 포함하지 않는다. 기본 전송을 사용하는 Node smoke와 이후 실행 환경은 Cloudflare 옵션 없이 동작한다.

- **선택·폴백 및 에러 구분**: `getPrices`는 `supports(symbol)`가 참(또는 미정의)인 제공자를 순서대로 시도하며, 실패 시 다음 제공자로 넘어간다. 존재하지 않는 심볼은 `SymbolNotFoundError`를, 그 외 오류는 일반 `Error`를 던진다. `runChart`의 영문 검색 재시도는 `SymbolNotFoundError`에만 반응한다.
- **업비트 (`upbit.ts`)**: `KRW-*` 마켓만 전담한다. 24시간 거래 상품이므로 `continuous: true`(KST 표시)를 반환하며, 커스텀 날짜(`from`~`to`) 조회는 최대 2,000일까지 허용한다. `search`는 한글 질의나 `KRW-` 접두사일 때만 동작한다.
  - `max` 외의 기간은 요청 시각 기준 시간 범위로 제한하고, 페이지 조회도 시작 시각에 도달하면 멈춘다. 월 단위 기간은 30·90·180일, 연 단위 기간은 365·1,825일을 사용한다.
- **한국투자증권 (`kis.ts`)**: `KIS_APP_KEY`·`KIS_APP_SECRET`이 설정된 경우 `.KS`·`.KQ` 종목과 국내 지수(`^KS11`, `^KQ11`, `^KS200`)를 맡는다. 접근 토큰은 워커 메모리와 KV(`kis:token:v1`)에 캐시한다. 주식 `1d`는 KRX+NXT 통합(`UN`, 08:00~20:00) 시세를 먼저 조회하고 장중 봉이 부족하면 KRX 정규장(`J`, 09:00~15:30)으로 재조회하며, 개장 직후 등 당일 봉이 2개 미만이면 직전 거래일 세션을 사용한다.
- **Yahoo Finance (`yahoo.ts`)**: 모든 심볼을 지원하며 마지막 폴백과 영문 원격 검색(`/v1/finance/search`)을 담당한다. `1d`는 `includePrePost=true`로 미국 주식의 시간외 봉을 포함하며, 새 거래일 직후 당일 봉이 부족하면 5일 데이터에서 마지막 세션을 잘라 쓴다.
- **단위 보정 (`display.ts`)**: `JPYKRW=X`는 100엔 기준으로 배율(`×100`)과 라벨을 적용하고(`displayRule`), 지수(`^` 접두사)는 통화 단위를 표시하지 않는다(`displayCurrency`).

### 3. 종목 목록과 검색 (`src/core/symbols.ts`)

- **저장소 경계**: `src/core/storage.ts`의 `SymbolReader`는 `readSeed`·`readAliases`, `SymbolStore`는 여기에 `mutateAlias`를 제공한다. 검색·별칭·차트 로직은 이 계약을 받으며, KV 키와 DO 호출은 `cloudflare/storage.ts`가 담당한다. 시드가 비어 있다는 이벤트도 저장소 어댑터가 키 정보와 함께 기록한다.
- **시드 및 캐시**: `scripts/fetch-krx-symbols.ts`가 KIND 상장법인(KOSPI·KOSDAQ), 네이버 금융 ETF·ETN, 업비트 원화 마켓, 수동 별칭(`scripts/symbols.manual.json`)을 병합해 `scripts/symbols.json`을 생성한다(영문 혼합 6자리 종목코드 포함). Cloudflare 시드 데이터는 KV 단일 키 `symbols:v1`에 저장하고 저장소 인스턴스별 메모리에 10분간 캐시하며, 무료 플랜 한도 보호를 위해 KV `list`는 사용하지 않는다. 동시 조회는 진행 중인 Promise를 공유하고, 조회 실패 시 다음 호출에서 재시도한다. 별칭 변경 성공 후 해당 저장소의 캐시를 무효화한다.
- **정식명과 별칭**: 심볼당 정식명(`alias`가 없는 항목)은 하나뿐이며(KRX·업비트 등록명 우선, 없으면 수동 목록 첫 항목), 나머지는 `alias: true`로 표시된다. 자동완성 목록과 차트 제목에는 항상 정식명을 사용한다.
- **검색**: 공백·대소문자를 무시한 **정확 일치 → 접두사 일치 → 부분 일치** 순으로 정렬하며 한글 초성 검색도 지원한다. 결과가 25개 미만이고 2자 이상의 ASCII 질의면 원격 검색(`searchRemote`)으로 보충한다.

### 4. 사용자 별칭과 동시성 제어 (`src/core/aliases.ts`, `cloudflare/alias-writer.ts`)

- 채팅에서 `/stock-alias`로 추가한 별칭은 KV의 `aliases:v1`에 저장되며 `loadSymbols`가 시드 목록 뒤에 합친다.
- 별칭 대상은 정확히 일치하는 등록명을 먼저 확인하고, 영문 입력은 직접 시세 조회를 우선한다. 없는 심볼일 때만 부분 이름 검색으로 폴백하며, 시세 제공자 장애를 다른 종목으로 대체하지 않는다.
- 별칭 추가·삭제는 `SymbolStore.mutateAlias`에 변경 내용과 선택적인 요청 식별자·만료 시각을 전달한다. Cloudflare 어댑터는 단일 인스턴스 SQLite Durable Object인 `AliasWriter`(`ALIAS_WRITER` 바인딩, 인스턴스명 `aliases:v1`)를 호출해 직렬화한다. DO 내부 스토리지를 원본(source of truth)으로 삼고, KV 동일 키 쓰기 제한(초당 1회)을 준수하기 위해 최소 1.1초 간격으로 `aliases:v1`에 복제하며 실패 시 DO Alarm으로 재시도한다. 외부에서 `KV.put`으로 `aliases:v1`을 직접 수정하지 않는다.

- 중복 방지 키가 주어진 변경은 처리 기록과 별칭을 같은 트랜잭션에 저장한다. 기록은 DO 재시작 후에도 유지하며 만료되면 알람으로 정리한다. KV 복제 실패의 재시도와 기록 정리를 같은 알람에서 구분한다.

### 5. 렌더링 및 이미지 전달 (`src/rendering/resvg.ts`, `cloudflare/images.ts`)

- **SVG 및 WASM 렌더링**: `chart.ts`가 SVG를 생성하고 `runChart`가 주입된 `ChartRenderer`를 호출한다. `src/rendering/resvg.ts`의 `createResvgRenderer`는 비동기 자산 로더를 받는다. Cloudflare는 `cloudflare/assets.ts`에서 WASM·TTF를 import하고 Node smoke는 파일에서 읽는다. 자산은 최초 렌더링 때 로드하고 WASM 초기화는 렌더러 간에 공유하며, 실패한 초기화는 재시도할 수 있다. 서브셋 폰트 `fonts/NanumSquare{R,B}.ttf`를 사용하고 굵은 글씨는 `font-family`(`FONT_BOLD = "NanumSquare Bold"`)로 지정한다. `Resvg` 인스턴스와 `RenderedImage`는 GC 대상이 아니므로 반드시 `try ... finally`에서 `free()`를 호출한다.
- **시간외 구간 음영**: `PriceSeries.regularHours`가 주어지면 `extendedRuns`가 정규장 밖의 연속된 봉 구간에 회색 음영과 `프리마켓`·`애프터마켓` 라벨을 넣는다.
- **제목과 기간**: `buildSvg`에 제목과 `period`를 나눠 전달한다. 날짜 지정 기간은 헤더 아래 별도 줄에 표시하고, 제목은 심볼 접미사가 길어도 현재가 영역을 넘지 않도록 말줄임한다.
- **이미지 전달**: Discord는 PNG 바이트를 multipart 응답으로 직접 첨부한다. Slack은 `ImagePublisher.publish(png, requestUrl)`가 반환하는 완성된 URL을 사용한다. Cloudflare 구현은 R2에 저장한 뒤 요청의 origin을 기준으로 `/charts/<key>` URL을 발급하며, 같은 모듈이 기존 캐시·ETag 헤더로 이미지를 서빙한다. 공통 라우터의 이미지 서빙 기능은 선택적으로 주입한다.

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

- **커스텀 스팬**: `run.ts`가 주입된 `Tracer`로 `chart` 아래에 `chart.resolve`, `chart.prices`, `chart.render` 스팬을 기록한다. `cloudflare/tracing.ts`가 `cloudflare:workers`의 `tracing.enterSpan`을 연결하며, tracer를 생략한 환경은 기본 무동작 구현을 사용한다. 공통 소스에서는 `cloudflare:workers`를 import하지 않는다.
- **자동완성**: 입력마다 호출되므로 성공 경로에는 로그를 남기지 않는다.

## 확장 가이드

### 새 메신저 플랫폼 추가

1. `src/platforms/<name>.ts`에 어댑터를 작성한다(원본 본문 서명 검증 → 인자 파싱 → `runChart` / `runAlias` 호출 → 응답 전송). 결과 전송은 `reportCommand`로 감싼다.
2. `src/app.ts`에 라우트를 추가한다(`src/core/**`는 수정하지 않는다).

### 새 데이터 소스 추가

1. `src/providers/<name>.ts`에 `MarketProvider` 인터페이스를 구현한다(`core`의 타입과 `log`만 import). 특정 심볼만 담당하면 `supports(symbol)`를 구현하고, 없는 심볼은 `SymbolNotFoundError`를 던진다.
2. `src/providers/index.ts`의 `createProviders`에 우선순위에 맞게 추가하고 `test/`에 단위 테스트를 작성한다.

## 코딩 컨벤션 및 보안

- **스타일 및 타입**: TypeScript `strict` 모드와 2칸 들여쓰기를 사용한다. 주석은 코드만으로 파악하기 어려운 배경 지식이나 제약 조건에만 간결하게 남기며, 사용자 노출 메시지는 한국어로 작성한다.
- **Wrangler 설정**: 로컬 설정은 Git에서 제외한 `cloudflare/wrangler.jsonc`, 추적하는 예시는 `cloudflare/wrangler.jsonc.example`이다. 공통 설정 변경 시 예시 파일도 함께 갱신한다. CI 검증은 예시 파일을 사용한다. 운영 배포·KV 적재는 기존 GitHub Actions Variable `WRANGLER_CONFIG`를 루트 `wrangler.jsonc`로 복원하고 `--config wrangler.jsonc`를 명시한다. npm 실행·배포 명령과 Vitest는 진입점 `cloudflare/index.ts`도 명시해 기존 설정의 `main` 값과 호환한다. 설정 파일에는 비밀값을 넣지 않는다.
- **시크릿 및 생성물**: 시크릿은 `cloudflare/.dev.vars`(로컬), `wrangler secret`(운영), GitHub Actions Secrets(CI)만 사용하며 코드·설정·로그에 노출하지 않는다. 실제 `wrangler.jsonc`와 `.dev.vars`는 이전 위치인 루트에서도 Git 제외를 유지한다. 생성물(`node_modules/`, `dist/`, `wasm/*.wasm`)은 커밋하지 않는다.
