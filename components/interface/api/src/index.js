import path from "path";
import fs from "fs";
import express from "express";
import { randomUUID } from 'crypto';
import yaml from 'yaml';
import { WorkshopStore } from "./workshopStore.js";
import { AgentService } from "./agentService.js";
import { ChatService } from "./chatService.js";
import { MultiAgentOrchestrator } from "./agents/orchestrator.js";
import { apiLimiter, adkLimiter, chatLimiter } from "./middleware/rateLimit.js";
import { ProjectAgent } from "./agents/projectAgent.js";
import { verifyToken } from "./middleware/auth.js";
import { PATHS, HTTP_STATUS, TIMEOUTS } from "./constants.js";
import { getDatabaseHealth, closeDatabase } from "./db.js";
import dotenv from 'dotenv'

dotenv.config()
const app = express()
const ARTIFACTS_DIR = path.resolve(process.cwd(), PATHS.ARTIFACTS_DIR);
const workshopStore = new WorkshopStore();
const agentService = new AgentService();
const chatService = new ChatService();
const projectAgent = new ProjectAgent();

// Initialize Multi-Agent Orchestrator
let multiAgentOrchestrator = null;
try {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.LLM_API_KEY;
  if (apiKey) {
    multiAgentOrchestrator = new MultiAgentOrchestrator(apiKey);
    console.log("🎭 Multi-Agent Orchestrator initialized");
  } else {
    console.log("⚠️  Multi-Agent mode disabled: No API key found");
  }
} catch (error) {
  console.error("Failed to initialize Multi-Agent Orchestrator:", error.message);
}

app.use(express.json({ limit: "10mb" }));

