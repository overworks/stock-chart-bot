# stock-chart-bot

Discord와 Slack에서 슬래시 커맨드로 주식·ETF·환율·암호화폐 차트를 그려 주는 봇이다.
Cloudflare Workers 엣지에서 동작하며, 플랫폼 중립적인 `core`와 메신저별 `adapter`를 분리한 구조라 다른 메신저로도 쉽게 확장할 수 있다.

## 사용법

### 차트 조회 (`/stock-chart`)

**Discord**

```
/stock-chart ticker:<종목> [range:<1d|1w|1m|3m|6m|1y|5y|max>] [style:<line|candle>] [volume:<True|False>]
/stock-chart ticker:<종목> from:<YYYY-MM-DD> to:<YYYY-MM-DD> [style:<line|candle>] [volume:<True|False>]
```

**Slack** (자동완성 없음 — 종목을 맨 앞에 쓰고 나머지 옵션은 순서 무관)

```
/stock-chart <종목> [1d|1w|1m|3m|6m|1y|5y|max] [candle] [volume|거래량]
/stock-chart <종목> <YYYY-MM-DD> <YYYY-MM-DD> [candle] [volume|거래량]
```

**옵션 및 차트 표시 규칙**

- `range`를 생략하면 기본값은 `1d`다. `from`과 `to`는 반드시 함께 입력해야 하며, 지정하면 `range`보다 우선한다.
- `style`을 생략하면 종가 선 차트(`line`), `candle`을 지정하면 봉 차트를 그린다.
- 거래량은 기본적으로 표시하지 않는다. Discord에서 `volume:True`, Slack에서 `volume` 또는 `거래량`을 붙이면 차트 하단에 거래량 막대를 함께 그린다.
- 차트 제목은 `삼성전자 (005930.KS)`처럼 정식 종목명과 심볼을 함께 표기하며, 내부 목록에 없는 해외 종목 등은 시세 제공자의 종목명을 사용한다.
- 상단에는 최근가와 등락폭(금액·등락률)을 표시한다. `1d`는 전일 종가 대비(차트에 전일 종가 점선 표시), 그 외 기간은 조회 구간 첫 봉 종가 대비로 계산하며 상승은 빨간색, 하락은 파란색으로 나타낸다.
- `1d`(5분봉)와 `1w`(30분봉)는 장중 차트이므로 가로축에 거래소 현지 시각을 표시한다. 환율·암호화폐처럼 24시간 거래되는 상품은 한국 시각(KST) 기준으로 표시한다.
- 국내 주식과 미국 주식의 `1d` 차트는 프리마켓·애프터마켓 시세를 포함하며, 정규장 밖 구간은 회색 배경과 `프리마켓`·`애프터마켓` 라벨로 구분한다.
- 일봉 이상 차트에는 20일(주황)·60일(보라) 이동평균선(`MA20`·`MA60`)을 함께 그리며, 봉 수가 부족하면 생략한다.
- 차트 우측 하단과 메시지에 데이터 출처와 생성 시각(KST)을 표시한다.

### 종목 입력

`ticker`에는 한글 종목명, 영문명, 줄임말 별칭, 티커 심볼 중 어느 것이든 입력할 수 있다.

| 입력 예시 | 해석 결과 |
|---|---|
| `삼성전자`, `SK하이닉스` | KRX 상장 종목명 → `005930.KS`, `000660.KS` |
| `KODEX 200`, `TIGER 미국S&P500` | 국내 상장 ETF·ETN → `069500.KS`, `360750.KS` |
| `삼전`, `하닉`, `삼바`, `엔솔`, `네이버`, `현대차`, `포스코` | 줄임말 별칭 → 정식 종목으로 매핑 |
| `코스피`, `나스닥`, `애플` | 수동 별칭 → `^KS11`, `^IXIC`, `AAPL` |
| `달러`, `달러/원`, `USDKRW` / `엔`, `엔화`, `JPYKRW` | 환율 → `KRW=X`(USD/KRW), `JPYKRW=X`(JPY/KRW, 100엔 기준으로 환산) |
| `비트코인`, `이더리움`, `리플`, `도지코인`, `KRW-SOL` | 업비트 원화 마켓 → `KRW-BTC`, `KRW-ETH`, `KRW-XRP`, `KRW-DOGE`, `KRW-SOL` |
| `비트코인/달러`, `이더리움/달러` | 달러 기준 암호화폐 시세 → `BTC-USD`, `ETH-USD` (Yahoo Finance) |
| `AAPL`, `005930.KS`, `TSLA` | Yahoo Finance 심볼 그대로 조회 |
| `ㅅㅅㅈㅈ`, `삼ㅈ` | 초성 검색 (Discord 자동완성) |
| `hynix`, `samsung` | 영문 검색 폴백 (첫 번째 검색 결과) |

