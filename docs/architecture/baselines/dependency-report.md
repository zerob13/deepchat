# Dependency Baseline

Generated on 2026-07-26.

## main

- Total files: 684
- Internal dependency edges: 2183
- Cycles detected: 9

### Top outgoing dependencies

- `app/composition.ts`: 144
- `agent/deepchat/runtime/deepChatLoopRunner.ts`: 42
- `agent/deepchat/runtime/turnCoordinator.ts`: 41
- `data/schemaCatalog.ts`: 41
- `agent/deepchat/harness/createDeepChatAgentHarness.ts`: 33
- `tool/agentTools/agentToolManager.ts`: 27
- `agent/deepchat/harness/runtimeServices.ts`: 26
- `session/data/database.ts`: 23
- `agent/deepchat/runtime/compactionRuntimeCoordinator.ts`: 21
- `agent/deepchat/runtime/interactionCoordinator.ts`: 20
- `memory/index.ts`: 20
- `app/mainProcess.ts`: 18
- `mcp/inMemoryServers/builder.ts`: 18
- `agent/acp/compatibility/dependencies.ts`: 17
- `provider/index.ts`: 16

### Top incoming dependencies

- `agent/shared/agentSessionIds.ts`: 45
- `provider/settings.ts`: 45
- `data/baseTable.ts`: 40
- `remote/types.ts`: 39
- `config/settingsStore.ts`: 35
- `agent/settings.ts`: 33
- `agent/deepchat/runtime/types.ts`: 26
- `memory/types.ts`: 24
- `routes/routeRegistry.ts`: 23
- `agent/deepchat/instance/deepChatAgentRuntime.ts`: 22
- `remote/binding/store.ts`: 22
- `session/data/transcript.ts`: 21
- `tape/domain/entry.ts`: 21
- `memory/ports.ts`: 20
- `session/data/database.ts`: 18

### Cycle samples

- `memory/injection.ts -> memory/core/injectionPort.ts -> memory/types.ts -> memory/injection.ts`
- `agent/acp/runtime/index.ts -> agent/acp/runtime/acpCompatibilityPromptBuilder.ts -> agent/acp/instance/ports.ts -> agent/acp/runtime/index.ts`
- `agent/acp/client/acpRuntimeOwner.ts -> agent/acp/client/index.ts -> agent/acp/client/acpRuntimeOwner.ts`
- `desktop/browser/YoBrowserPresenter.ts -> desktop/browser/YoBrowserToolHandler.ts -> desktop/browser/YoBrowserPresenter.ts`
- `tool/agentTools/agentToolManager.ts -> tool/agentTools/subagentOrchestratorTool.ts -> tool/agentTools/agentToolManager.ts`
- `tool/agentTools/agentToolManager.ts -> tool/agentTools/agentTapeTools.ts -> tool/agentTools/agentToolManager.ts`
- `tool/agentTools/agentToolManager.ts -> tool/agentTools/agentMemoryTools.ts -> tool/agentTools/agentToolManager.ts`
- `tool/agentTools/agentToolManager.ts -> tool/agentTools/cronJobTool.ts -> tool/agentTools/agentToolManager.ts`
- `skill/sync/toolScanner.ts -> skill/sync/security.ts -> skill/sync/toolScanner.ts`

## renderer-main

- Total files: 308
- Internal dependency edges: 559
- Cycles detected: 2

### Top outgoing dependencies

- `features/chat-page/ChatPage.vue`: 43
- `apps/chat-main/ChatMainApp.vue`: 29
- `i18n/index.ts`: 21
- `components/message/MessageItemAssistant.vue`: 19
- `pages/NewThreadPage.vue`: 19
- `components/chat/ChatStatusBar.vue`: 17
- `apps/chat-main/ChatTabView.vue`: 14
- `components/WindowSideBar.vue`: 9
- `components/chat/ChatInputBox.vue`: 9
- `stores/ui/session.ts`: 9
- `components/ChatConfig.vue`: 8
- `components/sidepanel/WorkspacePanel.vue`: 8
- `components/sidepanel/viewer/WorkspacePreviewPane.vue`: 8
- `features/chat-page/composables/useComposerSubmit.ts`: 8
- `components/markdown/MarkdownRenderer.vue`: 7

### Top incoming dependencies

- `features/chat-page/model/displayMessage.ts`: 26
- `stores/ui/session.ts`: 22
- `stores/ui/agent.ts`: 15
- `stores/theme.ts`: 14
- `stores/artifact.ts`: 13
- `stores/providerStore.ts`: 13
- `components/use-toast.ts`: 12
- `stores/modelStore.ts`: 12
- `stores/uiSettingsStore.ts`: 12
- `stores/ui/sidepanel.ts`: 11
- `stores/ui/message.ts`: 9
- `stores/mcp.ts`: 8
- `components/icons/ModelIcon.vue`: 6
- `lib/onboardingResume.ts`: 6
- `stores/language.ts`: 6

### Cycle samples

- `components/json-viewer/JsonValue.ts -> components/json-viewer/JsonObject.ts -> components/json-viewer/JsonValue.ts`
- `components/json-viewer/JsonArray.ts -> components/json-viewer/JsonValue.ts -> components/json-viewer/JsonArray.ts`

## renderer-settings

- Total files: 103
- Internal dependency edges: 117
- Cycles detected: 0

### Top outgoing dependencies

- `settingsRouteComponents.ts`: 20
- `components/ModelProviderSettingsDetail.vue`: 10
- `components/skills/SkillsSettings.vue`: 9
- `components/KnowledgeBaseSettings.vue`: 7
- `components/MemorySettings.vue`: 6
- `components/CommonSettings.vue`: 5
- `components/ModelProviderSettings.vue`: 5
- `components/BedrockProviderSettingsDetail.vue`: 4
- `components/DataSettings.vue`: 4
- `components/SettingsOverview.vue`: 4
- `App.vue`: 3
- `components/MemoryListView.vue`: 3
- `components/PromptSetting.vue`: 3
- `components/ProviderApiConfig.vue`: 3
- `components/skills/SkillAgentsTab.vue`: 3

### Top incoming dependencies

- `components/control-center/SettingsPageShell.vue`: 14
- `components/memoryRedesignUtils.ts`: 5
- `lib/guidedOnboardingSettings.ts`: 3
- `components/ProviderDialogContainer.vue`: 2
- `components/ProviderModelManager.vue`: 2
- `components/ProviderRateLimitConfig.vue`: 2
- `components/ProviderSettingsShell.vue`: 2
- `components/common/SettingToggleRow.vue`: 2
- `components/control-center/SettingsSectionCard.vue`: 2
- `components/skills/SkillDetailDialog.vue`: 2
- `components/skills/toolIcon.ts`: 2
- `settingsRouteComponents.ts`: 2
- `App.vue`: 1
- `components/AboutUsSettings.vue`: 1
- `components/AcpDebugDialog.vue`: 1

### Cycle samples

- None
