import { NextResponse } from "next/server";
import packageJson from "../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Get system version
 * @summary Get system version
 * @description Returns the current Zerodrift Agent system version from package metadata.
 * @tag System
 * @response 200:SystemVersionResponse:Current system version
 * @openapi
 */
export async function GET() {
  return NextResponse.json({
    name: packageJson.name,
    version: packageJson.version,
  });
}
