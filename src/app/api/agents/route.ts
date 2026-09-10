import { NextResponse } from "next/server";
import { listAgentDefinitions } from "@/audit/agent/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List audit agents
 * @summary List audit agents
 * @description Returns the registered audit agents.
 * @tag Agents
 * @response 200:AgentsResponse:Registered audit agents
 * @openapi
 */
export async function GET() {
  const agents = listAgentDefinitions();
  return NextResponse.json({ agents });
}
