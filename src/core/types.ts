export type Platform = "discord" | "slack" | "telegram" | "kakao";

export interface ChartRequest {
  ticker: string;
  range?: string;
  from?: string;
  to?: string;
}

export interface ChartBar {
  t: number;
  c: number;
}

export interface OutgoingMessage {
  text: string;
  image?: { png: Uint8Array; filename: string };
}

export interface IncomingCommand {
  platform: Platform;
  userId: string;
  channelId: string;
  name: string;
  args: Record<string, string | undefined>;
  reply: (msg: OutgoingMessage) => Promise<void>;
}
