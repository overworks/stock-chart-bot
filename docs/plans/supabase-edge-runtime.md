# Cloudflare Workers / Supabase Edge Functions 동시 지원 계획

- 작성일: 2026-11-14
- 기준 커밋: `cedd35f` (`main`)
- 작업 브랜치: `feat/supabase-edge-runtime`
- 현재 단계: 7단계 실행 연결·사용자 지정 Supabase 프로젝트 배포·실제 성능 측정 완료. 8단계 운영 자동화는 다음 구현 단계다.
- 진행 방식: 한 번에 한 단계씩 구현·검증·커밋한 뒤 결과를 보고한다.

## 목표와 범위

동일한 차트·검색·별칭·메신저 로직을 Cloudflare Workers와 Supabase Edge Functions에서 실행한다. 현재 Cloudflare 무료 플랜의 배포와 데이터를 보존하면서, 검증을 통과하는 작업 단위로 변경을 커밋한다.

두 실행 환경은 각각 독립된 배포와 저장소를 가진다. 이 작업의 완료 범위는 두 환경의 실행·테스트·배포 절차를 갖추는 것이다. 운영 웹훅 전환이나 기존 별칭 데이터 이전은 구현 완료 후 대상 환경에 맞춰 수행하는 별도 운영 단계다.

기존 기능 계약을 유지한다.

- `/stock-chart`, `/stock-alias`, `/stock-help` 세 명령, 한국어 메시지, 권한 검사와 원본 본문 서명 검증.
- 차트·별칭 명령은 3초 이내 초기 응답 후 작업을 계속한다. 자동완성은 즉시 결과를 반환하고, 도움말은 외부 호출·저장소·렌더러 초기화 없이 응답한다.
- 제공자 우선순위, `SymbolNotFoundError`에만 반응하는 검색 폴백, 정식명·정확 일치 별칭·초성 검색 규칙.
- Cloudflare의 KV 키, DO 클래스·인스턴스 식별자·기존 마이그레이션, 별칭 변경 직렬화·중복 방지·KV 복제 재시도.
- 이미지 전달 방식, 이미지 7일 보관, 구조화 로그와 민감정보 제외, WASM 자원 해제.

7단계의 로컬 Edge Runtime에서 2,000봉 캔들·거래량 조합의 CPU hard limit 종료를 관찰했다. 2026-11-16 사용자 지시에 따라 이 머신의 측정값으로 운영 성능을 판정하지 않는다. 차트 표현을 유지하고 구현을 완성한 뒤 배포 환경에서 CPU 예산 충족 여부와 최초·반복 호출을 측정한다. 로컬 긴 차트의 기능 정확성은 CPU 상한이 없는 별도 Deno 테스트로 검증한다.

## 구조 대안 검토

| 안 | 판단 |
|---|---|
| 단일 패키지 + 공통 `src/` + 실행 환경별 디렉토리 | 채택. 공유 코드를 직접 import하고 환경별 설정·어댑터를 함께 관리한다. |
| 앞서 제안한 `src/infra/cloudflare`, `src/infra/supabase`와 별도 설정 디렉토리 | 가능하지만 같은 실행 환경을 두 위치에서 관리하게 된다. 현재 규모에는 환경별 코드와 설정을 한곳에 모으는 편이 단순하다. |
| `apps/`, `packages/` 기반 workspace | 별도 패키지 배포나 독립 버전 관리가 필요할 때 재검토한다. 현재 공유 코드에는 패키지 빌드·배포 경계가 필요하지 않다. |
| Cloudflare KV/R2/DO API 전체를 흉내 내는 호환 계층 | 채택하지 않는다. 별칭 변경의 트랜잭션과 이미지 URL 발급처럼 업무에 필요한 작은 계약을 구현한다. |

목표 배치는 다음과 같다. 어댑터 파일은 구현 규모에 맞춰 나누되, 공통 코드의 원본은 `src/` 하나로 유지한다.

```text
.
├── package.json                  # 공통 도구 및 환경별 명령
├── tsconfig.json                 # 공통 코드: Web 표준 타입으로 독립 검사
├── tsconfig.base.json            # 모든 타입 검사가 공유하는 no-emit 옵션
├── src/
│   ├── app.ts                    # 공통 라우팅과 애플리케이션 조립
│   ├── core/                     # 업무 로직과 저장소·실행 기능 계약
│   ├── providers/                # 시세 요청·응답 해석
│   ├── platforms/                # Discord·Slack 처리
│   └── rendering/resvg.ts        # 자산을 주입받는 공통 PNG 렌더러
├── cloudflare/
│   ├── index.ts                  # fetch 진입점 및 AliasWriter export
│   ├── env.d.ts                  # 명시적으로 import하는 Workers 바인딩 타입
│   ├── modules.d.ts              # 바이너리 import 타입
│   ├── storage.ts                # KV·DO 저장소 어댑터
│   ├── images.ts                 # R2 이미지 공개·서빙
│   ├── tracing.ts                # Cloudflare tracing 연결
│   ├── http.ts                   # 캐시 시간 힌트를 Cloudflare 옵션으로 변환
│   ├── alias-writer.ts           # 기존 Durable Object
│   ├── assets.ts                 # Wrangler의 WASM·TTF import
│   ├── wrangler.jsonc.example
│   ├── .dev.vars.example
│   ├── tsconfig.json
│   └── vitest.config.ts
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   ├── scripts/                  # 시드 적재·만료 이미지 정리
│   └── functions/stock-chart-bot/
│       ├── index.ts              # 공통 앱 연결·경로 접두사 처리
│       ├── adapters.ts           # DB·Storage 어댑터
│       ├── assets.ts             # 번들 자산 읽기
│       └── deno.json
├── test/                         # 기존 workerd 회귀 테스트
│   └── supabase/                 # Deno 및 로컬 DB 통합 테스트
├── scripts/                      # 공통 목록 생성·등록·smoke 도구
├── fonts/                        # 공유 폰트 원본
├── wasm/                         # 설치 시 생성하는 WASM
└── .github/workflows/
```

