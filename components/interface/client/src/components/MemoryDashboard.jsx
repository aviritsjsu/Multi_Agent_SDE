import { useState, useEffect } from 'react';
import { Card, Container, Row, Col, Table, Badge, Button, Form, Modal, Alert, Spinner, ButtonGroup, Tabs, Tab } from 'react-bootstrap';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { toast } from 'react-toastify';
import { useNavigate } from 'react-router';
import { apiFetch, buildApiUrl } from '../utils/apiClient';
// Safe date formatter - handles various date formats
const formatDate = (dateValue) => {
  if (!dateValue) return 'Just now';
  try {
    // Handle timestamp numbers
    if (typeof dateValue === 'number') {
      const date = new Date(dateValue);
      if (!isNaN(date.getTime())) return date.toLocaleString();
    }
    // Handle string dates
    if (typeof dateValue === 'string') {
      const date = new Date(dateValue);
      if (!isNaN(date.getTime())) return date.toLocaleString();
    }
    // Handle Date objects
    if (dateValue instanceof Date && !isNaN(dateValue.getTime())) {
      return dateValue.toLocaleString();
    }
    return 'Just now';
  } catch {
    return 'Just now';
  }
};

const MemoryDashboard = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [memories, setMemories] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedMemory, setSelectedMemory] = useState(null);
  const [selectedSessions, setSelectedSessions] = useState([]);
  const [analyticsData, setAnalyticsData] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedSession, setSelectedSession] = useState(null);
  const [sessionMessages, setSessionMessages] = useState([]);

  useEffect(() => {
    loadAllData();
  }, []);

  const loadAllData = async () => {
    setLoading(true);
    try {
      // Fetch stats
      const statsRes = await apiFetch('/api/memory/stats');
      const statsData = await statsRes.json();
      setStats(statsData);

      // Fetch sessions
      const sessionsRes = await apiFetch('/api/memory/sessions?limit=50');
      const sessionsData = await sessionsRes.json();
      setSessions(sessionsData.sessions || []);

      // Fetch memories for search - use semantic-search endpoint
      // Note: This will be populated when user searches
      setMemories([]);

      // Calculate analytics
      calculateAnalytics(sessionsData.sessions || []);
    } catch (err) {
      console.error('Failed to load data:', err);
      toast.error('❌ Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  const calculateAnalytics = (sessionsList) => {
    // Calculate usage over time (last 7 days)
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - i));
      return date.toLocaleDateString();
    });

    const usageByDay = last7Days.map(date => {
      const count = sessionsList.filter(s => {
        const sessionDate = new Date(s.createdAt).toLocaleDateString();
        return sessionDate === date;
      }).length;
      return { date: date.split('/').slice(0, 2).join('/'), sessions: count };
    });

    // Calculate memory size distribution
    const sizeDistribution = [
      { range: '0-1KB', count: memories.filter(m => (m.text?.length || 0) < 1024).length },
      { range: '1-10KB', count: memories.filter(m => (m.text?.length || 0) >= 1024 && (m.text?.length || 0) < 10240).length },
      { range: '10-100KB', count: memories.filter(m => (m.text?.length || 0) >= 10240 && (m.text?.length || 0) < 102400).length },
      { range: '>100KB', count: memories.filter(m => (m.text?.length || 0) >= 102400).length },
    ].filter(item => item.count > 0);

    setAnalyticsData({ usageByDay, sizeDistribution });
  };

  const semanticSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      const response = await apiFetch(`/api/memory/semantic-search?query=${encodeURIComponent(searchQuery)}&topK=10`);
      const data = await response.json();
      setSearchResults(data.memories || []);
      toast.success(`🔍 Found ${data.memories?.length || 0} results`);
    } catch (err) {
      console.error('Search failed:', err);
      toast.error('❌ Search failed');
    }
  };

  const deleteSession = async (sessionId) => {
    try {
      const response = await apiFetch(`/api/memory/sessions/${sessionId}`, { method: 'DELETE' });
      if (response.ok) {
        toast.success('✅ Session deleted');
        loadAllData();
      }
    } catch (err) {
      console.error('Delete failed:', err);
      toast.error('❌ Failed to delete session');
    }
  };

  const bulkDeleteSessions = async () => {
    try {
      await Promise.all(selectedSessions.map(id =>
        apiFetch(`/api/memory/sessions/${id}`, { method: 'DELETE' })
      ));
      toast.success(`✅ Deleted ${selectedSessions.length} sessions`);
      setSelectedSessions([]);
      loadAllData();
    } catch (err) {
      console.error('Bulk delete failed:', err);
      toast.error('❌ Bulk delete failed');
    }
  };

  const viewSessionDetails = async (sessionId) => {
    try {
      setShowDetailsModal(true);
      setSessionMessages([]); // Clear previous messages

      // Fetch session details
      const sessionRes = await apiFetch(`/api/memory/export/${sessionId}`);
      const sessionData = await sessionRes.json();

      setSelectedSession(sessionData.session);
      setSessionMessages(sessionData.messages || []);
    } catch (err) {
      console.error('Failed to load session details:', err);
      toast.error('❌ Failed to load session details');
    }
  };

  const optimizeMemories = async (action) => {
    try {
      if (action === 'compress') {
        // Archive old sessions (>30 days)
        const oldSessions = sessions.filter(s => {
          const age = Date.now() - new Date(s.createdAt).getTime();
          return age > 30 * 24 * 60 * 60 * 1000;
        });
        await Promise.all(oldSessions.map(s => deleteSession(s.id)));
        toast.success(`🗃️ Archived ${oldSessions.length} old sessions`);
      } else if (action === 'cleanup') {
        // Delete sessions with no messages
        const emptySessions = sessions.filter(s => s.messageCount === 0);
        await Promise.all(emptySessions.map(s => deleteSession(s.id)));
        toast.success(`🧺 Cleaned up ${emptySessions.length} empty sessions`);
      }
      loadAllData();
    } catch (err) {
      console.error('Optimization failed:', err);
      toast.error('❌ Optimization failed');
    }
  };

  const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042'];

  if (loading) {
    return (
      <Container className="mt-4 text-center">
        <Spinner animation="border" variant="primary" />
        <p className="mt-3">Loading dashboard...</p>
      </Container>
    );
  }

  return (
    <Container className="mt-4" style={{ maxWidth: '1400px' }}>
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div className="d-flex align-items-center gap-2">
          <h2 className="mb-0">📊 Memory Dashboard</h2>
        </div>
        <div className="d-flex gap-2">
          <ButtonGroup>
            <Button variant="outline-secondary" size="sm" onClick={() => navigate('/')}>
              ⬅️ Chat
            </Button>
            <Button variant="outline-primary" size="sm" onClick={() => navigate('/multi-agent')}>
              🎭 Multi-Agent
            </Button>
          </ButtonGroup>
          <ButtonGroup>
            <Button variant="outline-danger" size="sm" onClick={() => optimizeMemories('cleanup')}>
              🧺 Clean Empty
            </Button>
            <Button variant="outline-warning" size="sm" onClick={() => optimizeMemories('compress')}>
              🗃️ Archive Old
            </Button>
            <Button variant="outline-info" size="sm" onClick={loadAllData}>
              🔄 Refresh
            </Button>
          </ButtonGroup>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <Row className="mb-4">
          <Col md={3}>
            <Card className="text-center">
              <Card.Body>
                <h3>{stats.summary?.totalMessages || 0}</h3>
                <p className="text-muted mb-0">💬 Messages</p>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="text-center">
              <Card.Body>
                <h3>{stats.summary?.totalSessions || 0}</h3>
                <p className="text-muted mb-0">📊 Sessions</p>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="text-center">
              <Card.Body>
                <h3>{stats.summary?.totalToolRuns || 0}</h3>
                <p className="text-muted mb-0">🔧 Tool Runs</p>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="text-center">
              <Card.Body>
                <h3>{memories.length}</h3>
                <p className="text-muted mb-0">🧠 Memories</p>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      )}

      {/* Tabbed Interface */}
      <Tabs activeKey={activeTab} onSelect={(k) => setActiveTab(k)} className="mb-3">
        {/* Overview Tab */}
        <Tab eventKey="overview" title="🏠 Overview">
          {selectedSessions.length > 0 && (
            <Alert variant="info" className="d-flex justify-content-between align-items-center">
              <span>{selectedSessions.length} session(s) selected</span>
              <Button variant="danger" size="sm" onClick={bulkDeleteSessions}>
                🗑️ Delete Selected
              </Button>
            </Alert>
          )}

          <Table striped bordered hover responsive>
            <thead>
              <tr>
                <th>
                  <Form.Check
                    type="checkbox"
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedSessions(sessions.map(s => s.id));
                      } else {
                        setSelectedSessions([]);
                      }
                    }}
                  />
                </th>
                <th>Session ID</th>
                <th>Messages</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr>
                  <td colSpan="5" className="text-center text-muted">
                    No sessions found
                  </td>
                </tr>
              ) : (
                sessions.map(s => (
                  <tr key={s.id}>
                    <td>
                      <Form.Check
                        type="checkbox"
                        checked={selectedSessions.includes(s.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedSessions([...selectedSessions, s.id]);
                          } else {
                            setSelectedSessions(selectedSessions.filter(id => id !== s.id));
                          }
                        }}
                      />
                    </td>
                    <td><code style={{ fontSize: '0.85em' }}>{s.id.substring(0, 8)}...</code></td>
                    <td><Badge bg="primary">{s.messageCount || 0}</Badge></td>
                    <td><small>{formatDate(s.createdAt || s.created_at || s.timestamp)}</small></td>
                    <td>
                      <ButtonGroup size="sm">
                        <Button
                          variant="outline-info"
                          onClick={() => viewSessionDetails(s.id)}
                        >
                          👁️ View
                        </Button>
                        <Button
                          variant="outline-primary"
                          href={buildApiUrl(`/api/memory/export/${s.id}/file?format=json`)}
                          download
                        >
                          📥 JSON
                        </Button>
                        <Button
                          variant="outline-secondary"
                          href={buildApiUrl(`/api/memory/export/${s.id}/file?format=txt`)}
                          download
                        >
                          📄 TXT
                        </Button>
                        <Button
                          variant="outline-danger"
                          onClick={() => deleteSession(s.id)}
                        >
                          🗑️
                        </Button>
                      </ButtonGroup>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Tab>

        {/* Analytics Tab */}
        <Tab eventKey="analytics" title="📊 Analytics">
          {analyticsData && (
            <>
              <Row className="mb-4">
                <Col md={8}>
                  <Card>
                    <Card.Header>📊 Session Usage Trend (Last 7 Days)</Card.Header>
                    <Card.Body>
                      <ResponsiveContainer width="100%" height={300}>
                        <LineChart data={analyticsData.usageByDay}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="date" />
                          <YAxis />
                          <Tooltip />
                          <Legend />
                          <Line type="monotone" dataKey="sessions" stroke="#8884d8" strokeWidth={2} />
                        </LineChart>
                      </ResponsiveContainer>
                    </Card.Body>
                  </Card>
                </Col>
                <Col md={4}>
                  <Card>
                    <Card.Header>📊 Memory Size Distribution</Card.Header>
                    <Card.Body>
                      <ResponsiveContainer width="100%" height={300}>
                        <PieChart>
                          <Pie
                            data={analyticsData.sizeDistribution}
                            dataKey="count"
                            nameKey="range"
                            cx="50%"
                            cy="50%"
                            outerRadius={80}
                            label
                          >
                            {analyticsData.sizeDistribution.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    </Card.Body>
                  </Card>
                </Col>
              </Row>
            </>
          )}
        </Tab>

        {/* Search Tab */}
        <Tab eventKey="search" title="� Semantic Search">
          <Card>
            <Card.Body>
              <Form.Group className="mb-3">
                <Form.Label><strong>🔍 Search Memories</strong></Form.Label>
                <div className="input-group">
                  <Form.Control
                    type="text"
                    placeholder="Search by meaning, not just keywords..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && semanticSearch()}
                  />
                  <Button variant="primary" onClick={semanticSearch}>
                    🔍 Search
                  </Button>
                </div>
                <Form.Text className="text-muted">
                  AI-powered semantic search finds memories by meaning, not just exact matches
                </Form.Text>
              </Form.Group>

              {searchResults.length > 0 && (
                <div>
                  <h6>🎯 Found {searchResults.length} results:</h6>
                  {searchResults.map((memory, idx) => (
                    <Card key={idx} className="mb-2">
                      <Card.Body>
                        <p className="mb-1">{memory.text}</p>
                        {memory.meta && (
                          <small className="text-muted">
                            {Object.entries(memory.meta).map(([k, v]) => `${k}: ${v}`).join(' | ')}
                          </small>
                        )}
                      </Card.Body>
                    </Card>
                  ))}
                </div>
              )}
            </Card.Body>
          </Card>
        </Tab>

        {/* Optimization Tab */}
        <Tab eventKey="optimize" title="⚙️ Optimization">
          <Row>
            <Col md={6}>
              <Card className="mb-3">
                <Card.Header>🧺 Cleanup Tools</Card.Header>
                <Card.Body>
                  <p>Remove unnecessary data to improve performance</p>
                  <Button
                    variant="warning"
                    className="w-100 mb-2"
                    onClick={() => optimizeMemories('cleanup')}
                  >
                    🧺 Clean Empty Sessions
                  </Button>
                  <small className="text-muted">Removes sessions with no messages</small>
                </Card.Body>
              </Card>
            </Col>
            <Col md={6}>
              <Card className="mb-3">
                <Card.Header>🗃️ Archive Tools</Card.Header>
                <Card.Body>
                  <p>Archive old data to reduce database size</p>
                  <Button
                    variant="info"
                    className="w-100 mb-2"
                    onClick={() => optimizeMemories('compress')}
                  >
                    🗃️ Archive Old Sessions (&gt;30 days)
                  </Button>
                  <small className="text-muted">Moves old sessions to archive</small>
                </Card.Body>
              </Card>
            </Col>
          </Row>

          <Card>
            <Card.Header>� Storage Recommendations</Card.Header>
            <Card.Body>
              <ul>
                <li>Total sessions: <strong>{sessions.length}</strong></li>
                <li>Empty sessions: <strong>{sessions.filter(s => s.messageCount === 0).length}</strong></li>
                <li>Old sessions (&gt;30 days): <strong>
                  {sessions.filter(s => {
                    const age = Date.now() - new Date(s.createdAt).getTime();
                    return age > 30 * 24 * 60 * 60 * 1000;
                  }).length}
                </strong></li>
                <li>Potential cleanup savings: <strong>
                  {sessions.filter(s => s.messageCount === 0).length +
                    sessions.filter(s => {
                      const age = Date.now() - new Date(s.createdAt).getTime();
                      return age > 30 * 24 * 60 * 60 * 1000;
                    }).length} sessions
                </strong></li>
              </ul>
            </Card.Body>
          </Card>
        </Tab>
      </Tabs>

      {/* Session Details Modal */}
      <Modal show={showDetailsModal} onHide={() => setShowDetailsModal(false)} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>
            📊 Session Details
            {selectedSession && (
              <small className="text-muted ms-2">
                {selectedSession.id?.substring(0, 12)}...
              </small>
            )}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {selectedSession && (
            <div className="mb-3">
              <p><strong>Created:</strong> {formatDate(selectedSession.createdAt || selectedSession.created_at)}</p>
              <p><strong>Messages:</strong> {sessionMessages.length}</p>
              {selectedSession.summary && (
                <p><strong>Summary:</strong> {selectedSession.summary}</p>
              )}
            </div>
          )}

          <h6>Messages:</h6>
          {sessionMessages.length === 0 ? (
            <Alert variant="info">No messages in this session</Alert>
          ) : (
            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {sessionMessages.map((msg, idx) => (
                <Card key={idx} className="mb-2">
                  <Card.Body>
                    <div className="d-flex justify-content-between align-items-start mb-2">
                      <Badge bg={msg.role === 'user' ? 'primary' : 'success'}>
                        {msg.role === 'user' ? '👤 User' : '🤖 Assistant'}
                      </Badge>
                      <small className="text-muted">
                        {formatDate(msg.created_at || msg.timestamp)}
                      </small>
                    </div>
                    <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                      {msg.content}
                    </p>
                  </Card.Body>
                </Card>
              ))}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowDetailsModal(false)}>
            Close
          </Button>
        </Modal.Footer>
      </Modal>
    </Container>
  );
};

export default MemoryDashboard;