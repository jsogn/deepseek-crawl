export const packageVersion = "0.17.0";

export function parseReportedVersion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const version = value.trim();
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version) ? version : undefined;
}
