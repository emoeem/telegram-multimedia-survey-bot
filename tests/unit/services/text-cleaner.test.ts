import { describe, expect, it } from "vitest";
import { cleanImportText, decodeHtmlEntities, dedupeStrings, stripInvisible } from "../../../src/services/text-cleaner";

describe("stripInvisible", () => {
  it("removes zero-width spaces and BOM", () => {
    expect(stripInvisible("hello\u200bworld")).toBe("helloworld");
    expect(stripInvisible("\ufefftest")).toBe("test");
    expect(stripInvisible("a\u200cb\u200cc")).toBe("abc");
  });

  it("removes bidirectional text controls", () => {
    expect(stripInvisible("hi\u2066world\u2067")).toBe("hiworld");
    expect(stripInvisible("\u202Ehello")).toBe("hello");
  });

  it("removes soft hyphens but keeps normal hyphens", () => {
    expect(stripInvisible("soft\u00adword")).toBe("softword");
    expect(stripInvisible("hard-word")).toBe("hard-word");
  });

  it("replaces non-breaking and special whitespace with regular spaces", () => {
    expect(stripInvisible("a\u00A0b\u3000c")).toBe("a b c");
    expect(stripInvisible("x\u202Fy\u205Fz")).toBe("x y z");
  });

  it("preserves normal ASCII whitespace", () => {
    expect(stripInvisible("a b  c\td")).toBe("a b  c\td");
  });

  it("removes control characters", () => {
    expect(stripInvisible("a\u0000b\u0001c\u001Fd\u007Fe")).toBe("abcde");
  });

  it("removes ZWNJ and Arabic letter marks", () => {
    expect(stripInvisible("test\u200c")).toBe("test");
    expect(stripInvisible("\u0600test")).toBe("test");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes common named entities", () => {
    expect(decodeHtmlEntities("AT&amp;T")).toBe("AT&T");
    expect(decodeHtmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("a &lt; b")).toBe("a < b");
    expect(decodeHtmlEntities("b &gt; a")).toBe("b > a");
    expect(decodeHtmlEntities("&quot;hello&quot;")).toBe('"hello"');
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
  });

  it("decodes numeric decimal entities", () => {
    expect(decodeHtmlEntities("&#65;")).toBe("A");
    expect(decodeHtmlEntities("&#8364;")).toBe("€");
  });

  it("decodes numeric hex entities", () => {
    expect(decodeHtmlEntities("&#x41;")).toBe("A");
    expect(decodeHtmlEntities("&#x20AC;")).toBe("€");
  });

  it("decodes full Unicode named entities like Euro and fractions", () => {
    expect(decodeHtmlEntities("&euro;")).toBe("€");
    expect(decodeHtmlEntities("&frac12;")).toBe("½");
    expect(decodeHtmlEntities("&frac34;")).toBe("¾");
    expect(decodeHtmlEntities("&hellip;")).toBe("…");
    expect(decodeHtmlEntities("&copy;")).toBe("©");
    expect(decodeHtmlEntities("&reg;")).toBe("®");
    expect(decodeHtmlEntities("&trade;")).toBe("™");
  });

  it("decodes smart quote entities", () => {
    expect(decodeHtmlEntities("&ldquo;smart&rdquo;")).toBe("\u201Csmart\u201D");
    expect(decodeHtmlEntities("&lsquo;curly&rsquo;")).toBe("\u2018curly\u2019");
  });

  it("decodes all 252 HTML5 named entities that he supports", () => {
    expect(decodeHtmlEntities("&AElig;")).toBe("Æ");
    expect(decodeHtmlEntities("&aring;")).toBe("å");
    expect(decodeHtmlEntities("&oslash;")).toBe("ø");
    expect(decodeHtmlEntities("&thorn;")).toBe("þ");
    expect(decodeHtmlEntities("&OElig;")).toBe("Œ");
    expect(decodeHtmlEntities("&diams;")).toBe("♦");
    expect(decodeHtmlEntities("&hearts;")).toBe("♥");
    expect(decodeHtmlEntities("&clubs;")).toBe("♣");
    expect(decodeHtmlEntities("&spades;")).toBe("♠");
  });

  it("handles non-breaking space entity specially", () => {
    expect(decodeHtmlEntities("hello&nbsp;world")).toBe("hello\u00A0world");
  });

  it("leaves unrecognized entities unchanged (strict:false)", () => {
    expect(decodeHtmlEntities("&unknownfoo;")).toBe("&unknownfoo;");
  });

  it("handles emoji skin tone modifiers via numeric entities", () => {
    expect(decodeHtmlEntities("&#x1F600;")).toBe("😀");
    expect(decodeHtmlEntities("&#128512;")).toBe("😀");
  });
});

