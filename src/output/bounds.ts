import type { FetchOutput, SearchOutput } from "../types.js";

export interface TextBound {
  value: string;
  truncated: boolean;
  originalLength: number;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000000) {
    throw new Error("Content limit must be an integer from 0 to 1000000.");
  }
}

export function truncateText(value: string, limit: number): TextBound {
  validateLimit(limit);
  const characters = Array.from(value);
  if (limit === 0 || characters.length <= limit) {
    return {
      value,
      truncated: false,
      originalLength: characters.length,
    };
  }
  return {
    value: characters.slice(0, limit).join(""),
    truncated: true,
    originalLength: characters.length,
  };
}

export function boundSearchOutput(output: SearchOutput, maxContentChars: number): SearchOutput {
  validateLimit(maxContentChars);
  let truncatedResults = 0;
  const results = output.results.map((result) => {
    if (result.content.length === 0) {
      return result;
    }

    const content = truncateText(result.content, maxContentChars);
    if (!content.truncated) {
      return result;
    }

    truncatedResults += 1;
    return {
      ...result,
      content: content.value,
      content_truncated: true,
      content_original_length: content.originalLength,
    };
  });

  if (truncatedResults === 0) {
    return { ...output, results };
  }
  return {
    ...output,
    results,
    truncation: {
      content_limit: maxContentChars,
      truncated_results: truncatedResults,
    },
  };
}

export function boundFetchOutput(output: FetchOutput, maxChars: number): FetchOutput {
  validateLimit(maxChars);
  const content = truncateText(output.content, maxChars);
  if (!content.truncated) {
    return { ...output, content: content.value };
  }
  return {
    ...output,
    content: content.value,
    truncated: true,
    original_length: content.originalLength,
  };
}
