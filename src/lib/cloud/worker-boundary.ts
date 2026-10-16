import { allowedBackendOrigin, backendCors, configuredOrigins, isBackendPath } from "../backend-policy";

type Handler = { fetch(request: Request, env: any, ctx: any): Promise<Response> | Response };

/** Existing gateway endpoints stay intact; the same Worker owns app APIs. */
export function createCloudflareBoundary(application: Handler, gateway: Handler): Handler {
  return {
    async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (!isBackendPath(path)) return gateway.fetch(request, env, ctx);
      const allowed = configuredOrigins(env.ALLOWED_RETURN_ORIGINS);
      const cors = backendCors(request, allowed);
      const origin = request.headers.get("Origin");
      if (origin && !allowedBackendOrigin(origin, request.url, allowed)) {
        return Response.json({ error: "Frontend origin is not allowed." }, { status: 403, headers: cors });
      }
      if (request.method === "OPTIONS") {
        if (!origin) return new Response(null, { status: 403, headers: cors });
        const method = request.headers.get("Access-Control-Request-Method") ?? "GET";
        const requested = (request.headers.get("Access-Control-Request-Headers") ?? "").toLowerCase().split(",").map((v) => v.trim()).filter(Boolean);
        const supported = (cors.get("Access-Control-Allow-Headers") ?? "").toLowerCase().split(",").map((v) => v.trim());
        if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(method) || requested.some((v) => !supported.includes(v))) {
          return new Response(null, { status: 403, headers: cors });
        }
        return new Response(null, { status: 204, headers: cors });
      }
      try {
        const response = await application.fetch(request, { ...env, VISION_BACKEND_RUNTIME: "cloudflare" }, ctx);
        const headers = new Headers(response.headers);
        cors.forEach((value, key) => {
          if (key === "vary") headers.set(key, [headers.get(key), value].filter(Boolean).join(", "));
          else headers.set(key, value);
        });
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      } catch {
        return Response.json({ error: "The Cloudflare backend could not complete the request." }, { status: 500, headers: cors });
      }
    },
  };
}