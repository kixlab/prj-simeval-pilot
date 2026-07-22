import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";
import type { CanvasSnapshot, SessionMetadata } from "./sessionTypes";

function safeSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function compactUtcTimestamp(isoTimestamp: string) {
  return isoTimestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function sessionArchiveBaseName(session: SessionMetadata) {
  const shortId = session.sessionId.split("-").at(-1)?.slice(-8) ?? "session";
  return [
    "simeval",
    `participant-${safeSegment(session.participantId)}`,
    `task-${safeSegment(session.taskType)}`,
    `seed-${safeSegment(session.seedId)}`,
    compactUtcTimestamp(session.startedAt),
    shortId
  ].join("__");
}

export function snapshotImageFileName(snapshot: CanvasSnapshot) {
  const sequence = String(snapshot.sequence).padStart(4, "0");
  const action = snapshot.actionSequence == null
    ? ""
    : `__action-${String(snapshot.actionSequence).padStart(4, "0")}`;
  return `screenshots/snapshot-${sequence}__${snapshot.reason}${action}.png`;
}

export class StreamingZipArchive {
  private readonly chunks: ArrayBuffer[] = [];
  private readonly archive: Zip;
  private readonly completed: Promise<Blob>;
  private resolveCompleted!: (blob: Blob) => void;
  private rejectCompleted!: (error: Error) => void;

  constructor() {
    this.completed = new Promise<Blob>((resolve, reject) => {
      this.resolveCompleted = resolve;
      this.rejectCompleted = reject;
    });
    this.archive = new Zip((error, chunk, final) => {
      if (error) {
        this.rejectCompleted(error);
        return;
      }
      this.chunks.push(chunk.slice().buffer as ArrayBuffer);
      if (final) {
        this.resolveCompleted(new Blob(this.chunks, { type: "application/zip" }));
      }
    });
  }

  addText(fileName: string, content: string) {
    const file = new ZipDeflate(fileName, { level: 6 });
    this.archive.add(file);
    file.push(strToU8(content), true);
  }

  async addBlob(fileName: string, blob: Blob) {
    const file = new ZipPassThrough(fileName);
    this.archive.add(file);
    file.push(new Uint8Array(await blob.arrayBuffer()), true);
  }

  finish() {
    this.archive.end();
    return this.completed;
  }
}
