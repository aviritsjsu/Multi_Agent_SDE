import Button from "react-bootstrap/Button";
import { useChat } from "../../ChatContext";
import { useState } from "react";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import { apiFetch } from "../../utils/apiClient";
import { Spinner } from "react-bootstrap";
import "./IdePlaceholder.scss";

export function IdePlaceholder({ onLaunch }) {
  const { projectGcsPrefix } = useChat();
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (!projectGcsPrefix) return;
    setDownloading(true);
    try {
      // 1. Get file list
      const res = await apiFetch(`/api/projects/files?prefix=${encodeURIComponent(projectGcsPrefix)}`);
      if (!res.ok) throw new Error(`Failed to fetch file list: ${res.statusText}`);
      const { files } = await res.json();

      if (!files || files.length === 0) {
        throw new Error("No files found in project");
      }

      // 2. Download all files
      const zip = new JSZip();
      // Use the project name from prefix or default
      const folderName = projectGcsPrefix.split('/').pop() || 'project';

      // Add files to zip
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

      // 3. Generate zip
      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `${folderName}.zip`);

    } catch (err) {
      console.error("Download failed:", err);
      alert("Failed to download project: " + err.message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="vscode-placeholder" id="vscode-placeholder" style={{ width: '100%', height: '100%', flex: 1 }}>
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"></path>
      </svg>

      <h3>VS Code Environment</h3>

      <div
        style={{
          marginTop: "20px",
          display: "flex",
          gap: "10px",
          justifyContent: "center",
          flexWrap: "wrap"
        }}
      >
        <Button onClick={() => onLaunch()} variant="primary" className="ide-button">
          Load VS Code here
        </Button>

        <Button
          as="a"
          href={import.meta.env.VITE_WORKSPACE_URL || "https://workspace-835319451022.us-central1.run.app"}
          target="_blank"
          variant="primary"
          className="ide-button"
        >
          Open VS Code in New Tab
        </Button>

        {projectGcsPrefix && (
          <Button
            onClick={handleDownload}
            variant="success"
            className="ide-button"
            disabled={downloading}
          >
            {downloading ? (
              <>
                <Spinner
                  as="span"
                  animation="border"
                  size="sm"
                  role="status"
                  aria-hidden="true"
                  className="me-2"
                />
                Zipping...
              </>
            ) : (
              <>
                📥 Download Project
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
