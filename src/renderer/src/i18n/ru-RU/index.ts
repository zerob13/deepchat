import common from './common'
import update from './update'
import routes from './routes'
import chat from './chat'
import model from './model'
import thread from './thread'
import dialog from './dialog'
import settings from './settings'
import mcp from './mcp'
import welcome from './welcome'
import artifacts from './artifacts'
import sync from './sync'
import toolCall from './toolCall'
import components from './components'
import newThread from './newThread'
import about from './about'

// 单独的顶层键
const others = {
  Silicon: 'Силиконовый Поток',
  QwenLM: 'Модель Qwen',
  Doubao: 'Doubao',
  PPIO: 'PPIO Cloud',
  Moonshot: 'Moonshot'
}

export default {
  common,
  update,
  routes,
  chat,
  model,
  thread,
  dialog,
  settings,
  mcp,
  welcome,
  artifacts,
  sync,
  toolCall,
  components,
  newThread,
  about,
  ...others
}
