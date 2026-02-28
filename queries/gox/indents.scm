; inherits: go

(gox_block) @indent.begin

(gox_block
  "}" @indent.branch @indent.end)

(gox_tilde_block) @indent.begin

(gox_tilde_block
  "}" @indent.branch @indent.end)

(gox_style_head
  (gox_open_head)) @indent.begin

(gox_script_head
  (gox_open_head)) @indent.begin

(gox_container_head
  (gox_open_head)) @indent.begin

(gox_head
  (gox_open_head)) @indent.begin

(gox_style_head
  (gox_close_head
    (gox_head_end) @indent.end))

(gox_script_head
  (gox_close_head
    (gox_head_end) @indent.end))

(gox_head
  (gox_close_head
    (gox_head_end) @indent.end))

(gox_container_head
  (gox_implicit_close_head) @indent.end)

(gox_head
  (gox_implicit_close_head) @indent.end)

(gox_style_head
  (gox_close_head) @indent.branch)

(gox_script_head
  (gox_close_head) @indent.branch)

(gox_container_head
  (gox_close_head) @indent.branch)

(gox_head
  (gox_close_head) @indent.branch)

(gox_void_head) @indent.begin

(gox_self_closing_head) @indent.begin

(gox_void_head
  (gox_self_closing_head_end) @indent.end)

(gox_self_closing_head
  (gox_self_closing_head_end) @indent.end)

(gox_self_closing_head_end) @indent.branch

(_
  (gox_lparen)
) @indent.begin

(_
  (gox_lparen)
  (gox_rparen) @indent.end @indent.branch
) 

