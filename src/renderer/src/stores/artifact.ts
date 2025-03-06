import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface ArtifactState {
  type: string
  title: string
  content: string
}

export const useArtifactStore = defineStore('artifact', () => {
  const currentArtifact = ref<ArtifactState | null>(null)
  const isOpen = ref(false)

  const showArtifact = (artifact: ArtifactState) => {
    currentArtifact.value = artifact
    isOpen.value = true
  }

  const hideArtifact = () => {
    currentArtifact.value = null
    isOpen.value = false
  }

  return {
    currentArtifact,
    isOpen,
    showArtifact,
    hideArtifact
  }
}) 