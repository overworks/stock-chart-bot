import { RANGE_CHOICES, STYLE_CHOICES, VOLUME_KEYWORDS } from "../core/command";

export function helpText(platform: "discord" | "slack"): string {
  const discord = platform === "discord";
  const bold = discord ? "**" : "*";
  const examples = discord
    ? [
      "/stock-chart ticker:삼성전자",
      "/stock-chart ticker:AAPL range:1m style:candle volume:True",
      "/stock-chart ticker:AAPL from:2024-01-01 to:2024-06-30",
    ]
    : [
      "/stock-chart 삼성전자",
      "/stock-chart AAPL 1m candle volume",
      "/stock-chart AAPL 2024-01-01 2024-06-30",
    ];

  return [
    `${bold}봇 사용법${bold}`,
    "`/stock-help`로 이 안내를 다시 볼 수 있습니다. 도움말은 본인에게만 표시됩니다.",
    "",
    `${bold}차트 조회 — /stock-chart${bold}`,
    discord
      ? "`/stock-chart ticker:종목 [range:기간] [style:종류] [volume:True]`"
      : `\`/stock-chart 종목 [기간] [종류] [${VOLUME_KEYWORDS.join("|")}]\``,
    `• 기간: ${RANGE_CHOICES.map((range) => `\`${range}\``).join(" · ")} (기본 \`1d\`).`,
    "  d=일, w=주, m=개월, y=년, max=최대 기간.",
    `• 종류: ${STYLE_CHOICES.map((style) => `\`${style}\``).join(" · ")} (기본 \`line\`: 선 차트, \`candle\`: 봉 차트).`,
    discord
      ? "• 거래량: 기본 숨김. `volume:True`로 표시합니다."
      : `• 거래량: 기본 숨김. ${VOLUME_KEYWORDS.map((word) => `\`${word}\``).join(" 또는 ")}을 붙이면 표시합니다.`,
    discord
      ? "• 날짜 지정: `from:YYYY-MM-DD to:YYYY-MM-DD`."
      : "• 날짜 지정: 종목 뒤에 `YYYY-MM-DD YYYY-MM-DD` (시작일, 종료일).",
    "  시작일과 종료일은 함께 입력하고 시작일이 앞서야 합니다. 날짜 지정은 기간 옵션보다 우선합니다.",
    "예시:",
    ...examples.map((example) => `\`${example}\``),
    "",
    `${bold}종목 입력${bold}`,
    "종목명(`삼성전자`), 별칭(`삼전`), 심볼(`AAPL`, `005930.KS`, `KRW-BTC`, `KRW=X`)을 사용할 수 있습니다.",
    discord
      ? "`ticker` 자동완성에서 종목을 선택하세요. 초성(`ㅅㅅㅈㅈ`) 검색도 지원합니다."
      : "종목을 맨 앞에 쓰고, 이후 옵션은 순서와 관계없이 입력하세요. 자동완성은 지원하지 않습니다.",
    "",
    `${bold}별칭 관리 — /stock-alias${bold}`,
    discord
      ? "추가: `/stock-alias add alias:내삼전 target:삼성전자`"
      : "추가: `/stock-alias add 내삼전 삼성전자`",
    discord
      ? "삭제: `/stock-alias remove alias:내삼전`"
      : "삭제: `/stock-alias remove 내삼전`",
    "목록: `/stock-alias list` — 누구나 조회할 수 있습니다.",
    discord
      ? "추가·삭제는 서버의 ‘관리자’ 또는 ‘서버 관리’ 권한이 있는 사용자만 가능합니다."
      : "추가·삭제는 봇 관리자가 허용한 사용자만 가능합니다.",
  ].join("\n");
}
