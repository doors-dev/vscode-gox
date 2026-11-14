; inherits: go

(gox_elem_function_declaration
  name: (identifier) @local.definition.function)

(gox_elem_method_declaration
  name: (field_identifier) @local.definition.method)

(gox_elem_function_declaration) @local.scope

(gox_elem_method_declaration) @local.scope

(gox_elem_func_literal) @local.scope
