import { expect, it } from "vitest";
import { MAX_ISSUE_PAGES, openIssues } from "./issues";
import { fakeGithub } from "./testing/fake";

const answering = (responses: unknown[]) => fakeGithub(() => responses.shift());
function node(number: number, repo: string, iterations: unknown[]) {
  return {
    number, title: `Issue ${number}`, url: `https://github.com/${repo}/issues/${number}`,
    updatedAt: "2026-09-30T00:00:00Z", repository: { nameWithOwner: repo },
    assignees: { nodes: [{ login: "eldin" }] },
    projectItems: { nodes: [{ fieldValues: { nodes: iterations } }] },
  };
}
const page = (nodes: unknown[], next: boolean) => ({ data: { repository: { issues: { pageInfo: { hasNextPage: next, endCursor: "c" }, nodes } } } });
const today = "2026-09-30";

it("marks issues in the running iteration", async () => {
  const gh = answering([page([
    node(1, "o/r", [{ title: "Sprint 3", startDate: "2026-09-27", duration: 14, field: { name: "Sprint" } }]),
    node(2, "o/r", [{ title: "Sprint 2", startDate: "2026-09-13", duration: 14, field: { name: "Sprint" } }]),
    node(3, "o/r", [{}, { title: "Sprint 4", startDate: "2026-10-11", duration: 14, field: { name: "Sprint" } }]),
    node(4, "o/r", [
      { title: "Q3", startDate: "2026-07-01", duration: 92, field: { name: "Quarter" } },
      { title: "Iteration 9", startDate: "2026-09-30", duration: 7, field: { name: "Iteration" } },
    ]),
  ], false)]);
  const issues = await openIssues(gh, "o/r", "", today);
  expect(issues.map((i) => [i.number, i.sprint])).toEqual([[1, "Sprint 3"], [2, null], [3, null], [4, "Iteration 9"]]);
  expect(issues[0].assignees).toEqual(["eldin"]);
});

it("reads a bounded number of pages", async () => {
  const gh = answering(Array.from({ length: MAX_ISSUE_PAGES + 1 }, (_, i) => page([node(i + 1, "o/r", [])], true)));
  expect((await openIssues(gh, "o/r", "", today)).length).toBe(MAX_ISSUE_PAGES);
  expect(gh.calls.length).toBe(MAX_ISSUE_PAGES);
});

it("searches only the repository", async () => {
  const gh = answering([{ data: { search: { nodes: [node(5, "o/r", []), node(6, "evil/r", []), {}] } } }]);
  const issues = await openIssues(gh, "o/r", "login repo:evil/r", today);
  expect(issues.map((i) => i.number)).toEqual([5]);
  expect(gh.calls[0].body.variables.q).toBe("repo:o/r is:issue is:open login repo:evil/r");
});

it("reports GraphQL errors and rejects bad repositories", async () => {
  const gh = answering([{ errors: [{ message: "nope" }] }]);
  await expect(openIssues(gh, "o/r", "", today)).rejects.toThrow();
  await expect(openIssues(gh, "../r", "", today)).rejects.toThrow();
});
