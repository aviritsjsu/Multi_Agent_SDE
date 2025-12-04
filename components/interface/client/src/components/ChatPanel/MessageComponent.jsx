import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Button, Badge, ButtonGroup, Form } from "react-bootstrap";
import { useState, useEffect, useRef } from "react";
import remarkGfm from "remark-gfm";
import { toast } from "react-toastify";
import { useChat } from "../../ChatContext";

export function MessageComponent({ message, searchQuery }) {
  const { sendMessage, setMessages, messages, projectGcsPrefix, downloadProject } = useChat();
  const [copied, setCopied] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(message.content);
  const [rating, setRating] = useState(message.rating || null);
  const utteranceRef = useRef(null);
  const speechSynthRef = useRef(window.speechSynthesis);

  // Cleanup speech on unmount
  useEffect(() => {
    return () => {
      if (speechSynthRef.current) {
        speechSynthRef.current.cancel();
      }
    };
  }, []);

  const speakMessage = () => {
    if (!('speechSynthesis' in window)) {
      toast.error('❌ Text-to-speech not supported in this browser');
      return;
    }

    // If already speaking, pause/resume
    if (isSpeaking) {
      if (isPaused) {
        speechSynthRef.current.resume();
        setIsPaused(false);
      } else {
        speechSynthRef.current.pause();
        setIsPaused(true);
      }
      return;
    }

    // Stop any ongoing speech
    speechSynthRef.current.cancel();

    // Create new utterance
    const utterance = new SpeechSynthesisUtterance(message.content);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onstart = () => {
      setIsSpeaking(true);
      setIsPaused(false);
    };

    utterance.onend = () => {
      setIsSpeaking(false);
      setIsPaused(false);
    };

    utterance.onerror = (event) => {
      console.error('Speech synthesis error:', event);
      toast.error('❌ Speech synthesis error');
      setIsSpeaking(false);
      setIsPaused(false);
    };

    utteranceRef.current = utterance;
    speechSynthRef.current.speak(utterance);
  };

  const stopSpeaking = () => {
    speechSynthRef.current.cancel();
    setIsSpeaking(false);
    setIsPaused(false);
  };

  // Highlight search query in message
  const highlightText = (text) => {
    if (!searchQuery || !text) return text;

    const parts = text.split(new RegExp(`(${searchQuery})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === searchQuery.toLowerCase() ?
        <mark key={i} style={{ background: '#ffeb3b', color: '#000' }}>{part}</mark> : part
    );
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success('✅ Copied to clipboard');
  };

  const copyFullMessage = () => {
    copyToClipboard(message.content);
  };

  const handleEdit = () => {
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setEditedContent(message.content);
  };

  const saveEdit = () => {
    if (editedContent.trim() && editedContent !== message.content) {
      // Remove messages after this one
      const messageIndex = messages.findIndex(m => m.id === message.id);
      const updatedMessages = messages.slice(0, messageIndex);
      setMessages(updatedMessages);

      // Send the edited message
      sendMessage(editedContent.trim());
      setIsEditing(false);
      toast.success('✅ Message edited and resent');
    }
  };

  const handleRate = (newRating) => {
    setRating(newRating);
    message.rating = newRating; // Store rating in message
    toast.success(newRating === 'up' ? '👍 Thanks for the feedback!' : '👎 Thanks, we\'ll improve!');
  };

  const regenerateMessage = () => {
    // Find the user message before this assistant message
    const messageIndex = messages.findIndex(m => m.id === message.id);
    if (messageIndex > 0) {
      const previousUserMessage = messages.slice(0, messageIndex).reverse().find(m => m.role === 'user');
      if (previousUserMessage) {
        // Remove this and subsequent messages
        const updatedMessages = messages.slice(0, messageIndex);
        setMessages(updatedMessages);

        // Resend the previous user message
        sendMessage(previousUserMessage.content);
        toast.info('🔄 Regenerating response...');
      }
    }
  };

  // Relative time formatting
  const formatRelativeTime = (timestamp) => {
    if (!timestamp) return '';
    const now = new Date();
    const date = new Date(timestamp);
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const formatTimestamp = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getProviderBadgeColor = (provider) => {
    const colors = {
      openai: "success",
      anthropic: "primary",
      vertexai: "warning",
      ollama: "info",
      mock: "secondary",
    };
    return colors[provider] || "secondary";
  };

  return (
    <div className={`message ${message.role}`}>
      <div className="message-avatar">
        {message.role === "user" ? "👤" : "🤖"}
      </div>

      <div className="message-content">
        <div className="message-header">
          <div className="d-flex align-items-center">
            <span className="message-role me-2">
              {message.role === "user" ? "You" : "Immortal"}
            </span>
            {message.provider && message.role === "assistant" && (
              <Badge bg={getProviderBadgeColor(message.provider)} size="sm">
                {message.provider}
                {message.model && ` (${message.model.split("/").pop()})`}
              </Badge>
            )}
            {message.timestamp && (
              <span className="message-time ms-2" title={new Date(message.timestamp).toLocaleString()}>
                {formatRelativeTime(message.timestamp)}
              </span>
            )}
          </div>
        </div>

        {message.thinking && (
          <div className="thinking-process mb-2 p-2 bg-light rounded">
            <small className="text-muted">
              <em>💭 {message.thinking}</em>
            </small>
          </div>
        )}

        {/* Edit Mode */}
        {isEditing ? (
          <div className="mb-3">
            <Form.Control
              as="textarea"
              rows={4}
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              style={{ fontFamily: 'inherit', fontSize: '0.95em' }}
            />
            <ButtonGroup size="sm" className="mt-2">
              <Button variant="success" onClick={saveEdit}>✅ Send</Button>
              <Button variant="secondary" onClick={cancelEdit}>❌ Cancel</Button>
            </ButtonGroup>
          </div>
        ) : (
          <div className="message-text">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ node, inline, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || "");
                  const codeString = String(children).replace(/\n$/, "");

                  return !inline && match ? (
                    <div className="code-block-wrapper">
                      <div className="code-header">
                        <span className="language">{match[1]}</span>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => copyToClipboard(codeString)}
                          className="copy-btn"
                        >
                          {copied ? "✅ Copied" : "📋 Copy"}
                        </Button>
                      </div>
                      <SyntaxHighlighter
                        style={vscDarkPlus}
                        language={match[1]}
                        PreTag="div"
                        {...props}
                      >
                        {codeString}
                      </SyntaxHighlighter>
                    </div>
                  ) : (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                table({ children }) {
                  return (
                    <div className="table-responsive">
                      <table className="table table-striped table-sm">
                        {children}
                      </table>
                    </div>
                  );
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}

        {message.usage && message.role === "assistant" && (
          <div className="message-footer mt-2">
            <small className="text-muted">
              🔢 Tokens: {message.usage.total_tokens || 0}
              {message.processingTime && ` • ⏱️ ${message.processingTime}ms`}
            </small>
          </div>
        )}

        {/* Message Actions */}
        {!isEditing && (
          <div className="mt-2 d-flex flex-wrap gap-1">
            {/* Download Project Button (Always show for ADK messages) */}
            {message.role === "assistant" && (message.provider === 'ADK' || message.content.includes("Project created") || message.content.includes("saved output.py")) && (
              <Button
                variant={projectGcsPrefix ? "success" : "outline-secondary"}
                size="sm"
                disabled={!projectGcsPrefix}
                onClick={() => {
                  if (projectGcsPrefix) {
                    downloadProject(projectGcsPrefix);
                  } else {
                    toast.error("Project not ready for download yet");
                  }
                }}
                title={projectGcsPrefix ? "Download generated project" : "Project processing..."}
              >
                {projectGcsPrefix ? "📥 Download Project" : "⏳ Processing..."}
              </Button>
            )}

            {/* Copy Full Message */}
            <Button
              variant="outline-secondary"
              size="sm"
              onClick={copyFullMessage}
              title="Copy full message"
            >
              {copied ? '✅ Copied' : '📋 Copy'}
            </Button>

            {/* Edit & Resend (User messages only) */}
            {message.role === "user" && (
              <Button
                variant="outline-primary"
                size="sm"
                onClick={handleEdit}
                title="Edit and resend"
              >
                ✏️ Edit
              </Button>
            )}

            {/* Regenerate (Assistant messages only) */}
            {message.role === "assistant" && (
              <Button
                variant="outline-warning"
                size="sm"
                onClick={regenerateMessage}
                title="Regenerate response"
              >
                🔄 Regenerate
              </Button>
            )}

            {/* Text-to-Speech (Assistant messages only) */}
            {message.role === "assistant" && 'speechSynthesis' in window && (
              <>
                {!isSpeaking ? (
                  <Button
                    variant="outline-info"
                    size="sm"
                    onClick={speakMessage}
                    title="Read message aloud"
                  >
                    🔊 Listen
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline-warning"
                      size="sm"
                      onClick={speakMessage}
                      title={isPaused ? 'Resume' : 'Pause'}
                    >
                      {isPaused ? '▶️' : '⏸️'}
                    </Button>
                    <Button
                      variant="outline-danger"
                      size="sm"
                      onClick={stopSpeaking}
                      title="Stop"
                    >
                      ⏹️
                    </Button>
                  </>
                )}
              </>
            )}

            {/* Rate Response (Assistant messages only) */}
            {message.role === "assistant" && (
              <ButtonGroup size="sm">
                <Button
                  variant={rating === 'up' ? 'success' : 'outline-success'}
                  onClick={() => handleRate('up')}
                  title="Good response"
                >
                  👍
                </Button>
                <Button
                  variant={rating === 'down' ? 'danger' : 'outline-danger'}
                  onClick={() => handleRate('down')}
                  title="Bad response"
                >
                  👎
                </Button>
              </ButtonGroup>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
