# AGENTS.md

AI 에이전트 및 자동화 세션이 이 저장소에서 작업할 때 따라야 할 핵심 지침이다.
상세 개발 가이드는 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고한다.

## 프로젝트

Discord와 Slack에서 슬래시 커맨드로 주가 차트를 그려 주는 Cloudflare Workers 봇이다.
플랫폼 중립적인 `core`, 시세 소스별 `providers`, 메신저별 `platforms` 어댑터로 이루어진다.

## 자주 쓰는 명령

| 목적 | 명령 |
|---|---|
| 로컬 개발 | `npm run dev` |
| 타입 검사 | `npm run typecheck` |
| 테스트 | `npm test` |
| 로컬 렌더 확인 | `npm run smoke -- "AAPL:1d,005930.KS:1m"` |
| 종목 목록 갱신 | `npm run fetch:symbols` (KIND 주식 + 네이버 ETF/ETN + 업비트 + 수동 별칭 → `scripts/symbols.json`) |
| KV 심볼 시드 | `npm run seed:symbols` (`scripts/symbols.json` → KV `symbols:v1`) |
| 빌드 확인 | `npx wrangler deploy --dry-run --outdir dist` |
| 운영 배포 | `npm run deploy` |
| 커맨드 등록 | `npm run register` |
| WASM 복사 | `npm run setup:wasm` |

## 구조

```
src/
├─ index.ts            # 경로 라우팅 (/discord, /slack, /charts/*), 제공자 목록 조립, AliasWriter DO export
├─ env.d.ts            # Env 바인딩 및 *.wasm / *.ttf 모듈 선언
├─ core/               # 플랫폼 의존성 없음
│  ├─ types.ts         #   공통 타입 (ChartBar, ChartRequest, OutgoingMessage 등)
│  ├─ command.ts       #   인자 검증·정규화
│  ├─ market.ts        #   MarketProvider 인터페이스, SymbolNotFoundError, 시세 조회·검색 폴백
│  ├─ symbols.ts       #   종목 목록(KV 단일 키 + 메모리 캐시) 검색 및 원격 검색 폴백
│  ├─ aliases.ts       #   /stock-alias add|remove|list 비즈니스 로직
│  ├─ alias-writer.ts  #   별칭 변경 직렬화 및 KV 복제를 담당하는 SQLite Durable Object
│  ├─ display.ts       #   관행 단위 보정(JPYKRW=X → 100엔) 및 지수(^) 통화 단위 생략
│  ├─ chart.ts         #   SVG 차트 생성 및 등락 요약
│  ├─ render.ts        #   resvg-wasm SVG→PNG 변환 (fonts/ 번들 폰트 사용)
│  ├─ store.ts         #   R2 이미지 저장·서빙 (URL 전용 플랫폼용)
│  ├─ log.ts           #   구조화 로그 (Workers Observability용 JSON 한 줄)
│  └─ run.ts           #   차트 생성 오케스트레이션 (어댑터가 호출)
├─ providers/          # MarketProvider 구현체 (core만 import)
│  ├─ index.ts         #   createProviders: 우선순위 순서로 목록 조립 (KIS는 키가 있을 때만)
│  ├─ upbit.ts         #   KRW-*
│  ├─ kis.ts           #   .KS/.KQ, ^KS11/^KQ11/^KS200
│  └─ yahoo.ts         #   그 외 전부, 영문 원격 검색
└─ platforms/
   ├─ discord.ts       #   Ed25519 서명 검증, 자동완성, deferred 응답, multipart 업로드
   ├─ slack.ts         #   HMAC 서명 검증, 3초 이내 ack, response_url 전송
   ├─ help.ts          #   /stock-help 공통 문구 및 플랫폼별 사용 예시
   └─ report.ts        #   결과 전송 및 명령 단위 로그(chart.command.done)
```

## 반드시 지킬 규칙

