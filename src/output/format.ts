import type { FetchOutput, SearchOutput } from "../types.js";

export function formatSearchHuman(output: SearchOutput): string {
  if (output.results.length === 0) {
    return "No results.";
  }

  return output.results
    .map((result, index) => {
      const lines = [`${index + 1}. ${result.title}`, `URL: ${result.url}`];
      const metadata = [
        result.site_name ? `Site: ${result.site_name}` : "",
        result.date ? `Published: ${result.date}` : "",
        `Authority: ${result.authority}`,
        `Relevance: ${result.rerank_score.toFixed(1)}`,
      ].filter(Boolean);
      lines.push(metadata.join(" | "));
      if (result.summary) {
        lines.push("", result.summary);
      }
      if (result.content) {
        lines.push("", result.content);
        if (result.content_truncated && result.content_original_length !== undefined) {
          lines.push(
            "",
            `[Content truncated from ${result.content_original_length} to ${[...result.content].length} characters.]`,
          );
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function formatFetchHuman(output: FetchOutput): string {
  const title = output.title || "Untitled";
  const lines = [`# ${title}`, "", `Source: ${output.url}`];
  if (output.retrieved_from) {
    lines.push(`Retrieved from: ${output.retrieved_from}`);
  }
  lines.push("", output.content);
  if (output.truncated && output.original_length !== undefined) {
    lines.push(
      "",
      `[Content truncated from ${output.original_length} to ${[...output.content].length} characters.]`,
    );
  }
  return lines.join("\n");
}
