import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import type { BaseAgent } from "@/audit/agent/base-agent";
import { WorkflowDefinition } from "@/audit/workflow";
import {
  AuditSession,
  createAuditSessionId,
  DEFAULT_FINDING_REVIEW_MIN_SEVERITY,
  isFindingAtOrAboveReviewSeverity,
  type AuditSessionCreateOptions,
} from "@/audit/session";
import { Severity, type Finding, type JsonObject } from "@/audit/session/types";
import {
  applySessionFindingReviews,
  extractRunSummary,
  findingKeyFor,
  getSessionDetails,
  reviewSessionFinding,
} from "@/server/sessions";
import {
  createSessionHumanConfirmedFindingsExport,
  renderHumanConfirmedFindingsMarkdown,
  renderSessionGroupHumanConfirmedFindingsMarkdown,
} from "@/server/finding-exports";
import { listSessionNeedsReviewFindingCountsFromDb } from "@/server/db/store";

const fakeAgent = {} as BaseAgent;

test("createAuditSessionId returns a timestamped unique id", () => {
  const first = createAuditSessionId();
  const second = createAuditSessionId();

  expect(first).toMatch(/^\d{14}-[0-9a-f]{12}$/);
  expect(second).toMatch(/^\d{14}-[0-9a-f]{12}$/);
  expect(first).not.toBe(second);
});

test("ignores removed Agent IDs when summarizing a stored Session", () => {
  expect(
    extractRunSummary(
      [],
      ["claude-glm-5.2-max", "gemini-gemini-3.5-flash-high"],
    ),
  ).toBeNull();
});

test("uses high as the default finding review severity", () => {
  expect(DEFAULT_FINDING_REVIEW_MIN_SEVERITY).toBe(Severity.HIGH);
  expect(isFindingAtOrAboveReviewSeverity(Severity.HIGH)).toBe(true);
  expect(isFindingAtOrAboveReviewSeverity(Severity.MEDIUM)).toBe(false);
});

test("treats the configured severity as an inclusive minimum", () => {
  expect(
    isFindingAtOrAboveReviewSeverity(Severity.CRITICAL, Severity.HIGH),
  ).toBe(true);
  expect(isFindingAtOrAboveReviewSeverity(Severity.HIGH, Severity.HIGH)).toBe(
    true,
  );
  expect(isFindingAtOrAboveReviewSeverity(Severity.MEDIUM, Severity.HIGH)).toBe(
    false,
  );
});

test("creates a queued session with normalized initial state", async () => {
  const options = sessionOptions({ targetPath: "/tmp/target" });
  const session = await AuditSession.createAuditSession(options);

  try {
    expect(session.projectName).toBe(options.projectName);
    expect(session.targetPath).toBe(options.targetPath);
    expect(session.workflow).toBe(options.workflow);
    expect(session.source).toBe(options.source);
    expect(session.metadata).toEqual(options.metadata);
    expect(session.agents).toEqual([fakeAgent]);
    expect(session.sessionId).toMatch(/^\d{14}-[0-9a-f]{12}$/);
  } finally {
    await closeAndRemoveSession(session);
  }
});

test("copies a source directory into the session working directory", async () => {
  const sourceRoot = await mkdtemp(
    path.join(tmpdir(), "zerodrift-session-source-"),
  );
  const session = await AuditSession.createAuditSession(
    sessionOptions({ targetPath: sourceRoot }),
  );

  try {
    await mkdir(path.join(sourceRoot, "contracts"), { recursive: true });
    await writeFile(
      path.join(sourceRoot, "contracts", "Vault.sol"),
      "contract Vault {}\n",
      "utf8",
    );

    await session.copySourceToWorkingDirectory();

    const workingFile = path.join(
      process.cwd(),
      ".data",
      "session",
      session.sessionId,
      "repo",
      "contracts",
      "Vault.sol",
    );
    expect(await readFile(workingFile, "utf8")).toBe("contract Vault {}\n");
  } finally {
    await rm(sourceRoot, { force: true, recursive: true });
    await closeAndRemoveSession(session);
  }
});