실제 `wrangler.jsonc`와 `.dev.vars`는 `cloudflare/`에 두고 계속 Git에서 제외한다. 공통 폰트·WASM 원본은 유지하며, Supabase 배포에 필요한 자산 복사본도 생성물로 제외한다. TypeScript 소스를 복제하는 빌드 단계는 만들지 않는다.

## 추상화할 계약

범용 DI 컨테이너를 도입하지 않고 함수 인자와 작은 인터페이스로 의존성을 전달한다. 다음은 역할을 정한 것이며 구체적인 함수명은 각 단계에서 정한다.

| 필요한 기능 | 공통 코드가 아는 것 | 환경별 구현 |
|---|---|---|
| 종목 목록 | 시드 목록과 사용자 별칭 읽기 | Cloudflare KV / Supabase DB |
| 별칭 변경 | 추가·갱신·삭제, 요청 식별자와 만료 시각 | 기존 DO / 원자적 DB 함수 |
| KIS 토큰 캐시 | 토큰 읽기·저장 및 만료 시각 | KV / 서버 전용 DB 캐시 |
| 이미지 렌더링 | SVG를 PNG 바이트로 변환 | 공통 resvg 구현 + 환경별 자산 로더 |
| 이미지 공개 | PNG를 저장하고 완성된 이미지 URL 반환 | R2와 기존 `/charts/` 서빙 / Storage URL |
| 백그라운드 작업 | Promise 수명 연장 | `ctx.waitUntil` / `EdgeRuntime.waitUntil` |
| 트레이싱 | 구간 실행과 속성 기록 | Cloudflare tracing / 기본 무동작 구현 |
| 시세 HTTP 전송 | 표준 요청과 선택적 캐시 시간 힌트 | Cloudflare `cf` 옵션 / Supabase 표준 fetch |

추가 원칙:

- `src/core/**`는 제공자·메신저·실행 환경 구현을 import하지 않는다. `src/app.ts`가 공통 앱을 조립하고 실행 환경 진입점이 구체적인 의존성을 전달한다.
- `Env`, `KVNamespace`, `R2Bucket`, `DurableObjectNamespace`, `ExecutionContext`, `cloudflare:workers`가 공통 코드의 타입 또는 import에 남지 않게 한다.
- 공통 설정에는 메신저·제공자에 필요한 값만 포함하고 런타임 바인딩과 구분한다.
- 종목 메모리 캐시와 KIS 제공자는 앱 인스턴스별로 유지한다. 별칭 변경 후 로컬 캐시를 무효화하고, 다른 인스턴스는 현재와 같은 TTL 정책으로 갱신한다. 프로세스 메모리를 영속 저장소로 사용하지 않는다.
- Yahoo·Upbit의 `cf.cacheTtl`도 분리한다. Cloudflare 캐시 동작은 보존하고 Supabase는 우선 표준 fetch를 사용하며 외부 API 호출량을 검증한다. API 주소·파싱·폴백 정책은 계속 `providers/`에 둔다.
- 공통 렌더러에 `initWasm` 입력과 폰트 버퍼를 주입한다. 초기화는 지연·공유하고, 두 `free()`의 `finally` 보장을 유지한다. Node smoke도 같은 렌더러를 사용한다.

## Deno 및 번들링

- 공통 상대 import에 `.ts` 확장자를 명시하고 TypeScript의 no-emit 설정에서 이를 허용한다. 디렉토리 import도 명시적 `index.ts` 경로로 정리한다.
- npm 패키지 이름은 공통 코드에서 유지하고, Supabase 함수의 `deno.json`에서 대응하는 npm 버전을 지정한다. 공통 의존성의 두 환경 버전이 어긋나지 않게 고정·검증한다.
- 타입 검사는 공통 Web 표준 코드, Cloudflare 바인딩 코드, Node 스크립트, Supabase/Deno 코드로 범위를 나눈다. 기존 `Request.json<T>()` 같은 런타임별 타입 확장도 각 경계에서 처리한다.
- Supabase 함수에서 루트 `src/`를 직접 import한다. 실제 Edge Runtime 통합 검증으로 외부 상대 import·npm 모듈·WASM·TTF가 모두 번들에 포함되는지 확인한다.
- 폰트·WASM은 준비 스크립트로 함수의 생성 자산 디렉토리에 복사하고 `static_files`로 포함한다. 정적 자산이 포함되는 CLI/Docker 배포 경로를 사용한다.
- 공통 코드에 Cloudflare나 Deno 전역이 유입되면 실패하는 타입 검사와 import 경계 검사를 CI에 둔다.

## Supabase 저장소 설계

시드 목록은 기존 JSON 배열을 한 행의 문서로 보관한다. 검색을 SQL로 재작성하지 않고 공통 검색 로직과 메모리 캐시를 사용한다. 사용자 별칭은 별도 행으로 저장하고, 별칭 변경 RPC에서 중복 요청 기록과 함께 원자적으로 갱신한다.

