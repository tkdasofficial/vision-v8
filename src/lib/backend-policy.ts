// Shared pure boundary rules; never trust a browser-supplied forwarding header.
export function configuredOrigins(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter((s) => {
    try { return new URL(s).origin === s; } catch { return false; }
  });
}

export function isBackendPath(path: string): boolean {
  return /^\/(api(?:\/|$)|_serverFn(?:\/|$))/.test(path) || /^\/auth\/(google|github)\/callback$/.test(path);
}

export function allowedBackendOrigin(origin: string | null, requestUrl: string, allowed: string[]): boolean {
  return origin !== null && (origin === new URL(requestUrl).origin || allowed.includes(origin));
}

export function backendCors(request: Request, allowed: string[]): Headers {
  const headers = new Headers({ "Vary": "Origin", "Cache-Control": "no-store" });
  const origin = request.headers.get("Origin");
  if (allowedBackendOrigin(origin, request.url, allowed) && origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-TSR-Redirect, X-TSR-ServerFn");
    headers.set("Access-Control-Expose-Headers", "X-Vision-Execution, X-Vision-Output, X-Vision-Model, Content-Disposition, Content-Length");
  }
  return headers;
}