- **작업 계획**: 장기 작업이나 구조 변경은 시작 전에 계획을 먼저 세운다.
- **플랫폼 경계 유지**: `src/core/**`에서 플랫폼 SDK나 전용 타입, `src/providers/**`, `src/platforms/**`를 절대 import하지 않는다. 새 플랫폼 추가는 `src/platforms/` 어댑터와 `src/index.ts` 라우트 추가로 끝내고 `core`는 수정하지 않는다.
- **서명 검증 및 비동기 응답**: 서명 검증은 파싱 전 **원본 요청 문자열(`await req.text()`)**로 수행한다. 슬래시 커맨드는 3초 이내에 초기 응답(Discord `{ type: 5 }`, Slack 즉시 응답)을 반환하고 실제 작업은 `ctx.waitUntil(...)`에서 처리해 웹훅으로 보낸다. 단, `/stock-help`는 외부 호출이나 저장소 접근 없이 서명 검증 후 실행자에게만 즉시 응답한다(Discord `type: 4`, `flags: 64`; Slack `ephemeral`).
- **슬래시 커맨드**: 지원하는 명령은 `/stock-chart`, `/stock-alias`, `/stock-help` 세 개뿐이며 그 외 명령은 등록·처리하지 않는다.
- **시세·검색 제공자 (`src/providers/*`)**:
  - 외부 시세·검색 API 호출은 `src/providers/*`에만 둔다. 제공자 목록은 `createProviders`로 조립해 `runChart`, `runAlias`, `searchSymbols`에 인자로 넘기며 `core`에 전역 목록이나 설정을 두지 않는다.
  - `search`는 자동완성마다 호출되므로 영문 질의에 불필요한 네트워크 호출을 추가하지 않는다(영문 원격 검색은 Yahoo만 담당).
  - 존재하지 않는 심볼은 `SymbolNotFoundError`, 그 외 오류는 일반 `Error`로 던진다. 실행 시 검색 폴백은 `SymbolNotFoundError`에만 반응한다.
- **로그**: `logEvent`로 JSON 한 줄을 남기고 사용자 ID·토큰·웹훅 URL은 넣지 않는다. 이벤트 이름과 속성 키는 OpenTelemetry 시맨틱 컨벤션(점 구분 소문자 `snake_case`, 표준 속성 `error.type`·`exception.*`·`http.response.status_code` 우선, 앱 고유 속성은 `chart.*`)을 따르며 예외는 `exceptionAttributes(err)`로 남긴다. 어댑터 결과 전송은 `reportCommand`로 감싸고, 자동완성 성공 경로에는 로그를 추가하지 않는다. `src/core/market.ts`와 `src/providers/*`는 smoke 스크립트가 Node에서 불러오므로 `cloudflare:workers`를 import하지 않는다.
- **WASM 메모리 해제**: `Resvg` 인스턴스와 `render()` 결과(`RenderedImage`)는 반드시 `finally` 블록에서 `free()`해 해제한다.
- **이미지 전달**: 직접 파일 업로드를 지원하지 않는 플랫폼은 `core/store.ts`로 R2에 저장하고 `/charts/<key>` URL을 사용한다.
- **종목 목록 및 별칭 규칙**:
  - `scripts/symbols.json`은 생성물이므로 직접 편집하지 않는다(`scripts/symbols.manual.json`을 수정하고 `npm run fetch:symbols`로 생성). 미국 티커와 겹치는 짧은 영문 별칭(`USD`, `ETH` 등)은 수동 목록에 넣지 않는다.
  - 심볼당 정식명은 하나이며 나머지는 `alias: true`로 표시된다. 자동완성 표시명과 차트 제목에는 항상 정식명을 쓴다.
  - 실행 시 별칭은 **정확 일치**만 매핑하며, 심볼 형식 입력(`005930.KS`, `KRW=X`, `BTC-USD`, `^KS11` 등)은 별칭 매핑을 거치지 않는다.
- **KV 및 Durable Object 사용**:
  - 시드 종목 목록은 KV `symbols:v1`, 사용자 별칭은 `aliases:v1` 단일 키에 JSON 배열로 저장하며 KV `list`는 호출하지 않는다.
  - 사용자 별칭(`aliases:v1`) 추가·삭제는 반드시 `ALIAS_WRITER` Durable Object(`mutateAlias`)를 거치며 KV를 직접 수정하지 않는다.
  - `/stock-alias` 변경 권한: Discord는 `ADMINISTRATOR`/`MANAGE_GUILD`, Slack은 `SLACK_ALIAS_ADMINS`로 검사한다(`list`는 전체 허용).
- **시크릿 및 생성물**: 시크릿은 `.dev.vars`(로컬)와 `wrangler secret`(운영)만 사용한다. `wasm/resvg.wasm`은 커밋하지 않고 `fonts/*.ttf`는 커밋한다.
- **테스트 및 스타일**: 테스트는 `test/**`에 두고 `@cloudflare/vitest-plugin`으로 `workerd`에서 실행하며 외부 `fetch`는 `vi.stubGlobal("fetch", ...)`로 격리한다. 사용자 노출 메시지는 한국어, 들여쓰기는 2칸, 주석은 최소화한다.

## 완료 전 확인

1. `npm run typecheck` 통과
2. `npm test` 통과
3. `npx wrangler deploy --dry-run --outdir dist` 성공
4. `src/core/**`에 플랫폼 의존성이나 `src/providers/**` import가 유입되지 않았는지 확인

## 하지 말 것

- 요청 없이 커밋하거나 push하지 않는다.
- `.dev.vars`, `dist/`, `node_modules/`, `wasm/*.wasm`을 커밋하지 않는다.
