import { LLMManager } from "./llmManager.js";
import { Config } from "./config.js";

export class AIService {
  constructor() {
    this.llmManager = new LLMManager();
    this.config = Config.getLLMConfig();
    this.initialized = false;
  }

  async initialize() {
    if (!this.initialized) {
      await this.llmManager.initialize(this.config);
      this.initialized = true;
      console.log("=================== AIService initialized with config: ====================", {
        primary: this.config.primary,
        providers: Object.keys(this.config.providers),
      });
    }
  }

  async generateResponse(messages, tools = null, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      return await this.llmManager.generateResponse(messages, tools, options);
    } catch (error) {
      console.error("=================== AIService error: ====================", error);
      throw error;
    }
  }

  async switchProvider(providerName) {
    return (this.llmManager.currentProvider = providerName);
  }

  getProviderInfo() {
    // Return hardcoded provider config (hide internal keys)
    const providers = {};

    for (const [name, config] of Object.entries(this.config.providers)) {
      if (config.enabled) {
        providers[name] = {
          name: config.name || name,
          displayName: config.displayName || config.name || name,
          baseURL: config.baseURL,
          supportsTools: config.supportsTools || false,
          maxTokens: config.maxTokens,
          provider: config.provider || "vertexai",
          // Never expose internal API keys
        };
      }
    }

    return {
      providers,
      current: this.llmManager.currentProvider || this.config.primary,
    };
  }
}