test("copies a source file into the session working directory", async () => {
  const sourceRoot = await mkdtemp(
    path.join(tmpdir(), "zerodrift-session-file-"),
  );
  const sourceFile = path.join(sourceRoot, "Contract.sol");
  await writeFile(sourceFile, "contract Contract {}\n", "utf8");
  const session = await AuditSession.createAuditSession(
    sessionOptions({ targetPath: sourceFile }),
  );

  try {
    await session.copySourceToWorkingDirectory();

    const workingFile = path.join(
      process.cwd(),
      ".data",
      "session",
      session.sessionId,
      "repo",
      "Contract.sol",
    );
    expect(await readFile(workingFile, "utf8")).toBe("contract Contract {}\n");
  } finally {
    await rm(sourceRoot, { force: true, recursive: true });
    await closeAndRemoveSession(session);
  }
});

test("rejects copying a source path that does not exist", async () => {
  const sourceRoot = await mkdtemp(
    path.join(tmpdir(), "zerodrift-missing-source-"),
  );
  const targetPath = path.join(sourceRoot, "missing.sol");
  const session = await AuditSession.createAuditSession(
    sessionOptions({ targetPath }),
  );

  try {
    await expect(session.copySourceToWorkingDirectory()).rejects.toThrow(
      `Target path does not exist: ${path.resolve(targetPath)}`,
    );
  } finally {
    await rm(sourceRoot, { force: true, recursive: true });
    await closeAndRemoveSession(session);
  }
});

test("writes on-chain metadata using both supported metadata keys", async () => {
  const metadataValues: JsonObject[] = [
    { onchain_info: { chain: "base", block: 42 } },
    { "onchain info": { chain: "base", block: 42 } },
  ];
  for (const metadata of metadataValues) {
    const session = await AuditSession.createAuditSession(
      sessionOptions({ metadata }),
    );

    try {
      const filePath = await session.writeOnchainInfoToSessionDirectory();

      expect(filePath).toBe(
        path.join(
          process.cwd(),
          ".data",
          "session",
          session.sessionId,
          "onchain_info.json",
        ),
      );
      expect(await readFile(filePath!, "utf8")).toBe(
        '{\n  "chain": "base",\n  "block": 42\n}\n',
      );
    } finally {
      await closeAndRemoveSession(session);
    }
  }
});

test("does not write an on-chain metadata file when metadata is absent", async () => {
  const session = await AuditSession.createAuditSession(sessionOptions());

  try {
    expect(await session.writeOnchainInfoToSessionDirectory()).toBeUndefined();
  } finally {
    await closeAndRemoveSession(session);
  }
});

test("renders persisted findings to the session artifact root", async () => {
  const session = await AuditSession.createAuditSession(sessionOptions());

  try {
    const finding = await session.addFinding({
      description: "Anyone can withdraw funds without authorization.",
      file_path: "Vault.sol",
      impact: "Funds can be stolen.",
      root_cause: "The withdraw function has no access control.",
      severity: Severity.HIGH,
      title: "Unauthorized withdrawal",
      triggered_actor: "An unprivileged attacker.",
    });

    const filePath = await session.renderFindingsMarkdownArtifact();

    expect(filePath).toBe(
      path.join(session.sessionDirectoryPath, "finding.md"),
    );
    expect(await readFile(filePath, "utf8")).toContain(
      `## ${finding.id}. Unauthorized withdrawal`,
    );
    expect(await readFile(filePath, "utf8")).toContain(
      "## Triggered Actor\n\nAn unprivileged attacker.",
    );
    expect(await session.readAllFindings()).toContainEqual(
      expect.objectContaining({
        triggered_actor: "An unprivileged attacker.",
      }),
    );
  } finally {
    await closeAndRemoveSession(session);
  }
});

test("stores the AI rejection reason separately from a finding note", async () => {
  const session = await AuditSession.createAuditSession(sessionOptions());

  try {
    const candidate = await session.addFinding({
      ...testFinding("Rejected candidate"),
      note: "Keep this human note.",
    });
    const rejected = await session.rejectFinding(
      candidate.id!,
      "The vulnerable path is unreachable.",
    );

    expect(rejected).toMatchObject({
      note: "Keep this human note.",
      rejection_reason: "The vulnerable path is unreachable.",
    });
    expect(
      (await session.readAllFindings()).find(({ id }) => id === candidate.id),
    ).toMatchObject({
      note: "Keep this human note.",
      rejection_reason: "The vulnerable path is unreachable.",
    });
    expect(AuditSession.renderFindingMarkdown(rejected)).toContain(
      "## Rejection Reason\n\nThe vulnerable path is unreachable.",
    );
  } finally {
    await closeAndRemoveSession(session);
  }
});

