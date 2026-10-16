import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { backendFetch } from "./lib/backend";
import { allowedBackendOrigin, configuredOrigins, isBackendPath } from "./lib/backend-policy";
import { getSecret } from "./lib/ai/runtime-env.server";

const backendTransport = createMiddleware({ type: "function" }).client(({ next }) =>
  next({ fetch: backendFetch }),
);

// Fail closed: a frontend host must never execute an API handler with local credentials.
const backendBoundary = createMiddleware().server(({ request, pathname, handlerType, next }) => {
  if ((handlerType === "serverFn" || isBackendPath(pathname)) && getSecret("VISION_BACKEND_RUNTIME") !== "cloudflare") {
    return Response.json({ error: "Use the configured Cloudflare API endpoint." }, { status: 503 });
  }
  return next();
});

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Start installs this automatically when src/start.ts is absent; defining the
// file opts out, so re-add it explicitly to keep server functions protected
// from cross-site requests.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
  secFetchSite: (_value, ctx) => allowedBackendOrigin(ctx.request.headers.get("origin"), ctx.request.url, configuredOrigins(getSecret("ALLOWED_RETURN_ORIGINS"))),
  origin: (value, ctx) => allowedBackendOrigin(value, ctx.request.url, configuredOrigins(getSecret("ALLOWED_RETURN_ORIGINS"))),
});

export const startInstance = createStart(() => ({
  functionMiddleware: [backendTransport],
  requestMiddleware: [errorMiddleware, backendBoundary, csrfMiddleware],
}));
