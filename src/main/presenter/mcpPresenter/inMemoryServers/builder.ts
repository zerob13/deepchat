import { ArtifactsServer } from './artifactsServer'
import { FileSystemServer } from './filesystem'

export function getInMemoryServer(serverName: string, args: string[]) {
  switch (serverName) {
    case 'buildInFileSystem':
      return new FileSystemServer(args)
    case 'Artifacts':
      return new ArtifactsServer()
    default:
      throw new Error(`Unknown in-memory server: ${serverName}`)
  }
}
