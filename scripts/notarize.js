import { notarize } from '@electron/notarize'

export default async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') {
    return
  }
  console.info('start notarize mac app', appOutDir)
  return await notarize({
    appPath: `${appOutDir}/DeepChat.app`,
    keychainProfile: 'DeepChat' // replace with your keychain
  })
}
