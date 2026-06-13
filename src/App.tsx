import {
  Activity,
  Archive,
  ArrowDownToLine,
  Bell,
  Check,
  Cloud,
  Copy,
  FileArchive,
  FileImage,
  FileText,
  FolderInput,
  Gauge,
  GitBranch,
  HardDriveUpload,
  History,
  Link,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  UploadCloud,
  Zap,
} from "lucide-react";

type TransferItem = {
  name: string;
  size: string;
  expires: string;
  progress: number;
  status: "就绪" | "同步中" | "已完成";
  tone: "blue" | "green" | "amber";
  icon: "archive" | "image" | "text";
};

const transfers: TransferItem[] = [
  {
    name: "project-assets.zip",
    size: "428 MB",
    expires: "23 小时",
    progress: 72,
    status: "同步中",
    tone: "blue",
    icon: "archive",
  },
  {
    name: "screenshots-pack.png",
    size: "86 MB",
    expires: "2 天",
    progress: 100,
    status: "已完成",
    tone: "green",
    icon: "image",
  },
  {
    name: "handoff-notes.pdf",
    size: "14 MB",
    expires: "6 小时",
    progress: 38,
    status: "就绪",
    tone: "amber",
    icon: "text",
  },
];

const navItems = [
  { label: "中转", icon: FolderInput, active: true },
  { label: "记录", icon: History },
  { label: "存储", icon: Archive },
  { label: "设置", icon: Settings },
];

function TransferIcon({ type }: { type: TransferItem["icon"] }) {
  const icons = {
    archive: FileArchive,
    image: FileImage,
    text: FileText,
  };
  const Icon = icons[type];
  return <Icon aria-hidden="true" size={20} />;
}

export default function App() {
  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <div className="brand-mark">
            <Send aria-hidden="true" size={20} />
          </div>
          <div>
            <strong>文件中转站</strong>
            <span>File Relay</span>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={item.active ? "nav-item active" : "nav-item"}
                key={item.label}
                type="button"
                aria-pressed={item.active}
              >
                <Icon aria-hidden="true" size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="cloud-badge">
            <Cloud aria-hidden="true" size={18} />
            <span>Pages Ready</span>
          </div>
          <button className="icon-button" type="button" aria-label="代码仓库">
            <GitBranch aria-hidden="true" size={19} />
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Transfer Desk</p>
            <h1>文件中转站</h1>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search aria-hidden="true" size={18} />
              <input placeholder="搜索文件" type="search" />
            </label>
            <button className="icon-button" type="button" aria-label="通知">
              <Bell aria-hidden="true" size={19} />
            </button>
          </div>
        </header>

        <div className="content-grid">
          <section className="primary-column">
            <section className="upload-panel" aria-label="上传面板">
              <div className="upload-copy">
                <div className="panel-kicker">
                  <Zap aria-hidden="true" size={16} />
                  临时中转
                </div>
                <h2>拖入文件，生成一次性中转链接</h2>
                <div className="upload-actions">
                  <button className="primary-button" type="button">
                    <Plus aria-hidden="true" size={18} />
                    选择文件
                  </button>
                  <button className="ghost-button" type="button">
                    <Link aria-hidden="true" size={18} />
                    粘贴链接
                  </button>
                </div>
              </div>
              <div className="drop-zone" aria-label="文件投放区">
                <UploadCloud aria-hidden="true" size={34} />
                <span>Drop Zone</span>
              </div>
            </section>

            <section className="metrics-row" aria-label="状态概览">
              <Metric icon={HardDriveUpload} label="本周流量" value="18.6 GB" />
              <Metric icon={ShieldCheck} label="访问控制" value="Token" />
              <Metric icon={Gauge} label="平均速度" value="42 MB/s" />
            </section>

            <section className="transfer-section" aria-label="传输列表">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Queue</p>
                  <h2>当前中转</h2>
                </div>
                <button className="icon-button" type="button" aria-label="更多">
                  <MoreHorizontal aria-hidden="true" size={20} />
                </button>
              </div>

              <div className="transfer-list">
                {transfers.map((item) => (
                  <article className="transfer-card" key={item.name}>
                    <div className={`file-icon ${item.tone}`}>
                      <TransferIcon type={item.icon} />
                    </div>
                    <div className="file-main">
                      <div className="file-title-row">
                        <strong>{item.name}</strong>
                        <span className={`status-pill ${item.tone}`}>
                          {item.status}
                        </span>
                      </div>
                      <div className="file-meta">
                        <span>{item.size}</span>
                        <span>{item.expires}</span>
                      </div>
                      <div className="progress-track" aria-hidden="true">
                        <span style={{ width: `${item.progress}%` }} />
                      </div>
                    </div>
                    <button className="icon-button" type="button" aria-label="复制链接">
                      <Copy aria-hidden="true" size={18} />
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </section>

          <aside className="detail-panel" aria-label="分享详情">
            <div className="share-visual">
              <div className="route-node source">
                <ArrowDownToLine aria-hidden="true" size={18} />
              </div>
              <div className="route-line" />
              <div className="route-node target">
                <Share2 aria-hidden="true" size={18} />
              </div>
            </div>

            <div className="detail-block">
              <p className="eyebrow">Share Link</p>
              <h2>relay.fls/9K4D7</h2>
              <div className="token-row">
                <LockKeyhole aria-hidden="true" size={17} />
                <span>访问码 2048</span>
              </div>
            </div>

            <div className="detail-actions">
              <button className="primary-button wide" type="button">
                <Copy aria-hidden="true" size={18} />
                复制
              </button>
              <button className="ghost-button square" type="button" aria-label="完成">
                <Check aria-hidden="true" size={18} />
              </button>
            </div>

            <div className="timeline" aria-label="中转状态">
              <TimelineItem label="文件接收" time="00:12" done />
              <TimelineItem label="边缘同步" time="00:18" active />
              <TimelineItem label="链接待取" time="23:42" />
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
}) {
  return (
    <article className="metric-card">
      <Icon aria-hidden="true" size={20} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </article>
  );
}

function TimelineItem({
  label,
  time,
  done,
  active,
}: {
  label: string;
  time: string;
  done?: boolean;
  active?: boolean;
}) {
  return (
    <div className={active ? "timeline-item active" : "timeline-item"}>
      <span className={done ? "dot done" : "dot"} />
      <strong>{label}</strong>
      <time>{time}</time>
    </div>
  );
}