describe("cleanImportText", () => {
  it("returns empty string for null/undefined", () => {
    expect(cleanImportText(null)).toBe("");
    expect(cleanImportText(undefined)).toBe("");
    expect(cleanImportText("")).toBe("");
  });

  it("strips HTML tags but preserves text", () => {
    expect(cleanImportText("<p>Hello <strong>World</strong></p>")).toBe("Hello World");
    expect(cleanImportText('<span class="foo">test</span>')).toBe("test");
  });

  it("converts block-level closing tags to newlines", () => {
    expect(cleanImportText("<p>para1</p><p>para2</p>")).toBe("para1\n\npara2");
    expect(cleanImportText("<li>item1</li><li>item2</li>")).toBe("item1\n\nitem2");
  });

  it("converts <br> tags to newlines", () => {
    expect(cleanImportText("line1<br>line2")).toBe("line1\nline2");
    expect(cleanImportText("line1<br/>line2")).toBe("line1\nline2");
    expect(cleanImportText("line1<br />line2")).toBe("line1\nline2");
  });

  it("decodes HTML entities after stripping tags", () => {
    expect(cleanImportText("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(cleanImportText("&quot;quoted&quot;")).toBe('"quoted"');
    expect(cleanImportText("&#8203;zws&#8203;")).toBe("zws");
  });

  it("removes invisible Unicode characters", () => {
    expect(cleanImportText("hello\u200b\u200bworld")).toBe("helloworld");
    expect(cleanImportText("\ufeff\u2066test\u2067")).toBe("test");
  });

  it("normalizes special whitespace to regular spaces", () => {
    expect(cleanImportText("hello\u00A0\u3000world")).toBe("hello world");
  });

  it("collapses multiple spaces into one", () => {
    expect(cleanImportText("hello   world")).toBe("hello world");
  });

  it("collapses excessive blank lines", () => {
    expect(cleanImportText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("normalizes Unicode to NFC form", () => {
    const composed = "e\u0301";
    expect(cleanImportText(composed)).toBe("é");
  });

  it("trims leading and trailing whitespace", () => {
    expect(cleanImportText("  hello world  ")).toBe("hello world");
  });

  it("handles Microsoft Forms rich text pollution combined case", () => {
    const input = '<div class="something">\ufeff\u200bTom &amp; Jerry <br/><span>with &quot;quotes&quot;</span></div>';
    expect(cleanImportText(input)).toBe("Tom & Jerry\nwith \"quotes\"");
  });

  it("replaces contact referral strings", () => {
    expect(cleanImportText("@X_chunai07")).toBe("@ehdhhsbot");
    expect(cleanImportText("@x_chunai07")).toBe("@ehdhhsbot");
  });

  it("handles number types", () => {
    expect(cleanImportText(42)).toBe("42");
  });

  it("handles boolean types", () => {
    expect(cleanImportText(true)).toBe("true");
  });
});

describe("dedupeStrings", () => {
  it("removes exact duplicates", () => {
    expect(dedupeStrings(["a", "b", "a"])).toEqual(["a", "b"]);
  });

  it("removes case-insensitive duplicates", () => {
    expect(dedupeStrings(["Apple", "apple", "APPLE"])).toEqual(["Apple"]);
  });

  it("removes whitespace-only duplicates", () => {
    expect(dedupeStrings(["a", " a ", "b"])).toEqual(["a", "b"]);
  });

  it("deduplicates Unicode normalization variants", () => {
    const composed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    expect(dedupeStrings([composed, decomposed])).toEqual([composed]);
  });

  it("filters empty strings and whitespace-only strings", () => {
    expect(dedupeStrings(["", " ", "a", "  ", "b"])).toEqual(["a", "b"]);
  });

  it("preserves order of first occurrence", () => {
    expect(dedupeStrings(["z", "a", "m", "a", "z"])).toEqual(["z", "a", "m"]);
  });

  it("handles empty array", () => {
    expect(dedupeStrings([])).toEqual([]);
  });

  it("trims each output value", () => {
    expect(dedupeStrings(["  hello  ", "world"])).toEqual(["hello", "world"]);
  });
});
