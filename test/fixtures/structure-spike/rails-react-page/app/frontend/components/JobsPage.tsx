import { useState } from "react";
import type { JobsPagePayload } from "../jobs-page-contract";
import { ResultsList } from "./ResultsList";
import { SearchForm } from "./SearchForm";

export function JobsPage({ initialPayload }: { initialPayload: JobsPagePayload }) {
  const [query, setQuery] = useState(initialPayload.query);

  return (
    <section>
      <SearchForm query={query} onSearch={setQuery} />
      <p>{initialPayload.jobs.length}件</p>
      <ResultsList jobs={initialPayload.jobs} />
    </section>
  );
}
