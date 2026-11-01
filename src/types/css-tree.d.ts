// The package provides runtime subpath exports; DefinitelyTyped only declares the root API.
declare module "css-tree/parser" {
  export { parse as default } from "css-tree";
}
declare module "css-tree/walker" {
  export { walk as default } from "css-tree";
}
declare module "css-tree/generator" {
  export { generate as default } from "css-tree";
}
declare module "css-tree/utils" {
  export { ident } from "css-tree";
}
