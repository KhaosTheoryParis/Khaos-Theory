export type StripeWebhookProcessingMode = "queue" | "legacy_local" | "unavailable";

export function determineStripeWebhookProcessingMode({
  hasDatabase,
  hasQueue,
  configuredMode,
  nodeEnvironment,
}: {
  hasDatabase: boolean;
  hasQueue: boolean;
  configuredMode: string | undefined;
  nodeEnvironment: string | undefined;
}): StripeWebhookProcessingMode {
  if (hasDatabase && hasQueue) return "queue";

  const explicitlyLocal = configuredMode === "legacy_local";
  const developmentRuntime = nodeEnvironment === "development";

  // Fail closed for production, test, and unknown runtimes. The fallback is available
  // only when both the configuration and the runtime explicitly identify local dev.
  if (explicitlyLocal && developmentRuntime) return "legacy_local";
  return "unavailable";
}
