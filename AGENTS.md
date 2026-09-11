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
| 빌드 확인 | `npx wrangler deploy --dry-run --outdir dist` |
| 운영 배포 | `npm run deploy` |
| 커맨드 등록 | `npm run register` |
| wasm 생성 | `npm run setup:wasm` |

## 구조

```
src/
├─ index.ts            # 경로 라우팅 (/discord, ...)
├─ env.d.ts            # Env 바인딩, *.wasm 모듈 선언
├─ core/               # 플랫폼 의존성 없음
│  ├─ command.ts       #   인자 검증/정규화
│  ├─ market.ts        #   시세 조회 + 캐시
│  ├─ chart.ts         #   SVG 생성
│  ├─ render.ts        #   resvg-wasm SVG→PNG
│  └─ run.ts           #   오케스트레이션 (어댑터가 호출)
└─ platforms/
   └─ discord.ts       #   서명 검증, deferred, multipart 업로드
```

## 반드시 지킬 규칙

- `src/core/**`에서 플랫폼 SDK/Discord 타입을 import 하지 않는다. 플랫폼 코드는
  `src/platforms/**`에만 둔다.
- 새 플랫폼은 어댑터 파일 + `src/index.ts` 라우트 추가로 끝내고 core는 건드리지 않는다.
- Discord 서명 검증은 **raw body 문자열**로 수행한다(파싱된 객체 금지). `req.text()` 사용.
- 슬래시 커맨드는 3초 내 `{ type: 5 }`(deferred)를 반환하고 실제 작업은
  `ctx.waitUntil(...)`에서 처리한 뒤 interaction token으로 원본 메시지를 수정한다.
- 시크릿은 `.dev.vars`(로컬) / `wrangler secret`(운영)만 사용한다. 코드·설정·로그에 넣지 않는다.
- `wasm/resvg.wasm`은 생성물이라 커밋하지 않는다.
- `wrangler.jsonc`의 `REPLACE_ME`, `REPLACE_WITH_KV_NAMESPACE_ID`를 실제 값으로 바꿔야 동작한다.
- 사용자 노출 메시지는 한국어. 2 spaces. 주석은 최소화.

## 완료 전 확인

1. `npm run typecheck` 통과
2. `npx wrangler deploy --dry-run --outdir dist` 성공
3. core에 플랫폼 의존성이 유입되지 않았는지 확인

## 하지 말 것

- 요청 없이 커밋/push 하지 않는다.
- `.dev.vars`, `dist/`, `node_modules/`, `wasm/*.wasm`을 커밋하지 않는다.
