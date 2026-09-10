import { type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";

const maxReadBytes = 512 * 1024;

export type LogTailEntry = {
  [key: string]: unknown;
};

export type LogTailCursor = {
  carry: Buffer;
  emittedOffset: number;
  inode?: string;
  readOffset: number;
};

export type LogTailBatch = {
  inode?: string;
  logs: LogTailEntry[];
  offset: number;
  rotated: boolean;
  size: number;
};

export function createLogTailCursor(after = 0): LogTailCursor {
  const offset = normalizedOffset(after);

  return {
    carry: Buffer.alloc(0),
    emittedOffset: offset,
    readOffset: offset,
  };
}

export async function readNextLogBatch(
  logFile: string,
  cursor: LogTailCursor,
): Promise<LogTailBatch | null> {
  let fileStats: Stats;
  try {
    fileStats = await stat(logFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
  const inode = fileIdentity(fileStats);
  const rotated = resetCursorWhenFileChanged(cursor, inode, fileStats.size);

  if (cursor.readOffset > fileStats.size) {
    cursor.readOffset = fileStats.size;
    cursor.emittedOffset = fileStats.size;
    cursor.carry = Buffer.alloc(0);
    return {
      inode,
      logs: [],
      offset: cursor.emittedOffset,
      rotated: true,
      size: fileStats.size,
    };
  }

  if (cursor.readOffset === fileStats.size) {
    return rotated
      ? {
          inode,
          logs: [],
          offset: cursor.emittedOffset,
          rotated,
          size: fileStats.size,
        }
      : null;
  }

  const length = Math.min(fileStats.size - cursor.readOffset, maxReadBytes);
  const file = await open(logFile, "r");

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, cursor.readOffset);

    if (bytesRead === 0) {
      return null;
    }

    const chunk = buffer.subarray(0, bytesRead);
    const combinedStartOffset = cursor.readOffset - cursor.carry.length;
    const combined =
      cursor.carry.length > 0 ? Buffer.concat([cursor.carry, chunk]) : chunk;

    cursor.readOffset += bytesRead;

    const lastNewlineIndex = combined.lastIndexOf(0x0a);
    if (lastNewlineIndex === -1) {
      cursor.carry = combined;
      return rotated
        ? {
            inode,
            logs: [],
            offset: cursor.emittedOffset,
            rotated,
            size: fileStats.size,
          }
        : null;
    }

    const completeLines = combined.subarray(0, lastNewlineIndex + 1);
    cursor.carry = combined.subarray(lastNewlineIndex + 1);
    cursor.emittedOffset = combinedStartOffset + lastNewlineIndex + 1;

    return {
      inode,
      logs: parseLogLines(completeLines),
      offset: cursor.emittedOffset,
      rotated,
      size: fileStats.size,
    };
  } finally {
    await file.close();
  }
}

function normalizedOffset(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function resetCursorWhenFileChanged(
  cursor: LogTailCursor,
  inode: string | undefined,
  size: number,
) {
  const previousInode = cursor.inode;
  cursor.inode = inode;

  if (
    (previousInode && inode && previousInode !== inode) ||
    size < cursor.emittedOffset
  ) {
    cursor.carry = Buffer.alloc(0);
    cursor.emittedOffset = 0;
    cursor.readOffset = 0;
    return true;
  }

  return false;
}

function fileIdentity(stats: Stats) {
  return `${stats.dev}:${stats.ino}`;
}

function parseLogLines(buffer: Buffer) {
  return buffer
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogTailEntry];
      } catch {
        return [];
      }
    });
}
