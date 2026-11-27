/** What a mod's permissions mean, in plain words (Settings › Mods and the approval prompt). */
export function describePermissions(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  if (list(p.process).length) out.push(`Run programs: ${list(p.process).join(", ")}`);
  if (list(p.net).length) out.push(`Reach: ${list(p.net).join(", ")}`);
  if (p.sessions === "read") out.push("Read your sessions and their events");
  if (p.sessions === "write") out.push("Read your sessions, start them and send them messages");
  if (p.git) out.push("Use git in your repositories");
  if (p.agents) out.push("Run agents (read-only) on files");
  if (p.orchestratorTools) out.push("Add tools to orchestrator sessions");
  if (list(p.mods).length) out.push(`Use the mods: ${list(p.mods).join(", ")}`);
  return out.length ? out : ["Nothing beyond its own storage"];
}
