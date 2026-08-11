import { ApiError } from "../api.js";

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "予期しないエラーが発生しました。";
  const code = error instanceof ApiError ? error.code : null;
  const suggestions = error instanceof ApiError ? error.suggestions : [];

  return (
    <div className="error-notice" role="alert">
      <div>
        <strong>処理に失敗しました。</strong>
        {code && <code>{code}</code>}
      </div>
      <p>{message}</p>
      {suggestions.length > 0 && (
        <ul>
          {suggestions.map((suggestion) => (
            <li key={suggestion}>{suggestion}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
