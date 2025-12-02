import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { ToastContainer } from "react-toastify";
import { ChatPanel } from "./components/ChatPanel/ChatPanel";
import { ExternalContentPanel } from "./components/ExternalContentPanel/ExternalContentPanel";

export default function AppRoute() {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', overflow: 'hidden' }}>
      <PanelGroup direction="horizontal" autoSaveId="persistence" style={{ width: '100%', height: '100%', flex: 1, overflow: 'hidden' }}>
        <Panel defaultSize={40} minSize={20} className="resizable-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <ChatPanel />
        </Panel>
        <PanelResizeHandle className="panel-resize-handle">
          <svg viewBox="0 0 24 24" data-direction="horizontal">
            <path
              fill="currentColor"
              d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2m-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2m0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2m6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2m0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2m0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2"
            ></path>
          </svg>
        </PanelResizeHandle>
        <Panel
          defaultSize={60}
          minSize={30}
          className="resizable-panel"
          style={{ display: 'flex', height: '100%', overflow: 'hidden' }}
        >
          <ExternalContentPanel />
        </Panel>
      </PanelGroup>
      <ToastContainer position="bottom-right" theme="dark" />
    </div>
  );
}
