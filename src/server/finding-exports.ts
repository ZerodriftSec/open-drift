import { AuditSession, type FindingMarkdownInput } from "@/audit/session";
import {
  listSessionHumanConfirmedFindingsFromDb,
  readSessionStateFromDb,
} from "@/server/db/store";
import { getSessionGroup } from "@/server/session-groups";

export type FindingMarkdownExport = {
  content: string;
  fileName: string;
};

export type ProjectHumanConfirmedFindings = {
  findings: readonly FindingMarkdownInput[];
  projectName: string;
};

export function findingMarkdownResponse({
  content,
  fileName,
}: FindingMarkdownExport) {
  const fallbackName = fileName.replace(/[^A-Za-z0-9._-]+/g, "-");

  return new Response(content, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function createSessionHumanConfirmedFindingsExport(
  sessionId: string,
): Promise<FindingMarkdownExport> {
  const session = await readSessionStateFromDb(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const findings = await listSessionHumanConfirmedFindingsFromDb([sessionId]);

  return {
    content: renderHumanConfirmedFindingsMarkdown(findings),
    fileName: exportFileName(session.projectName),
  };
}

export async function createSessionGroupHumanConfirmedFindingsExport(
  groupId: string,
): Promise<FindingMarkdownExport> {
  const group = await getSessionGroup(groupId);
  if (!group) {
    throw new Error(`Session Group not found: ${groupId}`);
  }

  const findings = await listSessionHumanConfirmedFindingsFromDb(
    group.sessions.map(({ session }) => session.sessionId),
  );
  const findingsBySessionId = new Map<string, FindingMarkdownInput[]>();
  for (const finding of findings) {
    const sessionFindings = findingsBySessionId.get(finding.session_id) ?? [];
    sessionFindings.push(finding);
    findingsBySessionId.set(finding.session_id, sessionFindings);
  }
  const projectsByName = new Map<string, FindingMarkdownInput[]>();

  for (const { session } of group.sessions) {
    const sessionFindings = findingsBySessionId.get(session.sessionId) ?? [];
    if (sessionFindings.length === 0) {
      continue;
    }

    const projectName = session.projectName || session.sessionId;
    const projectFindings = projectsByName.get(projectName) ?? [];
    projectFindings.push(...sessionFindings);
    projectsByName.set(projectName, projectFindings);
  }

  return {
    content: renderSessionGroupHumanConfirmedFindingsMarkdown(
      [...projectsByName].map(([projectName, projectFindings]) => ({
        findings: projectFindings,
        projectName,
      })),
    ),
    fileName: exportFileName(group.groupName),
  };
}

export function renderHumanConfirmedFindingsMarkdown(
  findings: readonly FindingMarkdownInput[],
) {
  if (findings.length === 0) {
    return "No human-confirmed findings.\n";
  }

  return `${findings.map(renderHumanConfirmedFindingMarkdown).join("\n\n")}\n`;
}

export function renderSessionGroupHumanConfirmedFindingsMarkdown(
  projects: readonly ProjectHumanConfirmedFindings[],
) {
  if (projects.length === 0) {
    return "No human-confirmed findings.\n";
  }

  return `${projects
    .map(({ findings, projectName }) => {
      const projectMarkdown = renderHumanConfirmedFindingsMarkdown(findings);
      return `# ${headingText(projectName)}\n\n${projectMarkdown.trimEnd()}`;
    })
    .join("\n\n")}\n`;
}

function renderHumanConfirmedFindingMarkdown(finding: FindingMarkdownInput) {
  return shiftMarkdownHeadings(
    AuditSession.renderFindingMarkdown(finding, {
      heading: finding.title,
      status: "human-confirmed",
    }),
  );
}

function shiftMarkdownHeadings(markdown: string) {
  let inCodeFence = false;

  return markdown
    .split("\n")
    .map((line) => {
      if (/^`{3,}/.test(line)) {
        inCodeFence = !inCodeFence;
        return line;
      }
      if (inCodeFence) {
        return line;
      }

      const heading = /^(#{1,5})(\s.*)$/.exec(line);
      return heading ? `#${heading[1]}${heading[2]}` : line;
    })
    .join("\n");
}

function headingText(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim() || "Unnamed Project";
}

function exportFileName(value: string) {
  const name = headingText(value)
    .replace(/[/:*?"<>|\\]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);

  return `${name || "findings"}-human-confirmed-findings.md`;
}
