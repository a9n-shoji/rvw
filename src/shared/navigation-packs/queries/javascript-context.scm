; Declaration names bind outside the declaration's own function scope.
(function_declaration name: (identifier) @local.definition.outer @context.nonlocal)
(generator_function_declaration name: (identifier) @local.definition.outer @context.nonlocal)
(class_declaration name: (_) @local.definition.outer @context.nonlocal)
; Direct, named ES imports only. Capture syntax; do not resolve project modules.
(import_statement
 (import_clause (named_imports (import_specifier
   name: (identifier) @import.name
   alias: (identifier)? @import.local)))
 source: (string (string_fragment) @import.source))