// -----------------------------
// 🩺 Health check (no rate limiting)
// -----------------------------
app.get("/api/health", async (req, res) => {
  try {
    const dbHealth = getDatabaseHealth();
    res.json({
      status: "healthy",
      mode: "ADK",
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit: "MB",
      },
      database: dbHealth,
      features: {
        semanticSearch: agentService.memory?.isSemanticSearchEnabled() || false,
        multiAgent: !!multiAgentOrchestrator,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(HTTP_STATUS.SERVER_ERROR).json({
      status: "unhealthy",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});



app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));
// Serve generated artifacts directory
app.use("/generated", express.static(ARTIFACTS_DIR));

// Apply general rate limiting to all API routes
app.use("/api", apiLimiter);

app.get("/api/providers", (req, res) => {
  try {
    const providerInfo = chatService.getProviderInfo();
    res.json({
      providers: providerInfo.providers || {},
      current: providerInfo.current || "mock",
    });
  } catch (error) {
    console.error("Error fetching providers:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/providers/switch", async (req, res) => {
  const { provider } = req.body;
  try {
    await chatService.switchProvider(provider);
    res.json({ success: true, provider });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.post("/api/project/generate", verifyToken, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    // Use user ID from token
    const userId = req.user.uid;

    const result = await projectAgent.generateProject(prompt, userId);
    res.json(result);
  } catch (error) {
    console.error("Project generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/chat", chatLimiter, async (req, res) => {
  try {
    const { message, history, mode, availableTools, options } = req.body;
    console.log(message, history, mode, availableTools, options);
    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Message is required and must be a string",
      });
    }

    let response;
    const startTime = Date.now();

    switch (mode) {
      case "agent":
        console.log(`=================== Agent request: ${message.substring(0, 50)}... ===================`);
        response = await agentService.processAgentRequest(
          message,
          history || [],
          availableTools || [],
          options || {},
        );
        break;

      case "ask":
        console.log(`=================== Ask request: ${message.substring(0, 50)}... ===================`);
        response = await agentService.runADKPipeline(message);
        break;

      case "chat":
      default:
        console.log(`=================== Chat request: ${message.substring(0, 50)}... ===================`);
        response = await chatService.processChatRequest(
          message,
          history || [],
          options || {},
        );
        break;
    }

    const processingTime = Date.now() - startTime;
    console.log(
      `=================== Response generated in ${processingTime}ms using ${response.provider || "unknown"} ===================`,
    );

    res.json({
      ...response,
      mode: mode,
      processingTime: processingTime,
    });
  } catch (error) {
    console.error("=================== Chat API error: ===================", error);
    res.status(500).json({
      error: "Failed to process chat request",
      message:
        "I apologize, but I encountered an error processing your request. Please try again.",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});





// -----------------------------
//  ADK pipeline endpoint (non-streaming)
// -----------------------------
app.post("/api/adk/run", adkLimiter, async (req, res) => {
  try {
    const { message, task, options } = req.body;
    const msg = message || task;
    if (!msg)
      return res.status(400).json({ error: "Message (or task) field is required" });

    const result = await agentService.runADKPipeline(msg, options || {});
    res.json(result);
  } catch (error) {
    console.error("=================== ADK run failed: ===================", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
//  Generated artifacts listing
// -----------------------------
app.get("/api/generate", async (req, res) => {
  try {
    const root = ARTIFACTS_DIR;
    fs.mkdirSync(root, { recursive: true });
    const entries = [];
    const walk = (dir, base = "") => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const rel = path.join(base, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, rel);
        else entries.push({ path: rel, size: st.size, mtime: st.mtimeMs });
      }
    };
    walk(root);
    res.json({ root: "/generated", files: entries.sort((a, b) => b.mtime - a.mtime) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Track active ADK processes for cancellation
const activeADKProcesses = new Map();

// -----------------------------
// ADK Cancel endpoint
// -----------------------------
app.post("/api/adk/cancel", async (req, res) => {
  try {
    // Cancel all active ADK processes
    for (const [id, proc] of activeADKProcesses) {
      try {
        proc.kill('SIGTERM');
        console.log(`🛑 Cancelled ADK process: ${id}`);
      } catch (e) {
        console.error(`Failed to kill process ${id}:`, e.message);
      }
    }
    activeADKProcesses.clear();
    res.json({ success: true, message: 'Pipeline cancellation requested' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// ADK streaming endpoint (SSE)
// -----------------------------
app.get("/api/adk/stream", adkLimiter, async (req, res) => {
  try {
    const task = req.query.task;
    if (!task) return res.status(400).end("Missing ?task=");

    // optional identity for logging
    const options = {
      userId: req.query.userId,
      sessionId: req.query.sessionId,
      projectId: req.query.projectId,
    };

    // Fetch session for refinement detection
    let session = null;
    if (options.sessionId && agentService.memory.store.getSession) {
      try {
        session = await agentService.memory.store.getSession(options.sessionId);
      } catch (err) {
        console.warn('Could not fetch session:', err.message);
      }
    }

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // Heartbeat
    const hb = setInterval(() => {
      res.write(`event: ping\n`);
      res.write(`data: {}\n\n`);
    }, TIMEOUTS.SSE_HEARTBEAT);

    const cleanup = await agentService.runADKPipelineStream(res, task, { ...options, session });

    req.on("close", () => {
      clearInterval(hb);
      try { cleanup?.(); } catch { }
    });
  } catch (error) {
    console.error("=================== ADK stream failed: ===================", error);
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
    } finally {
      res.end();
    }
  }
});

// -----------------------------
// Optional: Labspace info (still supported)
// -----------------------------
app.get("/api/labspace", (req, res) => {
  try {
    res.json(workshopStore.getWorkshopDetails());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 📁 Workspace Files Endpoint (for @ mention feature)
// -----------------------------
app.get("/api/workspace/files", async (req, res) => {
  try {
    const workspaceRoot = process.env.WORKSPACE_PATH || "/home/coder/project";
    const maxDepth = parseInt(req.query.maxDepth) || 3;
    const query = req.query.query?.toLowerCase() || "";

    const files = [];

    const walkDir = (dir, depth = 0, relativePath = "") => {
      if (depth > maxDepth) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip hidden files and common ignore patterns
          if (entry.name.startsWith('.') ||
            entry.name === 'node_modules' ||
            entry.name === '__pycache__' ||
            entry.name === 'dist' ||
            entry.name === 'build') {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          const relPath = path.join(relativePath, entry.name);

          if (entry.isDirectory()) {
            files.push({
              path: `/${relPath}`,
              type: 'directory',
              name: entry.name,
            });
            walkDir(fullPath, depth + 1, relPath);
          } else if (entry.isFile()) {
            files.push({
              path: `/${relPath}`,
              type: 'file',
              name: entry.name,
            });
          }
        }
      } catch (err) {
        console.error(`Error reading directory ${dir}:`, err.message);
      }
    };

    if (fs.existsSync(workspaceRoot)) {
      walkDir(workspaceRoot);
    }

    // Filter by query if provided
    let filteredFiles = files;
    if (query) {
      filteredFiles = files.filter(f =>
        f.path.toLowerCase().includes(query) ||
        f.name.toLowerCase().includes(query)
      );
    }

    // Limit results
    const limit = parseInt(req.query.limit) || 100;
    filteredFiles = filteredFiles.slice(0, limit);

    res.json({
      files: filteredFiles,
      total: filteredFiles.length,
      workspaceRoot,
    });
  } catch (error) {
    console.error("Workspace files error:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 📊 Memory Analytics Endpoint
// -----------------------------
app.get("/api/memory/stats", async (req, res) => {
  try {
    // If using Firestore (or if method exists), use the service method
    if (agentService.memory.store.getStats) {
      const stats = await agentService.memory.getStats();
      return res.json(stats);
    }

    // Fallback to SQLite raw queries (existing logic)
    const db = agentService.memory.store.db;

    // Get basic counts
    const totalMessages = db.prepare("SELECT COUNT(*) as count FROM messages").get().count;
    const totalSessions = db.prepare("SELECT COUNT(*) as count FROM sessions").get().count;
    const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
    const totalToolRuns = db.prepare("SELECT COUNT(*) as count FROM tool_runs").get().count;
    const totalMemories = db.prepare("SELECT COUNT(*) as count FROM memories").get().count;

    // Calculate success rate for tool runs
    const successfulRuns = db.prepare("SELECT COUNT(*) as count FROM tool_runs WHERE success = 1").get().count;
    const successRate = totalToolRuns > 0 ? ((successfulRuns / totalToolRuns) * 100).toFixed(2) : 0;

    // Get token usage stats (if available)
    const tokenStats = db.prepare(`
      SELECT 
        COUNT(*) as messages_with_tokens,
        SUM(CAST(json_extract(token_usage_json, '$.total_tokens') AS INTEGER)) as total_tokens
      FROM messages 
      WHERE token_usage_json IS NOT NULL
    `).get();

    // Recent activity
    const recentSessions = db.prepare(`
      SELECT COUNT(*) as count 
      FROM sessions 
      WHERE created_at > datetime('now', '-7 days')
    `).get().count;

    const recentMessages = db.prepare(`
      SELECT COUNT(*) as count 
      FROM messages 
      WHERE created_at > datetime('now', '-7 days')
    `).get().count;

    // Memory breakdown by scope
    const memoryByScope = db.prepare(`
      SELECT scope, COUNT(*) as count 
      FROM memories 
      GROUP BY scope
    `).all();

    res.json({
      summary: {
        totalMessages,
        totalSessions,
        totalUsers,
        totalToolRuns,
        totalMemories,
        successRate: `${successRate}%`,
      },
      tokens: {
        messagesWithTokens: tokenStats.messages_with_tokens || 0,
        totalTokens: tokenStats.total_tokens || 0,
        averagePerMessage: tokenStats.messages_with_tokens > 0
          ? Math.round(tokenStats.total_tokens / tokenStats.messages_with_tokens)
          : 0,
      },
      recentActivity: {
        sessionsLast7Days: recentSessions,
        messagesLast7Days: recentMessages,
      },
      memoryBreakdown: memoryByScope.reduce((acc, row) => {
        acc[row.scope] = row.count;
        return acc;
      }, {}),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Memory stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 📤 Session Export Endpoint
// -----------------------------
app.get("/api/memory/export/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit) || 1000;

    // Use service abstraction
    if (agentService.memory.store.getSessionDetails) {
      const sessionInfo = await agentService.memory.getSessionDetails(sessionId);
      if (!sessionInfo) return res.status(404).json({ error: "Session not found" });

      const messages = await agentService.memory.getSessionMessages(sessionId, limit);
      const toolRuns = await agentService.memory.getSessionToolRuns(sessionId);

      // Calculate total tokens
      const totalTokens = messages.reduce((sum, msg) => {
        if (msg.token_usage_json) {
          try {
            const usage = JSON.parse(msg.token_usage_json);
            return sum + (usage.total_tokens || 0);
          } catch { return sum; }
        }
        return sum;
      }, 0);

      return res.json({
        session: {
          id: sessionInfo.id,
          userId: sessionInfo.user_id,
          projectId: sessionInfo.project_id,
          createdAt: sessionInfo.created_at,
          summary: sessionInfo.summary_text,
          summaryUpdatedAt: sessionInfo.summary_updated_at,
        },
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          createdAt: msg.created_at,
          tokenUsage: msg.token_usage_json ? JSON.parse(msg.token_usage_json) : null,
        })),
        toolRuns: toolRuns.map(run => ({
          name: run.name,
          input: run.input_json ? JSON.parse(run.input_json) : null,
          output: run.output_json ? JSON.parse(run.output_json) : null,
          success: !!run.success,
          createdAt: run.created_at,
        })),
        stats: {
          messageCount: messages.length,
          toolRunCount: toolRuns.length,
          totalTokens,
          successfulToolRuns: toolRuns.filter(r => r.success).length,
        },
        exportedAt: new Date().toISOString(),
      });
    }

    // Fallback to SQLite raw queries
    const db = agentService.memory.store.db;

    // Get session info
    const sessionInfo = db.prepare(`
      SELECT s.*, u.id as user_id 
      FROM sessions s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.id = ?
    `).get(sessionId);

    if (!sessionInfo) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Get all messages
    const messages = db.prepare(`
      SELECT role, content, created_at, token_usage_json
      FROM messages 
      WHERE session_id = ? 
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, limit);

    // Get tool runs
    const toolRuns = db.prepare(`
      SELECT name, input_json, output_json, success, created_at
      FROM tool_runs
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId);

    // Calculate total tokens
    const totalTokens = messages.reduce((sum, msg) => {
      if (msg.token_usage_json) {
        try {
          const usage = JSON.parse(msg.token_usage_json);
          return sum + (usage.total_tokens || 0);
        } catch {
          return sum;
        }
      }
      return sum;
    }, 0);

    res.json({
      session: {
        id: sessionInfo.id,
        userId: sessionInfo.user_id,
        projectId: sessionInfo.project_id,
        createdAt: sessionInfo.created_at,
        summary: sessionInfo.summary_text,
        summaryUpdatedAt: sessionInfo.summary_updated_at,
      },
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        createdAt: msg.created_at,
        tokenUsage: msg.token_usage_json ? JSON.parse(msg.token_usage_json) : null,
      })),
      toolRuns: toolRuns.map(run => ({
        name: run.name,
        input: run.input_json ? JSON.parse(run.input_json) : null,
        output: run.output_json ? JSON.parse(run.output_json) : null,
        success: !!run.success,
        createdAt: run.created_at,
      })),
      stats: {
        messageCount: messages.length,
        toolRunCount: toolRuns.length,
        totalTokens,
        successfulToolRuns: toolRuns.filter(r => r.success).length,
      },
      exportedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Session export error:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 🔍 Session List Endpoint
// -----------------------------
app.get("/api/memory/sessions", async (req, res) => {
  try {
    const userId = req.query.userId;
    const limit = parseInt(req.query.limit) || 50;

    if (agentService.memory.store.listSessions) {
      const sessions = await agentService.memory.listSessions({ userId, limit });
      return res.json({
        sessions,
        count: sessions.length,
        timestamp: new Date().toISOString(),
      });
    }

    const db = agentService.memory.store.db;

    let query = `
      SELECT 
        s.id,
        s.user_id,
        s.project_id,
        s.created_at,
        s.summary_text,
        COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
    `;

    const params = [];
    if (userId) {
      query += " WHERE s.user_id = ?";
      params.push(userId);
    }

    query += ` GROUP BY s.id ORDER BY s.created_at DESC LIMIT ?`;
    params.push(limit);

    const sessions = db.prepare(query).all(...params);

    res.json({
      sessions: sessions.map(s => ({
        id: s.id,
        userId: s.user_id,
        projectId: s.project_id,
        createdAt: s.created_at,
        summary: s.summary_text,
        messageCount: s.message_count,
      })),
      count: sessions.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Sessions list error:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 📝 Create/Update Session Endpoint
// -----------------------------
app.post("/api/memory/sessions", async (req, res) => {
  try {
    const { sessionId, metadata, userId } = req.body;
    const id = sessionId || `session-${Date.now()}`;
    const user = userId || "anonymous";

    if (agentService.memory.store.updateSession) {
      await agentService.memory.store.updateSession(id, {
        id,
        userId: user,
        metadata: metadata || {},
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      });

      return res.json({ id, success: true });
    }

    // Fallback for SQLite
    res.status(501).json({ error: "Not implemented for current storage backend" });
  } catch (error) {
    console.error("Session create error:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 📝 Update Session Endpoint
// -----------------------------
app.put("/api/memory/sessions/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { metadata, userId } = req.body;

    if (agentService.memory.store.updateSession) {
      const updateData = {
        metadata: metadata || {},
        updatedAt: new Date().toISOString()
      };

      // CRITICAL: Include userId if provided (for migration)
      if (userId !== undefined) {
        updateData.userId = userId;
      }

      await agentService.memory.store.updateSession(sessionId, updateData);

      return res.json({ success: true });
    }

    // Fallback for SQLite
    res.status(501).json({ error: "Not implemented for current storage backend" });
  } catch (error) {
    console.error("Session update error:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 🗑️ Delete Session Endpoint
// -----------------------------
app.delete("/api/memory/sessions/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (agentService.memory.store.db && agentService.memory.store.db.collection) {
      // Firestore
      await agentService.memory.store.db.collection('sessions').doc(sessionId).delete();
      return res.json({ success: true });
    }

    // Fallback for SQLite
    res.status(501).json({ error: "Not implemented for current storage backend" });
  } catch (error) {
    console.error("Session delete error:", error);
    res.status(500).json({ error: error.message });
  }
});


// -----------------------------
// 🧠 Semantic Search Endpoint
// -----------------------------
app.get("/api/memory/semantic-search", async (req, res) => {
  try {
    const { scope, query, topK } = req.query;

    if (!scope || !query) {
      return res.status(400).json({
        error: "Both 'scope' and 'query' parameters are required"
      });
    }

    if (!agentService.memory.isSemanticSearchEnabled()) {
      return res.status(503).json({
        error: "Semantic search is not enabled. Please configure GOOGLE_API_KEY or LLM_API_KEY.",
        fallback: "Use keyword search instead"
      });
    }

    const results = await agentService.memory.semanticSearch({
      scope,
      query,
      topK: parseInt(topK) || 10,
    });

    res.json({
      results,
      count: results.length,
      semanticSearch: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Semantic search error:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 📥 Export Session to File (JSON/TXT)
// -----------------------------
app.get("/api/memory/export/:sessionId/file", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const format = req.query.format || 'json'; // json or txt
    const limit = parseInt(req.query.limit) || 1000;

    // Use service abstraction
    if (agentService.memory.store.getSessionDetails) {
      const sessionInfo = await agentService.memory.getSessionDetails(sessionId);
      if (!sessionInfo) return res.status(404).json({ error: "Session not found" });

      const messages = await agentService.memory.getSessionMessages(sessionId, limit);

      if (format === 'txt') {
        let content = `Session: ${sessionInfo.id}\n`;
        content += `User: ${sessionInfo.user_id || 'N/A'}\n`;
        content += `Created: ${sessionInfo.created_at}\n`;
        content += `Messages: ${messages.length}\n`;
        content += `\n${'='.repeat(80)}\n\n`;

        messages.forEach(msg => {
          content += `[${msg.created_at}] ${msg.role.toUpperCase()}:\n`;
          content += `${msg.content}\n\n`;
          content += `${'-'.repeat(80)}\n\n`;
        });

        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="session-${sessionId}.txt"`);
        res.send(content);
      } else {
        const data = {
          session: {
            id: sessionInfo.id,
            userId: sessionInfo.user_id,
            projectId: sessionInfo.project_id,
            createdAt: sessionInfo.created_at,
            summary: sessionInfo.summary_text,
          },
          messages: messages.map(msg => ({
            role: msg.role,
            content: msg.content,
            createdAt: msg.created_at,
          })),
          exportedAt: new Date().toISOString(),
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="session-${sessionId}.json"`);
        res.json(data);
      }
      return;
    }

    const db = agentService.memory.store.db;

    // Get session info
    const sessionInfo = db.prepare(`
      SELECT s.*, u.id as user_id 
      FROM sessions s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.id = ?
    `).get(sessionId);

    if (!sessionInfo) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Get all messages
    const messages = db.prepare(`
      SELECT role, content, created_at
      FROM messages 
      WHERE session_id = ? 
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, limit);

    if (format === 'txt') {
      // Plain text format
      let content = `Session: ${sessionInfo.id}\n`;
      content += `User: ${sessionInfo.user_id || 'N/A'}\n`;
      content += `Created: ${sessionInfo.created_at}\n`;
      content += `Messages: ${messages.length}\n`;
      content += `\n${'='.repeat(80)}\n\n`;

      messages.forEach(msg => {
        content += `[${msg.created_at}] ${msg.role.toUpperCase()}:\n`;
        content += `${msg.content}\n\n`;
        content += `${'-'.repeat(80)}\n\n`;
      });

      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="session-${sessionId}.txt"`);
      res.send(content);
    } else {
      // JSON format
      const data = {
        session: {
          id: sessionInfo.id,
          userId: sessionInfo.user_id,
          projectId: sessionInfo.project_id,
          createdAt: sessionInfo.created_at,
          summary: sessionInfo.summary_text,
        },
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          createdAt: msg.created_at,
        })),
        exportedAt: new Date().toISOString(),
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="session-${sessionId}.json"`);
      res.json(data);
    }
  } catch (error) {
    console.error("File export error:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 🔄 Batch Embedding Generation
// -----------------------------
app.post("/api/memory/embeddings/generate", async (req, res) => {
  try {
    const { scope, limit } = req.body;

    if (!agentService.memory.isSemanticSearchEnabled()) {
      return res.status(503).json({
        error: "Embeddings are not enabled. Please configure GOOGLE_API_KEY or LLM_API_KEY."
      });
    }

    const maxLimit = parseInt(limit) || 100;
    let memories = [];

    if (agentService.memory.store.getMemoriesWithoutEmbeddings) {
      memories = await agentService.memory.getMemoriesWithoutEmbeddings(scope, maxLimit);
    } else {
      const db = agentService.memory.store.db;
      // Get memories without embeddings
      let query = `
          SELECT m.id, m.text
          FROM memories m
          LEFT JOIN embeddings e ON m.id = e.memory_id
          WHERE e.id IS NULL
        `;

      const params = [];
      if (scope) {
        query += " AND m.scope = ?";
        params.push(scope);
      }

      query += " LIMIT ?";
      params.push(maxLimit);

      memories = db.prepare(query).all(...params);
    }

    if (memories.length === 0) {
      return res.json({
        message: "All memories already have embeddings",
        processed: 0,
        total: 0,
      });
    }

    // Generate embeddings in background
    const results = {
      total: memories.length,
      processed: 0,
      failed: 0,
      errors: [],
    };

    // Process embeddings (limit rate to avoid API throttling)
    for (const memory of memories) {
      try {
        const vector = await agentService.memory.store.embeddings.generateEmbedding(memory.text);
        if (vector) {
          if (agentService.memory.store.saveEmbedding) {
            await agentService.memory.store.saveEmbedding(memory.id, vector);
          } else {
            const db = agentService.memory.store.db;
            const stmt = db.prepare(
              "INSERT INTO embeddings(memory_id, vector_json) VALUES (?, ?)"
            );
            stmt.run(memory.id, JSON.stringify(vector));
          }
          results.processed++;
        } else {
          results.failed++;
          results.errors.push({ id: memory.id, error: "No vector returned" });
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        results.failed++;
        results.errors.push({ id: memory.id, error: error.message });
      }
    }

    res.json({
      message: "Batch embedding generation complete",
      ...results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Batch embedding error:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 📊 Embedding Status
// -----------------------------
app.get("/api/memory/embeddings/status", async (req, res) => {
  try {
    if (agentService.memory.store.getEmbeddingStatus) {
      const status = await agentService.memory.getEmbeddingStatus();
      return res.json({
        enabled: agentService.memory.isSemanticSearchEnabled(),
        ...status,
        timestamp: new Date().toISOString(),
      });
    }

    const db = agentService.memory.store.db;

    const totalMemories = db.prepare("SELECT COUNT(*) as count FROM memories").get().count;
    const withEmbeddings = db.prepare(
      "SELECT COUNT(DISTINCT memory_id) as count FROM embeddings"
    ).get().count;
    const withoutEmbeddings = totalMemories - withEmbeddings;

    const coverage = totalMemories > 0 ? ((withEmbeddings / totalMemories) * 100).toFixed(2) : 0;

    res.json({
      enabled: agentService.memory.isSemanticSearchEnabled(),
      totalMemories,
      withEmbeddings,
      withoutEmbeddings,
      coverage: `${coverage}%`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Embedding status error:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// 🎭 Multi-Agent Collaboration Endpoints
// -----------------------------
app.post("/api/multi-agent/run", async (req, res) => {
  try {
    const { task, mode, context } = req.body;

    if (!task) {
      return res.status(400).json({ error: "Task is required" });
    }

    if (!multiAgentOrchestrator) {
      return res.status(503).json({
        error: "Multi-agent mode is not available. Please configure GOOGLE_API_KEY or LLM_API_KEY."
      });
    }

    // Mode: "multi" for multi-agent, "single" for traditional
    if (mode === "multi") {
      const result = await multiAgentOrchestrator.processRequest(task, context || {});

      // Optional: Execute with ADK to create actual files
      if (context.executeWithADK) {
        console.log("🔧 Executing multi-agent results with ADK...");

        // Combine all agent outputs into a single execution plan
        const combinedOutput = result.result.agentOutputs
          .map(output => `## ${output.agentName}\n${output.output}`)
          .join('\n\n');

        // Execute with ADK to create files
        const adkResult = await agentService.runADKPipeline(
          `Implement the following plan:\n\n${combinedOutput}`,
          { userId: context.userId, sessionId: context.sessionId, projectId: context.projectId }
        );

        return res.json({
          success: true,
          mode: "multi-agent-with-execution",
          planning: result,
          execution: adkResult,
          message: "Multi-agent plan created and executed. Files saved to /generated folder."
        });
      }

      res.json({
        success: true,
        mode: "multi-agent",
        ...result,
      });
    } else {
      // Fallback to single agent (current ADK)
      return res.status(400).json({
        error: "Single agent mode should use /api/adk/run endpoint"
      });
    }
  } catch (error) {
    console.error("Multi-agent error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get workflow status
app.get("/api/multi-agent/workflow/:workflowId", (req, res) => {
  try {
    if (!multiAgentOrchestrator) {
      return res.status(503).json({ error: "Multi-agent mode not available" });
    }

    const { workflowId } = req.params;
    const workflow = multiAgentOrchestrator.getWorkflowStatus(workflowId);

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    res.json(workflow);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List active workflows
app.get("/api/multi-agent/workflows", (req, res) => {
  try {
    if (!multiAgentOrchestrator) {
      return res.status(503).json({ error: "Multi-agent mode not available" });
    }

    const workflows = multiAgentOrchestrator.listActiveWorkflows();
    res.json({
      workflows,
      count: workflows.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check multi-agent status
app.get("/api/multi-agent/status", (req, res) => {
  res.json({
    enabled: !!multiAgentOrchestrator,
    agentsAvailable: multiAgentOrchestrator ? 6 : 0,
    agents: multiAgentOrchestrator ? [
      'orchestrator',
      'frontend',
      'backend',
      'devops',
      'qa',
      'database'
    ] : [],
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// DATABASE SEEDING (For Development/Demo)
// ============================================

app.post("/api/seed-database", (req, res) => {
  try {
    // Seed sample templates
    const templates = [
      {
        id: randomUUID(),
        name: "React Dashboard",
        description: "Create a modern React dashboard with charts and analytics",
        category: "Frontend",
        taskTemplate: "Create a React dashboard with data visualization using Recharts, including a sidebar navigation, header, and multiple chart components (line, bar, pie). Use React Bootstrap for styling.",
        tags: ["react", "dashboard", "charts"],
        userId: "system",
        isPublic: true
      },
      {
        id: randomUUID(),
        name: "REST API with Auth",
        description: "Build a secure REST API with JWT authentication",
        category: "Backend",
        taskTemplate: "Build a REST API using Express.js with JWT authentication, including user registration, login, protected routes, and password hashing with bcrypt.",
        tags: ["api", "auth", "jwt", "express"],
        userId: "system",
        isPublic: true
      },
      {
        id: randomUUID(),
        name: "Database Schema",
        description: "Design a normalized database schema",
        category: "Database",
        taskTemplate: "Design a database schema for an e-commerce platform with tables for users, products, orders, order_items, and payments. Include proper relationships, foreign keys, and indexes.",
        tags: ["database", "sql", "schema"],
        userId: "system",
        isPublic: true
      },
      {
        id: randomUUID(),
        name: "CI/CD Pipeline",
        description: "Set up automated CI/CD with Docker",
        category: "DevOps",
        taskTemplate: "Set up a CI/CD pipeline using GitHub Actions with Docker containerization, automated testing, and deployment to a staging environment.",
        tags: ["cicd", "docker", "github-actions"],
        userId: "system",
        isPublic: true
      },
      {
        id: randomUUID(),
        name: "Unit Testing Suite",
        description: "Create comprehensive unit tests",
        category: "Testing",
        taskTemplate: "Create a unit testing suite using Jest, including tests for API endpoints, utility functions, and React components with coverage reports.",
        tags: ["testing", "jest", "qa"],
        userId: "system",
        isPublic: true
      }
    ];

    templates.forEach(template => {
      agentService.memory.store.createTemplate(template);
    });

    res.json({
      success: true,
      message: `Seeded ${templates.length} templates`,
      count: templates.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// TEMPLATE LIBRARY ENDPOINTS
// ============================================

app.post("/api/templates", (req, res) => {
  try {
    const { name, description, category, taskTemplate, tags, userId, isPublic } = req.body;

    if (!name || !taskTemplate) {
      return res.status(400).json({ error: "Name and taskTemplate are required" });
    }

    const id = agentService.memory.store.createTemplate({
      id: randomUUID(),
      name,
      description,
      category,
      taskTemplate,
      tags,
      userId,
      isPublic: isPublic || false
    });

    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/templates", (req, res) => {
  try {
    const { userId, category, isPublic, limit } = req.query;
    const templates = agentService.memory.store.listTemplates({
      userId,
      category,
      isPublic: isPublic === 'true',
      limit: parseInt(limit) || 50
    });

    res.json({ templates, count: templates.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/templates/:id", (req, res) => {
  try {
    const template = agentService.memory.store.getTemplate(req.params.id);

    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/templates/:id/use", (req, res) => {
  try {
    agentService.memory.store.incrementTemplateUsage(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/templates/:id", (req, res) => {
  try {
    agentService.memory.store.deleteTemplate(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WORKFLOW SAVE/LOAD ENDPOINTS
// ============================================

app.post("/api/workflows", (req, res) => {
  try {
    const { name, description, userId, mode, task } = req.body;

    if (!name || !task) {
      return res.status(400).json({ error: "Name and task are required" });
    }

    const id = agentService.memory.store.createWorkflow({
      id: randomUUID(),
      name,
      description,
      userId,
      mode: mode || 'multi',
      task
    });

    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/workflows", (req, res) => {
  try {
    const { userId, status, limit } = req.query;
    const workflows = agentService.memory.store.listWorkflows({
      userId,
      status,
      limit: parseInt(limit) || 50
    });

    res.json({ workflows, count: workflows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/workflows/:id", (req, res) => {
  try {
    const workflow = agentService.memory.store.getWorkflow(req.params.id);

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const steps = agentService.memory.store.getWorkflowSteps(req.params.id);
    const testResults = agentService.memory.store.getTestResults(req.params.id);

    res.json({ ...workflow, steps, testResults });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/workflows/:id", (req, res) => {
  try {
    const { status, result, executionTime, agentOutputs } = req.body;

    agentService.memory.store.updateWorkflow(req.params.id, {
      status,
      resultJson: result,
      executionTime
    });

    // Save agent steps if provided
    if (agentOutputs && Array.isArray(agentOutputs)) {
      agentOutputs.forEach((output, index) => {
        agentService.memory.store.addWorkflowStep({
          workflowId: req.params.id,
          stepNumber: index + 1,
          agentName: output.agentName,
          task: output.task,
          output: output.output,
          executionTime: output.executionTime,
          status: 'completed'
        });
      });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/workflows/:id", (req, res) => {
  try {
    agentService.memory.store.deleteWorkflow(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WORKFLOW IMPORT/EXPORT ENDPOINTS
// ============================================

app.get("/api/workflows/:id/export", (req, res) => {
  try {
    const { format } = req.query; // 'json' or 'yaml'
    const workflow = agentService.memory.store.getWorkflow(req.params.id);

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const steps = agentService.memory.store.getWorkflowSteps(req.params.id);

    const exportData = {
      version: '1.0',
      type: 'workflow',
      exportedAt: new Date().toISOString(),
      workflow: {
        name: workflow.name,
        description: workflow.description,
        mode: workflow.mode,
        task: workflow.task,
        steps: steps,
        result: workflow.result,
        executionTime: workflow.executionTime
      }
    };

    if (format === 'yaml') {
      const yamlContent = yaml.stringify(exportData);
      res.setHeader('Content-Type', 'text/yaml');
      res.setHeader('Content-Disposition', `attachment; filename="workflow-${req.params.id}.yaml"`);
      res.send(yamlContent);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="workflow-${req.params.id}.json"`);
      res.json(exportData);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/workflows/import", (req, res) => {
  try {
    const { data, format, userId } = req.body;

    if (!data) {
      return res.status(400).json({ error: "Data is required" });
    }

    let parsedData;

    if (format === 'yaml') {
      parsedData = yaml.parse(data);
    } else {
      parsedData = typeof data === 'string' ? JSON.parse(data) : data;
    }

    if (!parsedData.workflow || !parsedData.workflow.name) {
      return res.status(400).json({ error: "Invalid workflow format" });
    }

    const workflowId = agentService.memory.store.createWorkflow({
      id: randomUUID(),
      name: parsedData.workflow.name + ' (Imported)',
      description: parsedData.workflow.description,
      userId,
      mode: parsedData.workflow.mode || 'multi',
      task: parsedData.workflow.task
    });

    // Import steps if they exist
    if (parsedData.workflow.steps && Array.isArray(parsedData.workflow.steps)) {
      parsedData.workflow.steps.forEach((step) => {
        agentService.memory.store.addWorkflowStep({
          workflowId,
          stepNumber: step.step_number,
          agentName: step.agent_name,
          task: step.task,
          output: step.output,
          executionTime: step.execution_time,
          status: 'completed'
        });
      });
    }

    agentService.memory.store.logEvent({
      eventType: 'workflow_imported',
      eventData: { workflowId },
      userId
    });

    res.json({ success: true, workflowId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// REAL-TIME STREAMING FOR MULTI-AGENT
// ============================================

app.get("/api/multi-agent/stream", async (req, res) => {
  try {
    const task = req.query.task;
    const mode = req.query.mode || 'multi';

    if (!task) {
      return res.status(400).json({ error: "Task is required" });
    }

    if (!multiAgentOrchestrator) {
      return res.status(503).json({ error: "Multi-agent mode not available" });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Heartbeat
    const heartbeat = setInterval(() => {
      res.write('event: ping\n');
      res.write('data: {}\n\n');
    }, 15000);

    try {
      // Send start event
      res.write('event: start\n');
      res.write(`data: ${JSON.stringify({ task, mode })}\n\n`);

      // Process request with streaming updates
      const context = {
        onProgress: (event) => {
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event.data)}\n\n`);
        }
      };

      const result = await multiAgentOrchestrator.processRequest(task, context);

      // Send completion event
      res.write('event: complete\n');
      res.write(`data: ${JSON.stringify(result)}\n\n`);
    } catch (error) {
      res.write('event: error\n');
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    } finally {
      clearInterval(heartbeat);
      res.end();
    }

    req.on('close', () => {
      clearInterval(heartbeat);
    });
  } catch (error) {
    console.error('Streaming error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HUMAN-IN-THE-LOOP APPROVAL ENDPOINTS
// ============================================

app.post("/api/approvals", (req, res) => {
  try {
    const { workflowId, stepNumber, question, options, userId } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }

    const id = agentService.memory.store.createApproval({
      id: randomUUID(),
      workflowId,
      stepNumber,
      question,
      options,
      userId
    });

    res.json({ success: true, approvalId: id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/approvals/pending", (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const approvals = agentService.memory.store.getPendingApprovals(userId);
    res.json({ approvals, count: approvals.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/approvals/:id", (req, res) => {
  try {
    const approval = agentService.memory.store.getApproval(req.params.id);

    if (!approval) {
      return res.status(404).json({ error: "Approval not found" });
    }

    res.json(approval);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/approvals/:id/respond", (req, res) => {
  try {
    const { response } = req.body;

    if (!response) {
      return res.status(400).json({ error: "Response is required" });
    }

    agentService.memory.store.updateApproval(req.params.id, {
      response,
      status: 'approved'
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GIT INTEGRATION ENDPOINTS
// ============================================

app.post("/api/git/init", async (req, res) => {
  try {
    const { projectPath } = req.body;
    const targetPath = projectPath || '/home/coder/project';

    // Execute git init command
    const { spawn } = await import('child_process');

    const gitInit = spawn('git', ['init'], { cwd: targetPath });

    let output = '';
    gitInit.stdout.on('data', (data) => {
      output += data.toString();
    });

    gitInit.on('close', (code) => {
      if (code === 0) {
        res.json({ success: true, message: 'Git repository initialized', output });
      } else {
        res.status(500).json({ error: 'Git init failed', code });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/git/status", async (req, res) => {
  try {
    const { projectPath } = req.body;
    const targetPath = projectPath || '/home/coder/project';

    const { spawn } = await import('child_process');
    const gitStatus = spawn('git', ['status', '--porcelain'], { cwd: targetPath });

    let output = '';
    gitStatus.stdout.on('data', (data) => {
      output += data.toString();
    });

    gitStatus.on('close', (code) => {
      if (code === 0) {
        const changes = output.split('\n').filter(line => line.trim());
        res.json({ success: true, changes, hasChanges: changes.length > 0 });
      } else {
        res.status(500).json({ error: 'Git status failed' });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/git/commit", async (req, res) => {
  try {
    const { message, projectPath } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Commit message is required" });
    }

    const targetPath = projectPath || '/home/coder/project';
    const { spawn } = await import('child_process');

    // Add all files
    const gitAdd = spawn('git', ['add', '.'], { cwd: targetPath });

    gitAdd.on('close', (code) => {
      if (code !== 0) {
        return res.status(500).json({ error: 'Git add failed' });
      }

      // Commit
      const gitCommit = spawn('git', ['commit', '-m', message], { cwd: targetPath });

      let output = '';
      gitCommit.stdout.on('data', (data) => {
        output += data.toString();
      });

      gitCommit.on('close', (commitCode) => {
        if (commitCode === 0) {
          res.json({ success: true, message: 'Changes committed', output });
        } else {
          res.status(500).json({ error: 'Git commit failed' });
        }
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// AUTO-TESTING ENDPOINTS
// ============================================

app.post("/api/test/run", async (req, res) => {
  try {
    const { workflowId, testCommand, projectPath } = req.body;

    if (!testCommand) {
      return res.status(400).json({ error: "Test command is required" });
    }

    const targetPath = projectPath || '/home/coder/project';
    const { spawn } = await import('child_process');

    const startTime = Date.now();
    const [command, ...args] = testCommand.split(' ');
    const testProcess = spawn(command, args, { cwd: targetPath });

    let output = '';
    let errors = '';

    testProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    testProcess.stderr.on('data', (data) => {
      errors += data.toString();
    });

    testProcess.on('close', (code) => {
      const duration = Date.now() - startTime;
      const status = code === 0 ? 'passed' : 'failed';

      // Save test results if workflowId provided
      if (workflowId) {
        agentService.memory.store.recordTestResult({
          workflowId,
          testSuite: 'automated',
          testName: testCommand,
          status,
          duration,
          errorMessage: code !== 0 ? errors : null,
          output: { stdout: output, stderr: errors, exitCode: code }
        });
      }

      res.json({
        success: code === 0,
        status,
        duration,
        output,
        errors,
        exitCode: code
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/test/results/:workflowId", (req, res) => {
  try {
    const results = agentService.memory.store.getTestResults(req.params.workflowId);

    const summary = {
      total: results.length,
      passed: results.filter(r => r.status === 'passed').length,
      failed: results.filter(r => r.status === 'failed').length,
      totalDuration: results.reduce((sum, r) => sum + (r.duration || 0), 0)
    };

    res.json({ results, summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PERFORMANCE ANALYTICS ENDPOINTS
// ============================================

app.get("/api/analytics/performance", (req, res) => {
  try {
    const { metricType, startDate, endDate, limit } = req.query;

    const metrics = agentService.memory.store.getPerformanceMetrics({
      metricType,
      startDate,
      endDate,
      limit: parseInt(limit) || 100
    });

    // Calculate statistics
    const stats = {};

    if (metrics.length > 0) {
      const values = metrics.map(m => m.value);
      stats.count = values.length;
      stats.avg = values.reduce((a, b) => a + b, 0) / values.length;
      stats.min = Math.min(...values);
      stats.max = Math.max(...values);
      stats.median = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    }

    res.json({ metrics, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/analytics/events", (req, res) => {
  try {
    const { eventType, userId, startDate, endDate, limit } = req.query;

    const events = agentService.memory.store.getAnalytics({
      eventType,
      userId,
      startDate,
      endDate,
      limit: parseInt(limit) || 100
    });

    // Group by event type for summary
    const summary = {};
    events.forEach(event => {
      summary[event.eventType] = (summary[event.eventType] || 0) + 1;
    });

    res.json({ events, summary, count: events.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/analytics/event", (req, res) => {
  try {
    const { eventType, eventData, userId, sessionId } = req.body;

    if (!eventType) {
      return res.status(400).json({ error: "Event type is required" });
    }

    agentService.memory.store.logEvent({
      eventType,
      eventData,
      userId,
      sessionId
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// MULTI-USER COLLABORATION ENDPOINTS (Basic)
// ============================================

app.post("/api/collaboration/session", async (req, res) => {
  try {
    const { workflowId, participants } = req.body;

    if (agentService.memory.store.createCollaborationSession) {
      const sessionId = await agentService.memory.createCollaborationSession({ workflowId, participants });
      return res.json({ success: true, sessionId });
    }

    const sessionId = randomUUID();
    const db = agentService.memory.store.db;

    const stmt = db.prepare(
      "INSERT INTO collaboration_sessions(id, workflow_id, participants_json) VALUES (?, ?, ?)"
    );
    stmt.run(sessionId, workflowId, JSON.stringify(participants || []));

    res.json({ success: true, sessionId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/collaboration/event", async (req, res) => {
  try {
    const { sessionId, userId, eventType, eventData } = req.body;

    if (agentService.memory.store.logCollaborationEvent) {
      await agentService.memory.logCollaborationEvent({ sessionId, userId, eventType, eventData });
      return res.json({ success: true });
    }

    const db = agentService.memory.store.db;
    const stmt = db.prepare(
      "INSERT INTO collaboration_events(collab_session_id, user_id, event_type, event_data_json) VALUES (?, ?, ?, ?)"
    );
    stmt.run(sessionId, userId, eventType, JSON.stringify(eventData || {}));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/collaboration/events/:sessionId", async (req, res) => {
  try {
    if (agentService.memory.store.getCollaborationEvents) {
      const events = await agentService.memory.getCollaborationEvents(req.params.sessionId);
      return res.json({ events, count: events.length });
    }

    const db = agentService.memory.store.db;
    const stmt = db.prepare(
      "SELECT * FROM collaboration_events WHERE collab_session_id = ? ORDER BY created_at DESC LIMIT 100"
    );
    const events = stmt.all(req.params.sessionId);

    res.json({ events, count: events.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
//  Startup
// -----------------------------
const PORT = process.env.PORT || 3030;

(async function startServer() {
  try {
    console.log("=================== Initializing ADK-only server... ===================");

    await Promise.allSettled([
      agentService.initialize(),
      workshopStore.bootstrap(),
      chatService.initialize?.(),
    ]);

    console.log("ADK Mode Enabled → /api/adk/run");

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`API running on port ${PORT}:${PORT}`);
      console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🛡️  Rate limiting enabled`);
    });

    // Graceful shutdown handler
    const gracefulShutdown = async (signal) => {
      console.log(`\n${signal} received, shutting down gracefully...`);

      server.close(async () => {
        console.log('✅ HTTP server closed');

        try {
          // Close database connections
          closeDatabase();
          console.log('✅ Database connections closed');
        } catch (error) {
          console.error('Error during shutdown:', error);
        }

        process.exit(0);
      });

      // Force close after 10 seconds
      setTimeout(() => {
        console.error('⚠️  Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    // Register shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    console.error("Failed to start server: ", error);
    process.exit(1);
  }
})();
