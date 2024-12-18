import MarkdownIt from "markdown-it"
import markdownItFootnote from "markdown-it-footnote"
import DOMPurify from "isomorphic-dompurify"

const markdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
})
  .use(markdownItFootnote)
  .enable(["table", "list"])

// Add custom renderer for todo lists
markdownIt.renderer.rules.list_item_open = (tokens, idx) => {
  const token = tokens[idx + 2]
  if (token && token.content) {
    // Check for todo list pattern
    const match = token.content.match(/^\[([ xX])\]\s*(.*)$/)
    if (match) {
      const isChecked = match[1].toLowerCase() === "x"
      token.content = match[2]
      return `<li class="task-list-item"><input type="checkbox" ${
        isChecked ? "checked" : ""
      } disabled>`
    }
  }
  return "<li>"
}

interface SlideContent {
  type: "h1" | "h2" | "content" | "image" | "table"
  content: string
}

interface ConversionOptions {
  preserveNewlines?: boolean
  sanitize?: boolean
  maxCharsPerSlide?: number
  maxWordsPerSlide?: number
  maxLinesPerSlide?: number
}

interface TableChunk {
  headers: string[]
  rows: string[]
}

const splitTableIntoChunks = (
  headers: string[],
  rows: string[],
  maxLinesPerSlide: number
): TableChunk[] => {
  const chunks: TableChunk[] = []
  const avgCharsPerRow =
    rows.reduce((sum, row) => sum + row.length, 0) / rows.length
  const estimatedRowsPerSlide = Math.min(
    maxLinesPerSlide - 2, // Account for header and separator
    Math.floor(1000 / avgCharsPerRow) // Estimate based on content length
  )

  for (let i = 0; i < rows.length; i += estimatedRowsPerSlide) {
    chunks.push({
      headers,
      rows: rows.slice(i, i + estimatedRowsPerSlide),
    })
  }

  return chunks
}

// Modify the content processing to keep list items together
const processContent = (
  line: string,
  currentSection: SlideContent[]
): SlideContent[] => {
  if (line.startsWith("- [") || line.startsWith("* [")) {
    // Start or continue a todo list
    if (
      !currentSection.length ||
      currentSection[currentSection.length - 1].type !== "content"
    ) {
      currentSection.push({
        type: "content",
        content: '<ul class="task-list">\n',
      })
    }
    const match = line.match(/^[-*]\s*\[([ xX])\]\s*(.*)$/)
    if (match) {
      const isChecked = match[1].toLowerCase() === "x"
      const content = match[2]
      currentSection[
        currentSection.length - 1
      ].content += `<li class="task-list-item"><input type="checkbox" ${
        isChecked ? "checked" : ""
      } disabled>${content}</li>\n`
    }
  } else {
    // Close any open list and add new content
    if (
      currentSection.length &&
      currentSection[currentSection.length - 1].type === "content" &&
      currentSection[currentSection.length - 1].content.includes(
        '<ul class="task-list">'
      )
    ) {
      currentSection[currentSection.length - 1].content += "</ul>"
    }
    currentSection.push({ type: "content", content: markdownIt.render(line) })
  }
  return currentSection
}