| 데이터 | 설계와 완료 조건 |
|---|---|
| 시드 종목 | 단일 스냅샷 행. 전체 목록을 원자적으로 교체하고 기존 `alias: true` 의미를 보존한다. |
| 사용자 별칭 | 별칭 고유 키, 심볼, 정렬에 필요한 변경 정보. 전체 읽기의 페이지 제한과 안정적인 목록 순서를 처리한다. |
| 변경 요청 | 요청 키 고유 제약과 만료 시각. 같은 요청의 동시 실행·프로세스 재시작 후 재전송·만료 요청을 검증한다. |
| KIS 토큰 | 서버만 읽는 만료 시각 포함 캐시. 캐시 장애 시 기존 직접 발급 폴백을 유지한다. |
| 차트 PNG | 공개 읽기 가능한 전용 버킷, 서버만 쓰기·삭제. 현재와 같은 추측하기 어려운 객체 키와 7일 보관 정책. |

- 별칭 RPC는 변경과 요청 기록을 하나의 DB 트랜잭션으로 처리한다. 고유 제약과 필요한 잠금으로 같은 별칭에 대한 동시 변경을 보호하며, 여러 HTTP 요청의 read-modify-write로 대체하지 않는다.
- 기존 DO의 중복·만료·없는 별칭 삭제 오류 의미를 보존한다. 삭제 후 예전 추가 요청을 재전송해도 별칭이 복구되지 않아야 한다.
- DB가 별칭의 원본이므로 Supabase 구현에 KV 복제나 DO Alarm을 재현하지 않는다. 요청 기록 정리는 RPC에서 제한된 양을 처리하거나 정기 정리 작업으로 처리한다.
- 테이블과 RPC 접근은 서버 자격증명에 한정한다. 기본 DB 함수 실행 권한도 명시적으로 제한하고 비인증·일반 사용자 접근 거부를 실제 로컬 DB에서 검증한다.
- 이미지 정리는 기존 GitHub Actions 운영 방식에 맞춘 예약 작업과 Storage API로 구현한다. 페이지·삭제 배치 제한, 날짜 경계, 재실행을 처리한다. `storage.objects`의 SQL 삭제로 파일 삭제를 대신하지 않는다.

## 라우팅과 실행 수명

- Supabase는 하나의 봇 함수에서 `/discord`, `/slack`을 처리한다. 함수 URL 접두사는 Supabase 진입점에서 제거해 공통 라우터에 전달한다.
- 웹훅 함수는 Supabase JWT 검사를 끄고 기존 Discord·Slack 서명 검증으로 인증한다. 런타임 래퍼가 요청 본문을 먼저 소비하지 않게 한다.
- `waitUntil`은 두 환경 모두 실행 수명을 연장하는 기능으로만 추상화한다. 별칭의 영속성과 중복 방지는 저장소에서 보장한다.
- 초기 응답 경로에서 DB 조회나 WASM 초기화를 기다리지 않는다. 자동완성은 초기 응답을 미룰 수 없으므로 저장소·원격 검색을 포함한 응답 시간을 별도로 확인한다.
- Slack은 이미지 어댑터가 반환한 완성된 URL을 사용한다. 현재 `${origin}/${key}` 조합을 공통 어댑터에서 제거한다.

## 커밋 순서와 완료 조건

각 구현 커밋은 관련 테스트와 Cloudflare 전체 검증을 통과한 상태로 만든다. 분리할 수 없는 변경은 같은 커밋에 묶고, 실패하는 중간 상태를 체크포인트로 남기지 않는다. 각 단계에서 실제 경로·명령이 바뀌면 `AGENTS.md`, `CONTRIBUTING.md`, `README.md`도 함께 갱신한다.

| 순서 | 커밋 주제 | 작업 범위 | 완료 조건 |
|---|---|---|---|
| 0 | `docs: plan dual-runtime support` | 이 계획과 기준 검증 기록 | 기준 커밋·브랜치·검증 결과 확보 |
| 1 | `chore: isolate Cloudflare configuration` | Wrangler·로컬 시크릿 예시·Vitest 설정 이동, 명령·CI·ignore·문서 경로 갱신 | 예시 설정으로 typecheck/test/dry-run, 기존 운영 설정 복원 경로 확인 |
| 2 | `refactor: decouple symbol and alias storage` | 종목·별칭 저장소 및 KIS 캐시 계약, KV 어댑터, DO 이동 | 기존 키·DO 식별자 유지, 동시성·중복·재시도·토큰 캐시 회귀 테스트 통과 |
| 3 | `refactor: inject runtime services` | 공통 앱 조립, 백그라운드·이미지·tracing·설정 주입, 렌더러 자산 분리, Cloudflare 진입점 이동 | 두 메신저의 서명·초기 응답·도움말·이미지 전달과 PNG 생성 통과 |
| 4 | `refactor: isolate provider HTTP cache options` | Yahoo·Upbit HTTP 전송 경계와 Cloudflare 캐시 힌트 분리 | 기존 캐시 시간·검색 호출 조건·시세 폴백 보존 |
| 5 | `refactor: make shared code runtime independent` | 명시적 import 경로, 공통/Workers/Node 타입 검사 분리 | 공통 코드가 Cloudflare 타입 없이 검사되고 기존 smoke 진입점이 로드됨 |
| 6 | `feat: add Supabase persistence adapters` | DB 마이그레이션·별칭 RPC·시드/토큰/이미지 어댑터 | 로컬 DB 동시 변경·재전송·권한·캐시 만료·Storage 읽기 테스트 통과 |
| 7 | `feat: run the bot on Supabase Edge Functions` | 함수·설정·환경변수·경로·waitUntil·WASM/폰트 번들 연결 | 실제 로컬 Edge Runtime에서 서명된 요청 → 초기 응답 → PNG → 결과 전송, Deno에서 2,000봉 PNG 생성 확인. 성능 판정은 배포 후 수행 |
| 8 | `chore: complete dual-runtime operations and CI` | 두 환경 CI, 시드 적재, 이미지 정리, 배포·전환·복구 문서 | 외부 운영 시크릿 없는 PR 검증, 만료 정리·시드 재실행 검증, 운영 확인 항목 구분 |

