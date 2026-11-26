// @aura/github-client: GitHub reads and writes shared by the bundled mods.
//
// A TypeScript port of the former crates/aura-github. The functions here are
// stateless: they take a `Github`, which does the actual requests. The
// `github` mod's daemon half owns the one real transport (gh's token, the
// rate-limit gate, the ETag cache, notifications) and serves it over RPC as
// `api.*`; other mods reach it through `remoteGithub(...)`, so every mod
// shares one token, one cache and one rate limit.
//
// Naming: each former Rust function `snake_case(gh, a, b)` is `camelCase(gh, a, b)`
// with the same parameter order. JSON shapes (the types in ./types) are the
// Rust serde shapes, unchanged, so stored data stays compatible.

export * from "./types";
export * from "./github";
export * from "./pulls";
export * from "./timeline";
export * from "./branch";
export * from "./issues";
export * from "./activity";
export * from "./pace";
export * from "./remote";
