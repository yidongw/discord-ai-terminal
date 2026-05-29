/**
 * Utility functions to format content for Discord's limited Markdown support.
 * Discord embeds don't support tables or preserve ASCII art well, so we convert them to code blocks.
 */

/**
 * Detects if a line is part of a Markdown table.
 * Tables have | at the start and end of lines.
 */
function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|');
}

/**
 * Detects if a line is a table separator (e.g., |---|---|)
 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|[-:\s|]+\|$/.test(trimmed);
}

/**
 * Detects if a line contains ASCII box-drawing characters used in diagrams.
 */
function hasBoxDrawingChars(line: string): boolean {
  // Box-drawing characters and arrows commonly used in ASCII diagrams
  return /[┌┐└┘├┤┬┴┼─│═║╔╗╚╝╠╣╦╩╬▶▷◀◁►◄→←↑↓⟶⟵]/.test(line);
}

/**
 * Detects if a line looks like part of an ASCII diagram.
 * This includes lines with box-drawing chars or lines that are mostly
 * made up of diagram-like characters (pipes, dashes, plus signs).
 */
function isDiagramLine(line: string): boolean {
  if (hasBoxDrawingChars(line)) {
    return true;
  }

  // Also catch ASCII art made with regular characters
  // Lines that are mostly |, -, +, /, \, _, with minimal text
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;

  // Count diagram-like characters
  const diagramChars = (trimmed.match(/[|+\-\\/_<>^v]/g) || []).length;
  const ratio = diagramChars / trimmed.length;

  // If more than 40% of the line is diagram characters and it has some structure
  return ratio > 0.4 && trimmed.length > 3;
}

/**
 * Groups consecutive lines that match a predicate into blocks.
 */
interface LineBlock {
  type: 'normal' | 'table' | 'diagram';
  lines: string[];
}

function groupLines(content: string): LineBlock[] {
  const lines = content.split('\n');
  const blocks: LineBlock[] = [];
  let currentBlock: LineBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let lineType: 'normal' | 'table' | 'diagram' = 'normal';

    // Check if it's a table line
    if (isTableLine(line) || isTableSeparator(line)) {
      // Look ahead and behind to confirm it's really a table
      const prevIsTable = i > 0 && (isTableLine(lines[i - 1]) || isTableSeparator(lines[i - 1]));
      const nextIsTable = i < lines.length - 1 && (isTableLine(lines[i + 1]) || isTableSeparator(lines[i + 1]));
      if (prevIsTable || nextIsTable || isTableSeparator(line)) {
        lineType = 'table';
      }
    }

    // Check if it's a diagram line (only if not already identified as table)
    if (lineType === 'normal' && isDiagramLine(line)) {
      // Look ahead and behind to confirm it's part of a diagram
      const prevIsDiagram = i > 0 && isDiagramLine(lines[i - 1]);
      const nextIsDiagram = i < lines.length - 1 && isDiagramLine(lines[i + 1]);
      if (prevIsDiagram || nextIsDiagram || hasBoxDrawingChars(line)) {
        lineType = 'diagram';
      }
    }

    // Add to current block or start a new one
    if (currentBlock && currentBlock.type === lineType) {
      currentBlock.lines.push(line);
    } else {
      if (currentBlock) {
        blocks.push(currentBlock);
      }
      currentBlock = { type: lineType, lines: [line] };
    }
  }

  if (currentBlock) {
    blocks.push(currentBlock);
  }

  return blocks;
}

/**
 * Formats content for Discord by wrapping tables and ASCII diagrams in code blocks.
 * This preserves their visual appearance since Discord doesn't render Markdown tables
 * and mangles ASCII art in embeds.
 */
export function formatForDiscord(content: string): string {
  // Don't process if the content is already mostly in code blocks
  const codeBlockCount = (content.match(/```/g) || []).length;
  if (codeBlockCount >= 4) {
    // Already heavily uses code blocks, leave it alone
    return content;
  }

  const blocks = groupLines(content);
  const result: string[] = [];

  for (const block of blocks) {
    if (block.type === 'table') {
      // Wrap table in a code block to preserve formatting
      result.push('```');
      result.push(...block.lines);
      result.push('```');
    } else if (block.type === 'diagram') {
      // Wrap diagram in a code block to preserve ASCII art
      result.push('```');
      result.push(...block.lines);
      result.push('```');
    } else {
      result.push(...block.lines);
    }
  }

  // Clean up: avoid empty code blocks and consecutive code block markers
  let output = result.join('\n');

  // Remove empty code blocks
  output = output.replace(/```\s*```/g, '');

  // Merge adjacent code blocks (```\n``` -> single block)
  output = output.replace(/```\n+```/g, '\n');

  return output;
}
