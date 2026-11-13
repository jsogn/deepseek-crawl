export type MapWarningCode =
  | "sitemap_unavailable"
  | "sitemap_invalid"
  | "sitemap_limit_reached"
  | "seed_page_failed";

export interface MapWarning {
  code: MapWarningCode;
  message: string;
}
