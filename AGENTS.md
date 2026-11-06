# AGENTS.md

이 문서는 AI 에이전트 및 자동화 세션이 이 저장소에서 작업할 때 따라야 할 핵심 지침이다.
사람을 위한 상세 개발 가이드는 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고한다.

## 프로젝트

Discord와 Slack 등 메신저에서 슬래시 커맨드로 주가 차트를 그려 주는 봇이다.
Cloudflare Workers 엣지에서 동작하며, 플랫폼 중립적인 `core`와 메신저별 `adapter` 구조로 이루어진다.

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
├─ index.ts            # 경로 라우팅 (/discord, /slack, /charts/*) 및 AliasWriter DO export
├─ env.d.ts            # Env 바인딩 및 *.wasm / *.ttf 모듈 선언
├─ core/               # 플랫폼 의존성 없음
│  ├─ types.ts         #   공통 타입 (ChartBar, ChartRequest, OutgoingMessage 등)
│  ├─ command.ts       #   인자 검증·정규화
│  ├─ market.ts        #   시세 조회·검색 파사드 (supports 필터 후 PROVIDERS 순서대로 폴백)
│  ├─ providers/       #   MarketProvider 구현체 (upbit.ts: KRW-*, kis.ts: .KS/.KQ, ^KS11/^KQ11/^KS200, yahoo.ts: 그 외)
│  ├─ symbols.ts       #   종목 목록(KV 단일 키 + 메모리 캐시) 검색 및 Yahoo 검색 폴백
│  ├─ aliases.ts       #   /stock-alias add|remove|list 비즈니스 로직
│  ├─ alias-writer.ts  #   별칭 변경 직렬화 및 KV 복제를 담당하는 SQLite Durable Object
│  ├─ display.ts       #   관행 단위 보정 (JPYKRW=X → 100엔 기준 배율·라벨)
│  ├─ chart.ts         #   SVG 차트 생성 및 등락 요약
│  ├─ render.ts        #   resvg-wasm SVG→PNG 변환 (fonts/ 번들 폰트 사용)
│  ├─ store.ts         #   R2 이미지 저장·서빙 (URL 전용 플랫폼용)
│  └─ run.ts           #   차트 생성 오케스트레이션 (어댑터가 호출)
└─ platforms/
   ├─ discord.ts       #   Ed25519 서명 검증, 자동완성, deferred 응답, multipart 업로드
   ├─ slack.ts         #   HMAC 서명 검증, 3초 이내 ack, response_url 전송
   └─ help.ts          #   /stock-help 공통 문구 및 플랫폼별 사용 예시
