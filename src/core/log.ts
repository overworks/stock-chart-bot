/** Workers Observability에서 필드로 검색할 수 있게 JSON 한 줄로 남긴다. 사용자 ID와 시크릿은 넣지 않는다. */
export function logEvent(level: "log" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ message, ...fields }));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
