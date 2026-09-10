import { NextResponse } from "next/server";
import { SessionGroupReviewSettingsBody } from "@/app/openapi";
import {
  deleteSessionGroup,
  getSessionGroup,
  updateSessionGroupReviewMinSeverity,
} from "@/server/session-groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    groupId: string;
  }>;
};

/**
 * Get a Session Group
 * @summary Get a logical Session Group
 * @description Returns a logical Session Group and the current state of its associated Sessions.
 * @tag Session Groups
 * @pathParams SessionGroupIdParams
 * @response 200:SessionGroupDetailsResponse:Session Group details
 * @add 404:ErrorResponse:Session Group not found
 * @openapi
 */
export async function GET(_request: Request, context: RouteContext) {
  void _request;
  try {
    const { groupId } = await context.params;
    const group = await getSessionGroup(groupId);
    if (!group) {
      return NextResponse.json(
        { error: "Session Group not found." },
        { status: 404 },
      );
    }

    return NextResponse.json(group);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

/**
 * Update Session Group review settings
 * @summary Update the Needs Review severity threshold for a Session Group
 * @tag Session Groups
 * @pathParams SessionGroupIdParams
 * @body SessionGroupReviewSettingsBody
 * @response 200:SessionGroupReviewSettingsResponse:Updated review settings
 * @add 404:ErrorResponse:Session Group not found
 * @openapi
 */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { groupId } = await context.params;
    const body = SessionGroupReviewSettingsBody.parse(await request.json());
    return NextResponse.json(
      await updateSessionGroupReviewMinSeverity({ groupId, ...body }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 400 },
    );
  }
}

/**
 * Delete a Session Group
 * @summary Delete a Session Group and its Sessions
 * @description Deletes the Group and every associated Session, including stored state and runtime artifacts. Active Groups cannot be deleted.
 * @tag Session Groups
 * @pathParams SessionGroupIdParams
 * @response 200:DeleteSessionGroupResponse:Deleted Group and Session IDs
 * @add 404:ErrorResponse:Session Group not found
 * @openapi
 */
export async function DELETE(_request: Request, context: RouteContext) {
  void _request;
  try {
    const { groupId } = await context.params;
    return NextResponse.json(
      await deleteSessionGroup({ groupId, projectRoot: process.cwd() }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 400 },
    );
  }
}
