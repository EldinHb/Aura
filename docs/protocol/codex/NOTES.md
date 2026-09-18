# Codex app-server protocol (captured 2026-09-17, codex-cli 0.151.0)

`traffic.jsonl` is a real capture of `codex app-server` over stdio (JSONL, JSON-RPC 2.0 without the
`jsonrpc` field). `codex_app_server_protocol.v2.schemas.json` is the schema bundle produced by
`codex app-server generate-json-schema` for the same version.

Flow: `initialize` -> `initialized` -> `thread/start` (or `thread/resume`/`thread/fork`) -> `turn/start` ->
notifications -> `turn/completed`.

Server-initiated requests (have `id` + `method`; answer with `{"id": id, "result": {...}}`):

- `item/commandExecution/requestApproval` — params: `threadId, turnId, itemId, command, cwd, reason,
  commandActions[], proposedExecpolicyAmendment[], availableDecisions[]`. Answer `{"decision": "accept" |
  "acceptForSession" | "decline" | "cancel" | {"acceptWithExecpolicyAmendment": {...}}}`.
- `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`
  (answer `{"answers": {questionId: {"answers": [..]}}}`), `mcpServer/elicitation/request`.

Notifications seen: `thread/started`, `thread/status/changed`, `turn/started`, `turn/completed`,
`item/started`, `item/completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`,
`item/reasoning/textDelta`, `hook/started`, `hook/completed`, `mcpServer/startupStatus/updated`,
`thread/tokenUsage/updated`, `account/rateLimits/updated`, `serverRequest/resolved`,
`remoteControl/status/changed`.

Item types seen or documented: `userMessage`, `agentMessage`, `reasoning`, `commandExecution`,
`fileChange`, `plan`, `mcpToolCall`, `webSearch`, `error`, `contextCompaction`, `enteredReviewMode`,
`exitedReviewMode`, `imageView`, `collabAgentToolCall`, `dynamicToolCall`.

Requests exercised: `initialize`, `model/list`, `thread/start {cwd, approvalPolicy, sandbox, model?}`,
`turn/start {threadId, input:[{type:"text",text}]}`, `turn/interrupt {threadId}`, `thread/list {limit}`,
`skills/list {cwds}`, `mcpServerStatus/list`, `account/read`, `account/rateLimits/read`.
