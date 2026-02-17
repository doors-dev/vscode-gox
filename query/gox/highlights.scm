; inherits: go

(gox_erroneous_close_head) @comment.error

(gox_erroneous_close_head
  [
    "</"
    ">"
  ] @comment.error)

(gox_comment) @comment @spell

(gox_head_name) @tag

(gox_attr_name) @tag.attribute

(gox_tilde_marker) @punctuation.special

(gox_composite_arg
  [
    "("
    ")"
  ] @punctuation.special
)

(gox_attr_mod
  [
    "("
    ")"
  ] @punctuation.special)

(gox_attr
    [
      "("
      ")"
    ] @punctuation.special)

(gox_tilde_job
  [
    "("
    ")"
  ] @punctuation.special)

(gox_tilde_if
  [
    "("
    ")"
  ] @punctuation.special)

(gox_tilde_for
  [
    "("
    ")"
  ] @punctuation.special)

(gox_redundant) @comment.warning

(gox_tilde_comment
  (gox_tilde_marker) @comment)

(gox_open_head_beg) @punctuation.bracket

(gox_close_head_beg) @punctuation.bracket

(gox_head_end) @punctuation.bracket

(gox_self_closing_head_end) @punctuation.bracket

(gox_doctype) @constant

(gox_doctype
  "<!" @punctuation.bracket)

(gox_elem_function_declaration
  name: (identifier) @function)

(gox_elem_method_declaration
  name: (field_identifier) @function.method)

"elem" @keyword.function
