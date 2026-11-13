import { safePageSlug } from "../crawl/links.js";

export interface PageFileIdentity {
  index: number;
  url: string;
}

export interface PageMarkdown {
  title: string;
  url: string;
  content: string;
}

export function pageRelativePath(page: PageFileIdentity): string {
  return `pages/${String(page.index).padStart(4, "0")}-${safePageSlug(new URL(page.url))}.md`;
}

export function renderPageMarkdown(page: PageMarkdown): string {
  const title = page.title.trim() || "Untitled";
  const content = page.content.endsWith("\n") ? page.content : `${page.content}\n`;
  return `# ${title}\n\nSource: ${page.url}\n\n${content}`;
}
