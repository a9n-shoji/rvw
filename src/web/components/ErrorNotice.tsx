import { ApiError } from "../api.js";
import type { SerializedRvwError } from "../../shared/errors.js";

function isSerializedRvwError(error: unknown): error is SerializedRvwError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Partial<SerializedRvwError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    Array.isArray(candidate.suggestions) &&
    candidate.suggestions.every((suggestion) => typeof suggestion === "string")
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const serialized = isSerializedRvwError(error) ? error : null;
  const message =
    error instanceof Error
      ? error.message
      : (serialized?.message ?? "予期しないエラーが発生しました。");
  const code = error instanceof ApiError ? error.code : (serialized?.code ?? null);
  const suggestions =
    error instanceof ApiError ? error.suggestions : (serialized?.suggestions ?? []);

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
