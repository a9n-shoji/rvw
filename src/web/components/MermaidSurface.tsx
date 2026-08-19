import { useEffect, useId, useState, type ComponentPropsWithoutRef } from "react";
import type { ThemePreference } from "../theme.js";

let mermaidQueue = Promise.resolve();
const darkColorSchemeQuery = "(prefers-color-scheme: dark)";

function usePrefersDarkColorScheme(): boolean {
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia(darkColorSchemeQuery).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(darkColorSchemeQuery);
    const updatePreference = (): void => setPrefersDark(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return prefersDark;
}

export function MermaidSurface({
  source,
  themePreference,
  renderIdPrefix,
  errorClassName,
  onRendered,
  ...props
}: {
  source: string;
  themePreference: ThemePreference;
  renderIdPrefix: string;
  errorClassName: string;
  onRendered?: (container: HTMLDivElement) => void;
} & Omit<ComponentPropsWithoutRef<"div">, "children">) {
  const generatedId = useId().replace(/[^A-Za-z0-9]/g, "");
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prefersDarkColorScheme = usePrefersDarkColorScheme();
  const dark =
    themePreference === "dark" || (themePreference === "system" && prefersDarkColorScheme);

  useEffect(() => setError(null), [dark, source]);

  useEffect(() => {
    if (!container) return;
    let disposed = false;
    setError(null);
    const renderId = `${renderIdPrefix}${generatedId}`;
    mermaidQueue = mermaidQueue
      .then(async () => {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          suppressErrorRendering: true,
          securityLevel: "strict",
          theme: dark ? "dark" : "base",
          flowchart: { htmlLabels: false, curve: "basis" },
          themeVariables: dark
            ? { primaryColor: "#1f2937", primaryTextColor: "#f0f6fc", lineColor: "#8c959f" }
            : { primaryColor: "#eef5ff", primaryTextColor: "#24292f", lineColor: "#57606a" },
        });
        const rendered = await mermaid.render(renderId, source);
        if (disposed) return;
        container.innerHTML = rendered.svg;
        onRendered?.(container);
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "diagramを表示できません。");
        }
      })
      .finally(() => {
        document.getElementById(`d${renderId}`)?.remove();
        document.getElementById(`i${renderId}`)?.remove();
      });
    return () => {
      disposed = true;
    };
  }, [container, dark, generatedId, onRendered, renderIdPrefix, source]);

  if (error) return <div className={errorClassName}>{error}</div>;
  return <div {...props} ref={setContainer} />;
}
