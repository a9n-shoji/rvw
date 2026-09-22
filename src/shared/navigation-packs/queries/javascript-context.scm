; A property or function declaration name is not a local-variable use.
(function_declaration name: (identifier) @context.nonlocal)
; Direct, named ES imports only. Capture syntax; do not resolve project modules.
(import_statement
 (import_clause (named_imports (import_specifier
   name: (identifier) @import.name
   alias: (identifier)? @import.local)))
 source: (string (string_fragment) @import.source))
