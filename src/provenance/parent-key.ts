import type { ParentSelection } from "./model.js";

export function parentSelectionKey(parent: ParentSelection | null): string {
  if (parent === null) return "none";
  if (parent.kind === "commit") return "commit:" + parent.commitId + ":" + parent.evidence;
  if (parent.kind === "ambiguous") return "ambiguous:" + parent.parentIds.join(",");
  if (parent.kind === "unavailable") return "unavailable:" + parent.reason;
  return "root";
}
