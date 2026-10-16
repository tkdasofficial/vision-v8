<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- `src/AGENTS.md` and `src/lib/AGENTS.md` hold scoped rules; read them before changing files there.
- Chat attachment Plugins uses a controlled shared Popover anchored to the whole composer and selects through its existing plugin-chip callback. Why: keeps the picker above the input without navigating away or duplicating send logic.
- Credentials live only in Cloudflare Secrets/Variables or its Secrets Store and are read at runtime, never in Lovable secrets. Why: Cloudflare is the credential source of truth.
- GitHub CLI (`gh`) is used only for runtime setup tasks sourced from `tkdasofficial/vision-runtime` (runtime provisioning, its `.github` workflows, `runtime/` and `tests/` material); never for app source, code edits, or day-to-day changes. Why: keeps the app codebase (from `tkdasofficial/vision-v7`) separate from runtime provisioning.

- Page UIs live in `src/pages/<page>/index.tsx` (Admin stays in `src/views/admin/`), reusable UI in `src/components/<name>/index.tsx` (shadcn `ui/` keeps its flat files); route files only wrap a page. Old URLs are mapped once in `src/lib/legacy-routes.ts` and redirected by thin legacy route files; OAuth callbacks, `/auth/verify` and APIs are never redirected. Page access is decided in `src/lib/route-access.ts` and enforced once by `RouteGuard` in `__root.tsx`; a failed session check means retry, never signed out. Why: one rule set, no flashes or false logouts.
- Navigate via `@/lib/router-compat`, never react-router-dom. Why: preserves simple calls over TanStack Router.
- Backend is Cloudflare D1 reached from server code only (`src/lib/cloud/*.server.ts`); the browser `supabase`-shaped client in `src/lib/cloud/client.ts` sends every query to one server function that enforces per-table access rules. Why: user chose Cloudflare; keeps view query code unchanged while all permission checks run server-side.
- Sign-in uses PBKDF2 password hashes and hashed session tokens in D1 with an HttpOnly cookie; Google/GitHub OAuth callbacks live at /auth/google/callback and /auth/github/callback; the start endpoint is /api/oauth/$provider. Auth pages live under /auth/* (login, register, forgot-password, verify, reset-password); password reset is two steps: /auth/verify consumes the code and issues a 10-minute single-use HttpOnly reset ticket (hashed in D1 password_reset_tickets), then /auth/reset-password spends it. Why: no third-party auth service; tokens never reach browser scripts.
- Chat AI streams from Cloudflare Workers AI via the signed-in-only /api/chat server route, choosing a model per message. Why: user chose Workers AI for LLM only; keys stay on the server.
- Email verification uses 8-digit codes hashed in D1 `auth_otps`; delivery runs on the Cloudflare gateway Worker (`POST /mail`, Gmail SMTP with SMTP_EMAIL/SMTP_PASSWORD bound from the Cloudflare Secrets Store), and the app calls it with the shared MAIL_TOKEN. Why: mail credentials stay in Cloudflare; codes never stored in plain text.
- User files upload to Google Drive per-type sub-folders via `src/lib/cloud/drive.server.ts`; D1 `user_files` holds the record and link, and browsers can only read their own rows (writes are server-only). Why: Drive is the file store, D1 is the index; chats never touch Drive.
- Security logic lives in root `security/` (pure TS, store-agnostic, tested in `security/tests`); `src/lib/cloud/security.server.ts` binds it to D1 and the request, and every signup entry point (email + OAuth) calls `evaluateSignup`. Why: one policy for all entry points; decisions stay server-side and testable without D1.
- Enterprise Login state lives server-side in D1 keyed by an HttpOnly attempt cookie; domain ownership is proven only by DNS TXT and OTPs are bound to the attempt (details in `src/lib/AGENTS.md`). Why: the browser never holds verification results.
- Session cookie is SameSite=None + Partitioned with 30-day sliding renewal (refreshed at most daily in getCaller); every sign-in is recorded in D1 login_history with user agent and IP (pruned after 180 days). Why: keeps users signed in, including inside embedded previews; every state-changing endpoint must call assertSameOrigin to replace the CSRF protection Lax used to give.

- Workspace pages share fade/grid controls; Settings uses Radix switches/radios. Drafts pass URL context to addChat; ProjectChatHeader uses ProjectMenu; lists sort by creation with pins first. Why: consistent UI and isolated chats.
- Chat replies run detached from the browser request (Worker waitUntil, never request.signal) and the server saves the finished answer into chat_messages under the client reply id with INSERT OR IGNORE; a reopened chat whose last message is an unanswered question polls for it. Why: leaving or reloading never loses an answer.
