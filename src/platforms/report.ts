import { errorMessage, exceptionAttributes, logEvent } from "../core/log";

export const DELIVERY_FAILED_TEXT = "⚠️ 차트를 전송하지 못했습니다. 잠시 후 다시 시도해 주세요.";

export interface CommandReport {
  platform: "discord" | "slack";
  command: string;
  action?: string;
  started: number;
  /** 명령 실행이 실패해 사용자에게 오류 문구를 보내는 경우 */
  error?: unknown;
}

type Send = () => Promise<Response>;

async function attempt(send: Send): Promise<{ ok: boolean; status?: number; detail?: string }> {
  try {
    const res = await send();
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, detail: (await res.text().catch(() => "")).slice(0, 300) };
  } catch (err) {
    return { ok: false, detail: errorMessage(err) };
  }
}

/** 결과를 전송하고 명령 한 번을 `chart.command.done` 한 줄로 남긴다. 전송이 실패하면 fallback을 한 번 보낸다. */
export async function reportCommand(report: CommandReport, send?: Send, fallback?: Send): Promise<void> {
  const first = send ? await attempt(send) : undefined;
  const retry = first && !first.ok && fallback ? await attempt(fallback) : undefined;
  const outcome = first && !first.ok ? "delivery_failed" : report.error !== undefined ? "failed" : "ok";
  logEvent(outcome === "ok" ? "log" : outcome === "failed" ? "warn" : "error", "chart.command.done", {
    "chart.platform": report.platform,
    "chart.command.name": report.command,
    "chart.command.action": report.action,
    "chart.command.outcome": outcome,
    "chart.duration_ms": Date.now() - report.started,
    "http.response.status_code": first?.status,
    ...(report.error === undefined ? undefined : exceptionAttributes(report.error)),
    "chart.command.delivery_detail": first?.detail,
    "chart.command.fallback": retry && (retry.ok ? "sent" : "failed"),
  });
}