테스트를 마지막 단계까지 미루지 않는다. 저장소나 실행 경계가 생기는 커밋에 그 계약을 검증하는 테스트를 포함하고, Supabase 통합 테스트는 해당 구현 커밋부터 실행한다.

## 명령과 CI

- 루트 `package.json` 하나에서 `dev:cloudflare`, `dev:supabase`, `deploy:cloudflare`, `deploy:supabase`, `seed:symbols:cloudflare`, `seed:symbols:supabase`를 제공한다.
- 기존 `dev`, `deploy`, `seed:symbols`는 Cloudflare 별칭으로 유지해 운영 기본값을 보존한다.
- 공통 타입 검사, 환경별 타입 검사·테스트, Cloudflare dry-run, Supabase 로컬 통합 검증을 별도 CI 작업으로 둔다. 시세·메신저 외부 호출은 고정 fixture로 격리하고 저장소 통합 테스트만 로컬 서비스를 사용한다.
- 기존 workerd 테스트를 유지한다. 새 Deno 테스트는 `test/supabase/`에 두고 파일 패턴 또는 명시적 설정으로 서로의 러너가 읽지 않게 한다.
- Supabase 테스트용 CLI/런타임 버전을 고정하고 로컬 백그라운드 작업이 완료되는 설정으로 실행한다. 일반 Deno 실행 성공과 실제 Edge Runtime 검증을 구분한다.
- 종목 생성은 공통 스크립트 한 번으로 수행하고 적재 대상만 분리한다. 기존 생성 파일을 직접 수정하지 않는다.
- Supabase 운영 배포는 프로젝트·시크릿이 설정된 명시적 작업으로 제공한다. PR 검증은 운영 시크릿과 원격 리소스 변경에 의존하지 않는다.

### 기존 `WRANGLER_CONFIG`와 경로 호환

현재 GitHub Actions Variable에는 `main`을 포함한 Wrangler 설정 전체가 저장되어 있다. 코드 경로 이동 때문에 이 외부 값을 동시에 변경하면 이전 커밋의 배포가 깨질 수 있다.

따라서 첫 구현에서는 운영 변수의 형식을 유지한다. CI의 운영 설정은 기존처럼 루트의 Git 제외 임시 파일에 복원하고, 배포 명령에 해당 커밋의 진입점을 명시한다. 설정 예시와 로컬 설정은 `cloudflare/`를 사용한다. KV 시드도 사용할 설정 경로를 명시한다. 이를 통해 외부 변수의 `main` 값 변경 없이 신·구 커밋을 배포할 수 있게 한다.

이 호환 경로와 로컬·CI 설정 경로의 차이는 문서화하고, 기존 형태의 가짜 운영 설정으로 dry-run을 검증한다. 로컬 실제 설정·시크릿은 새 위치로 전환할 때 기존 파일을 보존하고, 브랜치 전환으로 되돌릴 수 있도록 한다.

## 검증과 롤백

구현 커밋의 공통 완료 조건:

1. 타입 검사, 기존 전체 workerd 테스트, Cloudflare dry-run 성공.
2. 해당 단계의 추가 계약·Supabase 테스트 성공.
3. 공통 코드의 import 경계와 로그·시크릿·생성물 변경 확인.
4. 스테이징한 변경과 `git diff --check` 확인 후 한 작업 단위로 커밋.
5. 이 계획의 진행 표에 커밋별 결과와 남은 검증을 기록.

복구 원칙:

- 구현은 현재 기능 브랜치에서 진행하고 기준점 `cedd35f`를 유지한다. 공유된 커밋은 `git revert`로 되돌리며, 뒤 단계가 앞 단계에 의존하면 역순으로 함께 되돌린다.
- Cloudflare는 Worker 이름, KV/R2 리소스, DO 바인딩·클래스명·`idFromName` 값과 마이그레이션 이력을 보존한다. 추상화 때문에 영속 데이터를 재생성하지 않는다.
- Git 커밋 복구, 배포 버전 복구, DB/설정 복구를 구분한다. 이미 적용된 Supabase DB 마이그레이션은 Git revert만으로 취소되지 않는다. 초기 마이그레이션은 추가형으로 만들고 코드 복구 시 데이터를 보존한다.
- 운영 전환 시 별칭 쓰기를 조정하고 원본의 일관된 스냅샷을 확보한다. Cloudflare의 KV가 DO보다 늦을 수 있으므로 확인 없이 KV 복사본을 원본으로 간주하지 않는다. 되돌리는 동안 새로 생성된 별칭도 보존하는 절차를 문서화한다.
- 커밋은 이 작업에서 명시적으로 허용됐다. 2026-11-16 사용자가 구현 완료 후 Supabase 배포와 실제 성능 측정을 지시하고 대상 프로젝트 `ylrplxrocwlbejdqflti`를 제공했다. push·운영 웹훅 전환은 요청 범위에 포함하지 않는다.

