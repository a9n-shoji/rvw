export function SearchForm({
  query,
  onSearch,
}: {
  query: string;
  onSearch: (query: string) => void;
}) {
  return <input value={query} onChange={(event) => onSearch(event.currentTarget.value)} />;
}
