import type { JobItem } from "../jobs-page-contract";
import { JobCard } from "./JobCard";

export function ResultsList({ jobs }: { jobs: JobItem[] }) {
  return (
    <ul>
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} />
      ))}
    </ul>
  );
}
