import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { CliLauncherStatus } from '@shared/contracts/routes'

const installedStatus = {
  state: 'installed',
  reason: null,
  owned: true,
  commandPath: '/home/user/.local/bin/deepchat',
  shellConfigPath: '/home/user/.zprofile'
} satisfies CliLauncherStatus

const switchStub = defineComponent({
  name: 'Switch',
  inheritAttrs: false,
  props: {
    modelValue: Boolean,
    disabled: Boolean
  },
  emits: ['update:model-value'],
  template:
    '<button v-bind="$attrs" :disabled="disabled" :data-model-value="String(modelValue)" @click="$emit(\'update:model-value\', !modelValue)" />'
})

const buttonStub = defineComponent({
  name: 'Button',
  inheritAttrs: false,
  props: { disabled: Boolean },
  template: '<button v-bind="$attrs" :disabled="disabled"><slot /></button>'
})

async function setup(initialStatus: CliLauncherStatus | Error) {
  vi.resetModules()
  const cliClient = {
    getLauncherStatus:
      initialStatus instanceof Error
        ? vi.fn().mockRejectedValue(initialStatus)
        : vi.fn().mockResolvedValue(initialStatus),
    setLauncherInstalled: vi.fn()
  }
  vi.doMock('@api/CliClient', () => ({ createCliClient: () => cliClient }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({ t: (key: string) => key })
  }))

  const CliLauncherSettingsSection = (
    await import('../../../src/renderer/settings/components/common/CliLauncherSettingsSection.vue')
  ).default
  const wrapper = mount(CliLauncherSettingsSection, {
    global: {
      stubs: {
        Icon: true,
        Button: buttonStub,
        Switch: switchStub
      }
    }
  })
  await flushPromises()
  return { wrapper, cliClient }
}

describe('CliLauncherSettingsSection', () => {
  it('shows an installed owned launcher and its command path', async () => {
    const { wrapper } = await setup(installedStatus)

    expect(wrapper.get('[data-testid="cli-launcher-status"]').text()).toBe('common.enabled')
    expect(wrapper.get('[data-testid="cli-launcher-switch"]').attributes('data-model-value')).toBe(
      'true'
    )
    expect(wrapper.text()).toContain(installedStatus.commandPath)
  })

  it('installs an unowned launcher from the disabled state', async () => {
    const notInstalled: CliLauncherStatus = {
      state: 'not-installed',
      reason: null,
      owned: false,
      commandPath: '/home/user/.local/bin/deepchat',
      shellConfigPath: null
    }
    const { wrapper, cliClient } = await setup(notInstalled)
    cliClient.setLauncherInstalled.mockResolvedValue(installedStatus)

    await wrapper.get('[data-testid="cli-launcher-switch"]').trigger('click')
    await flushPromises()

    expect(cliClient.setLauncherInstalled).toHaveBeenCalledWith(true)
    expect(wrapper.get('[data-testid="cli-launcher-switch"]').attributes('data-model-value')).toBe(
      'true'
    )
  })

  it('allows removing an owned launcher when its bundled source is unavailable', async () => {
    const unavailable: CliLauncherStatus = {
      ...installedStatus,
      state: 'unavailable',
      reason: 'source-missing'
    }
    const removed: CliLauncherStatus = {
      ...unavailable,
      owned: false
    }
    const { wrapper, cliClient } = await setup(unavailable)
    cliClient.setLauncherInstalled.mockResolvedValue(removed)

    await wrapper.get('[data-testid="cli-launcher-switch"]').trigger('click')
    await flushPromises()

    expect(cliClient.setLauncherInstalled).toHaveBeenCalledWith(false)
    expect(wrapper.get('[data-testid="cli-launcher-status"]').text()).toBe('common.disabled')
  })

  it('repairs owned stale launchers but disables conflicting integration', async () => {
    const stale: CliLauncherStatus = {
      ...installedStatus,
      state: 'stale',
      reason: 'upgrade-required'
    }
    const staleSetup = await setup(stale)
    staleSetup.cliClient.setLauncherInstalled.mockResolvedValue(installedStatus)

    await staleSetup.wrapper.get('[data-testid="cli-launcher-repair"]').trigger('click')
    await flushPromises()
    expect(staleSetup.cliClient.setLauncherInstalled).toHaveBeenCalledWith(true)

    const conflictSetup = await setup({
      ...installedStatus,
      state: 'conflict',
      reason: 'unowned-command',
      owned: false
    })
    expect(
      conflictSetup.wrapper.get('[data-testid="cli-launcher-switch"]').attributes('disabled')
    ).toBeDefined()
    expect(conflictSetup.wrapper.get('[data-testid="cli-launcher-status"]').text()).toBe(
      'common.error.operationFailed'
    )
  })

  it('reports initial failures and reconciles an ambiguous mutation response', async () => {
    const initialFailure = await setup(new Error('unavailable'))
    expect(initialFailure.wrapper.get('[role="alert"]').text()).toBe(
      'common.notifications.actionFailed'
    )
    expect(initialFailure.wrapper.get('[data-testid="cli-launcher-status"]').text()).toBe(
      'common.error.operationFailed'
    )

    const mutationFailure = await setup(installedStatus)
    const removed: CliLauncherStatus = {
      state: 'not-installed',
      reason: null,
      owned: false,
      commandPath: installedStatus.commandPath,
      shellConfigPath: null
    }
    mutationFailure.cliClient.setLauncherInstalled.mockRejectedValue(new Error('denied'))
    mutationFailure.cliClient.getLauncherStatus.mockResolvedValueOnce(removed)
    await mutationFailure.wrapper.get('[data-testid="cli-launcher-switch"]').trigger('click')
    await flushPromises()
    expect(mutationFailure.cliClient.getLauncherStatus).toHaveBeenCalledTimes(2)
    expect(mutationFailure.wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(
      mutationFailure.wrapper
        .get('[data-testid="cli-launcher-switch"]')
        .attributes('data-model-value')
    ).toBe('false')
  })

  it('keeps an error visible when mutation reconciliation does not reach the target', async () => {
    const { wrapper, cliClient } = await setup(installedStatus)
    cliClient.setLauncherInstalled.mockRejectedValue(new Error('denied'))

    await wrapper.get('[data-testid="cli-launcher-switch"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('common.notifications.actionFailed')
    expect(wrapper.get('[data-testid="cli-launcher-switch"]').attributes('data-model-value')).toBe(
      'true'
    )
  })
})
