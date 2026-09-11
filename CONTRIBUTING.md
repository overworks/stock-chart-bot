# Contributing

## 개요

`stock-chart-bot`은 Cloudflare Workers 엣지에서 동작하는 주가 차트 봇이다.
플랫폼 중립적인 `core`와 플랫폼별 `adapter`를 분리해, 새 메신저를 추가해도 core를
수정하지 않는 것을 목표로 한다.

## 요구 사항

- Node.js 20+
- npm
- Cloudflare 계정 및 Wrangler 로그인 (`npx wrangler login`)

## 셋업

```bash
npm install                                # postinstall에서 wasm/resvg.wasm 자동 복사
npx wrangler kv namespace create SYMBOLS   # 출력된 id를 wrangler.jsonc에 반영
npx wrangler r2 bucket create stock-chart-bot-charts
cp .dev.vars.example .dev.vars             # 로컬 개발용 시크릿 채우기
```

새 계정에 올릴 때는 `wrangler.jsonc`의 `DISCORD_APPLICATION_ID`와 KV 네임스페이스 `id`를
자기 값으로 바꾼다.

## 개발 워크플로

```bash
npm run dev          # 로컬 워커 (http://localhost:8787/discord)
npm run typecheck    # 타입 검사 (필수)
npm test             # vitest (workerd 런타임에서 실행)
npm run smoke -- "AAPL:1d,005930.KS:1m"   # Yahoo 조회 → PNG 로컬 확인 (dist/smoke/)
npm run fetch:symbols # KIND 상장법인 목록 + symbols.manual.json → scripts/symbols.json
npm run seed:symbols  # scripts/symbols.json 을 KV SYMBOLS 에 적재
npm run deploy       # 운영 배포
npm run register     # Discord 슬래시 커맨드 등록
```

Wrangler 빌드가 깨지지 않는지 확인하려면:

```bash
npx wrangler deploy --dry-run --outdir dist
```

## 검증

테스트는 `@cloudflare/vitest-plugin`으로 실제 workerd 런타임 안에서 실행된다(`vitest.config.ts`).
`test/discord.test.ts`는 서명 검증부터 PNG 렌더, webhook PATCH까지 전 구간을 검증한다.
외부 호출(Yahoo, Discord API)은 `vi.stubGlobal("fetch", ...)`로 대체한다.
`test/keypair.json`은 테스트 전용 Ed25519 키다.

PR 전에 다음은 반드시 통과해야 한다.

1. `npm run typecheck`
2. `npm test`
3. `npx wrangler deploy --dry-run`

## 아키텍처 규칙

경계를 지키는 것이 이 프로젝트의 핵심이다.

- `src/core/**`는 **어떤 플랫폼 SDK도 import 하지 않는다.** Discord, Slack 등의 타입이나
  라이브러리가 core로 들어오면 안 된다.
- 플랫폼과 무관한 로직(인자 파싱, 시세 조회, 차트 생성, 렌더링)은 core에 둔다.
- 플랫폼별 서명 검증, 응답 포맷, ack/deferred 처리, 파일 업로드는
  `src/platforms/<platform>.ts`에 둔다.
- 공용 오케스트레이션은 `src/core/run.ts`에 두고 각 어댑터가 호출한다.

### 이미지 전달

Kakao/LINE 등 일부 플랫폼은 업로드가 아니라 공개 URL만 허용한다. 따라서
core는 가능하면 PNG 바이트가 아니라 R2에 적재한 뒤 URL을 반환하는 방향을 지향한다.
Discord 어댑터는 현재 attachment 업로드를 사용한다.

### 종목 검색

종목 목록 전체(약 2,600개)는 KV `SYMBOLS`의 단일 키 `symbols:v1`에 JSON 배열로 저장하고,
워커는 이를 한 번 읽어 10분간 메모리에 캐시한다. 자동완성은 이 메모리에서 정확 일치 →
접두 → 부분 문자열 순으로 찾는다(대소문자·공백 무시). KV `list`는 무료 플랜 한도가
하루 1,000회라 사용하지 않는다. 결과가 부족하면서 입력이 ASCII이면
Yahoo search API(`/v1/finance/search`)로 폴백한다. Yahoo search는 한글 질의를 거부하므로
한글 종목명은 KV 시드(KRX 전 종목 + 수동 별칭)로만 커버한다. 실행 시에도 KV에 없는
ASCII 입력이 시세 조회에 실패하면 search 첫 결과로 한 번 재시도한다.

### 렌더링

차트는 SVG 문자열을 만든 뒤 `@resvg/resvg-wasm`으로 PNG로 변환한다.
`wasm/resvg.wasm`은 생성물이므로 커밋하지 않는다(`npm run setup:wasm`로 생성).
resvg-wasm에는 폰트가 없어 `fonts/NanumSquare{R,B}.ttf`(OFL, 라틴+한글 서브셋)를 번들한다.

## 코딩 컨벤션

- TypeScript strict 모드를 유지한다. `any`는 외부(비정형) 응답 파싱에 한해 허용한다.
- 들여쓰기는 2 spaces.
- 사용자에게 노출되는 에러 메시지는 한국어로 작성한다.
- 워커 경계에서 시크릿을 로그로 남기지 않는다.
- 주석은 꼭 필요한 경우에만 남긴다.

## 시크릿

- 로컬: `.dev.vars` (커밋 금지, `.gitignore`에 포함)
- 운영: `npx wrangler secret put <NAME>`
- CI: GitHub Secrets(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
- 코드, `wrangler.jsonc`, 로그에 시크릿을 절대 넣지 않는다.

## 새 플랫폼 추가

1. `src/platforms/<name>.ts`에 어댑터를 만든다(서명 검증 → 인자 정규화 →
   `runChart` 호출 → 응답 전송).
2. `src/index.ts`의 라우팅에 경로를 추가한다.
3. core는 수정하지 않는다. 수정이 필요하다면 추상화가 새고 있다는 신호다.

## 커밋 / 브랜치

- 기본 브랜치: `main`. 직접 push보다 PR을 권장한다.
- 커밋 메시지는 변경 이유를 중심으로 간결하게 작성한다.
- 커밋/PR에는 관련 없는 파일(node_modules, dist, .dev.vars)을 포함하지 않는다.

## 버전 관리

엣지에 배포되는 서비스 자체에는 SemVer를 강제하지 않는다. 봇 엔드포인트는 소비자가
버전을 선택하지 않으므로 호환성 계약이 의미가 없다. 대신 불변 버전 + 점진 배포 + 롤백으로
관리한다.

```bash
npx wrangler versions upload                              # 버전 업로드(미배포)
npx wrangler versions deploy --version-id <id> --percentage 90 ...  # 점진 배포
npx wrangler deployments status                           # 현재 배포/트래픽 확인
npx wrangler rollback [version-id]                        # 롤백
```

- `package.json`의 `version`은 메타데이터로만 유지한다(현재 0.x).
- 공개 패키지(npm)나 공개 HTTP API 계약이 생기면 그때 SemVer를 도입한다.
  API는 `/v1` 경로 등으로 버전을 노출한다.
- 릴리스 이력이 필요하면 GitHub Release 태그(`v0.1.0`)를 단다. 필요 시 changesets 도입.
- Discord 엔드포인트에는 버전 경로를 두지 않는다.
