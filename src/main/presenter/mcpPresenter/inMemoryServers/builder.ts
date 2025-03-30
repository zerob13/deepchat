import { FileSystemServer } from './filesystem'

export function getInMemoryServer(serverName: string, args: string[]) {
  switch (serverName) {
    case 'inMemoryFileSystem':
      return new FileSystemServer(args)
    default:
      throw new Error(`Unknown in-memory server: ${serverName}`)
  }
}
