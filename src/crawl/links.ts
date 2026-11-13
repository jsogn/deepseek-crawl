import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ linkify: true, html: false });

export function normalizeHttpUrl(value: string, base?: URL): URL | undefined {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
      return undefined;
    }
    if (url.username || url.password) {
      return undefined;
    }
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

export function sameOrigin(left: URL, right: URL): boolean {
  return left.origin === right.origin;
}

export function visitMarkdownLinks(value: string, base: URL, visitLink: (url: URL) => void): void {
  const seen = new Set<string>();

  const visit = (tokens: ReturnType<typeof markdown.parse>): void => {
    for (const token of tokens) {
      if (token.children) {
        visit(token.children);
      }
      if (token.type !== "link_open") {
        continue;
      }
      const href = token.attrGet("href");
      if (typeof href !== "string" || href.length === 0) {
        continue;
      }
      const url = normalizeHttpUrl(href, base);
      if (!url || seen.has(url.href)) {
        continue;
      }
      seen.add(url.href);
      visitLink(url);
    }
  };

  visit(markdown.parse(value, {}));
}

export function extractMarkdownLinks(value: string, base: URL): URL[] {
  const links: URL[] = [];
  visitMarkdownLinks(value, base, (url) => {
    links.push(url);
  });
  return links;
}

export function safePageSlug(url: URL): string {
  const raw = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let segment = raw;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    segment = raw;
  }
  const withoutExtension = segment.replace(/\.[a-z0-9]{1,10}$/i, "");
  const normalized = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return normalized || "page";
}
