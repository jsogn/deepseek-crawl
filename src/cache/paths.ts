import { join, resolve } from "node:path";

export function resolveCacheDirectory(
  env: NodeJS.ProcessEnv,
  home: string,
  platform = process.platform,
): string {
  const explicit = env.DEEPSEEK_CACHE_DIR?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg) {
    return join(resolve(xdg), "deepseek-crawl");
  }
  return platform === "darwin"
    ? join(home, "Library", "Caches", "deepseek-crawl")
    : join(home, ".cache", "deepseek-crawl");
}
