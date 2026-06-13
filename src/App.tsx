import {
  Cloud,
  Download,
  FileText,
  Folder,
  Link,
  List,
  MoreHorizontal,
  Plus,
  UploadCloud,
} from "lucide-react";

type FileItem = {
  name: string;
  type: "doc" | "pdf" | "sheet" | "folder";
  size: string;
  uploadedAt: string;
  expires: string;
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
    name: "项目进度表.xlsx",
    type: "sheet",
    size: "1.18 MB",
    uploadedAt: "2024-05-19 18:10",
    expires: "3天后过期",
  },
  {
    name: "项目资料",
    type: "folder",
    size: "--",
    uploadedAt: "2024-05-19 17:50",
    expires: "永久有效",
  },
];

const navItems = ["Direct", "STUN", "TURN", "SFU", "R2"];

const fileTypeStyles: Record<FileItem["type"], string> = {
  doc: "bg-[#3278f6]",
  pdf: "bg-[#ff4d4f]",
  sheet: "bg-[#2fc276]",
  folder: "bg-[#f7b731]",
};

function FileIcon({ type }: { type: FileItem["type"] }) {
  const Icon = type === "folder" ? Folder : FileText;

  return (
    <span
      className={`grid size-[25px] shrink-0 place-items-center rounded-[4px] text-white ${fileTypeStyles[type]}`}
    >
      <Icon aria-hidden="true" size={type === "folder" ? 17 : 16} />
    </span>
  );
}

