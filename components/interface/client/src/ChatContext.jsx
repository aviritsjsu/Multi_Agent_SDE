import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { toast } from "react-toastify";
import { useAuth } from "./contexts/AuthContext";
import { apiFetch, apiEventSource } from "./utils/apiClient";
import JSZip from "jszip";
import { saveAs } from "file-saver";

const ChatContext = createContext();

// Smart title generation from user message
const generateSmartTitle = (content) => {
  if (!content) return 'New Chat';

  // Common action words to look for
  const actionPatterns = [
    { pattern: /create\s+(?:a\s+)?(.{1,30})/i, prefix: 'Create' },
    { pattern: /build\s+(?:a\s+)?(.{1,30})/i, prefix: 'Build' },
    { pattern: /make\s+(?:a\s+)?(.{1,30})/i, prefix: 'Make' },
    { pattern: /write\s+(?:a\s+)?(.{1,30})/i, prefix: 'Write' },
    { pattern: /fix\s+(?:the\s+)?(.{1,30})/i, prefix: 'Fix' },
    { pattern: /debug\s+(?:the\s+)?(.{1,30})/i, prefix: 'Debug' },
    { pattern: /explain\s+(?:the\s+)?(.{1,30})/i, prefix: 'Explain' },
    { pattern: /review\s+(?:the\s+)?(.{1,30})/i, prefix: 'Review' },
    { pattern: /analyze\s+(?:the\s+)?(.{1,30})/i, prefix: 'Analyze' },
    { pattern: /help\s+(?:me\s+)?(?:with\s+)?(.{1,30})/i, prefix: 'Help' },
    { pattern: /how\s+(?:to\s+|do\s+I\s+)?(.{1,30})/i, prefix: 'How to' },
    { pattern: /what\s+is\s+(.{1,30})/i, prefix: 'About' },
  ];

  // Try to match action patterns
  for (const { pattern, prefix } of actionPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      let subject = match[1].trim();
      // Clean up the subject
      subject = subject.replace(/[.!?]$/, '').replace(/\s+/g, ' ');
      // Capitalize first letter
      subject = subject.charAt(0).toUpperCase() + subject.slice(1);
      // Truncate if too long
      if (subject.length > 35) {
        subject = subject.substring(0, 32) + '...';
      }
      return `${prefix}: ${subject}`;
    }
  }

  // Fallback: Clean up and use first part of message
  let title = content
    .replace(/^(hi|hello|hey|please|can you|could you|i want to|i need to)\s*/i, '')
    .replace(/[.!?]+$/, '')
    .trim();

  // Capitalize and truncate
  title = title.charAt(0).toUpperCase() + title.slice(1);
  if (title.length > 45) {
    title = title.substring(0, 42) + '...';
  }

  return title || 'New Chat';
};

