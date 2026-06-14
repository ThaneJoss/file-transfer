import {
  Check,
  Circle,
  Clock,
  Cloud,
  Database,
  Download,
  FileText,
  Gauge,
  HardDrive,
  Hourglass,
  Laptop,
  Link,
  Link2,
  List,
  MapPin,
  Monitor,
  MoreHorizontal,
  Plus,
  Server,
  UploadCloud,
  Wifi,
} from "lucide-react";

type FileItem = {
  name: string;
  type: "doc" | "pdf" | "sheet";
  size: string;
  uploadedAt: string;
  expires: string;
};

type Device = {
  name: string;
  ip: string;
  icon: typeof Monitor;
  selected?: boolean;
};

type DetailItem = {
  label: string;
  value: string;
  icon: typeof Link2;
  status?: "online";
  progress?: number;
};

const files: FileItem[] = [
  {
    name: "产品需求文档.docx",
    type: "doc",
    size: "2.45 MB",
    uploadedAt: "2024-05-20 14:30",
    expires: "7天后过期",
  },
  {
    name: "设计规范.pdf",
    type: "pdf",
    size: "3.21 MB",
    uploadedAt: "2024-05-20 14:25",
    expires: "7天后过期",
  },
  {
    name: "项目计划表.xlsx",
    type: "sheet",
    size: "1.87 MB",
    uploadedAt: "2024-05-20 14:20",
    expires: "7天后过期",
  },
];

const navItems = ["Direct", "STUN", "TURN", "SFU", "R2"];

const fileTypeStyles: Record<FileItem["type"], string> = {
  doc: "bg-[#2f7df6]",
  pdf: "bg-[#ff4248]",
  sheet: "bg-[#20c263]",
};

const transferSteps = [
  { label: "本地设备", meta: "已就绪", icon: Monitor, active: true },
  { label: "Direct 连接", meta: "已建立", icon: Link2, active: true },
  { label: "文件传输", meta: "传输中...", icon: FileText, active: true },
  { label: "传输完成", meta: "等待完成", icon: Check, active: false },
];

const details: DetailItem[] = [
  { label: "连接类型", value: "Direct", icon: Link2 },
  { label: "连接状态", value: "已连接", icon: Circle, status: "online" },
  { label: "本地地址", value: "192.168.1.100:54321", icon: MapPin },
  { label: "对端地址", value: "192.168.1.101:54322", icon: MapPin },
  { label: "连接时间", value: "2024-05-20 14:30:25", icon: Clock },
  { label: "传输协议", value: "TCP", icon: Wifi },
  { label: "传输速率", value: "12.5 MB/s", icon: Gauge },
  { label: "预计剩余时间", value: "2 分 35 秒", icon: Hourglass },
  { label: "已传输文件", value: "2 / 5", icon: FileText },
  { label: "已传输大小", value: "25.6 MB / 98.3 MB", icon: Database },
  { label: "进度", value: "26%", icon: Gauge, progress: 26 },
];

const devices: Device[] = [
  { name: "办公室电脑", ip: "192.168.1.101", icon: Monitor, selected: true },
  { name: "实验室服务器", ip: "192.168.1.150", icon: Server },
  { name: "家用笔记本", ip: "192.168.1.200", icon: Laptop },
];

function FileIcon({ type }: { type: FileItem["type"] }) {
  return (
    <span
      className={`grid size-8 shrink-0 place-items-center rounded-md text-white shadow-sm ${fileTypeStyles[type]}`}
    >
      <FileText aria-hidden="true" size={17} />
    </span>
  );
}

function Panel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-white/70 bg-white/90 shadow-[0_18px_55px_rgba(23,54,97,0.10)] ring-1 ring-[#d9e7f8]/70 backdrop-blur ${className}`}
    >
      {children}
    </section>
  );
}

