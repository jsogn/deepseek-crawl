export interface SearchInput {
  query: string;
  count: number;
  ori_question?: string | null | undefined;
  localization?: string | undefined;
  need_content: boolean;
}

export interface FetchInput {
  url: string;
}

export interface RawSearchResult extends Record<string, unknown> {
  rerank_score: number;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  authority: number;
}

export interface RawSearchResponse extends Record<string, unknown> {
  results: RawSearchResult[];
}

export interface RawFetchResponse extends Record<string, unknown> {
  title: string;
  content: string;
}

export type FetchRetrievalSource = "api" | "cache";

export interface SearchResultItem extends RawSearchResult {
  content_truncated?: boolean;
  content_original_length?: number;
}

export interface SearchOutput extends Record<string, unknown> {
  results: SearchResultItem[];
  truncation?: {
    content_limit: number;
    truncated_results: number;
  };
}

export interface FetchOutput extends RawFetchResponse {
  url: string;
  retrieved_from?: FetchRetrievalSource;
  truncated?: boolean;
  original_length?: number;
}
