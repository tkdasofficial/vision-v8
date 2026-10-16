import { createFileRoute } from "@tanstack/react-router";

// App-side return path; the gateway owns /auth/$provider/callback on the same Worker.
export const Route = createFileRoute("/api/oauth-callback/$provider")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (params.provider !== "google" && params.provider !== "github") return new Response("Not found", { status: 404 });
        const { finishOAuth } = await import("@/lib/cloud/oauth.server");
        return finishOAuth(request, params.provider);
      },
    },
  },
});
