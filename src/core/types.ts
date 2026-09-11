export type Platform = "discord" | "slack" | "telegram" | "kakao";

export type ChartStyle = "line" | "candle";

export interface ChartRequest {
  ticker: string;
  range?: string;
  from?: string;
  to?: string;
  style?: ChartStyle;
}

export interface ChartBar {
  t: number;
  c: number;
  o?: number;
  h?: number;
  l?: number;
  v?: number;
}

export interface OutgoingMessage {
  text: string;
  image?: { png: Uint8Array; filename: string };
  color?: string;
}

export interface IncomingCommand {
  platform: Platform;
  userId: string;
  channelId: string;
  name: string;
  args: Record<string, string | undefined>;
  reply: (msg: OutgoingMessage) => Promise<void>;
}