```

## 반드시 지킬 규칙

- **작업 계획**: 장기 작업이나 구조 변경은 시작 전에 계획을 먼저 세운다.
- **플랫폼 경계 유지**: `src/core/**`에서 플랫폼 SDK나 Discord/Slack 전용 타입을 절대 import하지 않는다. 플랫폼 종속 코드는 `src/platforms/**`에만 둔다. 새 플랫폼 추가는 어댑터 파일과 `src/index.ts` 라우트 추가로 끝내고 `core`는 수정하지 않는다.
- **서명 검증 및 비동기 응답**: Discord/Slack 서명 검증은 파싱된 객체가 아닌 **원본 요청 문자열(`await req.text()`)**로 수행한다. 슬래시 커맨드는 3초 이내에 즉시 응답(Discord `{ type: 5 }` deferred, Slack 즉시 응답)을 반환하고, 실제 작업은 `ctx.waitUntil(...)`에서 처리한 뒤 웹훅(`interaction.token` 또는 `response_url`)으로 결과를 보낸다. 고정 문구를 반환하는 `/stock-help`는 예외로, 서명 검증 후 실행자에게만 즉시 응답한다(Discord `type: 4`, `flags: 64`; Slack `ephemeral`). 도움말 처리에는 외부 호출이나 저장소 접근을 추가하지 않는다.
- **슬래시 커맨드**: 지원하는 명령은 `/stock-chart`, `/stock-alias`, `/stock-help` 세 개뿐이다. 제거된 구버전 `/chart`, `/alias`는 다시 등록하거나 처리하지 않는다.
- **시세·검색 제공자 (`src/core/providers/*`)**:
  - 외부 시세·검색 API 호출은 `src/core/providers/*`에만 둔다. 새 소스는 `MarketProvider`를 구현해 `market.ts`의 `PROVIDERS`에 추가하며, 특정 심볼 형식만 담당하면 `supports(symbol)`를 구현한다.
  - `search`는 자동완성마다 호출되므로 영문 질의에 불필요한 네트워크 호출을 추가하지 않는다(영문 원격 검색은 Yahoo만 담당).
  - 존재하지 않는 심볼은 `SymbolNotFoundError`, 그 외 오류(HTTP 오류, 데이터 부족, 파싱 실패)는 일반 `Error`로 던진다. 실행 시 검색 폴백은 `SymbolNotFoundError`에만 반응한다.
- **WASM 메모리 해제**: `Resvg` 인스턴스와 `render()` 결과(`RenderedImage`)는 GC에 등록되지 않으므로 반드시 `finally` 블록에서 `free()`해 메모리 누수를 막는다.
- **이미지 전달**: 직접 파일 업로드를 지원하지 않는 플랫폼은 `core/store.ts`로 R2에 저장하고 `/charts/<key>` URL을 사용한다.
- **종목 목록 및 별칭 규칙**:
  - `scripts/symbols.json`은 생성물이므로 직접 편집하지 않는다(`scripts/symbols.manual.json`과 KIND 상장법인·네이버 ETF/ETN·업비트 원화 마켓 목록을 합쳐 `npm run fetch:symbols`로 생성). 미국 티커와 겹치는 짧은 영문 별칭(`USD`, `ETH` 등)은 수동 목록에 넣지 않는다.
  - 심볼당 정식명은 하나(KRX·업비트 등록명 우선, 없으면 수동 목록의 첫 항목)이고 나머지는 `alias: true`로 표시된다. 별칭은 검색과 심볼 해석에만 쓰고, 자동완성 표시명과 차트 제목에는 항상 정식명을 쓴다.
  - 실행 시 별칭은 **정확 일치**만 매핑하며, 심볼 형식 입력(`005930.KS`, `KRW=X`, `BTC-USD`, `^KS11` 등)은 별칭 매핑을 거치지 않는다.
- **KV 및 Durable Object 사용**:
  - 시드 종목 목록은 KV(바인딩 `KV`)의 단일 키 `symbols:v1`, 채팅으로 추가한 별칭은 `aliases:v1`에 JSON 배열로 저장하며 `loadSymbols`가 둘을 합친다.
  - KV 무료 플랜 한도(쓰기·`list` 각 1,000회/일)를 지키기 위해 개별 키를 대량으로 쓰거나 자동완성 등에서 KV `list`를 호출하지 않는다.
  - 사용자 별칭(`aliases:v1`) 추가·삭제는 반드시 `ALIAS_WRITER` Durable Object(`mutateAlias`)를 거치며, KV의 `aliases:v1`을 직접 수정하지 않는다.
  - `/stock-alias` 변경 권한: Discord는 `member.permissions`의 `ADMINISTRATOR`/`MANAGE_GUILD`, Slack은 `SLACK_ALIAS_ADMINS`(쉼표 구분 사용자 ID)로 검사한다. `list`는 누구나 실행할 수 있다.
- **시크릿 및 생성물**: 시크릿은 `.dev.vars`(로컬)와 `wrangler secret`(운영)만 사용하며 코드·설정·로그에 넣지 않는다. `wasm/resvg.wasm`은 생성물이라 커밋하지 않고, `fonts/*.ttf`는 서브셋 산출물이며 커밋한다.
- **테스트 및 스타일**: 테스트는 `test/**`에 두고 `@cloudflare/vitest-plugin`으로 `workerd` 안에서 실행하며, 외부 `fetch`는 `vi.stubGlobal("fetch", ...)`로 격리한다. 사용자 노출 메시지는 한국어로 작성하고, 들여쓰기는 2칸(2 spaces), 주석은 최소화한다.

## 완료 전 확인

1. `npm run typecheck` 통과
2. `npm test` 통과
3. `npx wrangler deploy --dry-run --outdir dist` 성공
4. `src/core/**`에 플랫폼 의존성이 유입되지 않았는지 확인

## 하지 말 것

- 요청 없이 커밋하거나 push하지 않는다.
- `.dev.vars`, `dist/`, `node_modules/`, `wasm/*.wasm`을 커밋하지 않는다.
