<template>
  <div class="w-full h-full">
    <div class="w-full h-full flex flex-col gap-2">
      <div class="w-full h-full flex flex-col items-center justify-center gap-2">
        <img src="@/assets/logo.png" class="w-10 h-10" />
        <div class="flex flex-col gap-2 items-center">
          <h1 class="text-2xl font-bold">{{ t('about.title') }}</h1>
          <p class="text-sm text-muted-foreground">
            {{ t('about.description') }}
          </p>
          <a
            class="text-xs text-muted-foreground hover:text-primary"
            href="https://deepchat.thinkinai.xyz/"
            >{{ t('about.website') }}</a
          >
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>
