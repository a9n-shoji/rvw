import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, jsonRequest, type ThemePreferenceResponse } from "./api.js";
import { applyThemePreference, storeThemePreference, type ThemePreference } from "./theme.js";

export function useThemePreference(initialThemePreference: ThemePreference) {
  const queryClient = useQueryClient();
  const [themePreference, setThemePreference] = useState<ThemePreference>(initialThemePreference);
  const query = useQuery({
    queryKey: ["theme-preference"],
    queryFn: async () => await api<ThemePreferenceResponse>("/api/preferences/theme"),
  });
  useEffect(() => {
    const preference = query.data?.themePreference;
    if (!preference) return;
    setThemePreference(preference);
    applyThemePreference(preference);
    storeThemePreference(preference);
  }, [query.data?.themePreference]);
  const mutation = useMutation({
    mutationFn: async (preference: ThemePreference) =>
      await api<ThemePreferenceResponse>(
        "/api/preferences/theme",
        jsonRequest({ themePreference: preference }),
      ),
    onSuccess: (response) => {
      queryClient.setQueryData(["theme-preference"], response);
    },
  });
  const selectThemePreference = (preference: ThemePreference): void => {
    setThemePreference(preference);
    applyThemePreference(preference);
    storeThemePreference(preference);
    mutation.mutate(preference);
  };
  return { themePreference, selectThemePreference, query, mutation };
}
