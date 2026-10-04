# Result visual font subset

`LXGWWenKaiScreen-subset.ttf` is a 2 MB subset of the user-provided
`LXGWWenKaiScreen.ttf`. It includes project text, ASCII, punctuation, emoji,
and approximately 4,100 common Chinese characters. The Worker imports it as a
binary Data module, so result rendering does not depend on R2 or any external
font service.

When new fixed UI/template text requires a missing glyph, regenerate the
subset from the original font with `pyftsubset`, adding those characters to
the input set. Dynamic text outside the included glyph set should be
validated before a template is published.

`NotoColorEmoji-subset.ttf` is a 109 KB subset of Noto Color Emoji. It covers
common reaction, heart, sparkle, celebration, symbol, and profile emoji, and
loads as the renderer's second font without an external font or asset request.
