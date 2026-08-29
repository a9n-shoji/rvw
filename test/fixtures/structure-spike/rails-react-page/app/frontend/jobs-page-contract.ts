export type JobItem = {
  id: string;
  title: string;
  location: string;
};

export type JobsPagePayload = {
  query: string;
  page: number;
  facets: Record<string, number>;
  jobs: JobItem[];
};
