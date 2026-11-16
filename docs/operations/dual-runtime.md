# 두 실행 환경 운영

## 배포 대상과 인증

기본 `dev`, `deploy`, `test`, `seed:symbols` 명령은 Cloudflare를 사용한다. Supabase는 `:supabase` 명령과 명시적인 프로젝트 ref를 사용한다. 두 배포는 별도 저장소를 가지며 자동으로 사용자 별칭을 동기화하지 않는다.

| 대상 | 로컬 설정 | 운영 인증 |
|---|---|---|
| Cloudflare | `cloudflare/wrangler.jsonc`, `cloudflare/.dev.vars` | Wrangler 인증 또는 Cloudflare API 토큰 |
| Supabase 함수 | `supabase/config.toml`, `supabase/functions/.env` | Supabase CLI 3.1.0 인증 또는 `SUPABASE_ACCESS_TOKEN` |
| Supabase 시드·정리 | `SUPABASE_PROJECT_REF` 또는 `SUPABASE_URL` | `SUPABASE_SECRET_KEY`, 기존 서비스 역할 키, 또는 인증된 CLI로 키 조회 |

실제 설정·dotenv·WASM 복사본을 커밋하지 않는다. 함수용 `.env`에는 메신저·선택적 KIS 설정만 두며 플랫폼의 `SUPABASE_` 기본 환경변수는 직접 등록하지 않는다. 시드·정리용 서버 키는 환경변수로 전달한다. GitHub Actions에서는 Secrets를 사용한다.

## Cloudflare 배포

```bash
npm ci
npm run typecheck
npm test
npm run build:cloudflare
npm run deploy:cloudflare
```

로컬 설정은 예시를 복사해 실제 KV·R2 리소스를 지정한다. 기존 루트 `wrangler.jsonc`·`.dev.vars`는 과거 커밋과 호환되도록 보존한다. CI는 기존 `WRANGLER_CONFIG` Variable 전체를 루트 `wrangler.jsonc`로 복원하고 `cloudflare/index.ts`를 명시한다. Variable의 기존 `main` 값을 동시에 변경할 필요가 없다.

Worker 이름·KV 키·R2 버킷·`ALIAS_WRITER` 바인딩·DO 클래스 `AliasWriter`·인스턴스 `aliases:v1`·기존 마이그레이션을 보존한다. R2의 기존 `charts/` 7일 lifecycle 정책도 유지한다.

## Supabase 배포

Docker와 Node.js 22 이상, CLI 3.1.0을 준비한다. 프로젝트를 선택하고 메신저·KIS 시크릿을 한 번 설정한다.

```bash
supabase login
export SUPABASE_PROJECT_REF="<프로젝트 ref>"
supabase secrets set --env-file supabase/functions/.env --remote="$SUPABASE_PROJECT_REF" --yes
npm run deploy:supabase
```

배포 명령은 자산·의존성·시드 입력·대상·CLI 버전을 확인한 뒤 다음 순서로 실행한다.

1. 해당 ref에 DB 마이그레이션을 적용한다. Vault 시크릿은 갱신하지 않는다.
2. 종목 스냅샷이 없을 때만 초기 적재한다. 충돌 시 무시하므로 동시 갱신이 만든 최신 목록을 보존한다.
3. Docker 번들 경로로 `stock-chart-bot` 함수만 배포한다. `static_files`의 WASM·폰트·라이선스를 포함한다.

기존 목록 교체는 `npm run seed:symbols:supabase`로 수행한다. 이 명령은 사용자 별칭·요청 기록·토큰 캐시를 변경하지 않는다. 같은 입력으로 재실행할 수 있고 `--file`로 별도의 유효한 종목 스냅샷을 선택할 수 있다.

`SUPABASE_URL`을 프로젝트 ref와 함께 제공할 때는 같은 프로젝트를 가리켜야 한다. 로컬 서비스는 ref 없이 로컬 URL과 서버 키를 환경변수로 제공한다. 키 조회·SDK 오류에서 자격증명이나 행 데이터를 출력하지 않는다.

