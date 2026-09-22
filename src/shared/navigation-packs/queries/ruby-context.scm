; Ruby hard scope boundaries supplement the upstream locals query.
([(class) (module) (singleton_class) (singleton_method)] @local.scope
 (#set! local.scope-inherits false))
; A method name is not a local-variable reference, including explicit receivers.
(call method: (identifier) @context.nonlocal)
(method name: (identifier) @context.nonlocal)
(singleton_method name: (identifier) @context.nonlocal)
