// Public transport configuration only. Service credentials never belong here.
import { stableRpcPath } from "./rpc-id";
export const DEFAULT_BACKEND_URL = "https://vision.tusharkantidasofficial.workers.dev";

export function normalizeBackendUrl(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("Cloudflare API endpoint must be an HTTPS URL without credentials, query or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function backendUrl(path: string, base = import.meta.env.VITE_CLOUDFLARE_API_URL || DEFAULT_BACKEND_URL): string {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Expected an application API path.");
  return `${normalizeBackendUrl(base)}${path}`;
}

/** Native TanStack RPC supplies its serialized request to this fetch unchanged. */
export async function backendFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = input instanceof Request ? input.url : String(input);
  const parsed = new URL(raw, typeof window === "undefined" ? DEFAULT_BACKEND_URL : window.location.origin);
  if (!/^\/(api\/|_serverFn\/)/.test(parsed.pathname)) throw new Error("Not an application backend request.");
  const target = backendUrl(stableRpcPath(parsed.pathname) + parsed.search);
  const options = { ...init, credentials: "include" as const };
  const response = input instanceof Request
    ? await fetch(new Request(target, input), options)
    : await fetch(target, options);
  if (response.status === 404 && parsed.pathname.startsWith("/_serverFn/")) {
    throw new Error("The Cloudflare backend does not have this application's matching request handlers yet.");
  }
  return response;
}

export function backendOAuthUrl(provider: "google" | "github", returnOrigin: string): string {
  const url = new URL(backendUrl(`/api/oauth/${provider}`));
  url.searchParams.set("return_to", returnOrigin);
  return url.toString();
}