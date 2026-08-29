import { createRoot } from "react-dom/client";
import type { JobsPagePayload } from "../jobs-page-contract";
import { JobsPage } from "../components/JobsPage";

const root = document.getElementById("jobs-page-root");
const payloadNode = document.getElementById("jobs-page-props");

if (root && payloadNode?.textContent) {
  const payload = JSON.parse(payloadNode.textContent) as JobsPagePayload;
  createRoot(root).render(<JobsPage initialPayload={payload} />);
}
