/**
 * Workers Observability에서 필드로 검색할 수 있게 JSON 한 줄로 남긴다. 사용자 ID와 시크릿은 넣지 않는다.
 * 이벤트 이름과 속성 키는 OpenTelemetry 시맨틱 컨벤션을 따른다(표준 속성 우선, 앱 고유 값은 `chart.*`).
 */
export function logEvent(level: "log" | "warn" | "error", name: string, attributes: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ message: name, ...attributes }));
}

/** OpenTelemetry `exception.*` 속성 */
export function exceptionAttributes(err: unknown): Record<string, string> {
  if (!(err instanceof Error)) return { "exception.message": String(err) };
  return { "exception.type": err.name === "Error" ? err.constructor.name : err.name, "exception.message": err.message };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