- **자동완성 및 검색**: KRX 상장 종목(KOSPI·KOSDAQ 주식 약 2,700개, ETF·ETN 약 1,500개), 업비트 원화 마켓(약 290개), 등록된 별칭에서 **정확 일치 → 접두사 일치 → 부분 일치** 순으로 찾는다. 대소문자와 공백을 무시하며 초성(`ㅅㅅㅈㅈ`)도 인식한다. 영문 입력은 내부 목록 결과가 부족하면 Yahoo Finance 검색으로 보충한다(Yahoo 검색은 한글 질의를 지원하지 않으므로 한글 종목명은 시드 목록이나 별칭에 있어야 한다).
- **별칭 해석 규칙**: 실행 시 별칭은 **입력값과 정확히 일치할 때만** 적용된다(예: `GS`는 GS홀딩스로 매핑되지만, `gs`는 그대로 Yahoo에서 조회). `005930.KS`, `KRW=X`, `BTC-USD`, `^KS11`처럼 이미 심볼 형식인 입력은 별칭 매핑을 거치지 않는다. 국내 약칭과 해외 티커가 겹치는 경우(`GS`, `DB`, `SK` 등) 자동완성 목록에 둘 다 표시되므로 원하는 종목을 선택하면 된다.
- **표시 이름**: 별칭은 검색과 종목 해석에만 쓰이며, 자동완성 목록과 차트 제목에는 항상 정식 종목명이 표시된다(`삼전` 입력 → `삼성전자 (005930.KS)`).

### 별칭 관리 (`/stock-alias`)

```
/stock-alias add <별칭> <종목명|심볼>     예: /stock-alias add 내삼전 삼성전자
/stock-alias remove <별칭>
/stock-alias list
```

- `list`는 누구나 실행할 수 있다. `add`와 `remove`는 Discord에서는 서버 관리 권한(`관리자` 또는 `서버 관리`)이 있는 사용자만, Slack에서는 `SLACK_ALIAS_ADMINS`에 등록된 사용자만 실행할 수 있다.
- 별칭을 추가하는 방법은 두 가지다.
  1. **채팅 명령어**: `/stock-alias add 내삼전 삼성전자`처럼 종목명이나 심볼을 지정해 추가한다. KV의 `aliases:v1` 키에 별도로 저장되므로 주간 종목 목록 갱신에 덮어써지지 않는다.
  2. **수동 별칭 파일**: 저장소의 `scripts/symbols.manual.json`을 수정해 `main`에 push하면 `refresh-symbols` 워크플로가 자동으로 실행되어 KV에 반영한다.

> [!NOTE]
> 이전 버전의 `/chart`, `/alias` 명령은 제거되었다. `/stock-chart`와 `/stock-alias`만 사용한다.

## 데이터 출처

종목 유형에 따라 아래 순서로 시세를 조회한다.

1. **업비트 (`Upbit`)**: `KRW-BTC` 등 업비트 원화 마켓 암호화폐를 공개 API로 조회해 국내 원화 체결가를 보여 준다(직접 날짜 지정 조회는 최대 2,000일). 달러 시세가 필요하면 `비트코인/달러` 또는 `BTC-USD`를 사용한다.
2. **한국투자증권 (`KIS`)**: `KIS_APP_KEY`와 `KIS_APP_SECRET`이 설정된 경우 국내 주식·ETF·ETN(`.KS`, `.KQ`)을 먼저 조회한다. `1d` 차트는 KRX+NXT 통합 시세(프리마켓 08:00 ~ 애프터마켓 20:00)를 지원한다. 설정이 없거나 조회에 실패하면 자동으로 Yahoo Finance로 넘어간다.
3. **Yahoo Finance**: 해외 주식, 지수, 환율, 선물 및 한국투자증권 폴백 시세를 비공개 차트·검색 엔드포인트로 조회한다(별도 API 키 불필요). 미국 주식의 `1d` 차트는 프리마켓(04:00 ET)부터 애프터마켓(20:00 ET)까지 포함한다.

## 설치 및 배포

### 1. 사전 준비 및 리소스 생성

Discord Developer Portal에서 앱을 생성해 **Application ID**, **Public Key**, **Bot Token**을 확보한 뒤 아래 명령을 실행한다.

```bash
npm install                                # postinstall에서 wasm/resvg.wasm 자동 복사
npx wrangler login
npx wrangler kv namespace create stock-chart-bot --binding KV
npx wrangler r2 bucket create stock-chart-bot-charts
cp .dev.vars.example .dev.vars             # 로컬 개발 및 커맨드 등록용 환경변수 입력
```

`wrangler.jsonc`의 KV 네임스페이스 `id`를 자신의 값으로 변경한다.

### 2. 시크릿 등록 및 종목 데이터 적재