최종 인수 항목은 두 메신저의 세 명령, 권한·서명 오류, 자동완성, 동시·중복 별칭 변경, KIS 토큰 캐시, 한글/캔들/거래량/긴 기간 PNG, Slack 이미지 URL, 7일 이미지 정리, 두 배포 경로다. 실제 호스팅 검증을 수행하지 않았다면 로컬 검증과 구분해 기록한다.

## 진행 기록

| 단계 | 상태 | 근거 |
|---|---|---|
| 기준 상태 | 완료 | `main`의 `cedd35f`, 작업 시작 시 변경 파일 없음 |
| 브랜치 | 완료 | `feat/supabase-edge-runtime` 생성 |
| 타입 검사 | 통과 | `npm run typecheck` |
| 기존 테스트 | 통과 | `npm test`: 12개 파일, 202개 테스트 |
| 빌드 | 통과 | `npx wrangler deploy --dry-run --outdir dist` |
| 구현 1 | 완료 | `chore: isolate Cloudflare configuration`, 아래 검증 기록 참고 |
| 구현 2 | 완료 | `refactor: decouple symbol and alias storage`, 아래 검증 기록 참고 |
| 구현 3 | 완료 | `refactor: inject runtime services`, 아래 검증 기록 참고 |
| 구현 4 | 완료 | `refactor: isolate provider HTTP cache options`, 아래 검증 기록 참고 |
| 구현 5 | 완료 | `refactor: make shared code runtime independent`, 아래 검증 기록 참고 |
| 구현 6 | 완료 | `feat: add Supabase persistence adapters`, 아래 검증 기록 참고 |
| 구현 7 | 완료 | `c7567de`, 실행 연결·16개 통합 테스트·2개 Deno 긴 차트 검증 통과. 배포 실측 10회 모두 성공 |
| 구현 8 | 예정 | 구현별 완료 조건을 통과한 뒤 기록 |

기준 테스트 실행 중 샌드박스 밖 Wrangler 로그 파일 쓰기 실패와 기존 경고가 출력됐지만 테스트는 종료 코드 0으로 통과했다. dry-run은 로그 경로를 `/tmp`로 지정해 성공했다. 기준 시점에 있던 `core`의 Cloudflare 의존성 제거 결과는 각 단계의 기록에서 확인한다.

### 1단계 완료 기록

- Wrangler·시크릿 예시와 Vitest 설정을 `cloudflare/`로 이동하고 npm 별칭·CI·타입 검사 경로·문서를 갱신했다. 로컬 상태 경로는 `--persist-to .wrangler/state`로 명시했다.
- 커맨드 등록 스크립트는 `--vars-file`로 환경파일을 선택한다. Node/tsx가 자체 처리하는 `--env-file`과의 충돌을 피하고, 파일이 없는 환경변수 전용 실행도 확인했다.
- 예시 설정으로 `npm run typecheck`, `npm test`(12개 파일, 202개 테스트), `npm run build:cloudflare`를 통과했다.
- 기존 루트 형식의 가짜 운영 설정으로 CI와 동일한 명시적 진입점·설정 경로의 dry-run을 통과했다. 원격 KV 적재나 운영 배포는 실행하지 않았다.
- `npm run dev -- --port ...`의 인자 전달과 실제 로컬 HTTP 응답(`/`, `/discord`, `/slack`, `/charts/`)을 확인했다. 샌드박스 검증에서는 Wrangler 로그·레지스트리만 `/tmp`로 지정했다.
- 등록 스크립트는 외부 `fetch`를 가로채 파일 지정·환경변수 전용·없는 파일 폴백의 세 경로를 확인했다.
- 실제 로컬 설정·시크릿을 새 위치에 준비하고 루트 원본을 보존했다. 새 위치의 실제 설정으로도 dry-run을 통과했고, 두 위치의 실제 파일이 Git에서 제외되는지 확인했다.
- `src/**`, `test/**` 변경 없이 설정 분리 범위로 마무리했다. 다음 단계는 사용자 요청을 받은 뒤 진행한다.

### 2단계 완료 기록

- `src/core/storage.ts`에 `SymbolReader`·`SymbolStore`·`TokenCache`와 변경 요청 식별자 타입을 정의했다. 종목·별칭·차트 로직은 저장소를, KIS 제공자는 선택적인 토큰 캐시를 주입받는다.
- KV 읽기·DO 변경 호출·토큰 직렬화와 키 정의를 `cloudflare/storage.ts`로 분리했다. 빈 시드 목록 로그도 키를 아는 Cloudflare 어댑터가 기록한다.
- Durable Object를 `cloudflare/alias-writer.ts`로 옮기고 기존 진입점에서 같은 `AliasWriter` 이름으로 export한다. 클래스 내부 실행 로직은 타입명 변경 외에 동일하며, 바인딩·인스턴스명·마이그레이션·KV 키를 보존했다.
- 종목 캐시는 저장소 인스턴스별로 10분간 유지하고 동시 조회를 공유한다. 성공한 별칭 변경은 해당 저장소 캐시만 무효화한다. 실패한 옛 조회가 새로 만든 캐시를 제거하지 않도록 처리했다.
- `npm run typecheck`, `npm test`(13개 파일, 209개 테스트), `npm run build:cloudflare`를 통과했다. 기존 202개 회귀 테스트에 저장소 격리·만료·조회 실패·무효화 경쟁·변경 실패와 KV 없는 토큰 캐시 검증 7개를 추가했다.
- Node에서 제공자·종목·별칭 모듈을 불러오고 저장소 계약만으로 심볼을 해석했다. 외부 네트워크 호출 없이 확인했다.
- `core`의 저장소 경로와 `providers`에서 KV·DO 타입 및 구현 의존성을 제거했다. 기존 tracing·R2·바이너리 로딩·실행 환경 설정의 분리는 3단계에서 진행한다.

