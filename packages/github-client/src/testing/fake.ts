// A `Github` for tests: requests answer from a function, the rest has the trait's defaults.
import type { Memo, Notified } from "../activity";
import { defaults, type Github } from "../github";

export type Answer = (method: string, path: string, body: any) => unknown;

export function fakeGithub(answer: Answer, extra: Partial<Github> = {}): Github & { calls: Array<{ method: string; path: string; body: any }> } {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const gh: Github & { calls: typeof calls } = {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
      return answer(method, path, body);
    },
    requestFor: (account, method, path, body) => defaults.requestFor(gh, account, method, path, body),
    diff: async () => {
      throw new Error("unreachable");
    },
    host: () => "github.com",
    account: () => defaults.account(gh),
    blocked: async () => null,
    pace: async (baseMs) => baseMs,
    notified: async (): Promise<Notified | null> => null,
    memo: (): Memo | null => null,
    ...extra,
  };
  return gh;
}
