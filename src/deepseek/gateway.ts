import type { FetchInput, RawFetchResponse, RawSearchResponse, SearchInput } from "../types.js";

export interface DeepSeekGateway {
  search(input: SearchInput, signal?: AbortSignal): Promise<RawSearchResponse>;
  fetch(input: FetchInput, signal?: AbortSignal): Promise<RawFetchResponse>;
}
