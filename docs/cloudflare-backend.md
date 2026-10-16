# Existing Cloudflare backend boundary

## Audit

Previously `/api/chat`, `/api/jobs`, `/api/files`, `/api/artifacts/*`, and six `src/lib/cloud/*.functions.ts` modules executed in the server hosting the frontend. AI provider calls, Drive refresh/upload/read/delete, D1 HTTP queries, research/search, fact-check page reads, repository API reads, runtime GitHub dispatch, fonts for PDF generation and tool APIs consequently ran there. Only OAuth provider exchange, SMTP delivery and runtime runner relay were already executed by the existing `vision` Worker.

Browser REST callers: `cloud/chat-stream.ts`, `builder/jobs-client.ts`, `download.ts`, `pages/project-detail/index.tsx`. Browser RPC callers are routed centrally by `start.ts` (native TanStack serialization unchanged). `cloud/client.ts` initiated OAuth on the frontend host. `useBackgroundTasks.ts` still referenced a retired external task-worker; it now uses existing authenticated `/api/jobs`.

## Implemented path

Frontend → configured Cloudflare endpoint → `cloudflare.entry.ts` → existing application API/RPC handlers → existing provider integrations. Gateway OAuth/mail/runtime handlers remain on the same Worker. Root SSR is disabled and frontend-host API execution returns 503 rather than running with preview credentials. D1 prefers the existing `DB` binding; HTTP access remains a server-side compatibility fallback. No database schema or integration is replaced.

`VITE_CLOUDFLARE_API_URL` is a **public** HTTPS endpoint, defaulting to `https://vision.tusharkantidasofficial.workers.dev`. The existing Worker `ALLOWED_RETURN_ORIGINS` lists exact frontend origins for CORS, CSRF and OAuth returns, including the Worker itself for the app-side `/api/oauth-callback/:provider` return. Never put service credentials in `VITE_*` variables. Native RPC now uses stable handler names across checkout paths; dev IDs are normalized without changing serialization. The Worker still needs the corresponding version of every callable function.

## Remaining runtime step (not an application migration)

The currently served gateway does not implement the application's chat/files/RPC endpoints. Updating request URLs cannot add those handlers. Use the standard production build's `dist/server/index.mjs` with `cloudflare.entry.ts`, then update the **existing `vision` Worker** using `auth-gateway/wrangler.toml`. Its DB and SMTP Secrets Store declarations are retained; retain all currently configured secrets, variables, AI/service bindings and origin entries. No credentials are copied to frontend hosting, no new backend is created, no database is moved. This task does not publish or update a live Worker.

The Worker must retain NVIDIA_API_KEY, GROQ_API_KEY, existing Workers AI binding or REST configuration, Drive OAuth credentials/folder, security hash key, runtime GitHub key and mail authorization configuration as applicable. Secret presence and successful external calls are not established by source code.

## Browser exceptions and limitations

Static fonts/CDN scripts, locally executed PDF/FFmpeg converters, sandboxed generated web previews, ordinary outbound links, and browser speech recognition are frontend resource/OS functions, not privileged application service calls. They are not rerouted as arbitrary API proxies. Google/GitHub OAuth redirects remain intentional browser redirects; exchange/verification/session creation run on Cloudflare.

Cross-origin partitioned cookies are retained. Existing frontend-origin sessions do not automatically transfer to the API origin; users must sign in there. OAuth top-level navigation plus partitioned embedded sessions needs real-browser verification; do not claim OAuth success from unit tests. A different frontend top-level site may require its own sign-in because partitioned cookies are site-scoped.

## Actual verification (2026-10-16)

- Full suite: **72 files passed; 1,214 tests passed; 1 skipped**, 49.98 seconds. New transport tests: 19 (native RPC bytes, stable dev/production IDs, configured REST destinations, credentials, no preview fallback, exact origins, preflights, streams/cookies, gateway preservation and DB binding).
- `tsgo --noEmit`: exit 0. Production build: exit 0. Existing Worker bundle dry-run: exit 0, gzip 3,936.10 KiB; existing DB and SMTP Secrets Store bindings listed. No live publish/update performed. A dependency emitted duplicate-case warnings during bundling.
- Isolated local **workerd**, no production database or credentials: `/health` 200; `/api/chat` preflight 204 with `Access-Control-Allow-Origin: http://localhost:8080`; native `getCurrentUser` RPC 200 with serialized signed-out user result; `/api/files` 401 with CORS, proving the real authorization handler executes. An initial runtime check caught Nitro forwarding bindings on `request.runtime.cloudflare.env`, not the server-entry env argument; this was corrected and the check passed. A transient local broken-pipe warning accompanied startup probes, not the verified final handler responses.
- Real preview browser: session RPC requests targeted `vision.tusharkantidasofficial.workers.dev`, not localhost; no page errors. Preview-local `/api/chat` returned 503 instead of executing. Existing live Worker `/api/chat` preflight returned **405**, no CORS. The preview therefore displays a retrying connection state; authenticated end-to-end AI/Drive/files cannot currently complete.
- Content-route metadata inspected: component-bearing leaves have their own heads; only parent layout wrappers lack leaf heads. No unrelated presentation or Deep Thinking changes.

### Files changed

**Boundary/config:** `cloudflare.entry.ts`, `auth-gateway/wrangler.toml`, `vite.config.ts`, `src/start.ts`, `src/server.ts`, `src/vite-env.d.ts`, `src/routes/__root.tsx`, `src/routes/api/oauth-callback.$provider.ts`, `src/lib/backend.ts`, `src/lib/backend-policy.ts`, `src/lib/rpc-id.ts`, `src/lib/cloud/worker-boundary.ts`.

**Browser callers:** `src/lib/cloud/chat-stream.ts`, `src/lib/cloud/client.ts`, `src/lib/builder/jobs-client.ts`, `src/lib/download.ts`, `src/hooks/useBackgroundTasks.ts`, `src/pages/project-detail/index.tsx`.

**Existing binding/secret reuse:** `src/lib/ai/runtime-env.server.ts`, `src/lib/cloud/d1.server.ts`, `src/lib/cloud/drive.server.ts`, `src/lib/cloud/mail.server.ts`, `src/lib/cloud/oauth.server.ts`, `src/lib/cloud/security.server.ts`, `src/lib/jobs/artifact-store.server.ts`, `src/lib/runtime/github.server.ts`, `src/lib/search/search.server.ts`, `src/lib/tools/ai.server.ts`.

**Tests/rules/report:** `src/test/backend-transport.test.ts`, `AGENTS.md`, `auth-gateway/AGENTS.md`, `roadmap.md`, `docs/cloudflare-backend.md`. The route tree regenerated automatically for the new callback; it was not manually edited.