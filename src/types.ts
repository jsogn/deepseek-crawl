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

interface RawSearchResult extends Record<string, unknown> {
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

export interface RawBalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

export interface RawBalanceResponse extends Record<string, unknown> {
  is_available: boolean;
  balance_infos: RawBalanceInfo[];
}

export interface BalanceAmount {
  currency: string;
  total: string;
  granted: string;
  topped_up: string;
}

export interface BalanceOutput extends Record<string, unknown> {
  version: 1;
  provider: "deepseek";
  available: boolean;
  balances: BalanceAmount[];
}

export type FetchRetrievalSource = "api" | "cache";

interface SearchResultItem extends RawSearchResult {
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
  content_hash?: string;
  retrieved_from?: FetchRetrievalSource;
  truncated?: boolean;
  original_length?: number;
}
