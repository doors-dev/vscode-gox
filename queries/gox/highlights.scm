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

(gox_lparen) @punctuation.special
(gox_rparen) @punctuation.special
(gox_redundant) @punctuation.special

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