export function convertMarkdownToHTML(
  markdown: string,
  options: ConversionOptions = {}
): string {
  const {
    preserveNewlines = true,
    sanitize = true,
    maxCharsPerSlide = 1000,
    maxWordsPerSlide = 250,
    maxLinesPerSlide = 7,
  } = options

  const sections: SlideContent[][] = []
  let currentSection: SlideContent[] = []
  let tableBuffer: string[] = []

  const countWords = (text: string): number => {
    return text
      .trim()
      .split(/\s+/)
      .filter(word => word.length > 0).length
  }

  const shouldCreateNewSection = (
    content: string,
    currentContent: SlideContent[]
  ): boolean => {
    const totalChars =
      currentContent.reduce((sum, item) => sum + item.content.length, 0) +
      content.length
    const totalWords =
      currentContent.reduce((sum, item) => sum + countWords(item.content), 0) +
      countWords(content)
    const totalLines = currentContent.length + 1

    return (
      totalChars > maxCharsPerSlide ||
      totalWords > maxWordsPerSlide ||
      totalLines > maxLinesPerSlide
    )
  }

  const createNewSection = () => {
    if (currentSection.length > 0) {
      sections.push(currentSection)
      currentSection = []
    }
  }

  const processTable = (tableLines: string[]): string[] => {
    // Remove any empty lines
    const cleanedLines = tableLines.filter(line => line.trim().length > 0)
    if (cleanedLines.length < 2) return [""] // Need at least header and separator

    // Extract headers, separator and content rows
    const headers = cleanedLines[0]
      .split("|")
      .map(cell => cell.trim())
      .filter(Boolean)
    const separator = cleanedLines[1]
    const contentRows = cleanedLines.slice(2)

    // Check if table fits in one slide (headers + separator + content rows)
    if (cleanedLines.length <= maxLinesPerSlide) {
      const tableHtml = markdownIt.render(tableLines.join("\n"))
      return [`<div class="table-wrapper">${tableHtml}</div>`]
    }

    // Split into chunks that fit within slide limits
    const chunks = splitTableIntoChunks(headers, contentRows, maxLinesPerSlide)

    // Convert each chunk to HTML
    return chunks.map(chunk => {
      const chunkMarkdown = [
        `|${headers.join("|")}|`,
        separator,
        ...chunk.rows,
      ].join("\n")

      const tableHtml = markdownIt.render(chunkMarkdown)
      return `<div class="table-wrapper">${tableHtml}</div>`
    })
  }

  const lines = markdown.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Handle page breaks
    if (line === "===") {
      if (tableBuffer.length > 0) {
        const tableHtmlChunks = processTable(tableBuffer)

        for (let i = 0; i < tableHtmlChunks.length; i++) {
          const tableHtml = tableHtmlChunks[i]
          if (tableHtml) {
            if (i > 0 || shouldCreateNewSection(tableHtml, currentSection)) {
              createNewSection()
            }
            currentSection.push({ type: "table", content: tableHtml })
          }
        }
        tableBuffer = []
      }
      createNewSection()
      continue
    }

    // Handle H1 (Title slide)
    if (line.startsWith("# ")) {
      if (tableBuffer.length > 0) {
        const tableHtmlChunks = processTable(tableBuffer)

        for (let i = 0; i < tableHtmlChunks.length; i++) {
          const tableHtml = tableHtmlChunks[i]
          if (tableHtml) {
            if (i > 0 || shouldCreateNewSection(tableHtml, currentSection)) {
              createNewSection()
            }
            currentSection.push({ type: "table", content: tableHtml })
          }
        }
        tableBuffer = []
      }
      createNewSection()

      // Convert markdown content to HTML, but strip the outer <p> tags
      const markdownContent = line.substring(2)
      const htmlContent = markdownIt.renderInline(markdownContent)

      sections.push([{ type: "h1", content: htmlContent }])
      continue
    }

    // Handle H2 (Section header)
    if (line.startsWith("## ")) {
      if (tableBuffer.length > 0) {
        const tableHtmlChunks = processTable(tableBuffer)

        for (let i = 0; i < tableHtmlChunks.length; i++) {
          const tableHtml = tableHtmlChunks[i]
          if (tableHtml) {
            if (i > 0 || shouldCreateNewSection(tableHtml, currentSection)) {
              createNewSection()
            }
            currentSection.push({ type: "table", content: tableHtml })
          }
        }
        tableBuffer = []
      }
      createNewSection()

      // Convert markdown content to HTML, but strip the outer <p> tags
      const markdownContent = line.substring(3)
      const htmlContent = markdownIt.renderInline(markdownContent)

      currentSection = [{ type: "h2", content: htmlContent }]
      continue
    }

    // Table handling
    if (line.startsWith("|") || line.match(/^\s*[-|]+\s*$/)) {
      tableBuffer.push(line)
      continue
    } else if (tableBuffer.length > 0) {
      // End of table detected
      const tableHtmlChunks = processTable(tableBuffer)

      for (let i = 0; i < tableHtmlChunks.length; i++) {
        const tableHtml = tableHtmlChunks[i]
        if (tableHtml) {
          if (i > 0 || shouldCreateNewSection(tableHtml, currentSection)) {
            createNewSection()
          }
          currentSection.push({ type: "table", content: tableHtml })
        }
      }
      tableBuffer = []
    }

    // Handle images
    if (line.match(/!\[.*\]\(.*\)/)) {
      const imgMatch = line.match(/!\[(.*)\]\((.*)\)/)
      if (imgMatch) {
        if (currentSection.length === 0) {
          // Solo image slide
          sections.push([{ type: "image", content: imgMatch[2] }])
        } else {
          if (shouldCreateNewSection(line, currentSection)) {
            createNewSection()
          }
          currentSection.push({ type: "image", content: imgMatch[2] })
        }
        createNewSection()
      }
      continue
    }

    // Handle regular content
    if (line.length > 0) {
      if (shouldCreateNewSection(line, currentSection)) {
        if (
          currentSection.length &&
          currentSection[currentSection.length - 1].content.includes(
            '<ul class="task-list">'
          )
        ) {
          currentSection[currentSection.length - 1].content += "</ul>"
        }
        createNewSection()
      }
      currentSection = processContent(line, currentSection)
    }
  }

  // Handle any remaining table buffer at the end
  if (tableBuffer.length > 0) {
    const tableHtmlChunks = processTable(tableBuffer)

    for (let i = 0; i < tableHtmlChunks.length; i++) {
      const tableHtml = tableHtmlChunks[i]
      if (tableHtml) {
        if (shouldCreateNewSection(tableHtml, currentSection)) {
          createNewSection()
        }
        currentSection.push({ type: "table", content: tableHtml })
      }
    }
  }

  // Handle any remaining content
  createNewSection()

  // Convert sections to HTML
  const htmlSections = sections.map(section => {
    return section
      .map(content => {
        switch (content.type) {
          case "h1":
            return `<h1>${content.content}</h1>`
          case "h2":
            return `<h2>${content.content}</h2>`
          case "image":
            return `<img src="${content.content}" class="slide-image"/>`
          case "table":
            return content.content // Table content is already HTML
          default:
            return markdownIt.render(content.content)
        }
      })
      .filter(Boolean)
      .join("\n")
  })

  // Join sections with page break markers
  let finalHtml = htmlSections
    .filter(Boolean)
    .join('\n<div data-type="page-break" data-page-break="true"></div>\n')

  if (preserveNewlines) {
    finalHtml = finalHtml.replace(/\n+/g, "\n").replace(/>\n+</g, ">\n<")
  }

  if (sanitize) {
    finalHtml = DOMPurify.sanitize(finalHtml)
  }

  return finalHtml
}
