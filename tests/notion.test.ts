import { describe, expect, it } from "vitest";
import { markdownToBlocks } from "../src/integrations/notion.js";

describe("markdownToBlocks", () => {
  it("maps headings, bullets, quotes, paragraphs", () => {
    const md = [
      "# Title",
      "",
      "## Section",
      "",
      "Paragraph text.",
      "",
      "- bullet one",
      "- bullet two",
      "",
      "> quote line",
      "",
    ].join("\n");
    const blocks = markdownToBlocks(md);
    const types = blocks.map((b) => (b as { type: string }).type);
    expect(types).toEqual([
      "heading_1",
      "heading_2",
      "paragraph",
      "bulleted_list_item",
      "bulleted_list_item",
      "quote",
    ]);
  });

  it("splits very long lines into multiple rich_text chunks", () => {
    const longLine = "a".repeat(5000);
    const blocks = markdownToBlocks(longLine);
    const para = blocks[0] as unknown as { paragraph: { rich_text: unknown[] } };
    expect(para.paragraph.rich_text.length).toBeGreaterThan(1);
  });
});
