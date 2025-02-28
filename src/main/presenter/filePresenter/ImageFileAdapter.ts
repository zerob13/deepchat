import { BaseFileAdapter } from './BaseFileAdapter'
import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
// import { VisionService } from '../llm/VisionService'
// import { loadVisionConfig } from '../../utils/env'

export class ImageFileAdapter extends BaseFileAdapter {
  private maxFileSize: number
  private imageMetadata: {
    width?: number
    height?: number
    format?: string
  } = {}
  // private visionDescription: string | undefined

  constructor(filePath: string, maxFileSize: number) {
    super(filePath)
    this.maxFileSize = maxFileSize
  }

  protected getFileDescription(): string | undefined {
    return 'Image File'
  }

  /**
   * 使用视觉模型生成图片描述
   * 后续可以接入具体的视觉模型实现
   */
  // private async generateImageDescription(): Promise<string> {
  //   const visionConfig = loadVisionConfig()
  //   console.info('visionconfig', visionConfig)
  //   if (!visionConfig) {
  //     return ''
  //   }

  //   const visionService = new VisionService(visionConfig)
  //   return visionService.describeImage(this.filePath)
  // }

  /**
   * 提取图片的基本信息
   */
  private async extractImageMetadata(): Promise<void> {
    try {
      const metadata = await sharp(this.filePath).metadata()
      this.imageMetadata = {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format
      }
    } catch (error) {
      console.error('Error extracting image metadata:', error)
      // 如果 sharp 失败，至少从文件扩展名获取格式
      this.imageMetadata.format = path.extname(this.filePath).substring(1).toLowerCase()
    }
  }

  public async getLLMContent(): Promise<string | undefined> {
    const stats = await fs.stat(this.filePath)
    console.log('sss', stats.size, this.maxFileSize)
    if (stats.size > this.maxFileSize) {
      return undefined
    }

    // 提取图片元数据
    await this.extractImageMetadata()

    // 获取视觉描述
    const visionDescription = await this.getContent()

    // 构建基本信息
    const basicInfo = [
      `* **File Name:** ${path.basename(this.filePath)}`,
      `* **File Type:** Image File`,
      this.imageMetadata.format && `* **Image Format:** ${this.imageMetadata.format.toUpperCase()}`,
      `* **File Size:** ${stats.size} bytes`,
      `* **Creation Date:** ${stats.birthtime.toISOString().split('T')[0]}`,
      `* **Last Modified:** ${stats.mtime.toISOString().split('T')[0]}`
    ].filter(Boolean)

    // 构建图片信息（只有当宽高都存在时才显示）
    const imageInfo: string[] = []
    if (this.imageMetadata.width && this.imageMetadata.height) {
      imageInfo.push(`* **Dimensions:** ${this.imageMetadata.width} x ${this.imageMetadata.height}`)
    }

    const fileDescription = `# Image File Description

## Basic File Information
${basicInfo.join('\n')}
${imageInfo.length > 0 ? `\n## Image Information\n${imageInfo.join('\n')}` : ''}${visionDescription ? `\n## Visual Content Description\n${visionDescription}` : ''}`

    return fileDescription
  }

  async getContent(): Promise<string | undefined> {
    // if (this.visionDescription === undefined) {
    //   this.visionDescription = await this.generateImageDescription()
    // }
    // return this.visionDescription
    return ''
  }
}
