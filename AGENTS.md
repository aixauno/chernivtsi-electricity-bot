# Repository formatting

- Use the existing `.prettierrc` and `.editorconfig` for source formatting. Run `npm run format:check` before submitting changes. Use `npm run format` to bring existing files into compliance when the task includes a repository-wide formatting update.
- Preserve the existing Telegram message layout, wording, and typography unless the user explicitly requests a format change. Start every Telegram message with the shared bold city and group heading, the divider `────────────────────` on the next line, and a blank line. Reuse the English and Ukrainian templates in `src/messages.ts`.
- Keep `/status` in this order: bold city and group, NOW and the next actual schedule transition on consecutive lines, then the date, local time label, and outage intervals. Bold the labels, date, and times. Use italics for the local time label. Keep bold command names in `/start` and `/help`.
- Use 24-hour Kyiv time. Keep source names, links, and verification footers out of Telegram messages. Do not add or replace data sources without explicit user instruction. Share the schedule check between automatic alerts and Telegram requests for up to three minutes. Recheck the configured Energy UA group page when that period expires or the Kyiv date changes, and use the previously authorized backup on failure.
- When changing the Telegram format, update the existing message renderers and their tests alongside any new messages.

## Commit messages

- Write one short, descriptive subject in plain English. Start with a capitalized action verb and say what changed.
- Use ordinary words, without prefixes such as `feat:` or `fix:`. Leave off the final period.
- Examples
  - `Add a button to check the outage schedule`
  - `Remove the option to check tomorrow’s schedule`
  - `Fix the power return reminder`

# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command               | Purpose                   |
| --------------------- | ------------------------- |
| `npx wrangler dev`    | Local development         |
| `npx wrangler deploy` | Deploy to Cloudflare      |
| `npx wrangler types`  | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Local Explorer (Debugging & Inspection)

When running `npx wrangler dev`, a Local Explorer API is available for inspecting and debugging local Workers, bindings, and storage state. The API base URL is printed in the terminal when the dev server starts.

Use playwright mcp when needed to do debugging from websites, instead of chatgpt browser extension.

Key endpoints (relative to the dev server URL):

| Endpoint                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /cdn-cgi/local/explorer/api/local/workers`                      | List local Workers and their bindings                                                                                                                                                                                                                                                                                                                                                       |
| `GET /cdn-cgi/local/explorer/api/storage/kv/namespaces`              | List KV namespaces                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /cdn-cgi/local/explorer/api/d1/database`                        | List D1 databases                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /cdn-cgi/local/explorer/api/r2/buckets`                         | List R2 buckets                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /cdn-cgi/local/explorer/api/workers/durable_objects/namespaces` | List Durable Object namespaces                                                                                                                                                                                                                                                                                                                                                              |
| `GET /cdn-cgi/local/explorer/api/workflows`                          | List Workflows                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /cdn-cgi/local/explorer/api/local/observability/query`         | Run a read-only SQL query (SELECT/WITH only) over captured request traces and console logs. Tables: `spans`, `logs` (read attributes via `json(attributes)`). Example: `curl -X POST <base>/cdn-cgi/local/explorer/api/local/observability/query -H 'Content-Type: application/json' -d '{"sql":"SELECT service, name, outcome, duration_ms FROM spans WHERE parent_id IS NULL LIMIT 20"}'` |
| `POST /cdn-cgi/local/explorer/api/local/observability/clear`         | Clear all captured traces and logs                                                                                                                                                                                                                                                                                                                                                          |

If the routes above don't cover what you need, fetch the full OpenAPI schema (large - use only as a last resort): `GET /cdn-cgi/local/explorer/api`

Use the Local Explorer to debug issues by inspecting storage state (KV keys, D1 rows, R2 objects, DO storage), viewing Worker bindings, and querying request traces and logs captured during the dev session.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
