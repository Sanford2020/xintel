import { Client } from "@notionhq/client";
import { readFileSync } from "node:fs";
import dayjs from "dayjs";
import type { AppConfig } from "../config/schema.js";
import { getLogger } from "../utils/logger.js";

export interface PushOptions {
  summaryPath: string;
  parentPageId?: string | null;
  notionToken?: string;
  titleOverride?: string;
}

export interface PushResult {
  pageId: string;
  url?: string;
  blockCount: number;
}

const BLOCK_LIMIT = 100;

interface NotionRichTextItem {
  type: "text";
  text: { content: string };
}

interface NotionBlockBase {
  object: "block";
}

interface NotionParagraphBlock extends NotionBlockBase {
  type: "paragraph";
  paragraph: { rich_text: NotionRichTextItem[] };
}

interface NotionHeadingBlock<T extends "heading_1" | "heading_2" | "heading_3"> extends NotionBlockBase {
  type: T;
  // marker so TS keeps a discriminated structure regardless of the heading level
  heading: { rich_text: NotionRichTextItem[] };
}

interface NotionBulletBlock extends NotionBlockBase {
  type: "bulleted_list_item";
  bulleted_list_item: { rich_text: NotionRichTextItem[] };
}

interface NotionQuoteBlock extends NotionBlockBase {
  type: "quote";
  quote: { rich_text: NotionRichTextItem[] };
}

type NotionBlock =
  | NotionParagraphBlock
  | NotionHeadingBlock<"heading_1" | "heading_2" | "heading_3">
  | NotionBulletBlock
  | NotionQuoteBlock;

function rt(content: string): NotionRichTextItem[] {
  // Notion limits text content per rich_text item to 2000 characters
  const chunks: NotionRichTextItem[] = [];
  let remaining = content || "";
  while (remaining.length > 0) {
    const slice = remaining.slice(0, 1900);
    chunks.push({ type: "text", text: { content: slice } });
    remaining = remaining.slice(1900);
    if (chunks.length > 5) break; // safety; very long lines truncated downstream
  }
  if (chunks.length === 0) chunks.push({ type: "text", text: { content: "" } });
  return chunks;
}

function makeHeading(level: 1 | 2 | 3, text: string): NotionBlock {
  if (level === 1) {
    return {
      object: "block",
      type: "heading_1",
      heading: { rich_text: rt(text) },
    } as unknown as NotionBlock;
  }
  if (level === 2) {
    return {
      object: "block",
      type: "heading_2",
      heading: { rich_text: rt(text) },
    } as unknown as NotionBlock;
  }
  return {
    object: "block",
    type: "heading_3",
    heading: { rich_text: rt(text) },
  } as unknown as NotionBlock;
}

export function markdownToBlocks(md: string): NotionBlock[] {
  const lines = md.split(/\r?\n/);
  const blocks: NotionBlock[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, "");
    if (!line.trim()) continue;
    if (line.startsWith("# ")) {
      blocks.push(makeHeading(1, line.slice(2)));
    } else if (line.startsWith("## ")) {
      blocks.push(makeHeading(2, line.slice(3)));
    } else if (line.startsWith("### ")) {
      blocks.push(makeHeading(3, line.slice(4)));
    } else if (/^\s*[-*]\s+/.test(line)) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: rt(line.replace(/^\s*[-*]\s+/, "")) },
      });
    } else if (line.startsWith("> ")) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: rt(line.slice(2)) },
      });
    } else {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: rt(line) },
      });
    }
  }
  return blocks;
}

function fillTitle(template: string): string {
  const date = dayjs().format("YYYY-MM-DD");
  return template.replace("{date}", date);
}

export async function pushSummary(
  opts: PushOptions,
  cfg: AppConfig,
): Promise<PushResult> {
  const log = getLogger();
  const token = opts.notionToken ?? process.env.NOTION_TOKEN;
  const parent = opts.parentPageId ?? cfg.notion.parentPageId ?? process.env.NOTION_PARENT_PAGE_ID;

  if (!token) {
    throw new Error(
      "Notion token missing. Set NOTION_TOKEN in your environment (a Notion integration internal token). " +
        "Do not commit this to the repo.",
    );
  }
  if (!parent) {
    throw new Error(
      "Notion parent page id missing. Configure notion.parentPageId in config/local.json " +
        "or pass --parent-page-id. Without it, this command will not silently push to the wrong page.",
    );
  }

  const md = readFileSync(opts.summaryPath, "utf8");
  const blocks = markdownToBlocks(md);
  log.info({ blocks: blocks.length, parent }, "Pushing summary to Notion");

  const notion = new Client({ auth: token });

  const title = opts.titleOverride ?? fillTitle(cfg.notion.titleTemplate);

  const initial = blocks.slice(0, BLOCK_LIMIT);
  const rest = blocks.slice(BLOCK_LIMIT);

  // The Notion SDK has detailed runtime types we don't reproduce here; using
  // typed-ish unknown casts keeps us off `any` while staying type-safe at the
  // call site. The structures match the Notion API.
  const createInput = {
    parent: { page_id: parent },
    properties: {
      title: { title: [{ type: "text" as const, text: { content: title } }] },
    },
    children: initial,
  };

  // The SDK accepts a wider object than our minimal block types describe;
  // cast through unknown to satisfy both ends without weakening callers.
  const page = (await notion.pages.create(createInput as unknown as Parameters<typeof notion.pages.create>[0])) as { id: string; url?: string };

  let pushed = initial.length;
  for (let i = 0; i < rest.length; i += BLOCK_LIMIT) {
    const chunk = rest.slice(i, i + BLOCK_LIMIT);
    await notion.blocks.children.append({
      block_id: page.id,
      children: chunk as unknown as Parameters<typeof notion.blocks.children.append>[0]["children"],
    });
    pushed += chunk.length;
  }

  return { pageId: page.id, url: page.url, blockCount: pushed };
}
