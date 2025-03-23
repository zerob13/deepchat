import { BaseFileAdapter } from './BaseFileAdapter'
import fs from 'fs/promises'
import path from 'path'

export class CodeFileAdapter extends BaseFileAdapter {
  private maxFileSize: number
  private fileContent: string | undefined

  constructor(filePath: string, maxFileSize: number) {
    super(filePath)
    this.maxFileSize = maxFileSize
    this.fileContent = undefined
  }

  protected getFileDescription(): string | undefined {
    const ext = path.extname(this.filePath).toLowerCase()
    switch (ext) {
      case '.js':
      case '.jsx':
        return 'JavaScript Source File'
      case '.ts':
      case '.tsx':
        return 'TypeScript Source File'
      case '.py':
        return 'Python Source File'
      case '.java':
        return 'Java Source File'
      case '.c':
        return 'C Source File'
      case '.cpp':
      case '.cc':
      case '.cxx':
        return 'C++ Source File'
      case '.h':
        return 'C/C++ Header File'
      case '.hpp':
      case '.hxx':
      case '.hh':
        return 'C++ Header File'
      case '.cs':
        return 'C# Source File'
      case '.go':
        return 'Go Source File'
      case '.rb':
        return 'Ruby Source File'
      case '.php':
        return 'PHP Source File'
      case '.rs':
        return 'Rust Source File'
      case '.swift':
        return 'Swift Source File'
      case '.kt':
        return 'Kotlin Source File'
      case '.scala':
        return 'Scala Source File'
      case '.pl':
        return 'Perl Source File'
      case '.lua':
        return 'Lua Source File'
      case '.sh':
        return 'Shell Script'
      case '.html':
      case '.htm':
        return 'HTML File'
      case '.css':
        return 'CSS File'
      default:
        return 'Source Code File'
    }
  }

  private getLanguageFromExt(): string {
    const ext = path.extname(this.filePath).toLowerCase()
    switch (ext) {
      case '.js':
      case '.jsx':
        return 'javascript'
      case '.ts':
      case '.tsx':
        return 'typescript'
      case '.py':
        return 'python'
      case '.java':
        return 'java'
      case '.c':
        return 'c'
      case '.cpp':
      case '.cc':
      case '.cxx':
        return 'cpp'
      case '.h':
        return 'c'
      case '.hpp':
      case '.hxx':
      case '.hh':
        return 'cpp'
      case '.cs':
        return 'csharp'
      case '.go':
        return 'go'
      case '.rb':
        return 'ruby'
      case '.php':
        return 'php'
      case '.rs':
        return 'rust'
      case '.swift':
        return 'swift'
      case '.kt':
        return 'kotlin'
      case '.scala':
        return 'scala'
      case '.pl':
        return 'perl'
      case '.lua':
        return 'lua'
      case '.sh':
        return 'shell'
      case '.html':
      case '.htm':
        return 'html'
      case '.css':
        return 'css'
      default:
        return 'plaintext'
    }
  }

  async getContent(): Promise<string | undefined> {
    if (this.fileContent === undefined) {
      const fullPath = path.join(this.filePath)
      const stats = await fs.stat(fullPath)
      if (stats.size <= this.maxFileSize) {
        this.fileContent = await fs.readFile(fullPath, 'utf-8')
      }
    }
    return this.fileContent
  }

  public async getLLMContent(): Promise<string | undefined> {
    const fullPath = path.join(this.filePath)
    const stats = await fs.stat(fullPath)
    const content = await this.getContent()
    const language = this.getLanguageFromExt()

    const fileDescription = `# File Description

  ## Basic File Information

  * **File Name:** ${path.basename(this.filePath)}
  * **File Type:** ${this.getFileDescription()}
  * **File Format:** ${path.extname(this.filePath).substring(1)}
  * **Programming Language:** ${language}
  * **File Size:** ${stats.size} bytes
  * **Creation Date:** ${stats.birthtime.toISOString().split('T')[0]}
  * **Updated Date:** ${stats.mtime.toISOString().split('T')[0]}
  `
    if (content) {
      return `${fileDescription}

## File Content
  \`\`\`${language}
  ${content}
  \`\`\`
  `
    } else {
      return fileDescription
    }
  }
}
