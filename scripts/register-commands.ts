import { RANGE_CHOICES } from "../src/core/command";

const API = "https://discord.com/api/v10";

const appId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !botToken) {
  console.error(
    "DISCORD_APPLICATION_ID 와 DISCORD_BOT_TOKEN 환경변수가 필요합니다.",
  );
  process.exit(1);
}

const commands = [
  {
    name: "chart",
    description: "종목 주가 차트를 그립니다",
    options: [
      {
        type: 3,
        name: "ticker",
        description: "티커 또는 종목명 (예: 삼성전자, AAPL)",
        required: true,
        autocomplete: true,
      },
      {
        type: 3,
        name: "range",
        description: "기간 (미입력 시 1y)",
        required: false,
        choices: RANGE_CHOICES.map((r) => ({ name: r, value: r })),
      },
      {
        type: 3,
        name: "from",
        description: "시작일 YYYY-MM-DD (range 대신 사용)",
        required: false,
      },
      {
        type: 3,
        name: "to",
        description: "종료일 YYYY-MM-DD",
        required: false,
      },
    ],
  },
];

const url = guildId
  ? `${API}/applications/${appId}/guilds/${guildId}/commands`
  : `${API}/applications/${appId}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${botToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error("커맨드 등록 실패:", res.status, await res.text());
  process.exit(1);
}

console.log(
  guildId ? "길드 커맨드 등록 완료" : "글로벌 커맨드 등록 완료 (전파에 최대 1시간)",
);
