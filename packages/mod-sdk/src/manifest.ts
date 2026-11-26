// mod.json. aurad validates it (crates/aura-mods/src/manifest.rs); keep the two in step.

export interface ModPermissions {
  /** Programs the daemon half may run through aura.process.run. */
  process?: string[];
  /** Hosts aura.http.fetch may reach. "*.example.com" matches subdomains. */
  net?: string[];
  sessions?: "none" | "read" | "write";
  git?: boolean;
  agents?: boolean;
  orchestratorTools?: boolean;
  /** Other mods this one may call and listen to. */
  mods?: string[];
}

export interface ModSetting {
  key: string;
  type: "string" | "number" | "boolean" | "select" | "string[]";
  label: string;
  description?: string;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  description?: string;
  author?: string;
  daemon?: string;
  ui?: string;
  styles?: string;
  dependsOn?: Record<string, string>;
  permissions?: ModPermissions;
  settings?: ModSetting[];
}
