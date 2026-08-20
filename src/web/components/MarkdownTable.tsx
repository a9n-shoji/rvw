import type { Components } from "react-markdown";
import { markdownSourceDataAttributes } from "../markdown-source-map.js";

// A module-level renderer keeps React from remounting the horizontal scroller on preview updates.
export const PreviewMarkdownTable: NonNullable<Components["table"]> = ({
  children,
  node,
  ...props
}) => {
  return (
    <div className="markdown-table-scroll">
      <table {...markdownSourceDataAttributes(node)} {...props}>
        {children}
      </table>
    </div>
  );
};
