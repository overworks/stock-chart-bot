# Supabase Edge Functions 배포 및 성능 확인

- 일시: 2026-11-16, 서울 리전 `ap-northeast-2`
- 대상 프로젝트: `ylrplxrocwlbejdqflti` (`aoba`)
- 구현 커밋: `c7567de`
- 배포 함수: `stock-chart-bot`, 버전 1
- 런타임: Supabase Edge Runtime 1.79.1, 호환 Deno 2.1.4
- [측정 데이터](./supabase-edge-2026-11-16.json)

## 결과

로컬 머신에서 CPU 한도로 종료됐던 2,000봉 캔들·거래량 차트가 실제 Supabase 환경에서는 정상 생성됐다. 선·캔들, 거래량 표시, 30봉·2,000봉의 조합을 순차적으로 10회 실행해 모두 HTTP 200과 960×540 PNG를 확인했다. 차트 데이터를 집계하거나 렌더링 표현·운영 CPU 제한을 바꾸지 않았다.

| 입력 | 워커 상태 | 호출 수 | 차트 생성 시간 | 그중 SVG·PNG 생성 시간 |
|---|---|---:|---:|---:|
| 2,000봉 캔들·거래량 | 해당 워커 최초 호출 | 2 | 682–706ms | 592–593ms |
| 2,000봉 캔들·거래량 | 같은 워커 반복 호출 | 2 | 211–215ms | 209–212ms |
| 2,000봉 선·거래량 | 해당 워커 최초 호출 | 1 | 639ms | 525ms |
| 2,000봉 선·거래량 | 같은 워커 반복 호출 | 1 | 466ms | 463ms |
| 30봉 캔들·거래량 | 같은 워커 반복 호출 | 2 | 37–109ms | 36–108ms |
| 30봉 선 | 해당 워커 최초 호출 | 1 | 226ms | 142ms |
| 30봉 선 | 같은 워커 반복 호출 | 1 | 77ms | 77ms |

「최초 호출」은 측정 함수가 발급한 워커 ID별 호출 순번 1을 뜻한다. 플랫폼의 전체 콜드 스타트 비용과 같은 값은 아니다. 표의 차트 생성은 함수 내부 `runChart` 실행 시간이며, SVG·PNG 생성은 `chart.render` 스팬으로 SVG 생성·자산 지연 로드·WASM 초기화·래스터화·PNG 인코딩을 포함한다. 클라이언트에서 관찰한 HTTP 시간은 별도 JSON에 기록했다.

플랫폼 종료 로그에서도 4개 워커를 확인했다. CPU 사용량은 해당 워커가 처리한 여러 호출의 누적 값이며, 개별 요청의 CPU 사용량이 아니다. 종료 사유는 모두 `EarlyDrop`이었고 `CPUTime` 종료는 없었다.

| 워커 | 처리한 호출 수 | 종료 시 누적 CPU |
|---|---:|---:|
| A | 3 | 1,067ms |
| B | 2 | 1,252ms |
| C | 3 | 1,183ms |
| D | 2 | 305ms |

## 측정 범위

실제 배포된 런타임에서 동일한 `runChart`, 제공자 파서, 자산 로더, 공통 resvg 렌더러, Supabase DB 종목 저장소를 사용했다. 종목 시드는 저장소의 4,557개 목록을 적재했다. 시세만 로컬 실패 재현과 같은 고정 입력으로 주입해 외부 API 지연을 제외했다.

이 측정은 차트 코어 생성 비용을 확인한다. Discord·Slack 서명 검증, 초기 응답, 실제 시세 API 지연, 메신저 전송, 동시 부하 전체를 측정한 값은 아니다. 초기 응답과 백그라운드 결과 전송은 별도의 로컬 Edge Runtime 통합 테스트로 검증했다. 고정 입력 10회 결과만으로 모든 종목·부하에 대한 성능을 보장하지 않는다.

측정 함수는 JWT 검증과 별도의 임의 요청 키로 보호했다. 공개 명령이나 성능 측정용 경로를 운영 봇에 추가하지 않았다. 측정 종료 후 임시 함수를 삭제했다.

## 배포 확인

- 신규 마이그레이션 `20261114000000_chart_storage.sql` 적용.
- 기존 Cloudflare 로컬 설정의 Discord·KIS 환경변수 4개를 Supabase 시크릿으로 등록. 기존 프로젝트 시크릿은 보존했다.
- 운영 함수 기본 경로 HTTP 200, 미서명 `/discord`·`/slack` 요청 HTTP 401 확인.
- 실제 Storage에 측정 PNG 한 개를 저장하고 공개 URL의 MIME·전체 바이트를 확인한 뒤 해당 객체를 삭제.
- 임시 측정 함수 삭제 후 운영 `stock-chart-bot`만 활성 상태인 것을 확인.

운영 URL은 `https://ylrplxrocwlbejdqflti.supabase.co/functions/v1/stock-chart-bot`이다. 메신저 웹훅 URL 전환은 수행하지 않았다. 종목 시드 재적재·이미지 7일 정리·배포 CI 자동화는 계획의 8단계에서 진행한다.

이번 배포에 사용한 CLI 3.1.0 명령은 다음과 같다. 시크릿 파일은 Git에서 제외한다.

```bash
npm run prepare:supabase
supabase db push --remote=ylrplxrocwlbejdqflti --skip-vault --yes
supabase secrets set --env-file supabase/functions/.env --remote=ylrplxrocwlbejdqflti --yes
supabase functions deploy stock-chart-bot --remote=ylrplxrocwlbejdqflti --yes
```

## 재확인 방법

후속 측정도 운영 코어·렌더러를 import하는 일회성 보호 함수를 사용한다. 같은 시세 입력과 차트 옵션으로 워커 ID·호출 순번·생성 시간·PNG 크기를 기록하고, 각 PNG의 서명과 960×540 크기를 검사한다. 함수·검증 이미지는 종료 시 제거한다. 실제 외부 API와 메신저를 포함한 시간은 이 코어 측정과 구분해 기록한다.

플랫폼 CPU 값은 종료 이벤트의 `cpu_time_used`를 확인한다. 동일 워커의 여러 호출이 같은 실행 ID로 기록되므로 종료 CPU 값을 개별 요청의 렌더링 시간과 동일시하지 않는다. [종료 이벤트 설명](https://supabase.com/kb/troubleshooting/edge-function-shutdown-reasons-explained), [호스팅 로그 조회](https://supabase.com/docs/guides/observability/advanced-log-filtering)를 참고한다.
