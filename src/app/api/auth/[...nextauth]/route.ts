import { handlers } from "@/auth";
import { isAuthenticationRequired } from "@/lib/auth/config";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function GET(request: NextRequest) {
  if (!isAuthenticationRequired()) {
    return new NextResponse(null, { status: 404 });
  }

  return handlers.GET(request);
}

export function POST(request: NextRequest) {
  if (!isAuthenticationRequired()) {
    return new NextResponse(null, { status: 404 });
  }

  return handlers.POST(request);
}
