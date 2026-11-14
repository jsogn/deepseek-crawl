import type {
  FetchInput,
  RawBalanceResponse,
  RawFetchResponse,
  RawSearchResponse,
  SearchInput,
} from "../types.js";

export interface DeepSeekGateway {
  search(input: SearchInput, signal?: AbortSignal): Promise<RawSearchResponse>;
  fetch(input: FetchInput, signal?: AbortSignal): Promise<RawFetchResponse>;
}

export interface DeepSeekBalanceGateway {
  balance(signal?: AbortSignal): Promise<RawBalanceResponse>;
}
