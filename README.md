# stock-chart-bot

Discord/Slack 슬래시 커맨드로 종목 주가 차트를 그려 주는 봇. Cloudflare Workers 엣지에서 동작하며,
플랫폼 중립 `core` + 플랫폼별 `adapter` 구조라 Slack 등 다른 메신저로 확장할 수 있다.

## 사용법

Discord:

```
/chart ticker:<종목> [range:<1d|1w|1m|3m|6m|1y|5y|max>] [style:<line|candle>]
/chart ticker:<종목> from:<YYYY-MM-DD> to:<YYYY-MM-DD> [style:<line|candle>]
```

Slack (자동완성 없음, 종목을 먼저 쓰고 옵션은 순서 무관):

```
/chart <종목> [1d|1w|1m|3m|6m|1y|5y|max] [candle]
/chart <종목> <YYYY-MM-DD> <YYYY-MM-DD> [candle]
```

- `range`를 생략하면 `1d`. `from`/`to`는 둘 다 넣어야 하며 `range`보다 우선한다.
- `style`을 생략하면 종가 라인. `candle`은 봉차트. 둘 다 하단에 거래량이 붙는다.
- `1d`, `1w`는 분봉 기반이라 x축에 거래소 현지 시각이 표시된다.
- 제목은 종목명 기준(`삼성전자 (005930.KS)`)이며, KRX 목록에 없는 종목은 Yahoo의 이름을 쓴다.
- 헤더에 마지막 종가와 등락(금액·%)이 표시된다. `1d`는 전일 종가 대비, 그 외는 조회 구간 첫 종가 대비다. 상승은 빨강·하락은 파랑.
- 일봉 이상 차트에는 MA20(주황)·MA60(보라)이 함께 그려진다. 봉 수가 부족하면 생략한다.
- 환율·암호화폐처럼 24시간 거래되는 상품은 KST로 표시한다. 우하단에 데이터 출처와 생성 시각이 찍힌다.

### 종목 입력

`ticker`에는 한글 종목명, 영문명, 티커 어느 것이든 넣을 수 있다.

| 입력 | 해석 |
|---|---|
| `삼성전자`, `SK하이닉스` | KRX 상장 종목명 → `005930.KS`, `000660.KS` |
| `코스피`, `나스닥`, `애플` | 수동 별칭 → `^KS11`, `^IXIC`, `AAPL` |
| `달러`, `달러/원`, `USDKRW` / `엔`, `엔화`, `JPYKRW` | 환율 → `KRW=X`(USD/KRW), `JPYKRW=X`(JPY/KRW, 100엔 기준으로 환산해 표시) |
| `비트코인` / `이더리움` | 암호화폐 → `BTC-USD`, `ETH-USD`. 원화는 `비트코인/원`, `이더리움/원` |
| `AAPL`, `005930.KS`, `TSLA` | Yahoo Finance 심볼 그대로 |
| `ㅅㅅㅈㅈ`, `삼ㅈ` | 초성 검색 (자동완성에서) |
| `hynix`, `samsung` | Yahoo 검색 결과의 첫 종목 |

자동완성은 KRX 전 종목(KOSPI, KOSDAQ 약 2,600개)과 수동 별칭에서 정확 일치 → 접두 →
부분 문자열 순으로 찾는다. 대소문자와 공백은 무시하며 초성(`ㅅㅅㅈㅈ`)도 인식한다. 영문 입력은 결과가 부족하면
Yahoo 검색으로 보충한다. Yahoo 검색은 한글을 받지 않으므로 한글 종목은 시드 목록에
있어야 한다.

실행 시 별칭은 **정확히 일치할 때만** 적용된다(`GS`는 GS홀딩스, `gs`는 Yahoo에 그대로).
`005930.KS`, `KRW=X`, `BTC-USD`, `^KS11`처럼 이미 Yahoo 심볼 형식이면 별칭을 거치지 않는다.
KRX 약칭과 해외 티커가 겹치면(`GS`, `DB`, `SK`) 자동완성에서 둘 다 보이니 원하는 쪽을 고른다.

## 구조

```
src/
├─ index.ts            # 라우팅 (/discord, /slack, /charts/*)
├─ core/               # 플랫폼 의존성 없음
│  ├─ command.ts       # 인자 검증/정규화
│  ├─ symbols.ts       # 종목 검색 (KV 단일 키 + 메모리 캐시, Yahoo 검색 폴백)
│  ├─ market.ts        # 시세 조회 파사드 (providers 순서대로 시도, 실패 시 다음 제공자)
│  ├─ providers/       # 데이터 소스. yahoo.ts (현재 유일)
│  ├─ chart.ts         # SVG 생성
│  ├─ render.ts        # resvg-wasm SVG→PNG (fonts/ 번들 폰트)
│  ├─ store.ts         # R2 저장 + /charts/<key> 서빙 (URL만 받는 플랫폼용)
│  └─ run.ts           # 오케스트레이션
└─ platforms/
   ├─ discord.ts       # Ed25519 서명 검증, deferred 응답, multipart 업로드
   └─ slack.ts         # HMAC 서명 검증, 3초 ack, response_url 로 이미지 블록 전송
scripts/
├─ fetch-krx-symbols.ts  # KIND 상장법인 목록 → scripts/symbols.json
├─ symbols.manual.json   # 수동 별칭 (우선 적용)
├─ register-commands.ts  # Discord 슬래시 커맨드 등록
└─ smoke.ts              # Yahoo 조회 → PNG 로컬 확인
```