test("exports only explicitly human-confirmed session findings as Markdown", async () => {
  const session = await AuditSession.createAuditSession(sessionOptions());

  try {
    const pendingFinding = await session.addFinding(
      testFinding("Human-confirmed pending"),
    );
    await reviewSessionFinding({
      action: "confirm",
      findingId: pendingFinding.id!,
      sessionId: session.sessionId,
    });

    const aiConfirmedFinding = await session.confirmFinding(
      (await session.addFinding(testFinding("Human-confirmed Agent finding")))
        .id!,
      "Validated by the Agent review.",
    );
    expect(aiConfirmedFinding).toMatchObject({
      confirmation_reason: "Validated by the Agent review.",
    });
    await reviewSessionFinding({
      action: "confirm",
      findingId: aiConfirmedFinding.id!,
      sessionId: session.sessionId,
    });

    const rejectedFinding = await session.addFinding(
      testFinding("Human-rejected finding"),
    );
    await reviewSessionFinding({
      action: "pass",
      findingId: rejectedFinding.id!,
      sessionId: session.sessionId,
    });

    const markdownExport = await createSessionHumanConfirmedFindingsExport(
      session.sessionId,
    );

    expect(markdownExport.content).toContain("## Human-confirmed pending");
    expect(markdownExport.content).toContain(
      "## Human-confirmed Agent finding",
    );
    expect(markdownExport.content).toContain(
      "### Confirmation Reason\n\nValidated by the Agent review.",
    );
    expect(markdownExport.content).not.toContain("Human-rejected finding");
    expect(markdownExport.content).not.toMatch(/^# [^#]/m);
    expect(markdownExport.fileName).toBe(
      "session-test-project-human-confirmed-findings.md",
    );
  } finally {
    await closeAndRemoveSession(session);
  }
});

test("uses project names as group headings without changing finding Markdown", () => {
  const projectAFinding = testFinding("Project A finding");
  const projectBFinding = testFinding("Project B finding");
  const projectAMarkdown = renderHumanConfirmedFindingsMarkdown([
    projectAFinding,
  ]).trimEnd();
  const projectBMarkdown = renderHumanConfirmedFindingsMarkdown([
    projectBFinding,
  ]).trimEnd();

  expect(
    renderSessionGroupHumanConfirmedFindingsMarkdown([
      { findings: [projectAFinding], projectName: "Project A" },
      { findings: [projectBFinding], projectName: "Project B" },
    ]),
  ).toBe(
    [
      "# Project A",
      "",
      projectAMarkdown,
      "",
      "# Project B",
      "",
      projectBMarkdown,
      "",
    ].join("\n"),
  );
  expect(projectAMarkdown).toContain("## Project A finding");
  expect(projectAMarkdown).toContain("### Root Cause");
});

test("keeps the AI confirmed count independent of human status", async () => {
  const session = await AuditSession.createAuditSession(sessionOptions());

  try {
    const confirmedFindings: Finding[] = [];
    for (let index = 0; index < 8; index += 1) {
      const candidate = await session.addFinding(
        testFinding(`Confirmed ${index}`),
      );
      confirmedFindings.push(
        await session.confirmFinding(candidate.id!, "Validated in test."),
      );
    }

    await session.addFinding(testFinding("Pending"));
    const onchainCandidate = await session.addFinding(testFinding("Onchain"));
    const onchainFinding = await session.onchainConfirmFinding(
      onchainCandidate.id!,
      {
        economic_impact: "Funds can be lost.",
        trigger_conditions: "The vulnerable path is reachable.",
        triggered_actor: "An unprivileged attacker.",
      },
    );
    expect(onchainFinding.triggered_actor).toBe("An unprivileged attacker.");
    const rejectedCandidate = await session.addFinding(testFinding("Rejected"));
    await session.rejectFinding(rejectedCandidate.id!, "Not reachable.");
    const duplicateCandidate = await session.addFinding(
      testFinding("Duplicate"),
    );
    await session.markDuplicateFinding(
      duplicateCandidate.id!,
      confirmedFindings[0]!.id!,
    );

    expect(
      (await requiredSessionDetails(session.sessionId)).state,
    ).toMatchObject({
      findingCount: 9,
      pendingFindingCount: 1,
      aiConfirmedFindingCount: 8,
    });
    expect(await needsReviewFindingCount(session.sessionId)).toBe(8);

    await reviewSessionFinding({
      action: "confirm",
      findingId: confirmedFindings[0]!.id!,
      sessionId: session.sessionId,
    });
    expect(
      (await requiredSessionDetails(session.sessionId)).state
        .aiConfirmedFindingCount,
    ).toBe(8);
    expect(await needsReviewFindingCount(session.sessionId)).toBe(7);

    await reviewSessionFinding({
      action: "pass",
      findingId: confirmedFindings[1]!.id!,
      sessionId: session.sessionId,
    });
    expect(
      (await requiredSessionDetails(session.sessionId)).state
        .aiConfirmedFindingCount,
    ).toBe(8);
    expect(await needsReviewFindingCount(session.sessionId)).toBe(6);

    await reviewSessionFinding({
      action: "pass",
      findingId: confirmedFindings[0]!.id!,
      sessionId: session.sessionId,
    });
    expect(
      (await requiredSessionDetails(session.sessionId)).state
        .aiConfirmedFindingCount,
    ).toBe(8);
    expect(await needsReviewFindingCount(session.sessionId)).toBe(6);

    await reviewSessionFinding({
      action: "reset",
      findingId: confirmedFindings[0]!.id!,
      sessionId: session.sessionId,
    });
    const resetDetails = await requiredSessionDetails(session.sessionId);
    expect(resetDetails.state.aiConfirmedFindingCount).toBe(8);
    expect(await needsReviewFindingCount(session.sessionId)).toBe(7);

    const benchmarkReviewedFinding = resetDetails.findings.find(
      ({ id }) => String(id) === String(confirmedFindings[2]!.id),
    )!;
    const benchmarkReviewedIndex = resetDetails.findings.indexOf(
      benchmarkReviewedFinding,
    );
    await applySessionFindingReviews({
      decisionsByFindingKey: {
        [findingKeyFor(
          "confirmed",
          benchmarkReviewedIndex,
          benchmarkReviewedFinding,
        )]: "confirm",
      },
      sessionId: session.sessionId,
    });
    expect(
      (await requiredSessionDetails(session.sessionId)).state
        .aiConfirmedFindingCount,
    ).toBe(8);
    expect(await needsReviewFindingCount(session.sessionId)).toBe(6);
  } finally {
    await closeAndRemoveSession(session);
  }
});

test("applies the default minimum severity to AI confirmed counts", async () => {
  const session = await AuditSession.createAuditSession(sessionOptions());

  try {
    for (const severity of [
      Severity.CRITICAL,
      Severity.HIGH,
      Severity.MEDIUM,
    ]) {
      const candidate = await session.addFinding({
        ...testFinding(`Confirmed ${severity}`),
        severity,
      });
      await session.confirmFinding(candidate.id!, "Validated in test.");
    }

    expect(
      (await requiredSessionDetails(session.sessionId)).state
        .aiConfirmedFindingCount,
    ).toBe(2);
  } finally {
    await closeAndRemoveSession(session);
  }
});

function testFinding(title: string) {
  return {
    description: `${title} description.`,
    file_path: "Vault.sol",
    impact: `${title} impact.`,
    root_cause: `${title} root cause.`,
    severity: Severity.HIGH,
    title,
  };
}

async function requiredSessionDetails(sessionId: string) {
  const details = await getSessionDetails(sessionId);
  if (!details) throw new Error(`Missing test session: ${sessionId}`);
  return details;
}

async function needsReviewFindingCount(sessionId: string) {
  const rows = await listSessionNeedsReviewFindingCountsFromDb([sessionId]);
  return rows.find((row) => row.sessionId === sessionId)?.count ?? 0;
}

function sessionOptions(
  overrides: Partial<AuditSessionCreateOptions> = {},
): AuditSessionCreateOptions {
  return {
    agents: [fakeAgent],
    metadata: { source: "test" },
    projectName: "session-test-project",
    targetPath: "/tmp/session-test-target",
    workflow: Object.assign(
      new WorkflowDefinition({
        name: "test-workflow",
        stages: [],
      }),
      { id: "test-workflow" },
    ),
    source: "test",
    ...overrides,
  };
}

async function closeAndRemoveSession(session: AuditSession) {
  await session.close();
  const sessionDirectory = path.join(
    process.cwd(),
    ".data",
    "session",
    session.sessionId,
  );
  await rm(sessionDirectory, { force: true, recursive: true });
}