```bash
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET      # Slack 연동 시
npx wrangler secret put SLACK_ALIAS_ADMINS        # Slack 별칭 관리자 멤버 ID (쉼표 구분, 선택)
npx wrangler secret put KIS_APP_KEY               # 한국투자증권 Open API (선택, 미설정 시 Yahoo 사용)
npx wrangler secret put KIS_APP_SECRET            # 한국투자증권 Open API (선택)
npx wrangler r2 bucket lifecycle add stock-chart-bot-charts expire-charts charts/ --expire-days 7
npm run fetch:symbols                             # KRX 주식 + ETF/ETN + 업비트 + 수동 별칭 → scripts/symbols.json
npm run seed:symbols                              # KV의 symbols:v1 키에 적재
```

### 3. 배포 및 Discord 연동

```bash
npm run deploy
npm run register                                  # 글로벌 커맨드 등록 (전파에 최대 1시간 소요)
DISCORD_GUILD_ID=<서버 ID> npm run register        # 특정 서버에 즉시 등록
```

- `npm run register`는 프로젝트 루트의 `.dev.vars`에서 `DISCORD_APPLICATION_ID`와 `DISCORD_BOT_TOKEN`을 자동으로 읽는다(환경변수를 직접 지정하면 환경변수가 우선한다).
- 등록 시 `/stock-chart`, `/stock-alias` 두 명령으로 전체 덮어쓰기되므로, 이전에 등록된 구버전 명령(`/chart`, `/alias`)도 함께 정리된다.
- Discord Developer Portal → **General Information** → **Interactions Endpoint URL**에 `https://stock-chart-bot.<subdomain>.workers.dev/discord`를 입력하고, **OAuth2 URL Generator**에서 `applications.commands`와 `bot` 스코프로 초대 링크를 만들어 서버에 봇을 추가한다.

### 4. Slack 연동 (선택)

[api.slack.com/apps](https://api.slack.com/apps)에서 앱을 생성한 뒤 다음 순서로 설정한다.

1. **Basic Information** → **Signing Secret** 값을 `SLACK_SIGNING_SECRET` 시크릿으로 등록한다.
2. **Slash Commands**에서 `/stock-chart`(필수)와 `/stock-alias`(선택)를 생성하고, Request URL을 모두 `https://stock-chart-bot.<subdomain>.workers.dev/slack`으로 설정한다.
3. Slack에서 별칭 추가·삭제를 허용할 사용자의 멤버 ID를 쉼표로 구분해 `SLACK_ALIAS_ADMINS` 시크릿에 등록한다(미설정 시 `/stock-alias list`만 가능).
4. 워크스페이스에 앱을 설치한다. 별도의 봇 토큰이나 OAuth 스코프는 필요하지 않다. 응답은 `response_url`로 전송하며, 차트 이미지는 R2에 저장한 뒤 `/charts/<key>` URL로 서빙한다(7일 후 자동 만료).

### 5. CI/CD 및 종목 목록 자동 갱신

- **자동 배포 (`deploy.yml`)**: `main` 브랜치에 push하면 GitHub Actions가 `typecheck` → `test` → `dry-run` → `deploy`를 차례로 실행한다(PR에서는 검증만 실행). 저장소 Secrets에 `CLOUDFLARE_API_TOKEN`("Edit Cloudflare Workers" 템플릿)과 `CLOUDFLARE_ACCOUNT_ID`를 등록해야 한다. 수동 배포는 `npm run deploy`, 롤백은 `npx wrangler rollback`을 사용한다.
- **종목 목록 갱신 (`refresh-symbols.yml`)**: 매주 월요일 09:00 KST마다 KIND·네이버 금융·업비트 목록을 새로 받아 변경 사항이 있으면 `scripts/symbols.json`을 커밋하고 KV(`symbols:v1`)에 적재한다. `scripts/symbols.manual.json`이나 `scripts/fetch-krx-symbols.ts`가 `main`에 push될 때도 즉시 실행되며, GitHub Actions 탭에서 수동으로도 실행할 수 있다.

## 개발 및 기여

```bash
npm run dev                                        # 로컬 개발 서버 (http://localhost:8787)
npm test                                           # workerd 런타임에서 테스트 실행
npm run smoke -- "AAPL:1d,005930.KS:1m:candle"     # 로컬 PNG 렌더링 확인 (dist/smoke/)
```

아키텍처, 내부 모듈 구조, 새 메신저 플랫폼이나 데이터 소스를 추가하는 방법은 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고한다.

## 라이선스 고지

차트 렌더링에 번들된 폰트는 [나눔스퀘어](https://hangeul.naver.com/fonts)의 서브셋이며 SIL Open Font License 1.1을 따른다(`fonts/LICENSE-NanumSquare.txt`).
