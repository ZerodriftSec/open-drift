import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";
import type { NextAuthRequest } from "next-auth";
import { auth } from "@/auth";
import { isAuthenticationRequired } from "@/lib/auth/config";
import { isGoogleEmailAllowed } from "@/lib/auth/google-email-allowlist";
import { isPlatformTokenAuthorized } from "@/lib/auth/platform-token";

const authenticatedProxy = auth(
  (request: NextAuthRequest, event: NextFetchEvent) => {
    void event;
    const apiRequest = request.nextUrl.pathname.startsWith("/api/");
    if (
      apiRequest &&
      isPlatformTokenAuthorized(request.headers.get("authorization"))
    ) {
      return NextResponse.next();
    }

    const email = request.auth?.user?.email;
    if (isGoogleEmailAllowed(email)) {
      return NextResponse.next();
    }

    const authenticated = Boolean(request.auth?.user);
    if (apiRequest) {
      return NextResponse.json(
        {
          code: authenticated ? "FORBIDDEN" : "UNAUTHORIZED",
          error: authenticated
            ? "The current account is not authorized to access this system"
            : "Sign in with Google to continue",
        },
        { status: authenticated ? 403 : 401 },
      );
    }

    const loginUrl = new URL("/login", request.nextUrl);
    loginUrl.searchParams.set(
      "callbackUrl",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    if (authenticated) {
      loginUrl.searchParams.set("error", "AccessDenied");
    }

    return NextResponse.redirect(loginUrl);
  },
);

export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!isAuthenticationRequired()) {
    return NextResponse.next();
  }

  return authenticatedProxy(request, event);
}

export const config = {
  matcher: ["/((?!api/auth|login|_next|favicon.ico|icon.svg).*)"],
};
