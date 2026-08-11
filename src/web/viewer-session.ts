import { VIEWER_ID_HEADER } from "../shared/constants.js";

export let viewerSessionId = crypto.randomUUID();

export function viewerHeartbeatRequest(): RequestInit {
  return { headers: { [VIEWER_ID_HEADER]: viewerSessionId } };
}

let releaseHandlerInstalled = false;

export function installViewerReleaseHandler(): void {
  if (releaseHandlerInstalled) return;
  releaseHandlerInstalled = true;

  window.addEventListener("pagehide", () => {
    const body = JSON.stringify({ viewerId: viewerSessionId });
    const beaconBody = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon("/api/meta/viewers/release", beaconBody)) return;
    void fetch("/api/meta/viewers/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  });
  window.addEventListener("pageshow", (event) => {
    // A restored bfcache document needs a fresh ID because its released ID is tombstoned.
    if (!event.persisted) return;
    viewerSessionId = crypto.randomUUID();
    void fetch("/api/meta/change-sequence", viewerHeartbeatRequest()).catch(() => undefined);
  });
}
