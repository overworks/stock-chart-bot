# stock-chart-bot

슬래시 커맨드로 종목 주가 차트를 그려 주는 봇. Cloudflare Workers 엣지에서 동작하며,
core(플랫폼 중립) / adapter(플랫폼별) 구조로 되어 있어 다른 메신저로 확장 가능하다.

## 명령

```
/chart ticker:<종목> [range:<1d|1w|1m|3m|6m|1y|5y|max>]
/chart ticker:<종목> from:<YYYY-MM-DD> to:<YYYY-MM-DD>
```

## 구조

```
src/
├─ index.ts            # 라우팅 (/discord, ...)
├─ core/               # 플랫폼 의존성 없음
│  ├─ command.ts       # 인자 검증/정규화
│  ├─ market.ts        # 시세 조회 + 캐시
│  ├─ chart.ts         # SVG 생성
│  ├─ render.ts        # resvg-wasm SVG→PNG
│  └─ run.ts           # 오케스트레이션
└─ platforms/
   └─ discord.ts       # 서명 검증, deferred, multipart 업로드
```

## 셋업

```bash
npm install
npx wrangler kv namespace create SYMBOLS   # 출력된 id를 wrangler.jsonc에 반영
npx wrangler r2 bucket create stock-chart-bot-charts
cp .dev.vars.example .dev.vars             # 값 채우기
```

시크릿 등록:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

## 로컬 개발

```bash
npm run dev        # http://localhost:8787/discord
```

## 배포 & 커맨드 등록

```bash
npm run deploy
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register
```

배포 후 Discord Developer Portal 의 Interactions Endpoint URL 에
`https://stock-chart-bot.<subdomain>.workers.dev/discord` 를 입력한다 (PING 검증 통과 필요).

## 다른 플랫폼 추가

`src/platforms/<name>.ts` 에 어댑터를 만들고 `index.ts` 에 라우트를 추가한다.
core 는 수정할 필요가 없다.
