export function isTransientNetworkError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: number }).status;
    if (typeof status === "number" && status >= 500 && status <= 599) return true;
  }
  const text = error instanceof Error ? `${error.message} ${(error as { cause?: unknown }).cause ?? ""}` : String(error);
  return /fetch failed|connect timeout|econnreset|etimedout|socket disconnected|network/i.test(text);
}
