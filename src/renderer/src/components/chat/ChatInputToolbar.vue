<template>
  <div class="flex items-center justify-between px-3 py-2">
    <div class="flex items-center gap-1">
      <!-- Attach button -->
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
            :disabled="isGenerating"
            @click="$emit('attach')"
          >
            <Icon icon="lucide:plus" class="w-4 h-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Attach</p>
        </TooltipContent>
      </Tooltip>
    </div>

    <div class="flex items-center gap-1">
      <!-- Stop button (shown when generating) -->
      <template v-if="isGenerating">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="destructive"
              size="sm"
              class="h-7 px-3 gap-1.5 rounded-lg"
              @click="$emit('stop')"
            >
              <Icon icon="lucide:square" class="w-3.5 h-3.5 fill-current" />
              <span class="text-xs">Stop</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Stop generating</p>
          </TooltipContent>
        </Tooltip>
      </template>

      <!-- Mic button (hidden when generating) -->
      <template v-else>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              class="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
            >
              <Icon icon="lucide:mic" class="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Voice input</p>
          </TooltipContent>
        </Tooltip>

        <!-- Send button -->
        <Button size="icon" class="h-7 w-7 rounded-full" @click="$emit('send')">
          <Icon icon="lucide:arrow-up" class="w-4 h-4" />
        </Button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@shadcn/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@shadcn/components/ui/tooltip'
import { Icon } from '@iconify/vue'

defineProps<{
  isGenerating?: boolean
}>()

defineEmits<{
  send: []
  attach: []
  stop: []
}>()
</script>