## CI와 예약 작업

PR은 운영 시크릿 없이 다음을 검증한다.

- `types`: import 경계와 공통·Cloudflare·Supabase/Deno·Node·테스트 타입.
- `cloudflare`: workerd 테스트와 예시 설정의 배포 dry-run.
- `supabase`: CLI 3.1.0·Docker로 만든 임시 DB·Storage·실제 Edge Runtime, 별도 Deno의 긴 차트 렌더링.

기존 `check` 잡은 세 결과가 모두 성공해야 통과하는 집계 상태로 유지한다. 하나라도 실패·취소되면 배포를 진행하지 않는다. `main` push에서 검증 후 두 배포 잡이 각각 실행된다.

GitHub 저장소의 Actions 설정은 다음과 같다.

| 종류 | 이름 | 용도 |
|---|---|---|
| Variable | `CLOUDFLARE_ENABLED` | 기본 활성. `false`로 설정하면 Cloudflare 배포·시드만 비활성화 |
| Variable | `WRANGLER_CONFIG` | 기존 Cloudflare 운영 설정 전체. 비밀값 제외 |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare 배포·KV 적재 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 계정 |
| Variable | `SUPABASE_PROJECT_REF` | 설정한 경우 Supabase 배포·시드·이미지 정리 활성화 |
| Secret | `SUPABASE_ACCESS_TOKEN` | Supabase 배포 CLI 인증 |
| Secret | `SUPABASE_SECRET_KEY` | Supabase 시드·이미지 정리용 서버 키. 함수에 등록하는 봇 시크릿과 구분 |

Supabase 배포에는 대상 프로젝트의 migration·function 권한이 필요하다. 서버 키를 CLI에서 조회하는 경우 키 조회 권한도 필요하며, `SUPABASE_SECRET_KEY`를 제공하면 그 조회를 생략한다. 시드·정리 잡은 서버 키를 직접 사용하므로 Management API 토큰이나 CLI 설치를 요구하지 않는다. 봇 시크릿은 기존 프로젝트 설정을 유지하며 CI가 로컬 dotenv를 업로드하지 않는다.

`refresh-symbols.yml`은 평일 08:00 KST와 수동 실행, 수동 목록·생성기 변경 시 공통 목록을 한 번 생성한다. 활성화한 대상에 매번 적재하므로 이전 실행에서 한쪽 적재가 실패해도 다음 실행에서 재시도한다. 한쪽 실패가 다른 쪽 적재를 막지 않으며 실패는 최종 잡 실패로 보고한다. 생성 파일 변경은 기존 방식으로 커밋한다. 시드 재적재가 별칭을 초기화하지 않는다.

`cleanup-images.yml`은 매일 03:00 KST 또는 수동 실행으로 Supabase의 7일 경과 차트 PNG를 정리한다. 만료된 객체는 다음 성공한 정리 실행에서 삭제된다. Supabase 배포와 같은 concurrency 그룹으로 동시 실행을 막으며 진행 중인 작업을 취소하지 않는다. Cloudflare는 기존 R2 lifecycle이 정리한다.

설정과 워크플로 파일을 작성한 것만으로 원격 예약 작업이 활성화되지는 않는다. 기본 브랜치 반영과 위 Variables·Secrets 설정 후 GitHub Actions의 실제 실행 결과를 확인한다. 로컬에서는 먼저 미리보기를 실행할 수 있다.

```bash
npm run cleanup:images:supabase -- --dry-run
```

## 운영 웹훅 전환

현재 Cloudflare 운영 웹훅은 이 작업에서 변경하지 않았다. Supabase의 로컬 통합 검증과 [배포 실측](../performance/supabase-edge-2026-11-16.md)은 운영 메신저 전환과 구분한다.

| 경로 | Cloudflare | Supabase |
|---|---|---|
| Discord | `https://<worker>/discord` | `https://<ref>.supabase.co/functions/v1/stock-chart-bot/discord` |
| Slack 세 명령 | `https://<worker>/slack` | `https://<ref>.supabase.co/functions/v1/stock-chart-bot/slack` |

