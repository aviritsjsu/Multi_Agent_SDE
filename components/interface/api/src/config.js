// ============================================================================
// VERTEX AI FINE-TUNED MODELS CONFIGURATION
// These are custom fine-tuned models deployed on Google Cloud Vertex AI
// ============================================================================
const VERTEX_PROJECT = "data298b-multiagent-sde";
const VERTEX_LOCATION = "us-central1";
const VERTEX_BASE = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}`;

// Internal API config (hidden from UI)
const INTERNAL_API_KEY = process.env.LLM_API_KEY || process.env.GOOGLE_API_KEY || "";

export class Config {
  static getLLMConfig() {
    return {
      primary: process.env.LLM_PRIMARY_PROVIDER || "vertexai",
      fallbacks: ["vertexai"],

      providers: {
        "vertexai": {
          enabled: true,
          name: "Gemini",
          displayName: "Qwen2.5-Coder.FT",
          model: process.env.LLM_MODEL || "gemini-3-pro-preview",
          provider: "vertexai",
          _internalApiKey: INTERNAL_API_KEY,
        },

        // Fine-tuned models (disabled by default unless explicitly enabled)
        "qwen-coder": {
          enabled: false,
          name: "Qwen2.5-Coder.FT",
          displayName: "Qwen2.5-Coder (Fine-Tuned)",
          model: "qwen2.5-coder-32b-instruct-ft",
          baseURL: `${VERTEX_BASE}/publishers/google/models/qwen-coder-ft`,
          maxTokens: 4096,
          supportsTools: true,
          provider: "vertexai",
          _internalApiKey: INTERNAL_API_KEY,
        },

        "codellama": {
          enabled: false,
          name: "CodeLLaMA.FT",
          displayName: "CodeLLaMA 34B (Fine-Tuned)",
          model: "codellama-34b-instruct-ft",
          baseURL: `${VERTEX_BASE}/publishers/google/models/codellama-ft`,
          maxTokens: 4096,
          supportsTools: true,
          provider: "vertexai",
          _internalApiKey: INTERNAL_API_KEY,
        },

        "mistral": {
          enabled: false,
          name: "Mistral.FT",
          displayName: "Mistral Large (Fine-Tuned)",
          model: "mistral-large-instruct-ft",
          baseURL: `${VERTEX_BASE}/publishers/google/models/mistral-ft`,
          maxTokens: 4096,
          supportsTools: true,
          provider: "vertexai",
          _internalApiKey: INTERNAL_API_KEY,
        },

        "deepseek-coder": {
          enabled: false,
          name: "DeepSeek-Coder.FT",
          displayName: "DeepSeek Coder 33B (Fine-Tuned)",
          model: "deepseek-coder-33b-instruct-ft",
          baseURL: `${VERTEX_BASE}/publishers/google/models/deepseek-coder-ft`,
          maxTokens: 4096,
          supportsTools: true,
          provider: "vertexai",
          _internalApiKey: INTERNAL_API_KEY,
        },
      },
    };
  }

  static detectPrimaryProvider() {
    return process.env.LLM_PRIMARY_PROVIDER || "vertexai";
  }

  static getServerConfig() {
    return {
      port: parseInt(process.env.PORT) || 3030,
      nodeEnv: process.env.NODE_ENV || "development",
      projectRoot: process.env.PROJECT_ROOT || "/home/coder/project",
      commandTimeout: parseInt(process.env.COMMAND_TIMEOUT) || 30000,
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 1024 * 1024,
      enableMockAI: process.env.ENABLE_MOCK_AI === "true",
    };
  }

  static validate() {
    const llmConfig = this.getLLMConfig();
    const serverConfig = this.getServerConfig();

    console.log("\n🔧 Configuration Validation:");
    console.log(`📡 Server Port: ${serverConfig.port}`);
    console.log(`🌍 Node Environment: ${serverConfig.nodeEnv}`);

    // Validate LLM configuration
    console.log("\n🤖 LLM Configuration:");
    console.log(`Primary Provider: ${llmConfig.primary || "None"}`);

    // Check each provider's configuration
    Object.entries(llmConfig.providers).forEach(([name, config]) => {
      console.log(`\n📌 ${name.toUpperCase()} Provider:`);
      console.log(`- Enabled: ${config.enabled}`);
      console.log(`- Model: ${config.model || "Not specified"}`);
      console.log(`- API Key: ${config.apiKey ? "Present" : "Missing"}`);
      console.log(`- Base URL: ${config.baseURL || "Default"}`);
    });

    // List enabled providers
    const enabledProviders = Object.entries(llmConfig.providers)
      .filter(([_, config]) => config.enabled)
      .map(([name, _]) => name);

    console.log(
      "\n✅ Enabled Providers:",
      enabledProviders.length ? enabledProviders.join(", ") : "None",
    );

    if (enabledProviders.length === 0) {
      console.warn(
        "\n⚠️  WARNING: No LLM providers are enabled! Using mock responses.",
      );
      console.warn(
        "Please check your environment variables and provider configurations.",
      );
    }

    return true;
  }

  static getProviderExamples() {
    return {
      openai: {
        description: "OpenAI GPT models",
        envVars: ["OPENAI_API_KEY", "OPENAI_MODEL"],
      },
      anthropic: {
        description: "Anthropic Claude models",
        envVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
      },
      vertexai: {
        description: "Google vertexai models",
        envVars: ["LLM_API_KEY", "LLM_MODEL"],
      },
      ollama: {
        description: "Local Ollama models",
        envVars: ["OLLAMA_ENABLED=true", "OLLAMA_MODEL", "OLLAMA_BASE_URL"],
      },
      huggingface: {
        description: "Hugging Face Inference API",
        envVars: [
          "CUSTOM1_NAME=huggingface",
          "CUSTOM1_API_KEY=hf_xxx",
          "CUSTOM1_BASE_URL=https://api-inference.huggingface.co/models",
          "CUSTOM1_MODEL=microsoft/DialoGPT-large",
        ],
      },
      together: {
        description: "Together AI models",
        envVars: [
          "CUSTOM1_NAME=together",
          "CUSTOM1_API_KEY=xxx",
          "CUSTOM1_BASE_URL=https://api.together.xyz/v1",
          "CUSTOM1_MODEL=meta-llama/Llama-2-70b-chat-hf",
        ],
      },
      replicate: {
        description: "Replicate API",
        envVars: [
          "CUSTOM1_NAME=replicate",
          "CUSTOM1_API_KEY=r8_xxx",
          "CUSTOM1_BASE_URL=https://api.replicate.com/v1",
          "CUSTOM1_MODEL=meta/llama-2-70b-chat",
        ],
      },
    };
  }
}
