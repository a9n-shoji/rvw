import type { ChangedFile } from "./models.js";

export function changedFilePath(change: ChangedFile): string | null {
  return change.newPath ?? change.oldPath;
}
