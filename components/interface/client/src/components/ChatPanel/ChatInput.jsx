import { useState, useEffect, useRef } from "react";
import { useChat } from "../../ChatContext";
import { Badge, ProgressBar, Button, OverlayTrigger, Tooltip } from "react-bootstrap";
import { toast } from "react-toastify";

export function ChatInput() {
  const [input, setInput] = useState("");
  const { sendMessage, isLoading, mode, currentSessionId, messages } = useChat();
  const [contextFiles, setContextFiles] = useState([]);
  const [contextSize, setContextSize] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recognition, setRecognition] = useState(null);
  const maxContextSize = 8000; // tokens

  // @ mention autocomplete state
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionFiles, setMentionFiles] = useState([]);
  const [mentionQuery, setMentionQuery] = useState("");
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(0);
  const textareaRef = useRef(null);

  // Initialize speech recognition
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognitionInstance = new SpeechRecognition();
      recognitionInstance.continuous = false;
      recognitionInstance.interimResults = false;
      recognitionInstance.lang = 'en-US';

      recognitionInstance.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        setInput(prev => prev + (prev ? ' ' : '') + transcript);
        toast.success('🎤 Voice input captured');
      };

      recognitionInstance.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        toast.error(`❌ Voice input error: ${event.error}`);
        setIsRecording(false);
      };

      recognitionInstance.onend = () => {
        setIsRecording(false);
      };

      setRecognition(recognitionInstance);
    }
  }, []);

  // Fetch context files and token usage
  useEffect(() => {
    // TODO: Re-enable when /api/chat/:sessionId/context endpoint is implemented
    // Currently this endpoint doesn't exist and causes 404 errors
    /*
    const fetchContext = async () => {
      if (!currentSessionId) return;

      try {
        const response = await fetch(`/api/chat/${currentSessionId}/context`);
        if (response.ok) {
          const data = await response.json();
          setContextFiles(data.files || []);
          // Update token usage if provided
          if (data.tokenUsage) {
            // We can use this to show total session tokens
            setContextSize(data.tokenUsage.total || 0);
          }
        }
      } catch (err) {
        console.error('Failed to fetch context:', err);
      }
    };

    if (mode === 'agent' || mode === 'ask') {
      fetchContext();
      // Poll for updates every 10 seconds or when messages change
      const interval = setInterval(fetchContext, 10000);
      return () => clearInterval(interval);
    } else {
      setContextFiles([]);
      setContextSize(0);
    }
    */
  }, [mode, currentSessionId, messages.length]); // Re-fetch when messages change

  // Fetch workspace files when @ is typed
  useEffect(() => {
    const fetchWorkspaceFiles = async () => {
      console.log('[@ Mention] Fetching files with query:', mentionQuery);
      try {
        const response = await fetch(`/api/workspace/files?query=${encodeURIComponent(mentionQuery)}&limit=20`);
        console.log('[@ Mention] Response status:', response.status);
        const data = await response.json();
        console.log('[@ Mention] Received files:', data.files?.length || 0, 'files');
        setMentionFiles(data.files || []);
        if (data.files && data.files.length === 0) {
          console.warn('[@ Mention] No files found in workspace. Check API and workspace path.');
        }
      } catch (err) {
        console.error('[@ Mention] Failed to fetch workspace files:', err);
        setMentionFiles([]);
      }
    };

    if (showMentionDropdown) {
      console.log('[@ Mention] Dropdown is shown, fetching files...');
      fetchWorkspaceFiles();
    }
  }, [mentionQuery, showMentionDropdown]);

  const toggleVoiceInput = () => {
    if (!recognition) {
      toast.error('❌ Voice input not supported in this browser');
      return;
    }

    if (isRecording) {
      recognition.stop();
      setIsRecording(false);
    } else {
      recognition.start();
      setIsRecording(true);
      toast.info('🎤 Listening...');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const message = input.trim();
    setInput("");
    await sendMessage(message);
  };

  const getPlaceholder = () => {
    switch (mode) {
      case "agent":
        return "Ask me to create, modify, or analyze your code... (Type @ for files)";
      case "chat":
        return "Ask me anything about development... (Type @ for files)";
      case "ask":
        return "Ask me to read and analyze your files... (Type @ for files)";
      default:
        return "Type your message... (Type @ for files)";
    }
  };

  return (
    <div className="chat-input" style={{ flexShrink: 0 }}>
      {/* Context Info Panel */}
      {(mode === 'agent' || mode === 'ask') && contextFiles.length > 0 && (
        <div className="context-panel mb-2 p-3" style={{
          background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(139, 92, 246, 0.1) 100%)',
          borderRadius: '12px',
          border: '1px solid rgba(139, 92, 246, 0.3)',
          backdropFilter: 'blur(8px)',
        }}>
          <div className="d-flex justify-content-between align-items-center mb-2">
            <div className="d-flex align-items-center gap-2">
              <span style={{
                fontSize: '0.85em',
                color: 'rgba(255, 255, 255, 0.9)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}>
                <span style={{
                  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                  borderRadius: '6px',
                  padding: '2px 6px',
                  fontSize: '0.75em',
                }}>📁 {contextFiles.length}</span>
                files in context
              </span>
              <OverlayTrigger
                placement="top"
                overlay={<Tooltip>Context includes files the AI can see and reference</Tooltip>}
              >
                <span style={{ cursor: 'help', fontSize: '0.75em', opacity: 0.6 }}>ⓘ</span>
              </OverlayTrigger>
            </div>
            <span style={{
              fontSize: '0.75em',
              color: 'rgba(255, 255, 255, 0.7)',
              background: 'rgba(255, 255, 255, 0.1)',
              padding: '2px 8px',
              borderRadius: '10px',
            }}>
              {contextSize.toLocaleString()} / {maxContextSize.toLocaleString()} tokens
            </span>
          </div>

          {/* Context Size Progress Bar */}
          <ProgressBar
            now={(contextSize / maxContextSize) * 100}
            variant={contextSize > maxContextSize * 0.8 ? 'warning' : 'info'}
            style={{
              height: '4px',
              marginBottom: '10px',
              background: 'rgba(255, 255, 255, 0.1)',
              borderRadius: '2px',
            }}
          />

          {/* File Badges */}
          <div className="d-flex flex-wrap gap-2">
            {contextFiles.map((file, idx) => (
              <div
                key={idx}
                style={{
                  fontSize: '0.75em',
                  padding: '6px 10px',
                  background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.25) 0%, rgba(139, 92, 246, 0.2) 100%)',
                  border: '1px solid rgba(139, 92, 246, 0.4)',
                  borderRadius: '8px',
                  color: 'rgba(255, 255, 255, 0.95)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'all 0.2s ease',
                  cursor: 'default',
                }}
              >
                <span style={{ fontSize: '1em' }}>📄</span>
                <span style={{ fontWeight: 500 }}>{file.name}</span>
                <span style={{
                  opacity: 0.6,
                  fontSize: '0.9em',
                  background: 'rgba(255, 255, 255, 0.1)',
                  padding: '1px 5px',
                  borderRadius: '4px',
                }}>
                  {file.size >= 1000 ? `${(file.size / 1000).toFixed(1)}k` : file.size}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ position: 'relative' }}>
        {/* @ Mention Dropdown - positioned above form */}
        {showMentionDropdown && (
          <div
            className="mention-dropdown"
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              right: 0,
              maxHeight: '200px',
              overflowY: 'auto',
              background: 'rgba(30, 41, 59, 0.98)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(236, 72, 153, 0.3)',
              borderRadius: '12px',
              marginBottom: '8px',
              boxShadow: '0 -8px 32px rgba(0, 0, 0, 0.4)',
              zIndex: 1000,
            }}
          >
            {mentionFiles.length > 0 ? (
              mentionFiles.map((file, index) => (
                <div
                  key={file.path}
                  onClick={() => {
                    const before = input.substring(0, mentionStartPos);
                    const after = input.substring(textareaRef.current.selectionStart);
                    const newInput = before + file.path + ' ' + after;
                    setInput(newInput);
                    setShowMentionDropdown(false);
                    textareaRef.current.focus();
                  }}
                  style={{
                    padding: '10px 14px',
                    cursor: 'pointer',
                    background: index === selectedMentionIndex
                      ? 'rgba(236, 72, 153, 0.15)'
                      : 'transparent',
                    borderLeft: index === selectedMentionIndex
                      ? '3px solid #ec4899'
                      : '3px solid transparent',
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                  }}
                  onMouseEnter={() => setSelectedMentionIndex(index)}
                >
                  <span style={{ fontSize: '1.2em' }}>
                    {file.type === 'directory' ? '📁' : '📄'}
                  </span>
                  <span style={{
                    color: index === selectedMentionIndex ? '#f9a8d4' : '#cbd5e1',
                    fontSize: '0.9em',
                  }}>
                    {file.path}
                  </span>
                  <Badge
                    bg="secondary"
                    style={{
                      fontSize: '0.7em',
                      marginLeft: 'auto',
                      opacity: 0.7,
                    }}
                  >
                    {file.type}
                  </Badge>
                </div>
              ))
            ) : (
              <div style={{ padding: '12px', textAlign: 'center', color: '#94a3b8', fontSize: '0.9em' }}>
                {mentionQuery ? `No files matching "${mentionQuery}"` : 'Loading files...'}
              </div>
            )}
          </div>
        )}

        <div className="input-wrapper">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              const value = e.target.value;
              const cursorPos = e.target.selectionStart;
              setInput(value);

              // Detect @ mention
              const textBeforeCursor = value.substring(0, cursorPos);
              const lastAtIndex = textBeforeCursor.lastIndexOf('@');

              if (lastAtIndex !== -1) {
                const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1);
                if (!textAfterAt.includes(' ')) {
                  console.log('[@ Mention] Detected @ at position', lastAtIndex, 'query:', textAfterAt);
                  setShowMentionDropdown(true);
                  setMentionQuery(textAfterAt);
                  setMentionStartPos(lastAtIndex);
                  setSelectedMentionIndex(0);
                } else {
                  setShowMentionDropdown(false);
                }
              } else {
                setShowMentionDropdown(false);
              }
            }}
            onKeyDown={(e) => {
              if (showMentionDropdown && mentionFiles.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelectedMentionIndex(prev =>
                    prev < mentionFiles.length - 1 ? prev + 1 : prev
                  );
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelectedMentionIndex(prev => prev > 0 ? prev - 1 : 0);
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  const selectedFile = mentionFiles[selectedMentionIndex];
                  if (selectedFile) {
                    const before = input.substring(0, mentionStartPos);
                    const after = input.substring(textareaRef.current.selectionStart);
                    const newInput = before + selectedFile.path + ' ' + after;
                    setInput(newInput);
                    setShowMentionDropdown(false);
                    setTimeout(() => {
                      const newPos = (before + selectedFile.path + ' ').length;
                      textareaRef.current.setSelectionRange(newPos, newPos);
                      textareaRef.current.focus();
                    }, 0);
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setShowMentionDropdown(false);
                }
              } else if (e.key === 'Enter') {
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  handleSubmit(e);
                } else if (!e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }
            }}
            placeholder={getPlaceholder()}
            disabled={isLoading}
            rows={2}
          />

          <div className="input-actions">
            <div className="left-actions">
              {recognition && (
                <button
                  type="button"
                  onClick={toggleVoiceInput}
                  disabled={isLoading}
                  title={isRecording ? 'Stop recording' : 'Start voice input'}
                  className={`btn btn-sm ${isRecording ? 'btn-danger' : 'btn-outline-secondary'}`}
                >
                  {isRecording ? '🔴' : '🎤'}
                </button>
              )}
            </div>
            <button
              type="submit"
              className="btn-send"
              disabled={!input.trim() || isLoading}
            >
              <span className="material-symbols-outlined">
                {isLoading ? 'hourglass_empty' : 'send'}
              </span>
            </button>
          </div>
        </div>
        <div className="d-flex justify-content-between align-items-center mt-2">
          <small className="text-white">
            Currently in <strong>{mode}</strong> mode
            {input.length > 0 && ` • ${input.length} characters`}
            {showMentionDropdown && ` • @ mention active (${mentionFiles.length} files)`}
          </small>
          <small className="text-muted">
            {recognition && '🎤 Voice • '}
            @ files • ⌘↵ or Enter to send • ⇧↵ new line
          </small>
        </div>
      </form>
    </div>
  );
}
