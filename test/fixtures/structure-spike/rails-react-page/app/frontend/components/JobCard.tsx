import type { JobItem } from "../jobs-page-contract";

export function JobCard({ job }: { job: JobItem }) {
  return (
    <li>
      <strong>{job.title}</strong>
      <span>{job.location}</span>
    </li>
  );
}
