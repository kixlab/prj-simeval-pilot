import { formatClock } from "../tasks/timing";

/** Helpers shared by the participant text screens (MacGyver, CS4). */

export async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function spokenDuration(seconds: number) {
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${formatClock(seconds * 1000)} (minutes:seconds)`;
}

export function koreanDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}초`;
  return rest === 0 ? `${minutes}분` : `${minutes}분 ${rest}초`;
}

export function newId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

// Typing that stops for this long closes an edit burst: the boundary at which
// a free-text answer is read as steps or sentences. The same idle window as the
// Excalidraw session's human action log.
export const pauseAfterMs = 700;

export const consentKo =
  "작업하는 동안 생각을 소리 내어 말해 주세요. 목소리는 연구를 위해 녹음되어 답과 함께 저장됩니다. 마이크에 문제가 있어도 작업하고 제출하는 데는 지장이 없습니다.";
