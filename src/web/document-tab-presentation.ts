import {
  documentTabKey,
  documentTabLabel,
  documentTabPath,
  type ActiveDocument,
} from "./document-workspace.js";

export interface DocumentTabPresentation {
  displayLabel: string;
  accessibleLabel: string;
  identityQualifier?: string;
}

function shortestUniqueDirectorySuffix(path: string, peerPaths: string[]): string {
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const segments = directory.split("/").filter(Boolean);
  for (let length = 1; length <= segments.length; length += 1) {
    const suffix = segments.slice(-length).join("/");
    const unique = peerPaths.every((peerPath) => {
      const peerDirectory = peerPath.includes("/")
        ? peerPath.slice(0, peerPath.lastIndexOf("/"))
        : "";
      return peerDirectory.split("/").filter(Boolean).slice(-length).join("/") !== suffix;
    });
    if (unique) return suffix;
  }
  return directory;
}

export function documentIdentityQualifier(document: ActiveDocument): string {
  if (document.kind === "pull-request-markdown") return "PR本文";
  if (document.kind === "walkthrough") return `Walkthrough ${document.id.slice(0, 8)}`;
  if (document.kind === "structure") return `Structure ${document.id.slice(0, 8)}`;
  return "repository";
}

export function documentTabPresentation(
  document: ActiveDocument,
  documents: ActiveDocument[],
): DocumentTabPresentation {
  const key = documentTabKey(document);
  const label = documentTabLabel(document);
  const path = documentTabPath(document);
  const peers = documents.filter(
    (candidate) => documentTabKey(candidate) !== key && documentTabLabel(candidate) === label,
  );
  if (peers.length === 0) return { displayLabel: label, accessibleLabel: path };

  if (peers.some((peer) => documentTabPath(peer) === path)) {
    const qualifier = documentIdentityQualifier(document);
    return {
      displayLabel: `${label} · ${qualifier}`,
      accessibleLabel: `${path}（${qualifier}）`,
      identityQualifier: qualifier,
    };
  }

  const directory = shortestUniqueDirectorySuffix(
    path,
    peers.map((peer) => documentTabPath(peer)),
  );
  return {
    displayLabel: `${label} · ${directory || "root"}`,
    accessibleLabel: path,
  };
}