export default function App() {
  return (
    <main className="mx-auto min-h-screen w-[min(1160px,calc(100%_-_48px))] py-[22px] max-[900px]:w-[min(calc(100%_-_32px),720px)] max-[520px]:w-[min(calc(100%_-_24px),420px)] max-[520px]:pt-4">
      <header className="mb-[34px] grid min-h-10 grid-cols-[220px_1fr_220px] items-center max-[900px]:mb-6 max-[900px]:grid-cols-1 max-[900px]:justify-items-center max-[900px]:gap-3.5">
        <a
          className="inline-flex w-fit items-center gap-2.5 text-base font-semibold text-[#10223b] max-[520px]:text-[15px]"
          href="/"
          aria-label="文件中转站首页"
        >
          <span className="grid size-[31px] place-items-center rounded-full bg-[#2f7df6] text-white shadow-[0_8px_20px_rgba(47,125,246,0.24)]">
            <Cloud aria-hidden="true" size={21} />
          </span>
          <strong>文件中转站</strong>
        </a>

        <nav
          className="flex justify-center gap-[clamp(30px,6vw,76px)] text-[13px] font-bold text-[#14233a] max-[900px]:w-full max-[900px]:justify-between max-[900px]:gap-2.5 max-[900px]:overflow-x-auto max-[520px]:text-xs"
          aria-label="功能导航"
        >
          {navItems.map((item) => (
            <a
              className="inline-flex min-h-[30px] items-center px-0.5 transition-colors hover:text-[#2f7df6]"
              href={`#${item.toLowerCase()}`}
              key={item}
            >
              {item}
            </a>
          ))}
        </nav>
      </header>

      <section
        className="grid min-h-[292px] place-items-center rounded-lg border-2 border-dashed border-[#bdd3f1] bg-white/85 bg-linear-to-b from-white/80 to-[#f7fbff]/80 px-6 py-[38px] text-center shadow-[0_18px_48px_rgba(47,125,246,0.08)] max-[900px]:min-h-[260px] max-[520px]:min-h-[238px] max-[520px]:px-4 max-[520px]:py-7"
        aria-label="上传文件"
      >
        <div className="mb-3.5 grid size-[78px] place-items-center rounded-full bg-linear-to-b from-[#3e8cff] to-[#2f7df6] text-white shadow-[0_16px_30px_rgba(47,125,246,0.24)] max-[520px]:size-16">
          <UploadCloud aria-hidden="true" size={50} />
        </div>
        <h1 className="m-0 text-[21px] leading-tight font-bold text-[#10223b] max-[520px]:text-lg">
          点击或拖拽文件到此处上传
        </h1>
        <p className="mb-[18px] mt-1.5 text-[13px] text-[#6f7f95]">
          支持多种格式，单个文件最大 5GB
        </p>
        <button
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#2f7df6] px-7 text-sm font-extrabold text-white shadow-[0_12px_22px_rgba(47,125,246,0.24)] transition hover:-translate-y-px hover:bg-[#1763db]"
          type="button"
        >
          <UploadCloud aria-hidden="true" size={16} />
          选择文件
        </button>
      </section>

      <section className="mt-[42px]" aria-label="我的文件">
        <div className="mb-3.5 flex items-center justify-between gap-4 max-[520px]:items-start max-[520px]:flex-col">
          <h2 className="m-0 text-[22px] font-bold text-[#10223b]">我的文件</h2>
          <div className="flex items-center gap-3 max-[520px]:w-full">
            <button
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-[#dbe7f7] bg-white px-4 text-[13px] font-extrabold text-[#10223b] transition hover:-translate-y-px max-[520px]:flex-1"
              type="button"
            >
              <Plus aria-hidden="true" size={15} />
              新建文件夹
            </button>
            <button
              className="inline-flex size-[42px] items-center justify-center rounded-md border border-[#dbe7f7] bg-white text-[#10223b] transition hover:-translate-y-px max-[520px]:shrink-0"
              type="button"
              aria-label="列表视图"
            >
              <List aria-hidden="true" size={17} />
            </button>
          </div>
        </div>

        <div className="grid gap-0 max-[900px]:gap-2.5" role="table" aria-label="文件列表">
          <div
            className="grid min-h-10 grid-cols-[minmax(260px,2fr)_130px_190px_150px_220px] items-center gap-[18px] px-[18px] text-xs font-bold text-[#6f7f95] max-[900px]:hidden"
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
              className="mb-[9px] grid min-h-[62px] grid-cols-[minmax(260px,2fr)_130px_190px_150px_220px] items-center gap-[18px] rounded-[7px] border border-[#e2ebf8] bg-white/90 px-[18px] text-xs text-[#546781] shadow-[0_8px_24px_rgba(16,34,59,0.04)] max-[900px]:mb-0 max-[900px]:min-h-0 max-[900px]:grid-cols-1 max-[900px]:gap-2.5 max-[900px]:p-[15px]"
              key={file.name}
              role="row"
            >
              <div className="flex min-w-0 items-center gap-[11px] text-[#10223b]" role="cell">
                <FileIcon type={file.type} />
                <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm">
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
                className="flex min-w-0 items-center justify-end gap-2.5 max-[900px]:justify-start max-[900px]:pt-1 max-[520px]:flex-wrap"
                role="cell"
              >
                <button
                  className="inline-flex min-h-[30px] items-center justify-center gap-1.5 bg-transparent p-0 text-xs font-bold text-[#4e6b90] transition hover:-translate-y-px hover:text-[#2f7df6]"
                  type="button"
                >
                  <Link aria-hidden="true" size={14} />
                  复制链接
                </button>
                {file.type !== "folder" && (
                  <button
                    className="inline-flex min-h-[30px] items-center justify-center gap-1.5 bg-transparent p-0 text-xs font-bold text-[#4e6b90] transition hover:-translate-y-px hover:text-[#2f7df6]"
                    type="button"
                  >
                    <Download aria-hidden="true" size={14} />
                    下载
                  </button>
                )}
                <button
                  className="inline-flex size-7 shrink-0 items-center justify-center bg-transparent p-0 text-[#4e6b90] transition hover:-translate-y-px hover:text-[#2f7df6]"
                  type="button"
                  aria-label="更多操作"
                >
                  <MoreHorizontal aria-hidden="true" size={16} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <footer className="mt-[34px] flex justify-center gap-4 text-xs text-[#75859a]">
        <span>文件中转站</span>
        <span>·</span>
        <span>安全传输</span>
        <span>·</span>
        <span>快速分享</span>
      </footer>
    </main>
  );
}