export const ChatContextProvider = ({ children }) => {
  const { currentUser } = useAuth();
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState("ask");
  const [availableTools, setAvailableTools] = useState([]);
  const [progressEvents, setProgressEvents] = useState([]);
  const [insights, setInsights] = useState([]);
  const [agentActivity, setAgentActivity] = useState([]);
  const [activeAgent, setActiveAgent] = useState(null);
  const [pipelineProgress, setPipelineProgress] = useState({ current: 0, total: 5, percentage: 0 });
  const [tokenUsage, setTokenUsage] = useState({ input: 0, output: 0, total: 0, estimatedCost: 0 });
  const [pipelineError, setPipelineError] = useState(null);
  const sseRef = useRef(null);
  const pipelineTimeoutRef = useRef(null);
  const PIPELINE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

  // Session management state
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const currentSessionIdRef = useRef(null); // Ref to track ID immediately to prevent race conditions
  const [sessions, setSessions] = useState([]);
  const [sessionName, setSessionName] = useState("New Chat");
  const [projectPath, setProjectPath] = useState(null); // For ADK refinement
  const [projectGcsPrefix, setProjectGcsPrefix] = useState(null); // For project download
  const autoSaveTimeoutRef = useRef(null);
  const [isLoadingSession, setIsLoadingSession] = useState(false); // Prevent auto-save during load

  // Sync ref with state
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // Load sessions from API on mount and when user changes
  useEffect(() => {
    if (currentUser) {
      loadSessionsFromAPI();
    }
  }, [currentUser]);

  const loadSessionsFromAPI = async () => {
    if (!currentUser) return;

    try {
      // Pass the authenticated user's ID to get only their sessions
      const response = await apiFetch(`/api/memory/sessions?limit=50&userId=${currentUser.uid}`);
      const data = await response.json();
      const apiSessions = (data.sessions || []).map(s => {
        // Safe date formatting
        let dateStr = 'Recent';
        if (s.createdAt) {
          const d = new Date(s.createdAt);
          if (!isNaN(d.getTime())) {
            dateStr = d.toLocaleString();
          }
        }
        return {
          id: s.id,
          name: s.metadata?.chatName || `Chat ${dateStr}`,
          messages: s.metadata?.messages || [],
          mode: s.metadata?.mode || 'ask',
          createdAt: s.createdAt || new Date().toISOString(),
          updatedAt: s.updatedAt || s.createdAt || new Date().toISOString(),
        };
      });
      setSessions(apiSessions);
    } catch (err) {
      console.error('Failed to load sessions from API:', err);
      // Fallback to localStorage
      const savedSessions = localStorage.getItem('chatSessions');
      if (savedSessions) {
        try {
          setSessions(JSON.parse(savedSessions));
        } catch (e) {
          console.error('Failed to load from localStorage:', e);
        }
      }
    }
  };

  // Auto-save current session when messages change
  useEffect(() => {
    if (messages.length === 0 || isLoadingSession) return; // Skip if loading session

    // Clear existing timeout
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    // Auto-generate smart session name from first user message if still "New Chat"
    if (sessionName === 'New Chat' && messages.length > 0) {
      const firstUserMsg = messages.find(m => m.role === 'user');
      if (firstUserMsg) {
        const autoName = generateSmartTitle(firstUserMsg.content);
        setSessionName(autoName);
      }
    }

    // Set new timeout for auto-save (debounce)
    autoSaveTimeoutRef.current = setTimeout(() => {
      saveCurrentSession();
    }, 2000); // Auto-save after 2 seconds of inactivity

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [messages, isLoadingSession]);

  const stopStream = useCallback(async (showToast = true) => {
    // Close SSE connection
    try { sseRef.current?.close?.(); } catch { }
    sseRef.current = null;

    // Clear pipeline timeout
    if (pipelineTimeoutRef.current) {
      clearTimeout(pipelineTimeoutRef.current);
      pipelineTimeoutRef.current = null;
    }

    // Notify backend to cancel (fire and forget)
    try {
      fetch('/api/adk/cancel', { method: 'POST' }).catch(() => { });
    } catch { }

    // Reset states
    setActiveAgent(null);
    setIsLoading(false);
    setPipelineProgress({ current: 0, total: 5, percentage: 0 });
    // Don't clear projectGcsPrefix here as user might want to download after stop

    if (showToast) {
      toast.warning('🛑 Generation stopped');
    }
  }, []);

  const sendMessage = useCallback(async (userMessage) => {
    const newMessage = {
      id: Date.now(),
      role: "user",
      content: userMessage,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, newMessage]);

    // Ensure we have a session ID before making the API call
    let activeSessionId = currentSessionIdRef.current; // Use ref for immediate check

    if (!activeSessionId && currentUser) {
      const tempSessionData = {
        userId: currentUser.uid,
        metadata: {
          chatName: sessionName === 'New Chat' ? generateSmartTitle(userMessage) : sessionName,
          messages: [newMessage],
          mode: mode,
          messageCount: 1,
        }
      };

      try {
        const response = await apiFetch('/api/memory/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tempSessionData)
        });
        const data = await response.json();
        activeSessionId = data.id;
        setCurrentSessionId(activeSessionId);
        currentSessionIdRef.current = activeSessionId; // Update ref immediately
        if (sessionName === 'New Chat') {
          setSessionName(generateSmartTitle(userMessage));
        }
      } catch (err) {
        console.error('Failed to create session:', err);
      }
    }

    if (mode === "ask") {
      setIsLoading(true);
      setProgressEvents([]);
      try {
        // Build conversation context from recent messages
        const recentMessages = messages.slice(-6); // Last 6 messages (3 turns of user + assistant)
        let taskWithContext = userMessage;

        if (recentMessages.length > 0) {
          const contextHistory = recentMessages
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n\n');

          taskWithContext = `Previous conversation:\n${contextHistory}\n\nCurrent request:\n${userMessage}`;
        }

        const url = `/api/adk/stream?task=${encodeURIComponent(taskWithContext)}&sessionId=${activeSessionId || ''}&userId=${currentUser?.uid || ''}&projectId=${activeSessionId || ''}`;
        const ev = apiEventSource(url);  // Use authenticated EventSource
        sseRef.current = ev;
        setPipelineError(null);
        setPipelineProgress({ current: 0, total: 5, percentage: 0 });

        // Set pipeline timeout (5 minutes max)
        pipelineTimeoutRef.current = setTimeout(() => {
          stopStream(false);
          setMessages((prev) => [
            ...prev,
            { id: Date.now() + 1, role: "assistant", content: "⏱️ **Pipeline timed out** after 15 minutes. Please try a simpler request or check the server logs.", timestamp: new Date(), provider: "error" },
          ]);
          toast.error('⏱️ Pipeline timed out after 15 minutes');
        }, PIPELINE_TIMEOUT_MS);

        ev.addEventListener("agent.start", (e) => {
          setProgressEvents((p) => [...p, { type: "agent.start", data: JSON.parse(e.data) }]);
        });
        ev.addEventListener("loop.ready", (e) => {
          setProgressEvents((p) => [...p, { type: "loop.ready", data: JSON.parse(e.data) }]);
        });
        ev.addEventListener("pipeline.ready", (e) => {
          setProgressEvents((p) => [...p, { type: "pipeline.ready", data: JSON.parse(e.data) }]);
        });
        ev.addEventListener("runner.start", (e) => {
          setProgressEvents((p) => [...p, { type: "runner.start", data: JSON.parse(e.data) }]);
        });
        ev.addEventListener("runner.event", (e) => {
          setProgressEvents((p) => [...p, { type: "runner.event", data: JSON.parse(e.data) }]);
        });
        ev.addEventListener("pipeline.start", (e) => {
          try {
            const d = JSON.parse(e.data);
            setAgentActivity([]);
            setPipelineProgress({ current: 0, total: 5, percentage: 0 });
            setProgressEvents((p) => [...p, { type: "pipeline.start", data: d }]);
          } catch { }
        });
        ev.addEventListener("agent.start", (e) => {
          try {
            const d = JSON.parse(e.data);
            setActiveAgent(d.agent);

            // Update progress based on agent
            const agentOrder = ['BusinessAnalystAgent', 'CodeWriterAgent', 'CodeReviewerAgent', 'CodeRefactorerAgent', 'FileSaverAgent', 'TestingAgent'];
            const agentIndex = agentOrder.findIndex(a => d.agent?.includes(a.replace('Agent', '')));
            if (agentIndex >= 0) {
              const progress = Math.round(((agentIndex + 1) / agentOrder.length) * 100);
              setPipelineProgress({ current: agentIndex + 1, total: agentOrder.length, percentage: progress });
            }

            setAgentActivity((p) => [...p, {
              agent: d.agent,
              action: "started",
              description: d.description,
              timestamp: d.timestamp || new Date().toISOString()
            }]);
            setProgressEvents((p) => [...p, { type: "agent.start", data: d }]);
          } catch { }
        });
        ev.addEventListener("tool.use", (e) => {
          try {
            const d = JSON.parse(e.data);
            setAgentActivity((p) => [...p, {
              agent: d.agent,
              action: "using_tool",
              tool: d.tool,
              timestamp: d.timestamp || new Date().toISOString()
            }]);
            setProgressEvents((p) => [...p, { type: "tool.use", data: d }]);
          } catch { }
        });
        ev.addEventListener("agent.output", (e) => {
          try {
            const d = JSON.parse(e.data);
            // d: { agent, text, is_partial }
            setInsights((p) => [...p, d]);
            setAgentActivity((p) => [...p, {
              agent: d.agent,
              action: "output",
              text: d.text,
              is_partial: d.is_partial,
              timestamp: new Date().toISOString()
            }]);
            setProgressEvents((p) => [...p, { type: "agent.output", data: d }]);
          } catch { }
        });
        ev.addEventListener("log", (e) => {
          setProgressEvents((p) => [...p, { type: "log", data: JSON.parse(e.data) }]);
        });
        ev.addEventListener("error", (e) => {
          try {
            const d = JSON.parse(e.data);
            setPipelineError(d.error || d.message || 'Unknown error');
            setProgressEvents((p) => [...p, { type: "error", data: d }]);

            // Show user-friendly error
            const errorMessage = d.error || d.message || 'An error occurred';
            let friendlyMessage = '❌ ';
            if (errorMessage.includes('API key')) {
              friendlyMessage += 'API key issue. Please check your configuration.';
            } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
              friendlyMessage += 'Request timed out. Try a simpler request.';
            } else if (errorMessage.includes('rate limit')) {
              friendlyMessage += 'Rate limit exceeded. Please wait a moment.';
            } else if (errorMessage.includes('model')) {
              friendlyMessage += 'Model unavailable. Check LLM configuration.';
            } else {
              friendlyMessage += errorMessage.substring(0, 100);
            }
            toast.error(friendlyMessage);
          } catch { }
        });
        ev.addEventListener("pipeline.complete", (e) => {
          try {
            const d = JSON.parse(e.data);
            setActiveAgent(null);
            setProgressEvents((p) => [...p, { type: "pipeline.complete", data: d }]);
          } catch { }
        });
        ev.addEventListener("complete", (e) => {
          try {
            const d = JSON.parse(e.data);
            const outputs = Array.isArray(d.outputs) ? d.outputs : [];
            const combined = outputs.join("\n\n");

            // Store project path for refinement
            if (d.projectPath) {
              setProjectPath(d.projectPath);
            }

            setMessages((prev) => [
              ...prev,
              { id: Date.now() + 1, role: "assistant", content: combined || "✅ ADK pipeline complete.", timestamp: new Date(), provider: "ADK" },
            ]);
            // Track token usage if available
            if (d.usage) {
              setTokenUsage({
                input: d.usage.inputTokens || 0,
                output: d.usage.outputTokens || 0,
                total: (d.usage.inputTokens || 0) + (d.usage.outputTokens || 0),
                estimatedCost: ((d.usage.inputTokens || 0) * 0.000001 + (d.usage.outputTokens || 0) * 0.000002).toFixed(4)
              });
            }
          } finally {
            setActiveAgent(null);
            setPipelineProgress({ current: 5, total: 5, percentage: 100 });
            if (pipelineTimeoutRef.current) {
              clearTimeout(pipelineTimeoutRef.current);
              pipelineTimeoutRef.current = null;
            }
            stopStream(false);
            setIsLoading(false);
          }
        });

        // Handle SSE errors - improved to prevent false "Connection lost" messages
        let streamCompleted = false;
        ev.addEventListener("complete", () => {
          streamCompleted = true;
        });
        ev.addEventListener("pipeline.complete", () => {
          streamCompleted = true;
        });

        ev.addEventListener("project.uploaded", (e) => {
          try {
            const d = JSON.parse(e.data);
            console.log('📦 Project uploaded event received:', d);
            if (d.gcsPrefix) {
              setProjectGcsPrefix(d.gcsPrefix);
              if (d.projectPath) setProjectPath(d.projectPath);
            }
          } catch (err) {
            console.error('Error parsing project.uploaded event:', err);
          }
        });

        ev.onerror = (err) => {
          // Check if the stream was intentionally closed or already completed
          if (streamCompleted || !sseRef.current || sseRef.current.readyState === EventSource.CLOSED) {
            console.log('SSE stream closed normally');
            return; // Normal closure, don't show error
          }

          console.error('SSE error:', err);
          if (pipelineTimeoutRef.current) {
            clearTimeout(pipelineTimeoutRef.current);
          }
          stopStream(false);
          setMessages((prev) => [
            ...prev,
            { id: Date.now() + 1, role: "assistant", content: "❌ **Connection lost**. The pipeline may still be running on the server. Please check and try again.", timestamp: new Date(), provider: "error" },
          ]);
        };
      } catch (error) {
        stopStream();
        setIsLoading(false);
        setMessages((prev) => [
          ...prev,
          { id: Date.now() + 1, role: "assistant", content: `❌ **Error**: ${error.message}`, timestamp: new Date(), provider: "error" },
        ]);
      }
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiFetch("/api/adk/run", {  // Use authenticated fetch
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage }),
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const aiResponse = await response.json();
      const combinedOutput = Array.isArray(aiResponse.outputs)
        ? aiResponse.outputs.join("\n\n")
        : aiResponse.outputs || aiResponse.message || "✅ ADK pipeline complete.";
      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 1, role: "assistant", content: combinedOutput, timestamp: new Date(), provider: aiResponse.mode || "ADK" },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 1, role: "assistant", content: `❌ **Error**: ${error.message}`, timestamp: new Date(), provider: "error" },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [mode, stopStream]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setProgressEvents([]);
    setInsights([]);
    setAgentActivity([]);
    setActiveAgent(null);
    setProjectPath(null);
    setProjectGcsPrefix(null);
  }, []);

  const regenerateLastMessage = useCallback(() => {
    const userMessages = messages.filter((m) => m.role === "user");
    if (userMessages.length > 0) {
      const lastUser = userMessages[userMessages.length - 1];
      const msgs = messages.slice(0, -1);
      setMessages(msgs);
      sendMessage(lastUser.content);
    }
  }, [messages, sendMessage]);

  // Session management functions
  const saveCurrentSession = useCallback(async () => {
    if (messages.length === 0) return;

    try {
      // CRITICAL: Include userId from authenticated user
      const sessionData = {
        userId: currentUser?.uid,
        metadata: {
          chatName: sessionName,
          messages: messages,
          mode: mode,
          messageCount: messages.length,
          lastProject: projectPath ? {
            path: projectPath,
            createdAt: new Date().toISOString()
          } : undefined
        }
      };

      // Use ref to check for ID even if state hasn't updated yet
      let savedSessionId = currentSessionIdRef.current || currentSessionId;

      if (savedSessionId) {
        // Update existing session
        await apiFetch(`/api/memory/sessions/${savedSessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sessionData)
        });
      } else {
        // Create new session
        const response = await apiFetch('/api/memory/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sessionData)
        });
        const data = await response.json();
        savedSessionId = data.id;
        setCurrentSessionId(savedSessionId);
      }

      // Reload sessions from API
      await loadSessionsFromAPI();

      // Also save to localStorage as backup
      const session = {
        id: savedSessionId,
        name: sessionName,
        messages: messages,
        mode: mode,
        createdAt: currentSessionId ? sessions.find(s => s.id === currentSessionId)?.createdAt || new Date().toISOString() : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const existingIndex = sessions.findIndex(s => s.id === session.id);
      let updatedSessions;
      if (existingIndex >= 0) {
        updatedSessions = [...sessions];
        updatedSessions[existingIndex] = session;
      } else {
        updatedSessions = [session, ...sessions];
      }
      localStorage.setItem('chatSessions', JSON.stringify(updatedSessions));
    } catch (err) {
      console.error('Failed to save session to API:', err);
      toast.error('❌ Failed to save session');
    }
  }, [messages, currentSessionId, sessionName, mode, sessions]);

  const loadSession = useCallback((session) => {
    setIsLoadingSession(true); // Prevent auto-save trigger
    setMessages(session.messages || []);
    setMode(session.mode || 'ask');
    setCurrentSessionId(session.id);
    setSessionName(session.name || 'New Chat');
    setAgentActivity([]);
    setInsights([]);
    toast.info(`📋 Loaded: ${session.name}`);
    // Reset flag after a brief delay
    setTimeout(() => setIsLoadingSession(false), 500);
  }, []);

  const deleteSession = useCallback(async (sessionId) => {
    try {
      // Delete from API
      await apiFetch(`/api/memory/sessions/${sessionId}`, {
        method: 'DELETE'
      });

      // Update local state
      const updatedSessions = sessions.filter(s => s.id !== sessionId);
      setSessions(updatedSessions);
      localStorage.setItem('chatSessions', JSON.stringify(updatedSessions));

      if (currentSessionId === sessionId) {
        setMessages([]);
        setCurrentSessionId(null);
        setSessionName('New Chat');
      }

      toast.success('✅ Session deleted');
    } catch (err) {
      console.error('Failed to delete session:', err);
      toast.error('❌ Failed to delete session');
    }
  }, [sessions, currentSessionId]);

  const newSession = useCallback(() => {
    if (messages.length > 0) {
      saveCurrentSession();
    }
    setMessages([]);
    setCurrentSessionId(null);
    setSessionName('New Chat');
    setAgentActivity([]);
    setInsights([]);
    setProjectPath(null);
    setProjectGcsPrefix(null);
    toast.info('🆕 New chat started');
  }, [messages, saveCurrentSession]);

  // Export conversation functions
  const exportConversation = useCallback((format = 'json') => {
    if (messages.length === 0) {
      toast.warning('No messages to export');
      return;
    }

    const timestamp = new Date().toISOString().split('T')[0];
    let content = '';
    let filename = '';
    let mimeType = 'text/plain';

    if (format === 'json') {
      const exportData = {
        sessionId: currentSessionId,
        sessionName,
        exportedAt: new Date().toISOString(),
        messageCount: messages.length,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          provider: m.provider,
          model: m.model,
        }))
      };
      content = JSON.stringify(exportData, null, 2);
      filename = `conversation-${timestamp}.json`;
      mimeType = 'application/json';
    } else if (format === 'markdown') {
      const header = `# ${sessionName || 'Conversation'}\n\nExported: ${new Date().toLocaleString()}\n\n---\n\n`;
      content = header + messages.map(m => {
        const role = m.role === 'user' ? '👤 **You**' : '🤖 **Immortal**';
        const time = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
        return `### ${role} ${time ? `_(${time})_` : ''}\n\n${m.content}\n\n---\n`;
      }).join('\n');
      filename = `conversation-${timestamp}.md`;
    } else if (format === 'text') {
      content = messages.map(m => {
        const role = m.role === 'user' ? 'You' : 'Immortal';
        const time = m.timestamp ? `[${new Date(m.timestamp).toLocaleString()}]` : '';
        return `${time} ${role}:\n${m.content}\n\n`;
      }).join('');
      filename = `conversation-${timestamp}.txt`;
    }

    // Create and download file
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`✅ Exported as ${format.toUpperCase()}`);
  }, [messages, sessionName, currentSessionId]);

  const renameSession = useCallback(async (sessionId, newName) => {
    try {
      // Update session name in API
      const session = sessions.find(s => s.id === sessionId);
      if (session) {
        await apiFetch(`/api/memory/sessions/${sessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            metadata: {
              ...session.metadata,
              chatName: newName,
              messages: session.messages,
              mode: session.mode,
            }
          })
        });
      }

      // Update local state
      const updatedSessions = sessions.map(s =>
        s.id === sessionId ? { ...s, name: newName, updatedAt: new Date().toISOString() } : s
      );
      setSessions(updatedSessions);
      localStorage.setItem('chatSessions', JSON.stringify(updatedSessions));

      if (currentSessionId === sessionId) {
        setSessionName(newName);
      }
    } catch (err) {
      console.error('Failed to rename session:', err);
      toast.error('❌ Failed to rename session');
    }
  }, [sessions, currentSessionId]);

  const downloadProject = useCallback(async (prefix) => {
    if (!prefix) return;
    const toastId = toast.loading('📦 Preparing download...');
    try {
      const res = await apiFetch(`/api/projects/files?prefix=${encodeURIComponent(prefix)}`);
      if (!res.ok) throw new Error(`Failed to fetch file list: ${res.statusText}`);
      const { files } = await res.json();

      if (!files || files.length === 0) {
        toast.update(toastId, { render: '❌ No files found in project', type: 'error', isLoading: false, autoClose: 3000 });
        return;
      }

      const zip = new JSZip();
      const folderName = prefix.split('/').filter(Boolean).pop() || 'project';

      await Promise.all(files.map(async (file) => {
        try {
          const fileRes = await fetch(file.url);
          const blob = await fileRes.blob();
          zip.file(file.name, blob);
        } catch (err) {
          console.error(`Failed to download file ${file.name}:`, err);
        }
      }));

      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `${folderName}.zip`);
      toast.update(toastId, { render: '✅ Project downloaded', type: 'success', isLoading: false, autoClose: 3000 });
    } catch (err) {
      console.error('Download failed:', err);
      toast.update(toastId, { render: `❌ Download failed: ${err.message}`, type: 'error', isLoading: false, autoClose: 3000 });
    }
  }, []);

  return (
    <ChatContext.Provider
      value={{
        messages,
        setMessages,
        sendMessage,
        isLoading,
        clearMessages,
        regenerateLastMessage,
        mode,
        setMode,
        availableTools,
        progressEvents,
        insights,
        agentActivity,
        activeAgent,
        stopStream,
        // Pipeline state
        pipelineProgress,
        tokenUsage,
        pipelineError,
        // Session management
        sessions,
        currentSessionId,
        sessionName,
        setSessionName,
        saveCurrentSession,
        loadSession,
        deleteSession,
        newSession,
        renameSession,
        exportConversation,
        exportConversation,
        projectPath,  // Expose projectPath for workspace integration
        projectGcsPrefix, // Expose for download
        currentUser, // Expose currentUser for components that need auth info
        downloadProject, // Expose download function
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => useContext(ChatContext);