시세와 검색은 Yahoo Finance의 비공개 엔드포인트를 쓴다. 키는 필요 없지만 예고 없이
바뀌거나 막힐 수 있다. `src/core/providers/`에 `MarketProvider`를 하나 더 구현해
`market.ts`의 `PROVIDERS`에 넣으면 앞 제공자가 실패할 때 자동으로 넘어간다.

## 셋업

Discord Developer Portal에서 앱을 만들고 Application ID, Public Key, Bot Token을 확보한다.

```bash
npm install                                # postinstall에서 wasm/resvg.wasm 복사
npx wrangler login
npx wrangler kv namespace create SYMBOLS   # 출력된 id를 wrangler.jsonc에 반영
npx wrangler r2 bucket create stock-chart-bot-charts
cp .dev.vars.example .dev.vars             # DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN, SLACK_SIGNING_SECRET
```

`wrangler.jsonc`의 `DISCORD_APPLICATION_ID`를 자기 앱 ID로 바꾼다.

운영 시크릿과 종목 목록을 올린다.

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET      # Slack을 쓸 때만
npx wrangler r2 bucket lifecycle add stock-chart-bot-charts expire-charts charts/ --expire-days 7
npm run fetch:symbols                      # KRX 목록 + 수동 별칭 → scripts/symbols.json
npm run seed:symbols                       # KV SYMBOLS 의 symbols:v1 키에 적재
```

배포하고 커맨드를 등록한다.

```bash
npm run deploy
set -a; . ./.dev.vars; set +a
DISCORD_APPLICATION_ID=<앱 ID> npm run register            # 글로벌 (전파 최대 1시간)
DISCORD_GUILD_ID=<서버 ID> DISCORD_APPLICATION_ID=<앱 ID> npm run register   # 특정 서버, 즉시
```

마지막으로 Developer Portal → General Information → **Interactions Endpoint URL**에
`https://stock-chart-bot.<subdomain>.workers.dev/discord`를 입력하고, OAuth2 URL
Generator에서 `applications.commands` + `bot` 스코프로 초대 링크를 만들어 서버에 추가한다.

### Slack

[api.slack.com/apps](https://api.slack.com/apps)에서 앱을 만들고:

1. Basic Information → **Signing Secret**을 `SLACK_SIGNING_SECRET` 시크릿으로 등록한다.
2. Slash Commands → `/chart` 생성, Request URL은
   `https://stock-chart-bot.<subdomain>.workers.dev/slack`.
3. 워크스페이스에 설치한다. 봇 토큰이나 추가 스코프는 필요 없다. 응답은 `response_url`로
   보내고, 이미지는 R2에 저장한 뒤 Worker의 `/charts/<key>` URL로 노출한다(7일 후 만료).

## 배포

`main`에 push하면 GitHub Actions가 typecheck → test → dry-run → deploy를 실행한다.
PR에서는 검사만 돈다. 저장소 Secrets에 다음이 필요하다.

- `CLOUDFLARE_API_TOKEN`: "Edit Cloudflare Workers" 템플릿으로 발급
- `CLOUDFLARE_ACCOUNT_ID`

수동 배포는 `npm run deploy`, 롤백은 `npx wrangler rollback`.

## 로컬 개발

```bash
npm run dev                                 # http://localhost:8787/discord
npm test                                    # workerd 런타임에서 vitest 실행
npm run smoke -- "AAPL:1d,005930.KS:1m:candle"   # 차트 PNG를 dist/smoke/ 에 생성
```

## 종목 목록 갱신

GitHub Actions(`refresh-symbols`)가 매주 월요일 09:00 KST에 KIND 목록을 다시 받아
변경이 있으면 `scripts/symbols.json`을 커밋하고 KV에 적재한다. Actions 탭에서 수동 실행도
된다. 로컬에서는 `npm run fetch:symbols && npm run seed:symbols`.

별칭을 추가하려면 `scripts/symbols.manual.json`을 편집하고 push한다. 다음 갱신 때 반영되며,
바로 반영하려면 워크플로를 수동 실행한다. `scripts/symbols.json`은 생성물이라 직접 수정하지
않는다.

## 다른 플랫폼 추가

`src/platforms/<name>.ts`에 어댑터를 만들고 `src/index.ts`에 라우트를 추가한다.
core는 수정하지 않는다. 자세한 규칙은 [CONTRIBUTING.md](./CONTRIBUTING.md).

## 라이선스 고지

차트 폰트는 [나눔스퀘어](https://hangeul.naver.com/fonts)의 서브셋이며 SIL Open Font
License 1.1을 따른다(`fonts/LICENSE-NanumSquare.txt`).
