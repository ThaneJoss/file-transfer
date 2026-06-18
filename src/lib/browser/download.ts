export type DownloadableFile = {
  name: string;
  url: string;
};

export function saveBlob(file: DownloadableFile) {
  const anchor = document.createElement("a");
  anchor.href = file.url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
