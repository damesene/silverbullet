import {
  findNodeOfType,
  renderToText,
} from "@silverbulletmd/silverbullet/lib/tree";
import { expect, test } from "vitest";
import { markdownLinkParts } from "./markdown_link.ts";
import { parseMarkdown } from "./parser.ts";

function partsOf(markdown: string, type = "Link") {
  const node = findNodeOfType(parseMarkdown(markdown), type)!;
  const parts = markdownLinkParts(node.children!);
  return (
    parts && {
      text: markdown.slice(parts.textFrom, parts.textTo),
      url: renderToText(parts.url),
    }
  );
}

test("a link around an image takes its text and url from its own brackets", () => {
  const markdown = "[![alt|300](/folder/preview.webp)](/Report.pdf)";
  expect(partsOf(markdown)).toEqual({
    text: "![alt|300](/folder/preview.webp)",
    url: "/Report.pdf",
  });
  expect(partsOf(markdown, "Image")).toEqual({
    text: "alt|300",
    url: "/folder/preview.webp",
  });
});

test("an image anywhere in the link text belongs to the link text", () => {
  expect(partsOf("[see **![i](a.png)** here](b.pdf)")).toEqual({
    text: "see **![i](a.png)** here",
    url: "b.pdf",
  });
});

test.each([
  ["[text](url)", "Link", "text", "url"],
  ["![alt|300](image.png)", "Image", "alt|300", "image.png"],
  [String.raw`[a \] b](url)`, "Link", String.raw`a \] b`, "url"],
  ["[a](url(x).md)", "Link", "a", "url(x).md"],
  ["[a](<with space.md>)", "Link", "a", "<with space.md>"],
])("%s", (markdown, type, text, url) => {
  expect(partsOf(markdown, type)).toEqual({ text, url });
});

test("a link title is not part of the url", () => {
  expect(partsOf('[a](Page.md "Tip")')).toEqual({ text: "a", url: "Page.md" });
});

test.each(["[text]()", "[![a](b.png)]()"])("%s has no url", (markdown) => {
  expect(partsOf(markdown)).toBeNull();
});
