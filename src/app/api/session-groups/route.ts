import { NextResponse } from "next/server";
import { SessionGroupCreateBody } from "@/app/openapi";
import {
  createSessionGroup,
  SESSION_GROUP_MEMBER_MAX,
} from "@/server/session-groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a Session Group
 * @summary Create a logical Session Group
 * @description Creates a logical Session Group and independently queues each valid local or uploaded project as a normal Session.
 * @tag Session Groups
 * @body SessionGroupCreateBody
 * @response 201:SessionGroupCreateResponse:Created Session Group and per-Session results
 * @openapi
 */
export async function POST(request: Request) {
  try {
    const rawBody = await request.json().catch(() => ({}));
    const body = groupBody(rawBody);
    const result = await createSessionGroup(body);

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

function groupBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Session Group parameters.");
  }

  const rawBody = value as Record<string, unknown>;
  const parsed = SessionGroupCreateBody.pick({
    agentIds: true,
    groupName: true,
    metadata: true,
    source: true,
    workflowId: true,
  }).safeParse(rawBody);
  if (!parsed.success) {
    throw new Error("Invalid shared Session Group configuration.");
  }

  if (!Array.isArray(rawBody.sessions)) {
    throw new Error("sessions must be an array.");
  }
  if (
    rawBody.sessions.length < 1 ||
    rawBody.sessions.length > SESSION_GROUP_MEMBER_MAX
  ) {
    throw new Error(
      `sessions must contain between 1 and ${SESSION_GROUP_MEMBER_MAX} items.`,
    );
  }

  return { ...parsed.data, sessions: rawBody.sessions };
}
