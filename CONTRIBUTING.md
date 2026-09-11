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

`wrangler.jsonc`의 `REPLACE_ME` / `REPLACE_WITH_KV_NAMESPACE_ID`는 반드시 실제 값으로
교체한다. 교체 전에는 PING 검증과 KV 접근이 실패한다.

## 개발 워크플로

```bash
npm run dev          # 로컬 워커 (http://localhost:8787/discord)
npm run typecheck    # 타입 검사 (필수)
npm run deploy       # 운영 배포
npm run register     # Discord 슬래시 커맨드 등록
```

Wrangler 빌드가 깨지지 않는지 확인하려면:

```bash
npx wrangler deploy --dry-run --outdir dist
```

## 검증

별도 테스트 프레임워크는 아직 없다. PR 전에 다음 두 가지는 반드시 통과해야 한다.

1. `npm run typecheck`
2. `npx wrangler deploy --dry-run`

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

### 렌더링

차트는 SVG 문자열을 만든 뒤 `@resvg/resvg-wasm`으로 PNG로 변환한다.
`wasm/resvg.wasm`은 생성물이므로 커밋하지 않는다(`npm run setup:wasm`로 생성).

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
