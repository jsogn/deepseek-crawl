import { normalizeHttpUrl } from "./links.js";

function normalizePattern(pattern: string, name: string): string {
  const value = pattern.trim();
  if (!value) {
    throw new Error(`${name} pattern cannot be empty.`);
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function wildcardRegExp(pattern: string): RegExp {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function compilePathPattern(pattern: string, name: string): (pathname: string) => boolean {
  const normalized = normalizePattern(pattern, name);
  if (!normalized.includes("*") && !normalized.includes("?")) {
    const prefix = normalized.replace(/\/+$/, "") || "/";
    return (pathname) =>
      prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`);
  }
  const expression = wildcardRegExp(normalized);
  return (pathname) => expression.test(pathname);
}

export function createCrawlPathFilter(
  includePaths: string[],
  excludePaths: string[],
): (url: URL) => boolean {
  const includes = includePaths.map((pattern) => compilePathPattern(pattern, "include"));
  const excludes = excludePaths.map((pattern) => compilePathPattern(pattern, "exclude"));
  return (url) => {
    const included = includes.length === 0 || includes.some((matches) => matches(url.pathname));
    return included && !excludes.some((matches) => matches(url.pathname));
  };
}

export function canonicalizeCrawlUrl(
  value: string | URL,
  base?: URL,
  ignoreQueryParameters = false,
): URL | undefined {
  const url = normalizeHttpUrl(typeof value === "string" ? value : value.href, base);
  if (!url) {
    return undefined;
  }
  if (ignoreQueryParameters) {
    url.search = "";
  }
  return url;
}
