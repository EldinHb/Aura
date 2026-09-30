# Claude Code stream-json protocol (captured 2026-09-17, Claude Code 2.1.274)

`traffic.jsonl` is a real capture. Each line: `{"dir": "in"|"out", "t": epoch, "msg": {...}}`.
`out` = written by the host to claude's stdin, `in` = read from stdout.

Launch:

    claude -p --input-format stream-json --output-format stream-json --verbose \
      --include-partial-messages --replay-user-messages --permission-prompt-tool stdio \
      [--resume <session_id>] [--fork-session]

Observed messages (stdout):

- `system/init` — per turn: `session_id`, `model`, `permissionMode`, `tools[]`, `slash_commands[]`, `mcp_servers[]`, `agents[]`, `claude_code_version`, `cwd`.
- `system/status` — `status: "requesting"|null`, optional `permissionMode` after `set_permission_mode`.
- `system/commands_changed` — `commands: [{name, description, argumentHint}]` (full slash command catalogue).
- `system/hook_started`, `system/hook_response`, `system/thinking_tokens`, `rate_limit_event`.
- `user` (isReplay) — echo of our message (because of `--replay-user-messages`), and tool results: `content: [{type: "tool_result", tool_use_id, content, is_error}]`, `tool_use_result: {stdout, stderr, ...}`, `parent_tool_use_id` for subagents.
- `stream_event` — Anthropic streaming events: `message_start`, `content_block_start` (`text` | `tool_use` | `thinking`), `content_block_delta` (`text_delta` | `input_json_delta` | `thinking_delta` | `signature_delta`), `content_block_stop`, `message_delta`, `message_stop`.
- `assistant` — one message per completed content block (`text`, `tool_use{id,name,input}`, `thinking`), with `usage` and `parent_tool_use_id`.
- `control_request` — `request_id`, `request.subtype = "can_use_tool"`, `tool_name`, `display_name`, `input`, `description`, `permission_suggestions[]`, `blocked_path`, `tool_use_id`. AskUserQuestion arrives this way with `input.questions[]`.
- `control_response` — echo of our response, and responses to our requests (`interrupt` -> `{still_queued: []}`, `set_permission_mode` -> `{mode}`).
- `result` — `subtype: success | error_during_execution`, `session_id`, `total_cost_usd`, `usage`, `modelUsage{model:{contextWindow,...}}`, `permission_denials`, `is_error`, `result` (final text), `num_turns`.

Messages we send (stdin):

- `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
- `{"type":"control_response","response":{"subtype":"success","request_id":"...","response":{"behavior":"allow","updatedInput":{...}}}}` or `{"behavior":"deny","message":"..."}`.
  For AskUserQuestion: allow with `updatedInput = input + {"answers": {question: label}}`.
- `{"type":"control_request","request_id":"...","request":{"subtype":"interrupt"}}`
- `{"type":"control_request","request_id":"...","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}`
- Slash commands go in the prompt text, e.g. `/model` returns a synthetic assistant message listing models.

Slash commands (captured 2026-09-30, Claude Code 2.1.280):

- Local commands (`/cost`, `/context`, `/model`, `/effort`, `/config`, `/mcp`, `/usage`, ...) reply with a
  synthetic `assistant` message (`model: "<synthetic>"`) carrying `local_command_source`
  (`<local-command-stdout>...</local-command-stdout>`) and usually `local_command_run: {command, args}`.
  Commands unavailable in `-p` mode (`/status`, `/memory`) omit `local_command_run`. Aura shows these as
  command output, not as agent replies.
- Their `result` has `local_command: "<name>"`, zero `usage`, empty `iterations` and empty `modelUsage`.
- `/clear` emits a top-level `{"type": "conversation_reset", "new_conversation_id"}`, then a new
  `system/init` and a `result` with a new `session_id` (the id to resume from).
- `/compact` (and auto compaction) emits `system/status` with `status: "compacting"`, then `system/status`
  with `compact_result: "success" | "failed"` (plus `compact_error`), then on success
  `system/compact_boundary` with `compact_metadata: {trigger: "manual"|"auto", pre_tokens, post_tokens}`,
  a non-replay `user` message holding the summary, and a replayed `<local-command-stdout>Compacted </local-command-stdout>`.
  A failed compaction repeats `compact_error` as local command output.
