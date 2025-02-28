import { session } from 'electron'
import { ProxyAgent, setGlobalDispatcher } from 'undici'

// 先简单处理，用系统代理
export class ProxyConfig {
  private proxyUrl: string | null = null
  async resolveProxy(): Promise<void> {
    try {
      const proxyString = await session.defaultSession.resolveProxy('https://www.google.com')
      const [protocol, address] = proxyString.split(';')[0].split(' ')
      console.log('proxy url', protocol, address)
      this.proxyUrl = protocol === 'PROXY' ? `http://${address}` : null
      session.defaultSession.setProxy({
        mode: 'system'
      })
      if (this.proxyUrl) {
        process.env.http_proxy = this.proxyUrl
        process.env.https_proxy = this.proxyUrl
        process.env.HTTP_PROXY = this.proxyUrl
        process.env.HTTPS_PROXY = this.proxyUrl
        setGlobalDispatcher(new ProxyAgent(this.proxyUrl || ''))
      }
    } catch (error) {
      console.error('Failed to resolve proxy:', error)
      return
    }
  }
  getProxyUrl(): string | null {
    return this.proxyUrl
  }
}
export const proxyConfig = new ProxyConfig()
