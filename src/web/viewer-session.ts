import {
  VIEWER_ID_HEADER,
  VIEWER_OPEN_LEASE_HEADER,
  VIEWER_OPEN_LEASE_QUERY,
} from "../shared/constants.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function consumeViewerOpenLease(): string | null {
  const url = new URL(window.location.href);
  const leaseId = url.searchParams.get(VIEWER_OPEN_LEASE_QUERY);
  if (leaseId === null) return null;
  url.searchParams.delete(VIEWER_OPEN_LEASE_QUERY);
  window.history.replaceState(window.history.state, "", url);
  return UUID_PATTERN.test(leaseId) ? leaseId : null;
}

export let viewerSessionId = crypto.randomUUID();
const viewerOpenLeaseId = consumeViewerOpenLease();

export function viewerHeartbeatRequest(): RequestInit {
  return {
    headers: {
      [VIEWER_ID_HEADER]: viewerSessionId,
      ...(viewerOpenLeaseId === null ? {} : { [VIEWER_OPEN_LEASE_HEADER]: viewerOpenLeaseId }),
    },
  };
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