### 3단계 완료 기록

- `src/app.ts`에 공통 라우터를 두고 `BotConfig`와 `BotServices`를 주입한다. 메신저 어댑터에서 `Env`·`ExecutionContext` 의존성을 제거하고 원본 요청 본문 서명 검증과 즉시 응답 흐름을 유지했다.
- `src/core/runtime.ts`에 렌더러·tracer·백그라운드 작업·이미지 공개 계약을 정의했다. `runChart`는 주입된 렌더러와 선택적 tracer를 사용하며 기본 무동작 tracer로도 동작한다. Cloudflare tracing은 전용 어댑터가 같은 스팬 이름·속성으로 연결한다.
- `src/rendering/resvg.ts`는 자산 로더를 받아 최초 렌더링 때 로드하고 WASM 초기화를 공유한다. 실패한 초기화는 재시도하며, 렌더링·PNG 인코딩 예외에도 두 자원의 `finally` 해제를 보장한다. Cloudflare와 Node smoke가 같은 렌더러를 사용한다.
- 이미지 저장·서빙을 `cloudflare/images.ts`로 옮겼다. Slack은 어댑터의 완성된 URL을 사용하고 Discord는 파일 첨부를 유지한다. Cloudflare 이미지 경로·캐시·ETag 동작은 기존 회귀 테스트로 검증했다.
- Workers 진입점을 `cloudflare/index.ts`로 옮기고 바인딩 타입은 명시적 type import로 한정했다. npm 명령·Vitest·CI가 진입점을 명시하므로 저장된 `main: src/index.ts` 설정도 수정 없이 사용할 수 있다. 새 예시는 `main: index.ts`를 사용한다.
- `npm run typecheck`, `npm test`(15개 파일, 218개 테스트)를 통과했다. 기존 209개 회귀 테스트에 공통 앱·즉시 응답·이미지 전달·tracer와 렌더러 수명 검증 9개를 추가했다.
- 실제 로컬 설정, 새 예시 설정의 기본 진입점, 기존 루트 CI 형식의 설정으로 각각 dry-run을 통과했다. 로컬 서버에서도 새 진입점과 메신저·R2 경로를 확인했다.
- 외부 시세 호출을 고정 fixture로 대체한 Node smoke에서 한글 제목·캔들·거래량을 포함한 960×540 PNG를 생성했다. Node에서 공통 앱과 차트 오케스트레이션도 Cloudflare 런타임 없이 로드했다.
- `src/`의 Cloudflare 런타임 import·바인딩 타입·정적 WASM/TTF import가 제거됐음을 확인했다. 제공자의 기존 `cf` HTTP 캐시 힌트는 4단계, 독립 타입 검사 설정과 import 확장자 정리는 5단계에서 진행한다.

### 4단계 완료 기록

- `src/core/http.ts`에 표준 요청 옵션과 선택적인 캐시 시간 힌트를 받는 `MarketFetch` 계약을 정의했다. Yahoo·Upbit는 팩토리에서 전송 함수를 주입받고 기본값은 호출 시점의 표준 `fetch`를 사용한다.
- `createProviders`가 전송 함수를 각 제공자에 전달하고 Cloudflare 진입점은 `cloudflare/http.ts`를 주입한다. 이 어댑터가 힌트를 `cf.cacheTtl`·`cacheEverything: true`로 변환하며 호출자의 URL·헤더·signal·옵션을 보존한다. 힌트가 없으면 캐시 옵션을 추가하지 않는다.
- 기존 TTL인 Yahoo 차트 300초·검색 3,600초, Upbit 캔들 60초·마켓 검색 3,600초를 보존했다. Yahoo 직전 세션 재조회와 Upbit 모든 페이지·전일 종가 조회에도 같은 힌트를 전달한다.
- KIS의 인증·시세 코드는 변경하지 않았고 새 전송 함수의 강제 캐시 대상에 포함하지 않았다. 시세 주소·조회 범위·응답 해석·오류 구분·제공자 순서는 기존 로직을 유지한다.
- `npm run typecheck`, `npm test`(16개 파일, 225개 테스트), `npm run build:cloudflare`를 통과했다. 기존 218개 회귀 테스트에 옵션 보존·힌트 없는 요청·기본 표준 전송·인스턴스 격리·Yahoo/Upbit TTL·KIS 전송 경로 검증 7개를 추가했다.
- Node에서 고정 응답으로 기본 제공자의 표준 요청 옵션과 Yahoo 전용 영문 원격 검색을 확인했다. 외부 네트워크 호출 없이 검증했다.
- 공통 제공자에서 `cf` 필드와 이를 숨기던 `as RequestInit` 캐스트를 제거했다. 독립 타입 검사와 Deno용 명시적 import 경로는 5단계에서 진행한다.

### 5단계 완료 기록

