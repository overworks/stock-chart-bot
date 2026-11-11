import { vi } from "vitest";

/** console 출력을 가로채고, 메시지 이름으로 구조화 로그를 찾아 주는 함수를 돌려준다. */
export function captureLogs() {
  const spies = (["log", "warn", "error"] as const).map((level) => ({ level, spy: vi.spyOn(console, level).mockImplementation(() => {}) }));
  return (message: string): Record<string, unknown>[] =>
    spies.flatMap(({ level, spy }) =>
      spy.mock.calls.flatMap((call) => {
        try {
          const event = JSON.parse(String(call[0]));
          return event.message === message ? [{ level, ...event }] : [];
        } catch {
          return [];
        }
      }),
    );
}
