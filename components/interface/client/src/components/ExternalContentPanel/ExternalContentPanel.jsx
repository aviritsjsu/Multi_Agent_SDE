import { IdePlaceholder } from "./IdePlaceholder";
import { useTabs } from "../../TabContext";
import { useChat } from "../../ChatContext";
import "./ExternalContentPanel.scss";
import { ExternalTabs } from "./ExternalTabs";
import { useRef, useState, useEffect } from "react";
import { Card, Button, ButtonGroup, Dropdown, Spinner } from "react-bootstrap";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { toast } from "react-toastify";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import { apiFetch } from "../../utils/apiClient";

export function ExternalContentPanel() {
  const { tabs, setActiveTab, activeTab, addTab, removeTab } = useTabs();
  const { projectGcsPrefix, currentUser } = useChat();
  console.log("Configured Workspace URL:", import.meta.env.VITE_WORKSPACE_URL);
  const iframeRef = useRef();
  const [viewMode, setViewMode] = useState('iframe'); // 'iframe' or 'code'
  const [fileContent, setFileContent] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [projects, setProjects] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);

  // Detect language from URL
  const detectLanguage = (url) => {
    if (!url) return 'text';
    const ext = url.split('.').pop()?.toLowerCase();
    const langMap = {
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'go': 'go',
      'rs': 'rust',
      'rb': 'ruby',
      'php': 'php',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'sh': 'bash',
      'sql': 'sql',
    };
    return langMap[ext] || 'text';
  };

  // Load file content for code view
  useEffect(() => {
    const loadFileContent = async () => {
      if (viewMode === 'code' && activeTab) {
        setLoading(true);
        try {
          // Try to fetch as text
          const response = await fetch(activeTab);
          const text = await response.text();
          setFileContent(text);
          setLanguage(detectLanguage(activeTab));
        } catch (err) {
          console.error('Failed to load file:', err);
          toast.error('❌ Failed to load file for preview');
          setViewMode('iframe');
        } finally {
          setLoading(false);
        }
      }
    };

    loadFileContent();
  }, [viewMode, activeTab]);

  const copyCode = () => {
    navigator.clipboard.writeText(fileContent);
    toast.success('✅ Code copied to clipboard');
  };

  // Fetch projects on mount and when user changes
  useEffect(() => {
    const fetchProjects = async () => {
      if (!currentUser) return;

      setLoadingProjects(true);
      try {
        const res = await apiFetch(`/api/projects/list?userId=${currentUser.uid}`);
        const data = await res.json();
        setProjects(data.projects || []);
      } catch (err) {
        console.error('Failed to fetch projects:', err);
      } finally {
        setLoadingProjects(false);
      }
    };

    fetchProjects();

    // Refresh projects every 30 seconds
    const interval = setInterval(fetchProjects, 30000);
    return () => clearInterval(interval);
  }, [currentUser]);

  // Also refresh when projectGcsPrefix changes (new project created)
  useEffect(() => {
    if (projectGcsPrefix && currentUser) {
      // Add small delay to allow GCS to finish writing
      const timeout = setTimeout(async () => {
        try {
          const res = await apiFetch(`/api/projects/list?userId=${currentUser.uid}`);
          const data = await res.json();
          setProjects(data.projects || []);
        } catch (err) {
          console.error('Failed to refresh projects:', err);
        }
      }, 2000);
      return () => clearTimeout(timeout);
    }
  }, [projectGcsPrefix, currentUser]);

  const handleDownloadProject = async (projectPrefix) => {
    if (!projectPrefix) return;
    setDownloading(true);
    try {
      const res = await apiFetch(`/api/projects/files?prefix=${encodeURIComponent(projectPrefix)}`);
      if (!res.ok) throw new Error(`Failed to fetch file list: ${res.statusText}`);
      const { files } = await res.json();

      if (!files || files.length === 0) {
        throw new Error("No files found in project");
      }

      const zip = new JSZip();
      const folderName = projectPrefix.split('/').filter(Boolean).pop() || 'project';

      await Promise.all(files.map(async (file) => {
        try {
          const fileRes = await fetch(file.url);
          if (!fileRes.ok) throw new Error(`Failed to fetch ${file.name}`);
          const blob = await fileRes.blob();
          zip.file(file.name, blob);
        } catch (e) {
          console.error(`Failed to download file ${file.name}:`, e);
        }
      }));

      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `${folderName}.zip`);
      toast.success('✅ Project downloaded successfully');
    } catch (err) {
      console.error("Download failed:", err);
      toast.error('❌ Failed to download project: ' + err.message);
    } finally {
      setDownloading(false);
    }
  };

  // Auto-correct localhost workspace URLs to production
  useEffect(() => {
    const WORKSPACE_URL = import.meta.env.VITE_WORKSPACE_URL || "https://workspace-835319451022.us-central1.run.app";
    if (activeTab && activeTab.includes("localhost") && activeTab.includes("8085")) {
      console.log("Auto-correcting localhost Workspace URL to:", WORKSPACE_URL);
      // We can't easily update the tab URL in place without modifying the context, 
      // but we can force the iframe src to use the correct URL for this render.
      if (iframeRef.current) {
        iframeRef.current.src = WORKSPACE_URL;
      }
    }
  }, [activeTab]);

  return (
    <div className="external-content-panel" style={{ width: '100%', height: '100%', overflow: 'hidden', margin: 0, padding: 0 }}>
      <div className="ecp-header" style={{ padding: '0.5rem 0.75rem' }}>
        <div className="d-flex justify-content-between align-items-center mb-2">
          <ExternalTabs
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            tabs={tabs}
            onTabRemoval={removeTab}
            onRefreshClick={() => {
              if (viewMode === 'iframe' && iframeRef.current) {
                const WORKSPACE_URL = import.meta.env.VITE_WORKSPACE_URL || "https://workspace-835319451022.us-central1.run.app";
                // If it's the workspace, force the correct URL on refresh
                if (activeTab.includes("8085") || activeTab.includes("workspace")) {
                  iframeRef.current.src = WORKSPACE_URL;
                } else {
                  const url = new URL(iframeRef.current.src);
                  url.searchParams.set("t", Date.now());
                  iframeRef.current.src = url.toString();
                }
              }
            }}
          />
          {projects.length > 0 && (
            <ButtonGroup className="ms-2">
              <Dropdown>
                <Dropdown.Toggle
                  variant="success"
                  size="sm"
                  disabled={downloading || loadingProjects}
                >
                  {downloading ? (
                    <>
                      <Spinner
                        as="span"
                        animation="border"
                        size="sm"
                        role="status"
                        aria-hidden="true"
                        className="me-1"
                      />
                      Downloading...
                    </>
                  ) : (
                    <>📥 Download Project{projects.length > 1 ? ` (${projects.length})` : ''}</>
                  )}
                </Dropdown.Toggle>
                <Dropdown.Menu>
                  {projects.map((project, idx) => (
                    <Dropdown.Item
                      key={idx}
                      onClick={() => handleDownloadProject(project.prefix)}
                    >
                      <div>
                        <div><strong>{project.projectId}</strong></div>
                        <small className="text-muted">
                          {new Date(project.createdAt).toLocaleString()} • {project.fileCount} files
                        </small>
                      </div>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown>
            </ButtonGroup>
          )}
        </div>
      </div>
      {activeTab ? (
        viewMode === 'iframe' ? (
          <iframe
            ref={iframeRef}
            style={{
              flex: 1,
              width: '100%',
              height: '100%',
              border: 'none',
              margin: 0,
              padding: 0,
              display: 'block'
            }}
            src={activeTab.includes("localhost") && activeTab.includes("8085") ? "https://workspace-835319451022.us-central1.run.app" : activeTab}
            allow="clipboard-read; clipboard-write; cross-origin-isolated; local-fonts"
          />
        ) : (
          <div style={{ flex: 1, overflow: 'auto', background: '#1e1e1e', padding: '0' }}>
            {loading ? (
              <div className="d-flex justify-content-center align-items-center h-100">
                <Spinner animation="border" variant="light" />
              </div>
            ) : (
              <Card style={{ margin: 0, background: 'transparent', border: 'none' }}>
                <Card.Header style={{ background: '#2d2d30', border: 'none', color: 'white' }}>
                  <div className="d-flex justify-content-between align-items-center">
                    <div>
                      <span className="me-2">📄</span>
                      <strong>{activeTab.split('/').pop()}</strong>
                      <span className="ms-2 badge bg-secondary">{language}</span>
                    </div>
                    <ButtonGroup size="sm">
                      <Button variant="outline-light" onClick={copyCode}>
                        📋 Copy
                      </Button>
                    </ButtonGroup>
                  </div>
                </Card.Header>
                <Card.Body style={{ padding: 0 }}>
                  <SyntaxHighlighter
                    language={language}
                    style={vscDarkPlus}
                    showLineNumbers={true}
                    wrapLines={true}
                    lineNumberStyle={{ minWidth: '3em', paddingRight: '1em', userSelect: 'none', opacity: 0.5 }}
                    customStyle={{
                      margin: 0,
                      padding: '1em',
                      fontSize: '0.9em',
                      background: '#1e1e1e',
                    }}
                  >
                    {fileContent || '// No content'}
                  </SyntaxHighlighter>
                </Card.Body>
              </Card>
            )}
          </div>
        )
      ) : (
        <IdePlaceholder
          onLaunch={() => addTab(import.meta.env.VITE_WORKSPACE_URL || "https://workspace-835319451022.us-central1.run.app", "Workspace")}
        />
      )}
    </div>
  );
}