export default function App() {
  return (
    <main className="mx-auto flex min-h-dvh w-[min(1680px,calc(100vw_-_clamp(28px,4vw,72px)))] flex-col py-[clamp(18px,2.5vw,34px)]">
      <header className="mb-[clamp(18px,2.2vw,28px)] grid grid-cols-[minmax(210px,260px)_minmax(0,1fr)_minmax(160px,260px)] items-center gap-4 max-[1040px]:grid-cols-1 max-[1040px]:justify-items-center">
        <a
          className="inline-flex w-fit items-center gap-3 text-[22px] font-extrabold text-[#071b3a] max-[560px]:text-lg"
          href="/"
          aria-label="文件中转站首页"
        >
          <span className="grid size-11 place-items-center rounded-2xl bg-[#1677ff] text-white shadow-[0_12px_28px_rgba(47,125,246,0.34)]">
            <Cloud aria-hidden="true" size={26} />
          </span>
          <strong>文件中转站</strong>
        </a>

        <nav
          className="mx-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-2xl border border-white/70 bg-white/70 p-1.5 text-[16px] font-extrabold text-[#344a68] shadow-[0_14px_38px_rgba(23,54,97,0.08)] backdrop-blur max-[700px]:w-full max-[700px]:justify-between max-[560px]:text-sm"
          aria-label="功能导航"
        >
          {navItems.map((item) => (
            <a
              className={
                item === "Direct"
                  ? "inline-flex min-w-[118px] items-center justify-center rounded-xl bg-[#1677ff] px-7 py-3 text-white shadow-[0_10px_26px_rgba(47,125,246,0.22)] max-[700px]:min-w-0 max-[700px]:px-4 max-[700px]:py-2.5"
                  : "inline-flex items-center justify-center rounded-xl px-6 py-3 transition hover:bg-white hover:text-[#1476ff] max-[700px]:px-3 max-[700px]:py-2.5"
              }
              href={`#${item.toLowerCase()}`}
              key={item}
            >
              {item}
            </a>
          ))}
        </nav>
      </header>

      <div className="grid flex-1 grid-cols-[minmax(360px,1.05fr)_minmax(0,1.75fr)] gap-[clamp(14px,1.5vw,22px)] max-[1180px]:grid-cols-1">
        <Panel className="row-span-2 p-[clamp(18px,1.8vw,28px)]">
          <h2 className="mb-7 text-[22px] font-extrabold text-[#061b3a]">连接状态</h2>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(22px,40px)_minmax(0,1fr)_minmax(22px,40px)_minmax(0,1fr)_minmax(22px,40px)_minmax(0,1fr)] items-start gap-2 max-[620px]:grid-cols-1 max-[620px]:gap-5">
            {transferSteps.map((step, index) => {
              const Icon = step.icon;
              return (
                <div className="contents max-[620px]:block" key={step.label}>
                  <div className="grid justify-items-center text-center max-[620px]:grid-cols-[56px_1fr] max-[620px]:justify-items-start max-[620px]:gap-3 max-[620px]:text-left">
                    <span
                      className={`grid size-[54px] place-items-center rounded-2xl text-white shadow-[0_10px_25px_rgba(47,125,246,0.25)] ${
                        step.active ? "bg-[#1677ff]" : "bg-[#aeb8c8]"
                      }`}
                    >
                      <Icon aria-hidden="true" size={25} />
                    </span>
                    <div>
                      <strong className="mt-4 block text-[15px] font-extrabold text-[#071b3a] max-[620px]:mt-1">
                        {step.label}
                      </strong>
                      <span className="mt-2 block text-sm text-[#667a9a] max-[620px]:mt-0">
                        {step.meta}
                      </span>
                    </div>
                  </div>
                  {index < transferSteps.length - 1 && (
                    <span className="mt-[25px] h-[3px] rounded-full bg-[#1677ff] max-[620px]:hidden" />
                  )}
                </div>
              );
            })}
          </div>

          <div className="my-7 h-px bg-[#e3edf9]" />

          <h2 className="mb-4 text-[22px] font-extrabold text-[#061b3a]">连接详情</h2>
          <div className="grid gap-0">
            {details.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  className="grid min-h-[38px] grid-cols-[24px_minmax(0,1fr)_minmax(0,max-content)] items-center gap-3 border-b border-[#e5edf8] text-[15px] last:border-b-0 max-[560px]:grid-cols-[24px_1fr] max-[560px]:py-2"
                  key={item.label}
                >
                  <Icon aria-hidden="true" className="text-[#526c92]" size={18} />
                  <span className="text-[#526c92]">{item.label}</span>
                  {item.progress == null ? (
                    <span className="min-w-0 justify-self-end break-words text-right font-medium text-[#142a4f] max-[560px]:col-span-2 max-[560px]:justify-self-start max-[560px]:text-left">
                      {item.status === "online" && (
                        <span className="mr-2 inline-block size-2.5 rounded-full bg-[#1dc85f]" />
                      )}
                      {item.value}
                    </span>
                  ) : (
                    <span className="grid w-[min(420px,42vw)] max-w-full grid-cols-[minmax(0,1fr)_50px] items-center gap-5 max-[1180px]:w-[min(420px,70vw)] max-[560px]:col-span-2 max-[560px]:w-full">
                      <span className="h-1 rounded-full bg-[#cdd8e7]">
                        <span
                          className="block h-full rounded-full bg-[#1677ff]"
                          style={{ width: `${item.progress}%` }}
                        />
                      </span>
                      <span className="text-right font-medium text-[#142a4f]">{item.value}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>

        <div className="grid grid-cols-[minmax(280px,0.72fr)_minmax(0,1fr)] gap-[clamp(14px,1.5vw,22px)] max-[900px]:grid-cols-1">
          <Panel className="p-[clamp(18px,1.8vw,28px)]">
            <h2 className="text-[22px] font-extrabold text-[#061b3a]">选择传输目标</h2>
            <p className="mt-2 text-[15px] text-[#526c92]">选择要传输到的目标设备</p>

            <div className="mt-5 grid gap-3">
              {devices.map((device) => {
                const Icon = device.icon;
                return (
                  <article
                    className={`grid min-h-[76px] grid-cols-[24px_34px_minmax(0,1fr)_auto] items-center gap-4 rounded-xl border bg-white px-4 transition hover:-translate-y-px hover:shadow-[0_12px_28px_rgba(23,54,97,0.08)] ${
                      device.selected
                        ? "border-[#9ec7ff] shadow-[0_0_0_1px_rgba(22,119,255,0.12)]"
                        : "border-[#dbe6f5]"
                    } max-[560px]:grid-cols-[24px_30px_1fr] max-[560px]:py-3`}
                    key={device.ip}
                  >
                    <span
                      className={`grid size-5 place-items-center rounded-full border-2 ${
                        device.selected ? "border-[#1677ff]" : "border-[#a7b7cf]"
                      }`}
                    >
                      {device.selected && <span className="size-2.5 rounded-full bg-[#1677ff]" />}
                    </span>
                    <Icon aria-hidden="true" className="text-[#5b76a0]" size={28} />
                    <div className="min-w-0">
                      <strong className="block truncate text-[16px] font-extrabold text-[#071b3a]">
                        {device.name}
                      </strong>
                      <span className="mt-0.5 block text-[15px] text-[#4c6b98]">{device.ip}</span>
                    </div>
                    <button
                      className="min-h-10 whitespace-nowrap rounded-lg border border-[#9ec7ff] px-4 text-[15px] font-extrabold text-[#1677ff] transition hover:bg-[#eef6ff] max-[560px]:col-span-3"
                      type="button"
                    >
                      选择
                    </button>
                  </article>
                );
              })}
            </div>
          </Panel>

          <Panel className="p-[clamp(18px,1.8vw,28px)]">
            <section
              className="grid min-h-[clamp(280px,27vw,360px)] place-items-center rounded-2xl border-2 border-dashed border-[#bdd3f1] bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(244,249,255,0.78))] px-[clamp(18px,3vw,36px)] py-8 text-center"
              aria-label="上传文件"
            >
              <div className="mb-7 grid size-[86px] place-items-center rounded-3xl bg-[#1677ff] text-white shadow-[0_16px_32px_rgba(47,125,246,0.28)] max-[560px]:size-20">
                <UploadCloud aria-hidden="true" size={58} />
              </div>
              <h1 className="m-0 text-[25px] font-extrabold leading-tight text-[#071b3a] max-[560px]:text-xl">
                点击或拖拽文件到此处上传
              </h1>
              <p className="mb-7 mt-2 text-[16px] text-[#526c92] max-[560px]:text-sm">
                支持多种格式，单个文件最大 5GB
              </p>
              <button
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-[#1677ff] px-8 text-[17px] font-extrabold text-white shadow-[0_12px_22px_rgba(47,125,246,0.25)] transition hover:-translate-y-px hover:bg-[#0d63da]"
                type="button"
              >
                <HardDrive aria-hidden="true" size={18} />
                选择文件
              </button>
            </section>
          </Panel>
        </div>

        <Panel className="p-[clamp(18px,1.8vw,28px)]">
          <div className="mb-6 flex items-center justify-between gap-4 max-[560px]:items-start max-[560px]:flex-col">
            <h2 className="m-0 text-[26px] font-extrabold text-[#061b3a]">我的文件</h2>
            <div className="flex items-center gap-3 max-[560px]:w-full">
              <button
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-[#dbe7f7] bg-white px-5 text-[17px] font-medium text-[#142a4f] transition hover:-translate-y-px hover:border-[#9ec7ff] max-[560px]:flex-1"
                type="button"
              >
                <Plus aria-hidden="true" size={19} />
                新建文件夹
              </button>
              <button
                className="inline-flex size-12 items-center justify-center rounded-lg border border-[#dbe7f7] bg-white text-[#142a4f] transition hover:-translate-y-px hover:border-[#9ec7ff] max-[560px]:shrink-0"
                type="button"
                aria-label="列表视图"
              >
                <List aria-hidden="true" size={22} />
              </button>
            </div>
          </div>

          <div className="grid gap-0 max-[900px]:gap-3" role="table" aria-label="文件列表">
            <div
              className="grid min-h-11 grid-cols-[minmax(180px,1.8fr)_minmax(78px,0.55fr)_minmax(136px,0.9fr)_minmax(108px,0.65fr)_minmax(160px,0.95fr)] items-center gap-4 px-4 text-[15px] font-medium text-[#587197] max-[900px]:hidden"
              role="row"
            >
              <span role="columnheader">文件名</span>
              <span role="columnheader">大小</span>
              <span role="columnheader">上传时间</span>
              <span role="columnheader">有效期</span>
              <span role="columnheader">操作</span>
            </div>

            {files.map((file) => (
              <article
                className="mb-3 grid min-h-[72px] grid-cols-[minmax(180px,1.8fr)_minmax(78px,0.55fr)_minmax(136px,0.9fr)_minmax(108px,0.65fr)_minmax(160px,0.95fr)] items-center gap-4 rounded-xl border border-[#e0eaf7] bg-white px-4 text-[15px] text-[#355176] shadow-[0_8px_22px_rgba(16,34,59,0.035)] transition hover:-translate-y-px hover:border-[#c7daf2] hover:shadow-[0_14px_34px_rgba(23,54,97,0.08)] max-[900px]:mb-0 max-[900px]:grid-cols-1 max-[900px]:gap-2.5 max-[900px]:p-4"
                key={file.name}
                role="row"
              >
                <div className="flex min-w-0 items-center gap-3 text-[#071b3a]" role="cell">
                  <FileIcon type={file.type} />
                  <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[16px] font-extrabold">
                    {file.name}
                  </strong>
                </div>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap max-[900px]:whitespace-normal" role="cell">
                  {file.size}
                </span>
                <time className="overflow-hidden text-ellipsis whitespace-nowrap max-[900px]:whitespace-normal" role="cell">
                  {file.uploadedAt}
                </time>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap max-[900px]:whitespace-normal" role="cell">
                  {file.expires}
                </span>
                <div
                  className="flex min-w-0 items-center justify-end gap-4 max-[900px]:justify-start max-[560px]:flex-wrap"
                  role="cell"
                >
                  <button
                    className="inline-flex min-h-[32px] items-center justify-center gap-1.5 bg-transparent p-0 text-[15px] font-medium text-[#426494] transition hover:text-[#1677ff]"
                    type="button"
                  >
                    <Link aria-hidden="true" size={17} />
                    复制链接
                  </button>
                  <button
                    className="inline-flex min-h-[32px] items-center justify-center gap-1.5 bg-transparent p-0 text-[15px] font-medium text-[#426494] transition hover:text-[#1677ff]"
                    type="button"
                  >
                    <Download aria-hidden="true" size={17} />
                    下载
                  </button>
                  <button
                    className="inline-flex size-8 shrink-0 items-center justify-center bg-transparent p-0 text-[#426494] transition hover:text-[#1677ff]"
                    type="button"
                    aria-label="更多操作"
                  >
                    <MoreHorizontal aria-hidden="true" size={18} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </Panel>
      </div>
    </main>
  );
}
