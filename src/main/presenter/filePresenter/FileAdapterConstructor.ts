import { CsvFileAdapter } from './CsvFileAdapter'
import { ExcelFileAdapter } from './ExcelFileAdapter'
import { ImageFileAdapter } from './ImageFileAdapter'
import { TextFileAdapter } from './TextFileAdapter'

export type FileAdapterConstructor = new (
  filePath: string,
  maxFileSize: number
) => CsvFileAdapter | TextFileAdapter | ExcelFileAdapter | ImageFileAdapter
