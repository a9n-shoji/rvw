import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { api, type ThemePreferenceResponse } from "./api.js";
import "./styles/main.css";
import {
  applyThemePreference,
  readThemePreference,
  storeThemePreference,
  type ThemePreference,
} from "./theme.js";
import { installViewerReleaseHandler } from "./viewer-session.js";

installViewerReleaseHandler();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 500 },
    mutations: { retry: false },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("root elementがありません。");

async function readInitialThemePreference(): Promise<ThemePreference> {
  const browserPreference = readThemePreference();
  applyThemePreference(browserPreference);
  try {
    const response = await api<ThemePreferenceResponse>("/api/preferences/theme");
    storeThemePreference(response.themePreference);
    queryClient.setQueryData(["theme-preference"], response);
    return response.themePreference;
  } catch (error) {
    console.warn("共有テーマ設定を読み込めませんでした。ブラウザーの設定を使用します。", error);
    return browserPreference;
  }
}

void readInitialThemePreference().then((initialThemePreference) => {
  applyThemePreference(initialThemePreference);
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App initialThemePreference={initialThemePreference} />
      </QueryClientProvider>
    </StrictMode>,
  );
});
