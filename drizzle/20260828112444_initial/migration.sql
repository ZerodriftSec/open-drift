CREATE TABLE `AuditSession` (
	`id` text PRIMARY KEY,
	`agents` text DEFAULT '[]' NOT NULL,
	`workflow` text DEFAULT '{"stages":[]}' NOT NULL,
	`workflowState` text DEFAULT '{"mode":"idle","status":"idle","stages":[],"updatedAt":""}' NOT NULL,
	`workflowId` text DEFAULT 'main-audit' NOT NULL,
	`stageAgentAssignments` text DEFAULT '{}' NOT NULL,
	`projectName` text NOT NULL,
	`source` text,
	`metadata` text,
	`status` text NOT NULL,
	`projectRoot` text NOT NULL,
	`targetPath` text NOT NULL,
	`workingDirectory` text,
	`sessionDir` text NOT NULL,
	`programLogFile` text NOT NULL,
	`agentLogFile` text,
	`createdAt` text NOT NULL,
	`startedAt` text,
	`finishedAt` text
);
--> statement-breakpoint
CREATE TABLE `QueueSetting` (
	`key` text PRIMARY KEY,
	`concurrency` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `SessionFindingReview` (
	`id` text PRIMARY KEY,
	`sessionId` text NOT NULL,
	`findingKey` text NOT NULL,
	`action` text NOT NULL,
	`reviewedAt` text NOT NULL,
	CONSTRAINT `fk_SessionFindingReview_sessionId_AuditSession_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `AuditSession`(`id`) ON UPDATE CASCADE ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `SessionFinding` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`duplicateOfId` integer,
	`sessionId` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`rootCause` text NOT NULL,
	`severity` text NOT NULL,
	`filePath` text NOT NULL,
	`impact` text,
	`triggerConditions` text,
	`triggeredActor` text,
	`economicImpact` text,
	`confirmationReason` text,
	`rejectionReason` text,
	`recommendation` text,
	`note` text,
	`humanStatus` text,
	`sourceLocations` text,
	`createdAt` text NOT NULL,
	CONSTRAINT `fk_SessionFinding_sessionId_AuditSession_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `AuditSession`(`id`) ON UPDATE CASCADE ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `SessionGroupMember` (
	`groupId` text NOT NULL,
	`sessionId` text NOT NULL,
	`index` integer NOT NULL,
	`createdAt` text NOT NULL,
	CONSTRAINT `fk_SessionGroupMember_groupId_SessionGroup_id_fk` FOREIGN KEY (`groupId`) REFERENCES `SessionGroup`(`id`) ON UPDATE CASCADE ON DELETE CASCADE,
	CONSTRAINT `fk_SessionGroupMember_sessionId_AuditSession_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `AuditSession`(`id`) ON UPDATE CASCADE ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `SessionGroup` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`createdAt` text NOT NULL,
	`reviewMinSeverity` text DEFAULT 'high' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `SessionQueueItem` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL,
	`sessionId` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`claimedAt` text,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `Upload` (
	`id` text PRIMARY KEY,
	`targetPath` text NOT NULL,
	`workflowId` text DEFAULT 'main-audit' NOT NULL,
	`projectName` text,
	`metadata` text,
	`source` text
);
--> statement-breakpoint
CREATE INDEX `AuditSession_agents_idx` ON `AuditSession` (`agents`);--> statement-breakpoint
CREATE INDEX `AuditSession_workflowId_idx` ON `AuditSession` (`workflowId`);--> statement-breakpoint
CREATE INDEX `AuditSession_createdAt_idx` ON `AuditSession` (`createdAt`);--> statement-breakpoint
CREATE INDEX `AuditSession_projectName_idx` ON `AuditSession` (`projectName`);--> statement-breakpoint
CREATE INDEX `AuditSession_source_idx` ON `AuditSession` (`source`);--> statement-breakpoint
CREATE INDEX `AuditSession_status_idx` ON `AuditSession` (`status`);--> statement-breakpoint
CREATE INDEX `SessionFindingReview_findingKey_idx` ON `SessionFindingReview` (`findingKey`);--> statement-breakpoint
CREATE INDEX `SessionFindingReview_sessionId_idx` ON `SessionFindingReview` (`sessionId`);--> statement-breakpoint
CREATE INDEX `SessionFindingReview_reviewedAt_idx` ON `SessionFindingReview` (`reviewedAt`);--> statement-breakpoint
CREATE INDEX `SessionFinding_createdAt_idx` ON `SessionFinding` (`createdAt`);--> statement-breakpoint
CREATE INDEX `SessionFinding_duplicateOfId_idx` ON `SessionFinding` (`duplicateOfId`);--> statement-breakpoint
CREATE INDEX `SessionFinding_status_idx` ON `SessionFinding` (`status`);--> statement-breakpoint
CREATE INDEX `SessionFinding_sessionId_idx` ON `SessionFinding` (`sessionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `SessionGroupMember_groupId_index_key` ON `SessionGroupMember` (`groupId`,`index`);--> statement-breakpoint
CREATE INDEX `SessionGroupMember_sessionId_idx` ON `SessionGroupMember` (`sessionId`);--> statement-breakpoint
CREATE INDEX `SessionGroup_createdAt_idx` ON `SessionGroup` (`createdAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `SessionQueueItem_sessionId_unique` ON `SessionQueueItem` (`sessionId`);--> statement-breakpoint
CREATE INDEX `SessionQueueItem_status_createdAt_idx` ON `SessionQueueItem` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `SessionQueueItem_key_createdAt_idx` ON `SessionQueueItem` (`key`,`createdAt`);