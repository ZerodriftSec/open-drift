import { Bot } from "lucide-react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { isAuthenticationRequired } from "@/lib/auth/config";
import { isGoogleEmailAllowed } from "@/lib/auth/google-email-allowlist";
import { safeRedirectPath } from "@/lib/auth/safe-redirect";
import { signInWithGoogle } from "./actions";

const errorMessages: Record<string, string> = {
  AccessDenied: "The current account is not authorized to access this system.",
  Configuration: "Google OAuth is not configured. Contact an administrator.",
  OAuthCallback: "The Google sign-in callback failed. Try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    callbackUrl?: string;
    error?: string;
  }>;
}) {
  const params = await searchParams;
  const callbackUrl = safeRedirectPath(params.callbackUrl);

  if (!isAuthenticationRequired()) {
    redirect(callbackUrl);
  }

  const session = await auth();

  if (isGoogleEmailAllowed(session?.user?.email)) {
    redirect(callbackUrl);
  }

  const errorMessage = params.error
    ? (errorMessages[params.error] ?? "Google sign-in failed. Try again.")
    : null;

  return (
    <main className="grid min-h-dvh place-items-center overflow-auto bg-app-surface-strong p-4 text-foreground">
      <Card className="w-full max-w-[380px]" variant="raised">
        <CardHeader className="min-h-12">
          <span className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-app bg-primary text-primary-foreground">
              <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            Zerodrift Agent
          </span>
        </CardHeader>
        <CardContent className="grid gap-4 p-5">
          <div className="grid gap-1">
            <h1 className="m-0 text-base font-semibold text-app-text">
              Sign in to the workspace
            </h1>
          </div>

          {errorMessage ? (
            <div
              className="rounded-app border border-app-danger-border bg-app-danger-bg px-3 py-2 text-[12px] text-app-danger"
              role="alert"
            >
              {errorMessage}
            </div>
          ) : null}

          <form action={signInWithGoogle}>
            <input name="callbackUrl" type="hidden" value={callbackUrl} />
            <Button
              className="w-full"
              size="lg"
              type="submit"
              variant="primary"
            >
              <svg aria-hidden="true" viewBox="0 0 18 18">
                <path
                  fill="#4285F4"
                  d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.716v2.258h2.909c1.702-1.567 2.684-3.875 2.684-6.615Z"
                />
                <path
                  fill="#34A853"
                  d="M9 18c2.43 0 4.468-.806 5.956-2.18l-2.91-2.258c-.805.54-1.835.859-3.046.859-2.344 0-4.328-1.585-5.037-3.714H.957v2.333A9 9 0 0 0 9 18Z"
                />
                <path
                  fill="#FBBC05"
                  d="M3.963 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.281-1.707V4.96H.957A9 9 0 0 0 0 9c0 1.452.347 2.827.957 4.04l3.006-2.333Z"
                />
                <path
                  fill="#EA4335"
                  d="M9 3.58c1.322 0 2.508.455 3.442 1.346l2.581-2.581C13.464.892 11.43 0 9 0A9 9 0 0 0 .957 4.96l3.006 2.333C4.672 5.165 6.656 3.58 9 3.58Z"
                />
              </svg>
              Sign in with Google
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
