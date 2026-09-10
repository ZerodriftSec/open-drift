export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { ensureAppRuntimeCleanup } = await import("@/server/runtime/cleanup");
  await ensureAppRuntimeCleanup();
}
