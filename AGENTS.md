# AGENTS.md

이 문서는 에이전트/자동화 세션이 이 저장소에서 작업할 때 따라야 할 지침이다.
사람을 위한 상세 개발 가이드는 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고한다.

## 프로젝트

Slack/Discord 등 메신저에서 슬래시 커맨드로 주가 차트를 그려 주는 봇.
Cloudflare Workers 엣지에서 동작하며, 플랫폼 중립 `core` + 플랫폼별 `adapter` 구조다.

## 자주 쓰는 명령

| 목적 | 명령 |
|---|---|
| 로컬 개발 | `npm run dev` |
| 타입 검사 | `npm run typecheck` |
| 테스트 | `npm test` |
| 로컬 렌더 확인 | `npm run smoke -- "AAPL:1d,005930.KS:1m"` |
| KRX 종목 목록 갱신 | `npm run fetch:symbols` (KIND → `scripts/symbols.json`) |
| KV 심볼 시드 | `npm run seed:symbols` |
| 빌드 확인 | `npx wrangler deploy --dry-run --outdir dist` |
| 운영 배포 | `npm run deploy` |
| 커맨드 등록 | `npm run register` |
| wasm 생성 | `npm run setup:wasm` |

## 구조

```
src/
├─ index.ts            # 경로 라우팅 (/discord, /slack, /charts/*)
├─ env.d.ts            # Env 바인딩, *.wasm 모듈 선언
├─ core/               # 플랫폼 의존성 없음
│  ├─ command.ts       #   인자 검증/정규화
│  ├─ market.ts        #   시세 조회 파사드 (PROVIDERS 순서대로 폴백)
│  ├─ providers/       #   MarketProvider 구현체 (yahoo.ts). 외부 API 호출은 여기에만
│  ├─ chart.ts         #   SVG 생성
│  ├─ symbols.ts       #   종목 목록(KV 단일 키, 메모리 캐시) 검색 + Yahoo search 폴백
│  ├─ render.ts        #   resvg-wasm SVG→PNG (fonts/ 번들 폰트 사용)
│  ├─ store.ts         #   R2 저장/서빙 (URL 전용 플랫폼)
│  └─ run.ts           #   오케스트레이션 (어댑터가 호출)
└─ platforms/
   ├─ discord.ts       #   Ed25519 서명 검증, deferred, multipart 업로드
   └─ slack.ts         #   HMAC 서명 검증, 3초 ack, response_url
```

## 반드시 지킬 규칙

- `src/core/**`에서 플랫폼 SDK/Discord 타입을 import 하지 않는다. 플랫폼 코드는
  `src/platforms/**`에만 둔다.
- 새 플랫폼은 어댑터 파일 + `src/index.ts` 라우트 추가로 끝내고 core는 건드리지 않는다.
- Discord/Slack 서명 검증은 **raw body 문자열**로 수행한다(파싱된 객체 금지). `req.text()` 사용.
- 시세·검색 API 호출은 `src/core/providers/*`에만 둔다. 새 소스는 `MarketProvider`를 구현해 `market.ts`의 `PROVIDERS`에 추가한다. 없는 심볼은 `SymbolNotFoundError`, 그 외(HTTP 오류, 데이터 부족, 파싱 실패)는 일반 `Error`로 던진다. 검색 폴백은 전자에만 반응한다.
- resvg 인스턴스와 렌더 결과는 반드시 `free()`한다(GC에 등록되지 않아 wasm 메모리가 새어 나간다).
- KV 쓰기는 무료 플랜 기준 하루 1,000회다. `seed:symbols`는 1회지만, 개별 키를 대량으로 쓰지 않는다.
- 파일 업로드가 안 되는 플랫폼은 `core/store.ts`로 R2에 저장하고 `/charts/<key>` URL을 쓴다.
- 슬래시 커맨드는 3초 내 `{ type: 5 }`(deferred)를 반환하고 실제 작업은
  `ctx.waitUntil(...)`에서 처리한 뒤 interaction token으로 원본 메시지를 수정한다.
- 시크릿은 `.dev.vars`(로컬) / `wrangler secret`(운영)만 사용한다. 코드·설정·로그에 넣지 않는다.
- `wasm/resvg.wasm`은 생성물이라 커밋하지 않는다. `fonts/*.ttf`는 서브셋 산출물이며 커밋한다.
- 종목 별칭: `scripts/symbols.manual.json`(수동, 우선)과 KIND 목록을 합쳐 `scripts/symbols.json`을 만든다. `symbols.json`은 직접 편집하지 않는다. 실행 시 별칭은 정확 일치만 적용하고, Yahoo 심볼 형식 입력은 매핑하지 않는다. 미국 티커와 겹치는 짧은 영문 별칭(`USD`, `ETH` 등)은 넣지 않는다.
- 종목 목록은 KV `SYMBOLS`의 단일 키 `symbols:v1`에 JSON으로 저장한다. 자동완성에서 KV `list`를 쓰지 않는다(무료 플랜 list 한도 1,000회/일).
- 테스트는 `test/**`에 두고 `@cloudflare/vitest-plugin`으로 workerd 안에서 실행한다. 외부 fetch는 `vi.stubGlobal("fetch", ...)`로 막는다.
- 사용자 노출 메시지는 한국어. 2 spaces. 주석은 최소화.

## 완료 전 확인

1. `npm run typecheck` 통과
2. `npm test` 통과
3. `npx wrangler deploy --dry-run --outdir dist` 성공
4. core에 플랫폼 의존성이 유입되지 않았는지 확인

## 하지 말 것

- 요청 없이 커밋/push 하지 않는다.
- `.dev.vars`, `dist/`, `node_modules/`, `wasm/*.wasm`을 커밋하지 않는다.