- 상대 import·re-export·type import·동적 import에 실제 `.ts`·`.d.ts` 경로를 명시하고 디렉토리 import를 `index.ts`로 바꿨다. JSON·WASM·TTF의 기존 확장자는 유지한다.
- `tsconfig.base.json`에 공통 no-emit 옵션을 두고 루트의 공통 Web 표준 검사, Cloudflare 런타임, Node 스크립트, workerd 테스트 설정을 분리했다. `npm run typecheck`는 import 경계 검사와 네 타입 검사를 실행하므로 기존 CI에도 적용된다.
- 공통 검사 프로그램에 Cloudflare 선언·어댑터가 포함되지 않음을 확인하고, 별도 예제의 `KVNamespace` 사용이 실제 컴파일 오류로 차단됨을 확인했다.
- Discord SDK의 선언 파일은 Node 타입을 전이 참조하므로 `types: []`만으로 Node 전역을 완전히 숨길 수 없다. 개발 전용 Babel 7 파서를 사용하는 `scripts/check-boundaries.ts`가 소스의 런타임 모듈·전역, core의 구현 계층 참조, 상대 확장자와 실제 파일 경로를 검사한다.
- 주석·문자열·정규식은 import로 오인하지 않으며 type import와 동적 import도 검사한다. 정상·위반 예제 16개로 경계 검사를 확인했다. 파서 의존성은 기존 Node 최소 버전과 호환되는 개발 의존성으로만 추가했다.
- Web 표준 `BlobPart` 타입에 맞춰 Discord 파일 첨부 경계에서 PNG를 소유 버퍼로 복사한다. 의미를 숨기는 타입 캐스트를 추가하지 않고 기존 PNG 전달 테스트로 바이트 보존을 확인했다.
- `npm run typecheck`, `npm test`(16개 파일, 225개 테스트), `npm run build:cloudflare`를 통과했다. Node smoke도 외부 시세 호출을 고정 응답으로 대체해 한글 제목·캔들·거래량이 포함된 960×540 PNG를 생성했다.
- Supabase의 실제 Deno 의존성 매핑과 Edge Runtime 실행 검증은 해당 구현 단계에서 진행한다.

### 6단계 완료 기록

- `supabase/migrations/`에 시드 문서·정렬된 별칭·요청 기록·토큰 캐시 테이블과 서버 역할 전용 RPC를 추가했다. RLS를 활성화하고 익명·일반 사용자의 테이블·함수·시퀀스 권한을 회수했다.
- `mutate_chart_alias`는 트랜잭션 잠금으로 변경을 직렬화하고 별칭과 요청 기록을 함께 저장한다. 중복 요청의 만료 연장은 오류 결과와 함께 커밋하며, 예상하지 못한 SQL 오류는 변경 전체를 롤백한다. 만료 요청 기록은 변경 시 최대 128개씩 정리한다.
- `read_chart_aliases`는 단일 JSON 스냅샷을 반환해 1,000행 제한 없이 원자적인 전체 목록을 읽는다. 별칭 갱신 순서·삭제 반환값·재전송 방지의 기존 의미를 보존했다.
- `adapters.ts`가 공통 저장소·캐시·이미지 공개 계약을 구현한다. 토큰 만료와 캐시 TTL의 시간 단위를 구분하고, SDK 오류 원문을 사용자 메시지·로그에 전달하지 않는다. Storage는 공개 읽기 PNG 버킷, 5MiB 제한, 임의 객체 키, 86,400초 캐시 헤더를 사용한다.
- 실제 로컬 스키마에서 DB 타입을 생성해 별도 Web 표준 타입 검사에 포함했다. 현재 SDK 2.119.0의 요구사항에 맞춰 개발 Node 최소 버전을 22로 명시했다. CI의 Node 버전은 기존 22를 유지한다.
- SDK 단위 테스트 6개를 추가했다. 전체 `npm test`는 17개 파일·231개 테스트를 통과했고, `npm run typecheck`와 Cloudflare 배포 dry-run도 통과했다.
- `npm run test:supabase`는 CLI 3.1.0·Docker로 임시 프로젝트와 임의 포트를 준비하고 마이그레이션을 적용한 뒤 별도 workerd 설정에서 실제 API를 검증한다. 자격증명은 테스트 바인딩에만 전달하고 종료 시 소유한 컨테이너·볼륨을 정리한다.
- 실제 DB·Storage 통합 테스트 11개가 통과했다. 동시 추가·혼합 변경, 목록 순서, 프로세스 재생성 후 재전송·중복 만료 연장, SQL 실패 시 롤백, 만료 기록 정리, 1,005개 목록, 캐시 만료, 익명·인증 사용자의 접근 거부, 공개 PNG 바이트와 MIME 정책을 확인했다.
- 개발 프로젝트 ID와 포트를 바꾼 복제 작업 공간에서도 11개 통합 테스트가 통과했다. 검증용 초기 스택과 테스트 스택을 모두 정리했고 기존 Docker 서비스는 유지했다.
- Edge Functions 진입점·Deno 매핑은 7단계, 시드 적재·이미지 7일 정리·운영 CI는 8단계에서 연결한다. 원격 Supabase 프로젝트 변경이나 운영 웹훅 전환은 수행하지 않았다.

### 7단계 완료 기록

