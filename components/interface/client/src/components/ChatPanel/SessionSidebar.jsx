import { useState } from 'react';
import { Offcanvas, ListGroup, Button, Badge, Form, ButtonGroup } from 'react-bootstrap';
import { useChat } from '../../ChatContext';

// Helper to safely format dates
const formatDate = (dateStr) => {
  if (!dateStr) return 'Just now';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return 'Just now';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

// Generate a display name from session
const getSessionDisplayName = (session) => {
  // If already has a proper name, use it
  if (session.name && session.name !== 'New Chat') {
    return session.name;
  }
  
  // Try to get name from first user message
  const firstUserMsg = session.messages?.find(m => m.role === 'user');
  if (firstUserMsg?.content) {
    const content = firstUserMsg.content;
    // Truncate and clean up
    let title = content
      .replace(/^(hi|hello|hey|please|can you|could you|i want to|i need to)\s*/i, '')
      .replace(/[.!?]+$/, '')
      .trim();
    
    if (title.length > 40) {
      title = title.substring(0, 37) + '...';
    }
    
    return title.charAt(0).toUpperCase() + title.slice(1) || 'New Chat';
  }
  
  return 'New Chat';
};

export function SessionSidebar({ show, onHide }) {
  const { sessions, loadSession, deleteSession, renameSession, currentSessionId } = useChat();
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const handleRename = (sessionId) => {
    if (editName.trim()) {
      renameSession(sessionId, editName.trim());
      setEditingId(null);
      setEditName('');
    }
  };

  const startEdit = (session) => {
    setEditingId(session.id);
    setEditName(getSessionDisplayName(session));
  };

  return (
    <Offcanvas show={show} onHide={onHide} placement="start" style={{ 
      width: '350px',
      background: 'linear-gradient(180deg, rgba(30, 27, 75, 0.98) 0%, rgba(49, 46, 129, 0.98) 100%)',
      backdropFilter: 'blur(20px)',
    }}>
      <Offcanvas.Header closeButton style={{ 
        background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.2) 0%, rgba(139, 92, 246, 0.2) 100%)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
      }}>
        <Offcanvas.Title style={{ 
          fontWeight: 700, 
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}>
          📚 Chat Sessions
        </Offcanvas.Title>
      </Offcanvas.Header>
      <Offcanvas.Body style={{ padding: 0, background: 'transparent' }}>
        {sessions.length === 0 ? (
          <div className="p-4 text-center" style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem', opacity: 0.5 }}>💭</div>
            <p style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.8)' }}>No saved sessions yet</p>
            <small>Start chatting to create your first session!</small>
          </div>
        ) : (
          <ListGroup variant="flush">
            {sessions.map((session) => (
              <ListGroup.Item
                key={session.id}
                active={session.id === currentSessionId}
                className="d-flex flex-column"
                style={{ 
                  cursor: 'pointer', 
                  borderLeft: session.id === currentSessionId ? '3px solid #8b5cf6' : '3px solid transparent',
                  background: session.id === currentSessionId 
                    ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.2) 0%, rgba(139, 92, 246, 0.2) 100%)' 
                    : 'rgba(255, 255, 255, 0.02)',
                  border: 'none',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                  color: 'white',
                  transition: 'all 0.2s ease',
                }}
              >
                {editingId === session.id ? (
                  <Form.Group className="mb-2">
                    <Form.Control
                      type="text"
                      size="sm"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleRename(session.id)}
                      autoFocus
                    />
                    <ButtonGroup size="sm" className="mt-2 w-100">
                      <Button variant="success" onClick={() => handleRename(session.id)}>✅ Save</Button>
                      <Button variant="secondary" onClick={() => setEditingId(null)}>❌ Cancel</Button>
                    </ButtonGroup>
                  </Form.Group>
                ) : (
                  <div onClick={() => loadSession(session)}>
                    <div className="d-flex justify-content-between align-items-start mb-1">
                      <strong style={{ fontSize: '0.95em' }}>{getSessionDisplayName(session)}</strong>
                      <Badge bg="info" style={{ fontSize: '0.7em' }}>
                        {session.messages?.length || 0} msgs
                      </Badge>
                    </div>
                    <div className="d-flex justify-content-between align-items-center">
                      <small className="text-muted" style={{ fontSize: '0.75em' }}>
                        {formatDate(session.updatedAt || session.createdAt)}
                      </small>
                      <Badge bg="secondary" style={{ fontSize: '0.7em' }}>{session.mode}</Badge>
                    </div>
                  </div>
                )}
                
                {editingId !== session.id && (
                  <ButtonGroup size="sm" className="mt-2">
                    <Button
                      variant="outline-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(session);
                      }}
                      title="Rename"
                    >
                      ✏️
                    </Button>
                    <Button
                      variant="outline-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete "${getSessionDisplayName(session)}"?`)) {
                          deleteSession(session.id);
                        }
                      }}
                      title="Delete"
                    >
                      🗑️
                    </Button>
                  </ButtonGroup>
                )}
              </ListGroup.Item>
            ))}
          </ListGroup>
        )}
      </Offcanvas.Body>
    </Offcanvas>
  );
}