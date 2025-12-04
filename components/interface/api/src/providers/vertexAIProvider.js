import { BaseLLMProvider } from "./baseLLMProvider.js";
import { LLM } from '../constants.js';

export class VertexAIProvider extends BaseLLMProvider {
  constructor(config) {
    super({
      ...config,
      name: "vertexai",
      apiKey: config.apiKey || config._internalApiKey,
      baseURL: config.baseURL,
      model: config.model,
      maxTokens: config.maxTokens || 3000,
    });
    this.supportsTools = true;
    this.validateConfig();
  }

  async generateResponse(messages, tools = null, options = {}) {
    console.log("=================== Generating response with vertexai ====================");
    const toolCount = Array.isArray(tools) ? tools.length : 0;
    if (toolCount > 0) {
      console.log(`Including ${toolCount} tool(s)`);
    }
    try {
      // Fix: Use correct vertexai API endpoint format
      const endpoint = `${this.baseURL}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

      // Convert chat messages to vertexai format
      const contents = this.formatMessages(messages);

      const payload = {
        contents: contents,
        generationConfig: {
          temperature: options.temperature || LLM.DEFAULT_TEMPERATURE,
          maxOutputTokens: options.maxTokens || LLM.DEFAULT_MAX_TOKENS,
        },
      };

      // Add tools configuration if provided
      if (tools && tools.length > 0) {
        console.log(`=================== Including ${tools.length} tools in request ====================`);

        payload.tools = [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters,
            })),
          },
        ];

        // Add tool calling configuration
        payload.toolConfig = {
          functionCallingConfig: {
            mode: "AUTO", // Can be "AUTO", "ANY", or "NONE"
          },
        };
      }

      console.log("=================== Calling vertexai API ====================\n");
      console.log("=================== Endpoint: ====================\n", endpoint);
      console.log("=================== Payload: ====================\n", JSON.stringify(payload, null, 2));

      const response = await this.fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("=================== vertexai API error ====================\n", error);
        throw new Error(`vertexai API error: ${response.status} - ${error}`);
      }

      const data = await response.json();

      // Add better error handling for response parsing
      if (
        !data.candidates ||
        !data.candidates[0] ||
        !data.candidates[0].content
      ) {
        console.error("=================== Invalid vertexai response ====================\n", data);
        throw new Error("Invalid response from vertexai API");
      }

      // Parse the response to extract content and tool calls
      const parsedResponse = this.parseResponse(data);

      return {
        content: parsedResponse.content,
        toolCalls: parsedResponse.toolCalls,
        provider: "vertexai",
        model: this.model,
        usage: parsedResponse.usage,
      };
    } catch (error) {
      console.error("=================== vertexai provider error ====================\n", error);
      throw error;
    }
  }

  formatMessages(messages) {
    const contents = [];
    let systemMessage = "";

    // Handle system message by prepending it to the first user message
    messages.forEach((message) => {
      if (message.role === "system") {
        systemMessage = message.content;
      } else if (message.role === "user") {
        const content = systemMessage
          ? `${systemMessage}\n\n${message.content}`
          : message.content;
        contents.push({
          role: "user",
          parts: [{ text: content }],
        });
        systemMessage = ""; // Clear after using
      } else if (message.role === "assistant") {
        contents.push({
          role: "model",
          parts: [{ text: message.content }],
        });
      } else if (message.role === "function") {
        // Add support for function responses
        contents.push({
          role: "model",
          parts: [
            {
              functionResponse: {
                name: message.name,
                response: { result: message.content },
              },
            },
          ],
        });
      }
    });

    return contents;
  }

  parseResponse(data) {
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new Error("No response from vertexai");
    }

    const content = candidate.content?.parts?.[0]?.text || "";
    const functionCalls = [];

    // Extract function calls from all parts
    candidate.content?.parts?.forEach((part) => {
      if (part.functionCall) {
        functionCalls.push({
          id: `call-${functionCalls.length + 1}`,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        });
      }
    });

    return {
      content: content,
      toolCalls: functionCalls,
      usage: data.usageMetadata || {},
    };
  }

  validateConfig() {
    super.validateConfig();
    if (!this.apiKey) {
      throw new Error("Google vertexai API key is required");
    }
    console.log("=================== Initializing vertexai provider with model: ====================\n", this.model);
  }
}