- `Deno.serve`·`EdgeRuntime.waitUntil`을 연결하고 함수 URL 접두사 제거, 메신저·KIS 설정, 서버 키 선택을 구현했다. 원본 본문 서명 검증과 도움말의 무입출력·무렌더링 경로를 유지한다.
- `deno.json`에 공통 npm 의존성을 고정하고 lockfile을 추가했다. 준비 스크립트가 package-lock과 직접 의존성 버전을 비교하며 WASM·두 폰트·라이선스를 `_assets/`에 복사한다. 자산은 첫 차트에서만 읽고 `static_files`로 포함한다.
- 개발 의존성 Deno 2.9.6으로 실제 진입점·자산·테스트 bootstrap을 검사한다. 로컬 Supabase CLI 3.1.0의 Edge Runtime 1.78.1(호환 Deno 2.1.4)에서도 함수 밖 공통 소스, npm 패키지와 정적 자산을 불러오는 것을 확인했다.
- 통합 검증은 임시 프로젝트에만 테스트 bootstrap·수집 테이블·가짜 메신저 키를 넣는다. 운영 진입점을 그대로 실행하며 Yahoo 시세만 3.5초 지연 fixture로, 메신저 전송만 로컬 DB 수집으로 대체한다. 실제 `.env`와 외부 운영 서비스는 사용하지 않는다.
- 전체 타입 검사, `npm test`(18개 파일·237개 테스트), Cloudflare dry-run을 통과했다. 공통 `src/` 변경은 없다.
- Supabase 통합 검증 16개가 통과했다. 저장소 11개와 서명·도움말·자동완성·Discord 한글 PNG·별칭 권한/재전송·Slack 선/캔들 반복 전송을 확인했다. 시세 지연 중 두 메신저의 초기 응답은 3초 이내다. 로컬 Storage 이미지 확인에는 내부 프록시 URL의 경로를 외부 로컬 API 주소로 연결한다.
- 최초 로컬 검증에서 2,000봉 캔들·거래량 조합이 CPU hard limit으로 종료됐다. 2026-11-16 사용자는 저성능 로컬 머신의 측정값으로 운영 성능을 판정하지 말고 구현 후 배포해 확인하도록 지시했다.
- 이에 따라 CPU 상한이 없는 Deno에서 동일 자산 로더·공통 렌더러로 2,000봉 선·캔들·거래량 PNG를 생성하는 기능 테스트 2개를 추가했고 모두 통과했다. `test:supabase`가 이 테스트도 실행한다. 차트 데이터 집계·표현 변경·운영 CPU 제한 변경은 적용하지 않았다.
- 7단계의 기능 검증을 마쳤으며, 성능 검증은 별도 배포 측정으로 진행한다. 테스트용 컨테이너·볼륨은 정리했다. 8단계 운영 자동화와 운영 웹훅 전환은 진행하지 않았다.

### 7단계 배포·실측 기록 (2026-11-16)

- 사용자 지정 프로젝트 `ylrplxrocwlbejdqflti`에 신규 마이그레이션·봇 시크릿 4개·종목 4,557개와 `stock-chart-bot` 버전 1을 배포했다. 기존 프로젝트 함수·봇 테이블·차트 버킷이 없음을 사전에 확인했고 기존 시크릿을 보존했다.
- 실제 서울 리전에서 JWT와 임의 요청 키로 보호한 일회성 측정 함수를 사용했다. 동일 코어·렌더러·실제 DB에 고정 시세를 주입해 30봉·2,000봉 선/캔들·거래량 조합을 10회 실행했고 모두 960×540 PNG를 반환했다.
- 2,000봉 캔들·거래량의 생성 시간은 워커 최초 호출 682–706ms, 반복 호출 211–215ms였다. 플랫폼 종료 로그의 워커별 누적 CPU는 305–1,252ms였으며 CPUTime 종료는 없었다. 이 값은 외부 시세 API·메신저 전송을 포함한 전체 명령 응답 시간이 아니다.
- 실제 Storage 공개 이미지의 MIME·바이트를 검증하고 해당 객체를 삭제했다. 측정 함수도 삭제했으며 운영 봇 함수만 활성 상태다. 메신저 웹훅 URL 전환과 8단계 자동화는 진행하지 않았다.
- [측정 방법·범위·결과](../performance/supabase-edge-2026-11-16.md), [원시 측정 데이터](../performance/supabase-edge-2026-11-16.json)에 기록했다.

## 확인한 문서

- [Supabase 의존성 관리](https://supabase.com/docs/guides/functions/dependencies): 함수별 `deno.json`, npm 패키지.
- [Supabase 저장소의 외부 상대 import 사례](https://github.com/supabase/supabase/blob/master/supabase/functions/search-embeddings/index.ts): 함수 밖 공유 모듈 참조. 이 프로젝트의 런타임 코드 번들링은 별도 통합 테스트로 검증한다.
- [Supabase WASM](https://supabase.com/docs/guides/functions/wasm): 정적 자산 포함과 CLI/Docker 배포.
- [Supabase 시크릿](https://supabase.com/docs/guides/functions/secrets): 플랫폼 환경변수와 새 서버 키 사전.
- [Supabase 백그라운드 작업](https://supabase.com/docs/guides/functions/background-tasks): `EdgeRuntime.waitUntil`과 로컬 수명 설정.
- [Supabase 웹훅 인증](https://supabase.com/docs/guides/functions/auth#external-webhooks): JWT 검사를 끄고 제공자 서명을 검증하는 방식.
- [Supabase Storage 삭제](https://supabase.com/docs/guides/storage/management/delete-objects): Storage API로 파일 삭제, 배치 제한.
- [Supabase DB 함수 권한](https://supabase.com/docs/guides/database/functions): invoker·search_path·역할별 EXECUTE 제한.
- [Supabase 파일 업로드](https://supabase.com/docs/guides/storage/uploads/standard-uploads): MIME·캐시·upsert 옵션과 공개 URL 발급.
- [Cloudflare 로컬 환경변수](https://developers.cloudflare.com/workers/local-development/environment-variables/): Wrangler 설정과 같은 디렉토리의 `.dev.vars`.
- Wrangler 4.131.0의 로컬 `deploy --help`: 진입점 인자, `--config`, `--dry-run` 확인.
