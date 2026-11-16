import type { BotConfig } from "../../../src/config.ts";

export type EnvReader = (name: string) => string | undefined;

export function serverKey(env: EnvReader): string {
  const keys = env("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const value: unknown = JSON.parse(keys);
      if (value && typeof value === "object" && "default" in value && typeof value.default === "string" && value.default) return value.default;
    } catch {}
    throw new Error("Supabase 서버 키 설정 형식이 올바르지 않습니다.");
  }
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Supabase 서버 키가 필요합니다.");
  return legacy;
}

export function botConfig(env: EnvReader): BotConfig {
  return {
    discordPublicKey: env("DISCORD_PUBLIC_KEY") ?? "",
    discordApplicationId: env("DISCORD_APPLICATION_ID") ?? "",
    slackSigningSecret: env("SLACK_SIGNING_SECRET") ?? "",
    slackAliasAdmins: env("SLACK_ALIAS_ADMINS"),
  };
}
