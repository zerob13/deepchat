<template>
  <div class="react-artifact">
    <div ref="containerRef"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { AssistantMessageBlock } from '@shared/chat'

const props = defineProps<{
  block: AssistantMessageBlock
}>()

const containerRef = ref<HTMLElement>()

const loadScript = (src: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`))
    document.head.appendChild(script)
  })
}

onMounted(async () => {
  if (containerRef.value && props.block.content) {
    try {
      // 加载 React 和 Babel
      await Promise.all([
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/react/17.0.2/umd/react.development.js'),
        loadScript(
          'https://cdnjs.cloudflare.com/ajax/libs/react-dom/17.0.2/umd/react-dom.development.js'
        ),
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.18.13/babel.min.js')
      ])

      // 等待一下确保全局变量都加载完成
      await new Promise((resolve) => setTimeout(resolve, 100))

      // 使用全局的 Babel 转换代码
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { code } = (window as any).Babel.transform(props.block.content, {
        presets: ['react'],
        filename: 'component.jsx'
      })

      // 创建一个新的 Function 来执行转换后的代码
      const Component = new Function('React', 'require', code)

      // 创建一个模拟的 require 函数
      const mockRequire = (module: string) => {
        switch (module) {
          case 'react':
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (window as any).React
          case 'react-dom':
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (window as any).ReactDOM
          default:
            throw new Error(`Module ${module} is not available`)
        }
      }

      // 执行代码并获取组件
      const ReactComponent = Component((window as any).React, mockRequire)

      // 渲染组件
      ;(window as any).ReactDOM.render(
        (window as any).React.createElement(ReactComponent),
        containerRef.value
      )
    } catch (error) {
      console.error('Failed to render React component:', error)
    }
  }
})
</script>

<style>
.react-artifact {
  width: 100%;
  min-height: 100px;
  padding: 1rem;
}
</style>
