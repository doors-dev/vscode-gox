; inherits: go

((gox_style_head
  (gox_raw_text) @injection.content)
  (#set! injection.language "css"))

((gox_script_head
  (gox_raw_text) @injection.content)
  (#set! injection.language "javascript"))

((gox_raw_head
  (gox_raw_text) @injection.content)
  (#set! injection.language "html"))
