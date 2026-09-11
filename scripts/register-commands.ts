import { RANGE_CHOICES, STYLE_CHOICES } from "../src/core/command";

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
        description: "기간 (미입력 시 1d)",
        required: false,
        choices: RANGE_CHOICES.map((r) => ({ name: r, value: r })),
      },
      {
        type: 3,
        name: "style",
        description: "차트 종류 (미입력 시 line)",
        required: false,
        choices: STYLE_CHOICES.map((s) => ({ name: s, value: s })),
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
  {
    name: "alias",
    description: "종목 별칭을 관리합니다",
    default_member_permissions: "32", // MANAGE_GUILD
    options: [
      {
        type: 1,
        name: "add",
        description: "별칭을 추가합니다",
        options: [
          { type: 3, name: "alias", description: "별칭 (예: 삼전)", required: true },
          { type: 3, name: "target", description: "종목명 또는 심볼 (예: 삼성전자, 005930.KS)", required: true, autocomplete: true },
        ],
      },
      {
        type: 1,
        name: "remove",
        description: "별칭을 삭제합니다",
        options: [{ type: 3, name: "alias", description: "삭제할 별칭", required: true, autocomplete: true }],
      },
      { type: 1, name: "list", description: "등록된 별칭을 보여줍니다" },
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
