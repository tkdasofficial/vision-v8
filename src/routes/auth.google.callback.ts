import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { finishOAuth } = await import("@/lib/cloud/oauth.server");
        return finishOAuth(request, "google");
      },
    },
  },
});
