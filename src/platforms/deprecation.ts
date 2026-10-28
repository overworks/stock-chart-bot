export function appendDeprecationNotice(command: string | null, text: string): string {
  const name = command?.replace(/^\//, "");
  if (name !== "chart" && name !== "alias") return text;
  return `${text}\n\n⚠️ \`/${name}\` 명령은 지원 중단 예정입니다. \`/stock-${name}\`를 사용해 주세요.`;
}
