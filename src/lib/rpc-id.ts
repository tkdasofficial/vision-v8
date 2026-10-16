/** Stable RPC names across frontend origins, checkout paths and dev/build IDs. */
export function stableRpcPath(path: string): string {
  if (!path.startsWith("/_serverFn/")) return path;
  const id = path.slice("/_serverFn/".length);
  try {
    const encoded = id.replace(/-/g, "+").replace(/_/g, "/");
    const metadata = JSON.parse(atob(encoded)) as { export?: unknown };
    if (typeof metadata.export === "string" && /^[A-Za-z_$][\w$]*_createServerFn_handler$/.test(metadata.export)) {
      return `/_serverFn/${metadata.export}`;
    }
  } catch { /* production IDs are already stable names */ }
  return path;
}