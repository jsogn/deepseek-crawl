import { UnsupportedFallbackFeatureError } from "../gateway/errors.js";

type OptionValue = string | Record<string, unknown>;

function optionPath(basePath: string, key: string): string {
  return basePath ? `${basePath}.${key}` : key;
}

export function collectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  basePath = "",
): string[] {
  const allowed = new Set(allowedKeys);
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => optionPath(basePath, key))
    .sort();
}

export function collectUnsupportedFormats(
  formats: readonly OptionValue[] | undefined,
  basePath: string,
): string[] {
  if (formats === undefined) {
    return [];
  }
  const unsupported: string[] = [];
  formats.forEach((format, index) => {
    const itemPath = `${basePath}[${index}]`;
    if (typeof format === "string") {
      if (format !== "markdown") {
        unsupported.push(itemPath);
      }
      return;
    }
    unsupported.push(...collectUnsupportedKeys(format, ["type"], itemPath));
    if (format.type !== "markdown") {
      unsupported.push(`${itemPath}.type`);
    }
  });
  return unsupported.sort();
}

export function collectUnsupportedSources(
  sources: readonly OptionValue[] | undefined,
  basePath: string,
): string[] {
  if (sources === undefined) {
    return [];
  }
  const unsupported: string[] = [];
  sources.forEach((source, index) => {
    const itemPath = `${basePath}[${index}]`;
    if (typeof source === "string") {
      if (source !== "web") {
        unsupported.push(itemPath);
      }
      return;
    }
    unsupported.push(...collectUnsupportedKeys(source, ["type"], itemPath));
    if (source.type !== "web") {
      unsupported.push(`${itemPath}.type`);
    }
  });
  return unsupported.sort();
}

export function throwForUnsupportedOptions(paths: readonly string[]): void {
  const [first] = [...new Set(paths)].sort();
  if (first === undefined) {
    return;
  }
  throw new UnsupportedFallbackFeatureError(
    `DeepSeek fallback does not support Firecrawl option \`${first}\`.`,
  );
}
