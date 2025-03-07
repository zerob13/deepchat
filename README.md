
<p align='center'>
<img src='./build/icon.png' width="150" height="150" alt="logo" />
</p>

<h1 align="center">DeepChat</h1>

<p align="center">Dolphins are good friends of whales, and DeepChat is your good assistant</p>

<div align="center">
  <a href="./README.zh.md">中文</a> / English
</div>

### Reasoning
<p align='center'>
<img src='./build/screen.jpg'/>
</p>

### Search
<p align='center'>
<img src='./build/screen.search.jpg'/>
</p>

### Latex
<p align='center'>
<img src='./build/screen.latex.jpg'/>
</p>

### Artifacts support
<p align='center'>
<img src='./build/screen.artifacts.jpg'/>
</p>

## Main Features

- 🌐 Supports multiple model cloud services: DeepSeek, OpenAI, Silicon Flow, etc.
- 🏠 Supports local model deployment: Ollama
- 🚀 Multi-channel chat concurrency support, switch to other conversations without waiting for the model to finish generating, efficiency Max
- 💻 Supports multiple platforms: Windows, macOS, Linux
- 📄 Complete Markdown rendering, excellent code module rendering
- 🌟 Easy to use, with a complete guide page, you can get started immediately without understanding complex concepts

## Currently Supported Model Providers

- [Ollama](https://ollama.com)
- [Deepseek](https://deepseek.com/)
- [Silicon](https://www.siliconflow.cn/)
- [QwenLM](https://chat.qwenlm.ai)
- [Doubao](https://console.volcengine.com/ark/)
- [MiniMax](https://platform.minimaxi.com/)
- [Fireworks](https://fireworks.ai/)
- [PPIO](https://ppinfra.com/)
- [OpenAI](https://openai.com/)
- [Gemini](https://gemini.google.com/)
- [GitHub Models](https://github.com/marketplace/models)
- [Moonshot](https://moonshot.ai/)
- [OpenRouter](https://openrouter.ai/)
- [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service)
- Customizable addition of any openai/gemini format API providers

## TODO List
- [X] Support for Ollama local model management
- [ ] Support for llama.cpp local model
- [ ] Support for local file processing
- [X] Mermaid chart visualization
- [ ] Search integration (local + cloud API)
- [ ] MCP support
- [ ] Multi-modal model support
- [ ] Local chat data synchronization and encryption

## Development

Please read the [Contribution Guidelines](./CONTRIBUTING.md)

### Install dependencies

```bash
$ npm install
# for windows x64
$ npm install --cpu=x64 --os=win32 sharp
# for mac apple silicon
$ npm install --cpu=arm64 --os=darwin sharp
# for mac intel
$ npm install --cpu=x64 --os=darwin sharp
# for linux x64
$ npm install --cpu=x64 --os=linux sharp
```

### Start development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux

# Specify architecture packaging
$ npm run build:win:x64
$ npm run build:win:arm64
$ npm run build:mac:x64
$ npm run build:mac:arm64
$ npm run build:linux:x64
$ npm run build:linux:arm64
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ThinkInAIXYZ/deepchat&type=Date)](https://star-history.com/#ThinkInAIXYZ/deepchat&Date)

# 📃 License
[LICENSE](./LICENSE)
