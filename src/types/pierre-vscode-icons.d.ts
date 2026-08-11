declare module "@pierre/vscode-icons/scripts/themes/*.mjs" {
  interface IconColorPair {
    dark: string;
    light: string;
  }

  interface IconDefinition {
    name: string;
    svgName?: string;
    color?: IconColorPair | { fg: IconColorPair; bg: IconColorPair };
    fileExtensions?: string[];
    fileNames?: string[];
  }

  const definitions: IconDefinition[];
  export default definitions;
}