전환 순서는 다음과 같다.

1. 기존 두 웹훅 URL과 대상 ref, 배포 커밋, 시크릿 이름, 별칭 스냅샷 시각을 기록한다.
2. 필요한 플랫폼 시크릿을 확인한다. Slack을 사용하려면 `SLACK_SIGNING_SECRET`와 필요한 `SLACK_ALIAS_ADMINS`를 설정한다. 같은 Discord 앱이면 기존 세 커맨드 등록을 유지한다. 신규 앱은 공통 등록 스크립트에 환경변수 또는 `--vars-file`을 전달한다.
3. 별칭을 이전하려면 관리자들의 add/remove 작업을 조정하고 원본의 일관된 스냅샷을 확보한다. Cloudflare의 원본은 DO이며 KV는 복제본이다. `publishPending`·복제 실패·진행 중인 쓰기를 확인할 수 없으면 KV만으로 최신 원본이라고 판단하지 않는다. DO 원본 추출과 양방향 별칭 이관은 별도 운영 작업이며 시드 명령으로 대신하지 않는다. 독립된 새 별칭 저장소로 사용할 수도 있다.
4. 함수 기본 경로 HTTP 200과 미서명 요청 HTTP 401을 확인한 뒤 Discord Interactions Endpoint와 Slack 세 Request URL을 변경한다.
5. `/stock-help`, Discord 자동완성, 한글 차트·캔들·거래량, `/stock-alias list`, 권한 오류와 이미지 URL을 실제 메신저에서 확인한다. 초기 응답과 최종 결과 전송을 함께 확인한다.
6. 예약 시드·이미지 정리 실행 결과와 `chart.command.done`·`chart.failed` 로그를 확인한다. 이전 배포·데이터는 복구 확인이 끝날 때까지 보존한다.

서명된 운영 메신저 요청과 외부 시세를 포함한 전체 경로 확인은 실제 전환 시 수행할 운영 항목이다. 고정 시세를 사용한 코어 성능 측정과 같은 검증으로 취급하지 않는다.

## 복구

- 코드 체크포인트: 기존 운영 기준 `cedd35f`, Supabase 실행 연결 `c7567de`, 배포 실측 기록 `87b7a73`을 참고한다. 공유한 커밋은 의존성을 확인하고 역순으로 revert한다. 실제 설정·시크릿은 Git에서 복구하지 않는다.
- Cloudflare: 대상 설정의 Worker를 확인하고 `wrangler rollback --config cloudflare/wrangler.jsonc`를 사용하거나 기존 정상 커밋에서 그 커밋의 배포 절차를 실행한다. DO 바인딩·마이그레이션 식별자를 새로 만들지 않는다.
- Supabase 코드: 정상 커밋의 별도 체크아웃에서 `npm ci`, `npm run prepare:supabase` 후 `supabase functions deploy stock-chart-bot --remote=<ref> --yes`로 함수 코드만 재배포한다. 구버전 종목 목록을 자동으로 덮어쓰지 않는다.
- 데이터: Git revert나 함수 재배포는 이미 적용한 DB migration을 취소하지 않는다. 운영 DB를 reset하거나 migration 이력을 지우지 않고 데이터를 보존하는 후속 migration·검증된 백업 복구를 사용한다.
- 웹훅: 기존 URL로 되돌리기 전에 Supabase 전환 후 새로 생긴 별칭을 보존한다. 양쪽 별칭 쓰기가 발생했다면 충돌을 정리하고 원본 스냅샷·변경분을 이관한 후 확인한다. 단순한 URL 복구가 데이터 복구를 대신하지 않는다.

현재 구현 검증과 별도로 남는 운영 항목은 Actions 설정·기본 브랜치 반영, 실제 웹훅 전환, 필요한 별칭 데이터 이관이다. 이 문서의 절차를 자동 실행한 것으로 간주하지 않는다.
