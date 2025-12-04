import { GoogleGenerativeAI } from '@google/generative-ai';
import { AGENT_TYPES, AGENT_DEFINITIONS, suggestAgents } from './agentConfig.js';

export class MultiAgentOrchestrator {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.agents = new Map();
    this.activeWorkflows = new Map();

    // Initialize all specialist agents
    Object.entries(AGENT_DEFINITIONS).forEach(([type, config]) => {
      this.agents.set(type, {
        type,
        config,
        model: this.genAI.getGenerativeModel({
          model: process.env.LLM_MODEL || 'gemini-3-pro-preview',
          systemInstruction: config.systemPrompt,
        }),
      });
    });
  }

  /**
   * Main entry point: Process user request with multi-agent collaboration
   */
  async processRequest(userRequest, context = {}) {
    const workflowId = `workflow-${Date.now()}`;

    const workflow = {
      id: workflowId,
      userRequest,
      context,
      plan: null,
      agents: [],
      results: [],
      status: 'planning',
      startedAt: new Date(),
    };

    this.activeWorkflows.set(workflowId, workflow);

    try {
      // Step 1: Orchestrator creates execution plan
      workflow.plan = await this.createExecutionPlan(userRequest, context);
      workflow.status = 'executing';

      // Step 2: Execute agents in sequence or parallel based on plan
      const results = await this.executeAgents(workflow.plan);
      workflow.results = results;
      workflow.status = 'aggregating';

      // Step 3: Aggregate results
      const finalResult = await this.aggregateResults(results, userRequest);
      workflow.status = 'completed';
      workflow.finalResult = finalResult;

      return {
        workflowId,
        success: true,
        result: finalResult,
        plan: workflow.plan,
        agentsUsed: workflow.plan.agents.map(a => a.agent),
        executionTime: Date.now() - workflow.startedAt.getTime(),
      };

    } catch (error) {
      workflow.status = 'failed';
      workflow.error = error.message;
      throw error;
    }
  }

  /**
   * Step 1: Orchestrator analyzes task and creates execution plan
   */
  async createExecutionPlan(userRequest, context) {
    const orchestrator = this.agents.get(AGENT_TYPES.ORCHESTRATOR);

    // Auto-suggest agents based on keywords
    const suggestedAgents = suggestAgents(userRequest);

    const planningPrompt = `
Analyze this development task and create an execution plan:

USER REQUEST: "${userRequest}"

CONTEXT:
${JSON.stringify(context, null, 2)}

SUGGESTED AGENTS: ${suggestedAgents.join(', ')}

AVAILABLE AGENTS (use these exact type names):
${Object.entries(AGENT_DEFINITIONS).map(([type, def]) => `- "${type}": ${def.name} - ${def.role}`).join('\n')}

IMPORTANT: In your plan, use the exact agent type names in quotes above (e.g., "database", "frontend", "backend").

Return ONLY valid JSON in this exact format:
{
  "analysis": "brief task analysis",
  "complexity": "simple|moderate|complex",
  "agents": [
    {
      "agent": "agent_type",
      "task": "specific task for this agent",
      "dependencies": [],
      "priority": 1
    }
  ],
  "execution": "sequential|parallel"
}
`;

    const result = await orchestrator.model.generateContent(planningPrompt);
    const responseText = result.response.text();

    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Orchestrator failed to create valid plan');
    }

    const plan = JSON.parse(jsonMatch[0]);

    // Validate and normalize agent types
    if (plan.agents) {
      plan.agents = plan.agents.map(agentTask => {
        // Normalize agent type to lowercase
        let agentType = agentTask.agent.toLowerCase();

        // If agent type is not valid, try to find a match
        if (!AGENT_DEFINITIONS[agentType]) {
          // Try to find by name
          const matchedType = Object.entries(AGENT_DEFINITIONS).find(
            ([type, def]) => def.name.toLowerCase().includes(agentType) || agentType.includes(type)
          );

          if (matchedType) {
            agentType = matchedType[0];
          } else {
            console.warn(`Invalid agent type: ${agentTask.agent}, defaulting to orchestrator`);
            agentType = 'orchestrator';
          }
        }

        return {
          ...agentTask,
          agent: agentType,
        };
      });
    }

    return plan;
  }

  /**
   * Step 2: Execute agents based on plan
   */
  async executeAgents(plan) {
    const results = [];

    if (plan.execution === 'sequential') {
      // Execute agents one by one
      for (const agentTask of plan.agents) {
        const result = await this.executeAgent(agentTask, results);
        results.push(result);
      }
    } else {
      // Execute agents in parallel (respecting dependencies)
      const executed = new Set();
      const pending = [...plan.agents];

      while (pending.length > 0) {
        // Find agents with satisfied dependencies
        const ready = pending.filter(task =>
          !task.dependencies ||
          task.dependencies.every(dep => executed.has(dep))
        );

        if (ready.length === 0) {
          throw new Error('Circular dependency detected in agent plan');
        }

        // Execute ready agents in parallel
        const promises = ready.map(task => this.executeAgent(task, results));
        const batchResults = await Promise.all(promises);

        batchResults.forEach((result, index) => {
          results.push(result);
          executed.add(ready[index].agent);
          pending.splice(pending.indexOf(ready[index]), 1);
        });
      }
    }

    return results;
  }

  /**
   * Execute a single agent task
   */
  async executeAgent(agentTask, previousResults) {
    const agent = this.agents.get(agentTask.agent);
    if (!agent) {
      throw new Error(`Agent not found: ${agentTask.agent}`);
    }

    const contextFromPrevious = previousResults
      .map(r => `${r.agent}: ${r.output}`)
      .join('\n\n');

    const prompt = `
YOUR TASK: ${agentTask.task}

PREVIOUS AGENT OUTPUTS:
${contextFromPrevious || 'None'}

Execute your task and provide detailed output.
Include any code, configurations, or artifacts you create.
`;

    const startTime = Date.now();
    const result = await agent.model.generateContent(prompt);

    return {
      agent: agentTask.agent,
      agentName: agent.config.name,
      task: agentTask.task,
      output: result.response.text(),
      executionTime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Step 3: Aggregate all agent results into final output
   */
  async aggregateResults(results, userRequest) {
    const orchestrator = this.agents.get(AGENT_TYPES.ORCHESTRATOR);

    const aggregationPrompt = `
Original user request: "${userRequest}"

Agent results:
${results.map(r => `
### ${r.agentName}
Task: ${r.task}
Output:
${r.output}
`).join('\n---\n')}

Synthesize these results into a cohesive final response.
Include:
1. Summary of what was accomplished
2. Key outputs from each agent
3. Next steps or recommendations
4. Any issues or warnings
`;

    const result = await orchestrator.model.generateContent(aggregationPrompt);

    return {
      summary: result.response.text(),
      agentOutputs: results,
      totalAgents: results.length,
      totalTime: results.reduce((sum, r) => sum + r.executionTime, 0),
    };
  }

  /**
   * Get workflow status
   */
  getWorkflowStatus(workflowId) {
    return this.activeWorkflows.get(workflowId);
  }

  /**
   * List all active workflows
   */
  listActiveWorkflows() {
    return Array.from(this.activeWorkflows.values());
  }
}