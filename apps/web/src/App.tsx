import { healthResponseSchema } from '@weave/contracts';
import { useEffect, useState } from 'react';

type ConnectionStatus = 'checking' | 'connected' | 'unavailable';

const connectionLabels: Record<ConnectionStatus, string> = {
  checking: '正在连接接口服务',
  connected: '接口服务已连接',
  unavailable: '接口服务不可用',
};

export function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('checking');

  useEffect(() => {
    const controller = new AbortController();

    async function checkConnection() {
      try {
        const response = await fetch('/api/health', {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Health request failed: ${response.status}`);
        }

        healthResponseSchema.parse(await response.json());

        if (!controller.signal.aborted) {
          setConnectionStatus('connected');
        }
      } catch {
        if (!controller.signal.aborted) {
          setConnectionStatus('unavailable');
        }
      }
    }

    void checkConnection();

    return () => controller.abort();
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="项目导航">
        <a className="brand" href="/" aria-label="Weave 首页">
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          Weave
        </a>
        <p className="section-label">工作空间</p>
        <p className="sidebar-empty">尚未接入工作空间</p>
        <nav className="navigation" aria-label="项目功能">
          <button type="button" disabled>
            项目
          </button>
          <button type="button" disabled>
            文档
          </button>
          <button type="button" disabled>
            任务
          </button>
          <button type="button" disabled>
            对话
          </button>
        </nav>
        <span className="stage-label">基础框架</span>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <span>内容工作区</span>
          <span
            className="connection-status"
            data-status={connectionStatus}
            role="status"
          >
            <span className="status-dot" aria-hidden="true" />
            {connectionLabels[connectionStatus]}
          </span>
        </header>
        <section className="workspace-content" aria-labelledby="welcome-title">
          <p className="eyebrow">从讨论到行动</p>
          <h1 id="welcome-title">让想法成为可追踪的工作。</h1>
          <p className="intro">
            在对话中澄清需求，让文档与任务保持关联，每次修改都有来源。
          </p>
          <div className="empty-state">
            <span className="empty-symbol" aria-hidden="true">
              +
            </span>
            <h2>这里还没有项目内容</h2>
            <p>当前只提供界面骨架。项目、文档与任务尚未接入。</p>
            <button type="button" className="primary-button" disabled>
              创建项目 · 尚未开放
            </button>
          </div>
          <section className="history-note" aria-labelledby="history-title">
            <h2 id="history-title">每次变更，都有记录</h2>
            <p>
              文档与任务将提供差异、发起人、确认人和来源对话。变更历史功能尚未实现。
            </p>
          </section>
        </section>
      </main>

      <aside className="conversation" aria-labelledby="conversation-title">
        <header className="conversation-header">
          <h2 id="conversation-title">AI 对话</h2>
          <span className="pending-label">尚未接入</span>
        </header>
        <div className="conversation-content">
          <h3>从一个想法开始</h3>
          <p>后续可以在这里讨论需求、生成文档和提出修改。</p>
          <p className="confirmation-note">
            AI 生成的修改会先展示提案，经你确认后才写入正式内容。
          </p>
        </div>
        <div className="composer">
          <label htmlFor="message">向 AI 描述你的需求</label>
          <textarea
            id="message"
            placeholder="对话功能尚未接入"
            rows={3}
            disabled
          />
          <button type="button" disabled>
            发送
          </button>
        </div>
      </aside>
    </div>
  );
}
