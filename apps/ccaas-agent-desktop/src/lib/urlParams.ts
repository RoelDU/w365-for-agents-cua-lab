export interface UrlOverrides {
  cua: boolean;
}

export function readUrlOverrides(search: string = window.location.search): UrlOverrides {
  const params = new URLSearchParams(search);
  const cua = params.get("cua") === "true" || params.get("cua") === "1";
  return { cua };
}
